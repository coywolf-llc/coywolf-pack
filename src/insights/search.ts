/**
 * Search insights: the searches the site answers, counted per day and
 * query in plugin storage (collection "searchInsights"), and the report.
 *
 * What's counted (see search-core.ts): searches the search page answers
 * (searchWithFallback, first page), and searches a visitor settled on in the
 * live dropdown, which the live client reports to search/seen once they stop
 * typing for a moment or open a result. The live answers themselves aren't
 * counted (they come as the visitor types), and neither are searches
 * answered from Cloudflare's edge cache: the report counts the searches the
 * site answered.
 *
 * Recording is cheap: noteSearch() is synchronous and does nothing while the
 * part is off, or before this isolate has read the switches at all (the pack
 * middleware reads them on every request, so that's only an isolate's first
 * moment). Searches wait in this isolate's memory for BATCH_MS, then go to D1
 * in one batch after the response (waitUntil), one upsert per query. A flush
 * that hasn't ended long after it started (its request was canceled) is
 * replaced, as in src/files/counts.ts. Before each batch, one count of
 * today's rows caps the site at MAX_QUERIES_PER_DAY distinct queries a day:
 * past it, searches only add to queries already recorded today, so a flood
 * of made-up searches can't grow the table without bound.
 */
import { PLUGIN_ID, isOn, knownFeatures, siteFeatures } from "../core/features.js";
import { INSIGHTS_FEATURES } from "./keys.js";
import { MAX_QUERIES_PER_DAY, MIN_DAYS, MIN_SHOWN, RETENTION_DAYS, SEARCH_COLLECTION, type SearchEvent, type SearchSource, collapseBatch, dayOf, firstDay, normalizeSearchQuery, rowId } from "./search-core.js";

/** How long searches wait in memory before they're written together. */
const BATCH_MS = 2_000;
/** A flush still running this long after it started belonged to a canceled request. */
const STALE_MS = BATCH_MS + 25_000;
const MAX_PENDING = 2_000;
const STATEMENTS_PER_BATCH = 50;

const UPSERT = `INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision, created_at, updated_at)
	VALUES (?1, ?2, ?3, json_object('d', ?4, 'q', ?5, 'n', ?6, 'z', ?7), ?8, ?9, ?9)
	ON CONFLICT (plugin_id, collection, id) DO UPDATE SET
		data = json_set(data, '$.n', COALESCE(json_extract(data, '$.n'), 0) + ?6, '$.z', COALESCE(json_extract(data, '$.z'), 0) + ?7),
		revision = ?8, updated_at = ?9`;

/** Past the day's cap: add to a query already recorded today, never a new row (same parameters as UPSERT). */
const ADD_ONLY = `UPDATE _plugin_storage SET
		data = json_set(data, '$.n', COALESCE(json_extract(data, '$.n'), 0) + ?6, '$.z', COALESCE(json_extract(data, '$.z'), 0) + ?7),
		revision = ?8, updated_at = ?9
	WHERE plugin_id = ?1 AND collection = ?2 AND id = ?3`;

const TODAY_ROWS = "SELECT COUNT(*) AS n FROM _plugin_storage WHERE plugin_id = ?1 AND collection = ?2 AND json_extract(data, '$.d') = ?3";

/** The slice of D1 the recorder uses (stubbed in tests). */
export interface SearchDb {
	prepare(sql: string): { bind(...values: unknown[]): unknown };
	batch(statements: unknown[]): Promise<unknown>;
}

let pending: SearchEvent[] = [];
let flushing: Promise<void> | null = null;
let flushingSince = 0;
let batchMs = BATCH_MS;
let databaseName = "DB";
/** Whether Search insights is on, from the switches' per-isolate cache (replaced in tests). */
let partOn = async () => isOn(await siteFeatures(databaseName), INSIGHTS_FEATURES.search);
/** Whether this isolate's last read of the switches has the part on (null: not read yet). Replaced in tests. */
let knownOn = (): boolean | null => {
	const known = knownFeatures();
	return known ? isOn(known, INSIGHTS_FEATURES.search) : null;
};

/** The site database's binding name (from coywolfPlugin({ insights: { database } })). */
export function configureSearchInsights(options: { database?: string }): void {
	databaseName = options.database ?? "DB";
}

async function write(db: SearchDb, events: SearchEvent[]): Promise<void> {
	// Checked once per batch: the switch may have been turned off since the searches were noted.
	if (!(await partOn())) return;
	const now = Date.now();
	const day = dayOf(now);
	const at = new Date(now).toISOString();
	const counted = (await (db.prepare(TODAY_ROWS).bind(PLUGIN_ID, SEARCH_COLLECTION, day) as { first<T>(): Promise<T | null> }).first<{ n: number }>()) ?? { n: 0 };
	const sql = Number(counted.n) >= MAX_QUERIES_PER_DAY ? ADD_ONLY : UPSERT;
	const statements: unknown[] = [];
	for (const [q, tally] of collapseBatch(events)) {
		statements.push(db.prepare(sql).bind(PLUGIN_ID, SEARCH_COLLECTION, rowId(day, q), day, q, tally.n, tally.z, crypto.randomUUID(), at));
	}
	for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
}

async function drain(db: SearchDb, self: { flush: Promise<void> | null }): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, batchMs));
	while (pending.length) {
		const events = pending;
		pending = [];
		try {
			await write(db, events);
		} catch (error) {
			console.error("coywolf-pack: could not record searches", error);
		}
	}
	if (flushing === self.flush) flushing = null; // Same tick as the empty check above.
}

/**
 * Count one search: `raw` as the visitor typed it, how many results it found,
 * and where it came from ("live": settled on in the live dropdown; "page":
 * the search page or the search/query route). Synchronous, never throws.
 */
export function noteSearch(db: SearchDb | undefined | null, raw: string, results: number, source: SearchSource, waitUntil: (p: Promise<unknown>) => void): void {
	try {
		// Off, or the switches not read yet in this isolate: nothing at all (no flush, no switch read).
		if (!db || knownOn() !== true) return;
		const q = normalizeSearchQuery(raw);
		if (!q || pending.length >= MAX_PENDING) return;
		pending.push({ q, results: Math.max(0, Math.floor(results) || 0), source });
		if (!flushing || Date.now() - flushingSince > STALE_MS) {
			const self: { flush: Promise<void> | null } = { flush: null };
			self.flush = drain(db, self);
			flushing = self.flush;
			flushingSince = Date.now();
		}
		if (flushing) waitUntil(flushing);
	} catch (error) {
		console.error("coywolf-pack: could not note a search", error);
	}
}

/** For tests: the batch delay, and this isolate's state. */
export const searchRecorderForTests = {
	setDelay(ms: number) {
		batchMs = ms;
	},
	/** Replace the switch checks (the defaults read the site's switches). */
	setPartOn(check: () => Promise<boolean>, known: () => boolean | null = () => true) {
		partOn = check;
		knownOn = known;
	},
	reset() {
		pending = [];
		flushing = null;
		flushingSince = 0;
		batchMs = BATCH_MS;
	},
	get pending() {
		return pending.length;
	},
	get idle() {
		return flushing === null;
	},
};

// ── The report ───────────────────────────────────────────────────

export interface SearchQueryCount {
	q: string;
	searches: number;
	noResults: number;
}

export interface SearchReport {
	days: number;
	/** Every counted search in the window, queries seen once included. */
	searches: number;
	noResults: number;
	/** Queries seen at least MIN_SHOWN times on at least MIN_DAYS days. */
	top: SearchQueryCount[];
	/** Of those, the ones that found nothing at least once, most often first. */
	zero: SearchQueryCount[];
	minShown: number;
	minDays: number;
	retentionDays: number;
	/** The first day with counts (when the part was first on), or null. */
	since: string | null;
}

/** The slice of D1 the report reads (stubbed in tests). */
export interface ReportDb {
	prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }>; first<T>(): Promise<T | null> } };
}

const WHERE = "plugin_id = ?1 AND collection = ?2 AND json_extract(data, '$.d') >= ?3";

export async function searchReport(db: ReportDb, days: number, now = Date.now()): Promise<SearchReport> {
	const from = firstDay(now, days);
	const grouped = `SELECT json_extract(data, '$.q') AS q, SUM(json_extract(data, '$.n')) AS n, SUM(json_extract(data, '$.z')) AS z FROM _plugin_storage WHERE ${WHERE} GROUP BY q HAVING n >= ?4 AND COUNT(*) >= ?5`;
	const [totals, top, zero] = await Promise.all([
		db.prepare(`SELECT SUM(json_extract(data, '$.n')) AS n, SUM(json_extract(data, '$.z')) AS z, MIN(json_extract(data, '$.d')) AS since FROM _plugin_storage WHERE ${WHERE}`).bind(PLUGIN_ID, SEARCH_COLLECTION, from).first<{ n: number | null; z: number | null; since: string | null }>(),
		db.prepare(`${grouped} ORDER BY n DESC, q LIMIT 25`).bind(PLUGIN_ID, SEARCH_COLLECTION, from, MIN_SHOWN, MIN_DAYS).all<{ q: string; n: number; z: number }>(),
		db.prepare(`${grouped} AND z > 0 ORDER BY z DESC, n DESC, q LIMIT 25`).bind(PLUGIN_ID, SEARCH_COLLECTION, from, MIN_SHOWN, MIN_DAYS).all<{ q: string; n: number; z: number }>(),
	]);
	const rows = (list: Array<{ q: string; n: number; z: number }>) => list.map((r) => ({ q: String(r.q), searches: Number(r.n) || 0, noResults: Number(r.z) || 0 }));
	return {
		days,
		searches: Number(totals?.n) || 0,
		noResults: Number(totals?.z) || 0,
		top: rows(top.results),
		zero: rows(zero.results),
		minShown: MIN_SHOWN,
		minDays: MIN_DAYS,
		retentionDays: RETENTION_DAYS,
		since: totals?.since ?? null,
	};
}

/** Delete counts older than the retention (the daily task). Returns the rows deleted. */
export async function pruneSearches(db: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<{ meta?: { changes?: number } }> } } }, now = Date.now()): Promise<number> {
	const result = await db
		.prepare("DELETE FROM _plugin_storage WHERE plugin_id = ?1 AND collection = ?2 AND json_extract(data, '$.d') < ?3")
		.bind(PLUGIN_ID, SEARCH_COLLECTION, firstDay(now, RETENTION_DAYS))
		.run();
	return result.meta?.changes ?? 0;
}

/** Delete every count (the Delete search data button). */
export async function clearSearches(db: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<{ meta?: { changes?: number } }> } } }): Promise<number> {
	// Searches still waiting in this isolate's memory go too.
	pending = [];
	const result = await db.prepare("DELETE FROM _plugin_storage WHERE plugin_id = ?1 AND collection = ?2").bind(PLUGIN_ID, SEARCH_COLLECTION).run();
	return result.meta?.changes ?? 0;
}

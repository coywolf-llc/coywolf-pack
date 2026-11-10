/**
 * Search insights: the searches the site answers, counted per day and
 * query in plugin storage (collection "searchInsights"), and the report.
 *
 * Recording is cheap: noteSearch() is synchronous and does nothing while the
 * part is off (as this isolate last read the switches). Searches wait in
 * this isolate's memory for a few seconds (BATCH_MS, long enough to fold a
 * visitor's keystrokes into one search, see search-core.ts), then go to D1
 * in one batch after the response (waitUntil), one upsert per query. A flush
 * that hasn't ended long after it started (its request was canceled) is
 * replaced, as in src/files/counts.ts. Each isolate writes at most
 * MAX_QUERIES_PER_DAY distinct queries a day, so a flood of made-up searches
 * can't grow the table without bound.
 *
 * Searches answered from Cloudflare's edge cache (a repeat of a live search
 * within five minutes, with Workers Cache on) never reach the Worker, so
 * they aren't counted: the report counts the searches the site answered.
 */
import { PLUGIN_ID, isOn, knownFeatures, siteFeatures } from "../core/features.js";
import { INSIGHTS_FEATURES } from "./keys.js";
import { MIN_SHOWN, RETENTION_DAYS, SEARCH_COLLECTION, type SearchEvent, type SearchSource, collapseBatch, dayOf, firstDay, normalizeSearchQuery, rowId } from "./search-core.js";

/** How long searches wait in memory before they're written (a visitor's typing settles well within it). */
const BATCH_MS = 5_000;
/** A flush still running this long after it started belonged to a canceled request. */
const STALE_MS = BATCH_MS + 25_000;
const MAX_PENDING = 2_000;
const MAX_QUERIES_PER_DAY = 500;
const STATEMENTS_PER_BATCH = 50;

const UPSERT = `INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision, created_at, updated_at)
	VALUES (?1, ?2, ?3, json_object('d', ?4, 'q', ?5, 'n', ?6, 'z', ?7), ?8, ?9, ?9)
	ON CONFLICT (plugin_id, collection, id) DO UPDATE SET
		data = json_set(data, '$.n', COALESCE(json_extract(data, '$.n'), 0) + ?6, '$.z', COALESCE(json_extract(data, '$.z'), 0) + ?7),
		revision = ?8, updated_at = ?9`;

/** The slice of D1 the recorder uses (stubbed in tests). */
export interface SearchDb {
	prepare(sql: string): { bind(...values: unknown[]): unknown };
	batch(statements: unknown[]): Promise<unknown>;
}

let pending: SearchEvent[] = [];
let flushing: Promise<void> | null = null;
let flushingSince = 0;
let batchMs = BATCH_MS;
let written = { day: "", ids: new Set<string>() };
let databaseName = "DB";
/** Whether Search insights is on, from the switches' per-isolate cache (replaced in tests). */
let partOn = async () => isOn(await siteFeatures(databaseName), INSIGHTS_FEATURES.search);

/** The site database's binding name (from coywolfPlugin({ insights: { database } })). */
export function configureSearchInsights(options: { database?: string }): void {
	databaseName = options.database ?? "DB";
}

async function write(db: SearchDb, events: SearchEvent[]): Promise<void> {
	// Checked once per batch: the switch may have been turned off since the searches were noted.
	if (!(await partOn())) return;
	const now = Date.now();
	const day = dayOf(now);
	if (written.day !== day) written = { day, ids: new Set() };
	const at = new Date(now).toISOString();
	const statements: unknown[] = [];
	for (const [q, tally] of collapseBatch(events)) {
		const id = rowId(day, q);
		if (!written.ids.has(id)) {
			if (written.ids.size >= MAX_QUERIES_PER_DAY) continue;
			written.ids.add(id);
		}
		statements.push(db.prepare(UPSERT).bind(PLUGIN_ID, SEARCH_COLLECTION, id, day, q, tally.n, tally.z, crypto.randomUUID(), at));
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
 * Count one search the site answered: `raw` as the visitor typed it, how many
 * results it found, and where ("live": the as-you-type dropdown; "page": the
 * search page or the search/query route). Synchronous, never throws.
 */
export function noteSearch(db: SearchDb | undefined | null, raw: string, results: number | (() => number), source: SearchSource, waitUntil: (p: Promise<unknown>) => void): void {
	try {
		if (!db) return;
		const known = knownFeatures();
		if (known && !isOn(known, INSIGHTS_FEATURES.search)) return;
		const q = normalizeSearchQuery(raw);
		if (!q || pending.length >= MAX_PENDING) return;
		// A function when counting costs something (parsing a cached answer): only called for a search that's kept.
		const found = typeof results === "function" ? results() : results;
		pending.push({ q, results: Math.max(0, Math.floor(found) || 0), source });
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

/** The number of results in a live answer's JSON body ({ success, data: { items } }); 0 when it can't be read. */
export function liveAnswerCount(body: string): number {
	try {
		const items = (JSON.parse(body) as { data?: { items?: unknown[] } })?.data?.items;
		return Array.isArray(items) ? items.length : 0;
	} catch {
		return 0;
	}
}

/** For tests: the batch delay, and this isolate's state. */
export const searchRecorderForTests = {
	setDelay(ms: number) {
		batchMs = ms;
	},
	/** Replace the switch check (the default reads the site's switches from D1). */
	setPartOn(check: () => Promise<boolean>) {
		partOn = check;
	},
	reset() {
		pending = [];
		flushing = null;
		flushingSince = 0;
		written = { day: "", ids: new Set() };
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
	/** Queries seen at least MIN_SHOWN times. */
	top: SearchQueryCount[];
	/** Of those, the ones that found nothing at least once, most often first. */
	zero: SearchQueryCount[];
	minShown: number;
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
	const grouped = `SELECT json_extract(data, '$.q') AS q, SUM(json_extract(data, '$.n')) AS n, SUM(json_extract(data, '$.z')) AS z FROM _plugin_storage WHERE ${WHERE} GROUP BY q HAVING n >= ?4`;
	const [totals, top, zero] = await Promise.all([
		db.prepare(`SELECT SUM(json_extract(data, '$.n')) AS n, SUM(json_extract(data, '$.z')) AS z, MIN(json_extract(data, '$.d')) AS since FROM _plugin_storage WHERE ${WHERE}`).bind(PLUGIN_ID, SEARCH_COLLECTION, from).first<{ n: number | null; z: number | null; since: string | null }>(),
		db.prepare(`${grouped} ORDER BY n DESC, q LIMIT 25`).bind(PLUGIN_ID, SEARCH_COLLECTION, from, MIN_SHOWN).all<{ q: string; n: number; z: number }>(),
		db.prepare(`${grouped} AND z > 0 ORDER BY z DESC, n DESC, q LIMIT 25`).bind(PLUGIN_ID, SEARCH_COLLECTION, from, MIN_SHOWN).all<{ q: string; n: number; z: number }>(),
	]);
	const rows = (list: Array<{ q: string; n: number; z: number }>) => list.map((r) => ({ q: String(r.q), searches: Number(r.n) || 0, noResults: Number(r.z) || 0 }));
	return {
		days,
		searches: Number(totals?.n) || 0,
		noResults: Number(totals?.z) || 0,
		top: rows(top.results),
		zero: rows(zero.results),
		minShown: MIN_SHOWN,
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
	const result = await db.prepare("DELETE FROM _plugin_storage WHERE plugin_id = ?1 AND collection = ?2").bind(PLUGIN_ID, SEARCH_COLLECTION).run();
	written = { day: "", ids: new Set() };
	return result.meta?.changes ?? 0;
}

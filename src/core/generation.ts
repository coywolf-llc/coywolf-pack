/**
 * The settings generation: one option row the pack middleware rewrites after
 * every successful pack admin write (settings, redirects, schema, videos…).
 * Every isolate reads it in the feature switches' query (src/core/features.ts),
 * so a save made in one isolate reaches the others on their next read
 * (FEATURES_TTL_MS at most) without a query of its own, and they drop every
 * cache keyed on settingsEpoch().
 *
 * Until then another isolate may still render a page with the old settings,
 * and the page cache would keep that page for days. So a save that cleared
 * the page cache asks for a second, "settling" purge once every isolate must
 * have seen it: the first request after that time, in any isolate, claims it
 * (a compare-and-set on the row, so only one does) and purges again.
 *
 * Generation tags make that second purge small. Every response the pack lets
 * into the edge cache carries the tag of the generation its isolate had read
 * when the request started (generationTag; the switches, the settings and
 * the generation come from one query, so they always match). A save that
 * cleared every page settles by tag: only the generations that were current
 * shortly before it (`recent`), i.e. exactly the pages isolates rendered with
 * the old settings after the first purge, usually none or a handful. It
 * used to clear every page again and restart cache warming.
 */
import type { PurgeScope } from "../pageCache/lib.js";
import { FEATURES_TTL_MS, GENERATION_OPTION, rememberSiteOption, siteOption } from "./features.js";

/** Margin after the switches' lifetime before the settling purge, for reads that were in flight at save time. */
const SETTLE_MARGIN_MS = 15_000;
/** How long after a generation is replaced an isolate may still render with it. */
const STALE_WINDOW_MS = FEATURES_TTL_MS + SETTLE_MARGIN_MS;

/** Cache tag prefix of a settings generation (Cloudflare tags: printable ASCII, no spaces, 1,024 characters at most). */
export const GENERATION_TAG_PREFIX = "coywolf-gen-";
/** The generation of a site that has never saved pack settings (no row yet). */
export const FIRST_GENERATION = "0";
/**
 * Pages rendered by an isolate that couldn't tell its generation (its read of the switches had expired
 * mid-request, say). Every generation-tag settle clears these too, so they can't outlive a save.
 */
export const UNKNOWN_GENERATION_TAG = `${GENERATION_TAG_PREFIX}unknown`;
/**
 * Most generation tags one settle clears; more (dozens of saves within five minutes) settles by
 * clearing everything instead. Cloudflare takes at most 100 tags and path prefixes per purge.
 */
export const MAX_SETTLE_TAGS = 40;
/** Most tags and path prefixes in one purge call (Cloudflare's limit is 100 operations per request). */
export const MAX_PURGE_OPERATIONS = 100;

export interface GenerationRow {
	/** New on every save. */
	id: string;
	/** When the save happened (ms since the epoch). */
	at: number;
	/** The purge to repeat once every isolate has the new settings; absent when nothing needs it (or it's done). */
	settle?: PurgeScope;
	/**
	 * Generations replaced in the last STALE_WINDOW_MS, and when: an isolate may still render with
	 * one of them, so a save that clears everything settles by their tags.
	 */
	recent?: Array<{ id: string; at: number }>;
}

export function parseGeneration(raw: string | null | undefined): GenerationRow | null {
	if (!raw) return null;
	try {
		const row = JSON.parse(raw) as GenerationRow;
		return row && typeof row.id === "string" && typeof row.at === "number" ? row : null;
	} catch {
		return null;
	}
}

/** The cache tag of a settings generation. */
export function generationTag(id: string): string {
	return `${GENERATION_TAG_PREFIX}${id}`;
}

/**
 * The generation tag for what this isolate renders now: from its last read of
 * the switches (the pack middleware reads them before anything renders).
 * UNKNOWN_GENERATION_TAG when that read has expired or never happened.
 */
export function currentGenerationTag(): string {
	const raw = siteOption(GENERATION_OPTION);
	if (raw === undefined) return UNKNOWN_GENERATION_TAG;
	if (raw === null) return generationTag(FIRST_GENERATION);
	const row = parseGeneration(raw);
	return row ? generationTag(row.id) : UNKNOWN_GENERATION_TAG;
}

/** Tags and path prefixes a scope names (purgeEverything: none). */
const operations = (scope: PurgeScope) => ("purgeEverything" in scope ? 0 : ("tags" in scope ? scope.tags.length : 0) + ("pathPrefixes" in scope ? scope.pathPrefixes.length : 0));

/**
 * Both purges in one: every path prefix and tag of both (Workers Cache takes
 * both kinds in one call and clears whatever matches either), or everything
 * when either clears everything or the union is over Cloudflare's 100
 * operations per purge.
 */
export function mergeScopes(a: PurgeScope | null | undefined, b: PurgeScope | null | undefined): PurgeScope | null {
	if (!a || !b) return a ?? b ?? null;
	if ("purgeEverything" in a || "purgeEverything" in b) return { purgeEverything: true };
	const tags = [...new Set([...("tags" in a ? a.tags : []), ...("tags" in b ? b.tags : [])])];
	const pathPrefixes = [...new Set([...("pathPrefixes" in a ? a.pathPrefixes : []), ...("pathPrefixes" in b ? b.pathPrefixes : [])])];
	if (tags.length + pathPrefixes.length > MAX_PURGE_OPERATIONS) return { purgeEverything: true };
	if (tags.length && pathPrefixes.length) return { pathPrefixes, tags };
	return tags.length ? { tags } : { pathPrefixes };
}

export interface RecordOptions {
	/**
	 * Settle a save that clears everything by generation tags (see the file
	 * comment) instead of clearing everything again. For the pack's own admin
	 * saves, whose settings reach other isolates with the generation. Not for
	 * changes other isolates learn about some other way (EmDash's own settings,
	 * such as going live): those keep a full settling purge.
	 */
	byGeneration?: boolean;
}

/**
 * Record a save: a new generation, and the purge to settle later when the
 * save purged the page cache. A settling purge still pending from an earlier
 * save is kept (merged), and its clock restarts: isolates may have read the
 * earlier generation just before this save.
 */
export async function recordSettingsChange(db: D1Database, settle: PurgeScope | null, now = Date.now(), options: RecordOptions = {}): Promise<GenerationRow> {
	const current = await db.prepare("SELECT value FROM options WHERE name = ?").bind(GENERATION_OPTION).first<{ value: string }>();
	const previous = parseGeneration(current?.value);
	// The generation this save replaces (FIRST_GENERATION on a site's first save, or when the row is unreadable), and
	// the ones replaced shortly before it: isolates may still render with any of them.
	const recent = [...(previous?.recent ?? []).filter((r) => r && typeof r.id === "string" && now - r.at <= STALE_WINDOW_MS), { id: previous?.id ?? FIRST_GENERATION, at: now }].slice(-MAX_SETTLE_TAGS - 1);
	let own = settle;
	if (options.byGeneration && settle && "purgeEverything" in settle) {
		// The first purge cleared every page; what isolates on the old settings rendered after it carries their generation's tag.
		own = recent.length > MAX_SETTLE_TAGS ? settle : { tags: [...new Set([...recent.map((r) => generationTag(r.id)), UNKNOWN_GENERATION_TAG])] };
	}
	const pending = mergeScopes(previous?.settle, own);
	const row: GenerationRow = { id: crypto.randomUUID(), at: now, ...(pending ? { settle: pending } : {}), recent };
	const raw = JSON.stringify(row);
	await db
		.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
		.bind(GENERATION_OPTION, raw)
		.run();
	rememberSiteOption(GENERATION_OPTION, raw);
	return row;
}

/** True when the last read generation has a settling purge whose time has come. */
export function settleDue(row: GenerationRow | null, now = Date.now()): row is GenerationRow & { settle: PurgeScope } {
	return Boolean(row?.settle && now - row.at > STALE_WINDOW_MS);
}

/**
 * Claim the settling purge of the generation this isolate last read: returns
 * its scope when this call won it (the caller purges), null otherwise. Reads
 * nothing: the row comes from the switches' cached query; the claim is one
 * conditional write, and only when a purge is due.
 */
export async function claimSettle(db: D1Database, now = Date.now()): Promise<PurgeScope | null> {
	const raw = siteOption(GENERATION_OPTION);
	const row = parseGeneration(raw);
	if (!raw || !settleDue(row, now)) return null;
	const { settle, ...rest } = row;
	const next = JSON.stringify(rest);
	// Only one isolate claims it, and a newer save (another row) isn't touched.
	rememberSiteOption(GENERATION_OPTION, next);
	const result = await db.prepare("UPDATE options SET value = ? WHERE name = ? AND value = ?").bind(next, GENERATION_OPTION, raw).run();
	return (result.meta?.changes ?? 0) > 0 ? settle : null;
}

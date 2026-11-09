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
 */
import type { PurgeScope } from "../pageCache/lib.js";
import { FEATURES_TTL_MS, GENERATION_OPTION, rememberSiteOption, siteOption } from "./features.js";

/** Margin after the switches' lifetime before the settling purge, for reads that were in flight at save time. */
const SETTLE_MARGIN_MS = 15_000;

export interface GenerationRow {
	/** New on every save. */
	id: string;
	/** When the save happened (ms since the epoch). */
	at: number;
	/** The purge to repeat once every isolate has the new settings; absent when nothing needs it (or it's done). */
	settle?: PurgeScope;
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

/** Both purges in one: every path prefix (or tag) of both, or everything when either clears everything, mixes the two, or they're of different kinds. */
export function mergeScopes(a: PurgeScope | null | undefined, b: PurgeScope | null | undefined): PurgeScope | null {
	if (!a || !b) return a ?? b ?? null;
	const mixed = (s: PurgeScope) => "pathPrefixes" in s && "tags" in s;
	if (mixed(a) || mixed(b)) return { purgeEverything: true };
	if ("pathPrefixes" in a && "pathPrefixes" in b) return { pathPrefixes: [...new Set([...a.pathPrefixes, ...b.pathPrefixes])] };
	if ("tags" in a && "tags" in b) return { tags: [...new Set([...a.tags, ...b.tags])] };
	return { purgeEverything: true };
}

/**
 * Record a save: a new generation, and the purge to settle later when the
 * save purged the page cache. A settling purge still pending from an earlier
 * save is kept (merged), and its clock restarts: isolates may have read the
 * earlier generation just before this save.
 */
export async function recordSettingsChange(db: D1Database, settle: PurgeScope | null, now = Date.now()): Promise<GenerationRow> {
	const current = await db.prepare("SELECT value FROM options WHERE name = ?").bind(GENERATION_OPTION).first<{ value: string }>();
	const pending = mergeScopes(parseGeneration(current?.value)?.settle, settle);
	const row: GenerationRow = { id: crypto.randomUUID(), at: now, ...(pending ? { settle: pending } : {}) };
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
	return Boolean(row?.settle && now - row.at > FEATURES_TTL_MS + SETTLE_MARGIN_MS);
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

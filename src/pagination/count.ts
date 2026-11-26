/**
 * How many entries an archive lists, for its last-page link. EmDash's
 * getEmDashCollection returns `hasMore` but no total, so the pack counts with
 * one query of its own, through the raw D1 binding (with the pack's other
 * reads of the same tick: one round trip, src/core/d1-batch.ts). Start it with
 * the list (Promise.all) and it costs the page no extra wait.
 *
 * The count mirrors EmDash 1.5.0's public listing rules (loadCollection in
 * emdash/src/loader.ts, and the locale getEmDashCollection resolves):
 * - not in the trash (`deleted_at IS NULL`);
 * - the filter's status, "published" by default (there's no published_at
 *   rule: a published entry with a future date is listed);
 * - the locale: the filter's, else the request's, else the default locale
 *   when the site has more than one, matched with its alias codes (an empty
 *   locale, `locale: ""`, is no locale filter);
 * - each taxonomy in `where` (category, tag…, the names EmDash declares for
 *   the collection): tagged with one of its slugs in that taxonomy, in the
 *   locale too; several taxonomies must all match;
 * - `where.byline`: credited to one of those byline translation groups.
 * Any other `where` key is a field filter, which the count doesn't mirror, so
 * it answers null (no last-page link) rather than a wrong number.
 * test/emdash-contract.test.mjs checks it against paging through
 * getEmDashCollection to the end.
 *
 * Null too while Pagination is off (no query), and when the count can't be
 * read (a query error, or no D1 binding): the failure is noted (src/core/read-failures.ts), so the page rendered
 * without its last-page link isn't kept in the edge cache.
 */
import { COLLECTION_SLUG } from "../core/content-url.js";
import { batchedFirst } from "../core/d1-batch.js";
import { isOn, siteFeatures } from "../core/features.js";
import { noteReadFailure } from "../core/read-failures.js";
import { requestStore } from "../core/request-memo.js";
import { workerEnv } from "../shared.js";
import { PAGINATION_FEATURE } from "./pack.js";
import { errorSummary } from "../core/error-summary.js";

/** What getEmDashCollection takes that changes which entries are listed (its other keys are ignored here). */
export interface CountFilter {
	status?: string;
	where?: Record<string, unknown>;
	locale?: string;
}

export interface CountOptions {
	/** The site database: a D1 binding name (default "DB") or the binding itself. */
	database?: string | D1Database;
}

// ── Locales, as EmDash 1.5.0 resolves them (emdash/src/i18n) ─────

export interface I18nConfig {
	defaultLocale: string;
	locales: string[];
	localeAliases?: Record<string, string>;
}

/** Where EmDash keeps its i18n config (setI18nConfig in emdash/src/i18n/config.ts), so no import of emdash is needed. */
const I18N_CONFIG_KEY = Symbol.for("emdash:i18n-config");
const i18nConfig = () => ((globalThis as Record<symbol, I18nConfig | null | undefined>)[I18N_CONFIG_KEY] ?? null) as I18nConfig | null;

/** EmDash's resolveConfiguredLocale: a locale path or Astro code → the canonical content locale. */
function configuredLocale(locale: string, config: I18nConfig | null): string {
	const configured = config?.locales.find((candidate) => candidate.toLowerCase() === locale.toLowerCase());
	if (configured) return configured;
	const aliased = Object.entries(config?.localeAliases ?? {}).find(([code]) => code.toLowerCase() === locale.toLowerCase())?.[1];
	if (aliased === undefined) return locale;
	return config?.locales.find((candidate) => candidate.toLowerCase() === aliased.toLowerCase()) ?? aliased;
}

/** EmDash's getLocaleCandidates: the canonical locale, then the alias codes stored for it. */
function localeCandidates(locale: string, config: I18nConfig | null): string[] {
	const canonical = configuredLocale(locale, config);
	const candidates = [canonical];
	const seen = new Set([canonical.toLowerCase()]);
	for (const code of Object.keys(config?.localeAliases ?? {})) {
		if (configuredLocale(code, config) === canonical && !seen.has(code.toLowerCase())) {
			candidates.push(code);
			seen.add(code.toLowerCase());
		}
	}
	return candidates;
}

/** EmDash's resolveLocale: the filter's locale, else the request's, else the default one when the site has several. */
function listLocale(explicit: string | undefined, config: I18nConfig | null): string | undefined {
	if (explicit !== undefined) return configuredLocale(explicit, config);
	const requested = (requestStore() as { locale?: string } | undefined)?.locale;
	if (requested !== undefined) return configuredLocale(requested, config);
	if (config && config.locales.length > 1) return config.defaultLocale;
	return undefined;
}

// ── The query ────────────────────────────────────────────────────

/**
 * Value lists are bound as one JSON array (`IN (SELECT value FROM json_each(?))`),
 * so a category with many subcategories never reaches D1's limit on bound
 * parameters. The same match as EmDash's `IN (?, ?, …)`.
 */
export const LOCALE_SQL = " AND c.locale IN (SELECT value FROM json_each(?))";
export const TERM_LOCALE_SQL = " AND t.locale IN (SELECT value FROM json_each(?))";

/** Entries (by translation group) tagged with one of the slugs in one taxonomy: the match of EmDash's taxonomy EXISTS. */
export function termEntries(termLocale: string): string {
	return `(SELECT ct.entry_id FROM content_taxonomies ct INNER JOIN taxonomies t ON t.translation_group = ct.taxonomy_id WHERE ct.collection = ? AND t.name = ? AND t.slug IN (SELECT value FROM json_each(?))${termLocale})`;
}

/** Entries (by id) credited to one of the byline groups: the match of EmDash's byline EXISTS. */
export const BYLINE_ENTRIES = "(SELECT cb.content_id FROM _emdash_content_bylines cb WHERE cb.collection_slug = ? AND cb.byline_id IN (SELECT value FROM json_each(?)))";

/**
 * How many of the given names are taxonomies of the collection, the way
 * EmDash tells a taxonomy filter from a field filter (getTaxonomyNames:
 * every taxonomy definition, in any locale, whose collections, from its
 * group when it has one, list the collection; collections that aren't a JSON
 * array of names list none).
 */
export const KNOWN_TAXONOMIES =
	"(SELECT COUNT(DISTINCT d.name) FROM _emdash_taxonomy_defs d LEFT JOIN _emdash_taxonomy_def_groups g ON g.name = d.name WHERE d.name IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(coalesce(g.collections, d.collections)) THEN CASE json_type(coalesce(g.collections, d.collections)) WHEN 'array' THEN coalesce(g.collections, d.collections) END END) j WHERE j.type = 'text' AND j.value = ?))";

const isRange = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
const values = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).map(String);

/** The count statement for a filter, or a number when it's known without one (an empty list matches nothing), or null when it can't be mirrored. */
export function countQuery(collection: string, filter: CountFilter, config: I18nConfig | null = i18nConfig()): { sql: string; binds: unknown[]; taxonomies: number } | number | null {
	if (!COLLECTION_SLUG.test(collection)) return null;
	const locale = listLocale(filter.locale, config);
	// An empty locale is no locale filter, as in EmDash's loader (`locale ? … : no clause`).
	const locales = locale ? JSON.stringify(localeCandidates(locale, config)) : null;
	let filters = "";
	const filterBinds: unknown[] = [];
	const names: string[] = [];
	let empty = false;
	for (const [key, value] of Object.entries(filter.where ?? {})) {
		if (value === null || value === undefined) continue;
		if (key === "byline") {
			// EmDash ignores a range on bylines (with a warning).
			if (isRange(value)) continue;
			const groups = values(value);
			if (!groups.length) empty = true;
			filters += ` AND c.id IN ${BYLINE_ENTRIES}`;
			filterBinds.push(collection, JSON.stringify(groups));
			continue;
		}
		names.push(key);
		// A range on a taxonomy is ignored too; on a field it's a field filter (the name check answers that).
		if (isRange(value)) continue;
		const slugs = values(value);
		if (!slugs.length) empty = true;
		const termLocale = locales === null ? "" : TERM_LOCALE_SQL;
		filters += ` AND c.translation_group IN ${termEntries(termLocale)}`;
		filterBinds.push(collection, key, JSON.stringify(slugs));
		if (locales !== null) filterBinds.push(locales);
	}
	// An empty list matches nothing, as in EmDash, once every name is known to be a taxonomy (or the byline).
	if (empty && !names.length) return 0;
	const known = names.length ? KNOWN_TAXONOMIES : "NULL";
	const localeSql = locales === null ? "" : LOCALE_SQL;
	const binds = [...(names.length ? [JSON.stringify(names), collection] : []), filter.status || "published", ...(locales === null ? [] : [locales]), ...filterBinds];
	const sql = `SELECT ${known} AS known, COUNT(*) AS n FROM "ec_${collection}" c WHERE c.deleted_at IS NULL AND c.status = ?${localeSql}${filters}`;
	return { sql: empty ? `SELECT ${known} AS known, 0 AS n` : sql, binds: empty ? binds.slice(0, 2) : binds, taxonomies: names.length };
}

/**
 * The number of entries getEmDashCollection(collection, filter) lists across
 * all its pages (pass it the same filter; `orderBy`, `limit` and `offset`
 * don't change the count). Null while Pagination is off, for a `where` the
 * count doesn't mirror, and when it can't be read.
 *
 *   const filter = { status: "published", where: { category: "news" }, limit: 20, offset: 20 };
 *   const [result, count] = await Promise.all([getEmDashCollection("posts", filter), countEntries("posts", filter)]);
 */
export async function countEntries(collection: string, filter: CountFilter = {}, options: CountOptions = {}): Promise<number | null> {
	const database = options.database ?? "DB";
	if (!isOn(await siteFeatures(database), PAGINATION_FEATURE)) return null;
	const query = countQuery(collection, filter);
	if (query === null || typeof query === "number") return query;
	try {
		const db = typeof database === "string" ? ((await workerEnv())[database] as D1Database | undefined) : database;
		if (!db) throw new Error(`no D1 binding${typeof database === "string" ? ` named ${database}` : ""}`);
		const row = await batchedFirst<{ known: number | null; n: number }>(db, db.prepare(query.sql).bind(...query.binds));
		if (!row) throw new Error("the count query returned no row");
		if (query.taxonomies && Number(row.known) < query.taxonomies) return null;
		return Number(row.n);
	} catch (error) {
		console.error(`coywolf-pack pagination: could not count the ${collection} entries`, errorSummary(error), error);
		noteReadFailure("entry count");
		return null;
	}
}

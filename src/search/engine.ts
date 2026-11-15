/**
 * Live results engine: EmDash's FTS5 search, read straight from D1 in a few
 * batched round trips instead of EmDash's per-collection lookups.
 *
 * EmDash's search() re-reads each collection's search config, searchable
 * fields and title column and checks the FTS table exists on every call, then
 * runs one query per collection; live results called it two or three times
 * (titles, full text, the any-word fallback) and then read collection info,
 * terms, dates and excerpt text separately: 25–31 queries a keystroke. Here:
 *
 * - Collection info, fields, FTS tables and term parents: one batch, cached
 *   per isolate for a minute (and reloaded when the content version changes).
 * - Title and full-text matches for every collection: one batch.
 * - The any-word fallback, only when nothing matched every word: one batch.
 * - Excerpt text and URL terms for the results: one batch. Publish dates come
 *   with the matches.
 *
 * The SQL is EmDash's (emdash/src/search/query.ts searchSingleCollection),
 * with the same query escaping, BM25 weights, title scope and filters, so
 * results match EmDash's search. The pure parts are exported for tests.
 */
import {
	COLLECTION_SLUG,
	type ChildPagesState,
	ParentPagesUnreadable,
	type CollectionInfo,
	type PrimaryTermRow,
	type SqlQuery,
	type TermParentRow,
	collectPrimaryTerms,
	createEntryUrlResolver,
	currentChildPagesState,
	hostDefaultLocale,
	interpolateUrlPattern,
	overriddenCollections,
	patternTaxonomies,
	patternTermPathTaxonomies,
	primaryTermsQuery,
	termParentsFromRows,
	termParentsQuery,
	urlOverride,
} from "../core/content-url.js";
import { buildOrQuery, rankByCoverage } from "./fallback.js";
import { buildSnippet, highlightHtml, highlightWords, portableTextProse } from "./snippet.js";

// ── Metadata ─────────────────────────────────────────────────────

export interface CollectionMeta extends CollectionInfo {
	/** search_config.enabled */
	searchEnabled: boolean;
	weights?: Record<string, number>;
	/** Searchable fields in EmDash's order (the FTS table's column order, for BM25 weights). */
	searchable: string[];
	/** Searchable fields with their types, in schema (sort_order) order, for excerpts. */
	excerptFields: Array<{ field: string; type: string }>;
	/** The collection has a field named "title". */
	hasTitleColumn: boolean;
	/** The FTS table exists (unknown counts as true; the query then fails softly). */
	ftsExists: boolean;
}

export interface SearchMeta {
	collections: Map<string, CollectionMeta>;
	/** Term parents per taxonomy named by `{termpath:…}` URL overrides. */
	termParents: Map<string, Map<string, string>>;
	/** Child Pages' parents, read with the rest (null while it's off; absent: ask when resolving). */
	childPages?: ChildPagesState | null;
}

interface CollectionRow {
	slug: string;
	label: string;
	label_singular: string | null;
	url_pattern: string | null;
	title_field: string | null;
	search_config: string | null;
}

interface FieldRow {
	collection: string;
	field: string;
	type: string;
	searchable: number;
	sort_order: number | null;
}

export const META_COLLECTIONS_SQL = "SELECT slug, label, label_singular, url_pattern, title_field, search_config FROM _emdash_collections";
// rowid order is the order EmDash's getSearchableFields returns (no ORDER BY), which built the FTS table's columns.
export const META_FIELDS_SQL =
	"SELECT c.slug AS collection, f.slug AS field, f.type AS type, f.searchable AS searchable, f.sort_order AS sort_order FROM _emdash_fields f JOIN _emdash_collections c ON c.id = f.collection_id ORDER BY f.rowid";
export const META_FTS_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_emdash_fts_%'";

/** Parse a collection's search_config the way EmDash's getSearchConfig does. */
export function parseSearchConfig(raw: string | null): { enabled: boolean; weights?: Record<string, number> } | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || typeof (parsed as { enabled?: unknown }).enabled !== "boolean") return null;
		const out: { enabled: boolean; weights?: Record<string, number> } = { enabled: (parsed as { enabled: boolean }).enabled };
		const weights = (parsed as { weights?: unknown }).weights;
		if (weights && typeof weights === "object") {
			out.weights = {};
			for (const [k, v] of Object.entries(weights)) if (typeof v === "number") out.weights[k] = v;
		}
		return out;
	} catch {
		return null;
	}
}

/** Build the metadata from the batch's rows. `ftsTables` null means "couldn't tell" (treated as present). */
export function buildMeta(collections: CollectionRow[], fields: FieldRow[], ftsTables: string[] | null, termParents: Map<string, Map<string, string>>): SearchMeta {
	const out = new Map<string, CollectionMeta>();
	const fts = ftsTables ? new Set(ftsTables) : null;
	for (const c of collections) {
		if (!COLLECTION_SLUG.test(c.slug)) continue;
		const config = parseSearchConfig(c.search_config);
		const own = fields.filter((f) => f.collection === c.slug);
		out.set(c.slug, {
			slug: c.slug,
			label: c.label,
			labelSingular: c.label_singular,
			urlPattern: c.url_pattern,
			titleField: c.title_field,
			searchEnabled: config?.enabled === true,
			weights: config?.weights,
			searchable: own.filter((f) => f.searchable === 1).map((f) => f.field),
			excerptFields: own
				.filter((f) => f.searchable === 1)
				.map((f, i) => ({ f, i }))
				.sort((a, b) => (a.f.sort_order ?? 0) - (b.f.sort_order ?? 0) || a.i - b.i)
				.map(({ f }) => ({ field: f.field, type: f.type })),
			hasTitleColumn: own.some((f) => f.field === "title"),
			ftsExists: fts ? fts.has(`_emdash_fts_${c.slug}`) : true,
		});
	}
	return { collections: out, termParents };
}

/** Taxonomies whose term parents URL overrides need (`{termpath:…}`). */
function overrideParentTaxonomies(slugs: string[]): string[] {
	return [...new Set(slugs.flatMap((slug) => patternTermPathTaxonomies(urlOverride(slug))))];
}

const META_TTL_MS = 60_000;
const metaCache = new Map<string, { meta: SearchMeta; at: number; version: string }>();

/** Forget cached metadata (call after search settings change). */
export function invalidateSearchMeta(): void {
	metaCache.clear();
}

/**
 * Collection info, fields, FTS tables and term parents in one batch, cached
 * per isolate for a minute, and reloaded when `version` (the search content
 * version) changes.
 */
export async function loadSearchMeta(db: D1Database, cacheKey = "DB", version = ""): Promise<SearchMeta> {
	const hit = metaCache.get(cacheKey);
	if (hit && hit.version === version && Date.now() - hit.at < META_TTL_MS) return hit.meta;

	// URL overrides are configuration, so their taxonomies are known before reading anything.
	const parentTaxonomies = overrideParentTaxonomies(overriddenCollections());
	const statements = [db.prepare(META_COLLECTIONS_SQL), db.prepare(META_FIELDS_SQL), db.prepare(META_FTS_SQL)];
	const parentsQuery = parentTaxonomies.length ? termParentsQuery(parentTaxonomies) : null;
	if (parentsQuery) statements.push(db.prepare(parentsQuery.sql).bind(...parentsQuery.binds));

	let collections: CollectionRow[] = [];
	let fields: FieldRow[] = [];
	let fts: string[] | null = null;
	let parentRows: TermParentRow[] = [];
	try {
		const results = await db.batch(statements);
		collections = (results[0]?.results ?? []) as CollectionRow[];
		fields = (results[1]?.results ?? []) as FieldRow[];
		fts = ((results[2]?.results ?? []) as Array<{ name: string }>).map((r) => r.name);
		parentRows = (results[3]?.results ?? []) as TermParentRow[];
	} catch {
		// One failing statement fails the batch (e.g. sqlite_master or taxonomies unreadable): read the essentials alone.
		const [c, f, t, p] = await Promise.all([
			statements[0].all<CollectionRow>(),
			statements[1].all<FieldRow>(),
			statements[2].all<{ name: string }>().catch(() => null),
			statements[3] ? statements[3].all<TermParentRow>().catch(() => null) : null,
		]);
		collections = c.results;
		fields = f.results;
		fts = t ? t.results.map((r) => r.name) : null;
		parentRows = p?.results ?? [];
	}
	const termParents = termParentsFromRows(parentRows, parentTaxonomies, await hostDefaultLocale());
	const meta = buildMeta(collections, fields, fts, termParents);
	// Child Pages: page URLs nest by their parents, kept with the rest (the search version changes with them), so a
	// search reads no parents of its own. A read that fails rejects, and nothing is cached: "off" kept here would
	// answer searches with flat page URLs until the metadata is read again.
	meta.childPages = await currentChildPagesState(db);
	metaCache.set(cacheKey, { meta, at: Date.now(), version });
	return meta;
}

// ── Queries (pure) ───────────────────────────────────────────────

const WHITESPACE = /\s+/;
const FTS_OPERATORS = /\b(AND|OR|NOT|NEAR)\b/i;

/** EmDash's escapeQuery (search/query.ts): quoted, prefix-matched words, or the visitor's own operators. */
export function escapeFtsQuery(query: string, allowOperators = true): string {
	if (!query || typeof query !== "string") return "";
	const trimmed = query.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) return `"${trimmed.slice(1, -1).replace(/"/g, '""')}"`;
	const escaped = trimmed.replace(/"/g, '""');
	if (allowOperators && FTS_OPERATORS.test(trimmed)) return escaped;
	const terms = escaped.split(WHITESPACE).filter((t) => t.length > 0);
	if (!terms.length) return "";
	return terms.map((t) => `"${t}"*`).join(" ");
}

export type SearchScope = "title" | "all" | "any";

/** The FTS5 column holding a collection's title, for title scope (null: it can't match by title). */
export function titleColumn(meta: CollectionMeta): string | null {
	if (meta.titleField && meta.searchable.includes(meta.titleField)) return meta.titleField;
	return meta.searchable.includes("title") ? "title" : null;
}

const IDENT = /^[a-z][a-z0-9_]*$/;

/** The title expression EmDash selects: the configured title field, else a "title" field, else NULL. */
export function titleExpression(meta: CollectionMeta): string {
	if (meta.titleField && IDENT.test(meta.titleField)) return `c."${meta.titleField}"`;
	return meta.hasTitleColumn ? "c.title" : "NULL";
}

/**
 * One collection's match query (EmDash's searchSingleCollection SQL plus the
 * publish date), or null when this collection can't match. "any" also
 * selects EmDash's snippet, which the fallback's coverage ranking reads.
 */
export function matchQuery(meta: CollectionMeta, query: string, scope: SearchScope, options: { locale?: string; limit: number }): SqlQuery | null {
	if (!meta.searchEnabled || !meta.ftsExists || !COLLECTION_SLUG.test(meta.slug)) return null;
	let match = escapeFtsQuery(query);
	if (!match) return null;
	if (scope === "title") {
		const column = titleColumn(meta);
		if (!column || !IDENT.test(column)) return null;
		match = `${column} : (${escapeFtsQuery(query, false)})`;
	}
	const fts = `_emdash_fts_${meta.slug}`;
	const weights = meta.weights && meta.searchable.length ? ["0", "0", ...meta.searchable.map((f) => String(meta.weights?.[f] ?? 1))].join(", ") : "";
	const bm25 = weights ? `bm25("${fts}", ${weights})` : `bm25("${fts}")`;
	const snippet = scope === "any" ? `, snippet("${fts}", 2, '<mark>', '</mark>', '...', 32) AS snippet` : "";
	const binds: unknown[] = [match];
	let where = `"${fts}" MATCH ? AND c.status = 'published' AND c.deleted_at IS NULL`;
	if (options.locale) {
		where += " AND c.locale = ? COLLATE NOCASE";
		binds.push(options.locale);
	}
	binds.push(options.limit);
	return {
		sql: `SELECT c.id AS id, c.slug AS slug, c.locale AS locale, c.published_at AS published_at, ${titleExpression(meta)} AS title${snippet}, ${bm25} AS score FROM "${fts}" f JOIN "ec_${meta.slug}" c ON f.id = c.id WHERE ${where} ORDER BY score LIMIT ?`,
		binds,
	};
}

/** The excerpt source columns for a set of entries (searchable fields other than the title). */
export function excerptQuery(meta: CollectionMeta, ids: string[]): { query: SqlQuery; columns: Array<{ field: string; type: string }> } | null {
	const titleField = meta.titleField || "title";
	const columns = meta.excerptFields.filter((f) => f.field !== titleField && IDENT.test(f.field));
	if (!columns.length || !ids.length || !COLLECTION_SLUG.test(meta.slug)) return null;
	const select = columns.map((c, i) => `c."${c.field}" AS f${i}`).join(", ");
	return { query: { sql: `SELECT c.id AS id, ${select} FROM "ec_${meta.slug}" c WHERE c.id IN (${ids.map(() => "?").join(",")})`, binds: ids }, columns };
}

// ── Running ──────────────────────────────────────────────────────

/** One matched entry. */
export interface MatchRow {
	collection: string;
	id: string;
	slug: string | null;
	locale: string | null;
	publishedAt: string | null;
	title?: string;
	snippet?: string;
	score: number;
}

interface RawMatch {
	id: string;
	slug: string | null;
	locale: string | null;
	published_at: string | null;
	title: string | null;
	snippet?: string | null;
	score: number;
}

const FTS_SYNTAX = /fts5: syntax error|unknown special query/i;

/**
 * Run statements as one D1 batch (one round trip). A failing statement fails
 * a batch, so on error each runs alone and a failure there (an FTS syntax
 * error from the visitor's own operators) reads as no rows.
 */
export async function runBatch<T = Record<string, unknown>>(db: D1Database, queries: SqlQuery[]): Promise<T[][]> {
	if (!queries.length) return [];
	const statements = queries.map((q) => db.prepare(q.sql).bind(...q.binds));
	try {
		return (await db.batch<T>(statements)).map((r) => r.results ?? []);
	} catch {
		return Promise.all(
			statements.map((s) =>
				s
					.all<T>()
					.then((r) => r.results)
					.catch((error: unknown) => {
						if (!(error instanceof Error && FTS_SYNTAX.test(error.message))) console.error("coywolf-pack search: query failed", error);
						return [] as T[];
					}),
			),
		);
	}
}

// EmDash's snippet() markers are escaped the way its sanitizeSnippet does, so rankByCoverage sees the same text.
const sanitizeSnippet = (snippet: string) =>
	snippet.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");

/** Merge per-collection rows the way EmDash's search does: by score (|bm25|), highest first. */
export function mergeMatches(perCollection: Array<{ collection: string; rows: RawMatch[] }>, limit: number): MatchRow[] {
	const all: MatchRow[] = [];
	for (const { collection, rows } of perCollection) {
		for (const r of rows) {
			all.push({
				collection,
				id: String(r.id),
				slug: r.slug,
				locale: r.locale,
				publishedAt: r.published_at ?? null,
				title: r.title ?? undefined,
				snippet: r.snippet == null ? undefined : sanitizeSnippet(r.snippet),
				score: Math.abs(Number(r.score) || 0),
			});
		}
	}
	return all.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** How many OR results to rank in one go (as in searchWithFallback). */
const FALLBACK_POOL = 50;
/** Characters of indexed text read per entry for its excerpt. */
const SNIPPET_SOURCE_CHARS = 20_000;

/** One live result: everything the dropdown shows, already escaped where it's HTML. */
export interface LiveSearchResult {
	id: string;
	collection: string;
	title: string;
	/** The title, escaped, with the visitor's words in <mark> (the only tag). */
	titleHtml: string;
	url: string;
	type: string;
	/** An excerpt around the first match, escaped, with matches in <mark> and "…" where it was cut. */
	snippet: string;
}

export interface LiveSearchResponse {
	items: LiveSearchResult[];
	/** True when nothing matched every word, so these results match any word. */
	fallback: boolean;
}

export interface LiveEngineOptions {
	collections?: string[];
	locale?: string;
	limit?: number;
	/** Cache key for this database's metadata (its binding name). */
	database?: string;
	/** The search content version: metadata reloads when it changes. */
	version?: string;
}

/** Search-enabled collections to search: the requested ones (that exist), else all. */
export function searchTargets(meta: SearchMeta, collections?: string[]): CollectionMeta[] {
	const slugs = collections ? [...new Set(collections)].filter((c) => COLLECTION_SLUG.test(c)).slice(0, 10) : [...meta.collections.keys()];
	return slugs.map((s) => meta.collections.get(s)).filter((m): m is CollectionMeta => !!m && m.searchEnabled);
}

/**
 * Live results: title matches first, then full-text matches (with the
 * any-word fallback) to fill the list, each with a resolved URL, a type
 * label and an excerpt. Published entries only.
 */
export async function liveSearchD1(db: D1Database, query: string, options: LiveEngineOptions = {}): Promise<LiveSearchResponse> {
	const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
	if (options.collections && !options.collections.length) return { items: [], fallback: false };
	const meta = await loadSearchMeta(db, options.database, options.version);
	const targets = searchTargets(meta, options.collections);
	if (!targets.length) return { items: [], fallback: false };
	const locale = options.locale || undefined;

	// Titles and every-word matches together: one round trip.
	const firstRound: Array<{ collection: string; scope: SearchScope; query: SqlQuery }> = [];
	for (const t of targets) {
		for (const scope of ["title", "all"] as const) {
			const q = matchQuery(t, query, scope, { locale, limit });
			if (q) firstRound.push({ collection: t.slug, scope, query: q });
		}
	}
	const firstRows = await runBatch<RawMatch>(db, firstRound.map((r) => r.query));
	const pick = (scope: SearchScope) => firstRound.map((r, i) => ({ r, rows: firstRows[i] ?? [] })).filter(({ r }) => r.scope === scope).map(({ r, rows }) => ({ collection: r.collection, rows }));
	const titles = mergeMatches(pick("title"), limit);
	const all = mergeMatches(pick("all"), limit);

	const merged: MatchRow[] = [...titles];
	const seen = new Set(merged.map((m) => `${m.collection}:${m.id}`));
	let fallback = false;
	const fill = (rows: MatchRow[]) => {
		for (const row of rows) {
			if (merged.length >= limit) break;
			const key = `${row.collection}:${row.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(row);
		}
	};
	if (merged.length < limit) {
		if (all.length) fill(all);
		else {
			const orQuery = buildOrQuery(query);
			if (orQuery) {
				const round = targets.map((t) => ({ collection: t.slug, query: matchQuery(t, orQuery, "any", { locale, limit: FALLBACK_POOL }) })).filter((r): r is { collection: string; query: SqlQuery } => !!r.query);
				const rows = await runBatch<RawMatch>(db, round.map((r) => r.query));
				const any = mergeMatches(round.map((r, i) => ({ collection: r.collection, rows: rows[i] ?? [] })), FALLBACK_POOL);
				const ranked = rankByCoverage(any, query).slice(0, limit);
				fill(ranked);
				fallback = ranked.length > 0 && titles.length === 0;
			}
		}
	}
	if (!merged.length) return { items: [], fallback: false };

	const { texts, urls } = await resolveResults(db, meta, merged);
	const words = highlightWords(query);
	return {
		fallback,
		items: merged.map((item) => {
			const info = meta.collections.get(item.collection);
			const title = item.title || item.slug || item.id;
			const key = `${item.collection}:${item.id}`;
			return {
				id: item.id,
				collection: item.collection,
				title,
				titleHtml: highlightHtml(title, words),
				url: urls.get(key) ?? interpolateUrlPattern({ pattern: null, collection: item.collection, slug: item.slug ?? item.id, id: item.id }),
				type: info?.labelSingular || info?.label || item.collection,
				snippet: buildSnippet(texts.get(key) ?? "", words),
			};
		}),
	};
}

/** Excerpt text and URL terms for the results in one round trip, then their URLs (no further queries). */
async function resolveResults(db: D1Database, meta: SearchMeta, rows: MatchRow[]): Promise<{ texts: Map<string, string>; urls: Map<string, string | null> }> {
	const slugs = [...new Set(rows.map((r) => r.collection))];
	const defaultLocale = await hostDefaultLocale();
	const batch: Array<{ kind: "text"; slug: string; columns: Array<{ field: string; type: string }> } | { kind: "terms"; slug: string }> = [];
	const queries: SqlQuery[] = [];
	for (const slug of slugs) {
		const info = meta.collections.get(slug);
		if (!info) continue;
		const ids = rows.filter((r) => r.collection === slug).map((r) => r.id);
		const excerpt = excerptQuery(info, ids);
		if (excerpt) {
			batch.push({ kind: "text", slug, columns: excerpt.columns });
			queries.push(excerpt.query);
		}
		const taxonomies = patternTaxonomies(urlOverride(slug));
		if (taxonomies.length) {
			batch.push({ kind: "terms", slug });
			queries.push(primaryTermsQuery(slug, ids, taxonomies, defaultLocale));
		}
	}
	const results = await runBatch(db, queries);

	const texts = new Map<string, string>();
	const terms = new Map<string, Map<string, Record<string, string>>>();
	batch.forEach((b, i) => {
		const found = results[i] ?? [];
		if (b.kind === "terms") {
			terms.set(b.slug, collectPrimaryTerms(found as unknown as PrimaryTermRow[]));
			return;
		}
		for (const row of found) {
			const text = b.columns
				.map((c, j) => {
					const value = row[`f${j}`];
					if (c.type === "portableText") return portableTextProse(value, SNIPPET_SOURCE_CHARS);
					return typeof value === "string" ? value.slice(0, SNIPPET_SOURCE_CHARS) : "";
				})
				.filter(Boolean)
				.join(" ");
			if (text) texts.set(`${b.slug}:${String(row.id)}`, text);
		}
	});

	const urls = await entryUrlsFromMeta(db, meta, slugs, (slug) =>
		rows
			.filter((r) => r.collection === slug)
			.map((r) => ({ id: r.id, slug: r.slug ?? r.id, locale: r.locale, publishedAt: r.publishedAt, terms: terms.has(slug) ? (terms.get(slug)?.get(r.id) ?? {}) : undefined })),
	);
	return { texts, urls };
}

/** URLs from the cached metadata (collection patterns, term parents) and entries that carry their dates and terms. */
export async function entryUrlsFromMeta(
	db: D1Database,
	meta: SearchMeta,
	slugs: string[],
	entriesOf: (slug: string) => Array<{ id: string; slug: string; locale?: string | null; publishedAt?: string | null; terms?: Record<string, string> }>,
): Promise<Map<string, string | null>> {
	const resolver = createEntryUrlResolver(db, {
		collections: meta.collections,
		...(meta.childPages !== undefined ? { childPages: meta.childPages } : {}),
		termParents: async (taxonomies) => {
			const out = new Map<string, Map<string, string>>();
			for (const t of taxonomies) out.set(t, meta.termParents.get(t) ?? new Map());
			return out;
		},
	});
	const urls = new Map<string, string | null>();
	for (const slug of slugs) {
		try {
			for (const [id, url] of await resolver.urls(slug, entriesOf(slug))) urls.set(`${slug}:${id}`, url);
		} catch (error) {
			// Default routes below rather than fail the search. Not when Child Pages' parents couldn't be read:
			// the default would be a nested page's flat URL, in an answer that's cached.
			if (error instanceof ParentPagesUnreadable) throw error;
		}
	}
	return urls;
}

// ── Query counting (Server-Timing, tests) ────────────────────────

export interface QueryStats {
	/** SQL statements run. */
	statements: number;
	/** Requests to D1 (a batch is one). */
	roundTrips: number;
}

/** Wrap a D1 binding to count statements and round trips into `stats`. */
export function countingD1(db: D1Database, stats: QueryStats): D1Database {
	const inner = new WeakMap<object, D1PreparedStatement>();
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
		const proxy = new Proxy(stmt, {
			get(target, prop) {
				if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
				if (prop === "all" || prop === "first" || prop === "run" || prop === "raw") {
					return (...args: unknown[]) => {
						stats.statements++;
						stats.roundTrips++;
						return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		inner.set(proxy, stmt);
		return proxy;
	};
	return new Proxy(db, {
		get(target, prop) {
			if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
			if (prop === "batch") {
				return (statements: D1PreparedStatement[]) => {
					stats.roundTrips++;
					stats.statements += statements.length;
					return target.batch(statements.map((s) => inner.get(s) ?? s));
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

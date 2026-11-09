/**
 * Public URLs of content entries, pack-wide.
 *
 * EmDash resolves an entry's URL from its collection's `url_pattern`
 * ({slug}, {id} and WordPress-style date tokens; emdash/src/i18n/resolve.ts
 * interpolateUrlPattern, which isn't exported), falling back to
 * /<collection>/<slug>. Themes can route entries any way they like, though,
 * e.g. WordPress-style /{category}/{slug}/. The site tells the pack about
 * such routes with coywolfPlugin({ urls }):
 *
 * ```js
 * coywolfPlugin({ urls: { posts: "/{term:category|uncategorized}/{slug}/" } })
 * ```
 *
 * Override patterns take EmDash's tokens plus `{term:<taxonomy>}` (the slug
 * of the entry's first term in that taxonomy, ordered the way EmDash's
 * getTermsForEntries orders them: by label) with an optional fallback after
 * a pipe, `{term:category|uncategorized}`. `{category}` is shorthand for
 * exactly that. `{termpath:<taxonomy>|fallback}` is the same term with its
 * ancestors in front, WordPress's hierarchical %category%: `news/seo` for
 * SEO under News. Parents come from EmDash's taxonomy table (`parent_id`),
 * with the `termParents` option filling in terms that have none.
 * `{pagepath}` is the entry's slug with its parents' slugs in front
 * (`apps/coywolf-seo`); EmDash has no parent for entries, so they come from
 * the `pageParents` option. Collections without an override resolve the way
 * EmDash does (getPublicUrl inside the plugin context, url_pattern otherwise).
 *
 * Configuration: coywolfPlugin() options reach createPlugin(), which
 * EmDash's generated plugins module (virtual:emdash/plugins) calls when the
 * Worker isolate starts, so configureContentUrls() runs before any request
 * reaches the middleware or an Astro component. Same pattern as the search
 * module's rate limit options.
 *
 * Sources: every resolver takes either the plugin context (hooks and
 * routes) or the site's D1 database (middleware, Astro components). With a
 * context, terms come from EmDash's getTermsForEntries and non-overridden
 * collections from getPublicUrl (published entries only). With D1, terms are
 * read with the same SQL EmDash uses and url_pattern is interpolated
 * locally. No locale prefix is applied to override patterns.
 */
import type { PluginContext } from "emdash";

// ── Pattern interpolation (pure) ─────────────────────────────────

const REPEATED_SLASHES = /\/{2,}/g;
const DATE_TOKEN = /\{(year|month|day|hour|minute|second)\}/g;
const DATE_TOKEN_TEST = /\{(year|month|day|hour|minute|second)\}/;
const TERM_TOKEN = /\{(term|termpath):([A-Za-z0-9_-]+)(?:\|([^{}/]*))?\}/g;
const UNRESOLVED_TERM = /\{term(?:path)?:[^}]*\}/;
const PAGE_PATH = "{pagepath}";
/** Longest ancestor chain followed (cycles stop earlier). */
const MAX_DEPTH = 32;
const OFFSETLESS_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

export type TrailingSlash = "always" | "never" | "ignore";

function parseUtcDate(date: string | Date): Date {
	if (date instanceof Date) return date;
	const offsetless = OFFSETLESS_DATETIME.exec(date);
	return new Date(offsetless ? `${offsetless[1]}T${offsetless[2]}Z` : date);
}

function applyDateTokens(path: string, date: string | Date | null | undefined): string {
	const d = date == null ? null : parseUtcDate(date);
	if (!d || Number.isNaN(d.getTime())) return path;
	const parts: Record<string, string> = {
		year: String(d.getUTCFullYear()),
		month: pad2(d.getUTCMonth() + 1),
		day: pad2(d.getUTCDate()),
		hour: pad2(d.getUTCHours()),
		minute: pad2(d.getUTCMinutes()),
		second: pad2(d.getUTCSeconds()),
	};
	return path.replace(DATE_TOKEN, (match, key: string) => parts[key] ?? match);
}

/** Expand pack shorthands: `{category}` → `{term:category|uncategorized}`. */
export function expandPattern(pattern: string): string {
	return pattern.replaceAll("{category}", "{term:category|uncategorized}");
}

/** Taxonomies named by `{term:…}` and `{termpath:…}` tokens. */
export function patternTaxonomies(pattern: string | null): string[] {
	if (!pattern) return [];
	return [...new Set([...expandPattern(pattern).matchAll(TERM_TOKEN)].map((m) => m[2] as string))];
}

/** Taxonomies named by `{termpath:…}` tokens (those that need term parents). */
export function patternTermPathTaxonomies(pattern: string | null): string[] {
	if (!pattern) return [];
	return [...new Set([...expandPattern(pattern).matchAll(TERM_TOKEN)].filter((m) => m[1] === "termpath").map((m) => m[2] as string))];
}

/** True when the pattern has a `{pagepath}` token. */
export function patternUsesPagePath(pattern: string | null): boolean {
	return !!pattern && pattern.includes(PAGE_PATH);
}

/**
 * A slug with its ancestors in front (root first), following `parents`
 * (slug → parent slug). Stops at a cycle or after 32 levels.
 */
export function ancestorTrail(slug: string, parents: ReadonlyMap<string, string> | Record<string, string> | null | undefined): string[] {
	const trail = [slug];
	if (!parents) return trail;
	const get = parents instanceof Map ? (s: string) => parents.get(s) : (s: string) => (Object.hasOwn(parents, s) ? (parents as Record<string, string>)[s] : undefined);
	let up = get(slug);
	while (up && !trail.includes(up) && trail.length < MAX_DEPTH) {
		trail.unshift(up);
		up = get(up);
	}
	return trail;
}

const encodeSegments = (segments: string[]) => segments.map((s) => encodeURIComponent(s)).join("/");

/** True when the pattern needs a publish date to resolve. */
export function patternUsesDate(pattern: string | null): boolean {
	return !!pattern && DATE_TOKEN_TEST.test(pattern);
}

/**
 * EmDash's interpolateUrlPattern, plus `{term:<taxonomy>|fallback}` tokens
 * filled from `terms` (taxonomy → first term slug), `{termpath:…}` from
 * `termPaths` (taxonomy → the term's slugs, root first; the bare term when
 * missing) and `{pagepath}` from `pagePath` (the entry's slugs, root first;
 * the slug when missing). A term token with no term and no fallback stays
 * literal, like a date token without a date. The result has no trailing
 * slash (see applyTrailingSlash).
 */
export function interpolateUrlPattern(options: {
	pattern: string | null;
	collection: string;
	slug: string;
	id: string;
	date?: string | Date | null;
	terms?: Record<string, string | null | undefined>;
	termPaths?: Record<string, string[] | null | undefined>;
	pagePath?: string[] | null;
}): string {
	const { pattern, collection, slug, id, date, terms, termPaths, pagePath } = options;
	const basePattern = pattern == null ? `/${encodeURIComponent(collection)}/{slug}` : expandPattern(pattern);
	let path = basePattern.replace(TERM_TOKEN, (match, kind: string, taxonomy: string, fallback: string | undefined) => {
		const trail = kind === "termpath" ? termPaths?.[taxonomy] : null;
		if (trail?.length) return encodeSegments(trail);
		const term = terms?.[taxonomy];
		if (term) return encodeURIComponent(term);
		return fallback ? fallback : match;
	});
	path = path.replaceAll(PAGE_PATH, pagePath?.length ? encodeSegments(pagePath) : encodeURIComponent(slug));
	path = path.replaceAll("{slug}", encodeURIComponent(slug)).replaceAll("{id}", encodeURIComponent(id));
	path = applyDateTokens(path, date);
	path = path.replace(REPEATED_SLASHES, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	return path;
}

/**
 * Astro's trailingSlash policy, as EmDash applies it. With "ignore", an
 * override pattern keeps its own trailing slash (`/{slug}/` → `/a/`), while
 * EmDash's url_pattern resolution never has one.
 */
export function applyTrailingSlash(path: string, policy: TrailingSlash | undefined, patternHasSlash = false): string {
	if (path === "/") return path;
	const bare = path.replace(/\/+$/, "");
	if (policy === "always" || (policy !== "never" && patternHasSlash)) return `${bare}/`;
	return bare;
}

/** The path an override pattern gives an entry, or null when a term token can't be filled. */
export function overridePath(
	pattern: string,
	entry: {
		collection: string;
		id: string;
		slug: string;
		date?: string | Date | null;
		terms?: Record<string, string | null | undefined>;
		termPaths?: Record<string, string[] | null | undefined>;
		pagePath?: string[] | null;
	},
	policy: TrailingSlash | undefined,
): string | null {
	const expanded = expandPattern(pattern);
	const path = interpolateUrlPattern({ pattern: expanded, ...entry });
	if (UNRESOLVED_TERM.test(path)) return null;
	return applyTrailingSlash(path, policy, expanded.endsWith("/"));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANY_TOKEN = /\{(?:term(?:path)?:[A-Za-z0-9_-]+(?:\|[^{}/]*)?|[a-z]+)\}/g;
const ONE_SEGMENT = "([^/]+)";
const SEGMENTS = "([^/]+(?:/[^/]+)*)";

/**
 * Compile a pattern into a regex over decoded paths without a trailing
 * slash. Captures the {slug} and {id} tokens (and {pagepath}, whose last
 * segment is the slug). `{termpath:…}` and `{pagepath}` match one or more
 * segments, other tokens one.
 */
export function compilePattern(pattern: string): { regex: RegExp; slug: number; id: number; pagePath: number } {
	let source = expandPattern(pattern).replace(REPEATED_SLASHES, "/");
	if (!source.startsWith("/")) source = `/${source}`;
	if (source.length > 1) source = source.replace(/\/+$/, "");
	let regex = "";
	let last = 0;
	let group = 0;
	let slug = 0;
	let id = 0;
	let pagePath = 0;
	for (const m of source.matchAll(ANY_TOKEN)) {
		regex += escapeRegex(source.slice(last, m.index));
		group++;
		if (m[0] === "{slug}" && !slug) slug = group;
		if (m[0] === "{id}" && !id) id = group;
		if (m[0] === PAGE_PATH && !pagePath) pagePath = group;
		regex += m[0] === PAGE_PATH || m[0].startsWith("{termpath:") ? SEGMENTS : ONE_SEGMENT;
		last = (m.index ?? 0) + m[0].length;
	}
	regex += escapeRegex(source.slice(last));
	return { regex: new RegExp(`^${regex}$`), slug, id, pagePath };
}

const safeDecode = (path: string) => {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
};
/** Comparable form of a path: decoded, no trailing slash. */
export const comparablePath = (path: string) => {
	const p = safeDecode(path.split(/[?#]/)[0]);
	return p.length > 1 ? p.replace(/\/+$/, "") : p;
};

// ── Configuration ────────────────────────────────────────────────

/** Collection slugs are validated before being used as table names. */
export const COLLECTION_SLUG = /^[a-z][a-z0-9_]*$/;

export interface ContentUrlOptions {
	/** Collection → URL pattern, for collections the theme routes differently from EmDash's url_pattern. */
	urls?: Record<string, string>;
	/** Trailing-slash policy for the pack's entry URLs. Default: EmDash's (Astro's `trailingSlash`). */
	trailingSlash?: TrailingSlash;
	/**
	 * Taxonomy → term slug → parent term slug, for `{termpath:…}`. Used only
	 * for terms with no parent in EmDash (e.g. before parents are restored
	 * after a WordPress import).
	 */
	termParents?: Record<string, Record<string, string>>;
	/** Entry slug → parent entry slug, for `{pagepath}` (EmDash entries have no parent). */
	pageParents?: Record<string, string>;
}

interface UrlConfig {
	urls: Map<string, string>;
	trailingSlash?: TrailingSlash;
	termParents: Map<string, Map<string, string>>;
	pageParents: Map<string, string>;
}

let config: UrlConfig = { urls: new Map(), termParents: new Map(), pageParents: new Map() };

const TAXONOMY_NAME = /^[A-Za-z0-9_-]+$/;

/** A slug → parent slug map from an option, dropping non-string and self-parent entries. */
function parentMap(input: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (!input || typeof input !== "object") return out;
	for (const [slug, parent] of Object.entries(input as Record<string, unknown>)) {
		if (typeof parent === "string" && parent.trim() && slug && parent.trim() !== slug) out.set(slug, parent.trim());
	}
	return out;
}

/** Set from coywolfPlugin()/createPlugin() options. Invalid collection slugs are ignored. */
export function configureContentUrls(options: ContentUrlOptions = {}): void {
	const urls = new Map<string, string>();
	for (const [collection, pattern] of Object.entries(options.urls ?? {})) {
		if (COLLECTION_SLUG.test(collection) && typeof pattern === "string" && pattern.trim()) urls.set(collection, expandPattern(pattern.trim()));
	}
	const termParents = new Map<string, Map<string, string>>();
	for (const [taxonomy, map] of Object.entries(options.termParents ?? {})) {
		if (TAXONOMY_NAME.test(taxonomy)) termParents.set(taxonomy, parentMap(map));
	}
	config = { urls, trailingSlash: options.trailingSlash, termParents, pageParents: parentMap(options.pageParents) };
}

/** The entry's slugs, root first, from the `pageParents` option. */
export function pageTrail(slug: string): string[] {
	return ancestorTrail(slug, config.pageParents);
}

/** The URL configuration as text, for cache keys (answers with URLs change when it does). */
export function contentUrlFingerprint(): string {
	const pairs = (m: Map<string, unknown>) => [...m.entries()].map(([k, v]) => [k, v instanceof Map ? [...v.entries()] : v]);
	return JSON.stringify([pairs(config.urls), config.trailingSlash ?? "", pairs(config.termParents), pairs(config.pageParents)]);
}

/** Collections the `urls` option routes. */
export function overriddenCollections(): string[] {
	return [...config.urls.keys()];
}

/** The configured override pattern for a collection (shorthands expanded), if any. */
export function urlOverride(collection: string): string | null {
	return config.urls.get(collection) ?? null;
}

// ── Sources ──────────────────────────────────────────────────────

/** The plugin context, or the parts of it URL resolution uses. */
export type UrlContext = Pick<PluginContext, "site" | "content" | "schema">;
export type UrlSource = UrlContext | D1Database;

const isD1 = (source: UrlSource): source is D1Database => typeof (source as D1Database).prepare === "function";

interface HostConfig {
	trailingSlash?: TrailingSlash;
	defaultLocale?: string;
}
let hostConfig: Promise<HostConfig> | null = null;
/** EmDash's build-time config (virtual:emdash/config), as menus read it. Empty outside a site build. */
function readHostConfig(): Promise<HostConfig> {
	hostConfig ??= (async () => {
		try {
			// @ts-ignore: provided by EmDash's Vite integration in the site build; absent under Node tests.
			const mod = (await import("virtual:emdash/config")) as { default?: { trailingSlash?: TrailingSlash; i18n?: { defaultLocale?: string } | null } };
			return { trailingSlash: mod.default?.trailingSlash, defaultLocale: mod.default?.i18n?.defaultLocale };
		} catch {
			return {};
		}
	})();
	return hostConfig;
}

/** The site's trailing-slash policy: the pack's `trailingSlash` option, else EmDash's (Astro's `trailingSlash`), else "ignore". */
export async function trailingPolicy(source: UrlSource): Promise<TrailingSlash> {
	if (config.trailingSlash) return config.trailingSlash;
	if (!isD1(source) && source.site.trailingSlash) return source.site.trailingSlash;
	return (await readHostConfig()).trailingSlash ?? "ignore";
}

const SQL_CHUNK = 50;
function chunks<T>(items: T[], size = SQL_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** A SQL statement and its bound values, for callers that batch statements (D1 batch). */
export interface SqlQuery {
	sql: string;
	binds: unknown[];
}

export interface PrimaryTermRow {
	entry_id: string;
	name: string;
	slug: string;
}

/** The site's default locale (EmDash's i18n config; "en" without one). */
export async function hostDefaultLocale(): Promise<string> {
	return (await readHostConfig()).defaultLocale ?? "en";
}

/**
 * EmDash's selectEntryTermRows SQL for the given entries (or, with `ids`
 * null, every published entry of the collection), for all wanted taxonomies
 * at once, ordered by label. Feed the rows to collectPrimaryTerms.
 */
export function primaryTermsQuery(collection: string, ids: string[] | null, taxonomies: string[], defaultLocale: string): SqlQuery {
	const where = ids ? `content.id IN (${ids.map(() => "?").join(",")})` : "content.status = 'published' AND content.deleted_at IS NULL";
	return {
		sql: `SELECT content.id AS entry_id,
				coalesce(exact_term.name, default_term.name) AS name,
				coalesce(exact_term.slug, default_term.slug) AS slug
			FROM "ec_${collection}" AS content
			INNER JOIN content_taxonomies AS pivot
				ON pivot.entry_id = content.translation_group
				AND pivot.collection = ?
			LEFT JOIN taxonomies AS exact_term
				ON exact_term.translation_group = pivot.taxonomy_id
				AND exact_term.locale = content.locale
			LEFT JOIN taxonomies AS default_term
				ON default_term.translation_group = pivot.taxonomy_id
				AND default_term.locale = ?
			WHERE ${where}
				AND coalesce(exact_term.id, default_term.id) IS NOT NULL
				AND coalesce(exact_term.name, default_term.name) IN (${taxonomies.map(() => "?").join(",")})
			ORDER BY coalesce(exact_term.label, default_term.label) ASC`,
		binds: [collection, defaultLocale, ...(ids ?? []), ...taxonomies],
	};
}

/** Fold primaryTermsQuery rows into entry id → taxonomy → first term slug (entries missing from `out` are added). */
export function collectPrimaryTerms(rows: PrimaryTermRow[], out: Map<string, Record<string, string>> = new Map()): Map<string, Record<string, string>> {
	for (const row of rows) {
		let terms = out.get(row.entry_id);
		if (!terms) {
			terms = {};
			out.set(row.entry_id, terms);
		}
		if (row.slug && !(row.name in terms)) terms[row.name] = row.slug;
	}
	return out;
}

export interface TermParentRow {
	name: string;
	id: string;
	slug: string;
	parent_id: string | null;
	locale: string | null;
	translation_group: string | null;
}

/** Taxonomy names usable in SQL and options. */
export function validTaxonomies(taxonomies: string[]): string[] {
	return [...new Set(taxonomies)].filter((t) => TAXONOMY_NAME.test(t));
}

/** The taxonomy rows termParentsFromRows needs, in one query. */
export function termParentsQuery(taxonomies: string[]): SqlQuery {
	const wanted = validTaxonomies(taxonomies);
	return { sql: `SELECT name, id, slug, parent_id, locale, translation_group FROM taxonomies WHERE name IN (${wanted.map(() => "?").join(",")})`, binds: wanted };
}

/** Term parents per taxonomy from termParentsQuery rows, then the `termParents` option for terms with none. */
export function termParentsFromRows(input: TermParentRow[], taxonomies: string[], defaultLocale: string): Map<string, Map<string, string>> {
	const wanted = validTaxonomies(taxonomies);
	const out = new Map<string, Map<string, string>>();
	for (const taxonomy of wanted) out.set(taxonomy, new Map());
	// Default locale first, so its slugs win where locales disagree.
	const rows = [...input].sort((a, b) => Number(b.locale === defaultLocale) - Number(a.locale === defaultLocale));
	const slugOf = new Map<string, string>();
	for (const r of rows) {
		for (const ref of [r.translation_group ?? r.id, r.id]) {
			for (const key of [`${r.name}|${r.locale ?? ""}|${ref}`, `${r.name}||*|${ref}`]) if (!slugOf.has(key)) slugOf.set(key, r.slug);
		}
	}
	for (const r of rows) {
		if (!r.parent_id || !r.slug) continue;
		const parent = slugOf.get(`${r.name}|${r.locale ?? ""}|${r.parent_id}`) ?? slugOf.get(`${r.name}||*|${r.parent_id}`);
		const map = out.get(r.name);
		if (map && parent && parent !== r.slug && !map.has(r.slug)) map.set(r.slug, parent);
	}
	applyTermParentOption(out, wanted);
	return out;
}

function applyTermParentOption(out: Map<string, Map<string, string>>, wanted: string[]): void {
	for (const taxonomy of wanted) {
		const fallback = config.termParents.get(taxonomy);
		if (!fallback) continue;
		const map = out.get(taxonomy)!;
		for (const [slug, parent] of fallback) if (!map.has(slug)) map.set(slug, parent);
	}
}

/**
 * First term slug per entry for each taxonomy, ordered as EmDash's
 * getTermsForEntries orders them (label ascending, locale-resolved terms).
 */
export async function primaryTerms(source: UrlSource, collection: string, ids: string[], taxonomies: string[]): Promise<Map<string, Record<string, string>>> {
	const out = new Map<string, Record<string, string>>();
	const unique = [...new Set(ids)];
	for (const id of unique) out.set(id, {});
	if (!unique.length || !taxonomies.length || !COLLECTION_SLUG.test(collection)) return out;

	if (!isD1(source)) {
		const { getTermsForEntries } = await import("emdash");
		for (const taxonomy of taxonomies) {
			const map = await getTermsForEntries(collection, unique, taxonomy).catch(() => new Map());
			for (const [id, terms] of map as Map<string, Array<{ slug: string }>>) {
				const first = terms[0]?.slug;
				if (first) out.get(id)![taxonomy] = first;
			}
		}
		return out;
	}

	// The SQL of EmDash's selectEntryTermRows (taxonomies/index.ts), for all wanted taxonomies at once.
	const defaultLocale = await hostDefaultLocale();
	for (const chunk of chunks(unique)) {
		let rows: PrimaryTermRow[];
		try {
			const q = primaryTermsQuery(collection, chunk, taxonomies, defaultLocale);
			rows = (await source.prepare(q.sql).bind(...q.binds).all<PrimaryTermRow>()).results;
		} catch {
			return out; // No taxonomy tables yet: no terms (fallbacks apply).
		}
		collectPrimaryTerms(rows, out);
	}
	return out;
}

/**
 * Term parents per taxonomy (term slug → parent term slug), read in one
 * query: EmDash's `taxonomies.parent_id` (the parent's translation_group, or
 * a row id before EmDash's migration 045), then the `termParents` option for
 * terms with no parent in the database. A parent in the entry's own locale
 * wins; otherwise the default locale's slug is used.
 */
export async function termParentMaps(source: UrlSource, taxonomies: string[]): Promise<Map<string, Map<string, string>>> {
	const wanted = [...new Set(taxonomies)].filter((t) => TAXONOMY_NAME.test(t));
	const out = new Map<string, Map<string, string>>();
	for (const taxonomy of wanted) out.set(taxonomy, new Map());
	if (!wanted.length) return out;

	if (!isD1(source)) {
		const { getTaxonomyTerms } = await import("emdash");
		type Node = { slug: string; children?: Node[] };
		for (const taxonomy of wanted) {
			const roots = (await getTaxonomyTerms(taxonomy, { includeCounts: false }).catch(() => [])) as Node[];
			const map = out.get(taxonomy)!;
			const walk = (nodes: Node[], parent: string | null, depth: number) => {
				if (depth > MAX_DEPTH) return;
				for (const node of nodes) {
					if (parent && node.slug && node.slug !== parent && !map.has(node.slug)) map.set(node.slug, parent);
					if (node.children?.length) walk(node.children, node.slug, depth + 1);
				}
			};
			walk(roots, null, 0);
		}
		applyTermParentOption(out, wanted);
		return out;
	}
	let rows: TermParentRow[] = [];
	try {
		const q = termParentsQuery(wanted);
		rows = (await source.prepare(q.sql).bind(...q.binds).all<TermParentRow>()).results;
	} catch {
		rows = []; // No taxonomy table yet: only the option applies.
	}
	return termParentsFromRows(rows, wanted, await hostDefaultLocale());
}

// ── Collections (D1) ─────────────────────────────────────────────

export interface CollectionInfo {
	slug: string;
	label: string;
	labelSingular: string | null;
	urlPattern: string | null;
	titleField: string | null;
}

/** Read collection metadata from the site's D1 database. */
export async function readCollections(db: D1Database, slugs?: string[]): Promise<Map<string, CollectionInfo>> {
	const wanted = slugs?.filter((s) => COLLECTION_SLUG.test(s));
	if (wanted && wanted.length === 0) return new Map();
	const sql = wanted?.length
		? `SELECT slug, label, label_singular, url_pattern, title_field FROM _emdash_collections WHERE slug IN (${wanted.map(() => "?").join(",")})`
		: "SELECT slug, label, label_singular, url_pattern, title_field FROM _emdash_collections";
	const { results } = await db
		.prepare(sql)
		.bind(...(wanted ?? []))
		.all<{ slug: string; label: string; label_singular: string | null; url_pattern: string | null; title_field: string | null }>();
	const out = new Map<string, CollectionInfo>();
	for (const r of results) {
		out.set(r.slug, { slug: r.slug, label: r.label, labelSingular: r.label_singular, urlPattern: r.url_pattern, titleField: r.title_field });
	}
	return out;
}

// ── Entry URLs ───────────────────────────────────────────────────

export interface EntryRef {
	id: string;
	slug?: string | null;
	/** Publish date (for date tokens). `date` is accepted as an alias. */
	publishedAt?: string | Date | null;
	date?: string | Date | null;
	locale?: string | null;
	/** When known and not "published", context sources answer null (like getPublicUrl). */
	status?: string | null;
	/** First term slug per taxonomy, when the caller already read them (primaryTermsQuery); skips the terms query. */
	terms?: Record<string, string>;
}

/** What a caller already knows, so the resolver doesn't read it again. */
export interface EntryUrlResolverOptions {
	/** Collection info (D1 sources): route patterns come from here instead of a query per collection. */
	collections?: ReadonlyMap<string, CollectionInfo>;
	/** Term parents per taxonomy (e.g. from a per-isolate cache), instead of termParentMaps. */
	termParents?: (taxonomies: string[]) => Promise<Map<string, Map<string, string>>>;
}

interface CollectionRoute {
	/** Override pattern, or EmDash's url_pattern (null = /<collection>/{slug}). */
	pattern: string | null;
	override: boolean;
	routable: boolean;
}

export interface EntryUrlResolver {
	/** Root-relative paths keyed by entry id (null: no public URL). */
	urls(collection: string, entries: EntryRef[]): Promise<Map<string, string | null>>;
	url(collection: string, entry: EntryRef): Promise<string | null>;
}

/**
 * A resolver that remembers collection info, the trailing-slash policy and
 * (with a context) whether local interpolation matches getPublicUrl for each
 * collection and locale. Use one per request or build.
 */
export function createEntryUrlResolver(source: UrlSource, options: EntryUrlResolverOptions = {}): EntryUrlResolver {
	const routes = new Map<string, Promise<CollectionRoute | null>>();
	const verdicts = new Map<string, "local" | "exact">();
	let policy: Promise<TrailingSlash> | null = null;
	const getPolicy = () => (policy ??= trailingPolicy(source));
	const parents = new Map<string, Promise<Map<string, string>>>();

	/** Term parents per taxonomy, loaded once per resolver (taxonomies not seen yet in one query). */
	async function termParents(taxonomies: string[]): Promise<Map<string, Map<string, string>>> {
		const missing = taxonomies.filter((t) => !parents.has(t));
		if (missing.length) {
			const batch = (options.termParents ? options.termParents(missing) : termParentMaps(source, missing)).catch(() => new Map<string, Map<string, string>>());
			for (const t of missing) parents.set(t, batch.then((m) => m.get(t) ?? new Map()));
		}
		const out = new Map<string, Map<string, string>>();
		for (const t of taxonomies) out.set(t, await parents.get(t)!);
		return out;
	}

	function route(collection: string): Promise<CollectionRoute | null> {
		let r = routes.get(collection);
		if (!r) {
			r = (async (): Promise<CollectionRoute | null> => {
				const override = urlOverride(collection);
				if (override) return { pattern: override, override: true, routable: true };
				if (isD1(source)) {
					const known = options.collections;
					const info = known ? known.get(collection) : (await readCollections(source, [collection]).catch(() => new Map<string, CollectionInfo>())).get(collection);
					return { pattern: info?.urlPattern ?? null, override: false, routable: true };
				}
				const info = await source.schema?.getCollection(collection).catch(() => null);
				if (!info) return null;
				return { pattern: info.urlPattern ?? null, override: false, routable: info.routable };
			})();
			routes.set(collection, r);
		}
		return r;
	}

	/** Publish dates for entries that didn't bring one, when the pattern needs them (D1 only). */
	async function fillDates(collection: string, entries: EntryRef[]): Promise<Map<string, string | null>> {
		const dates = new Map<string, string | null>();
		const missing = entries.filter((e) => e.publishedAt === undefined && e.date === undefined).map((e) => e.id);
		if (!missing.length || !isD1(source) || !COLLECTION_SLUG.test(collection)) return dates;
		for (const chunk of chunks([...new Set(missing)])) {
			try {
				const { results } = await source
					.prepare(`SELECT id, published_at FROM "ec_${collection}" WHERE id IN (${chunk.map(() => "?").join(",")})`)
					.bind(...chunk)
					.all<{ id: string; published_at: string | null }>();
				for (const r of results) dates.set(r.id, r.published_at);
			} catch {
				// Leave date tokens unresolved rather than fail.
			}
		}
		return dates;
	}

	async function exact(collection: string, id: string): Promise<string | null> {
		if (isD1(source)) return null;
		const url = await source.content?.getPublicUrl?.(collection, id).catch(() => null);
		if (!url) return null;
		try {
			const path = new URL(url).pathname;
			// A pack-level trailingSlash option wins over EmDash's.
			return config.trailingSlash ? applyTrailingSlash(path, config.trailingSlash) : path;
		} catch {
			return null;
		}
	}

	async function urls(collection: string, entries: EntryRef[]): Promise<Map<string, string | null>> {
		const out = new Map<string, string | null>();
		const r = await route(collection);
		const usable = entries.filter((e) => {
			const ok = !!r?.routable && !!e.slug && (isD1(source) || !e.status || e.status === "published");
			if (!ok) out.set(e.id, null);
			return ok;
		});
		if (!r || !usable.length) return out;
		const trailing = await getPolicy();
		const dates = patternUsesDate(r.pattern) ? await fillDates(collection, usable) : new Map<string, string | null>();
		const dateOf = (e: EntryRef) => e.publishedAt ?? e.date ?? dates.get(e.id) ?? null;

		if (r.override && r.pattern) {
			const taxonomies = patternTaxonomies(r.pattern);
			const pathTaxonomies = patternTermPathTaxonomies(r.pattern);
			const usesPagePath = patternUsesPagePath(r.pattern);
			const prefilled = usable.every((e) => e.terms !== undefined);
			const [terms, termParentsByTaxonomy] = await Promise.all([
				!taxonomies.length
					? new Map<string, Record<string, string>>()
					: prefilled
						? new Map(usable.map((e) => [e.id, e.terms as Record<string, string>]))
						: primaryTerms(source, collection, usable.map((e) => e.id), taxonomies),
				pathTaxonomies.length ? termParents(pathTaxonomies) : new Map<string, Map<string, string>>(),
			]);
			for (const e of usable) {
				const entryTerms = terms.get(e.id);
				let termPaths: Record<string, string[]> | undefined;
				for (const taxonomy of pathTaxonomies) {
					const leaf = entryTerms?.[taxonomy];
					if (leaf) (termPaths ??= {})[taxonomy] = ancestorTrail(leaf, termParentsByTaxonomy.get(taxonomy));
				}
				const slug = e.slug as string;
				out.set(e.id, overridePath(r.pattern, { collection, id: e.id, slug, date: dateOf(e), terms: entryTerms, termPaths, pagePath: usesPagePath ? pageTrail(slug) : null }, trailing));
			}
			return out;
		}

		for (const e of usable) {
			const local = applyTrailingSlash(interpolateUrlPattern({ pattern: r.pattern, collection, slug: e.slug as string, id: e.id, date: dateOf(e) }), trailing);
			if (isD1(source) || !source.content?.getPublicUrl) {
				out.set(e.id, local);
				continue;
			}
			// Context: getPublicUrl is authoritative (locale prefixes). Verify local interpolation once per collection and locale.
			const group = `${collection}|${e.locale ?? ""}`;
			const verdict = verdicts.get(group);
			if (verdict === "local") out.set(e.id, local);
			else if (verdict === "exact") out.set(e.id, await exact(collection, e.id));
			else {
				const real = await exact(collection, e.id);
				if (real !== null) verdicts.set(group, real === local ? "local" : "exact");
				out.set(e.id, real);
			}
		}
		return out;
	}

	return {
		urls,
		async url(collection, entry) {
			return (await urls(collection, [entry])).get(entry.id) ?? null;
		},
	};
}

/** Root-relative public path of one entry, or null. */
export async function entryUrl(source: UrlSource, collection: string, entry: EntryRef): Promise<string | null> {
	return createEntryUrlResolver(source).url(collection, entry);
}

/** Root-relative public paths of a list of entries (terms and dates read in batches), keyed by id. */
export async function entryUrls(source: UrlSource, collection: string, entries: EntryRef[]): Promise<Map<string, string | null>> {
	return createEntryUrlResolver(source).urls(collection, entries);
}

/** An absolute URL from a root-relative path and the site URL. */
export function absoluteUrl(path: string, siteUrl: string): string {
	return `${siteUrl.replace(/\/+$/, "")}${path}`;
}

// ── Reverse: path → entry ────────────────────────────────────────

export interface MatchedEntry {
	collection: string;
	id: string;
	/** The entry's canonical path (equal to the requested path, ignoring a trailing slash and encoding). */
	path: string;
}

interface Candidate extends EntryRef {
	slug: string;
}

/** Published entries of a collection with this slug (or id). */
async function findPublished(source: UrlSource, collection: string, by: "slug" | "id", value: string): Promise<Candidate[]> {
	if (!COLLECTION_SLUG.test(collection)) return [];
	if (isD1(source)) {
		try {
			const { results } = await source
				.prepare(`SELECT id, slug, published_at, locale FROM "ec_${collection}" WHERE ${by} = ? AND status = 'published' AND deleted_at IS NULL LIMIT 20`)
				.bind(value)
				.all<{ id: string; slug: string | null; published_at: string | null; locale: string | null }>();
			return results.filter((r) => r.slug).map((r) => ({ id: r.id, slug: r.slug as string, publishedAt: r.published_at, locale: r.locale, status: "published" }));
		} catch {
			return [];
		}
	}
	let id = value;
	if (by === "slug") {
		const { getEmDashEntry } = await import("emdash");
		const { entry } = await getEmDashEntry(collection, value).catch(() => ({ entry: null }));
		if (!entry) return [];
		const dataId = (entry.data as Record<string, unknown>).id;
		id = typeof dataId === "string" && dataId ? dataId : entry.id;
	}
	const item = await source.content?.get(collection, id).catch(() => null);
	if (!item || item.status !== "published" || !item.slug) return [];
	return [{ id: item.id, slug: item.slug, publishedAt: item.publishedAt, locale: item.locale, status: item.status }];
}

async function verify(resolver: EntryUrlResolver, collection: string, candidates: Candidate[], wanted: string): Promise<MatchedEntry | null> {
	if (!candidates.length) return null;
	const urls = await resolver.urls(collection, candidates);
	for (const c of candidates) {
		const path = urls.get(c.id);
		if (path && comparablePath(path) === wanted) return { collection, id: c.id, path };
	}
	return null;
}

async function matchPattern(source: UrlSource, resolver: EntryUrlResolver, collection: string, pattern: string, wanted: string): Promise<MatchedEntry | null> {
	let compiled: ReturnType<typeof compilePattern>;
	try {
		compiled = compilePattern(pattern);
	} catch {
		return null;
	}
	const m = compiled.regex.exec(wanted);
	if (!m) return null;
	const by = compiled.slug || compiled.pagePath ? "slug" : compiled.id ? "id" : null;
	if (!by) return null;
	// {pagepath}: the slug is its last segment.
	const value = compiled.slug ? m[compiled.slug] : compiled.pagePath ? m[compiled.pagePath]?.split("/").pop() : m[compiled.id];
	if (!value) return null;
	return verify(resolver, collection, await findPublished(source, collection, by, value), wanted);
}

/**
 * The published entry a site path belongs to, or null. Override patterns
 * first: e.g. for `/{term:category}/{slug}/` the entry is looked up by slug
 * and its primary category must match; for `/{termpath:category}/{slug}/`
 * the whole category path must (`/news/seo/a/`, not `/seo/a/`), and for
 * `/{pagepath}/` the whole parent chain. Then EmDash's own routing
 * (resolveEmDashPath with a context; url_pattern or /<collection>/{slug}
 * from D1). Every match is verified by resolving the entry's URL back.
 */
export async function matchEntryPath(source: UrlSource, path: string): Promise<MatchedEntry | null> {
	const wanted = comparablePath(path);
	if (!wanted.startsWith("/")) return null;
	const resolver = createEntryUrlResolver(source);

	for (const [collection, pattern] of config.urls) {
		const found = await matchPattern(source, resolver, collection, pattern, wanted);
		if (found) return found;
	}

	if (isD1(source)) {
		let rows: Array<{ slug: string; url_pattern: string | null; routable?: number | null }> = [];
		try {
			rows = (await source.prepare("SELECT slug, url_pattern, routable FROM _emdash_collections").all<{ slug: string; url_pattern: string | null; routable: number | null }>()).results;
		} catch {
			rows = [...(await readCollections(source).catch(() => new Map<string, CollectionInfo>())).values()].map((c) => ({ slug: c.slug, url_pattern: c.urlPattern }));
		}
		for (const row of rows) {
			if (config.urls.has(row.slug) || row.routable === 0) continue;
			const found = await matchPattern(source, resolver, row.slug, row.url_pattern ?? `/${row.slug}/{slug}`, wanted);
			if (found) return found;
		}
		return null;
	}

	// Context: EmDash's resolver for url_pattern collections, then the default /<collection>/<slug>.
	const { resolveEmDashPath } = await import("emdash");
	for (const candidate of new Set([wanted, `${wanted}/`])) {
		const match = await resolveEmDashPath(candidate).catch(() => null);
		if (!match) continue;
		const dataId = (match.entry.data as Record<string, unknown>).id;
		const id = typeof dataId === "string" && dataId ? dataId : match.entry.id;
		const item = await source.content?.get(match.collection, id).catch(() => null);
		if (item?.slug && item.status === "published") {
			const found = await verify(resolver, match.collection, [{ id: item.id, slug: item.slug, publishedAt: item.publishedAt, locale: item.locale, status: item.status }], wanted);
			if (found) return found;
		}
	}
	const segments = wanted.split("/").filter(Boolean);
	if (segments.length === 2 && !config.urls.has(segments[0])) {
		const info = await source.schema?.getCollection(segments[0]).catch(() => null);
		if (info?.routable && !info.urlPattern) {
			const found = await verify(resolver, segments[0], await findPublished(source, segments[0], "slug", segments[1]), wanted);
			if (found) return found;
		}
	}
	return null;
}

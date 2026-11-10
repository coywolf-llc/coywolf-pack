/**
 * Inbound internal links per entry, and orphans (published, indexable entries
 * nothing in your content links to), from the links Link Manager already
 * stores (links_urls, links_refs; see ./store.ts). Nothing new is stored.
 *
 * One report reads, from the site's D1 database:
 * - each routable collection's published entries (id, slug, dates, title,
 *   No index), one statement per collection, sent as one batch;
 * - their public paths (src/core/content-url.ts, which reads terms in chunks
 *   when a collection's URLs use them);
 * - the internal links (one statement over the `internal` index) and the
 *   entries that use them (pages of REF_PAGE rows, keyed on the primary key).
 * Then each link is matched to the entry at its path (or at the end of its
 * redirect) and the distinct published entries linking to it are counted.
 *
 * Navigation, footer, taxonomy and other theme links aren't in Link Manager's
 * index, so "orphan" means "no link from content".
 */
import { PLUGIN_ID } from "../core/features.js";
import { type CollectionInfo, comparablePath, createEntryUrlResolver } from "../core/content-url.js";

/** One published entry, with its inbound count. */
export interface InboundEntry {
	collection: string;
	id: string;
	title: string;
	/** Root-relative public path, or null when it has none (it can't be linked to then). */
	path: string | null;
	/** Distinct published entries that link to it (itself excluded). */
	inbound: number;
	noIndex: boolean;
	publishedAt: string | null;
	updatedAt: string | null;
}

export interface InboundReport {
	entries: InboundEntry[];
	/** Internal links that matched an entry, and those that didn't (links to tag pages, the home page, a 404…). */
	matched: number;
	unmatched: number;
	builtAt: string;
}

/** Collection slugs as EmDash allows them (its tables are `ec_<slug>`). */
const COLLECTION_SLUG = /^[a-z][a-z0-9_]*$/;
/** A column name the pack will put in SQL. */
const COLUMN = /^[a-z][a-z0-9_]*$/;
/** Reference rows per statement. */
export const REF_PAGE = 5_000;

export interface PageCollection extends CollectionInfo {
	routable: boolean;
}

/** Collections that have public pages (routable), from EmDash's collections table. */
export async function pageCollections(db: D1Database): Promise<PageCollection[]> {
	const { results } = await db.prepare("SELECT slug, label, label_singular, url_pattern, title_field, routable FROM _emdash_collections ORDER BY slug").all<{
		slug: string;
		label: string;
		label_singular: string | null;
		url_pattern: string | null;
		title_field: string | null;
		routable: number | null;
	}>();
	return (results ?? [])
		.filter((r) => COLLECTION_SLUG.test(r.slug) && r.routable !== 0)
		.map((r) => ({ slug: r.slug, label: r.label, labelSingular: r.label_singular, urlPattern: r.url_pattern, titleField: r.title_field, routable: true }));
}

interface EntryRow {
	id: string;
	slug: string | null;
	locale: string | null;
	published_at: string | null;
	updated_at: string | null;
	title: string | null;
	no_index: number | null;
}

/** The statement listing a collection's published entries (title from its title field, else the slug). */
export function publishedEntriesSql(collection: string, titleField: string | null): string {
	const titleColumn = titleField && COLUMN.test(titleField) ? `content."${titleField}"` : "content.slug";
	return `SELECT content.id AS id, content.slug AS slug, content.locale AS locale, content.published_at AS published_at, content.updated_at AS updated_at, ${titleColumn} AS title, coalesce(seo.seo_no_index, 0) AS no_index
		FROM "ec_${collection}" AS content
		LEFT JOIN _emdash_seo AS seo ON seo.collection = ? AND seo.content_id = content.id
		WHERE content.status = 'published' AND content.deleted_at IS NULL`;
}

/** Every internal link: its id, where it points and where it ends up. */
export const internalUrlsSql = `SELECT id, json_extract(data, '$.resolved') AS resolved, json_extract(data, '$.finalUrl') AS final_url
	FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND json_extract(data, '$.internal') = 1`;

/** A page of reference rows (link, entry using it, that entry's status), after `id`, in primary-key order. */
export const refPairsSql = `SELECT id, json_extract(data, '$.urlId') AS url_id, json_extract(data, '$.entryKey') AS entry_key, json_extract(data, '$.entryStatus') AS entry_status
	FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id > ? ORDER BY id LIMIT ?`;

export interface UrlTarget {
	id: string;
	resolved: string | null;
	finalUrl: string | null;
}

export interface RefPair {
	urlId: string;
	entryKey: string;
	entryStatus: string | null;
}

/** The comparable path of an absolute URL on the site, or null for another host or a non-URL. */
export function sitePath(url: string | null | undefined, siteHost: string): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		if (parsed.host.replace(/^www\./, "") !== siteHost.replace(/^www\./, "")) return null;
		return comparablePath(parsed.pathname);
	} catch {
		return null;
	}
}

/**
 * Count inbound links (pure). `entries` have their paths; a link counts for
 * the entry at its path or, when it redirects, at its final URL; each source
 * entry counts once per target, only when published, and never for itself.
 */
export function countInbound(
	entries: Array<Omit<InboundEntry, "inbound">>,
	urls: UrlTarget[],
	refs: RefPair[],
	siteUrl: string,
): { entries: InboundEntry[]; matched: number; unmatched: number } {
	let host = "";
	try {
		host = new URL(siteUrl).host;
	} catch {
		host = "";
	}
	const byPath = new Map<string, string>();
	for (const e of entries) if (e.path) byPath.set(comparablePath(e.path), `${e.collection}/${e.id}`);
	const target = new Map<string, string>();
	let unmatched = 0;
	for (const u of urls) {
		const key = byPath.get(sitePath(u.resolved, host) ?? "") ?? byPath.get(sitePath(u.finalUrl, host) ?? "");
		if (key) target.set(u.id, key);
		else unmatched++;
	}
	const sources = new Map<string, Set<string>>();
	for (const r of refs) {
		if (r.entryStatus && r.entryStatus !== "published") continue;
		const to = target.get(r.urlId);
		if (!to || to === r.entryKey) continue;
		const set = sources.get(to) ?? new Set<string>();
		set.add(r.entryKey);
		sources.set(to, set);
	}
	return {
		entries: entries.map((e) => ({ ...e, inbound: sources.get(`${e.collection}/${e.id}`)?.size ?? 0 })),
		matched: target.size,
		unmatched,
	};
}

/** Every published entry of the site's page collections, with its path. */
export async function publishedEntries(db: D1Database, collections: PageCollection[]): Promise<Array<Omit<InboundEntry, "inbound">>> {
	if (!collections.length) return [];
	const statements = collections.map((c) => db.prepare(publishedEntriesSql(c.slug, c.titleField)).bind(c.slug));
	let results: Array<{ results?: EntryRow[] }>;
	try {
		results = (await db.batch<EntryRow>(statements)) as Array<{ results?: EntryRow[] }>;
	} catch {
		// A title field that isn't a column (or a collection whose table is gone): one at a time, slug as the title.
		results = [];
		for (const c of collections) {
			results.push(await db.prepare(publishedEntriesSql(c.slug, null)).bind(c.slug).all<EntryRow>().catch(() => ({ results: [] })));
		}
	}
	const resolver = createEntryUrlResolver(db, { collections: new Map(collections.map((c) => [c.slug, c])) });
	const out: Array<Omit<InboundEntry, "inbound">> = [];
	for (const [i, c] of collections.entries()) {
		const rows = results[i]?.results ?? [];
		const paths = await resolver.urls(
			c.slug,
			rows.map((r) => ({ id: r.id, slug: r.slug, publishedAt: r.published_at, locale: r.locale })),
		);
		for (const r of rows) {
			const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 200) : (r.slug ?? r.id);
			out.push({ collection: c.slug, id: r.id, title, path: paths.get(r.id) ?? null, noIndex: Boolean(r.no_index), publishedAt: r.published_at, updatedAt: r.updated_at });
		}
	}
	return out;
}

/** The internal links and who uses them, from Link Manager's storage. */
export async function internalLinks(db: D1Database, maxRefs = 200_000): Promise<{ urls: UrlTarget[]; refs: RefPair[] }> {
	const { results: urlRows } = await db.prepare(internalUrlsSql).bind(PLUGIN_ID, "links_urls").all<{ id: string; resolved: string | null; final_url: string | null }>();
	const urls = (urlRows ?? []).map((r) => ({ id: r.id, resolved: r.resolved, finalUrl: r.final_url }));
	const internal = new Set(urls.map((u) => u.id));
	const refs: RefPair[] = [];
	let after = "";
	for (let read = 0; read < maxRefs; read += REF_PAGE) {
		const { results } = await db
			.prepare(refPairsSql)
			.bind(PLUGIN_ID, "links_refs", after, REF_PAGE)
			.all<{ id: string; url_id: string | null; entry_key: string | null; entry_status: string | null }>();
		const rows = results ?? [];
		for (const r of rows) if (r.url_id && r.entry_key && internal.has(r.url_id)) refs.push({ urlId: r.url_id, entryKey: r.entry_key, entryStatus: r.entry_status });
		if (rows.length < REF_PAGE) break;
		after = rows[rows.length - 1].id;
	}
	return { urls, refs };
}

/** The whole report: every published entry of the page collections with its inbound count. */
export async function inboundReport(db: D1Database, siteUrl: string): Promise<InboundReport> {
	const collections = await pageCollections(db);
	const [entries, links] = await Promise.all([publishedEntries(db, collections), internalLinks(db)]);
	const counted = countInbound(entries, links.urls, links.refs, siteUrl);
	return { ...counted, builtAt: new Date().toISOString() };
}

// ── Suggestions ──────────────────────────────────────────────────

/**
 * Up to `limit` published entries of the same collection that share the most
 * categories or tags with the entry (newest first among ties): good places to
 * add a link to it from.
 */
export function relatedEntriesSql(collection: string): string {
	return `SELECT other.id AS id, COUNT(DISTINCT other_pivot.taxonomy_id) AS shared
		FROM "ec_${collection}" AS content
		INNER JOIN content_taxonomies AS pivot ON pivot.entry_id = content.translation_group AND pivot.collection = ?
		INNER JOIN content_taxonomies AS other_pivot ON other_pivot.taxonomy_id = pivot.taxonomy_id AND other_pivot.collection = ?
		INNER JOIN "ec_${collection}" AS other ON other.translation_group = other_pivot.entry_id
		WHERE content.id = ? AND other.id != content.id AND other.status = 'published' AND other.deleted_at IS NULL
		GROUP BY other.id
		ORDER BY shared DESC, other.published_at DESC
		LIMIT ?`;
}

/** Related entries for each entry asked about (one batch of one statement each). Keyed "collection/id". */
export async function relatedEntries(db: D1Database, entries: Array<{ collection: string; id: string }>, limit = 3): Promise<Map<string, Array<{ id: string; shared: number }>>> {
	const wanted = entries.filter((e) => COLLECTION_SLUG.test(e.collection));
	const out = new Map<string, Array<{ id: string; shared: number }>>();
	if (!wanted.length) return out;
	const statements = wanted.map((e) => db.prepare(relatedEntriesSql(e.collection)).bind(e.collection, e.collection, e.id, limit));
	const results = (await db.batch<{ id: string; shared: number }>(statements)) as Array<{ results?: Array<{ id: string; shared: number }> }>;
	wanted.forEach((e, i) => out.set(`${e.collection}/${e.id}`, (results[i]?.results ?? []).map((r) => ({ id: r.id, shared: Number(r.shared) || 0 }))));
	return out;
}

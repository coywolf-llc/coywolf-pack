/**
 * Child pages: reading parent trees from D1, and what the URL resolver
 * (src/core/content-url.ts) asks of them.
 *
 * EmDash keeps a reference field's selection in `_emdash_content_references`
 * (one row per link, both ends by translation group) under a relation named in
 * the field's `validation` (`_emdash_fields`). The link table holds only the
 * published selection: a selection saved on an entry with drafts waits in the
 * draft revision's data (`_references`) until it's published. Contract tests
 * check these tables and keys (test/emdash-contract.test.mjs).
 *
 * Reads are shared by everything that renders one page (src/core/request-memo.ts).
 * A collection's tree is one D1 round trip (readCollection): a batch with the
 * collections and their fields, the collection's rows (no content columns) and its
 * links. A caller that already has the collections (readMeta) reads the rows and
 * links in one batch (readTree). The Child pages hooks call invalidatePageTrees()
 * before they look again, so a read from before a publish isn't reused after it.
 */
import { COLLECTION_SLUG, type ChildPagesState, type CollectionInfo, type StoredParents, type StoredParentsProvider, type UrlSource, comparablePath, createEntryUrlResolver, hostDefaultLocale } from "../core/content-url.js";
import { isOn, knownFeatures, knownSiteSetting, registerSiteSetting, siteFeatureState } from "../core/features.js";
import { noteReadFailure } from "../core/read-failures.js";
import { peekRequestMemo, requestMemo, seedRequestMemo } from "../core/request-memo.js";
import { workerEnv } from "../shared.js";
import { PARENT_FIELD, type PageRow, type PageTreeData, type ParentLink, buildPageTree, storedParentsOf } from "./tree.js";

export const CHILD_PAGES_FEATURE = "childPages";

/**
 * Plugin setting changed whenever published pages of a collection with a parent field change
 * (publish, unpublish, trash, delete, restore): part of the URL fingerprint, so caches keyed on
 * it (live search answers) don't keep old page URLs.
 */
export const VERSION_SETTING = "childPagesVersion";
registerSiteSetting(VERSION_SETTING);

/** A collection, with its parent field when it has one. */
export interface CollectionMeta {
	collection: string;
	label: string;
	titleField: string | null;
	urlPattern: string | null;
	routable: boolean;
	/** The parent field, when it's a reference to the collection itself. */
	field: { id: string; relation: string; side: "parent" | "child" } | null;
	/** A field named parent_page that isn't one (another type or target): Set up can't add the field. */
	conflict: string | null;
}

/** Every collection, with its parent_page field (if any). */
export const META_SQL = `SELECT c.slug AS collection, c.label AS label, c.title_field AS title_field, c.url_pattern AS url_pattern, c.routable AS routable, f.id AS field_id, f.type AS field_type, f.validation AS validation
	FROM _emdash_collections c LEFT JOIN _emdash_fields f ON f.collection_id = c.id AND f.slug = ?
	ORDER BY c.slug`;

/** A reference field's links: the entry that holds the field and the entry it names (parent side), both by translation group. */
export const LINKS_SQL = `SELECT e.parent_group AS holder, e.child_group AS target
	FROM _emdash_content_references e JOIN _emdash_relations r ON r.id = e.relation_id
	WHERE r.slug = ?`;

/**
 * The same links, found from the collection and the field's slug (the relation is in the field's
 * `validation`), for a read that doesn't have the collections yet (readCollection).
 */
export const LINKS_BY_FIELD_SQL = `SELECT e.parent_group AS holder, e.child_group AS target
	FROM _emdash_content_references e JOIN _emdash_relations r ON r.id = e.relation_id
	WHERE r.slug = (SELECT json_extract(f.validation, '$.relation') FROM _emdash_fields f JOIN _emdash_collections c ON c.id = f.collection_id WHERE c.slug = ? AND f.slug = ? LIMIT 1)`;

const COLUMN = /^[a-z][a-z0-9_]*$/;
/** The title column of a collection, as SQL (its title field, else "title"). */
export const titleColumn = (field: string | null | undefined) => (field && COLUMN.test(field) ? `"${field}"` : `"title"`);

/** A collection's rows that aren't in the trash, with what the tree needs. */
export function rowsSql(collection: string, title: string): string {
	return `SELECT id, slug, locale, translation_group, status, published_at, draft_revision_id, live_revision_id, ${title} AS title FROM "ec_${collection}" WHERE deleted_at IS NULL`;
}

interface MetaRow {
	collection: string;
	label: string | null;
	title_field: string | null;
	url_pattern: string | null;
	routable: number | null;
	field_id: string | null;
	field_type: string | null;
	validation: string | null;
}

/** The meta rows as collections (pure). */
export function metaFromRows(rows: MetaRow[]): CollectionMeta[] {
	return rows.map((row) => {
		let field: CollectionMeta["field"] = null;
		let conflict: string | null = null;
		if (row.field_id) {
			let validation: Record<string, unknown> = {};
			try {
				validation = row.validation ? (JSON.parse(row.validation) as Record<string, unknown>) : {};
			} catch {
				validation = {};
			}
			if (row.field_type === "reference" && validation.targetCollection === row.collection && typeof validation.relation === "string") {
				field = { id: row.field_id, relation: validation.relation, side: validation.relationSide === "child" ? "child" : "parent" };
			} else {
				conflict = row.field_type !== "reference" ? `a ${row.field_type ?? "different"} field` : `a reference to ${String(validation.targetCollection ?? "another collection")}`;
			}
		}
		return { collection: row.collection, label: row.label ?? row.collection, titleField: row.title_field, urlPattern: row.url_pattern, routable: row.routable !== 0, field, conflict };
	});
}

let generation = 0;

/** Forget this request's tree reads (after a write that changes them). */
export function invalidatePageTrees(): void {
	generation++;
	titleColumns.clear();
}

const metaKey = () => `childPages:meta:${generation}`;
const treeKey = (collection: string, withLinks: boolean) => `childPages:tree:${generation}:${collection}:${withLinks ? 1 : 0}`;

/**
 * The title column that reads for a collection, learned in this isolate: `use` is the SQL to select
 * ("NULL" when the collection has no such column), valid while its title field is still `for`.
 * readCollection reads the rows before it knows the title field, so it needs the answer beforehand.
 */
const titleColumns = new Map<string, { for: string; use: string; at: number }>();
/** How long a learned title column is trusted: a collection's fields can change (a title field added). */
const TITLE_COLUMN_TTL_MS = 5 * 60_000;
const DEFAULT_TITLE = titleColumn(null);
const missingColumn = (error: unknown) => /no such (column|table)/i.test(String((error as { message?: unknown } | null)?.message ?? error));

/** Every collection and its parent field, once per request. */
export function readMeta(db: D1Database): Promise<CollectionMeta[]> {
	return requestMemo(metaKey(), async () => {
		const { results } = await db.prepare(META_SQL).bind(PARENT_FIELD).all<MetaRow>();
		return metaFromRows(results.filter((r) => COLLECTION_SLUG.test(r.collection)));
	});
}

/** A collection's rows and (with `links`) its parent links, read in one batch. Null for an unknown collection. */
export function readTree(db: D1Database, meta: CollectionMeta, links: boolean): Promise<PageTreeData> {
	const withLinks = links && meta.field !== null;
	return requestMemo(treeKey(meta.collection, withLinks), async () => {
		const defaultLocale = await hostDefaultLocale();
		const rowsStatement = (title: string) => db.prepare(rowsSql(meta.collection, title));
		const linkStatement = withLinks && meta.field ? db.prepare(LINKS_SQL).bind(meta.field.relation) : null;
		const wanted = titleColumn(meta.titleField);
		let rows: PageRow[];
		let edges: Array<{ holder: string; target: string }> = [];
		try {
			const statements = [rowsStatement(wanted), ...(linkStatement ? [linkStatement] : [])];
			const results = typeof db.batch === "function" ? await db.batch(statements) : await Promise.all(statements.map((s) => s.all()));
			rows = (results[0]?.results ?? []) as PageRow[];
			edges = (results[1]?.results ?? []) as Array<{ holder: string; target: string }>;
			titleColumns.set(meta.collection, { for: wanted, use: wanted, at: Date.now() });
		} catch (error) {
			// No title column (a collection whose title field is something else, or none): the slugs stand in.
			// Any other failure (D1 unreachable for a moment) is the caller's: a tree read with nothing in it
			// would make every page top level.
			if (!/no such column/i.test(String((error as { message?: unknown } | null)?.message ?? error))) throw error;
			rows = (await rowsStatement("NULL").all<PageRow>()).results;
			if (linkStatement) edges = (await linkStatement.all<{ holder: string; target: string }>()).results;
			titleColumns.set(meta.collection, { for: wanted, use: "NULL", at: Date.now() });
		}
		return treeFrom(meta, rows, edges, defaultLocale);
	});
}

type Edge = { holder: string; target: string };

function treeFrom(meta: CollectionMeta, rows: PageRow[], edges: Edge[], defaultLocale: string): PageTreeData {
	const side = meta.field?.side ?? "parent";
	const parentLinks: ParentLink[] = edges.map((e) => (side === "parent" ? { entry: e.holder, parent: e.target } : { entry: e.target, parent: e.holder }));
	return buildPageTree(meta.collection, rows, parentLinks, defaultLocale);
}

/**
 * A collection with its tree in one D1 round trip: the collections and their fields, the collection's
 * rows and (with `links`) its links, in one batch. What a theme's loadPageTree costs an uncached page.
 * The other readers of the request (readMeta, readTree) share the result. Falls back to those two reads
 * when the collections are already read, and the first time a collection's title column has to be found
 * (one that isn't "title", or none). Null for an unknown collection.
 */
export async function readCollection(db: D1Database, collection: string, links: boolean): Promise<{ meta: CollectionMeta; tree: PageTreeData } | null> {
	const twoReads = async () => {
		const meta = (await readMeta(db)).find((m) => m.collection === collection);
		return meta ? { meta, tree: await readTree(db, meta, links) } : null;
	};
	if (!COLLECTION_SLUG.test(collection)) return null;
	if (peekRequestMemo(metaKey()) || typeof db.batch !== "function") return twoReads();
	const learned = titleColumns.get(collection);
	const guess = learned && Date.now() - learned.at < TITLE_COLUMN_TTL_MS ? learned : { for: DEFAULT_TITLE, use: DEFAULT_TITLE };
	const defaultLocale = await hostDefaultLocale();
	const started = generation;
	let results: Awaited<ReturnType<D1Database["batch"]>>;
	try {
		results = await db.batch([db.prepare(META_SQL).bind(PARENT_FIELD), db.prepare(rowsSql(collection, guess.use)), ...(links ? [db.prepare(LINKS_BY_FIELD_SQL).bind(collection, PARENT_FIELD)] : [])]);
	} catch (error) {
		// No such table (an unknown collection) or no such title column: the two reads find out. Anything else is the caller's.
		if (!missingColumn(error)) throw error;
		return twoReads();
	}
	const metas = metaFromRows(((results[0]?.results ?? []) as MetaRow[]).filter((r) => COLLECTION_SLUG.test(r.collection)));
	if (generation === started) seedRequestMemo(metaKey(), Promise.resolve(metas));
	const meta = metas.find((m) => m.collection === collection);
	if (!meta) return null;
	// The rows were read with a title column chosen before the title field was known: read again if it wasn't the one.
	if (titleColumn(meta.titleField) !== guess.for) return { meta, tree: await readTree(db, meta, links) };
	const withLinks = links && meta.field !== null;
	const tree = treeFrom(meta, (results[1]?.results ?? []) as PageRow[], withLinks ? ((results[2]?.results ?? []) as Edge[]) : [], defaultLocale);
	if (generation === started) seedRequestMemo(treeKey(collection, withLinks), Promise.resolve(tree));
	return { meta, tree };
}

// ── The URL resolver's provider ──────────────────────────────────

const isD1 = (source: UrlSource): source is D1Database => typeof (source as D1Database).prepare === "function";

export interface ProviderDeps {
	/** Whether the feature is on (default: the switch, from the per-isolate settings cache). */
	enabled?: () => Promise<boolean>;
	/** The database for a source (default: a D1 source itself, else the DB binding). */
	database?: (source: UrlSource) => Promise<D1Database | null>;
}

/**
 * Whether the feature is on, from the per-isolate switches. When they can't be read (they then
 * read as their defaults, with Child Pages off), the isolate's last read decides; without one
 * this rejects: "off" would give nested pages their flat URLs (see parentsUnreadable in
 * src/core/content-url.ts).
 */
const featureOn = async () => {
	const { features, ok } = await siteFeatureState();
	if (ok) return isOn(features, CHILD_PAGES_FEATURE);
	const known = knownFeatures();
	if (known) return isOn(known, CHILD_PAGES_FEATURE);
	throw new Error("coywolf-pack: Child Pages: the feature switches couldn't be read");
};

/** The site's D1 database: the source when it is one, else the DB binding. */
export async function databaseFor(source?: UrlSource | null): Promise<D1Database | null> {
	if (source && isD1(source)) return source;
	try {
		return ((await workerEnv()).DB as D1Database | undefined) ?? null;
	} catch {
		return null;
	}
}

/** Child pages state for a resolver, read now: the collections with a parent field and their stored parents. */
export async function readChildPagesState(db: D1Database): Promise<ChildPagesState> {
	const meta = await readMeta(db);
	const nesting = meta.filter((m) => m.field);
	const parents = new Map<string, StoredParents>();
	for (const m of nesting) parents.set(m.collection, storedParentsOf(await readTree(db, m, true)));
	return { collections: new Set(nesting.map((m) => m.collection)), parents: (collection) => parents.get(collection) ?? null };
}

/** What src/core/content-url.ts asks for: collections that nest by their field, and their parents, while the feature is on. */
export function childPagesProvider(deps: ProviderDeps = {}): StoredParentsProvider {
	const enabled = deps.enabled ?? featureOn;
	const database = deps.database ?? databaseFor;
	const empty: ReadonlySet<string> = new Set();
	return {
		async collections(source) {
			if (!(await enabled())) return empty;
			const db = await database(source);
			if (!db) return empty;
			return new Set((await readMeta(db)).filter((m) => m.field).map((m) => m.collection));
		},
		async parents(source, collection) {
			if (!(await enabled())) return null;
			const db = await database(source);
			const meta = db ? (await readMeta(db)).find((m) => m.collection === collection) : undefined;
			if (!db || !meta?.field) return null;
			return storedParentsOf(await readTree(db, meta, true));
		},
		fingerprint: () => {
			const version = knownSiteSetting<string>(VERSION_SETTING);
			return typeof version === "string" ? version : "";
		},
	};
}

// ── Trees with URLs ──────────────────────────────────────────────

export interface CollectionTree {
	meta: CollectionMeta;
	tree: PageTreeData;
	/** Each entry's URL (drafts too: where they'd be), root-relative; null when it has none. */
	urls: Map<string, string | null>;
	/** Stored parents applied (the feature on and the collection has its field). */
	nested: boolean;
}

/**
 * A collection's tree and every entry's URL. `on` overrides the switch (to compare URLs
 * with the feature on and off); by default the live switch decides.
 */
export async function collectionTree(db: D1Database, collection: string, options: { on?: boolean } = {}): Promise<CollectionTree | null> {
	// A switch that can't be read rejects (featureOn): the admin and a theme's loadPageTree fail rather than show flat URLs.
	const on = options.on ?? (await featureOn());
	const read = await readCollection(db, collection, on);
	if (!read) return null;
	const { meta, tree } = read;
	const state = on ? await readChildPagesState(db) : null;
	// The collections' URL patterns are already read: the resolver doesn't read them again.
	const collections = new Map<string, CollectionInfo>((await readMeta(db)).map((m) => [m.collection, { slug: m.collection, label: m.label, labelSingular: null, urlPattern: m.urlPattern, titleField: m.titleField }]));
	const resolver = createEntryUrlResolver(db, { childPages: state, collections });
	const entries = [...tree.nodes.values()].filter((n) => n.slug).map((n) => ({ id: n.id, slug: n.slug, publishedAt: n.publishedAt, locale: n.locale }));
	const urls = await resolver.urls(collection, entries);
	return { meta, tree, urls, nested: Boolean(on && meta.field) };
}

/**
 * Titles of published pages by URL path (decoded, no trailing slash), for breadcrumb
 * trails derived from a page's path (Breadcrumb Nav, the schema's BreadcrumbList): the
 * ancestors get their real titles instead of their humanized slugs. Null while the
 * feature is off or no collection has the field. Read once per request.
 */
export async function pageTitlesByPath(db?: D1Database | null): Promise<Map<string, string> | null> {
	try {
		return await pageTitles(db);
	} catch (error) {
		// The trail falls back to humanized slugs (the callers catch this): not a page for the edge cache.
		noteReadFailure("child pages: page titles");
		throw error;
	}
}

async function pageTitles(db?: D1Database | null): Promise<Map<string, string> | null> {
	if (!(await featureOn())) return null;
	const d1 = db ?? (await databaseFor());
	if (!d1) return null;
	const nesting = (await readMeta(d1)).filter((m) => m.field);
	if (!nesting.length) return null;
	return requestMemo(`childPages:titles:${generation}`, async () => {
		const out = new Map<string, string>();
		for (const meta of nesting) {
			const ct = await collectionTree(d1, meta.collection, { on: true });
			for (const node of ct?.tree.nodes.values() ?? []) {
				const url = ct?.urls.get(node.id);
				const title = node.title?.trim();
				if (!node.published || !url || !title) continue;
				const path = comparablePath(url);
				if (!out.has(path)) out.set(path, title);
			}
		}
		return out;
	});
}

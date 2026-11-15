// Run: node --test test/child-pages.test.mjs
//
// Child Pages (src/childPages): the parent tree (loops, unpublished parents, locales), the URL
// resolver following stored parents ahead of the pageParents option, the theme helpers
// (loadPageTree's tree, resolvePagePath, nestMenuUrls), the import's dry run, descendant 301s
// and the switch re-settle (with the Redirect Manager's real rule planning), breadcrumb titles,
// and the publish guard that refuses a loop.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tree = await import("../src/childPages/tree.ts");
const cu = await import("../src/core/content-url.ts");
const read = await import("../src/childPages/read.ts");
const theme = await import("../src/childPages/theme.ts");
const { buildPageTree, storedParentsOf, ancestorsOf, childrenOf, descendantsOf, warningsFor, loopWith, DEPTH_WARNING } = tree;
const { configureContentUrls, configureStoredParents, createEntryUrlResolver, entryUrl, matchEntryPath, pageTrailFor, pagePathPattern, contentUrlFingerprint } = cu;

const row = (id, slug, extra = {}) => ({ id, slug, locale: "en", translation_group: id, status: "published", title: slug ? slug[0].toUpperCase() + slug.slice(1) : null, ...extra });
const link = (entry, parent) => ({ entry, parent });

// ── The tree (pure) ──

test("a page nests under a published parent; an unpublished, scheduled, trashed (absent) or deleted parent leaves it top level", () => {
	const t = buildPageTree(
		"pages",
		[row("a", "apps"), row("b", "pack"), row("c", "draft-parent", { status: "draft" }), row("d", "under-draft"), row("e", "under-gone"), row("f", "under-scheduled"), row("g", "later", { status: "scheduled" })],
		[link("b", "a"), link("d", "c"), link("e", "zz"), link("f", "g")],
	);
	assert.equal(t.nodes.get("b").effectiveParentId, "a");
	assert.equal(t.nodes.get("d").parentId, "c");
	assert.equal(t.nodes.get("d").effectiveParentId, null);
	assert.deepEqual(warningsFor(t, "d"), ["parentUnpublished"]);
	assert.equal(t.nodes.get("e").hasParent, true);
	assert.equal(t.nodes.get("e").parentId, null);
	assert.deepEqual(warningsFor(t, "e"), ["parentMissing"]);
	assert.equal(t.nodes.get("f").effectiveParentId, null, "a scheduled parent isn't live yet");
	const stored = storedParentsOf(t);
	assert.equal(stored.parentOf.get("b"), "apps");
	assert.equal(stored.parentOf.get("d"), null, "a value that doesn't count: top level, not the option's parent");
	assert.equal(stored.parentOf.has("a"), false, "no value: the option applies");
	assert.equal(stored.idOf.get("pack"), "b");
	assert.equal(stored.idOf.has("draft-parent"), false, "only published entries are followed");
	const drafted = storedParentsOf(buildPageTree("pages", [row("a", "apps"), row("b", "pack", { status: "draft" })], [link("b", "a")]));
	assert.equal(drafted.parentOf.get("b"), "apps", "a draft's URL is under its parent too (an unpublished page's former URL, a draft's future one)");
});

test("loops: a page that is its own parent, and a cycle, are top level; pages below the loop keep their parents", () => {
	const t = buildPageTree("pages", [row("s", "self"), row("a", "a"), row("b", "b"), row("c", "c"), row("x", "below")], [link("s", "s"), link("a", "b"), link("b", "c"), link("c", "a"), link("x", "a")]);
	for (const id of ["s", "a", "b", "c"]) {
		assert.equal(t.nodes.get(id).loop, true, id);
		assert.equal(t.nodes.get(id).effectiveParentId, null, id);
		assert.ok(warningsFor(t, id).includes("loop"), id);
	}
	assert.equal(t.nodes.get("x").loop, false);
	assert.equal(t.nodes.get("x").effectiveParentId, "a", "below the loop: nested under its (top-level) parent");
	assert.deepEqual(ancestorsOf(t, "x").map((n) => n.id), ["a"]);
});

test("loopWith: choosing the entry itself or one of its descendants is a loop, with the chain", () => {
	const t = buildPageTree("pages", [row("a", "apps"), row("b", "pack"), row("c", "docs")], [link("b", "a"), link("c", "b")]);
	assert.deepEqual(loopWith(t, "a", "a"), ["Apps"]);
	assert.deepEqual(loopWith(t, "a", "c"), ["Docs", "Pack", "Apps"], "docs → pack → apps: apps would be under itself");
	assert.equal(loopWith(t, "c", "a"), null, "moving docs straight under apps is fine");
	assert.equal(loopWith(t, "b", "zz"), null, "an unknown parent ends the chain");
});

test("children, descendants and depth warnings follow the parents that count", () => {
	const rows = [row("r", "root")];
	const links = [];
	for (let i = 1; i <= DEPTH_WARNING; i++) {
		rows.push(row(`n${i}`, `level-${i}`));
		links.push(link(`n${i}`, i === 1 ? "r" : `n${i - 1}`));
	}
	rows.push(row("z", "zebra"), row("y", "123", { status: "draft" }));
	links.push(link("z", "r"), link("y", "r"));
	const t = buildPageTree("pages", rows, links);
	assert.deepEqual(childrenOf(t, "r").map((n) => n.id), ["y", "n1", "z"], "every child that names it, by title (drafts too)");
	assert.deepEqual(childrenOf(t, "r", { effective: true }).map((n) => n.id).sort(), ["n1", "y", "z"].sort());
	assert.equal(descendantsOf(t, "r").length, DEPTH_WARNING + 2);
	assert.ok(warningsFor(t, `n${DEPTH_WARNING - 1}`).includes("deep"));
	assert.ok(!warningsFor(t, `n${DEPTH_WARNING - 2}`).includes("deep"));
	assert.ok(warningsFor(t, "y").includes("digitSlug"));
});

test("translations: a parent in the entry's own locale, else the default locale's; idOf prefers the default locale", () => {
	const t = buildPageTree(
		"pages",
		[row("a-en", "apps", { translation_group: "A" }), row("a-fr", "applis", { locale: "fr", translation_group: "A" }), row("b-en", "pack", { translation_group: "B" }), row("b-fr", "pack", { locale: "fr", translation_group: "B" }), row("c-de", "paket", { locale: "de", translation_group: "C" })],
		[link("B", "A"), link("C", "A")],
		"en",
	);
	assert.equal(t.nodes.get("b-fr").parentId, "a-fr");
	assert.equal(t.nodes.get("b-en").parentId, "a-en");
	assert.equal(t.nodes.get("c-de").parentId, "a-en", "no German Apps: the default locale's");
	const stored = storedParentsOf(t);
	assert.equal(stored.idOf.get("pack"), "b-en");
	assert.equal(stored.parentOf.get("b-fr"), "applis");
});

test("pending changes: a draft revision that isn't the live one", () => {
	const t = buildPageTree("pages", [row("a", "a", { draft_revision_id: "r2", live_revision_id: "r1" }), row("b", "b", { draft_revision_id: "r1", live_revision_id: "r1" }), row("c", "c")], []);
	assert.equal(t.nodes.get("a").pendingChanges, true);
	assert.equal(t.nodes.get("b").pendingChanges, false);
	assert.equal(t.nodes.get("c").pendingChanges, false);
	assert.equal(t.nodes.get("a").draftRevisionId, "r2");
});

// ── The resolver ──

test("pageTrailFor: the stored parent wins over pageParents; a value that doesn't count ends the chain; the option fills in", () => {
	configureContentUrls({ pageParents: { pack: "tools", docs: "pack", huzzah: "newsletter", orphan: "apps" } });
	const stored = { parentOf: new Map([["p", "apps"], ["o", null]]), idOf: new Map([["apps", "a"], ["pack", "p"], ["docs", "d"], ["orphan", "o"]]) };
	assert.deepEqual(pageTrailFor("pack", "p", stored), ["apps", "pack"], "stored apps, not the option's tools");
	assert.deepEqual(pageTrailFor("docs", "d", stored), ["apps", "pack", "docs"], "docs has no value: the option's pack, then pack's stored apps");
	assert.deepEqual(pageTrailFor("huzzah", "h", stored), ["newsletter", "huzzah"], "a parent that isn't a page stays in the option");
	assert.deepEqual(pageTrailFor("orphan", "o", stored), ["orphan"], "its parent doesn't count: top level, the option ignored");
	assert.deepEqual(pageTrailFor("pack", "p", null), ["tools", "pack"], "feature off: the option alone");
	configureContentUrls({});
});

test("pagePathPattern: {slug} becomes {pagepath}; EmDash's default pattern without one; none without {slug}", () => {
	assert.equal(pagePathPattern("/{slug}/", "pages"), "/{pagepath}/");
	assert.equal(pagePathPattern(null, "pages"), "/pages/{pagepath}");
	assert.equal(pagePathPattern("/docs/{pagepath}", "docs"), "/docs/{pagepath}");
	assert.equal(pagePathPattern("/{id}", "items"), null);
});

function fakeD1(sql) {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE _emdash_collections (id TEXT, slug TEXT, label TEXT, label_singular TEXT, url_pattern TEXT, title_field TEXT, routable INTEGER DEFAULT 1);
		CREATE TABLE _emdash_fields (id TEXT, collection_id TEXT, slug TEXT, type TEXT, validation TEXT);
		CREATE TABLE _emdash_relations (id TEXT, slug TEXT);
		CREATE TABLE _emdash_content_references (id TEXT, relation_id TEXT, parent_group TEXT, child_group TEXT);
		CREATE TABLE ec_pages (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT, draft_revision_id TEXT, live_revision_id TEXT);
		CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT, draft_revision_id TEXT, live_revision_id TEXT);
		CREATE TABLE revisions (id TEXT PRIMARY KEY, data TEXT);
		CREATE TABLE content_taxonomies (collection TEXT, entry_id TEXT, taxonomy_id TEXT);
		CREATE TABLE taxonomies (id TEXT, name TEXT, slug TEXT, label TEXT, parent_id TEXT, locale TEXT, translation_group TEXT);
		INSERT INTO _emdash_collections VALUES ('c1','pages','Pages','Page','/{slug}/','title',1), ('c2','posts','Posts','Post','/blog/{slug}',NULL,1);
		INSERT INTO _emdash_fields VALUES ('f1','c1','parent_page','reference','{"targetCollection":"pages","relation":"pages_parent_page","relationSide":"parent"}');
		INSERT INTO _emdash_relations VALUES ('r1','pages_parent_page');
	`);
	if (sql) db.exec(sql);
	const statement = (q, params = []) => ({
		bind: (...p) => statement(q, p),
		all: async () => ({ results: db.prepare(q).all(...params) }),
		first: async () => db.prepare(q).get(...params) ?? null,
		run: async () => ({ meta: { changes: Number(db.prepare(q).run(...params).changes) } }),
	});
	return {
		raw: db,
		prepare: (q) => statement(q),
		batch: async (statements) => Promise.all(statements.map((s) => s.all())),
	};
}

const pages = (rows) => rows.map(([id, slug, status = "published", title = slug]) => `('${id}','${slug}','${status}','2024-01-01 00:00:00','en','${id}',NULL,'${title}',NULL,NULL)`).join(",");
const SITE = `
	INSERT INTO ec_pages VALUES ${pages([["a", "apps", "published", "Coywolf apps"], ["p", "coywolf-pack", "published", "Coywolf Pack"], ["d", "docs"], ["h", "huzzah"], ["x", "about"]])};
	INSERT INTO _emdash_content_references VALUES ('e1','r1','p','a'), ('e2','r1','d','p');
`;

/** The provider with the switch and database given (tests have no Worker). */
function provide(db, on = true) {
	configureStoredParents(read.childPagesProvider({ enabled: async () => on, database: async () => db }));
}

test("with Child Pages on, a collection with the field nests by {pagepath} without configuration (EmDash's trailing slash)", async () => {
	const db = fakeD1(SITE);
	configureContentUrls({ pageParents: { huzzah: "newsletter" } });
	provide(db);
	try {
		const urls = await createEntryUrlResolver(db).urls("pages", [{ id: "p", slug: "coywolf-pack" }, { id: "d", slug: "docs" }, { id: "x", slug: "about" }, { id: "h", slug: "huzzah" }]);
		assert.equal(urls.get("p"), "/apps/coywolf-pack", "EmDash resolves url_pattern without a trailing slash (policy ignore)");
		assert.equal(urls.get("d"), "/apps/coywolf-pack/docs");
		assert.equal(urls.get("x"), "/about");
		assert.equal(urls.get("h"), "/newsletter/huzzah", "the option fills in a page without a parent page");
		// Posts have no field: EmDash's pattern.
		assert.equal(await entryUrl(db, "posts", { id: "q", slug: "hello" }), "/blog/hello");
		// Off: as before.
		provide(db, false);
		assert.equal(await entryUrl(db, "pages", { id: "p", slug: "coywolf-pack" }), "/coywolf-pack");
		// A configured {pagepath} override keeps its own trailing slash and follows the stored parents.
		configureContentUrls({ urls: { pages: "/{pagepath}/" } });
		provide(db);
		assert.equal(await entryUrl(db, "pages", { id: "d", slug: "docs" }), "/apps/coywolf-pack/docs/");
	} finally {
		configureStoredParents(null);
		configureContentUrls({});
	}
});

test("matchEntryPath: a nested page only at its full path; the flat URL doesn't match", async () => {
	const db = fakeD1(SITE);
	provide(db);
	try {
		assert.deepEqual(await matchEntryPath(db, "/apps/coywolf-pack/docs/"), { collection: "pages", id: "d", path: "/apps/coywolf-pack/docs" });
		assert.equal(await matchEntryPath(db, "/docs/"), null);
		assert.equal(await matchEntryPath(db, "/apps/docs/"), null);
		assert.deepEqual(await matchEntryPath(db, "/about"), { collection: "pages", id: "x", path: "/about" });
	} finally {
		configureStoredParents(null);
	}
});

test("a resolver given a Child Pages state uses it instead of the switch (comparing before and after)", async () => {
	const db = fakeD1(SITE);
	provide(db, false);
	try {
		const state = await read.readChildPagesState(db);
		const on = await createEntryUrlResolver(db, { childPages: state }).url("pages", { id: "d", slug: "docs" });
		const off = await createEntryUrlResolver(db, { childPages: null }).url("pages", { id: "d", slug: "docs" });
		assert.equal(on, "/apps/coywolf-pack/docs");
		assert.equal(off, "/docs");
	} finally {
		configureStoredParents(null);
	}
});

test("the URL fingerprint changes with the stored parents' version", () => {
	configureStoredParents({ collections: async () => new Set(), parents: async () => null, fingerprint: () => "v1" });
	const a = contentUrlFingerprint();
	configureStoredParents({ collections: async () => new Set(), parents: async () => null, fingerprint: () => "v2" });
	assert.notEqual(contentUrlFingerprint(), a);
	configureStoredParents(null);
});

test("reads: one query for the collections and their field, one batch for a collection's rows and links", async () => {
	const db = fakeD1(SITE);
	const meta = await read.readMeta(db);
	const pagesMeta = meta.find((m) => m.collection === "pages");
	assert.deepEqual(pagesMeta.field, { id: "f1", relation: "pages_parent_page", side: "parent" });
	assert.equal(meta.find((m) => m.collection === "posts").field, null);
	let batches = 0;
	const counted = { ...db, batch: async (s) => (batches++, db.batch(s)) };
	const t = await read.readTree(counted, pagesMeta, true);
	assert.equal(batches, 1);
	assert.equal(t.nodes.get("d").effectiveParentId, "p");
	// A field named parent_page that isn't a self-reference: reported, not used.
	const odd = read.metaFromRows([{ collection: "pages", label: "Pages", title_field: null, url_pattern: null, routable: 1, field_id: "f", field_type: "string", validation: null }]);
	assert.equal(odd[0].field, null);
	assert.match(odd[0].conflict, /string/);
	// The child side of a relation: the holder and the target swap.
	const child = read.metaFromRows([{ collection: "pages", label: "Pages", title_field: null, url_pattern: null, routable: 1, field_id: "f", field_type: "reference", validation: '{"targetCollection":"pages","relation":"r","relationSide":"child"}' }]);
	assert.equal(child[0].field.side, "child");
});

// ── Theme helpers ──

async function themeTree(db, on = true) {
	configureContentUrls({ urls: { pages: "/{pagepath}/" }, pageParents: { huzzah: "newsletter" } });
	const ct = await read.collectionTree(db, "pages", { on });
	return theme.pageTreeFrom(ct);
}

test("loadPageTree's tree: paths, trails with titles (and option parents that aren't pages), children, cache tags", async () => {
	const db = fakeD1(SITE);
	try {
		const t = await themeTree(db);
		assert.equal(t.nested, true);
		assert.equal(t.path("docs"), "/apps/coywolf-pack/docs/");
		assert.deepEqual(t.trail("docs").map((i) => [i.title, i.url, i.id]), [["Coywolf apps", "/apps/", "a"], ["Coywolf Pack", "/apps/coywolf-pack/", "p"]]);
		assert.deepEqual(t.trail("huzzah"), [{ slug: "newsletter", url: "/newsletter/", id: null, title: null }]);
		assert.deepEqual(t.children("apps").map((i) => i.slug), ["coywolf-pack"]);
		assert.deepEqual(t.cacheTags("docs"), ["a", "p"]);
		assert.equal(t.get("docs").parentId, "p");
		assert.equal(t.get("nope"), null);
	} finally {
		configureContentUrls({});
	}
});

test("resolvePagePath: the page at its full path, a 301 from the flat path (query kept), null for any other path", async () => {
	const db = fakeD1(SITE);
	try {
		const t = await themeTree(db);
		assert.equal(theme.resolvePagePath(t, ["apps", "coywolf-pack"]).page.id, "p");
		assert.deepEqual(theme.resolvePagePath(t, ["coywolf-pack"], { search: "?_preview=abc" }), { redirect: "/apps/coywolf-pack/?_preview=abc" });
		assert.equal(theme.resolvePagePath(t, ["news", "coywolf-pack"]), null, "a post's category path with the same slug isn't the page's");
		assert.equal(theme.resolvePagePath(t, ["coywolf-pack", "docs"]), null);
		assert.equal(theme.resolvePagePath(t, "/apps/coywolf-pack/docs/").page.id, "d");
		assert.equal(theme.resolvePagePath(t, ["about"]).page.id, "x");
		assert.equal(theme.resolvePagePath(t, []), null);
	} finally {
		configureContentUrls({});
	}
});

test("nestMenuUrls: EmDash's flat page URLs become nested, with query and hash; other URLs are left alone", async () => {
	const db = fakeD1(SITE);
	try {
		const t = await themeTree(db);
		const menu = {
			name: "primary",
			items: [
				{ id: "1", label: "Pack", url: "/coywolf-pack/", children: [{ id: "2", label: "Docs", url: "/docs?x=1#top", children: [] }] },
				{ id: "3", label: "About", url: "/about/", children: [] },
				{ id: "4", label: "Out", url: "https://example.com/docs/", children: [] },
				{ id: "5", label: "Anchor", url: "#docs", children: [] },
			],
		};
		const nested = theme.nestMenuUrls(menu, t);
		assert.deepEqual(nested.items.map((i) => i.url), ["/apps/coywolf-pack/", "/about/", "https://example.com/docs/", "#docs"]);
		assert.equal(nested.items[0].children[0].url, "/apps/coywolf-pack/docs/?x=1#top");
		assert.equal(menu.items[0].url, "/coywolf-pack/", "a copy: the menu itself is unchanged");
		assert.equal(theme.nestMenuUrls(null, t), null);
		assert.equal(theme.nestMenuUrls([{ url: "https://coywolf.com/docs/" }], t, { origin: "https://coywolf.com" })[0].url, "https://coywolf.com/apps/coywolf-pack/docs/");
		assert.equal(t.nest("https://coywolf.com/docs/"), "https://coywolf.com/docs/", "absolute URLs only with the site's origin");
	} finally {
		configureContentUrls({});
	}
});

test("with Child Pages off the tree nests only by the pageParents option", async () => {
	const db = fakeD1(SITE);
	try {
		const t = await themeTree(db, false);
		assert.equal(t.nested, false);
		assert.equal(t.path("docs"), "/docs/");
		assert.equal(t.path("huzzah"), "/newsletter/huzzah/");
		assert.deepEqual(theme.resolvePagePath(t, ["apps", "coywolf-pack"]), null);
	} finally {
		configureContentUrls({});
	}
});

// ── Breadcrumb titles ──

test("breadcrumbs derived from a path name parent pages by their titles", async () => {
	const { resolveTrail } = await import("../src/breadcrumbs/trail.ts");
	const { breadcrumbTrail } = await import("../src/schema/graph.ts");
	const titles = new Map([["/apps", "Coywolf apps"], ["/apps/coywolf-pack", "Coywolf Pack"]]);
	const trail = resolveTrail({ path: "/apps/coywolf-pack/docs/", title: "Docs", homeLabel: "Home", showHome: true, showCurrent: true, titles });
	assert.deepEqual(trail.map((c) => c.name), ["Home", "Coywolf apps", "Coywolf Pack", "Docs"]);
	assert.deepEqual(resolveTrail({ path: "/apps/coywolf-pack/docs/", title: "Docs", homeLabel: "Home", showHome: true, showCurrent: true }).map((c) => c.name), ["Home", "Apps", "Coywolf pack", "Docs"]);
	const schema = breadcrumbTrail({ path: "/apps/coywolf-pack/", url: "https://coywolf.com/apps/coywolf-pack/", pageTitle: "Coywolf Pack" }, "https://coywolf.com", "Home", titles);
	assert.deepEqual(schema.map((c) => c.name), ["Home", "Coywolf apps", "Coywolf Pack"]);
});

test("live search keeps Child Pages' parents with its metadata (no reads per search), and resolves nested page URLs from them", async () => {
	const db = fakeD1(SITE);
	const { entryUrlsFromMeta } = await import("../src/search/engine.ts");
	provide(db);
	try {
		const state = await cu.currentChildPagesState(db);
		assert.deepEqual([...state.collections], ["pages"]);
		const reads = [];
		const counted = { ...db, prepare: (q) => (reads.push(q), db.prepare(q)) };
		const meta = { collections: new Map([["pages", { slug: "pages", label: "Pages", labelSingular: "Page", urlPattern: "/{slug}/", titleField: "title" }]]), termParents: new Map(), childPages: state };
		const urls = await entryUrlsFromMeta(counted, meta, ["pages"], () => [{ id: "d", slug: "docs" }, { id: "x", slug: "about" }]);
		assert.equal(urls.get("pages:d"), "/apps/coywolf-pack/docs");
		assert.equal(urls.get("pages:x"), "/about");
		assert.deepEqual(reads, [], "nothing read: the parents came with the metadata");
		const off = await entryUrlsFromMeta(db, { ...meta, childPages: null }, ["pages"], () => [{ id: "d", slug: "docs" }]);
		assert.equal(off.get("pages:d"), "/docs");
		provide(db, false);
		assert.equal(await cu.currentChildPagesState(db), null, "off: nothing to keep");
	} finally {
		configureStoredParents(null);
	}
});

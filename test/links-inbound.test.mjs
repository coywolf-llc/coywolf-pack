// Run: node --test test/links-inbound.test.mjs
// Link Manager's Entries view: inbound internal link counts and orphans from the
// links it already indexed, read with a few batched statements, and related
// entries (shared categories or tags) to link an orphan from.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const inbound = await import("../src/links/inbound.ts");

const SITE = "https://example.com";
const e = (id, path, over = {}) => ({ collection: "posts", id, title: id.toUpperCase(), path, noIndex: false, publishedAt: null, updatedAt: null, ...over });

test("counts distinct published entries linking to each entry; itself, drafts and other hosts don't count", () => {
	const entries = [e("a", "/a/"), e("b", "/b/"), e("c", "/c/"), e("d", null)];
	const urls = [
		{ id: "u-a", resolved: `${SITE}/a/`, finalUrl: null },
		{ id: "u-a2", resolved: `${SITE}/a?utm=x#top`, finalUrl: null },
		{ id: "u-old", resolved: `${SITE}/old-b/`, finalUrl: `${SITE}/b/` },
		{ id: "u-home", resolved: `${SITE}/`, finalUrl: null },
		{ id: "u-www", resolved: "https://www.example.com/c", finalUrl: null },
	];
	const refs = [
		{ urlId: "u-a", entryKey: "posts/b", entryStatus: "published" },
		{ urlId: "u-a2", entryKey: "posts/b", entryStatus: "published" }, // Same source again: counted once.
		{ urlId: "u-a", entryKey: "posts/a", entryStatus: "published" }, // Itself.
		{ urlId: "u-a", entryKey: "posts/c", entryStatus: "draft" }, // Not live.
		{ urlId: "u-old", entryKey: "posts/a", entryStatus: "published" }, // Through a redirect.
		{ urlId: "u-www", entryKey: "posts/a", entryStatus: "published" },
		{ urlId: "u-home", entryKey: "posts/c", entryStatus: "published" },
		{ urlId: "u-a", entryKey: "posts/gone", entryStatus: null }, // No status, and not a published entry: not counted.
		{ urlId: "u-old", entryKey: "posts/c", entryStatus: "" }, // No status, but published: counted.
	];
	const out = inbound.countInbound(entries, urls, refs, SITE);
	assert.deepEqual(Object.fromEntries(out.entries.map((x) => [x.id, x.inbound])), { a: 1, b: 2, c: 1, d: 0 });
	assert.equal(out.matched, 4);
	assert.equal(out.unmatched, 1, "the home page isn't an entry");
});

test("site paths: the site's host (with or without www), decoded, no trailing slash", () => {
	assert.equal(inbound.sitePath(`${SITE}/caf%C3%A9/`, "example.com"), "/café");
	assert.equal(inbound.sitePath("https://other.test/a/", "example.com"), null);
	assert.equal(inbound.sitePath("not a url", "example.com"), null);
});

// ── Against SQLite, through a D1-shaped wrapper ────────────────

function d1(db) {
	const statement = (sql, params = []) => ({
		bind: (...values) => statement(sql, values),
		all: async () => ({ results: db.prepare(sql).all(...params.map((v) => (typeof v === "boolean" ? Number(v) : v))) }),
	});
	const statements = [];
	return {
		statements,
		prepare: (sql) => {
			statements.push(sql);
			return statement(sql);
		},
		batch: async (list) => Promise.all(list.map((s) => s.all())),
	};
}

/** EmDash's tables, as much of them as these queries use. */
function database() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE _emdash_collections (id TEXT, slug TEXT, label TEXT, label_singular TEXT, url_pattern TEXT, title_field TEXT, routable INTEGER NOT NULL DEFAULT 1, hidden INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE _emdash_fields (collection_id TEXT, slug TEXT);
		CREATE TABLE _emdash_seo (collection TEXT, content_id TEXT, seo_no_index INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE ec_posts (id TEXT, slug TEXT, status TEXT, locale TEXT, published_at TEXT, updated_at TEXT, deleted_at TEXT, translation_group TEXT, title TEXT);
		CREATE TABLE ec_widgets (id TEXT, slug TEXT, status TEXT, locale TEXT, published_at TEXT, updated_at TEXT, deleted_at TEXT, translation_group TEXT, title TEXT);
		CREATE TABLE content_taxonomies (collection TEXT, entry_id TEXT, taxonomy_id TEXT);
		CREATE TABLE _plugin_storage (plugin_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (plugin_id, collection, id));
	`);
	// No title field set on posts (EmDash then uses its `title` field).
	db.prepare("INSERT INTO _emdash_collections VALUES ('c1', 'posts', 'Posts', 'Post', '/{slug}/', NULL, 1, 0), ('c2', 'widgets', 'Widgets', 'Widget', NULL, 'title', 0, 0), ('c3', 'drafts_area', 'Hidden', 'Hidden', '/{slug}/', 'title', 1, 1)").run();
	db.prepare("INSERT INTO _emdash_fields VALUES ('c1', 'title'), ('c1', 'body'), ('c2', 'title')").run();
	const post = db.prepare("INSERT INTO ec_posts VALUES (?, ?, ?, 'en', '2026-01-01', '2026-02-01', ?, ?, ?)");
	post.run("p1", "one", "published", null, "g1", "Post one");
	post.run("p2", "two", "published", null, "g2", "Post two");
	post.run("p3", "three", "published", null, "g3", "Post three");
	post.run("p4", "four", "draft", null, "g4", "Draft four");
	post.run("p5", "five", "published", "2026-03-01", "g5", "Trashed five");
	post.run("p6", "six", "published", null, "g6", "Hidden six");
	db.prepare("INSERT INTO ec_widgets VALUES ('w1', 'w', 'published', 'en', NULL, NULL, NULL, 'gw', 'Widget')").run();
	db.prepare("INSERT INTO _emdash_seo VALUES ('posts', 'p6', 1)").run();
	const tag = db.prepare("INSERT INTO content_taxonomies VALUES ('posts', ?, ?)");
	for (const [entry, term] of [["g1", "t-seo"], ["g2", "t-seo"], ["g2", "t-ai"], ["g3", "t-ai"], ["g3", "t-seo"], ["g4", "t-seo"]]) tag.run(entry, term);
	const row = db.prepare("INSERT INTO _plugin_storage VALUES ('coywolf-pack', ?, ?, ?)");
	row.run("links_urls", "u2", JSON.stringify({ url: "/two/", resolved: `${SITE}/two/`, internal: true, finalUrl: null }));
	row.run("links_urls", "ux", JSON.stringify({ url: "https://x.test/", resolved: "https://x.test/", internal: false }));
	row.run("links_refs", "posts/p1|u2", JSON.stringify({ urlId: "u2", entryKey: "posts/p1", entryStatus: "published" }));
	row.run("links_refs", "posts/p3|u2", JSON.stringify({ urlId: "u2", entryKey: "posts/p3", entryStatus: "published" }));
	row.run("links_refs", "posts/p1|ux", JSON.stringify({ urlId: "ux", entryKey: "posts/p1", entryStatus: "published" }));
	return db;
}

test("the report: published entries of routable collections, with paths, No index and counts", async () => {
	const db = d1(database());
	assert.deepEqual((await inbound.pageCollections(db)).map((c) => [c.slug, c.titleField]), [["posts", "title"]], "not routable or hidden: left out");
	const report = await inbound.inboundReport(db, SITE);
	const byId = Object.fromEntries(report.entries.map((x) => [x.id, x]));
	assert.deepEqual(Object.keys(byId).sort(), ["p1", "p2", "p3", "p6"], "no drafts, trashed entries or unroutable collections");
	assert.equal(byId.p2.inbound, 2);
	assert.equal(byId.p1.inbound, 0);
	assert.equal(byId.p1.path?.replace(/\/$/, ""), "/one", "the path EmDash would give it (trailing slash per the site's policy)");
	assert.equal(byId.p1.title, "Post one");
	assert.equal(byId.p6.noIndex, true);
	assert.equal(report.matched, 1);
});

test("reference rows are read in pages keyed on the primary key", async () => {
	const raw = database();
	const row = raw.prepare("INSERT INTO _plugin_storage VALUES ('coywolf-pack', 'links_refs', ?, ?)");
	for (let i = 0; i < 12_000; i++) row.run(`posts/p${i % 3 === 0 ? 1 : 3}|u2|${String(i).padStart(5, "0")}`, JSON.stringify({ urlId: "u2", entryKey: `posts/p${i % 2 ? 1 : 3}`, entryStatus: "published" }));
	const db = d1(raw);
	const { refs } = await inbound.internalLinks(db);
	assert.equal(refs.length, 12_002);
	assert.equal(db.statements.filter((s) => s === inbound.refPairsSql).length, 3, "5,000 rows a statement");
	assert.doesNotMatch(inbound.refPairsSql, /OFFSET/i);
});

test("related entries share the most categories or tags, published ones only, one statement each in a batch", async () => {
	const db = d1(database());
	const related = await inbound.relatedEntries(db, [
		{ collection: "posts", id: "p1" },
		{ collection: "posts", id: "p3" },
		{ collection: "bad slug", id: "x" },
	]);
	assert.deepEqual(related.get("posts/p1"), [
		{ id: "p2", shared: 1 },
		{ id: "p3", shared: 1 },
	]);
	assert.deepEqual(related.get("posts/p3")?.[0], { id: "p2", shared: 2 });
	assert.ok(!related.has("bad slug/x"));
});

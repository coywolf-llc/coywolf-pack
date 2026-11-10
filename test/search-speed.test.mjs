// Live results speed-ups: the batched D1 engine (query counts), the title index, the content
// version and cache keys, the browser's title matcher, and the middleware's edge caching.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// The middleware and the settings cache read bindings from cloudflare:workers; point it at a test env.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => p;`, shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const engine = await import("../src/search/engine.ts");
const { packTitleIndex, buildTitleIndex } = await import("../src/search/title-index.ts");
const cacheLib = await import("../src/search/live-cache.ts");
const { MATCH_SOURCE } = await import("../src/search/title-match.ts");
const { configureContentUrls } = await import("../src/core/content-url.ts");
const { invalidateFeatures } = await import("../src/core/features.ts");

configureContentUrls({ urls: { posts: "/{term:category|uncategorized}/{slug}/" } });

// ── A D1 stand-in over node:sqlite (FTS5 included) that counts statements and round trips ──

const pt = (text) => JSON.stringify([{ _type: "block", children: [{ _type: "span", text }] }, { _type: "image", alt: "ignored alt text" }]);

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE _emdash_collections (id TEXT, slug TEXT, label TEXT, label_singular TEXT, url_pattern TEXT, title_field TEXT, search_config TEXT);
		CREATE TABLE _emdash_fields (id TEXT, collection_id TEXT, slug TEXT, label TEXT, type TEXT, searchable INTEGER, sort_order INTEGER);
		CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT, content TEXT, excerpt TEXT);
		CREATE TABLE ec_pages (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT, body TEXT);
		CREATE TABLE ec_authors (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, name TEXT);
		CREATE TABLE content_taxonomies (collection TEXT, entry_id TEXT, taxonomy_id TEXT);
		CREATE TABLE taxonomies (id TEXT, name TEXT, slug TEXT, label TEXT, parent_id TEXT, locale TEXT, translation_group TEXT);
		CREATE VIRTUAL TABLE "_emdash_fts_posts" USING fts5(id UNINDEXED, locale UNINDEXED, title, content, excerpt, tokenize='porter unicode61');
		CREATE VIRTUAL TABLE "_emdash_fts_pages" USING fts5(id UNINDEXED, locale UNINDEXED, title, body, tokenize='porter unicode61');

		INSERT INTO options VALUES ('plugin:coywolf-pack:settings:features', '{"search":true,"search.rateLimit":true}'), ('plugin:coywolf-pack:settings:searchVersion', '"abc123"');
		INSERT INTO _emdash_collections VALUES
			('c1','posts','Posts','Post',NULL,NULL,'{"enabled":true,"weights":{"title":5}}'),
			('c2','pages','Pages','Page','/{slug}',NULL,'{"enabled":true}'),
			('c3','authors','Authors','Author',NULL,'name',NULL);
		-- rowid order (title, content, excerpt) is the FTS column order; sort_order puts the excerpt first.
		INSERT INTO _emdash_fields VALUES
			('f1','c1','title','Title','string',1,1),
			('f2','c1','content','Content','portableText',1,2),
			('f3','c1','excerpt','Excerpt','text',1,0),
			('f4','c2','title','Title','string',1,0),
			('f5','c2','body','Body','text',1,1),
			('f6','c3','name','Name','string',0,0);
		INSERT INTO taxonomies VALUES ('t1','category','nature','Nature',NULL,'en','g1'), ('t2','category','food','Food',NULL,'en','g2');
	`);
	const posts = [
		["p1", "grey-wolves", "published", "2024-03-05 10:00:00", "en", "Grey wolves of Yellowstone", "The pack hunts elk across the valley.", "Wolves at home"],
		["p2", "ecole", "published", "2024-04-01 10:00:00", "en", "École de cuisine", "A French cooking school.", ""],
		["p3", "wolf-draft", "draft", null, "en", "Wolf pack dynamics", "Unpublished.", ""],
		["p4", "herbs", "published", "2024-05-01 10:00:00", "en", "Cooking with herbs", "Wild garlic grows where wolves roam.", ""],
		["p5", "gone", "published", "2024-01-01 10:00:00", "en", "Wolf gone", "Deleted.", ""],
		["p6", "loup", "published", "2024-02-01 10:00:00", "fr", "Le loup gris", "Le loup.", ""],
	];
	for (const [id, slug, status, date, locale, title, content, excerpt] of posts) {
		db.prepare("INSERT INTO ec_posts VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, slug, status, date, locale, id, id === "p5" ? "2024-02-01" : null, title, pt(content), excerpt);
		db.prepare("INSERT INTO _emdash_fts_posts VALUES (?,?,?,?,?)").run(id, locale, title, `${content} ignored alt text`, excerpt);
	}
	db.prepare("INSERT INTO ec_pages VALUES (?,?,?,?,?,?,?,?,?)").run("a1", "about", "published", "2023-01-01 00:00:00", "en", "a1", null, "About the Wolf Project", "We study wolves and elk.");
	db.prepare("INSERT INTO _emdash_fts_pages VALUES (?,?,?,?)").run("a1", "en", "About the Wolf Project", "We study wolves and elk.");
	db.exec("INSERT INTO content_taxonomies VALUES ('posts','p1','g1'), ('posts','p4','g2')");

	const stats = { statements: 0, roundTrips: 0 };
	const run = (sql, params) => db.prepare(sql).all(...params.map((p) => (typeof p === "boolean" ? Number(p) : p)));
	const statement = (sql, params = []) => ({
		sql,
		params,
		bind: (...p) => statement(sql, p),
		async all() {
			stats.statements++;
			stats.roundTrips++;
			return { results: run(sql, params) };
		},
		async first() {
			stats.statements++;
			stats.roundTrips++;
			return run(sql, params)[0] ?? null;
		},
	});
	const d1 = {
		stats,
		sqlite: db,
		reset() {
			stats.statements = 0;
			stats.roundTrips = 0;
		},
		prepare: (sql) => statement(sql),
		async batch(statements) {
			stats.roundTrips++;
			stats.statements += statements.length;
			// Like D1: one failure fails the batch.
			return statements.map((s) => ({ results: run(s.sql, s.params) }));
		},
	};
	return d1;
}

// ── Engine: results and query counts ──

test("live search: titles first, then full text; drafts, deleted and other locales left out", async () => {
	engine.invalidateSearchMeta();
	const d1 = fixture();
	const out = await engine.liveSearchD1(d1, "wol", { version: "v1", locale: "en" });
	const ids = out.items.map((i) => i.id);
	assert.deepEqual(new Set(ids), new Set(["p1", "a1", "p4"]));
	// Title matches (p1, a1) before the content-only match (p4).
	assert.equal(ids[2], "p4");
	assert.equal(out.fallback, false);
	assert.ok(!ids.includes("p3") && !ids.includes("p5") && !ids.includes("p6"));
});

test("live search: URLs (with terms), type labels, highlighted titles and excerpts from prose", async () => {
	engine.invalidateSearchMeta();
	const d1 = fixture();
	const out = await engine.liveSearchD1(d1, "elk", { version: "v1" });
	const p1 = out.items.find((i) => i.id === "p1");
	assert.equal(p1.url, "/nature/grey-wolves/");
	assert.equal(p1.type, "Post");
	// Excerpt fields in schema order (excerpt, then content), Portable Text prose only.
	assert.ok(p1.snippet.includes("<mark>elk</mark>"), p1.snippet);
	assert.ok(!p1.snippet.includes("alt text"), p1.snippet);
	const a1 = out.items.find((i) => i.id === "a1");
	assert.equal(a1.url, "/about");
	assert.equal(a1.type, "Page");
	const herbs = (await engine.liveSearchD1(d1, "herb", { version: "v1" })).items[0];
	assert.equal(herbs.url, "/food/herbs/");
	assert.equal(herbs.titleHtml, "Cooking with <mark>herb</mark>s");
});

test("query count: cold isolate 3 round trips, warm 2 (EmDash's search path took 25–31 queries)", async () => {
	engine.invalidateSearchMeta();
	const d1 = fixture();
	await engine.liveSearchD1(d1, "wol", { version: "v1" });
	// Metadata (collections, fields, FTS tables) + titles/full text (2 collections × 2) + excerpts/terms.
	assert.equal(d1.stats.roundTrips, 3, JSON.stringify(d1.stats));
	assert.ok(d1.stats.statements <= 10, JSON.stringify(d1.stats));

	d1.reset();
	await engine.liveSearchD1(d1, "elk", { version: "v1" });
	assert.equal(d1.stats.roundTrips, 2, JSON.stringify(d1.stats));
	assert.ok(d1.stats.statements <= 7, JSON.stringify(d1.stats));

	// A new content version reloads the metadata (one more batch).
	d1.reset();
	await engine.liveSearchD1(d1, "elk", { version: "v2" });
	assert.equal(d1.stats.roundTrips, 3);

	// Nothing found: no excerpt round.
	d1.reset();
	await engine.liveSearchD1(d1, "zzzz", { version: "v2" });
	assert.equal(d1.stats.roundTrips, 1);
});

test("any-word fallback: one more batch, ranked by coverage, flagged", async () => {
	engine.invalidateSearchMeta();
	const d1 = fixture();
	await engine.liveSearchD1(d1, "x", { version: "v1" });
	d1.reset();
	const out = await engine.liveSearchD1(d1, "garlic yellowstone", { version: "v1" });
	assert.equal(out.fallback, true);
	assert.deepEqual(new Set(out.items.map((i) => i.id)), new Set(["p1", "p4"]));
	assert.equal(d1.stats.roundTrips, 3, JSON.stringify(d1.stats));
});

test("collections filter: only search-enabled collections that exist", async () => {
	engine.invalidateSearchMeta();
	const d1 = fixture();
	assert.deepEqual((await engine.liveSearchD1(d1, "wol", { version: "v1", collections: ["pages"] })).items.map((i) => i.id), ["a1"]);
	assert.deepEqual((await engine.liveSearchD1(d1, "wol", { version: "v1", collections: ["authors", "nope"] })).items, []);
	assert.deepEqual((await engine.liveSearchD1(d1, "wol", { version: "v1", collections: [] })).items, []);
});

test("a failing statement (the visitor's own broken FTS operators) reads as no rows, not an error", async () => {
	engine.invalidateSearchMeta();
	const d1 = fixture();
	const out = await engine.liveSearchD1(d1, "wolf AND", { version: "v1" });
	assert.deepEqual(out.items, []);
});

test("matchQuery: EmDash's SQL — BM25 weights in FTS column order, title scope, filters", () => {
	const meta = engine.buildMeta(
		[{ slug: "posts", label: "Posts", label_singular: "Post", url_pattern: null, title_field: null, search_config: '{"enabled":true,"weights":{"title":5}}' }],
		[
			{ collection: "posts", field: "title", type: "string", searchable: 1, sort_order: 1 },
			{ collection: "posts", field: "content", type: "portableText", searchable: 1, sort_order: 0 },
		],
		["_emdash_fts_posts"],
		new Map(),
	).collections.get("posts");
	const title = engine.matchQuery(meta, "wolf pa", "title", { locale: "en", limit: 8 });
	assert.match(title.sql, /bm25\("_emdash_fts_posts", 0, 0, 5, 1\)/);
	assert.match(title.sql, /c\.status = 'published' AND c\.deleted_at IS NULL AND c\.locale = \? COLLATE NOCASE/);
	assert.deepEqual(title.binds, ['title : ("wolf"* "pa"*)', "en", 8]);
	assert.ok(!title.sql.includes("snippet("));
	assert.ok(engine.matchQuery(meta, "a OR b", "any", { limit: 50 }).sql.includes("snippet("));
	assert.deepEqual(meta.excerptFields.map((f) => f.field), ["content", "title"]);
	assert.equal(engine.matchQuery({ ...meta, searchEnabled: false }, "x", "all", { limit: 1 }), null);
	assert.equal(engine.matchQuery({ ...meta, ftsExists: false }, "x", "all", { limit: 1 }), null);
});

test("escapeFtsQuery matches EmDash's escapeQuery", () => {
	assert.equal(engine.escapeFtsQuery("hel wor"), '"hel"* "wor"*');
	assert.equal(engine.escapeFtsQuery('say "hi'), '"say"* """hi"*');
	assert.equal(engine.escapeFtsQuery('"exact phrase"'), '"exact phrase"');
	assert.equal(engine.escapeFtsQuery("cats OR dogs"), "cats OR dogs");
	assert.equal(engine.escapeFtsQuery("cats OR dogs", false), '"cats"* "OR"* "dogs"*');
	assert.equal(engine.escapeFtsQuery("   "), "");
});

test("countingD1 counts statements and round trips", async () => {
	const d1 = fixture();
	const stats = { statements: 0, roundTrips: 0 };
	const counted = engine.countingD1(d1, stats);
	await counted.prepare("SELECT 1").all();
	await counted.batch([counted.prepare("SELECT 1"), counted.prepare("SELECT ?").bind(2)]);
	assert.deepEqual(stats, { statements: 3, roundTrips: 2 });
});

// ── Title index ──

test("packTitleIndex: newest first, one row per URL, types listed once, capped", () => {
	const index = packTitleIndex(
		[
			{ title: "Old", url: "/old", type: "Post", date: "2020-01-01" },
			{ title: "  New   one ", url: "/new", type: "Post", date: "2024-01-01" },
			{ title: "Dup", url: "/new", type: "Post", date: "2023-01-01" },
			{ title: "About", url: "/about", type: "Page", date: null },
			{ title: "", url: "/empty", type: "Post", date: "2025-01-01" },
		],
		"v9",
		3,
	);
	assert.equal(index.v, "v9");
	assert.deepEqual(index.types, ["Post", "Page"]);
	assert.deepEqual(index.entries, [
		["New one", "/new", 0],
		["Old", "/old", 0],
		["About", "/about", 1],
	]);
	assert.equal(packTitleIndex([{ title: "x", url: "/x", type: "Post", date: null }], "v", 0).entries.length, 0);
});

test("buildTitleIndex: published entries with resolved URLs in one batch (metadata cached)", async () => {
	engine.invalidateSearchMeta();
	const d1 = fixture();
	const meta = await engine.loadSearchMeta(d1, "DB", "v1");
	d1.reset();
	const index = await buildTitleIndex(d1, meta, { version: "v1", locale: "en" });
	assert.equal(d1.stats.roundTrips, 1, JSON.stringify(d1.stats));
	assert.deepEqual(index.types, ["Post", "Page"]);
	assert.deepEqual(
		index.entries.map((e) => [e[0], e[1]]),
		[
			["Cooking with herbs", "/food/herbs/"],
			["École de cuisine", "/uncategorized/ecole/"],
			["Grey wolves of Yellowstone", "/nature/grey-wolves/"],
			["About the Wolf Project", "/about"],
		],
	);
	const fr = await buildTitleIndex(d1, meta, { version: "v1", locale: "FR" });
	assert.deepEqual(fr.entries.map((e) => e[0]), ["Le loup gris"]);
	assert.equal((await buildTitleIndex(d1, meta, { version: "v1", max: 1 })).entries.length, 1);
});

// ── Version and cache keys ──

test("content version: stored value plus a config fingerprint; malformed values fall back", () => {
	const a = cacheLib.effectiveVersion("abc", "cfg");
	assert.match(a, /^abc\.[a-z0-9]+$/);
	assert.notEqual(a, cacheLib.effectiveVersion("abd", "cfg"));
	assert.notEqual(a, cacheLib.effectiveVersion("abc", "cfg2"));
	assert.match(cacheLib.effectiveVersion(null, "cfg"), /^0\./);
	assert.match(cacheLib.effectiveVersion("<script>", "cfg"), /^0\./);
	const v = cacheLib.newContentVersion(1_700_000_000_000, 0.5);
	assert.match(v, /^[a-z0-9]+$/);
	assert.ok(cacheLib.newContentVersion(1_700_000_000_001, 0.5) > v, "time-ordered");
});

test("cache keys: equivalent requests share a key", () => {
	const { normalizeLiveQuery, normalizeCollections, normalizeLocale, liveCacheKey } = cacheLib;
	assert.equal(normalizeLiveQuery("  Grey   Wolves "), "grey wolves");
	assert.equal(normalizeLiveQuery("cats OR Dogs"), "cats OR Dogs", "upper-case operators keep their case");
	assert.deepEqual(normalizeCollections("pages, posts,posts,Bad!"), ["pages", "posts"]);
	assert.equal(normalizeCollections(""), undefined);
	assert.equal(normalizeLocale("en-US"), "en-us");
	assert.equal(normalizeLocale("x</script>"), undefined);
	const key = (q, c) => liveCacheKey("https://a.test", { version: "v1", query: normalizeLiveQuery(q), limit: 8, collections: normalizeCollections(c), locale: normalizeLocale("EN") });
	assert.equal(key("Wolf  Pack", "posts,pages"), key("wolf pack", "pages,posts"));
	assert.notEqual(key("wolf", "posts"), key("wolf", "pages"));
	assert.notEqual(
		liveCacheKey("https://a.test", { version: "v1", query: "wolf", limit: 8 }),
		liveCacheKey("https://a.test", { version: "v2", query: "wolf", limit: 8 }),
		"publishing (a new version) changes every key",
	);
	assert.ok(key("x", null).startsWith("https://a.test/_coywolf-cache/search/live?"));
});

test("Lru keeps the most recently used", () => {
	const lru = new cacheLib.Lru(2);
	lru.set("a", 1);
	lru.set("b", 2);
	lru.get("a");
	lru.set("c", 3);
	assert.equal(lru.get("b"), undefined);
	assert.equal(lru.get("a"), 1);
	assert.equal(lru.size, 2);
});

// ── Browser title matcher (the same source the page runs) ──

const tools = new Function(`return (${MATCH_SOURCE})();`)();
const sample = tools.prepare({
	types: ["Post", "Page"],
	entries: [
		["Wolf pack dynamics", "/wolf-pack/", 0],
		["Grey wolves of Yellowstone", "/grey-wolves/", 0],
		["École de cuisine", "/ecole/", 0],
		["The werewolf myth", "/werewolf/", 0],
		["About the Wolf Project", "/about", 1],
		["Packing for a trip", "/packing/", 0],
	],
});

test("matcher: starts-with, then word prefix, then contains; every word must match", () => {
	const titles = (q) => tools.match(sample, q, 10).map((h) => h.entry.title);
	assert.deepEqual(titles("wol"), ["Wolf pack dynamics", "Grey wolves of Yellowstone", "About the Wolf Project", "The werewolf myth"]);
	assert.deepEqual(titles("wolf"), ["Wolf pack dynamics", "About the Wolf Project", "The werewolf myth"]);
	assert.deepEqual(titles("wolf pa"), ["Wolf pack dynamics"]);
	assert.deepEqual(titles("pack"), ["Packing for a trip", "Wolf pack dynamics"]);
	assert.deepEqual(titles("zzz"), []);
	// Short words only match at word starts (no "contains" for "ol").
	assert.deepEqual(titles("ol"), []);
	assert.equal(tools.match(sample, "wolf", 2).length, 2);
});

test("matcher: case- and diacritics-insensitive, both ways", () => {
	assert.deepEqual(tools.match(sample, "ecole", 5).map((h) => h.entry.url), ["/ecole/"]);
	assert.deepEqual(tools.match(sample, "ÉCOLE", 5).map((h) => h.entry.url), ["/ecole/"]);
	assert.equal(tools.fold("Ünïcödé"), "unicode");
});

test("matcher: highlights like the server (word starts), escaped, and maps folded matches back", () => {
	const items = tools.localItems(sample, "ecole", 5);
	assert.equal(items[0].titleHtml, "<mark>École</mark> de cuisine");
	assert.equal(items[0].type, "Post");
	assert.equal(items[0].snippet, "");
	assert.equal(tools.highlight("Wolf <b> wolves", "wol", false), "<mark>Wol</mark>f &lt;b&gt; <mark>wol</mark>ves");
	assert.equal(tools.highlight("The werewolf myth", "wolf", false), "The werewolf myth");
	assert.equal(tools.highlight("The werewolf myth", "wolf", true), "The were<mark>wolf</mark> myth");
	assert.equal(tools.localItems(sample, "wolf", 10).find((i) => i.url === "/werewolf/").titleHtml, "The were<mark>wolf</mark> myth");
});

test("merge: server results enrich local rows in place, then append; unconfirmed local rows give way", () => {
	const local = [
		{ url: "/a/", title: "A", local: true },
		{ url: "/b/", title: "B", local: true },
	];
	const server = [
		{ url: "/b", title: "B", snippet: "b text" },
		{ url: "/c", title: "C", snippet: "c text" },
	];
	assert.deepEqual(tools.merge(local, server, 8).map((i) => [i.title, !!i.local, i.snippet ?? ""]), [
		["A", true, ""],
		["B", false, "b text"],
		["C", false, "c text"],
	]);
	// Full list: the unconfirmed local row makes room for the server's.
	assert.deepEqual(tools.merge(local, server, 2).map((i) => i.title), ["B", "C"]);
	assert.deepEqual(tools.merge([], server, 1).map((i) => i.title), ["B"]);
	assert.deepEqual(tools.merge(local, [], 8).map((i) => i.title), ["A", "B"]);
});

// ── Middleware: edge cache, rate limit on misses only, the index endpoint ──

await import("../src/search/pack.ts"); // registers the search feature switches
const serve = await import("../src/search/live-serve.ts");
const { configureSearchRateLimit } = await import("../src/search/ratelimit.ts");

function fakeEdgeCache() {
	const store = new Map();
	return {
		store,
		async match(key) {
			const hit = store.get(String(key));
			if (!hit) return undefined;
			// Like the Cache API: headers on a cached response are immutable.
			const response = new Response(hit.body, { headers: hit.headers });
			const frozen = response.headers;
			Object.defineProperty(response, "headers", { value: new Proxy(frozen, { get: (t, p) => (p === "set" || p === "append" || p === "delete" ? () => { throw new TypeError("immutable"); } : typeof t[p] === "function" ? t[p].bind(t) : t[p]) }) });
			return response;
		},
		async put(key, response) {
			store.set(String(key), { body: await response.text(), headers: Object.fromEntries(response.headers) });
		},
	};
}

function request(path, headers = {}) {
	const url = new URL(path, "https://site.test");
	return { url, request: new Request(url, { headers: { "cf-connecting-ip": "203.0.113.9", ...headers } }), clientAddress: "203.0.113.9" };
}

test("middleware: miss, then hit (memory and edge); hits are mutable copies and skip the rate limit", async () => {
	engine.invalidateSearchMeta();
	invalidateFeatures();
	const d1 = fixture();
	const edge = fakeEdgeCache();
	globalThis.caches = { default: edge };
	globalThis.__testEnv = { DB: d1 };
	configureSearchRateLimit({ requestsPerMinute: 2 });
	const pending = [];
	const waitUntil = (p) => pending.push(p);
	const handle = (path, headers) => serve.searchLiveMiddleware.handle(request(path, headers), globalThis.__testEnv, waitUntil);

	const first = await handle(`${serve.LIVE_ENDPOINT}?q=Wol&limit=5`);
	assert.equal(first.status, 200);
	assert.equal(first.headers.get("X-Coywolf-Cache"), "MISS");
	assert.equal(first.headers.get("Cache-Control"), "public, max-age=60");
	assert.match(first.headers.get("Server-Timing"), /cw-search;desc="miss".*cw-d1;desc="\d+ statements, \d+ round trips"/);
	const body = await first.json();
	assert.equal(body.success, true);
	assert.ok(body.data.items.length > 0);
	await Promise.all(pending);
	assert.equal(edge.store.size, 1);
	assert.match([...edge.store.values()][0].headers["cache-control"], /max-age=300/);

	// Same query, different case and spacing: a memory hit, no database work.
	d1.reset();
	const again = await handle(`${serve.LIVE_ENDPOINT}?q=%20wol%20&limit=5`);
	assert.equal(again.headers.get("X-Coywolf-Cache"), "HIT");
	assert.equal(d1.stats.roundTrips, 0);
	again.headers.set("X-Later-Middleware", "ok"); // mutable

	// Another isolate (empty memory): the edge copy, returned with mutable headers.
	serve.resetLiveMemory();
	const edgeHit = await handle(`${serve.LIVE_ENDPOINT}?q=wol&limit=5`);
	assert.match(edgeHit.headers.get("Server-Timing"), /hit-edge/);
	edgeHit.headers.set("X-Later-Middleware", "ok");
	assert.deepEqual(await edgeHit.json(), body);

	// The rate limit (2 a minute here) counts misses only: the first miss above was one.
	for (let i = 0; i < 5; i++) assert.equal((await handle(`${serve.LIVE_ENDPOINT}?q=wol&limit=5`)).status, 200);
	assert.equal((await handle(`${serve.LIVE_ENDPOINT}?q=elk`)).status, 200);
	assert.equal((await handle(`${serve.LIVE_ENDPOINT}?q=herbs`)).status, 429);

	// Bad input is a 400, not a search.
	assert.equal((await handle(`${serve.LIVE_ENDPOINT}?q=%20`)).status, 400);
	assert.equal((await handle(`${serve.LIVE_ENDPOINT}?q=x&limit=99`)).status, 400);
	configureSearchRateLimit({});
});

test("middleware: warm-up answers 204 without searching; other paths pass through", async () => {
	globalThis.__testEnv = { DB: fixture() };
	const warm = await serve.searchLiveMiddleware.handle(request(`${serve.LIVE_ENDPOINT}?warm=1`), globalThis.__testEnv, () => {});
	assert.equal(warm.status, 204);
	assert.equal(warm.headers.get("Cache-Control"), "no-store");
	assert.equal(await serve.searchLiveMiddleware.handle(request("/blog/"), globalThis.__testEnv, () => {}), undefined);
});

test("middleware: the title index is immutable for its version, short-lived for an old one, and answers 304", async () => {
	engine.invalidateSearchMeta();
	invalidateFeatures();
	globalThis.__testEnv = { DB: fixture() };
	globalThis.caches = { default: fakeEdgeCache() };
	const version = await serve.searchVersion();
	assert.match(version, /^abc123\./);
	const handle = (path, headers) => serve.searchLiveMiddleware.handle(request(path, headers), globalThis.__testEnv, () => {});

	const current = await handle(`${serve.INDEX_ENDPOINT}?v=${version}&locale=en`);
	assert.equal(current.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
	const index = await current.json();
	assert.equal(index.v, version);
	assert.ok(index.entries.length >= 4);
	const stale = await handle(`${serve.INDEX_ENDPOINT}?v=old&locale=en`);
	assert.equal(stale.headers.get("Cache-Control"), "public, max-age=300");
	assert.deepEqual(await stale.json(), index);
	const etag = current.headers.get("ETag");
	assert.equal((await handle(`${serve.INDEX_ENDPOINT}?v=${version}&locale=en`, { "If-None-Match": etag })).status, 304);
});

test("middleware with Workers Cache: successful answers go to the edge cache, tagged; errors and 429s never do", async () => {
	engine.invalidateSearchMeta();
	invalidateFeatures();
	serve.resetLiveMemory();
	const d1 = fixture();
	const edge = fakeEdgeCache();
	globalThis.caches = { default: edge };
	globalThis.__testEnv = { DB: d1 };
	configureSearchRateLimit({ requestsPerMinute: 1 });
	const handle = (path) => {
		const sets = [];
		const ctx = { ...request(path, { "cf-connecting-ip": "198.51.100.77" }), cache: { enabled: true, set: (o) => sets.push(o) } };
		return serve.searchLiveMiddleware.handle(ctx, globalThis.__testEnv, () => {}).then((response) => ({ response, sets }));
	};
	const { response, sets } = await handle(`${serve.LIVE_ENDPOINT}?q=Wol&limit=5`);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Server-Timing"), null, "no render timings stored at the edge");
	assert.equal(response.headers.get("X-Coywolf-Cache"), null);
	const last = sets.at(-1);
	assert.equal(last.maxAge, serve.LIVE_EDGE_TTL);
	assert.equal(last.swr, 0);
	assert.equal(last.tags[0], serve.SEARCH_TAG);
	assert.ok(last.tags.length > 1, "and the searchable collections, which EmDash clears on publish");
	assert.equal(edge.store.size, 0, "the Cache API layer is skipped: the edge cache is the copy");
	// Over the limit: a 429, kept out of the edge cache (only the handler's own set(false)).
	const limited = await handle(`${serve.LIVE_ENDPOINT}?q=elk`);
	assert.equal(limited.response.status, 429);
	assert.deepEqual(limited.sets, [false]);
	configureSearchRateLimit({});
	const bad = await handle(`${serve.LIVE_ENDPOINT}?q=%20`);
	assert.equal(bad.response.status, 400);
	assert.deepEqual(bad.sets, [false]);
	const warm = await handle(`${serve.LIVE_ENDPOINT}?warm=1`);
	assert.equal(warm.response.status, 204);
	assert.deepEqual(warm.sets, [false]);
	// The title index: a day for the current version, five minutes for an old page's.
	const version = await serve.searchVersion();
	const index = await handle(`${serve.INDEX_ENDPOINT}?v=${version}`);
	assert.equal(index.sets.at(-1).maxAge, 86_400);
	assert.equal(index.response.headers.get("Server-Timing"), null);
	const stale = await handle(`${serve.INDEX_ENDPOINT}?v=old`);
	assert.equal(stale.sets.at(-1).maxAge, 300);
});

test("publishing changes the version pages and cache keys use", async () => {
	invalidateFeatures();
	globalThis.__testEnv = { DB: fixture() };
	const before = await serve.searchVersion();
	const saved = new Map();
	await serve.bumpSearchVersion({ settings: { set: async (k, v) => saved.set(k, v) } });
	assert.ok(saved.get("searchVersion"));
	assert.notEqual(await serve.searchVersion(), before);
});

test("content hooks: publishing, unpublishing, deleting and saving published entries bump the version; drafts don't", async () => {
	const { composeHooks } = await import("../src/core/compose.ts");
	const { searchPack } = await import("../src/search/pack.ts");
	const { hooks } = composeHooks([searchPack({})], { tasks: [] });
	const writes = [];
	const ctx = {
		settings: { get: async (k) => (k === "features" ? { search: true } : null), set: async (k, v) => writes.push([k, v]) },
		log: { info() {}, warn() {}, error() {} },
	};
	invalidateFeatures();
	await hooks["content:afterPublish"]({ content: { id: "1" }, collection: "posts" }, ctx);
	await hooks["content:afterUnpublish"]({ content: { id: "1" }, collection: "posts" }, ctx);
	await hooks["content:afterDelete"]({ id: "1", collection: "posts", permanent: false }, ctx);
	await hooks["content:afterSave"]({ content: { id: "1", status: "published" }, collection: "posts" }, ctx);
	await hooks["content:afterSave"]({ content: { id: "2", status: "draft" }, collection: "posts" }, ctx);
	assert.equal(writes.length, 4);
	assert.ok(writes.every(([k, v]) => k === "searchVersion" && /^[a-z0-9]+$/.test(v)));
	invalidateFeatures();
});

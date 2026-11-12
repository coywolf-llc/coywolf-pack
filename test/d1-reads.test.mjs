// Run: node --test test/d1-reads.test.mjs
// Fewer D1 round trips per page render: the entry's docs in one batch, video facts
// shared within a request, settings read with the feature switches, the settings
// generation (cross-isolate cache drop + settling purge), and redirects that never
// write on the read path.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => p;`, shortCircuit: true };
		}
		return next(specifier, context);
	},
});

// EmDash's request context (an AsyncLocalStorage on a global symbol); pages render inside als.run().
const als = new AsyncLocalStorage();
globalThis[Symbol.for("emdash:request-context")] = als;
const inRequest = (fn) => als.run({}, fn);

const { readEntryDocs, rowData } = await import("../src/core/entry-docs.ts");
const { videoFacts, publicConfig, invalidatePublicConfig } = await import("../src/videos/store.ts");
const features = await import("../src/core/features.ts");
const { claimSettle, recordSettingsChange, mergeScopes, parseGeneration } = await import("../src/core/generation.ts");
const { serveRedirect, invalidateRedirectCache, setRedirectHitDelay } = await import("../src/redirects/middleware.ts");
setRedirectHitDelay(0); // Hits are batched per isolate (a second's wait in production).
const { saveRule } = await import("../src/redirects/rules.ts");

/** A D1 stand-in over node:sqlite that counts round trips (a batch is one). */
function d1(setup = "") {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT DEFAULT '0' NOT NULL);
		CREATE TABLE _plugin_storage (plugin_id TEXT, collection TEXT, id TEXT, data TEXT, created_at TEXT, PRIMARY KEY (plugin_id, collection, id));
		CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, status TEXT, deleted_at TEXT, title TEXT, content TEXT, sidebar TEXT);
		${setup}
	`);
	const stats = { roundTrips: 0, sql: [] };
	const exec = (sql, params) => {
		const st = db.prepare(sql);
		return /^\s*(select|with)/i.test(sql) ? { results: st.all(...params) } : { results: [], meta: { changes: Number(st.run(...params).changes) } };
	};
	const statement = (sql, params = []) => ({
		sql,
		params,
		bind: (...p) => statement(sql, p),
		async all() {
			stats.roundTrips++;
			stats.sql.push(sql);
			return exec(sql, params);
		},
		async first() {
			stats.roundTrips++;
			stats.sql.push(sql);
			return exec(sql, params).results[0] ?? null;
		},
		async run() {
			stats.roundTrips++;
			stats.sql.push(sql);
			return exec(sql, params);
		},
	});
	return {
		stats,
		sqlite: db,
		prepare: (sql) => statement(sql),
		async batch(statements) {
			stats.roundTrips++;
			for (const s of statements) stats.sql.push(s.sql);
			return statements.map((s) => exec(s.sql, s.params));
		},
	};
}

const put = (db, collection, id, data) =>
	db.sqlite.prepare("INSERT INTO _plugin_storage VALUES ('coywolf-pack', ?, ?, ?, '2026-01-01')").run(collection, id, JSON.stringify(data));

/** A plugin context whose storage and content reads fail the test (the D1 path must not use them). */
function strictCtx() {
	const fail = (what) => () => assert.fail(`${what} read through the plugin context`);
	return {
		log: { warn: (msg, data) => assert.fail(`${msg} ${JSON.stringify(data)}`), info() {}, error() {} },
		storage: new Proxy({}, { get: (_, name) => ({ get: fail(`${String(name)}.get`), getMany: fail(`${String(name)}.getMany`), query: fail(`${String(name)}.query`) }) }),
		content: { get: fail("content.get") },
		settings: { get: fail("settings.get") },
		kv: { get: async () => null },
	};
}

// ── Entry docs ───────────────────────────────────────────────────

test("an entry's docs in several collections, and its data, are one round trip", async () => {
	const db = d1();
	put(db, "schemaEntries", "posts:e1", { mainSubject: "publisher" });
	put(db, "aiEntries", "posts:e1", { entities: [{ name: "Wolf" }] });
	put(db, "schemaEntries", "posts:e2", { mainSubject: "byline:x" });
	const review = JSON.stringify([{ _type: "coywolf-review", itemName: "Trail camera" }]);
	db.sqlite.prepare("INSERT INTO ec_posts VALUES ('e1','my-post','published',NULL,'Title',?,?)").run(review, JSON.stringify([{ _type: "block" }]));
	globalThis.__testEnv = { DB: db };
	const docs = await readEntryDocs(strictCtx(), { collection: "posts", id: "e1", collections: ["schemaEntries", "videosEmbeds", "aiEntries"], data: true }, '"coywolf-review"');
	assert.equal(db.stats.roundTrips, 1);
	assert.deepEqual(docs.docs.get("schemaEntries"), { mainSubject: "publisher" });
	assert.equal(docs.docs.get("videosEmbeds"), null);
	assert.deepEqual(docs.docs.get("aiEntries"), { entities: [{ name: "Wolf" }] });
	assert.deepEqual(docs.data.content, [{ _type: "coywolf-review", itemName: "Trail camera" }]);
	assert.equal(docs.data.sidebar, undefined, "JSON columns that can't hold a review aren't parsed");
	assert.equal(docs.data.title, "Title");
	delete globalThis.__testEnv;
});

test("rowData parses JSON columns and keeps text", () => {
	assert.deepEqual(rowData({ a: "[1]", b: "{x", c: "plain", d: 3 }), { a: [1], b: "{x", c: "plain", d: 3 });
	assert.equal(rowData(null), null);
});

test("without a D1 binding, entry docs come from the plugin context", async () => {
	const reads = [];
	const store = (name, rows) => ({ get: async (id) => (reads.push(`${name}:${id}`), rows[id] ?? null) });
	const ctx = {
		storage: { schemaEntries: store("schemaEntries", { "posts:e1": { a: 1 } }), aiEntries: store("aiEntries", {}) },
		content: { get: async () => ({ data: { body: [] } }) },
	};
	const docs = await readEntryDocs(ctx, { collection: "posts", id: "e1", collections: ["schemaEntries", "aiEntries"], data: true });
	assert.deepEqual(docs.docs.get("schemaEntries"), { a: 1 });
	assert.deepEqual(docs.data, { body: [] });
	assert.deepEqual(reads, ["schemaEntries:posts:e1", "aiEntries:posts:e1"]);
});

// ── Video facts ──────────────────────────────────────────────────

const UID_A = "a".repeat(32);
const UID_B = "b".repeat(32);

function videoDb() {
	const db = d1();
	put(db, "videosMeta", UID_A, { uid: UID_A, name: "A" });
	put(db, "videosMeta", UID_B, { uid: UID_B, name: "B" });
	put(db, "videosStats", UID_A, { plays: 3, likes: 1 });
	put(db, "videosEmbeds", "posts:e1", { status: "published", uids: [UID_A] });
	put(db, "videosEmbeds", "posts:e2", { status: "draft", uids: [UID_B] });
	return db;
}

test("video facts: metadata, counts and published state in one batch", async () => {
	const db = videoDb();
	globalThis.__testEnv = { DB: db };
	const facts = await videoFacts(strictCtx(), [UID_A, UID_B], async () => assert.fail("fallback used"));
	assert.equal(db.stats.roundTrips, 1);
	assert.deepEqual(facts.get(UID_A), { published: true, meta: { uid: UID_A, name: "A" }, counts: { plays: 3, likes: 1 } });
	assert.deepEqual(facts.get(UID_B), { published: false, meta: { uid: UID_B, name: "B" }, counts: null }, "draft-only videos aren't published");
	delete globalThis.__testEnv;
});

test("video facts are read once per request: the schema hook and the video block share them", async () => {
	const db = videoDb();
	globalThis.__testEnv = { DB: db };
	await inRequest(async () => {
		const [fromSchema, fromBlock] = await Promise.all([
			videoFacts(strictCtx(), [UID_A, UID_B], async () => new Set()),
			videoFacts(strictCtx(), [UID_A], async () => new Set()),
		]);
		assert.equal(fromBlock.get(UID_A), fromSchema.get(UID_A));
		await videoFacts(strictCtx(), [UID_B], async () => new Set());
	});
	assert.equal(db.stats.roundTrips, 1);
	// A new request reads again.
	await inRequest(() => videoFacts(strictCtx(), [UID_A], async () => new Set()));
	assert.equal(db.stats.roundTrips, 2, db.stats.sql.join("\n"));
	delete globalThis.__testEnv;
});

// ── Settings with the switches, generation, settling purge ──────

const option = (key) => `plugin:coywolf-pack:settings:${key}`;

test("the videos player settings come with the feature switches (no query of their own)", async () => {
	const db = d1(`INSERT INTO options (name, value) VALUES ('${option("videosAccentColor")}', '"#ff0000"'), ('${option("videosLightEmbed")}', 'false');`);
	globalThis.__testEnv = { DB: db };
	features.invalidateFeatures();
	invalidatePublicConfig();
	await features.siteFeatures();
	assert.equal(db.stats.roundTrips, 1);
	const cfg = await publicConfig(strictCtx());
	assert.equal(cfg.accent, "#ff0000");
	assert.equal(cfg.lightEmbed, false);
	assert.equal(db.stats.roundTrips, 1);
	// Cached until settings change: a save (here) drops it.
	await publicConfig(strictCtx());
	assert.equal(db.stats.roundTrips, 1);
	features.invalidateFeatures();
	await publicConfig(strictCtx());
	assert.equal(db.stats.roundTrips, 2, db.stats.sql.join("\n"));
	delete globalThis.__testEnv;
});

test("a new settings generation in D1 moves the settings epoch (another isolate saved)", async () => {
	const db = d1();
	globalThis.__testEnv = { DB: db };
	features.invalidateFeatures();
	await features.siteFeatures();
	const before = features.settingsEpoch();
	// Another isolate records a save.
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run(features.GENERATION_OPTION, JSON.stringify({ id: "g1", at: Date.now() }));
	// This isolate's cache is still fresh: nothing changes until it reads again.
	await features.siteFeatures();
	assert.equal(features.settingsEpoch(), before);
	// Simulate the cache expiring (without invalidateFeatures, which would bump the epoch itself).
	const realNow = Date.now;
	Date.now = () => realNow() + features.FEATURES_TTL_MS + 1;
	try {
		await features.siteFeatures();
		assert.equal(features.settingsEpoch(), before + 1);
		// Reading the same generation again doesn't.
		Date.now = () => realNow() + 2 * features.FEATURES_TTL_MS + 2;
		await features.siteFeatures();
		assert.equal(features.settingsEpoch(), before + 1);
	} finally {
		Date.now = realNow;
	}
	delete globalThis.__testEnv;
});

test("settling purge: claimed once, after the switches' lifetime, by one isolate", async () => {
	const db = d1();
	globalThis.__testEnv = { DB: db };
	features.invalidateFeatures();
	const saved = await recordSettingsChange(db, { purgeEverything: true }, Date.now());
	assert.deepEqual(saved.settle, { purgeEverything: true });
	await features.siteFeatures();
	// Not yet due.
	assert.equal(await claimSettle(db), null);
	const later = Date.now() + features.FEATURES_TTL_MS + 20_000;
	// Due: one isolate claims it; a second claim (same stale row) loses.
	const raw = features.siteOption(features.GENERATION_OPTION);
	assert.deepEqual(await claimSettle(db, later), { purgeEverything: true });
	assert.equal(await claimSettle(db, later), null, "already claimed in this isolate");
	features.rememberSiteOption(features.GENERATION_OPTION, raw);
	assert.equal(await claimSettle(db, later), null, "another isolate's claim fails the compare-and-set");
	assert.equal(parseGeneration(db.sqlite.prepare("SELECT value FROM options WHERE name = ?").get(features.GENERATION_OPTION).value).settle, undefined);
	delete globalThis.__testEnv;
});

test("a save keeps a settling purge still pending from an earlier one", async () => {
	const db = d1();
	await recordSettingsChange(db, { purgeEverything: true });
	const row = await recordSettingsChange(db, null);
	assert.deepEqual(row.settle, { purgeEverything: true });
	assert.deepEqual(mergeScopes({ pathPrefixes: ["/a"] }, { pathPrefixes: ["/b", "/a"] }), { pathPrefixes: ["/a", "/b"] });
	assert.deepEqual(mergeScopes(null, { pathPrefixes: ["/a"] }), { pathPrefixes: ["/a"] });
	assert.deepEqual(mergeScopes({ tags: ["coywolf-redirects"] }, { tags: ["coywolf-redirects"] }), { tags: ["coywolf-redirects"] });
	// Workers Cache takes both kinds in one call (it clears whatever matches either).
	assert.deepEqual(mergeScopes({ tags: ["coywolf-redirects"] }, { pathPrefixes: ["/robots.txt"] }), { pathPrefixes: ["/robots.txt"], tags: ["coywolf-redirects"] });
	assert.deepEqual(mergeScopes({ tags: ["a"], pathPrefixes: ["/x"] }, { tags: ["a", "b"] }), { pathPrefixes: ["/x"], tags: ["a", "b"] });
	assert.deepEqual(mergeScopes({ tags: ["a"] }, { purgeEverything: true }), { purgeEverything: true });
	// Over Cloudflare's 100 operations per purge: everything instead.
	const many = Array.from({ length: 60 }, (_, i) => `/p${i}`);
	assert.deepEqual(mergeScopes({ pathPrefixes: many }, { tags: many.map((p) => `t${p}`) }), { purgeEverything: true });
});

// ── Redirects ────────────────────────────────────────────────────

test("redirects: serving never creates the table; a missing table means no rules", async () => {
	const db = d1();
	invalidateRedirectCache();
	const res = await serveRedirect(new URL("https://example.com/old"), { DB: db }, () => {});
	assert.equal(res, undefined);
	assert.ok(!db.stats.sql.some((s) => /CREATE/i.test(s)), "no CREATE on the read path");
	invalidateRedirectCache();
});

test("redirects: the rules' index stays in memory until an edit (the settings epoch); only a path that's an exact source reads its rule", async () => {
	const db = d1();
	await saveRule(db, { source: "/old", target: "/new" });
	await saveRule(db, { source: "^/a/(\\d+)$", target: "/b/$1", isRegex: true });
	await saveRule(db, { source: "/off", target: "/x", enabled: false });
	invalidateRedirectCache();
	db.stats.roundTrips = 0;
	db.stats.sql = [];
	const env = { DB: db };
	const hits = [];
	const go = async (path) => {
		const res = await serveRedirect(new URL(`https://example.com${path}`), env, (p) => hits.push(p));
		return res && [res.status, res.headers.get("Location")];
	};
	const count = (re) => db.stats.sql.filter((s) => re.test(s)).length;
	const PATTERNS = /FROM coywolf_redirects WHERE is_regex = 1/;
	const EXACT = /FROM coywolf_redirects WHERE source IN \(\?(?:, \?)?\)/;
	const SOURCES = /SELECT source FROM coywolf_redirects WHERE is_regex = 0 AND enabled = 1/;
	assert.deepEqual(await go("/old/?x=1"), [301, "https://example.com/new?x=1"]);
	assert.deepEqual(await go("/a/42"), [301, "https://example.com/b/42"]);
	assert.equal(await go("/off"), undefined, "disabled rules don't match");
	assert.equal(await go("/nothing"), undefined);
	await Promise.all(hits);
	assert.equal(count(PATTERNS), 1, "one pattern load for four requests");
	assert.equal(count(SOURCES), 1, "and one load of the exact sources");
	assert.equal(count(EXACT), 1, "only the cold request read its exact rule; the others aren't exact sources");
	assert.ok(!db.stats.sql.some((s) => /FROM coywolf_redirects WHERE enabled/.test(s)), "no full-table load");
	await go("/old");
	assert.equal(count(EXACT), 2, "an exact source reads its rule (an edit in another isolate shows at once)");
	features.invalidateFeatures(); // A save (settings epoch moves).
	await go("/old");
	assert.equal(count(PATTERNS), 2);
	assert.equal(count(SOURCES), 2);
	invalidateRedirectCache();
});

test("pack reads issued in the same tick share one D1 batch; a bad one fails alone", async () => {
	const { batchedAll, batchedFirst } = await import("../src/core/d1-batch.ts");
	const db = d1("INSERT INTO options (name, value) VALUES ('a', '1'), ('b', '2');");
	const [a, b, rows] = await Promise.all([
		batchedFirst(db, db.prepare("SELECT value FROM options WHERE name = ?").bind("a")),
		batchedFirst(db, db.prepare("SELECT value FROM options WHERE name = ?").bind("b")),
		batchedAll(db, db.prepare("SELECT name FROM options ORDER BY name")),
	]);
	assert.deepEqual([a.value, b.value, rows.map((r) => r.name)], ["1", "2", ["a", "b"]]);
	assert.equal(db.stats.roundTrips, 1);
	const results = await Promise.allSettled([
		batchedFirst(db, db.prepare("SELECT value FROM options WHERE name = ?").bind("a")),
		batchedFirst(db, db.prepare("SELECT nope FROM missing_table")),
	]);
	assert.equal(results[0].status, "fulfilled");
	assert.equal(results[0].value.value, "1");
	assert.equal(results[1].status, "rejected");
});

test("entry docs are read once per request, however many hooks ask", async () => {
	const db = d1();
	put(db, "schemaEntries", "posts:e1", { a: 1 });
	globalThis.__testEnv = { DB: db };
	await inRequest(async () => {
		const req = { collection: "posts", id: "e1", collections: ["schemaEntries", "videosEmbeds"] };
		const [x, y] = await Promise.all([readEntryDocs(strictCtx(), req), readEntryDocs(strictCtx(), req)]);
		await readEntryDocs(strictCtx(), { ...req, collections: ["schemaEntries"] });
		assert.deepEqual(x.docs.get("schemaEntries"), { a: 1 });
		assert.equal(y.docs.get("videosEmbeds"), null);
	});
	assert.equal(db.stats.roundTrips, 1);
	delete globalThis.__testEnv;
});

test("cold isolate: the redirect lookup and the feature switches are one D1 round trip", async () => {
	const { prefetchRedirects } = await import("../src/redirects/middleware.ts");
	const db = d1();
	await saveRule(db, { source: "/old", target: "/new" });
	globalThis.__testEnv = { DB: db };
	// This database's settings generation (none) is the one this "isolate" last saw.
	features.invalidateFeatures();
	await features.siteFeatures();
	features.invalidateFeatures();
	invalidateRedirectCache();
	db.stats.roundTrips = 0;
	db.stats.sql = [];
	const url = new URL("https://example.com/old");
	prefetchRedirects(url, { DB: db });
	await features.siteFeatures();
	const pending = [];
	const res = await serveRedirect(url, { DB: db }, (p) => pending.push(p));
	assert.equal(res.status, 301);
	// One batch for every read: the switches, the request's exact rule and the rules' index.
	assert.equal(db.stats.roundTrips, 1, db.stats.sql.join("\n"));
	// The hit is written after the response (batched per isolate).
	await Promise.all(pending);
	assert.equal(db.stats.roundTrips, 2);
	assert.ok(db.stats.sql.at(-1).startsWith("UPDATE coywolf_redirects SET hits"));
	invalidateRedirectCache();
	delete globalThis.__testEnv;
});

// ── Stored image sizes ──────────────────────────────────────────

test("file records are cached per isolate until the settings epoch moves (a save elsewhere), not only for their minute", async () => {
	const { resolveFile, invalidateSiteCache } = await import("../src/files/site.ts");
	const db = d1("CREATE TABLE media (id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, size INTEGER, storage_key TEXT, created_at TEXT, status TEXT);");
	db.sqlite.prepare("INSERT INTO media VALUES ('01F', 'guide.pdf', 'application/pdf', 10, 'k', '2026-01-01', 'ready')").run();
	invalidateSiteCache("01F");
	assert.equal((await resolveFile(db, "01F")).name, "guide.pdf");
	db.sqlite.prepare("UPDATE media SET filename = 'guide-v2.pdf' WHERE id = '01F'").run();
	assert.equal((await resolveFile(db, "01F")).name, "guide.pdf", "cached");
	features.invalidateFeatures(); // A new settings generation seen (or a save here): the epoch moves.
	assert.equal((await resolveFile(db, "01F")).name, "guide-v2.pdf", "a page tagged with the new generation never shows the old record");
});

test("imageInfo: one statement for all of a page's images, cached, read again after a settings change", async () => {
	const MEDIA = "CREATE TABLE media (id TEXT PRIMARY KEY, storage_key TEXT, width INTEGER, height INTEGER, mime_type TEXT, size INTEGER, status TEXT, focal_x REAL, focal_y REAL, created_at TEXT);";
	const db = d1(MEDIA);
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify({ images: true }));
	for (const id of ["01A", "01B", "01C"]) db.sqlite.prepare("INSERT INTO media VALUES (?, ?, 1600, 900, 'image/jpeg', 1000, 'ready', NULL, NULL, '2020-01-01 00:00:00')").run(id, `${id}.jpg`);
	put(db, "imageVariants", "01A", { v: 1, w: [400, 640, 800, 1200], c: ["600x315"], k: "600x315", at: "" });
	globalThis.__testEnv = { DB: db };
	const { imageInfo, imageDimensions, responsiveImage, croppedImage } = await import("../src/images/pack.ts");
	const { setImageCdn } = await import("../src/images/lib.ts");
	const { setImageCrops } = await import("../src/images/variants.ts");
	const { PENDING_MEDIA_LOCAL } = await import("../src/images/pending.ts");
	setImageCdn("https://media.example.com");
	setImageCrops([[600, 315], [2000, 1000]]);
	features.invalidateFeatures();
	await features.siteFeatures();
	const srcs = ["/_emdash/api/media/file/01A.jpg", "https://media.example.com/01B.jpg", "/_emdash/api/media/file/01C.jpg", "/_emdash/api/media/file/NOPE.png", "https://elsewhere.example/x.jpg"];
	db.stats.roundTrips = 0;
	const info = await inRequest(() => imageInfo(srcs));
	assert.equal(db.stats.roundTrips, 1, "one statement for the page");
	assert.equal(info.size, 3);
	assert.deepEqual(info.get(srcs[0]).variants.w, [400, 640, 800, 1200]);
	assert.equal(info.get(srcs[1]).variants, null);

	// Later calls on the page (and imageDimensions) come from the cache.
	const dims = await inRequest(() => imageDimensions(srcs));
	assert.deepEqual(dims.get(srcs[2]), { width: 1600, height: 900 });
	const locals = {};
	const r = await inRequest(() => responsiveImage(srcs[0], { locals }));
	assert.equal(r.src, "https://media.example.com/v1/01A-800.webp");
	assert.match(r.webp, /01A-400\.webp 400w, .*01A-1200\.webp 1200w, https:\/\/media\.example\.com\/01A\.jpg 1600w$/);
	assert.match(r.avif, /^https:\/\/media\.example\.com\/v1\/01A-400\.avif 400w/);
	const crop = await inRequest(() => croppedImage(srcs[0], [[600, 315, "600w"]], { locals }));
	assert.equal(crop.src, "https://media.example.com/v1/01A-600x315.webp");
	assert.equal(locals[PENDING_MEDIA_LOCAL], undefined, "stored: not a stopgap");
	assert.equal(await inRequest(() => responsiveImage(srcs[2], { locals })), null, "no record: the theme falls back");
	assert.equal(locals[PENDING_MEDIA_LOCAL], undefined, "an older image with sizes for existing images off: /s/ for good, not a stopgap");
	assert.equal(db.stats.roundTrips, 1, "that setting comes with the switches");

	// A settings change (any isolate) drops the cache: the next page reads again.
	put(db, "imageVariants", "01C", { v: 1, w: [400], c: [], at: "" });
	features.invalidateFeatures();
	await features.siteFeatures();
	db.stats.roundTrips = 0;
	const again = await inRequest(() => imageInfo([srcs[2]]));
	assert.equal(db.stats.roundTrips, 1);
	assert.deepEqual(again.get(srcs[2]).variants.w, [400]);
	const later = {};
	assert.equal(await inRequest(() => croppedImage(srcs[2], [[2000, 1000, "1x"]], { locals: later })), null);
	assert.equal(later[PENDING_MEDIA_LOCAL], undefined, "a crop the image is too small for isn't a stopgap");
	setImageCdn(null);
	setImageCrops([]);
});

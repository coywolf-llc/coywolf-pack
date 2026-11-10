// Run: node --test test/redirects.test.mjs
import "./ts-resolve.mjs";
import { registerHooks } from "node:module";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Workers Cache's purge, as cloudflare:workers exposes it.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: "data:text/javascript,export const cache = { purge: (o) => globalThis.__purge(o) };", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const { compile, match, listRules, saveRule } = await import("../src/redirects/rules.ts");
const { serveRedirect, invalidateRedirectCache, setRedirectHitDelay } = await import("../src/redirects/middleware.ts");
setRedirectHitDelay(0); // Hits are batched per isolate (a second's wait in production).

const rule = (source, target, extra = {}) => ({
	id: source,
	source,
	target,
	type: 301,
	isRegex: true,
	enabled: true,
	hits: 0,
	lastHit: null,
	note: null,
	createdAt: "",
	updatedAt: "",
	...extra,
});

/** What a browser would end up on: the request URL's own parsing, then the Location resolved against it. */
function follow(compiled, requestUrl) {
	const url = new URL(requestUrl);
	const found = match(compiled, url.pathname, url.search);
	return found && new URL(found.location, url).href;
}

test("regex capture can't turn a site path into a protocol-relative redirect", () => {
	const compiled = compile([rule("^/blog/(.*)$", "/$1")]);
	assert.equal(follow(compiled, "https://example.com/blog/hello"), "https://example.com/hello");
	assert.equal(follow(compiled, "https://example.com/blog//evil.com/x"), "https://example.com/evil.com/x");
	assert.equal(follow(compiled, "https://example.com/blog///evil.com"), "https://example.com/evil.com");
	// URL parsing turns "\" into "/" in http(s) paths before the rules see it.
	assert.equal(follow(compiled, "https://example.com/blog/\\evil.com"), "https://example.com/evil.com");
	assert.equal(follow(compiled, "https://example.com/blog/\\/evil.com"), "https://example.com/evil.com");
	// Percent-encoded slashes and backslashes stay encoded, so they stay on this site.
	assert.equal(follow(compiled, "https://example.com/blog/%2F%2Fevil.com"), "https://example.com/%2F%2Fevil.com");
	assert.equal(follow(compiled, "https://example.com/blog/%5Cevil.com"), "https://example.com/%5Cevil.com");
	assert.equal(follow(compiled, "https://example.com/blog/%5C%5Cevil.com"), "https://example.com/%5C%5Cevil.com");
});

test("a backslash captured from the raw path is collapsed too", () => {
	const compiled = compile([rule("^/blog/(.*)$", "/$1")]);
	assert.equal(match(compiled, "/blog/\\evil.com", "").location, "/evil.com");
	assert.equal(match(compiled, "/blog/\\\\evil.com", "").location, "/evil.com");
});

test("an absolute target keeps the host it names", () => {
	const compiled = compile([rule("^/old(.*)$", "https://example.com$1")]);
	assert.equal(match(compiled, "/old/page", "").location, "https://example.com/page");
	assert.equal(match(compiled, "/old.evil.com/x", ""), null);
	assert.equal(match(compiled, "/old@evil.com", ""), null);
	// A host built from a capture is the site owner's choice.
	const open = compile([rule("^/go/([a-z.]+)$", "https://$1/")]);
	assert.equal(match(open, "/go/coywolf.com", "").location, "https://coywolf.com/");
});

test("ordinary rules are unchanged", () => {
	const compiled = compile([
		rule("/old", "/new", { isRegex: false }),
		rule("^/a/(\\d+)$", "/b/$1"),
		rule("/gone", "", { isRegex: false, type: 410 }),
	]);
	assert.equal(match(compiled, "/old/", "?x=1").location, "/new?x=1");
	assert.equal(match(compiled, "/a/42", "").location, "/b/42");
	assert.equal(match(compiled, "/gone", "?x").location, "");
});

test("a redirect to an anchor keeps the request's query string before the fragment", () => {
	const compiled = compile([
		rule("/pricing", "/#pricing-h", { isRegex: false }),
		rule("/plans", "/?ref=plans#pricing-h", { isRegex: false }),
		rule("/faq", "/help#a?b", { isRegex: false }),
		rule("^/docs/(.*)$", "/guide/$1#top"),
		rule("^/ext/(.*)$", "https://example.com/$1#section"),
	]);
	// recollect.fyi: /pricing/?x=1 went to /#pricing-h?x=1 (the query lost inside the anchor).
	assert.equal(match(compiled, "/pricing/", "?x=1").location, "/?x=1#pricing-h");
	assert.equal(match(compiled, "/pricing/", "").location, "/#pricing-h");
	// The target's own query wins; the request's isn't added.
	assert.equal(match(compiled, "/plans", "?x=1").location, "/?ref=plans#pricing-h");
	// A "?" inside the fragment isn't a query.
	assert.equal(match(compiled, "/faq", "?x=1").location, "/help?x=1#a?b");
	// Patterns with a capture and a fragment.
	assert.equal(match(compiled, "/docs/setup", "?x=1").location, "/guide/setup?x=1#top");
	assert.equal(match(compiled, "/docs/setup", "").location, "/guide/setup#top");
	assert.equal(match(compiled, "/ext/a/b", "?utm=1").location, "https://example.com/a/b?utm=1#section");
	// What a browser ends up on.
	assert.equal(follow(compiled, "https://recollect.fyi/pricing/?x=1"), "https://recollect.fyi/?x=1#pricing-h");
});

test("middleware puts the request's query before the target's fragment (edge and origin responses)", async () => {
	invalidateRedirectCache();
	const rows = [
		{ id: "1", source: "^/pricing/?$", target: "/#pricing-h", type: 301, is_regex: 1, enabled: 1, hits: 0, last_hit: null, note: null, created_at: "", updated_at: "" },
	];
	const statement = (sql) => ({
		sql,
		bind: () => statement(sql),
		run: async () => ({ meta: { changes: 1 } }),
		all: async () => ({ results: /is_regex = 1/.test(sql) ? rows : [] }),
	});
	const db = { prepare: statement, batch: (statements) => Promise.all(statements.map((s) => s.all())) };
	const origin = await serveRedirect(new URL("https://recollect.fyi/pricing/?x=1"), { DB: db }, () => {});
	assert.equal(origin.headers.get("Location"), "https://recollect.fyi/?x=1#pricing-h");
	const edge = await serveRedirect(new URL("https://recollect.fyi/pricing/?x=1"), { DB: db }, () => {}, {}, true);
	assert.equal(edge.headers.get("Location"), "/?x=1#pricing-h");
	invalidateRedirectCache();
});

test("middleware never answers with an off-site Location for a site path", async () => {
	invalidateRedirectCache();
	const rows = [
		{ id: "1", source: "^/blog/(.*)$", target: "/$1", type: 301, is_regex: 1, enabled: 1, hits: 0, last_hit: null, note: null, created_at: "", updated_at: "" },
	];
	const statement = (sql) => ({
		sql,
		bind: () => statement(sql),
		run: async () => ({ meta: { changes: 1 } }),
		all: async () => ({ results: /is_regex = 1/.test(sql) ? rows : [] }),
	});
	const db = { prepare: statement, batch: (statements) => Promise.all(statements.map((s) => s.all())) };
	const res = await serveRedirect(new URL("https://example.com/blog//evil.com/x"), { DB: db }, () => {});
	assert.equal(res.status, 301);
	assert.equal(res.headers.get("Location"), "https://example.com/evil.com/x");
	invalidateRedirectCache();
});

test("listRules creates the table once per isolate and recreates it if a restore dropped it", async () => {
	let batches = 0;
	let selects = 0;
	let dropped = false;
	const db = {
		prepare: (sql) => ({
			all: async () => {
				selects++;
				if (dropped) {
					dropped = false;
					throw new Error("D1_ERROR: no such table: coywolf_redirects");
				}
				return { results: [] };
			},
		}),
		batch: async () => {
			batches++;
			return [];
		},
	};
	await Promise.all([listRules(db), listRules(db)]);
	await listRules(db);
	const before = batches;
	assert.ok(before <= 1);
	dropped = true;
	await listRules(db);
	assert.equal(batches, before + 1);
	assert.equal(selects, 5);
});

// ── Serving from D1: one indexed read per request, patterns cached ──

/** A D1 stand-in over node:sqlite that records the SQL and bindings it runs. */
function sqliteD1() {
	const db = new DatabaseSync(":memory:");
	const log = [];
	const exec = (sql, params) => {
		const st = db.prepare(sql);
		return /^\s*select/i.test(sql) ? { results: st.all(...params) } : { results: [], meta: { changes: Number(st.run(...params).changes) } };
	};
	const statement = (sql, params = []) => ({
		sql,
		params,
		bind: (...p) => statement(sql, p),
		all: async () => (log.push({ sql, params }), exec(sql, params)),
		first: async () => (log.push({ sql, params }), exec(sql, params).results[0] ?? null),
		run: async () => (log.push({ sql, params }), exec(sql, params)),
	});
	return {
		sqlite: db,
		log,
		prepare: (sql) => statement(sql),
		batch: async (statements) => statements.map((s) => (log.push({ sql: s.sql, params: s.params }), exec(s.sql, s.params))),
	};
}

async function serve(db, href) {
	const hits = [];
	const res = await serveRedirect(new URL(href), { DB: db }, (p) => hits.push(p));
	await Promise.all(hits);
	return res && [res.status, res.headers.get("Location")];
}

async function seeded() {
	const db = sqliteD1();
	await saveRule(db, { source: "/old", target: "/new" });
	await saveRule(db, { source: "/both", target: "/exact-wins" });
	await saveRule(db, { source: "^/both$", target: "/pattern-loses", isRegex: true });
	await saveRule(db, { source: "^/a/(\\d+)/?$", target: "/b/$1", isRegex: true });
	await saveRule(db, { source: "^/a/", target: "/later-pattern", isRegex: true });
	await saveRule(db, { source: "/caf%C3%A9", target: "/coffee" });
	await saveRule(db, { source: "/gone", type: 410 });
	await saveRule(db, { source: "/off", target: "/x", enabled: false });
	invalidateRedirectCache();
	db.log.length = 0;
	return db;
}

test("exact rules win over patterns; patterns are tried in source order", async () => {
	const db = await seeded();
	assert.deepEqual(await serve(db, "https://example.com/both"), [301, "https://example.com/exact-wins"]);
	// "^/a/" sorts before "^/a/(\d+)/?$", so it's tried first.
	assert.deepEqual(await serve(db, "https://example.com/a/42"), [301, "https://example.com/later-pattern"]);
	assert.equal(await serve(db, "https://example.com/off"), undefined);
	assert.deepEqual(await serve(db, "https://example.com/gone?x=1"), [410, null]);
	invalidateRedirectCache();
});

test("exact rules match with or without a trailing slash and keep the query string", async () => {
	const db = await seeded();
	assert.deepEqual(await serve(db, "https://example.com/old"), [301, "https://example.com/new"]);
	assert.deepEqual(await serve(db, "https://example.com/old/"), [301, "https://example.com/new"]);
	assert.deepEqual(await serve(db, "https://example.com/old//?utm=x"), [301, "https://example.com/new?utm=x"]);
	assert.equal(await serve(db, "https://example.com/OLD"), undefined, "case-sensitive, as before");
	invalidateRedirectCache();
});

test("encoded paths match the rule's source as written (no decoding)", async () => {
	const db = await seeded();
	// The URL parser percent-encodes "café", so it reaches the rule written encoded.
	assert.deepEqual(await serve(db, "https://example.com/café"), [301, "https://example.com/coffee"]);
	assert.deepEqual(await serve(db, "https://example.com/caf%C3%A9/"), [301, "https://example.com/coffee"]);
	assert.equal(await serve(db, "https://example.com/caf%c3%a9"), undefined);
	invalidateRedirectCache();
});

test("hits are counted for exact and pattern matches", async () => {
	const db = await seeded();
	await serve(db, "https://example.com/old");
	await serve(db, "https://example.com/old/");
	await serve(db, "https://example.com/both");
	const hits = Object.fromEntries(db.sqlite.prepare("SELECT source, hits FROM coywolf_redirects").all().map((r) => [r.source, r.hits]));
	assert.equal(hits["/old"], 2);
	assert.equal(hits["/both"], 1);
	assert.equal(hits["^/both$"], 0);
	invalidateRedirectCache();
});

test("a request reads its exact rule (indexed) only when its path is an exact source; the patterns and sources once per isolate", async () => {
	const db = await seeded();
	invalidateRedirectCache();
	await serve(db, "https://example.com/old/");
	await serve(db, "https://example.com/nothing-here");
	await serve(db, "https://example.com/old");
	const reads = db.log.filter((q) => /^SELECT/.test(q.sql) && /coywolf_redirects/.test(q.sql) && !/SELECT \* FROM/.test(q.sql));
	const exact = reads.filter((q) => /WHERE source = \? AND is_regex = 0 AND enabled = 1$/.test(q.sql));
	const patterns = reads.filter((q) => /WHERE is_regex = 1 AND enabled = 1 ORDER BY source$/.test(q.sql));
	const sources = reads.filter((q) => /^SELECT source FROM coywolf_redirects WHERE is_regex = 0 AND enabled = 1 LIMIT/.test(q.sql));
	assert.deepEqual(exact.map((q) => q.params), [["/old"], ["/old"]], "/nothing-here is no exact source: no read");
	assert.equal(patterns.length, 1);
	assert.equal(sources.length, 1);
	assert.equal(reads.length, 4, reads.map((q) => q.sql).join("\n"));
	// Both go through an index: no scan of the table.
	const plan = (q) => db.sqlite.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params).map((r) => r.detail).join("; ");
	assert.match(plan(exact[0]), /SEARCH coywolf_redirects USING INDEX coywolf_redirects_source \(source=\? AND is_regex=\?\)/);
	assert.match(plan(patterns[0]), /coywolf_redirects USING INDEX coywolf_redirects_patterns/);
	assert.doesNotMatch(plan(patterns[0]), /TEMP B-TREE/);
	invalidateRedirectCache();
});

test("hits within a moment are written together: one UPDATE per rule, not one per request", async () => {
	const db = await seeded();
	invalidateRedirectCache();
	await serve(db, "https://example.com/nothing"); // The rules' index is in memory: the requests below answer within a millisecond or two.
	setRedirectHitDelay(100);
	const pending = [];
	await Promise.all(["/old?a=1", "/old?a=2", "/old?a=3", "/a/1", "/a/2"].map((path) => serveRedirect(new URL(`https://example.com${path}`), { DB: db }, (p) => pending.push(p))));
	await Promise.all(pending);
	setRedirectHitDelay(0);
	const updates = db.log.filter((q) => /^UPDATE coywolf_redirects SET hits/.test(q.sql));
	assert.equal(updates.length, 2, `one per rule: ${JSON.stringify(updates.map((u) => u.params))}`);
	const hits = Object.fromEntries(db.sqlite.prepare("SELECT source, hits FROM coywolf_redirects").all().map((r) => [r.source, r.hits]));
	assert.equal(hits["/old"], 3);
	assert.equal(hits["^/a/"], 2, JSON.stringify(hits)); // the first pattern in source order that matches
	invalidateRedirectCache();
});

test("an exact rule added in another isolate is seen once this one reads the new redirects version (or settings generation)", async () => {
	const features = await import("../src/core/features.ts");
	const { REDIRECTS_VERSION_OPTION, noteRedirectsChanged } = await import("../src/redirects/middleware.ts");
	const db = await seeded();
	db.sqlite.exec("CREATE TABLE IF NOT EXISTS options (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
	features.invalidateFeatures();
	await features.siteFeatures(db); // This isolate's read of the switches (no redirects version yet).
	invalidateRedirectCache();
	assert.equal(await serve(db, "https://example.com/added"), undefined, "not an exact source yet");
	await saveRule(db, { source: "/added", target: "/there" }); // in another isolate, by a content hook
	assert.equal(await serve(db, "https://example.com/added"), undefined, "this isolate's index doesn't have it yet");
	features.rememberSiteOption(REDIRECTS_VERSION_OPTION, JSON.stringify("v2")); // the switches' next read carries the new version
	assert.deepEqual(await serve(db, "https://example.com/added"), [301, "https://example.com/there"]);
	// noteRedirectsChanged writes the version other isolates read with the switches.
	await noteRedirectsChanged(db);
	assert.match(db.sqlite.prepare("SELECT value FROM options WHERE name = ?").get(REDIRECTS_VERSION_OPTION).value, /^"[0-9a-f-]{36}"$/);
	invalidateRedirectCache();
});

test("patterns: nested repeats are refused on save; paths longer than MAX_PATTERN_PATH only match exact rules", async () => {
	const { nestedRepeat, validate, RedirectValidationError, MAX_PATTERN_PATH } = await import("../src/redirects/rules.ts");
	for (const slow of ["^/(a+)+$", "(\\w+\\s?)*", "^/((a)+)+$", "^/(a{2,})+$", "^/(x*y?)+z$", "^/(?:[a-z]+/)*end$", "^/(a|a)*$", "^/(a|ab)+$", "^/(?:x|(?:x))*$", "^/([^/]+a)+$"])
		assert.ok(nestedRepeat(slow), slow);
	for (const fine of [
		"^/a/(\\d+)/?$",
		"^/blog/(.*)$",
		"^/(?:news|blog)/(\\d{4})/(\\d{2})/(.*)$",
		"^/[(a+)+]$",
		"^/\\(a+\\)+$",
		"^/(a|b){2}$",
		"^/(ab)?c+$",
		"^/(?:[^/]+/)*feed/?$",
		"^/(?:[^\\/]+\\/)*feed/?$",
		"^/blog(?:/[^/]+)+$",
		"^/img/[a-z0-9-]+\\.(?:jpg|png)+$",
	])
		assert.equal(nestedRepeat(fine), null, fine);
	// The allowed shapes really are fast on a path that almost matches.
	const started = performance.now();
	assert.equal(new RegExp("^/(?:[^/]+/)*feed/?$").test(`/${"a/".repeat(500)}x`), false);
	assert.equal(new RegExp("^/blog(?:/[^/]+)+$").test(`/blog${"/a".repeat(500)}/`), false);
	assert.ok(performance.now() - started < 200);
	assert.throws(() => validate({ source: "^/(a+)+$", target: "/x", isRegex: true }), (error) => error instanceof RedirectValidationError && /very slow/.test(error.message));
	assert.doesNotThrow(() => validate({ source: "^/a/(\\d+)/?$", target: "/b/$1", isRegex: true }));
	const compiled = compile([rule("^/(.*)$", "/all/$1")]);
	assert.ok(match(compiled, "/x", ""));
	assert.equal(match(compiled, `/${"x".repeat(MAX_PATTERN_PATH)}`, ""), null, "a crafted long path can't make every pattern run on it");
});

test("a pattern saved before the speed check can still be enabled, disabled or retargeted (its pattern unchanged), not changed into another slow one", async () => {
	const db = sqliteD1();
	await saveRule(db, { source: "/x", target: "/y" }); // creates the table
	db.sqlite.prepare("INSERT INTO coywolf_redirects (id, source, target, type, is_regex, enabled, created_at, updated_at) VALUES ('old', '^/(a+)+$', '/a', 301, 1, 1, 'x', 'x')").run();
	const disabled = await saveRule(db, { id: "old", source: "^/(a+)+$", target: "/a", isRegex: true, enabled: false });
	assert.equal(disabled.enabled, false);
	const moved = await saveRule(db, { id: "old", source: "^/(a+)+$", target: "/elsewhere", isRegex: true });
	assert.equal(moved.target, "/elsewhere");
	await assert.rejects(saveRule(db, { id: "old", source: "^/(b+)+$", target: "/a", isRegex: true }), /very slow/);
	// Importing it again (an export) is fine too; a new slow pattern isn't.
	await assert.doesNotReject(saveRule(db, { source: "^/(a+)+$", target: "/a", isRegex: true }));
	await assert.rejects(saveRule(db, { source: "^/(c|c)*$", target: "/a", isRegex: true }), /very slow/);
});

test("serving from a database without the table: no rules, no error, no CREATE", async () => {
	const db = sqliteD1();
	invalidateRedirectCache();
	assert.equal(await serve(db, "https://example.com/old"), undefined);
	assert.ok(!db.log.some((q) => /CREATE/i.test(q.sql)));
	invalidateRedirectCache();
});

// ── Edge caching (Workers Cache through Astro's route caching) ──

const { serveCachedRedirect, REDIRECT_EDGE_MAX_AGE } = await import("../src/redirects/middleware.ts");
const { REDIRECTS_TAG, purgeScope, purgePageCache, purgesAfter, registerReadOnlyRoutes, isRedirectSave, redirectPagesScope } = await import("../src/pageCache/lib.ts");
const { redirectsMiddleware } = await import("../src/redirects/pack.ts");

/** Astro's per-request cache, recording what's set. */
function routeCache(enabled = true) {
	const calls = [];
	return { enabled, calls, set: (options) => calls.push(options) };
}

async function serveWith(db, href, { method = "GET", cache = routeCache() } = {}) {
	const hits = [];
	const context = { url: new URL(href), request: new Request(href, { method }), cache };
	const res = await serveCachedRedirect(context, { DB: db }, (p) => hits.push(p));
	await Promise.all(hits);
	return { res, cache };
}

test("GET and HEAD redirects go in the edge cache, tagged; browsers keep them an hour", async () => {
	const db = await seeded();
	for (const method of ["GET", "HEAD"]) {
		const { res, cache } = await serveWith(db, "https://example.com/old?x=1", { method });
		assert.equal(res.status, 301);
		// Site-relative: the edge cache is shared by every hostname the Worker answers.
		assert.equal(res.headers.get("Location"), "/new?x=1");
		assert.equal(res.headers.get("Cache-Control"), "max-age=3600");
		// Any lifetime a site route rule gave the request is dropped first.
		assert.deepEqual(cache.calls, [false, { maxAge: REDIRECT_EDGE_MAX_AGE, tags: [REDIRECTS_TAG] }]);
	}
	const gone = await serveWith(db, "https://example.com/gone");
	assert.equal(gone.res.status, 410);
	assert.equal(gone.res.headers.get("Cache-Control"), "max-age=3600");
	assert.equal(gone.cache.calls.length, 2);
	const pattern = await serveWith(db, "https://example.com/a/42");
	assert.equal(pattern.res.headers.get("Location"), "/later-pattern");
	assert.ok(redirectsMiddleware.ownsCache, "the pack middleware leaves the redirect's caching alone");
	invalidateRedirectCache();
});

test("other methods, no route caching, and pages are never edge-cached by redirects", async () => {
	const db = await seeded();
	const post = await serveWith(db, "https://example.com/old", { method: "POST" });
	assert.equal(post.res.status, 301);
	assert.equal(post.res.headers.get("Cache-Control"), "private, max-age=3600");
	assert.equal(post.res.headers.get("Location"), "https://example.com/new");
	assert.deepEqual(post.cache.calls, []);
	const off = await serveWith(db, "https://example.com/old", { cache: routeCache(false) });
	assert.equal(off.res.headers.get("Cache-Control"), "private, max-age=3600");
	assert.deepEqual(off.cache.calls, []);
	const page = await serveWith(db, "https://example.com/not-redirected");
	assert.equal(page.res, undefined);
	assert.deepEqual(page.cache.calls, [], "a page keeps the site's route caching");
	const admin = await serveWith(db, "https://example.com/_emdash/api/plugins/coywolf-pack/redirects/list");
	assert.equal(admin.res, undefined);
	assert.deepEqual(admin.cache.calls, []);
	invalidateRedirectCache();
});

test("redirect changes purge the redirects tag; lookups purge nothing", async () => {
	const API = "/_emdash/api/plugins/coywolf-pack/";
	for (const route of ["redirects/save", "redirects/delete", "redirects/import", "redirects/removed/resolve", "backups/rewind", "backups/undo"]) {
		assert.deepEqual(purgeScope(API + route), { tags: [REDIRECTS_TAG] }, route);
	}
	for (const route of ["redirects/list", "redirects/test", "redirects/removed", "backups/run"]) assert.equal(purgeScope(API + route), null, route);
	for (const route of ["videos/status", "videos/settings", "videos/webhook/subscribe"]) assert.equal(purgeScope(API + route), null, route);
	// The videos admin reads (list, detail, storage, captions list…) are read-only routes: purgesAfter is false for them once
	// createPlugin has registered them (src/pageCache/lib.test.mjs), so purgeScope is never asked.
	registerReadOnlyRoutes(["videos/list", "videos/detail", "videos/storage", "videos/captions/list"]);
	for (const route of ["videos/list", "videos/detail", "videos/storage", "videos/captions/list"]) assert.equal(purgesAfter("POST", API + route), false, route);
	for (const route of ["videos/settings/save", "videos/update", "videos/delete"]) assert.deepEqual(purgeScope(API + route), { purgeEverything: true }, route);
	const purged = [];
	globalThis.__purge = (options) => (purged.push(options), Promise.resolve({ success: true }));
	assert.equal(await purgePageCache(purgeScope(API + "redirects/save")), true);
	assert.deepEqual(purged, [{ tags: ["coywolf-redirects"] }]);
});

test("the purge's RPC result is disposed of, whether the purge succeeded or was refused", async () => {
	let disposed = 0;
	const result = (fields) => ({ ...fields, [Symbol.dispose]: () => disposed++ });
	globalThis.__purge = () => Promise.resolve(result({ success: true }));
	assert.equal(await purgePageCache(), true);
	assert.equal(disposed, 1);
	const logged = console.error;
	console.error = () => {};
	try {
		globalThis.__purge = () => Promise.resolve(result({ success: false, errors: [{ message: "rate limited" }] }));
		assert.equal(await purgePageCache(), false);
	} finally {
		console.error = logged;
	}
	assert.equal(disposed, 2);
	// Results without a disposer (or none at all) are fine.
	globalThis.__purge = () => Promise.resolve({ success: true });
	assert.equal(await purgePageCache(), true);
	globalThis.__purge = () => Promise.resolve(undefined);
	assert.equal(await purgePageCache(), true);
});

test("a redirect save also clears the pages cached at its new sources", () => {
	const API = "/_emdash/api/plugins/coywolf-pack/";
	assert.ok(isRedirectSave(API + "redirects/save"));
	assert.ok(isRedirectSave(API + "redirects/import"));
	for (const route of ["redirects/delete", "redirects/list", "redirects/test", "redirects/removed", "robots/save"]) assert.ok(!isRedirectSave(API + route), route);

	// Exact sources clear by prefix, without the trailing slash or query, so both forms go.
	assert.deepEqual(redirectPagesScope({ source: "/old-post/", target: "/new-post/" }), { pathPrefixes: ["/old-post"] });
	assert.deepEqual(redirectPagesScope({ source: "/a?x=1", target: "/b" }), { pathPrefixes: ["/a"] });
	assert.deepEqual(redirectPagesScope({ rules: [{ source: "/a", target: "/b" }, { source: "/c/", target: "/d" }, { source: "/a/", target: "/e" }] }), { pathPrefixes: ["/a", "/c"] });
	// Disabled rules serve nothing, so no page needs clearing.
	assert.equal(redirectPagesScope({ source: "/a", target: "/b", enabled: false }), null);
	// A pattern, the home page, or more sources than one purge takes: everything.
	assert.deepEqual(redirectPagesScope({ source: "^/2019/(.*)$", target: "/archive/$1", isRegex: true }), { purgeEverything: true });
	assert.deepEqual(redirectPagesScope({ source: "/", target: "/home" }), { purgeEverything: true });
	assert.deepEqual(redirectPagesScope({ rules: Array.from({ length: 31 }, (_, i) => ({ source: `/p${i}`, target: "/x" })) }), { purgeEverything: true });
	// Unreadable bodies clear nothing beyond the redirects' own tag.
	for (const body of [null, "x", {}, { rules: [] }, { source: 5 }]) assert.equal(redirectPagesScope(body), null);
});

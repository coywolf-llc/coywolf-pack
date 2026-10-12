// Run: node --test test/read-failures.test.mjs
// A page rendered after one of the pack's reads failed (the pack then fails closed: features
// at their defaults, settings unset, redirect and robots.txt rules absent, a module's page metadata missing)
// isn't edge-cached, so it isn't served for the Page cache lifetime (days). Covers the
// failure count (src/core/read-failures.ts), the reads that note it, and the pack middleware
// end to end with Astro's own route cache.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => { globalThis.__waitUntil?.push(p); };`,
				shortCircuit: true,
			};
		}
		// The middleware's module list pulls in every module (some need a bundler); tests pass their own handlers.
		if (specifier === "./modules.js" && context.parentURL?.endsWith("/src/middleware.ts")) {
			return { url: "data:text/javascript,export const MIDDLEWARE = [];", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const { readFailures } = await import("../src/core/read-failures.ts");
const features = await import("../src/core/features.ts");
const { coywolfPack } = await import("../src/middleware.ts");
const { serveRedirect, invalidateRedirectCache } = await import("../src/redirects/middleware.ts");
const { serveRobots } = await import("../src/robots/middleware.ts");
const { composeHooks } = await import("../src/core/compose.ts");
const { LIFETIME_DEFAULTS } = await import("../src/pageCache/pack.ts");
const { AstroCache, applyCacheHeaders, isCacheActive } = await import(new URL("../node_modules/astro/dist/core/cache/runtime/cache.js", import.meta.url).href);

/** A D1 stand-in over node:sqlite; `broken` makes every read fail the way D1 does during a blip. */
function d1() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT DEFAULT '0' NOT NULL);");
	const state = { broken: false, sqlite: db };
	const blip = () => {
		if (state.broken) throw new Error("D1_ERROR: Network connection lost.");
	};
	const exec = (sql, params) => {
		blip();
		const st = db.prepare(sql);
		return /^\s*(select|with)/i.test(sql) ? { results: st.all(...params) } : { results: [], meta: { changes: Number(st.run(...params).changes) } };
	};
	const statement = (sql, params = []) => ({
		sql,
		params,
		bind: (...p) => statement(sql, p),
		all: async () => exec(sql, params),
		first: async () => exec(sql, params).results[0] ?? null,
		run: async () => exec(sql, params),
	});
	return Object.assign(state, {
		prepare: (sql) => statement(sql),
		batch: async (statements) => statements.map((s) => exec(s.sql, s.params)),
	});
}

/** A fresh isolate's view of the switches (nothing cached), with `db` as the site database. */
function freshIsolate(db) {
	globalThis.__testEnv = { DB: db };
	globalThis.__waitUntil = [];
	features.invalidateFeatures();
	invalidateRedirectCache();
}

/** Astro's route cache as a "/[...path]" route rule leaves it: cacheable, with the rule's lifetime. */
function routeCache(maxAge = 3600) {
	const cache = new AstroCache({ setHeaders: (o) => new Headers({ "Cloudflare-CDN-Cache-Control": o.maxAge === undefined ? "public" : `public, max-age=${o.maxAge}` }) });
	cache.set({ maxAge });
	return cache;
}
const cdnHeader = (cache) => {
	const response = new Response(null);
	applyCacheHeaders(cache, response, new Request("https://example.com/"));
	return response.headers.get("Cloudflare-CDN-Cache-Control");
};

function context(path, cache, method = "GET") {
	const url = new URL(`https://example.com${path}`);
	return { url, request: new Request(url, { method }), cache, locals: {}, site: undefined };
}

/** next(): a streamed HTML page; `render` runs while the body streams (a component deep in the page). */
const page = (render) => async () =>
	new Response(
		new ReadableStream({
			async pull(controller) {
				await new Promise((r) => setTimeout(r, 0));
				await render?.();
				controller.enqueue(new TextEncoder().encode("<html><main>page</main></html>"));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);

const FULL_LIFETIME = `public, max-age=${LIFETIME_DEFAULTS.maxAgeDays * 86400}`;

// ── The middleware, end to end ───────────────────────────────────

test("the switches can't be read: the page renders with the features at their defaults (mostly off) and isn't edge-cached", async () => {
	const db = d1();
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify({ reviews: true }));
	features.registerFeatures([{ id: "reviews", default: false }]);
	freshIsolate(db);
	db.broken = true;
	let ran = false;
	const handlers = [{ module: "reviews", feature: "reviews", handle: () => ((ran = true), undefined) }];
	const cache = routeCache();
	const out = await coywolfPack({}, handlers)(context("/post/", cache), page());
	assert.equal(ran, false, "failed closed: Reviews (stored on) read as its default, off");
	assert.equal(await out.text(), "<html><main>page</main></html>", "the visitor still gets the page");
	assert.equal(isCacheActive(cache), false);
	assert.equal(cdnHeader(cache), null, "no edge lifetime (the adapter sends no-store)");
	await Promise.allSettled(globalThis.__waitUntil);
});

test("the next request after the blip reads again and is cached with the Page cache lifetime", async () => {
	const db = d1();
	freshIsolate(db);
	db.broken = true;
	await coywolfPack({}, [])(context("/a/", routeCache()), page());
	db.broken = false;
	const cache = routeCache();
	const before = readFailures();
	await (await coywolfPack({}, [])(context("/a/", cache), page())).text();
	assert.equal(readFailures(), before, "a failed read isn't remembered as the answer");
	assert.equal(cdnHeader(cache), FULL_LIFETIME);
	await Promise.allSettled(globalThis.__waitUntil);
});

test("a read that fails while the body streams is caught too, after any cache.set() the page makes", async () => {
	const db = d1();
	freshIsolate(db);
	const cache = routeCache();
	const out = await coywolfPack({}, [])(
		context("/b/", cache),
		page(async () => {
			// A block renderer reads a setting this isolate hasn't read yet (a fresh read), while D1 blips,
			// then the layout adds its menu tag (cache.set turns caching back on after a set(false)).
			db.broken = true;
			assert.equal(await features.siteSetting("someBlockSetting"), null, "read as unset");
			cache.set({ tags: ["emdash:menu:primary"] });
		}),
	);
	assert.equal(await out.text(), "<html><main>page</main></html>");
	assert.equal(isCacheActive(cache), false);
	await Promise.allSettled(globalThis.__waitUntil);
});

test("concurrent requests waiting for the same failed read are all kept out of the cache", async () => {
	const db = d1();
	freshIsolate(db);
	db.broken = true;
	const caches = [routeCache(), routeCache(), routeCache()];
	const responses = await Promise.all(caches.map((cache, i) => coywolfPack({}, [])(context(`/c${i}/`, cache), page())));
	await Promise.all(responses.map((r) => r.text()));
	assert.deepEqual(
		caches.map((c) => isCacheActive(c)),
		[false, false, false],
	);
	await Promise.allSettled(globalThis.__waitUntil);
});

test("a module handler that throws: the page the request falls through to isn't cached", async () => {
	const db = d1();
	freshIsolate(db);
	await features.siteFeatures(); // A healthy read: the switches are cached.
	const handlers = [
		{
			module: "robots",
			feature: "*",
			handle: () => {
				throw new Error("D1_ERROR: Network connection lost.");
			},
		},
	];
	const cache = routeCache();
	await (await coywolfPack({}, handlers)(context("/robots.txt", cache), async () => new Response("User-agent: *\n", { headers: { "content-type": "text/plain" } }))).text();
	assert.equal(isCacheActive(cache), false, "EmDash's own robots.txt isn't kept for days");
	await Promise.allSettled(globalThis.__waitUntil);
});

test("healthy reads: pages keep the Page cache lifetime, and nothing is counted as a failure", async () => {
	const db = d1();
	freshIsolate(db);
	const before = readFailures();
	for (const path of ["/d/", "/e/"]) {
		const cache = routeCache();
		const out = await coywolfPack({}, [])(context(path, cache), page(() => features.siteSetting("headings")));
		assert.equal(await out.text(), "<html><main>page</main></html>");
		assert.equal(cdnHeader(cache), FULL_LIFETIME, path);
	}
	// A HEAD, a JSON endpoint and a 404 the site turned off go through untouched.
	const head = routeCache();
	await coywolfPack({}, [])(context("/d/", head, "HEAD"), async () => new Response(null, { headers: { "content-type": "text/html" } }));
	assert.equal(cdnHeader(head), "public, max-age=3600", "the route rule's own lifetime (the pack sets GET's)");
	const json = routeCache();
	const body = new Response("{}", { headers: { "content-type": "application/json" } });
	assert.equal(await coywolfPack({}, [])(context("/feed.json", json), async () => body), body, "not read in full");
	const missing = routeCache();
	await coywolfPack({}, [])(context("/gone/", missing), async () => {
		missing.set(false);
		return new Response("gone", { status: 404, headers: { "content-type": "text/html" } });
	});
	assert.equal(isCacheActive(missing), false);
	assert.equal(readFailures(), before);
	await Promise.allSettled(globalThis.__waitUntil);
});

// ── The reads that note a failure ────────────────────────────────

test("siteFeatures and siteSetting: a failed read counts once per caller; a cached or missing value doesn't count", async () => {
	const db = d1();
	freshIsolate(db);
	db.broken = true;
	let before = readFailures();
	features.registerFeatures([{ id: "robots", default: false }]);
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify({ robots: true }));
	const [a, b] = await Promise.all([features.siteFeatures(), features.siteFeatures()]);
	assert.equal(a.robots, false, "fails closed: the default (off), not the stored choice");
	assert.equal(b.robots, false);
	assert.equal(readFailures(), before + 2, "both callers were handed the one failed read");
	before = readFailures();
	assert.equal(await features.siteSetting("headings"), null);
	assert.equal(await features.readSiteSetting("headings"), null, "can't be read (not { value: null })");
	assert.equal(readFailures(), before + 2);

	db.broken = false;
	before = readFailures();
	await features.siteFeatures();
	assert.deepEqual(await features.readSiteSetting("headings"), { value: null }, "unset is not a failure");
	await features.siteFeatures();
	assert.equal(readFailures(), before);
});

test("ctxFeatures (page hooks): a failed settings read is noted and still thrown", async () => {
	features.registerFeatures([{ id: "schema", default: false }]);
	const before = readFailures();
	const ctx = {
		settings: {
			get: async () => {
				throw new Error("D1_ERROR: Network connection lost.");
			},
		},
	};
	await assert.rejects(features.ctxFeatures(ctx), /Network connection lost/);
	assert.equal(readFailures(), before + 1);
	const ok = await features.ctxFeatures({ settings: { get: async () => ({ schema: true }) } });
	assert.equal(ok.schema, true);
	assert.equal(readFailures(), before + 1);
});

test("redirects: rules that can't be loaded are noted; a site with no redirects table isn't a failure", async () => {
	const db = d1();
	freshIsolate(db);
	let before = readFailures();
	assert.equal(await serveRedirect(new URL("https://example.com/old"), { DB: db }, () => {}), undefined);
	assert.equal(readFailures(), before, "no table yet means no rules");
	invalidateRedirectCache();
	db.broken = true;
	before = readFailures();
	assert.equal(await serveRedirect(new URL("https://example.com/old2"), { DB: db }, () => {}), undefined);
	assert.equal(readFailures(), before + 1);
	invalidateRedirectCache();
});

test("robots.txt: rules that can't be loaded are noted (EmDash's own file answers instead)", async () => {
	const db = d1();
	freshIsolate(db);
	db.broken = true;
	const before = readFailures();
	assert.equal(await serveRobots(new URL("https://example.com/robots.txt"), "GET", { DB: db }), undefined);
	assert.ok(readFailures() > before);
});

test("page hooks: a module whose page:metadata fails is noted; the others' metadata still comes back", async () => {
	const modules = [
		{ id: "schema", features: [{ id: "schema", default: true }], hooks: { "page:metadata": async () => { throw new Error("D1_ERROR: Network connection lost."); } } },
		{ id: "videos", features: [{ id: "videos", default: true }], hooks: { "page:metadata": async () => [{ kind: "meta", name: "x", content: "1" }] } },
	];
	features.registerFeatures(modules.flatMap((m) => m.features));
	const { hooks } = composeHooks(modules, { tasks: [] });
	const ctx = { settings: { get: async () => ({ schema: true, videos: true }) }, log: { error() {}, info() {}, warn() {} } };
	features.invalidateFeatures();
	const before = readFailures();
	const out = await hooks["page:metadata"]({}, ctx);
	assert.deepEqual(out, [{ kind: "meta", name: "x", content: "1" }]);
	assert.equal(readFailures(), before + 1);
});

test("page hooks: one still running just before EmDash's 5 s timeout is noted (EmDash drops its part)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let finish;
	const modules = [{ id: "slow", features: [{ id: "slow", default: true }], hooks: { "page:metadata": () => new Promise((r) => (finish = r)) } }];
	features.registerFeatures(modules.flatMap((m) => m.features));
	const { hooks } = composeHooks(modules, { tasks: [] });
	const ctx = { settings: { get: async () => ({ slow: true }) }, log: { error() {}, info() {}, warn() {} } };
	features.invalidateFeatures();
	const before = readFailures();
	const running = hooks["page:metadata"]({}, ctx);
	await new Promise((r) => setImmediate(r));
	t.mock.timers.tick(4_499);
	assert.equal(readFailures(), before);
	t.mock.timers.tick(1);
	assert.equal(readFailures(), before + 1);
	finish([]);
	await running;
	// A hook that finishes in time leaves nothing behind.
	const quick = composeHooks([{ ...modules[0], hooks: { "page:metadata": async () => [] } }], { tasks: [] }).hooks;
	await quick["page:metadata"]({}, ctx);
	t.mock.timers.tick(10_000);
	assert.equal(readFailures(), before + 1);
});

test("discovery files: a server error isn't kept as the answer for a minute; a 404 still is", async () => {
	const { llmsMiddleware } = await import("../src/discovery/middleware.ts");
	const calls = [];
	let answer = { success: false, status: 500 };
	const ctx = (path) => ({
		url: new URL(`https://example.com${path}`),
		request: new Request(`https://example.com${path}`),
		locals: { emdash: { handlePublicPluginApiRoute: async (...args) => (calls.push(args[2]), answer) } },
	});
	const before = readFailures();
	assert.equal(await llmsMiddleware.handle(ctx("/llms.txt")), undefined);
	assert.equal(readFailures(), before + 1);
	answer = { success: true, status: 200, data: { body: "# Site" } };
	const res = await llmsMiddleware.handle(ctx("/llms.txt"));
	assert.equal(await res.text(), "# Site", "asked again after the error");
	answer = { success: false, status: 404 };
	await llmsMiddleware.handle(ctx("/a/index.html.md"));
	await llmsMiddleware.handle(ctx("/a/index.html.md"));
	assert.equal(calls.filter((c) => c === "discovery/public/markdown").length, 1, "a 404 is remembered");
	assert.equal(readFailures(), before + 1, "and isn't a failure");
});

test("reviews: entry data that couldn't be read isn't remembered as \"no reviews\"", async () => {
	const { pageReviews } = await import("../src/reviews/schema.ts");
	const { noteReadFailure } = await import("../src/core/read-failures.ts");
	const page = { content: { collection: "posts", id: "r1" }, articleMeta: { modifiedTime: "2026-10-01" } };
	// readEntryDocs' plugin-context fallback answers null for data it couldn't read, and notes it.
	const failed = await pageReviews({}, page, async () => (noteReadFailure(), null));
	assert.deepEqual(failed, []);
	const data = { content: [{ _type: "coywolf-review", _key: "a", itemName: "A", rating: "4" }] };
	const read = await pageReviews({}, page, async () => data);
	assert.equal(read.length, 1, "read again, not the remembered empty list");
	assert.equal((await pageReviews({}, page, async () => assert.fail("read again"))).length, 1, "a good read is remembered");
});

test("entry docs: the plugin-context fallback notes entry data it couldn't read", async () => {
	const { readEntryDocs } = await import("../src/core/entry-docs.ts");
	globalThis.__testEnv = {};
	const before = readFailures();
	const ctx = {
		log: { warn() {} },
		storage: { schemaEntries: { get: async () => ({ a: 1 }) } },
		content: {
			get: async () => {
				throw new Error("D1_ERROR: Network connection lost.");
			},
		},
	};
	const out = await readEntryDocs(ctx, { collection: "posts", id: "x1", collections: ["schemaEntries"], data: true });
	assert.equal(out.data, null);
	assert.deepEqual(out.docs.get("schemaEntries"), { a: 1 });
	assert.equal(readFailures(), before + 1);
	delete globalThis.__testEnv;
});

// Unit tests for page cache purge rules.
// Run: node --test src/pageCache/lib.test.mjs   (Node 22.6+ strips the types from lib.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

const { purgesAfter, watchInvalidation } = await import("./lib.ts");
const api = "/_emdash/api/plugins/coywolf-pack/";

test("admin writes to pack routes purge the page cache", () => {
	for (const route of ["schema/site/save", "redirects/import", "features/save", "robots/save", "videos/settings/save", "videos/webhook/subscribe", "backups/run", "files/delete"]) {
		assert.equal(purgesAfter("POST", api + route), true, route);
	}
});

test("uploads and changes to one video aren't settings saves: no purge, no settings generation", () => {
	// Each upload piece used to clear every page (a 500 MB video: about 100 full purges). A new upload is on
	// no page yet; a change to one video clears only the pages that embed it, in its route (clearVideoPages).
	for (const route of [
		"videos/upload",
		"videos/upload-chunk",
		"videos/update",
		"videos/delete",
		"videos/captions/upload",
		"videos/captions/generate",
		"videos/captions/delete",
		"videos/captions/refresh",
		"files/upload-start",
		"files/upload-part",
		"files/upload-complete",
		"files/upload-abort",
	]) {
		assert.equal(purgesAfter("POST", api + route), false, route);
	}
	// Neighbors that do change pages still purge.
	for (const route of ["videos/settings/save", "videos/reindex", "files/delete", "files/settings/save", "videos/uploads"]) assert.equal(purgesAfter("POST", api + route), true, route);
});

test("changes to one video clear the pages that embed it, from their routes", () => {
	const src = readFileSync(new URL("../videos/module.ts", import.meta.url), "utf8");
	for (const route of ["videos/update", "videos/delete", "videos/captions/upload", "videos/captions/delete", "videos/captions/refresh"]) {
		const at = src.indexOf(`"${route}":`);
		assert.ok(at > 0, route);
		const body = src.slice(at, src.indexOf("\n\t\t}),", at));
		assert.match(body, /clearVideoPages\(ctx, (input\.)?uid\)/, route);
	}
});

test("public pack routes, the Stream webhook, reads, and other plugins don't", () => {
	// The webhook clears only the pages that show its video (src/videos/module.ts): not everything, no settings generation, no re-warm.
	for (const route of ["search/live", "search/index", "discovery/public/llms", "videos/like", "videos/play", "videos/caption", "videos/embed", "videos/sitemap", "videos/webhook"]) {
		assert.equal(purgesAfter("POST", api + route), false, route);
	}
	assert.equal(purgesAfter("GET", api + "schema/config"), false);
	assert.equal(purgesAfter("POST", "/_emdash/api/plugins/emdash-forms/submit"), false);
	assert.equal(purgesAfter("POST", "/_emdash/api/content/posts"), false, "EmDash purges its own content by tag");
});

test("no public pack route (anyone can call it: a webhook, a visitor) counts as an admin save that purges everything", async () => {
	const { readFileSync, readdirSync, statSync } = await import("node:fs");
	const { join } = await import("node:path");
	const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") && !f.endsWith(".test.ts") ? [join(dir, f)] : []));
	const routes = [];
	for (const file of files("src")) {
		const src = readFileSync(file, "utf8");
		// "name": definePluginRoute({ public: true, …  or  "name": { public: true, …
		for (const m of src.matchAll(/"([a-z][\w/-]*)":\s*(?:definePluginRoute\()?\{\s*public:\s*true/g)) routes.push(m[1]);
	}
	// 13 since 0.35.18 removed the IndexNow key file route.
	assert.ok(routes.length >= 13, `found ${routes.length} public routes`);
	assert.ok(routes.includes("videos/webhook"));
	for (const route of routes) assert.equal(purgesAfter("POST", api + route), false, route);
});

const { applyPageLifetime } = await import("./lib.ts");

function routeCache(maxAge) {
	return {
		enabled: true,
		options: maxAge === undefined ? {} : { maxAge },
		sets: [],
		set(o) {
			this.sets.push(o);
		},
	};
}

test("page lifetimes apply only to routes the site made cacheable", () => {
	const page = routeCache(3600);
	assert.equal(applyPageLifetime(page, 7, 1), true);
	assert.deepEqual(page.sets, [{ maxAge: 604800, swr: 86400 }]);

	const uncached = routeCache(undefined);
	assert.equal(applyPageLifetime(uncached, 7, 1), false, "never turns caching on");
	assert.deepEqual(uncached.sets, []);
	assert.equal(applyPageLifetime(undefined, 7, 1), false);
	assert.equal(applyPageLifetime({ ...routeCache(60), enabled: false }, 7, 1), false);
});

const { settlePage, STOPGAP_LIFETIME } = await import("./lib.ts");

const html = (body = "<p>hi</p>", init = {}) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });
/** settlePage with no failed read: the stopgap checks alone. */
const shortenStopgapPage = (cache, response, stopgap, markHeader) => settlePage(cache, response, { failed: () => false, stopgap, markHeader });

test("a page rendered with a stopgap poster is cached for minutes, decided after its body has rendered", async () => {
	const page = routeCache(604800);
	let rendered = false;
	// The flag is set while the body streams (a component deep in the page), not before next() returns.
	const stream = new ReadableStream({
		async pull(controller) {
			await new Promise((r) => setTimeout(r, 0));
			rendered = true;
			controller.enqueue(new TextEncoder().encode("<video>"));
			controller.close();
		},
	});
	const out = await shortenStopgapPage(page, html(stream, { headers: { "content-type": "text/html", "x-keep": "1" } }), () => rendered);
	assert.deepEqual(page.sets, [{ maxAge: STOPGAP_LIFETIME.maxAge, swr: STOPGAP_LIFETIME.swr }]);
	assert.equal(await out.text(), "<video>");
	assert.equal(out.headers.get("x-keep"), "1");
	assert.equal(out.status, 200);
});

test("pages without a stopgap, uncached routes and non-HTML responses keep their lifetime", async () => {
	const page = routeCache(604800);
	assert.equal(await (await shortenStopgapPage(page, html(), () => false)).text(), "<p>hi</p>");
	assert.deepEqual(page.sets, []);

	const untouched = html();
	assert.equal(await shortenStopgapPage(routeCache(undefined), untouched, () => assert.fail("asked")), untouched);
	assert.equal(await shortenStopgapPage(undefined, untouched, () => assert.fail("asked")), untouched);

	const json = new Response("{}", { headers: { "content-type": "application/json" } });
	assert.equal(await shortenStopgapPage(routeCache(60), json, () => assert.fail("asked")), json);
	const missing = html("gone", { status: 404 });
	assert.equal(await shortenStopgapPage(routeCache(60), missing, () => assert.fail("asked")), missing);

	const short = routeCache(120);
	await shortenStopgapPage(short, html(), () => true);
	assert.deepEqual(short.sets, [{ maxAge: 120, swr: STOPGAP_LIFETIME.swr }], "never lengthens a shorter lifetime");
});

test("the cache warmer's stopgap render isn't cached and is marked for a revisit; visitors' renders aren't marked", async () => {
	const warmer = routeCache(604800);
	const marked = await shortenStopgapPage(warmer, html("<video>", { headers: { "content-type": "text/html", "x-keep": "1" } }), () => true, "X-Coywolf-Stopgap");
	assert.deepEqual(warmer.sets, [false], "not cached, so the mark never reaches visitors and the revisit renders afresh");
	assert.equal(marked.headers.get("x-coywolf-stopgap"), "1");
	assert.equal(marked.headers.get("x-keep"), "1");
	assert.equal(await marked.text(), "<video>");

	const visitor = routeCache(604800);
	const plain = await shortenStopgapPage(visitor, html(), () => true);
	assert.equal(plain.headers.get("x-coywolf-stopgap"), null);
	assert.deepEqual(visitor.sets, [{ maxAge: STOPGAP_LIFETIME.maxAge, swr: STOPGAP_LIFETIME.swr }]);

	const fine = routeCache(604800);
	const clean = await shortenStopgapPage(fine, html(), () => false, "X-Coywolf-Stopgap");
	assert.equal(clean.headers.get("x-coywolf-stopgap"), null, "the warmer's normal renders aren't marked");
	assert.deepEqual(fine.sets, []);
});

test("watchInvalidation notices EmDash clearing pages by tag, and only a successful clear", async () => {
	const calls = [];
	const cache = {
		async invalidate(options) {
			calls.push(options);
			if (options.tags.includes("boom")) throw new Error("purge failed");
		},
	};
	const invalidated = watchInvalidation(cache);
	assert.equal(invalidated(), false, "a draft save that clears nothing");
	await assert.rejects(cache.invalidate({ tags: ["boom"] }));
	assert.equal(invalidated(), false);
	await cache.invalidate({ tags: ["posts", "01ABC"] });
	assert.equal(invalidated(), true);
	assert.deepEqual(calls.at(-1), { tags: ["posts", "01ABC"] }, "the route's call still reaches the cache");
	assert.equal(watchInvalidation(undefined)(), false, "no route cache");
	assert.equal(watchInvalidation({})(), false);
});

// ── After a failed read (src/core/read-failures.ts) ─────────────

// Astro's own route cache (what context.cache is in production), so set(false) and a later
// set() behave as they really do: a later set() turns caching back on.
const { AstroCache, applyCacheHeaders, isCacheActive } = await import(new URL("../../node_modules/astro/dist/core/cache/runtime/cache.js", import.meta.url).href);
const PROVIDER = { setHeaders: (options) => new Headers({ "Cloudflare-CDN-Cache-Control": options.maxAge === undefined ? "public" : `public, max-age=${options.maxAge}` }) };
function astroCache(maxAge = 604800) {
	const cache = new AstroCache(PROVIDER);
	cache.set({ maxAge, swr: 86400 });
	return cache;
}
/** The CDN header Astro would send for this cache state. */
const cdnHeader = (cache) => {
	const response = new Response(null);
	applyCacheHeaders(cache, response, new Request("https://example.com/"));
	return response.headers.get("Cloudflare-CDN-Cache-Control");
};

test("Astro's cache: a set() after set(false) turns caching back on (why settlePage decides last)", () => {
	const cache = astroCache();
	cache.set(false);
	assert.equal(isCacheActive(cache), false);
	cache.set({ tags: ["emdash:menu:primary"] });
	assert.equal(isCacheActive(cache), true);
	assert.equal(cdnHeader(cache), "public");
});

test("a page whose render saw a failed read isn't cached, decided after its body (a component's late cache.set can't undo it)", async () => {
	const cache = astroCache();
	let failed = false;
	// The layout renders while the body streams: a settings read fails, then the menu adds its cache tag.
	const stream = new ReadableStream({
		async pull(controller) {
			await new Promise((r) => setTimeout(r, 0));
			failed = true;
			cache.set({ tags: ["emdash:menu:primary"] });
			controller.enqueue(new TextEncoder().encode("<main></main>"));
			controller.close();
		},
	});
	const out = await settlePage(cache, html(stream, { headers: { "content-type": "text/html", "x-keep": "1" } }), { failed: () => failed, label: "GET /a/" });
	assert.equal(isCacheActive(cache), false);
	assert.equal(cdnHeader(cache), null, "no Cloudflare-CDN-Cache-Control: the adapter sends no-store");
	assert.equal(await out.text(), "<main></main>", "the visitor still gets the page");
	assert.equal(out.headers.get("x-keep"), "1");
	assert.equal(out.status, 200);
});

test("a page going to the edge cache loses this render's Server-Timing; one kept out of it keeps it", async () => {
	const timed = () => html("<p>hi</p>", { headers: { "content-type": "text/html", "server-timing": 'cw;dur=12', "x-keep": "1" } });
	const cached = await settlePage(astroCache(), timed(), { failed: () => false });
	assert.equal(cached.headers.get("server-timing"), null);
	assert.equal(cached.headers.get("x-keep"), "1");
	const failed = await settlePage(astroCache(), timed(), { failed: () => true });
	assert.equal(failed.headers.get("server-timing"), "cw;dur=12", "not cached, so the visitor's own timings stay");
});

test("a failed read wins over a stopgap; the cache warmer is told to come back", async () => {
	const visitor = astroCache();
	await settlePage(visitor, html(), { failed: () => true, stopgap: () => true });
	assert.equal(isCacheActive(visitor), false, "not cached for minutes either");

	const warmer = astroCache();
	const marked = await settlePage(warmer, html(), { failed: () => true, markHeader: "X-Coywolf-Stopgap" });
	assert.equal(isCacheActive(warmer), false);
	assert.equal(marked.headers.get("x-coywolf-stopgap"), "1", "visited again later (src/pageCache/warm.ts)");
});

test("other responses after a failed read: left out of the cache without reading their body", async () => {
	for (const response of [
		new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } }), // EmDash's robots.txt
		new Response("{}", { headers: { "content-type": "application/json" } }),
		html("<p>later</p>", { status: 503 }),
		new Response(null, { status: 200, headers: { "content-type": "text/html" } }), // HEAD
	]) {
		const cache = astroCache();
		const out = await settlePage(cache, response, { failed: () => true });
		assert.equal(out, response, "returned as is, still streaming");
		assert.equal(response.bodyUsed, false);
		assert.equal(isCacheActive(cache), false, response.headers.get("content-type"));
	}
	// A route that only had cache tags (no lifetime) is still left out.
	const tagged = new AstroCache(PROVIDER);
	tagged.set({ tags: ["posts"] });
	await settlePage(tagged, html(), { failed: () => true });
	assert.equal(isCacheActive(tagged), false);
});

test("no failed read: a cacheable page keeps its lifetime, and an uncached route is never turned on", async () => {
	const cache = astroCache();
	const out = await settlePage(cache, html(), { failed: () => false });
	assert.equal(await out.text(), "<p>hi</p>");
	assert.equal(cdnHeader(cache), "public, max-age=604800");

	const off = astroCache();
	off.set(false); // e.g. a 404 the site turned off
	await settlePage(off, html("gone", { status: 404 }), { failed: () => false });
	assert.equal(isCacheActive(off), false);

	const untouched = html();
	assert.equal(await settlePage(undefined, untouched, { failed: () => assert.fail("asked") }), untouched, "no route cache (dev)");
	assert.equal(await settlePage({ enabled: false, set: () => assert.fail("set") }, untouched, { failed: () => assert.fail("asked") }), untouched);
});

const { registerReadOnlyRoutes, isReadOnlyRoutePath, purgeScope } = await import("./lib.ts");
const { readOnlyRoute, isReadOnlyRoute, readOnlyRouteNames } = await import("../core/routes.ts");

/** Every route declared read-only where it's defined (`"name": readOnlyRoute(definePluginRoute({`). Adding one is a deliberate change: list it here. */
const READ_ONLY_ROUTES = [
	"ai/entries",
	"ai/media",
	"ai/test",
	"backups/download-link",
	"codeBlocks/preview",
	"files/options",
	"images/check",
	"images/setup/plan",
	"links/list",
	"redirects/test",
	"schema/entries/bylines",
	"schema/entries/find",
	"schema/media",
	"schema/preview",
	"videos/captions/list",
	"videos/detail",
	"videos/list",
	"videos/options",
	"videos/status",
	"videos/storage",
	"videos/test",
	"wpImport/urls",
];

function sourceRoutes(marker) {
	const { readFileSync, readdirSync, statSync } = require("node:fs");
	const { join } = require("node:path");
	const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") && !f.endsWith(".test.ts") ? [join(dir, f)] : []));
	const names = [];
	for (const file of files("src")) for (const m of readFileSync(file, "utf8").matchAll(marker)) names.push(m[1]);
	return names.sort();
}

test("the read-only routes are exactly the ones declared with readOnlyRoute, and createPlugin registers them", () => {
	assert.deepEqual(sourceRoutes(/"([a-z][\w/-]*)":\s*readOnlyRoute\(/g), READ_ONLY_ROUTES);
	// Every other POST route is a write (or public): none of them is in the list by accident.
	const writes = ["schema/custom/save", "schema/custom/delete", "schema/entries/save", "schema/entries/delete", "schema/site/save", "features/save", "videos/settings/save", "wpImport/scan", "links/scan", "ai/run", "images/setup/apply"];
	for (const route of writes) assert.ok(!READ_ONLY_ROUTES.includes(route), route);
	const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.ok(index.includes("registerReadOnlyRoutes(readOnlyRouteNames(routes))"), "createPlugin registers the marked routes with the page cache");
});

test("a POST to a read-only route purges nothing and records no settings change; a real save still purges everything", () => {
	// The marker is a WeakSet membership: the route object is unchanged (EmDash sees a plain route definition).
	const route = { permission: "plugins:manage", methods: ["POST"], handler: async () => ({}) };
	const before = JSON.stringify(route);
	assert.equal(readOnlyRoute(route), route);
	assert.equal(JSON.stringify(route), before);
	assert.equal(isReadOnlyRoute(route), true);
	assert.equal(isReadOnlyRoute({ ...route }), false);
	assert.deepEqual(readOnlyRouteNames({ "x/read": route, "x/save": { ...route } }), ["x/read"]);
	// Until registered, a route is a write: the safe default.
	assert.equal(purgesAfter("POST", api + "schema/preview"), true);
	registerReadOnlyRoutes(READ_ONLY_ROUTES);
	for (const name of READ_ONLY_ROUTES) {
		assert.equal(isReadOnlyRoutePath(api + name), true, name);
		assert.equal(purgesAfter("POST", api + name), false, name);
	}
	// purgesAfter false means the middleware runs none of: purge, invalidateFeatures, recordSettingsChange, startWarming (src/middleware.ts).
	assert.equal(isReadOnlyRoutePath("/_emdash/api/plugins/other-plugin/schema/preview"), false);
	for (const route of ["schema/custom/save", "schema/custom/delete", "schema/entries/save", "schema/site/save", "features/save", "videos/settings/save"]) {
		assert.equal(purgesAfter("POST", api + route), true, route);
		assert.deepEqual(purgeScope(api + route), { purgeEverything: true }, route);
	}
	// (Un)subscribing the Stream webhook still changes no page but does record a settings change.
	assert.equal(purgesAfter("POST", api + "videos/webhook/subscribe"), true);
	assert.equal(purgeScope(api + "videos/webhook/subscribe"), null);
});

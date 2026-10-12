// Unit tests for page cache purge rules.
// Run: node --test src/pageCache/lib.test.mjs   (Node 22.6+ strips the types from lib.ts)
import assert from "node:assert/strict";
import { test } from "node:test";

const { purgesAfter, watchInvalidation } = await import("./lib.ts");
const api = "/_emdash/api/plugins/coywolf-pack/";

test("admin writes to pack routes purge the page cache", () => {
	for (const route of ["schema/site/save", "redirects/import", "features/save", "robots/save", "videos/webhook", "videos/update", "backups/run"]) {
		assert.equal(purgesAfter("POST", api + route), true, route);
	}
});

test("public pack routes, reads, and other plugins don't", () => {
	for (const route of ["search/live", "search/index", "discovery/public/llms", "videos/like", "videos/play", "videos/caption", "videos/embed", "videos/sitemap"]) {
		assert.equal(purgesAfter("POST", api + route), false, route);
	}
	assert.equal(purgesAfter("GET", api + "schema/config"), false);
	assert.equal(purgesAfter("POST", "/_emdash/api/plugins/emdash-forms/submit"), false);
	assert.equal(purgesAfter("POST", "/_emdash/api/content/posts"), false, "EmDash purges its own content by tag");
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

// Run: node --test test/tracking-params.test.mjs
//
// Tracking parameters and Workers Cache (src/core/tracking-params.ts, src/worker.ts): which
// parameters go, that everything else is left exactly as it was, and that the Worker wrapper
// serves such a request from the clean URL's cache entry without storing it again.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { TRACKING_HEADER, privateCacheControl, stripTrackingQuery, trackingFreeUrl, trackingWrapperInstalled, withTrackingParams } = await import("../src/core/tracking-params.ts");

test("removes utm_*, click IDs and ref; keeps the other parameters exactly as sent", () => {
	assert.deepEqual(stripTrackingQuery("?utm_source=news&utm_medium=email&p=2&fbclid=abc"), { search: "?p=2", removed: ["utm_source=news", "utm_medium=email", "fbclid=abc"] });
	assert.deepEqual(stripTrackingQuery("gclid=1&msclkid=2&mc_cid=3&mc_eid=4&ref=producthunt&srsltid=5"), { search: "", removed: ["gclid=1", "msclkid=2", "mc_cid=3", "mc_eid=4", "ref=producthunt", "srsltid=5"] });
	// Order and encoding of what's kept don't change (a different spelling would be a different cache entry).
	assert.equal(stripTrackingQuery("?s=a%20b&utm_campaign=x&z=1+2&a").search, "?s=a%20b&z=1+2&a");
	// Names are matched decoded and case-insensitively; similar names stay.
	assert.deepEqual(stripTrackingQuery("?UTM_Source=x&utm%5Fterm=y&utmost=1&refresh=1&reference=2").removed, ["UTM_Source=x", "utm%5Fterm=y"]);
	assert.deepEqual(stripTrackingQuery("?utmost=1"), { search: "?utmost=1", removed: [] });
	// A site's own list.
	assert.deepEqual(stripTrackingQuery("?ref=a&utm_source=b", { params: ["fbclid"] }).removed, ["utm_source=b"]);
	assert.deepEqual(stripTrackingQuery("?ref=a&utm_source=b", { params: ["fbclid"], prefixes: [] }).removed, []);
	assert.deepEqual(stripTrackingQuery("?%E0%A4%A=1&utm_source=b").removed, ["utm_source=b"], "an undecodable name is kept");
});

test("only GET and HEAD page requests, never EmDash's admin, API or Astro's files", () => {
	const url = (path) => new URL(`https://coywolf.com${path}`);
	assert.equal(trackingFreeUrl(url("/?utm_source=x"), "GET").url.href, "https://coywolf.com/");
	assert.equal(trackingFreeUrl(url("/post/?p=1&gclid=2"), "HEAD").url.href, "https://coywolf.com/post/?p=1");
	assert.equal(trackingFreeUrl(url("/?utm_source=x"), "POST"), null);
	assert.equal(trackingFreeUrl(url("/post/"), "GET"), null);
	assert.equal(trackingFreeUrl(url("/post/?p=1"), "GET"), null);
	for (const path of ["/_emdash/admin?utm_source=x", "/_emdash/api/content?ref=1", "/_astro/a.js?ref=1", "/_image?href=x&ref=1"]) assert.equal(trackingFreeUrl(url(path), "GET"), null, path);
});

test("a same-origin redirect gets the parameters back; another site's never does", () => {
	const from = new URL("https://coywolf.com/post?utm_source=x");
	const removed = ["utm_source=x", "fbclid=1"];
	assert.equal(withTrackingParams("/post/", from, removed), "/post/?utm_source=x&fbclid=1");
	assert.equal(withTrackingParams("/post/?a=1#top", from, removed), "/post/?a=1&utm_source=x&fbclid=1#top");
	assert.equal(withTrackingParams("https://coywolf.com/new/", from, removed), "https://coywolf.com/new/?utm_source=x&fbclid=1");
	assert.equal(withTrackingParams("https://partner.example/buy", from, removed), "https://partner.example/buy");
	assert.equal(withTrackingParams("//partner.example/buy", from, removed), "//partner.example/buy");
	assert.equal(withTrackingParams("/post/", from, []), "/post/");
});

test("a relative Location that resolves to a path starting with // comes back absolute, never as another host", () => {
	const from = new URL("https://coywolf.com/post?utm_source=x");
	const removed = ["utm_source=x"];
	for (const location of ["/.//evil.com/", "/a/..//evil.com", "/./\\evil.com", "./..//evil.com/x"]) {
		const out = withTrackingParams(location, from, removed);
		assert.ok(!/^[/\\]{2}/.test(out), `${location} → ${out}`);
		const resolved = new URL(out, from);
		assert.equal(resolved.origin, "https://coywolf.com", `${location} → ${out}`);
		assert.ok(out.startsWith("https://coywolf.com/"), `${location} → ${out}`);
	}
	assert.equal(withTrackingParams("/.//evil.com/", from, removed), "https://coywolf.com//evil.com/?utm_source=x");
	// "/\\evil.com" is another host to a browser: left as the site sent it.
	assert.equal(withTrackingParams("/\\evil.com", from, removed), "/\\evil.com");
});

test("www and the bare domain count as the site; other hosts only when listed", () => {
	const removed = ["utm_source=x"];
	const www = new URL("https://www.coywolf.com/?utm_source=x");
	assert.equal(withTrackingParams("https://coywolf.com/", www, removed), "https://coywolf.com/?utm_source=x");
	const apex = new URL("https://coywolf.com/a?utm_source=x");
	assert.equal(withTrackingParams("https://www.coywolf.com/a/", apex, removed), "https://www.coywolf.com/a/?utm_source=x");
	assert.equal(withTrackingParams("http://coywolf.com/", www, removed), "http://coywolf.com/?utm_source=x");
	assert.equal(withTrackingParams("https://evilcoywolf.com/", www, removed), "https://evilcoywolf.com/");
	assert.equal(withTrackingParams("https://coywolf.com.evil.test/", www, removed), "https://coywolf.com.evil.test/");
	assert.equal(withTrackingParams("https://coywolf.net/", apex, removed), "https://coywolf.net/");
	assert.equal(withTrackingParams("https://coywolf.net/", apex, removed, ["coywolf.net"]), "https://coywolf.net/?utm_source=x");
	assert.equal(withTrackingParams("javascript:alert(1)", apex, removed, ["coywolf.net"]), "javascript:alert(1)");
});

test("keep: a parameter the site's server reads stays", () => {
	assert.deepEqual(stripTrackingQuery("?ref=a&utm_source=b&REF=c", { keep: ["ref"] }), { search: "?ref=a&REF=c", removed: ["utm_source=b"] });
});

test("the answer is kept out of Workers Cache under the tracking URL; browsers' rules otherwise stay", () => {
	assert.equal(privateCacheControl("no-cache"), "private, no-cache");
	assert.equal(privateCacheControl("public, max-age=3600, s-maxage=86400"), "private, max-age=3600");
	assert.equal(privateCacheControl(null), "private");
	assert.equal(privateCacheControl("private, no-store"), "private, no-store");
});

test("the wrapper: tracking URLs are served from the clean URL through the cache, everything else goes straight to the handler", async () => {
	const { stripTrackingParams } = await import("../src/worker.ts");
	const direct = [];
	const looped = [];
	const handler = {
		marker: "kept",
		async fetch(request) {
			direct.push(request.url);
			return new Response("rendered", { headers: { "Cache-Control": "no-cache" } });
		},
		scheduled() {},
	};
	const cached = (request) => {
		looped.push(`${request.method} ${request.url}`);
		const url = new URL(request.url);
		if (url.pathname === "/old") return new Response(null, { status: 301, headers: { Location: "/new/" } });
		if (url.pathname === "/out") return new Response(null, { status: 302, headers: { Location: "https://partner.example/" } });
		return new Response("cached page", { headers: { "Cache-Control": "no-cache", "Cloudflare-CDN-Cache-Control": "public, max-age=604800", "Cache-Tag": "posts" } });
	};
	const ctx = { exports: { default: { fetch: async (request) => cached(request) } } };
	const wrapped = stripTrackingParams(handler);
	assert.equal(wrapped.marker, "kept");
	assert.equal(typeof wrapped.scheduled, "function");
	assert.ok(trackingWrapperInstalled(), "the checkup can tell the wrapper is installed");

	const page = await wrapped.fetch(new Request("https://coywolf.com/?utm_source=news&p=2", { headers: { "user-agent": "test" } }), {}, ctx);
	assert.equal(await page.text(), "cached page");
	assert.deepEqual(looped, ["GET https://coywolf.com/?p=2"]);
	assert.deepEqual(direct, [], "nothing rendered");
	assert.equal(page.headers.get("Cache-Control"), "private, no-cache");
	assert.equal(page.headers.get("Cloudflare-CDN-Cache-Control"), null);
	assert.equal(page.headers.get("Cache-Tag"), null);
	assert.equal(page.headers.get(TRACKING_HEADER), "removed");

	const redirect = await wrapped.fetch(new Request("https://coywolf.com/old?fbclid=abc"), {}, ctx);
	assert.equal(redirect.status, 301);
	assert.equal(redirect.headers.get("Location"), "/new/?fbclid=abc");
	const outbound = await wrapped.fetch(new Request("https://coywolf.com/out?utm_source=x"), {}, ctx);
	assert.equal(outbound.headers.get("Location"), "https://partner.example/");

	// No tracking parameters, another method, or EmDash's API: straight to the handler, untouched.
	looped.length = 0;
	for (const request of [new Request("https://coywolf.com/post/"), new Request("https://coywolf.com/?utm_source=x", { method: "POST", body: "x" }), new Request("https://coywolf.com/_emdash/api/x?ref=1")]) {
		const response = await wrapped.fetch(request, {}, ctx);
		assert.equal(await response.text(), "rendered");
		assert.equal(response.headers.get(TRACKING_HEADER), null);
	}
	assert.deepEqual(looped, []);
	assert.equal(direct.length, 3);
});

test("the wrapper falls back to SELF, then to serving the request as it came", async () => {
	const { stripTrackingParams } = await import("../src/worker.ts");
	const handler = { fetch: async (request) => new Response(`rendered ${new URL(request.url).search}`) };
	const viaSelf = await stripTrackingParams(handler).fetch(new Request("https://x.test/?gclid=1"), { SELF: { fetch: async (r) => new Response(`self ${new URL(r.url).search || "(none)"}`) } }, {});
	assert.equal(await viaSelf.text(), "self (none)");
	const neither = await stripTrackingParams(handler).fetch(new Request("https://x.test/?gclid=1"), {}, {});
	assert.equal(await neither.text(), "rendered ?gclid=1");
	// A loopback that throws, or answers with a server error: served as it came, not an error page.
	const broken = await stripTrackingParams(handler).fetch(new Request("https://x.test/?gclid=1"), { SELF: { fetch: async () => { throw new Error("down"); } } }, {});
	assert.equal(await broken.text(), "rendered ?gclid=1");
	const failing = await stripTrackingParams(handler).fetch(new Request("https://x.test/?gclid=1"), { SELF: { fetch: async () => new Response("oops", { status: 502 }) } }, {});
	assert.equal(await failing.text(), "rendered ?gclid=1");
	assert.equal(failing.headers.get(TRACKING_HEADER), null);
	assert.throws(() => stripTrackingParams({}), /no fetch/);
});

test("the wrapper records what it saw for the checkup: no loopback, an answer, then a HIT, a few writes per isolate at most", async () => {
	const { stripTrackingParams } = await import("../src/worker.ts");
	const { TRACKING_STATE_OPTION } = await import("../src/core/tracking-params.ts");
	const writes = [];
	const db = { prepare: (sql) => ({ bind: (...values) => ({ run: async () => writes.push({ sql, values }) }) }) };
	const waits = [];
	const ctx = { waitUntil: (p) => waits.push(p) };
	const handler = { fetch: async () => new Response("rendered") };
	const record = () => {
		const last = writes.at(-1);
		return last && { name: last.values[0], ...JSON.parse(last.values[1]) };
	};

	const none = stripTrackingParams(handler);
	await none.fetch(new Request("https://x.test/?gclid=1"), { DB: db }, ctx);
	await none.fetch(new Request("https://x.test/?gclid=2"), { DB: db }, ctx);
	await Promise.all(waits);
	assert.equal(writes.length, 1, "once per isolate");
	assert.equal(record().name, TRACKING_STATE_OPTION);
	assert.equal(record().loopback, false);

	writes.length = 0;
	let cacheStatus = "MISS";
	const env = { DB: db, SELF: { fetch: async () => new Response("page", { headers: { "cf-cache-status": cacheStatus } }) } };
	const looped = stripTrackingParams(handler);
	await looped.fetch(new Request("https://x.test/?gclid=1"), env, ctx);
	await looped.fetch(new Request("https://x.test/?gclid=2"), env, ctx);
	await Promise.all(waits);
	assert.equal(writes.length, 1);
	assert.deepEqual([record().loopback, record().cache, record().status], [true, "MISS", 200]);
	cacheStatus = "HIT";
	await looped.fetch(new Request("https://x.test/?gclid=3"), env, ctx);
	cacheStatus = "MISS";
	await looped.fetch(new Request("https://x.test/?gclid=4"), env, ctx);
	await Promise.all(waits);
	assert.equal(writes.length, 2, "a HIT is recorded once; a later MISS says nothing new");
	assert.equal(record().cache, "HIT");
	// Requests without tracking parameters never write.
	await looped.fetch(new Request("https://x.test/plain"), env, ctx);
	assert.equal(writes.length, 2);
});

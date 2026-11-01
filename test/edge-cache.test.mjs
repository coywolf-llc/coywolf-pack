// Run: node --test test/edge-cache.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { keepAtEdge, keepOffEdge, ROBOTS_TAG } = await import("../src/pageCache/lib.ts");
const { strayRobotsMiddleware } = await import("../src/pageCache/pack.ts");

function fakeContext(path, method = "GET", enabled = true) {
	const calls = [];
	return { url: new URL(`https://example.com${path}`), request: new Request(`https://example.com${path}`, { method }), cache: { enabled, set: (o) => calls.push(o) }, calls };
}

test("keepAtEdge replaces the route's lifetime with its own; keepOffEdge turns it off", () => {
	const c = fakeContext("/x");
	keepAtEdge(c, 86400, ["t"]);
	assert.deepEqual(c.calls, [false, { maxAge: 86400, swr: 0, tags: ["t"] }]);
	const off = fakeContext("/x");
	keepOffEdge(off);
	assert.deepEqual(off.calls, [false]);
	const disabled = fakeContext("/x", "GET", false);
	keepAtEdge(disabled, 10);
	assert.deepEqual(disabled.calls, [], "no route caching: nothing set");
});

test("robots.txt below the root: a small 404, kept at the edge for a day", async () => {
	const c = fakeContext("/news/robots.txt");
	const res = await strayRobotsMiddleware.handle(c, {}, () => {});
	assert.equal(res.status, 404);
	assert.match(res.headers.get("content-type"), /text\/plain/);
	assert.equal(res.headers.get("x-robots-tag"), "noindex");
	assert.deepEqual(c.calls, [false, { maxAge: 86400, swr: 0, tags: [ROBOTS_TAG] }]);
	assert.equal(strayRobotsMiddleware.ownsCache, true);
	const head = await strayRobotsMiddleware.handle(fakeContext("/a/b/robots.txt", "HEAD"), {}, () => {});
	assert.equal(head.status, 404);
	assert.equal(await head.text(), "");
});

test("the root robots.txt, other paths and other methods go on", async () => {
	assert.equal(await strayRobotsMiddleware.handle(fakeContext("/robots.txt"), {}, () => {}), undefined);
	assert.equal(await strayRobotsMiddleware.handle(fakeContext("/news/"), {}, () => {}), undefined);
	assert.equal(await strayRobotsMiddleware.handle(fakeContext("/news/robots.txt", "POST"), {}, () => {}), undefined);
	assert.equal(await strayRobotsMiddleware.handle(fakeContext("/news/robots.txt.bak"), {}, () => {}), undefined);
});

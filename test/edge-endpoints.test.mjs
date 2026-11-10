// Run: node --test test/edge-endpoints.test.mjs
// The pack's public files go to the edge cache (Workers Cache) like the RSS feed: llms.txt, the
// Markdown versions, the news sitemap and the video sitemap, each with a lifetime of its own and
// tagged so EmDash's content purges (collection and entry tags) and the pack's own purges clear them.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = {}; export const waitUntil = () => {}; export const cache = { purge: async (o) => { globalThis.__purges.push(o); return { success: true }; } };`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

globalThis.__purges = [];
const { llmsMiddleware, newsSitemapMiddleware } = await import("../src/discovery/middleware.ts");
const { LLMS_TAG, NEWS_TAG, MARKDOWN_TAG, LLMS_EDGE_MAX_AGE, NEWS_EDGE_MAX_AGE, MARKDOWN_EDGE_MAX_AGE, rebuildNow } = await import("../src/discovery/build.ts");
const { videosSitemapMiddleware } = await import("../src/videos/pack.ts");
const { VIDEO_SITEMAP_TAG, VIDEO_SITEMAP_EDGE_MAX_AGE } = await import("../src/videos/lib.ts");

/** A request context with Astro's route cache (enabled or not) and EmDash's public route handler answering `answer(route)`. */
function context(path, answer, enabled = true) {
	const calls = [];
	const sets = [];
	return {
		url: new URL(`https://example.com${path}`),
		request: new Request(`https://example.com${path}`),
		cache: { enabled, set: (o) => sets.push(o) },
		locals: { emdash: { handlePublicPluginApiRoute: async (_id, _method, route) => (calls.push(route.replace(/^\//, "")), answer(route.replace(/^\//, ""))) } },
		calls,
		sets,
	};
}
const ok = (data) => ({ success: true, status: 200, data });

test("llms.txt: kept at the edge for an hour, tagged with its collections; the memory copy isn't reused for the edge", async () => {
	assert.equal(llmsMiddleware.ownsCache, true);
	const answer = () => ok({ body: "# Site", tags: [LLMS_TAG, "posts", "pages"] });
	const first = context("/llms.txt", answer);
	assert.equal(await (await llmsMiddleware.handle(first)).text(), "# Site");
	assert.deepEqual(first.sets, [false, { maxAge: LLMS_EDGE_MAX_AGE, swr: 0, tags: [LLMS_TAG, "posts", "pages"] }]);
	// The next edge miss asks again: a memory copy could put the pre-publish version back right after EmDash cleared it.
	const second = context("/llms.txt", answer);
	await llmsMiddleware.handle(second);
	assert.deepEqual(second.calls, ["discovery/public/llms"]);
	// A copy stored before 0.35.19 (no tags) still gets the llms.txt tag.
	const old = context("/llms.txt", () => ok({ body: "# Old" }));
	await llmsMiddleware.handle(old);
	assert.deepEqual(old.sets.at(-1).tags, [LLMS_TAG]);
});

test("Markdown versions: a day at the edge, tagged with the entry and its collection", async () => {
	const md = context("/guides/setup/index.html.md", () => ok({ body: "---\ntitle: Setup\n---\n", tokens: 5, markdownUrl: "x", tags: [MARKDOWN_TAG, "guides", "01ENTRY"] }));
	const res = await llmsMiddleware.handle(md);
	assert.match(res.headers.get("content-type"), /text\/markdown/);
	assert.deepEqual(md.sets, [false, { maxAge: MARKDOWN_EDGE_MAX_AGE, swr: 0, tags: [MARKDOWN_TAG, "guides", "01ENTRY"] }]);
	// No entry there: the site's 404 answers, and nothing is set.
	const missing = context("/nope/index.html.md", () => ({ success: false, status: 404 }));
	assert.equal(await llmsMiddleware.handle(missing), undefined);
	assert.deepEqual(missing.sets, []);
});

test("the news sitemap (both URLs): five minutes at the edge, tagged; no robots header", async () => {
	assert.equal(newsSitemapMiddleware.ownsCache, true);
	for (const path of ["/news-sitemap.xml", "/coywolf-news-sitemap.xml"]) {
		const c = context(path, () => ok({ body: "<urlset/>", tags: [NEWS_TAG, "posts"] }));
		const res = await newsSitemapMiddleware.handle(c);
		assert.equal(res.headers.get("x-robots-tag"), null);
		assert.deepEqual(c.sets, [false, { maxAge: NEWS_EDGE_MAX_AGE, swr: 0, tags: [NEWS_TAG, "posts"] }], path);
	}
});

test("without route caching nothing is set and the memory copy still serves repeats", async () => {
	const answer = () => ok({ body: "<urlset>x</urlset>", tags: [NEWS_TAG] });
	const a = context("/news-sitemap.xml", answer, false);
	await newsSitemapMiddleware.handle(a);
	assert.deepEqual(a.sets, [], "keepAtEdge does nothing without route caching");
});

test("the video sitemap: an hour at the edge, tagged with its own tag and its entries' collections", async () => {
	assert.equal(videosSitemapMiddleware.ownsCache, true);
	const c = context("/coywolf-video-sitemap.xml", () => ok({ xml: "<urlset/>", tags: [VIDEO_SITEMAP_TAG, "posts"] }));
	const res = await videosSitemapMiddleware.handle(c);
	assert.match(res.headers.get("content-type"), /xml/);
	assert.deepEqual(c.sets, [false, { maxAge: VIDEO_SITEMAP_EDGE_MAX_AGE, swr: 0, tags: [VIDEO_SITEMAP_TAG, "posts"] }]);
	// With the edge caching it, each miss asks the route (no stale copy from memory).
	const again = context("/coywolf-video-sitemap.xml", () => ok({ xml: "<urlset>2</urlset>", tags: [VIDEO_SITEMAP_TAG] }));
	assert.equal(await (await videosSitemapMiddleware.handle(again)).text(), "<urlset>2</urlset>");
});

test("a rebuild that changes llms.txt clears its edge copy (the rebuild runs seconds after EmDash's purge); an unchanged one doesn't", async () => {
	const kv = new Map();
	const POSTS = { slug: "posts", label: "Posts", routable: true, hidden: false, titleField: "title", urlPattern: "/{slug}/", fields: [] };
	let title = "First";
	const ctx = {
		kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) },
		settings: { get: async () => null },
		site: { url: "https://example.com", name: "Example", locale: "en" },
		schema: { listCollections: async () => [POSTS], getCollection: async () => POSTS },
		content: {
			list: async () => ({ items: [{ id: "1", slug: "a", status: "published", publishedAt: "2026-11-01", data: { title } }], hasMore: false }),
			get: async () => null,
		},
		log: { info() {}, warn() {}, error() {} },
	};
	globalThis.__purges = [];
	const first = await rebuildNow(ctx, "llms");
	assert.deepEqual(first.collections, ["posts"], "its collections are its edge tags");
	assert.deepEqual(globalThis.__purges, [], "nothing stored before: nothing at the edge to clear");
	await rebuildNow(ctx, "llms");
	assert.deepEqual(globalThis.__purges, [], "unchanged");
	title = "Renamed";
	await rebuildNow(ctx, "llms");
	assert.deepEqual(globalThis.__purges, [{ tags: [LLMS_TAG] }]);
});

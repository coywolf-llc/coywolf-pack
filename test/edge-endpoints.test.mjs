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
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = () => {}; export const cache = { purge: async (o) => { globalThis.__purges.push(o); return { success: globalThis.__purgeOk !== false }; } };`,
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

test("a scheduled rebuild clears the edge copies of the documents it changed in one purge call; an unchanged one, or Rebuild now, none", async () => {
	const { scheduleRebuild } = await import("../src/discovery/build.ts");
	const kv = new Map();
	const POSTS = { slug: "posts", label: "Posts", routable: true, hidden: false, titleField: "title", urlPattern: "/{slug}/", fields: [] };
	let title = "First";
	const recent = new Date(Date.now() - 3_600_000).toISOString();
	const ctx = {
		kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) },
		settings: { get: async () => null },
		site: { url: "https://example.com", name: "Example", locale: "en" },
		schema: { listCollections: async () => [POSTS], getCollection: async () => POSTS },
		content: {
			list: async () => ({ items: [{ id: "1", slug: "a", status: "published", publishedAt: recent, data: { title } }], hasMore: false }),
			get: async () => null,
		},
		log: { info() {}, warn() {}, error() {} },
	};
	const rebuild = async () => {
		scheduleRebuild(ctx, ["llms", "news"], 0);
		await new Promise((r) => setTimeout(r, 50));
	};
	globalThis.__purges = [];
	const first = await rebuildNow(ctx, "llms");
	assert.deepEqual(first.collections, ["posts"], "its collections are its edge tags");
	await rebuildNow(ctx, "news");
	title = "Renamed";
	await rebuildNow(ctx, "llms");
	assert.deepEqual(globalThis.__purges, [], "Rebuild now purges nothing itself (the admin save clears every page)");
	await rebuild();
	assert.deepEqual(globalThis.__purges, [{ tags: [NEWS_TAG] }], "llms.txt was already rebuilt: only the news sitemap changed");
	globalThis.__purges = [];
	await rebuild();
	assert.deepEqual(globalThis.__purges, [], "nothing changed");
	title = "Renamed again";
	await rebuild();
	assert.deepEqual(globalThis.__purges, [{ tags: [LLMS_TAG, NEWS_TAG] }], "both changed: one purge call");
});

test("video changes: one purge call for every video changed together; over 30 pages, an admin's change clears everything, the webhook only the newest", async () => {
	const { clearVideoPages } = await import("../src/videos/module.ts");
	const { invalidateEmbeds } = await import("../src/videos/store.ts");
	const A = "a".repeat(32);
	const B = "b".repeat(32);
	const C = "c".repeat(32);
	const entry = (uid, i) => ({
		id: `posts:${uid}${i}`,
		data: { collection: "posts", entryId: `${uid}${i}`, status: "published", url: `https://example.com/${uid.slice(0, 1)}/${i}/`, publishedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, uids: [uid] },
	});
	const items = [entry(A, 1), entry(B, 1), ...Array.from({ length: 35 }, (_, i) => entry(C, i))];
	const ctx = { storage: { videosEmbeds: { query: async () => ({ items, hasMore: false }) } }, log: { info() {}, warn() {}, error() {} } };
	invalidateEmbeds();
	globalThis.__purges = [];
	await clearVideoPages(ctx, [A, B], "skip");
	assert.deepEqual(globalThis.__purges, [{ pathPrefixes: ["/a/1", "/b/1"], tags: ["coywolf:video-sitemap"] }]);
	globalThis.__purges = [];
	await clearVideoPages(ctx, C, "skip");
	assert.equal(globalThis.__purges[0].pathPrefixes.length, 30, "the webhook: the newest 30, never everything");
	globalThis.__purges = [];
	await clearVideoPages(ctx, C);
	assert.deepEqual(globalThis.__purges, [{ purgeEverything: true }], "an admin's change: once, everything");
	invalidateEmbeds();
});

test("a refused video-page purge is kept for the settling purge (a new generation row on a site that has none)", async () => {
	const { clearVideoPages } = await import("../src/videos/module.ts");
	const { invalidateEmbeds } = await import("../src/videos/store.ts");
	const { GENERATION_OPTION } = await import("../src/core/features.ts");
	const { DatabaseSync } = await import("node:sqlite");
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const exec = (sql, params) => {
		const st = sqlite.prepare(sql);
		return /^\s*(select|with)|\breturning\b/i.test(sql) ? { results: st.all(...params) } : { results: [], meta: { changes: Number(st.run(...params).changes) } };
	};
	const statement = (sql, params = []) => ({ bind: (...p) => statement(sql, p), first: async () => exec(sql, params).results[0] ?? null, run: async () => exec(sql, params), all: async () => exec(sql, params) });
	globalThis.__testEnv = { DB: { prepare: (sql) => statement(sql) } };
	const A = "d".repeat(32);
	const items = [{ id: "posts:1", data: { collection: "posts", entryId: "1", status: "published", url: "https://example.com/d/1/", publishedAt: "2026-01-01", uids: [A] } }];
	const ctx = { storage: { videosEmbeds: { query: async () => ({ items, hasMore: false }) } }, log: { info() {}, warn() {}, error() {} } };
	invalidateEmbeds();
	globalThis.__purgeOk = false;
	try {
		await clearVideoPages(ctx, A, "skip");
	} finally {
		globalThis.__purgeOk = true;
		delete globalThis.__testEnv;
		invalidateEmbeds();
	}
	const row = JSON.parse(sqlite.prepare("SELECT value FROM options WHERE name = ?").get(GENERATION_OPTION).value);
	assert.deepEqual(row.settle, { pathPrefixes: ["/d/1"], tags: ["coywolf:video-sitemap"] });
	assert.equal(row.id, "0", "the site's first generation: no page changes its tag");
});

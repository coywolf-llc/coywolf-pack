import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { buildRss, feedLanguage, parseFeedPath, termFeedRoute, termSegments, withDescendants } = await import("../src/discovery/feed.ts");
const { expandPattern } = await import("../src/core/content-url.ts");

test("feed URLs: the site feed, term feeds, and paths that aren't feeds", () => {
	assert.deepEqual(parseFeedPath("/feed/"), []);
	assert.deepEqual(parseFeedPath("/feed"), []);
	assert.deepEqual(parseFeedPath("/news/feed/"), ["news"]);
	assert.deepEqual(parseFeedPath("/news/seo/feed/"), ["news", "seo"]);
	assert.equal(parseFeedPath("/news/"), null);
	assert.equal(parseFeedPath("/feeds/"), null);
	assert.equal(parseFeedPath("/news/feed/extra/"), null);
	assert.equal(parseFeedPath("/a%2Fb/feed/"), null, "an encoded slash isn't a segment");
	assert.equal(parseFeedPath("/../feed/"), null);
	assert.equal(parseFeedPath(`${"/a".repeat(9)}/feed/`), null, "too deep");
});

test("term feed routes come from a term-then-slug URL override", () => {
	assert.deepEqual(termFeedRoute(expandPattern("/{termpath:category|uncategorized}/{slug}/")), { prefix: "", hierarchical: true, taxonomy: "category" });
	assert.deepEqual(termFeedRoute(expandPattern("/{category}/{slug}/")), { prefix: "", hierarchical: false, taxonomy: "category" });
	assert.deepEqual(termFeedRoute("/blog/{term:topic}/{slug}"), { prefix: "/blog", hierarchical: false, taxonomy: "topic" });
	assert.equal(termFeedRoute("/{slug}/"), null);
	assert.equal(termFeedRoute("/{year}/{term:category}/{slug}/"), null);
	assert.equal(termFeedRoute(null), null);
});

test("term segments: under the prefix, one segment unless hierarchical", () => {
	const flat = { prefix: "", hierarchical: false, taxonomy: "category" };
	const deep = { prefix: "", hierarchical: true, taxonomy: "category" };
	const blog = { prefix: "/blog", hierarchical: false, taxonomy: "topic" };
	assert.deepEqual(termSegments(["news"], flat), ["news"]);
	assert.equal(termSegments(["news", "seo"], flat), null);
	assert.deepEqual(termSegments(["news", "seo"], deep), ["news", "seo"]);
	assert.deepEqual(termSegments(["blog", "tips"], blog), ["tips"]);
	assert.equal(termSegments(["tips"], blog), null);
	assert.equal(termSegments(["blog"], blog), null);
});

test("a term feed includes child terms, and a cycle stops", () => {
	const parents = new Map([["seo", "news"], ["local", "seo"], ["ai", "news"], ["other", "misc"], ["x", "y"], ["y", "x"]]);
	assert.deepEqual(withDescendants("news", parents).sort(), ["ai", "local", "news", "seo"]);
	assert.deepEqual(withDescendants("seo", parents).sort(), ["local", "seo"]);
	assert.deepEqual(withDescendants("x", parents).sort(), ["x", "y"]);
});

test("RSS 2.0 document: channel, items, escaping, dates", () => {
	const xml = buildRss(
		{
			title: "Coywolf & Co",
			link: "https://e.com/",
			selfUrl: "https://e.com/feed/",
			description: "News <and> more",
			language: "en-US",
			lastBuildDate: "2026-10-30 12:00:00",
			image: { url: "https://e.com/logo.png", title: "Coywolf", link: "https://e.com/" },
			items: [
				{ title: "A \"quoted\" post", url: "https://e.com/news/a/", publishedAt: "2026-10-30T10:00:00Z", creator: "Jon", category: "News", description: "Short\u0001 summary" },
				{ title: "No date", url: "https://e.com/b/", publishedAt: "not a date" },
			],
		},
		new Date("2026-10-31T00:00:00Z"),
	);
	assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0"/);
	assert.match(xml, /<title>Coywolf &amp; Co<\/title>/);
	assert.match(xml, /<atom:link href="https:\/\/e.com\/feed\/" rel="self" type="application\/rss\+xml" \/>/);
	assert.match(xml, /<description>News &lt;and&gt; more<\/description>/);
	assert.match(xml, /<lastBuildDate>Fri, 30 Oct 2026 12:00:00 GMT<\/lastBuildDate>/);
	assert.match(xml, /<language>en-US<\/language>/);
	assert.match(xml, /<image>\n\t\t\t<url>https:\/\/e.com\/logo.png<\/url>/);
	assert.match(xml, /<title>A &quot;quoted&quot; post<\/title>/);
	assert.match(xml, /<dc:creator>Jon<\/dc:creator>/);
	assert.match(xml, /<pubDate>Fri, 30 Oct 2026 10:00:00 GMT<\/pubDate>/);
	assert.match(xml, /<category>News<\/category>/);
	assert.match(xml, /<guid isPermaLink="true">https:\/\/e.com\/news\/a\/<\/guid>/);
	assert.match(xml, /<description>Short summary<\/description>/, "control characters are dropped");
	assert.equal((xml.match(/<item>/g) ?? []).length, 1, "an item without a valid date is left out");
});

test("no items: lastBuildDate falls back to now; no image, creator or category tags", () => {
	const xml = buildRss({ title: "T", link: "https://e.com/", selfUrl: "https://e.com/feed/", description: "", language: "", items: [] }, new Date("2026-10-31T00:00:00Z"));
	assert.match(xml, /<lastBuildDate>Sat, 31 Oct 2026 00:00:00 GMT<\/lastBuildDate>/);
	assert.match(xml, /<language>en<\/language>/);
	assert.doesNotMatch(xml, /<image>|<item>/);
});

test("feed language", () => {
	assert.equal(feedLanguage("en-US"), "en-US");
	assert.equal(feedLanguage("fr_CA"), "fr-CA");
	assert.equal(feedLanguage(""), "en");
	assert.equal(feedLanguage("not a locale!"), "en");
});

// ── Head links (composed like the plugin) ──

const { composeHooks } = await import("../src/core/compose.ts");
const { invalidateFeatures } = await import("../src/core/features.ts");
const { discoveryPack } = await import("../src/discovery/pack.ts");

function fakeCtx(features) {
	return {
		site: { name: "Example", url: "https://example.com", locale: "en" },
		settings: { get: async (key) => (key === "features" ? features : null) },
		log: { info() {}, warn() {}, error() {} },
	};
}

test("head link to the feed on every page while the RSS feed is on; the Markdown link keeps its own switch", async () => {
	const { hooks } = composeHooks([discoveryPack({})], { tasks: [] });
	const custom = { page: { kind: "custom", url: "https://example.com/news/", canonical: null, title: null } };
	const entry = { page: { kind: "content", url: "https://example.com/news/a/", canonical: "https://example.com/news/a/", title: "A", content: { collection: "posts" } } };

	invalidateFeatures();
	const feedOnly = await hooks["page:fragments"](custom, fakeCtx({ discovery: true, "discovery.feed": true }));
	assert.equal(feedOnly.length, 1);
	assert.equal(feedOnly[0].placement, "head");
	assert.match(feedOnly[0].html, /^<link rel="alternate" type="application\/rss\+xml" href="https:\/\/example.com\/feed\/" title="[^"]+ RSS feed">$/);

	invalidateFeatures();
	const both = await hooks["page:fragments"](entry, fakeCtx({ discovery: true, "discovery.feed": true, "discovery.llms": true }));
	assert.deepEqual(both.map((f) => f.key).sort(), ["discovery-feed", "discovery-markdown"]);

	invalidateFeatures();
	const markdownOnly = await hooks["page:fragments"](entry, fakeCtx({ discovery: true, "discovery.llms": true }));
	assert.deepEqual(markdownOnly.map((f) => f.key), ["discovery-markdown"]);

	invalidateFeatures();
	assert.deepEqual(await hooks["page:fragments"](custom, fakeCtx({ discovery: false, "discovery.feed": true })), []);
	invalidateFeatures();
});

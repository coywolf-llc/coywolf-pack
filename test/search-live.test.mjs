import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

const { buildSnippet, highlightHtml, highlightWords, escapeHtml, wordPattern } = await import("../src/search/snippet.ts");
const { liveScript, liveScriptConfig, LIVE_CSS, LIVE_ASSET, LIVE_ASSET_HASH } = await import("../src/search/live-client.ts");
const { isLimitedPath } = await import("../src/search/ratelimit-core.ts");

test("highlight words: typed words of two or more characters, longest first, de-duplicated", () => {
	assert.deepEqual(highlightWords("photo Photograph a x"), ["photograph", "photo"]);
	assert.deepEqual(highlightWords("  "), []);
	assert.deepEqual(highlightWords("red-wolf, RED"), ["wolf", "red"]);
	assert.equal(highlightWords("a1 b2 c3 d4 e5 f6 g7 h8 i9 j10 k11 l12").length, 10);
});

test("highlight: case-insensitive, at word starts only", () => {
	assert.equal(highlightHtml("Synergy and asynchronous sync", ["syn"]), "<mark>Syn</mark>ergy and asynchronous <mark>syn</mark>c");
	assert.equal(highlightHtml("Wolf pack", []), "Wolf pack");
	assert.equal(highlightHtml("ÉCOLE école", ["éco"]), "<mark>ÉCO</mark>LE <mark>éco</mark>le");
});

test("highlight: longer word wins over its prefix", () => {
	assert.equal(highlightHtml("Photography", highlightWords("photo photograph")), "<mark>Photograph</mark>y");
});

test("highlight: escapes text and matches; never marks inside an entity", () => {
	assert.equal(highlightHtml(`<script>alert("x")</script> & amp`, ["amp", "script"]), "&lt;<mark>script</mark>&gt;alert(&quot;x&quot;)&lt;/<mark>script</mark>&gt; &amp; <mark>amp</mark>");
	assert.equal(escapeHtml(`<a href='x'>&</a>`), "&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;");
});

test("highlight: regex characters in the query are literal", () => {
	assert.equal(wordPattern(highlightWords("c++ (wolf)"))?.source.includes("wolf"), true);
	assert.equal(highlightHtml("a.b wolf", ["a.b"]), "<mark>a.b</mark> wolf");
	assert.equal(highlightHtml("axb", ["a.b"]), "axb");
});

test("snippet: only <mark> tags survive", () => {
	const html = buildSnippet(`<img src=x onerror=alert(1)> wolves <b>bold</b>`, ["wolves"]);
	assert.ok(!/<(?!\/?mark>)/.test(html), html);
	assert.ok(html.includes("<mark>wolves</mark>"));
});

test("snippet: short text is whole, without ellipses", () => {
	assert.equal(buildSnippet("  Red   wolves\nhunt in packs. ", ["wolves"]), "Red <mark>wolves</mark> hunt in packs.");
	assert.equal(buildSnippet("", ["x"]), "");
});

test("snippet: long text is a window around the first match with ellipses, cut at word boundaries", () => {
	const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
	words[100] = "synergy";
	const html = buildSnippet(words.join(" "), ["syn"]);
	assert.ok(html.startsWith("…") && html.endsWith("…"), html);
	assert.ok(html.includes("<mark>syn</mark>ergy"));
	const text = html.replace(/<\/?mark>/g, "").slice(1, -1);
	assert.ok(text.length <= 180, String(text.length));
	// Starts and ends on whole words.
	assert.match(text, /^word\d+ /);
	assert.match(text, / word\d+$/);
	// About 40 characters of context before the match.
	const before = text.indexOf("synergy");
	assert.ok(before > 20 && before <= 40, String(before));
});

test("snippet: no match starts at the beginning", () => {
	const html = buildSnippet("alpha ".repeat(60), ["zeta"]);
	assert.ok(!html.startsWith("…"));
	assert.ok(html.endsWith("…"));
});

test("snippet: a match near the end keeps the window full", () => {
	const html = buildSnippet(`${"lorem ipsum ".repeat(30)}final wolf`, ["wolf"]);
	assert.ok(html.startsWith("…"));
	assert.ok(html.endsWith("<mark>wolf</mark>"));
	assert.ok(html.replace(/<\/?mark>/g, "").length > 150);
});

test("snippet: never splits a surrogate pair", () => {
	const html = buildSnippet("😀".repeat(200), []);
	assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(html) && !/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(html));
});

test("live script: valid JavaScript, config embedded safely", () => {
	const code = liveScript({ endpoint: "/_emdash/api/plugins/coywolf-pack/search/live", indexEndpoint: "/_emdash/api/plugins/coywolf-pack/search/index", version: "v1", limit: 8, minChars: 2, debounce: 120, locale: "</script><x>", enterOpensTop: true });
	assert.doesNotThrow(() => new vm.Script(code));
	// The title matcher ships inside it, compacted like the rest.
	assert.ok(code.includes("localItems") && code.includes("/search/index"));
	assert.ok(!code.includes("</script>"));
	assert.ok(code.includes("\\u003c/script>"));
});

test("live script: does nothing without a DOM-capable browser (no fetch)", () => {
	const code = liveScript({ endpoint: "/x", indexEndpoint: null, version: "v1", limit: 8, minChars: 2, debounce: 200, locale: null, enterOpensTop: true });
	const window = {};
	assert.doesNotThrow(() => vm.runInNewContext(code, { window }));
	assert.equal(window.__cwLive, undefined);
});

test("live script file: runs the same client with the config from its own script element", () => {
	assert.doesNotThrow(() => new vm.Script(LIVE_ASSET));
	const config = { endpoint: "/x", indexEndpoint: null, version: "v1", limit: 8, minChars: 2, debounce: 200, locale: "</script>", enterOpensTop: true };
	// The inline script is this client called with the config; the file passes the parsed attribute instead.
	const inline = liveScript(config);
	assert.ok(LIVE_ASSET.includes(inline.slice(1, 4000)), "same client body");
	// Executes the client: with a config, it reads document.readyState; without one it touches nothing.
	const reads = [];
	const document = {
		currentScript: { getAttribute: (name) => (name === "data-cw-live" ? liveScriptConfig(config) : null) },
		get readyState() {
			reads.push("readyState");
			return "loading";
		},
		addEventListener: (type) => reads.push(type),
	};
	const browser = () => ({ fetch() {}, AbortController: class {} });
	const window = browser();
	vm.runInNewContext(LIVE_ASSET, { document, window });
	// Started: it marks itself with the tools it lends the SearchBox.
	assert.equal(typeof window.__cwLive, "object", "the client started");
	assert.deepEqual(Object.keys(window.__cwLive).sort(), ["localItems", "merge", "titles", "warm"]);
	assert.equal(window.__cwLive.titles("terms", null), null, "no index endpoint, no index");
	assert.ok(reads.includes("DOMContentLoaded"), reads.join());
	const idle = { currentScript: { getAttribute: () => null } };
	const idleWindow = browser();
	assert.doesNotThrow(() => vm.runInNewContext(LIVE_ASSET, { document: idle, window: idleWindow }));
	assert.equal(idleWindow.__cwLive, undefined, "no config, nothing runs");
	assert.match(LIVE_ASSET_HASH, /^[0-9a-z]+$/);
});

test("live script file: immutable for the current version only, served by the middleware alone", async () => {
	const serve = await import("../src/search/live-serve.ts");
	assert.equal(serve.liveAssetParts(LIVE_ASSET_HASH).headers["Cache-Control"], "public, max-age=31536000, immutable");
	assert.equal(serve.liveAssetParts("old").headers["Cache-Control"], "public, max-age=300");
	assert.equal(serve.liveAssetParts(null).body, LIVE_ASSET);
	const request = (path, method = "GET") => ({ url: new URL(`https://example.com${path}`), request: new Request(`https://example.com${path}`, { method }) });
	const res = await serve.searchLiveMiddleware.handle(request(serve.liveAssetUrl()), {}, () => {});
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("Content-Type"), "text/javascript; charset=utf-8");
	assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
	assert.equal(await res.text(), LIVE_ASSET);
	const head = await serve.searchLiveMiddleware.handle(request(serve.liveAssetUrl(), "HEAD"), {}, () => {});
	assert.equal(await head.text(), "");

	// EmDash rejects raw plugin routes with a JavaScript content type (500), so there's no route fallback.
	const { searchPack: pack } = await import("../src/search/pack.ts");
	assert.equal(pack({}).routes["search/live-client"], undefined);
});

test("live script fragment: the file only while the pack middleware serves it, else inline", async () => {
	const serve = await import("../src/search/live-serve.ts");
	const config = { endpoint: "/x", indexEndpoint: null, version: "v1", limit: 8, minChars: 2, debounce: 120, locale: null, enterOpensTop: true };
	const external = serve.liveScriptFragment(config, true);
	assert.equal(external.kind, "external-script");
	assert.equal(external.src, serve.liveAssetUrl());
	assert.deepEqual(JSON.parse(external.attributes["data-cw-live"]), config);
	const inline = serve.liveScriptFragment(config, false);
	assert.equal(inline.kind, "inline-script");
	assert.equal(inline.placement, "body:end");
	assert.equal(inline.code, liveScript(config));

	// The default follows whether the middleware has run in this isolate.
	serve.notePackMiddleware(false);
	assert.equal(serve.packMiddlewareActive(), false);
	assert.equal(serve.liveScriptFragment(config).kind, "inline-script", "a site without the middleware");
	serve.notePackMiddleware();
	assert.equal(serve.liveScriptFragment(config).kind, "external-script");
	serve.notePackMiddleware(false);
});

test("live styles: no unbalanced braces", () => {
	assert.equal((LIVE_CSS.match(/{/g) ?? []).length, (LIVE_CSS.match(/}/g) ?? []).length);
});

test("rate limit covers the live results route", () => {
	assert.equal(isLimitedPath("/_emdash/api/plugins/coywolf-pack/search/live"), true);
	assert.equal(isLimitedPath("/_emdash/api/plugins/coywolf-pack/search/live/"), true);
});

// ── Feature switch and page fragment ─────────────────────────────

const { resolveFeatures, invalidateFeatures } = await import("../src/core/features.ts");
const { composeHooks } = await import("../src/core/compose.ts");
const { searchPack, FEATURES } = await import("../src/search/pack.ts");

test("search.live: on by default with Search, including sites that saved switches before it existed", () => {
	assert.equal(FEATURES.find((f) => f.id === "search.live")?.default, true);
	assert.equal(resolveFeatures({})["search.live"], false, "Search itself is off by default");
	// An existing install: Search and its other parts saved, no "search.live" key.
	assert.equal(resolveFeatures({ search: true, "search.box": false, "search.settings": true })["search.live"], true);
	assert.equal(resolveFeatures({ search: true, "search.live": false })["search.live"], false);
	assert.equal(resolveFeatures({ search: false, "search.live": true })["search.live"], false);
});

function fakeCtx(features) {
	return { settings: { get: async (key) => (key === "features" ? features : null) }, log: { info() {}, warn() {}, error() {} } };
}

test("page fragment: the live results script at the end of the body while search.live is on", async () => {
	const { hooks } = composeHooks([searchPack({ live: { limit: 5, minChars: 3 } })], { tasks: [] });
	const event = { page: { locale: "en", kind: "custom", url: "https://example.com/" } };
	const { notePackMiddleware } = await import("../src/search/live-serve.ts");

	// Without the pack middleware: the client inline.
	notePackMiddleware(false);
	invalidateFeatures();
	const inline = await hooks["page:fragments"](event, fakeCtx({ search: true }));
	assert.equal(inline.length, 1);
	assert.equal(inline[0].kind, "inline-script");
	assert.ok(inline[0].code.includes('"limit":5'));

	notePackMiddleware();
	invalidateFeatures();
	const on = await hooks["page:fragments"](event, fakeCtx({ search: true }));
	notePackMiddleware(false);
	assert.equal(on.length, 1);
	assert.equal(on[0].kind, "external-script");
	assert.equal(on[0].placement, "body:end");
	assert.equal(on[0].defer, true);
	assert.equal(on[0].src, `/_emdash/api/plugins/coywolf-pack/search/live-client?v=${LIVE_ASSET_HASH}`);
	const config = JSON.parse(on[0].attributes["data-cw-live"]);
	assert.equal(config.limit, 5);
	assert.equal(config.minChars, 3);
	assert.equal(config.locale, "en");
	assert.equal(config.endpoint, "/_emdash/api/plugins/coywolf-pack/search/live");

	invalidateFeatures();
	assert.deepEqual(await hooks["page:fragments"](event, fakeCtx({ search: true, "search.live": false })), []);
	invalidateFeatures();
	assert.deepEqual(await hooks["page:fragments"](event, fakeCtx({})), []);
	invalidateFeatures();
});

test("live options are clamped", async () => {
	const { hooks } = composeHooks([searchPack({ live: { limit: 500, minChars: 0, debounce: -5 } })], { tasks: [] });
	const { notePackMiddleware } = await import("../src/search/live-serve.ts");
	notePackMiddleware();
	invalidateFeatures();
	const [fragment] = await hooks["page:fragments"]({ page: { locale: null } }, fakeCtx({ search: true }));
	notePackMiddleware(false);
	assert.ok(fragment.attributes["data-cw-live"].includes('"limit":20,"minChars":1,"debounce":0'), fragment.attributes["data-cw-live"]);
	invalidateFeatures();
});

test("portableTextProse keeps text blocks only (no image alt or captions)", async () => {
	const { portableTextProse } = await import("../src/search/snippet.ts");
	const pt = [
		{ _type: "image", alt: "A close-up of coffee beans", caption: "Beans" },
		{ _type: "block", style: "h2", children: [{ _type: "span", text: "Why " }, { _type: "span", text: "decaf" }] },
		{ _type: "block", children: [{ _type: "span", text: "Decaf coffee is safe." }] },
		{ _type: "coywolf-review", pros: "Tasty" },
	];
	assert.equal(portableTextProse(JSON.stringify(pt)), "Why decaf Decaf coffee is safe.");
	assert.equal(portableTextProse(pt), "Why decaf Decaf coffee is safe.");
	assert.equal(portableTextProse("not json"), "");
	assert.equal(portableTextProse({}), "");
	assert.equal(portableTextProse(JSON.stringify(pt), 5), "Why d");
});

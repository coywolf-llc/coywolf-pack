// Run: node --test test/searchbox-client.test.mjs
//
// The SearchBox's script (src/search/searchbox-client.ts) in happy-dom, with the live results client on the page
// lending it the title index and matcher (window.__cwLive) and a fake server: instant title matches on every
// keystroke, one server request once typing pauses, the answer merged in without reshuffling, cached answers,
// late answers dropped, a picked row kept, and the server-only path without the live client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

import "./ts-resolve.mjs";

const { liveScript } = await import("../src/search/live-client.ts");
const { enhanceSearchBoxes, liveTools } = await import("../src/search/searchbox-client.ts");

const LIVE_ENDPOINT = "/_emdash/api/plugins/coywolf-pack/search/live";
const INDEX_ENDPOINT = "/_emdash/api/plugins/coywolf-pack/search/index";
const INDEX = {
	v: "v1",
	types: ["Term"],
	entries: [
		["What is a coyote?", "/coyote", 0],
		["What is Coywolf?", "/coywolf", 0],
		["What is a wolf?", "/wolf", 0],
	],
};
/** The server's answers: title matches with excerpts, plus a full-text match the index can't know about. */
const ANSWERS = {
	coy: [
		{ title: "What is Coywolf?", url: "/coywolf/", type: "Term", snippet: "<mark>Coy</mark>wolf is a hybrid." },
		{ title: "What is a coyote?", url: "/coyote/", type: "Term", snippet: "A <mark>coy</mark>ote is a canine." },
		{ title: "What is a jackal?", url: "/jackal/", type: "Term", snippet: "Kin of the <mark>coy</mark>ote." },
	],
};

const FORM = `<form class="cw-search" role="search" action="/search/" method="get" data-cw-search data-live="1" data-endpoint="${LIVE_ENDPOINT}" data-min-chars="2" data-debounce="40" data-limit="8" data-collections="terms" data-show-snippets="1">
	<label for="s-input">Search</label>
	<div class="cw-search__field"><input id="s-input" class="cw-search__input" type="search" name="q"><button type="button" class="cw-search__clear" hidden></button></div>
	<ul id="s-list" class="cw-search__list" role="listbox" hidden></ul>
	<div role="status" aria-live="polite"></div>
</form>`;

/**
 * A page with a SearchBox and (unless `withClient` is false) the live results client, the SearchBox's script
 * running against it, and a server that answers live results after `delay` ms. Returns the requests it saw.
 */
async function page({ withClient = true, delay = 30 } = {}) {
	const window = new Window({ url: "https://example.test/", settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
	const requests = [];
	window.fetch = (url, init = {}) => {
		const u = new URL(String(url), "https://example.test/");
		requests.push(u);
		const json = (body) => new window.Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
		if (u.pathname === INDEX_ENDPOINT) return Promise.resolve(json(INDEX));
		if (u.searchParams.get("warm") === "1") return Promise.resolve(new window.Response(null, { status: 204 }));
		const q = u.searchParams.get("q") ?? "";
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => resolve(json({ success: true, data: { items: ANSWERS[q] ?? [], fallback: false } })), delay);
			init.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(new window.DOMException("Aborted", "AbortError"));
			});
		});
	};
	const client = withClient ? `<script>${liveScript({ endpoint: LIVE_ENDPOINT, indexEndpoint: INDEX_ENDPOINT, version: "v1", limit: 8, minChars: 2, debounce: 120, locale: null, enterOpensTop: true })}</script>` : "";
	window.document.write(`<!doctype html><html><body>${FORM}${client}</body></html>`);
	// The module runs in Node: point its globals at this page.
	Object.assign(globalThis, {
		window,
		document: window.document,
		fetch: window.fetch,
		requestAnimationFrame: (fn) => setTimeout(fn, 0),
		__cwLive: window.__cwLive,
	});
	enhanceSearchBoxes(window.document);
	const input = window.document.querySelector("input");
	const list = window.document.querySelector(".cw-search__list");
	const type = (value) => {
		input.value = value;
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	};
	const rows = () => [...list.querySelectorAll("[role=option]")].map((o) => o.getAttribute("href"));
	const live = () => requests.filter((u) => u.pathname === LIVE_ENDPOINT && u.searchParams.has("q")).map((u) => u.searchParams.get("q"));
	const settle = (ms) => new Promise((r) => setTimeout(r, ms));
	return { window, input, list, type, rows, live, requests, settle, status: window.document.querySelector("[role=status]") };
}

async function done(p) {
	await p.window.happyDOM.close();
	delete globalThis.__cwLive;
}

test("live client: lends the SearchBox one title index per collections and locale", async () => {
	const p = await page();
	const tools = liveTools();
	assert.ok(tools, "window.__cwLive has the tools");
	const a = tools.titles("terms", undefined);
	assert.equal(tools.titles("terms", undefined), a, "same collections, same request");
	assert.notEqual(tools.titles("posts", undefined), a);
	assert.equal((await a).length, 3);
	const indexUrls = p.requests.filter((u) => u.pathname === INDEX_ENDPOINT).map((u) => u.search);
	assert.deepEqual(indexUrls, ["?v=v1&collections=terms", "?v=v1&collections=posts"]);
	await done(p);
});

test("SearchBox: title matches show in the same keystroke; one server request once typing pauses, merged without reshuffling", async () => {
	const p = await page({ delay: 30 });
	p.input.focus();
	await p.settle(5); // the index loads (first focus), with one warm-up
	assert.equal(p.requests.filter((u) => u.searchParams.get("warm") === "1").length, 1);
	p.type("co");
	assert.deepEqual(p.rows(), ["/coywolf", "/coyote"], "instant: no await between the keystroke and the rows (earlier match first)");
	p.type("coy");
	assert.deepEqual(p.rows(), ["/coywolf", "/coyote"]);
	assert.equal(p.status.textContent, "", "instant rows aren't announced while the server is quick");
	assert.deepEqual(p.live(), [], "nothing asked yet: still typing");
	await p.settle(100);
	assert.deepEqual(p.live(), ["coy"], "one request, for what was typed last");
	assert.deepEqual(p.rows(), ["/coywolf/", "/coyote/", "/jackal/"], "the server's rows replace the title matches in place, the rest follow");
	assert.equal(p.list.querySelectorAll(".cw-search__snippet").length, 3, "with excerpts");
	assert.match(p.status.textContent, /^3 suggestions/);
	// Backspace to a query already answered: shown at once, no new request.
	p.type("coyo");
	p.type("coy");
	assert.deepEqual(p.rows(), ["/coywolf/", "/coyote/", "/jackal/"]);
	await p.settle(100);
	assert.deepEqual(p.live(), ["coy"], "coyo was typed past before a pause, and coy came from the cache");
	await done(p);
});

test("SearchBox: queries are sent the way the server caches them (lower case, single spaces)", async () => {
	const p = await page();
	p.input.focus();
	p.type("  CoY  ");
	await p.settle(100);
	assert.deepEqual(p.live(), ["coy"]);
	p.type("coy");
	await p.settle(100);
	assert.deepEqual(p.live(), ["coy"], "same normalized query: from the cache");
	await done(p);
});

test("SearchBox: an answer for a query typed past is dropped, and the picked row stays picked", async () => {
	const p = await page({ delay: 80 });
	p.input.focus();
	await p.settle(5);
	p.type("co");
	await p.settle(60); // the request for "co" is in flight
	p.type("coy");
	await p.settle(55); // "co" was cancelled; "coy" asked
	assert.deepEqual(p.live(), ["co", "coy"]);
	assert.deepEqual(p.rows(), ["/coywolf", "/coyote"], "still the instant rows: no stale answer");
	// Arrow to the second row before the server answers: it stays picked when the answer fills the list in.
	p.input.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
	p.input.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
	assert.equal(p.list.querySelector("[aria-selected=true]").getAttribute("href"), "/coyote");
	await p.settle(120);
	assert.deepEqual(p.rows(), ["/coywolf/", "/coyote/", "/jackal/"]);
	assert.equal(p.list.querySelector("[aria-selected=true]")?.getAttribute("href"), "/coyote/", "same entry, now the server's row");
	await done(p);
});

test("SearchBox: without the live results client it asks the server only, as before", async () => {
	const p = await page({ withClient: false, delay: 10 });
	assert.equal(liveTools(), null);
	p.input.focus();
	await p.settle(5);
	assert.equal(p.requests.filter((u) => u.pathname === INDEX_ENDPOINT).length, 0, "no index");
	assert.equal(p.requests.filter((u) => u.searchParams.get("warm") === "1").length, 1, "still a warm-up");
	p.type("coy");
	assert.deepEqual(p.rows(), [], "nothing until the server answers");
	await p.settle(100);
	assert.deepEqual(p.rows(), ["/coywolf/", "/coyote/", "/jackal/"], "the server's order");
	await done(p);
});

test("SearchBox: an older live results client (no tools) is ignored", async () => {
	const p = await page({ withClient: false });
	globalThis.__cwLive = 1;
	assert.equal(liveTools(), null);
	await done(p);
});

// Run: node --test test/searchbox-client.test.mjs
//
// The SearchBox's script (src/search/searchbox-client.ts) in happy-dom, with the live results client on the page
// lending it the title index and matcher (window.__cwLive) and a fake server: instant title matches on every
// keystroke, one server request once typing pauses, the answer merged in without reshuffling, cached answers,
// late answers dropped, a picked row kept, and the server-only path without the live client.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
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

const SEEN_ENDPOINT = "/_emdash/api/plugins/coywolf-pack/search/seen";
const form = ({ limit = 8, seen = false } = {}) => `<form class="cw-search" role="search" action="/search/" method="get" data-cw-search data-live="1" data-endpoint="${LIVE_ENDPOINT}"${seen ? ` data-seen="${SEEN_ENDPOINT}"` : ""} data-min-chars="2" data-debounce="40" data-limit="${limit}" data-collections="terms" data-show-snippets="1">
	<label for="s-input">Search</label>
	<div class="cw-search__field"><input id="s-input" class="cw-search__input" type="search" name="q"><button type="button" class="cw-search__clear" hidden></button></div>
	<ul id="s-list" class="cw-search__list" role="listbox" hidden></ul>
	<div role="status" aria-live="polite"></div>
</form>`;
const CLIENT = `<script>${liveScript({ endpoint: LIVE_ENDPOINT, indexEndpoint: INDEX_ENDPOINT, version: "v1", limit: 8, minChars: 2, debounce: 120, locale: null, enterOpensTop: true })}</script>`;

/**
 * A page with a SearchBox and (unless `withClient` is false) the live results client, the SearchBox's script
 * running against it, and a server that answers live results after `delay` ms. Returns the requests it saw.
 */
async function page({ withClient = true, delay = 30, limit = 8, seen = false } = {}) {
	const window = new Window({ url: "https://example.test/", settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
	const requests = [];
	const posts = [];
	window.fetch = (url, init = {}) => {
		const u = new URL(String(url), "https://example.test/");
		if (init.method === "POST") {
			posts.push(JSON.parse(init.body));
			return Promise.resolve(new window.Response(null, { status: 204 }));
		}
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
	window.document.write(`<!doctype html><html><body>${form({ limit, seen })}${withClient ? CLIENT : ""}</body></html>`);
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
	const key = (k) => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
	const live = () => requests.filter((u) => u.pathname === LIVE_ENDPOINT && u.searchParams.has("q")).map((u) => u.searchParams.get("q"));
	const settle = (ms) => new Promise((r) => setTimeout(r, ms));
	const p = { window, input, list, type, rows, live, requests, posts, key, settle, status: window.document.querySelector("[role=status]") };
	pages.add(p);
	return p;
}

// Pages still open (a failed assertion skips its test's done()): closed after each test, so a failure fails fast.
const pages = new Set();

async function done(p) {
	if (!pages.delete(p)) return;
	await p.window.happyDOM.close();
	delete globalThis.__cwLive;
}

afterEach(async () => {
	for (const p of [...pages]) await done(p);
});

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

test("SearchBox: a space typed while the request waits still sends it (and doesn't cancel a settled search)", async () => {
	const p = await page({ seen: true });
	p.input.focus();
	await p.settle(5);
	p.type("coy");
	p.type("coy ");
	await p.settle(100);
	assert.deepEqual(p.live(), ["coy"], "the space didn't cancel the request");
	assert.equal(p.list.querySelectorAll(".cw-search__snippet").length, 3);
	p.type("coy  ");
	await p.settle(1600);
	assert.deepEqual(p.posts, [{ q: "coy", n: 3 }], "the settled search counts despite the trailing spaces");
	await done(p);
});

test("SearchBox: a title match opened before the server answers counts as a search", async () => {
	const p = await page({ seen: true, delay: 500 });
	p.input.focus();
	await p.settle(5);
	p.type("coyw");
	assert.deepEqual(p.rows(), ["/coywolf"]);
	p.list.querySelector("a").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true, cancelable: true }));
	assert.deepEqual(p.posts, [{ q: "coyw", n: 1 }]);
	await done(p);
});

test("SearchBox: focused before the live results client ran, it picks up the index on the next focus", async () => {
	const p = await page({ withClient: false });
	p.input.focus();
	await p.settle(5);
	assert.equal(p.requests.filter((u) => u.pathname === INDEX_ENDPOINT).length, 0);
	// The deferred client at the end of the page runs now.
	const script = p.window.document.createElement("script");
	script.textContent = CLIENT.replace(/^<script>|<\/script>$/g, "");
	p.window.document.body.appendChild(script);
	globalThis.__cwLive = p.window.__cwLive;
	p.input.blur();
	p.input.focus();
	await p.settle(5);
	assert.equal(p.requests.filter((u) => u.pathname === INDEX_ENDPOINT).length, 1, "index requested once tools exist");
	assert.equal(p.requests.filter((u) => u.searchParams.get("warm") === "1").length, 1, "one warm-up all told");
	p.type("coy");
	assert.deepEqual(p.rows(), ["/coywolf", "/coyote"], "instant from then on");
	await done(p);
});

test("SearchBox: a picked row the server's answer drops leaves nothing active (Enter submits)", async () => {
	const p = await page({ limit: 2, delay: 40 });
	p.input.focus();
	await p.settle(5);
	p.type("coy");
	p.key("ArrowDown");
	p.key("ArrowDown");
	assert.equal(p.input.getAttribute("aria-activedescendant"), "s-list-1");
	await p.settle(120);
	// The server's two rows for "coy" are Coywolf and Coyote again here; drop Coyote by changing the answer.
	assert.ok(p.list.querySelector("[aria-selected=true]") !== null, "still there: still picked");
	ANSWERS.coyo = [{ title: "What is a jackal?", url: "/jackal/", type: "Term", snippet: "" }];
	p.type("coyo");
	p.key("ArrowDown");
	assert.equal(p.list.querySelector("[aria-selected=true]")?.getAttribute("href"), "/coyote");
	await p.settle(120);
	assert.deepEqual(p.rows(), ["/coyote", "/jackal/"], "the unconfirmed title match stays, the server's row follows");
	p.type("coyot");
	assert.equal(p.list.querySelector("[aria-selected=true]")?.id ?? null, null, "a new query starts with nothing picked");
	assert.equal(p.input.hasAttribute("aria-activedescendant"), false);
	delete ANSWERS.coyo;
	await done(p);
});

test("SearchBox: a re-render never leaves aria-activedescendant on a row that isn't selected", async () => {
	const p = await page({ limit: 2, delay: 40 });
	p.input.focus();
	await p.settle(5);
	ANSWERS.wo = [{ title: "What is a jackal?", url: "/jackal/", type: "Term", snippet: "" }, { title: "Who is Wolfgang?", url: "/wolfgang/", type: "Term", snippet: "" }];
	p.type("wo");
	assert.deepEqual(p.rows(), ["/wolf"]);
	p.key("ArrowDown");
	assert.equal(p.input.getAttribute("aria-activedescendant"), "s-list-0");
	await p.settle(120);
	// The merge keeps /wolf (unconfirmed) only while there's room; with limit 2 the server's rows win.
	// Ids, not elements: a failing assert.equal on happy-dom nodes takes minutes to print.
	const selected = p.list.querySelector("[aria-selected=true]")?.id ?? null;
	const pointed = p.input.getAttribute("aria-activedescendant");
	assert.equal(pointed, selected, "the attribute and the selection agree");
	delete ANSWERS.wo;
	await done(p);
});

test("SearchBox: back in the box, the list shows the current query, never an older one's rows", async () => {
	const p = await page({ delay: 40 });
	p.input.focus();
	await p.settle(5);
	p.type("coy");
	await p.settle(120);
	p.type("alzz"); // no title matches: the "coy" rows stay while the server is asked
	p.input.blur();
	await p.settle(120); // answered while away: cached, not shown
	assert.equal(p.list.hidden, true);
	p.input.focus();
	assert.equal(p.list.hidden, false);
	assert.deepEqual(p.rows(), [], "the answer for alzz (nothing), not coy's rows");
	assert.match(p.list.textContent, /No matching results/);
	await done(p);
});

test("SearchBox: Escape closes the list for good: a pending answer or announcement doesn't bring it back", async () => {
	const p = await page({ delay: 60 });
	p.input.focus();
	await p.settle(5);
	p.type("coy");
	await p.settle(50); // the request is in flight
	p.key("Escape");
	assert.equal(p.list.hidden, true);
	await p.settle(900);
	assert.equal(p.list.hidden, true, "the answer arrived and stayed hidden");
	assert.equal(p.status.textContent, "", "and the instant rows' delayed announcement never fired");
	p.type("coyo");
	assert.equal(p.list.hidden, false, "typing opens it again");
	await done(p);
});

test("SearchBox: titles use the server's and the matcher's highlighting (accents, substrings), escaped", async () => {
	const p = await page({ delay: 10 });
	ANSWERS.ecole = [{ title: "Ecole <b>x</b>", titleHtml: "<mark>École</mark> &lt;b&gt;x&lt;/b&gt;<img src=x>", url: "/ecole/", type: "Term", snippet: "" }];
	p.input.focus();
	await p.settle(5);
	p.type("ecole");
	await p.settle(80);
	const title = p.list.querySelector(".cw-search__title span");
	assert.equal(title.querySelector("mark").textContent, "École");
	assert.equal(title.querySelectorAll("img").length, 0, "only <mark> survives");
	delete ANSWERS.ecole;
	await done(p);
});

test("SearchBox: an answer that arrived while the visitor was away shows on refocus, even with no rows before", async () => {
	const p = await page({ withClient: false, delay: 40 });
	p.input.focus();
	p.type("coy");
	p.input.blur();
	await p.settle(120);
	assert.equal(p.list.hidden, true, "not shown while away");
	p.input.focus();
	assert.deepEqual(p.rows(), ["/coywolf/", "/coyote/", "/jackal/"]);
	await done(p);
});

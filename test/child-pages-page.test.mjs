// Run: node --test test/child-pages-page.test.mjs
//
// The real Child Pages page (src/admin/childPages.tsx, compiled by test/tsx-loader.mjs) in happy-dom, with a
// fake childPages/status and childPages/tree: a page that loaded before any collection had the Parent page
// field shows its tree as soon as one has it (it used to say "Loading the page tree…" until a full reload),
// and the list of changes names the page a change was made to. The logic alone is in test/child-pages-admin.test.mjs.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import "./tsx-loader.mjs";

const API = "/_emdash/api/plugins/coywolf-pack/childPages";

let window;
let h;
let act;
let createRoot;
let Toasty;
let ChildPagesPage;
before(async () => {
	const { Window } = await import("happy-dom");
	window = new Window({ url: "https://example.com/_emdash/admin/plugins/coywolf-pack/child-pages" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "sessionStorage", "KeyboardEvent", "Event", "CustomEvent"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	const React = await import("react");
	h = React.createElement;
	act = React.act;
	({ createRoot } = await import("react-dom/client"));
	({ Toasty } = await import("@cloudflare/kumo"));
	({ ChildPagesPage } = await import("../src/admin/childPages.tsx"));
});
after(async () => {
	await window?.happyDOM.close();
});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const collection = (slug, label, field) => ({ collection: slug, label, field, conflict: null, urlPattern: "/{slug}/", nests: field ? "field" : null });
const treePage = (id, title, slug) => ({ id, title, slug, url: `/${slug}/`, status: "published", parentId: null, chosenParentId: null, depth: 0, pendingChanges: false, warnings: [] });

/** A fake server over `site`: `{ collections, changes?, trees: { [collection]: pages } }`, changed by the test as Set up would. */
function server(site) {
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		const call = { url: String(url), body: init.body ? JSON.parse(init.body) : undefined };
		calls.push(call);
		const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
		if (call.url === `${API}/status`) return reply({ data: { enabled: true, redirects: true, slugChanges: true, pageParents: 0, collections: site.collections, changes: site.changes ?? [], open: [] } });
		if (call.url === `${API}/tree`) return reply({ data: { pages: site.trees[call.body.collection] ?? [], nested: true } });
		return reply({ error: { message: "not found" } }, 404);
	};
	return { treeReads: () => calls.filter((c) => c.url === `${API}/tree`).map((c) => c.body.collection) };
}

const settle = () =>
	act(async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});

async function renderPage() {
	const main = window.document.createElement("main");
	window.document.body.appendChild(main);
	const root = createRoot(main);
	await act(async () => root.render(h(Toasty, null, h(ChildPagesPage))));
	await settle();
	return {
		text: () => main.textContent,
		async refresh() {
			await act(async () => [...main.querySelectorAll("button")].find((b) => b.textContent.trim() === "Refresh").click());
			await settle();
		},
		async unmount() {
			await act(async () => root.unmount());
			main.remove();
		},
	};
}

test("the page tree: an empty state while no collection has the field, and the tree once one does, without a reload", async () => {
	const site = { collections: [collection("pages", "Pages", false), collection("docs", "Docs", false)], trees: { pages: [treePage("a", "Coywolf apps", "apps")], docs: [] } };
	const api = server(site);
	const page = await renderPage();
	try {
		assert.match(page.text(), /No collection has a Parent page field yet/);
		assert.doesNotMatch(page.text(), /Loading the page tree/);
		assert.deepEqual(api.treeReads(), [], "nothing to read");

		// Set up adds the field to Pages, and the page reads its status again (what Refresh does too).
		site.collections = [collection("pages", "Pages", true), collection("docs", "Docs", false)];
		await page.refresh();
		assert.deepEqual(api.treeReads(), ["pages"]);
		assert.doesNotMatch(page.text(), /Loading the page tree|No collection has a Parent page field yet/);
		assert.match(page.text(), /1 page\./);
		assert.match(page.text(), /Coywolf apps/);

		// The field is taken off again: back to the empty state, not the old tree and not a spinner.
		site.collections = [collection("pages", "Pages", false), collection("docs", "Docs", false)];
		await page.refresh();
		assert.match(page.text(), /No collection has a Parent page field yet/);
		assert.doesNotMatch(page.text(), /Loading the page tree|1 page\./);

		// Another collection gets it: its (empty) tree is read and shown.
		site.collections = [collection("pages", "Pages", false), collection("docs", "Docs", true)];
		await page.refresh();
		assert.equal(api.treeReads().at(-1), "docs");
		assert.match(page.text(), /0 pages\.No pages yet\./);
	} finally {
		await page.unmount();
	}
});

test("the latest changes name the page each was made to", async () => {
	const change = (reason, page) => ({ at: "2026-11-15T12:00:00.000Z", collection: "pages", label: "Pages", reason, ...(page ? { page } : {}), moved: 1, written: 1, skipped: 0, redirectsOff: false });
	server({
		collections: [collection("pages", "Pages", true)],
		trees: { pages: [] },
		changes: [change("A page was published", { title: "Coywolf Apps", url: "/apps/" }), { ...change("A page was unpublished", { url: "/tools/" }), at: "2026-11-14T12:00:00.000Z" }, { ...change("A page was saved"), at: "2026-11-13T12:00:00.000Z" }],
	});
	const page = await renderPage();
	try {
		assert.match(page.text(), /: “Coywolf Apps” was published\. 1 more page moved with it; 1 redirect added\./);
		assert.match(page.text(), /: the page at \/tools\/ was unpublished\. /);
		assert.match(page.text(), /: a page was saved\. /, "a change stored before pages were named");
	} finally {
		await page.unmount();
	}
});

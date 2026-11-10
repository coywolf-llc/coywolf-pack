// Run: node --test test/editor-panels.test.mjs
//
// The entry editor panels and the content-list column (src/admin/editor-panels.tsx,
// src/admin/extensions.ts): when they show, what they're made of, and the server pieces they read
// (one entry's schema override and links; a whole list page's link problems in one request).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { packPageOn, adminManifest, EDITOR_PANELS, LIST_COLUMNS, ADMIN_ROLE } = await import("../src/admin/extensions.ts");
const { goTo } = await import("../src/admin/router.ts");
const { summarizeEntryLinks } = await import("../src/links/store.ts");

/** EmDash's admin router as the pack sees it: on window, with the React Query client on its context. */
function scope(manifest) {
	return {
		__TSR_ROUTER__: {
			navigate() {},
			history: { block: () => () => {} },
			options: { basepath: "/_emdash/admin", context: { queryClient: { getQueryData: (key) => (JSON.stringify(key) === '["manifest"]' ? manifest : undefined) } } },
		},
	};
}

const manifest = (pages, extra = {}) => ({ plugins: { "coywolf-pack": { enabled: true, adminPages: pages.map((path) => ({ path, label: path })), ...extra } } });

test("a panel shows while its module's page is in the admin's sidebar (the manifest), and never when that can't be read", () => {
	const on = scope(manifest(["/features", "/performance", "/schema", "/links"]));
	assert.equal(packPageOn("/schema", on), true);
	assert.equal(packPageOn("/links", on), true);
	assert.equal(packPageOn("/ai", on), false, "AI Enrichment is off: its page isn't listed");
	assert.equal(packPageOn("/schema", scope(manifest(["/schema"], { enabled: false }))), false, "the plugin is disabled");
	assert.equal(packPageOn("/schema", scope(undefined)), false, "no manifest loaded yet");
	assert.equal(packPageOn("/schema", {}), false, "no router");
	assert.equal(packPageOn("/schema", { __TSR_ROUTER__: { ...scope(undefined).__TSR_ROUTER__, options: { basepath: "/other" } } }), false, "another router");
	assert.deepEqual(adminManifest(on)?.plugins["coywolf-pack"].adminPages.length, 4);
});

test("the panels and the column: valid for EmDash (ids, titles, finite order and role), admins only, one per module page", () => {
	assert.deepEqual(EDITOR_PANELS.map((p) => [p.id, p.page]), [["schema", "/schema"], ["ai", "/ai"], ["links", "/links"]]);
	for (const panel of [...EDITOR_PANELS, ...LIST_COLUMNS]) {
		assert.ok(panel.id.trim() && (panel.title ?? panel.label).trim(), panel.id);
		assert.ok(Number.isFinite(panel.order) && Number.isFinite(panel.minRole), panel.id);
		assert.equal(panel.minRole, ADMIN_ROLE, "the routes need plugins:manage");
	}
	assert.equal(new Set(EDITOR_PANELS.map((p) => p.id)).size, EDITOR_PANELS.length);
	assert.deepEqual(LIST_COLUMNS.map((c) => [c.id, c.page, c.align]), [["links", "/links", "end"]]);
	// The admin entry exports them under the names EmDash reads, with a predicate per page and the component per id.
	const index = readFileSync(new URL("../src/admin/index.tsx", import.meta.url), "utf8");
	assert.match(index, /export \{ contentEditorPanels, contentListColumns \} from "\.\/editor-panels\.js";/);
	const panels = readFileSync(new URL("../src/admin/editor-panels.tsx", import.meta.url), "utf8");
	assert.match(panels, /export const contentEditorPanels = EDITOR_PANELS\.map\(\(\{ page, \.\.\.panel \}\) => \(\{ \.\.\.panel, component: PANEL_COMPONENTS\[panel\.id\], collections: \(\) => packPageOn\(page\) \}\)\);/);
	assert.match(panels, /export const contentListColumns = LIST_COLUMNS\.map\(\(\{ page, \.\.\.column \}\) => \(\{ \.\.\.column, cell: LinksCell, collections: \(\) => packPageOn\(page\) \}\)\);/);
	// The column's cells share one request per page (pageLinks, keyed by collection and the page's ids).
	assert.match(panels, /pageLinks\(props\.collection, ids\)/);
	assert.doesNotMatch(panels, /@tanstack\/react-query/, "a second React Query copy in dev has no client");
});

test("the Schema panel's link opens the entry's override: the query string goes to the router as search params", () => {
	const calls = [];
	const router = { navigate: (o) => calls.push(o), history: { block: () => () => {} }, options: { basepath: "/_emdash/admin" } };
	goTo("/plugins/coywolf-pack/schema?entry=posts%3A01ABC", { __TSR_ROUTER__: router });
	assert.deepEqual(calls, [{ to: "/plugins/coywolf-pack/schema", search: { entry: "posts:01ABC" } }]);
	goTo("/plugins/coywolf-pack/links", { __TSR_ROUTER__: router });
	assert.deepEqual(calls[1], { to: "/plugins/coywolf-pack/links" });
	const loads = [];
	goTo("/plugins/coywolf-pack/schema?entry=posts%3A1", { location: { assign: (url) => loads.push(url) } });
	assert.deepEqual(loads, ["/_emdash/admin/plugins/coywolf-pack/schema?entry=posts%3A1"]);
	// The Schema page reads it back (schema.tsx entryFromSearch; the same parsing, checked on the source).
	const schema = readFileSync(new URL("../src/admin/schema.tsx", import.meta.url), "utf8");
	assert.match(schema, /export function entryFromSearch\(search: string\)/);
	assert.match(schema, /useState\(openEntry \? "overrides" : "site"\)/);
});

test("an entry's links by status: each URL once, ignored ones left out", () => {
	const ref = (entryKey, urlId) => ({ entryKey, urlId, collection: "posts", entryId: entryKey.split("/")[1], title: "", entryStatus: "published", kinds: ["link"], anchors: [], count: 1, seenAt: "" });
	const url = (status, ignored = false) => ({ url: "https://x.test/", resolved: "https://x.test/", host: "x.test", internal: false, ignored, status, rank: 0, code: null, finalUrl: null, chain: [], note: "", checkedAt: null, nextCheckAt: "", firstSeen: "" });
	const urls = new Map([
		["u1", url("broken")],
		["u2", url("blocked")],
		["u3", url("ok")],
		["u4", url("broken", true)],
		["u5", url("error")],
	]);
	const summary = summarizeEntryLinks([ref("posts/a", "u1"), ref("posts/a", "u1"), ref("posts/a", "u2"), ref("posts/a", "u3"), ref("posts/a", "u4"), ref("posts/b", "u5"), ref("posts/b", "missing")], urls);
	assert.deepEqual(summary.get("posts/a"), { total: 3, broken: 1, error: 0, blocked: 1, redirect: 0, unchecked: 0 });
	assert.deepEqual(summary.get("posts/b"), { total: 1, broken: 0, error: 1, blocked: 0, redirect: 0, unchecked: 0 });
	assert.equal(summary.get("posts/c"), undefined);
});

test("the column reads a page of entries' references in one statement per 90 (the entryKey index), not one per row", async () => {
	const store = readFileSync(new URL("../src/links/store.ts", import.meta.url), "utf8");
	assert.match(store, /json_extract\(data, '\$\.entryKey'\) IN \(\$\{part\.map\(\(\) => "\?"\)\.join\(", "\)\}\)/);
	assert.match(store, /for \(let i = 0; i < unique\.length; i \+= 90\)/);
	const module = readFileSync(new URL("../src/links/module.ts", import.meta.url), "utf8");
	assert.match(module, /"links\/entries\/status": readOnlyRoute\(/);
	assert.match(module, /ids: z\.array\(z\.string\(\)\.min\(1\)\.max\(200\)\)\.max\(200\)/);
});

test("custom markup's types for the Schema panel's summary", async () => {
	const { markupTypes } = await import("../src/schema/module.ts");
	assert.deepEqual(markupTypes('{"@type":"FAQPage"}'), ["FAQPage"]);
	assert.deepEqual(markupTypes('[{"@type":["HowTo","Thing"]},{"@type":"HowTo"}]'), ["HowTo", "Thing"]);
	assert.deepEqual(markupTypes('{"@context":"https://schema.org","@graph":[{"@type":"Event"},{"@type":"Place"}]}'), ["Event", "Place"]);
	assert.deepEqual(markupTypes("not json"), []);
});

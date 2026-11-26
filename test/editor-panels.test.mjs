// Run: node --test test/editor-panels.test.mjs
//
// The entry editor panels and the content-list column (src/admin/editor-panels.tsx,
// src/admin/extensions.ts): when they show, what they're made of, and the server pieces they read
// (one entry's schema override and links; a whole list page's link problems in one request).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { packPageOn, adminManifest, collectionHasField, extensionShows, EDITOR_PANELS, LIST_COLUMNS, ADMIN_ROLE } = await import("../src/admin/extensions.ts");
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
	assert.deepEqual(EDITOR_PANELS.map((p) => [p.id, p.page]), [["childPages", "/child-pages"], ["schema", "/schema"], ["ai", "/ai"], ["links", "/links"], ["buttondown", "/buttondown"]]);
	assert.equal(new Set(EDITOR_PANELS.map((p) => p.order)).size, EDITOR_PANELS.length, "no two panels share an order");
	for (const panel of [...EDITOR_PANELS, ...LIST_COLUMNS]) {
		assert.ok(panel.id.trim() && (panel.title ?? panel.label).trim(), panel.id);
		assert.ok(Number.isFinite(panel.order) && Number.isFinite(panel.minRole), panel.id);
		assert.equal(panel.minRole, ADMIN_ROLE, "the routes need plugins:manage");
	}
	assert.equal(new Set(EDITOR_PANELS.map((p) => p.id)).size, EDITOR_PANELS.length);
	assert.deepEqual(LIST_COLUMNS.map((c) => [c.id, c.page, c.align]), [["parent", "/child-pages", "start"], ["links", "/links", "end"]]);
	// The admin entry exports them under the names EmDash reads, with a predicate per page and the component per id.
	const index = readFileSync(new URL("../src/admin/index.tsx", import.meta.url), "utf8");
	assert.match(index, /export \{ contentEditorPanels, contentListColumns \} from "\.\/editor-panels\.js";/);
	const panels = readFileSync(new URL("../src/admin/editor-panels.tsx", import.meta.url), "utf8");
	assert.match(panels, /export const contentEditorPanels = EDITOR_PANELS\.map\(\(\{ page, \.\.\.panel \}\) => \(\{ \.\.\.panel, component: PANEL_COMPONENTS\[panel\.id\], collections: \(collection: string\) => extensionShows\(panel\.id, page, collection\), \.\.\.\(PANEL_VISIBLE\[panel\.id\] \? \{ isVisible: PANEL_VISIBLE\[panel\.id\] \} : \{\}\) \}\)\);/);
	// Buttondown's panel also asks whether a rule covers the collection (EmDash's isVisible), sharing the panel's own read.
	assert.match(panels, /const PANEL_VISIBLE: .+? = \{ buttondown: buttondownPanelVisible \};/);
	assert.match(panels, /export const contentListColumns = LIST_COLUMNS\.map\(\(\{ page, \.\.\.column \}\) => \(\{ \.\.\.column, cell: COLUMN_CELLS\[column\.id\], collections: \(collection: string\) => extensionShows\(column\.id, page, collection\) \}\)\);/);
	// The columns' cells share one request per page (pageLinks, pageParents: keyed by collection and the page's ids).
	assert.match(panels, /pageLinks\(props\.collection, ids\)/);
	assert.match(panels, /pageParents\(props\.collection, ids\)/);
	assert.doesNotMatch(panels, /@tanstack\/react-query/, "a second React Query copy in dev has no client");
	// The AI panel's AI Enrich button: only with EmDash 1.6's editorDraft (absent on older hosts), and only when a click could do something.
	assert.match(panels, /editorDraft\?: EditorDraft;/);
	assert.match(panels, /const showEnrich = Boolean\(draft\) && \(Boolean\(data\?\.enrich\?\.available\) \|\| runState\(runKey\(collection, entry\.id\)\)\.phase !== "idle"\);/);
	// One wrapper with or without the button: the suggestions below never remount when it appears.
	assert.doesNotMatch(panels, /enrich \? \(/);
	assert.match(panels, /<div className="space-y-3">\s*\{enrich\}\s*<AiSuggestions /);
	// The review isn't closed by a click on the backdrop (behavior: test/enrich-panel.test.mjs).
	assert.match(readFileSync(new URL("../src/admin/enrich.tsx", import.meta.url), "utf8"), /<PackDialog\.Root open disablePointerDismissal /);
});

test("Child Pages' panel and Parent column show only in collections with the Parent page field (a reference field in the manifest)", () => {
	const withField = (fields) => ({ ...manifest(["/child-pages", "/links"]), collections: { pages: { fields }, posts: { fields: { title: { kind: "string" } } } } });
	const on = scope(withField({ parent_page: { kind: "reference" } }));
	assert.equal(extensionShows("childPages", "/child-pages", "pages", on), true);
	assert.equal(extensionShows("parent", "/child-pages", "pages", on), true);
	assert.equal(extensionShows("childPages", "/child-pages", "posts", on), false, "no field on posts");
	assert.equal(extensionShows("links", "/links", "posts", on), true, "the Links column needs no field");
	assert.equal(extensionShows("childPages", "/child-pages", "pages", scope(withField({ parent_page: { kind: "string" } }))), false, "a parent_page that isn't a reference");
	assert.equal(extensionShows("childPages", "/child-pages", "pages", scope({ ...withField({ parent_page: { kind: "reference" } }), plugins: manifest(["/links"]).plugins })), false, "Child Pages is off");
	assert.equal(collectionHasField("pages", "parent_page", scope(undefined)), false, "no manifest yet");
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

test("a collection is dated (its entries are articles) only with a custom date field, not EmDash 1.5's system date columns", async () => {
	const { isDatedCollection } = await import("../src/schema/module.ts");
	assert.equal(isDatedCollection({ dateField: "eventDate" }), true);
	for (const system of ["publishedAt", "createdAt", "updatedAt"]) assert.equal(isDatedCollection({ dateField: system }), false, system);
	assert.equal(isDatedCollection({ dateField: null }), false);
	assert.equal(isDatedCollection({}), false);
	assert.equal(isDatedCollection(undefined), false);
});

test("byline avatars in JSON-LD use the public media address, never EmDash's sign-in-only asset URL", async () => {
	const { publicAvatarUrl, resolveAssetUrls } = await import("../src/schema/module.ts");
	const ctx = (url) => ({ media: { get: async () => (url ? { url } : null) } });
	const asset = ctx("/_emdash/api/media/asset/01M41A5F7JYHVSYM3JAXFDJZ4Z/jon-henshaw.png");
	// The storage key (one cached read) gives the public file route.
	assert.equal(await publicAvatarUrl(asset, "01M41A5F7JYHVSYM3JAXFDJZ4Z", async () => "01M41A5F7JYHVSYM3JAXFDJZ4Z.png"), "/_emdash/api/media/file/01M41A5F7JYHVSYM3JAXFDJZ4Z.png");
	// Not found (or not ready): no image rather than a broken one.
	assert.equal(await publicAvatarUrl(asset, "01M41A5F7JYHVSYM3JAXFDJZ4Z", async () => null), null);
	// Can't read the database here: the plugin API's URL only when it's a public one.
	assert.equal(await publicAvatarUrl(asset, "01M41A5F7JYHVSYM3JAXFDJZ4Z", async () => undefined), null);
	assert.equal(await publicAvatarUrl(ctx("/_emdash/api/media/file/m1.jpg"), "m1", async () => undefined), "/_emdash/api/media/file/m1.jpg");
	assert.equal(await publicAvatarUrl(ctx("/x"), null), null);

	// A JSON-LD value with an asset URL saved by the old image picker: replaced with the public file route.
	const graph = { "@graph": [{ "@type": "Organization", logo: "https://example.com/_emdash/api/media/asset/LOGO1/logo.png" }, { image: ["/_emdash/api/media/asset/IMG2/a.jpg", "https://example.com/other.png"] }] };
	let reads = 0;
	await resolveAssetUrls(graph, async (id) => (reads++, { LOGO1: "LOGO1.png", IMG2: "IMG2.jpg" })[id]);
	assert.equal(graph["@graph"][0].logo, "https://example.com/_emdash/api/media/file/LOGO1.png");
	assert.deepEqual(graph["@graph"][1].image, ["/_emdash/api/media/file/IMG2.jpg", "https://example.com/other.png"]);
	assert.equal(reads, 2);
	await resolveAssetUrls({ "@graph": [{ name: "No media here" }] }, async () => assert.fail("no read without an asset URL"));
});

test("the Buttondown panel: shown only where a rule covers the collection, with one read shared by EmDash's isVisible and the panel", async () => {
	const { buttondownEntry, buttondownPanelVisible, badgeLabel, STATE_BADGE, timeAgo } = await import("../src/admin/buttondown-core.ts");
	const asked = [];
	const fetcher = async (body) => (asked.push(body), { covered: body.collection === "posts" });
	assert.equal((await buttondownEntry("posts", "1", "v1", { fetcher, now: 0 })).covered, true);
	assert.equal((await buttondownEntry("posts", "1", "v1", { fetcher, now: 1000 })).covered, true);
	assert.equal(asked.length, 1, "the second ask (the panel after isVisible) reuses the first");
	await buttondownEntry("posts", "1", "v2", { fetcher, now: 1000 });
	assert.equal(asked.length, 2, "a saved entry (a new updatedAt) reads again");
	await buttondownEntry("posts", "1", "v2", { fetcher, now: 1000, fresh: true });
	assert.equal(asked.length, 3, "after a button: fresh");
	assert.equal((await buttondownEntry("pages", "1", "", { fetcher, now: 0 })).covered, false);
	// The visibility check never throws: a failed read hides the panel.
	assert.equal(await buttondownPanelVisible({ collection: "broken", entry: { id: "x", updatedAt: "never-read-before" } }).catch(() => "threw"), false);
	// Badges: the state in a word or two, Buttondown's own status for an email the Pack leaves alone.
	assert.equal(badgeLabel({ state: "left", remoteStatus: "about_to_send" }), "About to send");
	assert.equal(badgeLabel({ state: "draft", remoteStatus: "draft" }), "Draft");
	assert.equal(STATE_BADGE.error.variant, "error");
	for (const [state, b] of Object.entries(STATE_BADGE)) assert.ok(b.label && b.variant, state);
	assert.equal(timeAgo(new Date(Date.now() - 120_000).toISOString()), "2 minutes ago");
	assert.equal(timeAgo("nope"), "");
	// The panel's actions: Refresh asks first (it overwrites changes made in Buttondown).
	const panels = readFileSync(new URL("../src/admin/editor-panels.tsx", import.meta.url), "utf8");
	assert.match(panels, /title: "Refresh the draft from the post\?"/);
	assert.match(panels, /Create draft now/);
});

// Run: node --test test/child-pages-admin.test.mjs
//
// The Child Pages admin page's logic (src/admin/childPages-core.ts): which collection the page tree
// shows as the collections change under it (Set up adds the first field after the page has loaded),
// and the wording of a change, which names the page it was made to.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { changeReason, changeText, treeCollection } = await import("../src/admin/childPages-core.ts");

const c = (collection, field) => ({ collection, field });

test("treeCollection: none while no collection has the field, then the one Set up adds, without a reload", () => {
	const before = [c("pages", false), c("docs", false)];
	assert.equal(treeCollection([], null), "");
	assert.equal(treeCollection(before, null), "", "nothing to load: the page says so instead of loading forever");
	// Set up adds the field to Pages; the status is read again and the same component renders with it.
	assert.equal(treeCollection([c("pages", true), c("docs", false)], null), "pages");
	assert.equal(treeCollection([c("pages", false), c("docs", true)], null), "docs", "the first with the field when Pages has none");
});

test("treeCollection: Pages first; a chosen collection is kept while it has the field, and dropped when it doesn't", () => {
	const both = [c("docs", true), c("pages", true)];
	assert.equal(treeCollection(both, null), "pages");
	assert.equal(treeCollection(both, "docs"), "docs");
	assert.equal(treeCollection([c("docs", false), c("pages", true)], "docs"), "pages", "its field was removed");
	assert.equal(treeCollection([c("pages", true)], "gone"), "pages", "the collection was deleted");
	assert.equal(treeCollection([c("docs", false)], "docs"), "");
});

const change = (reason, page, extra = {}) => ({ at: "2026-11-15T00:00:00.000Z", collection: "pages", label: "Pages", reason, ...(page ? { page } : {}), moved: 2, written: 2, skipped: 0, redirectsOff: false, ...extra });

test("changeReason: a change to a page names it by its title, or by its URL when it has no title", () => {
	assert.equal(changeReason(change("A page was published", { title: "Coywolf Pack", url: "/apps/coywolf-pack/" })), "“Coywolf Pack” was published");
	assert.equal(changeReason(change("A page was moved to the trash", { url: "/apps/" })), "the page at /apps/ was moved to the trash");
	assert.equal(changeReason(change("A page was unpublished", { title: "  ", url: "/apps/" })), "the page at /apps/ was unpublished");
	assert.equal(changeReason(change("A page's slug changed", { title: "Coywolf apps" })), "the slug of “Coywolf apps” changed");
	assert.equal(changeReason(change("A page's slug changed", { url: "/tools/" })), "the slug of the page at /tools/ changed");
	assert.equal(changeReason(change("A page was saved", { title: "iPhone Tips" })), "“iPhone Tips” was saved", "the title keeps its capitals");
});

test("changeReason: a change with no page known (an older one, the switch, Re-check) reads as before", () => {
	assert.equal(changeReason(change("A page was published")), "a page was published");
	assert.equal(changeReason(change("A page was deleted", {})), "a page was deleted");
	assert.equal(changeReason(change("Redirects re-checked")), "redirects re-checked");
	assert.equal(changeReason(change("Redirects re-checked", { title: "Stray" })), "redirects re-checked", "only a page's change is given a name");
});

test("changeText: the pages that moved with a page's change, and the redirects made", () => {
	assert.equal(changeText(change("A page was published", { title: "Coywolf apps" })), "2 more pages moved with it; 2 redirects added.");
	assert.equal(changeText(change("Redirects re-checked", null, { moved: 1, written: 1 })), "1 page moved; 1 redirect added.");
	assert.match(changeText(change("A page was published", null, { failed: "D1 down" })), /couldn't be worked out \(D1 down\)/);
});

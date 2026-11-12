import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { buildPending, snapshotFromRow, snapshotFromContent, pendingId, shouldDropApplied, appliedStillOurs, idsByCollection } = await import(
	"../src/redirects/removed-core.ts"
);
const { interpolateUrlPattern } = await import("../src/core/content-url.ts");

const now = new Date("2026-10-03T12:00:00Z");

test("deleted published entry: decision with the URL from the collection pattern", () => {
	const row = { id: "01J", slug: "red-wolf", status: "published", published_at: "2025-04-07 09:30:00", locale: "en", headline: "The Red Wolf" };
	const entry = snapshotFromRow(row, "headline");
	const pending = buildPending("posts", entry, { urlPattern: "/{year}/{month}/{slug}/" }, "deleted", now);
	assert.deepEqual(pending, {
		id: "posts:01J",
		collection: "posts",
		entryId: "01J",
		url: "/2025/04/red-wolf",
		title: "The Red Wolf",
		reason: "deleted",
		locale: "en",
		at: "2026-10-03T12:00:00.000Z",
	});
});

test("no URL pattern: EmDash's /<collection>/<slug> default", () => {
	const entry = snapshotFromRow({ id: "1", slug: "about", status: "published", title: "About" }, null);
	assert.equal(buildPending("pages", entry, undefined, "deleted", now).url, "/pages/about");
});

test("deleted drafts and entries without slugs need no decision", () => {
	const draft = snapshotFromRow({ id: "1", slug: "wip", status: "draft", title: "WIP" }, null);
	assert.equal(buildPending("posts", draft, undefined, "deleted", now), null);
	const noSlug = snapshotFromRow({ id: "2", slug: null, status: "published" }, null);
	assert.equal(buildPending("posts", noSlug, undefined, "deleted", now), null);
});

test("unpublished entry: from the hook's content record (status is already draft)", () => {
	const content = { id: "9", slug: "coyotes", status: "draft", publishedAt: "2024-01-02T03:04:05Z", locale: "en", data: { title: "Coyotes" } };
	const pending = buildPending("posts", snapshotFromContent(content, null), { urlPattern: "/blog/{slug}" }, "unpublished", now);
	assert.equal(pending.url, "/blog/coyotes");
	assert.equal(pending.title, "Coyotes");
	assert.equal(pending.reason, "unpublished");
	assert.equal(pending.id, pendingId("posts", "9"));
});

test("unpublished entry that was never published: nothing to decide", () => {
	const content = { id: "9", slug: "x", status: "draft", publishedAt: null, data: {} };
	assert.equal(buildPending("posts", snapshotFromContent(content, null), undefined, "unpublished", now), null);
});

test("title falls back to the slug", () => {
	const entry = snapshotFromRow({ id: "3", slug: "untitled", status: "published" }, "name");
	assert.equal(buildPending("posts", entry, undefined, "deleted", now).title, "untitled");
});

test("URL interpolation matches EmDash: encoding, {id}, repeated and trailing slashes, unresolved date tokens", () => {
	assert.equal(interpolateUrlPattern({ pattern: "/news//{slug}/", collection: "news", slug: "a b", id: "1" }), "/news/a%20b");
	assert.equal(interpolateUrlPattern({ pattern: "items/{id}", collection: "items", slug: "s", id: "42" }), "/items/42");
	assert.equal(interpolateUrlPattern({ pattern: "/{year}/{slug}", collection: "p", slug: "s", id: "1", date: null }), "/{year}/s");
	assert.equal(interpolateUrlPattern({ pattern: "/{year}/{month}/{day}/{slug}.html", collection: "p", slug: "s", id: "1", date: "2023-05-08 23:59:00" }), "/2023/05/08/s.html");
});

test("restore drops the rule its decision created (trailing slashes compared loosely)", () => {
	const applied = { url: "/human-generated-content/" };
	const rule = { source: "/human-generated-content", note: "Removed: Human content" };
	assert.equal(shouldDropApplied(applied, rule, null, "restore"), true);
});

test("a rule that was edited, replaced, or deleted since is left alone", () => {
	const applied = { url: "/a" };
	assert.equal(shouldDropApplied(applied, null, null, "restore"), false);
	assert.equal(shouldDropApplied(applied, { source: "/b", note: "Removed: A" }, null, "restore"), false);
	assert.equal(shouldDropApplied(applied, { source: "/a", note: "Moved to the new guide" }, null, "restore"), false);
	assert.equal(shouldDropApplied(applied, { source: "/a", note: null }, null, "restore"), false);
});

test("republishing drops the rule only when the entry is back at the same URL", () => {
	const applied = { url: "/blog/coyotes" };
	const rule = { source: "/blog/coyotes", note: "Removed: Coyotes" };
	assert.equal(shouldDropApplied(applied, rule, "/blog/coyotes/", "publish"), true);
	assert.equal(shouldDropApplied(applied, rule, "/blog/coyotes-2", "publish"), false);
	assert.equal(shouldDropApplied(applied, rule, null, "publish"), false);
});

test("a rule is still ours only with the same source and our Removed: note", () => {
	assert.equal(appliedStillOurs({ url: "/a/" }, { source: "/a", note: "Removed: A" }), true);
	// An entry URL is built percent-encoded; the rule's source may be stored in another spelling.
	assert.equal(appliedStillOurs({ url: "/blog/caf%C3%A9/" }, { source: "/blog/café", note: "Removed: Café" }), true);
	assert.equal(appliedStillOurs({ url: "/blog/caf%C3%A9" }, { source: "/blog/caf%c3%a9", note: "Removed: Café" }), true);
	assert.equal(appliedStillOurs({ url: "/a" }, { source: "/a", note: "Moved" }), false);
	assert.equal(appliedStillOurs({ url: "/a" }, { source: "/b", note: "Removed: A" }), false);
	assert.equal(appliedStillOurs({ url: "/a" }, null), false);
});

test("entry ids are grouped by collection, without repeats", () => {
	const grouped = idsByCollection([
		{ collection: "posts", entryId: "1" },
		{ collection: "pages", entryId: "9" },
		{ collection: "posts", entryId: "2" },
		{ collection: "posts", entryId: "1" },
	]);
	assert.deepEqual([...grouped], [
		["posts", ["1", "2"]],
		["pages", ["9"]],
	]);
});

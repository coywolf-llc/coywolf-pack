// Run: node --test test/content-audit.test.mjs
// Content Audit: the per-entry checks (facts, not a score), duplicates across the
// site, and runs in bounded steps that store one chunk per page and keep trends.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeCollection, fakeKv, fakeSettings, quietLog } from "./fixtures/fake-plugin.mjs";

const checks = await import("../src/audit/checks.ts");
const run = await import("../src/audit/run.ts");
const { Ops } = await import("../src/links/store.ts");

const text = (key, words, style = "normal") => ({ _type: "block", _key: key, style, markDefs: [], children: [{ _type: "span", _key: `${key}s`, text: words, marks: [] }] });
const h = (level, key) => text(key, `Heading ${key}`, `h${level}`);
const image = (key, alt) => ({ _type: "image", _key: key, asset: { _ref: `m${key}`, url: `/_emdash/api/media/file/m${key}.jpg` }, ...(alt === undefined ? {} : { alt }) });
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

const SHAPE = { slug: "posts", hasSeo: true, titleField: "title", fields: [{ slug: "title", type: "string" }, { slug: "body", type: "portableText" }, { slug: "cover", type: "image" }] };
const NOW = Date.parse("2026-11-10T12:00:00Z");

const entry = (over = {}) => ({
	collection: "posts",
	id: "e1",
	title: "A good title for this post",
	data: { title: "A good title for this post", body: [h(2, "a"), text("p", words(400)), image("i", "A cat")], cover: { id: "m1", alt: "Cover" } },
	seo: { title: "A good SEO title for the post", description: "A description that is long enough to be useful in search results, but not too long.", image: null },
	updatedAt: "2026-10-01T00:00:00Z",
	...over,
});

test("a healthy entry has no findings", () => {
	assert.deepEqual(checks.checkEntry(entry(), SHAPE, checks.AUDIT_DEFAULTS, { now: NOW }), []);
});

test("each check reports a fact the editor can act on", () => {
	const bad = entry({
		title: "Hi",
		data: { title: "Hi", body: [h(1, "x"), h(2, "a"), h(4, "b"), text("p", words(20)), image("i"), { _type: "gallery", _key: "g", images: [{ asset: { _ref: "g1" } }, { asset: { _ref: "g2" }, alt: "ok" }] }], cover: { id: "m1" } },
		seo: { title: null, description: "Short", image: null },
		updatedAt: "2024-01-01T00:00:00Z",
	});
	const found = Object.fromEntries(checks.checkEntry(bad, { ...SHAPE }, checks.AUDIT_DEFAULTS, { now: NOW }));
	assert.equal(found.seoTitleMissing, "Uses the entry title: “Hi”");
	assert.match(found.titleLength, /^2 characters \(under 15\)$/);
	assert.match(found.descriptionLength, /^5 characters \(under 70\)$/);
	assert.equal(found.altMissing, "3 images", "the content image, one gallery image and the cover field");
	assert.equal(found.thin, "26 words", "headings count too");
	assert.equal(found.stale, "Last updated 2 years ago");
	const recent = Object.fromEntries(checks.checkEntry({ ...bad, updatedAt: "2025-09-01 08:00:00" }, SHAPE, checks.AUDIT_DEFAULTS, { now: NOW }));
	assert.equal(recent.stale, "Last updated 14 months ago", "SQLite's datetime format, read as UTC");
	assert.equal(found.headings, "2 H1s (the title and 1 in the content); H2 → H4");
	assert.equal(found.socialImageMissing, undefined, "the cover field is its own image");
});

test("a missing description, no social image, and checks that are off", () => {
	const e = entry({ data: { title: "A good title for this post", body: [text("p", words(400))] }, seo: { title: "A good SEO title for the post", description: "", image: null } });
	const found = Object.fromEntries(checks.checkEntry(e, SHAPE, checks.AUDIT_DEFAULTS, { now: NOW }));
	assert.equal(found.descriptionMissing, "No meta description");
	assert.equal(found.socialImageMissing, "No image of its own");
	assert.equal(found.descriptionLength, undefined);
	// A generated social image counts; a check that's off says nothing.
	const settings = { ...checks.AUDIT_DEFAULTS, off: ["descriptionMissing"] };
	assert.deepEqual(checks.checkEntry(e, SHAPE, settings, { now: NOW, hasGeneratedImage: true }), []);
});

test("collections without SEO or Portable Text skip the checks that don't apply", () => {
	const shape = { slug: "terms", hasSeo: false, titleField: "title", fields: [{ slug: "title", type: "string" }] };
	const e = entry({ collection: "terms", data: { title: "A glossary term name" }, seo: null });
	const found = checks.checkEntry(e, shape, checks.AUDIT_DEFAULTS, { now: NOW }).map(([c]) => c);
	assert.deepEqual(found, ["socialImageMissing"]);
});

test("headings: levels in order, H1 counting with and without the theme's title", () => {
	assert.deepEqual(checks.headingProblems([2, 3, 2, 3], true), []);
	assert.deepEqual(checks.headingProblems([3, 4], true), ["H1 → H3"]);
	assert.deepEqual(checks.headingProblems([1, 2], false), []);
	assert.deepEqual(checks.headingProblems([1, 1, 3], false), ["2 H1s", "H1 → H3"]);
	assert.deepEqual(checks.headingProblems([2, 4, 2, 4], true), ["H2 → H4"], "each skip once");
	// Nested blocks (columns) count, in document order.
	assert.deepEqual(checks.headingLevels([{ _type: "columns", columns: [{ content: [h(2, "a"), h(3, "b")] }] }, h(2, "c")]), [2, 3, 2]);
});

test("words and alt text read the content the way EmDash renders it", () => {
	assert.equal(checks.wordCount([text("a", "Don't stop — it's 3.5 times faster, e.g. here.")]), 8);
	assert.equal(checks.imagesWithoutAlt([image("a", ""), image("b", "  "), { _type: "image", _key: "c", asset: { _ref: "x", alt: "From the asset" } }]), 2);
});

test("text keys ignore case, spacing and end punctuation; groups are only duplicates", () => {
	assert.equal(checks.textKey("Hello  World!"), checks.textKey("hello world"));
	assert.notEqual(checks.textKey("Hello World"), checks.textKey("Hello Worlds"));
	assert.equal(checks.textKey("  "), null);
	assert.deepEqual([...checks.duplicateGroups(["a", "b", "a", null, "c", "a"]).values()], [[0, 2, 5]]);
});

test("settings: anything invalid falls back to the defaults", () => {
	assert.deepEqual(checks.normalizeAuditSettings(null), checks.AUDIT_DEFAULTS);
	const s = checks.normalizeAuditSettings({ off: ["thin", "nope"], thinWords: -1, staleMonths: 6, collections: ["posts", "Bad Slug"], titleIsH1: false });
	assert.deepEqual(s.off, ["thin"]);
	assert.equal(s.thinWords, checks.AUDIT_DEFAULTS.thinWords);
	assert.equal(s.staleMonths, 6);
	assert.deepEqual(s.collections, ["posts"]);
	assert.equal(s.titleIsH1, false);
});

// ── Runs ─────────────────────────────────────────────────────────

function fakeCtx(entries, { settings = {}, collections = ["posts"] } = {}) {
	const lists = [];
	return {
		lists,
		kv: fakeKv(),
		settings: fakeSettings(settings),
		storage: { audit_chunks: fakeCollection(), socialImages: fakeCollection(), links_urls: fakeCollection(), links_refs: fakeCollection() },
		log: quietLog(),
		schema: {
			async listCollections() {
				return collections.map((slug) => ({ slug, label: slug, routable: true, hidden: false, hasSeo: true, titleField: "title", supports: [], fields: SHAPE.fields }));
			},
		},
		content: {
			async list(collection, { limit, cursor }) {
				lists.push(collection);
				const all = entries.filter((e) => (e.collection ?? "posts") === collection);
				const start = cursor ? Number(cursor) : 0;
				const items = all.slice(start, start + limit).map((e) => ({ id: e.id, slug: e.id, status: "published", data: e.data, seo: e.seo, updatedAt: e.updatedAt }));
				const hasMore = start + limit < all.length;
				return { items, hasMore, cursor: hasMore ? String(start + limit) : undefined };
			},
		},
	};
}

const many = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => entry({ id: `e${i}`, title: `Post number ${i} with a long enough title`, data: { ...entry().data, title: `Post number ${i} with a long enough title` }, seo: { ...entry().seo, title: `SEO title number ${i} for post`, description: `Description number ${i}: long enough to be useful in search results, but not too long.` }, ...over(i) }));

async function runToEnd(ctx, ops = () => new Ops(40), options = { socialImages: false, links: false, now: NOW }) {
	let state = await run.auditStep(ctx, ops(), options);
	for (let i = 0; i < 100 && state.status === "running"; i++) state = await run.auditStep(ctx, ops(), options);
	return state;
}

resetSchema();
function resetSchema() {
	run.resetAuditSchemaCache();
}

test("a run pages through every entry in bounded steps, one chunk per page, then reports", async () => {
	resetSchema();
	const ctx = fakeCtx(many(120, (i) => (i % 40 === 0 ? { seo: { title: "Same SEO title for many", description: "", image: null } } : {})));
	await run.startRun(ctx, "admin");
	// A small budget: several steps.
	let steps = 0;
	let state = { status: "running" };
	while (state.status === "running" && steps < 50) {
		// The smallest scheduled step (Workers Free): 20 statements.
		state = await run.auditStep(ctx, new Ops(20), { socialImages: false, links: false, now: NOW });
		steps++;
	}
	assert.equal(state.status, "idle");
	assert.ok(steps > 2, `took ${steps} steps`);
	assert.equal(state.processed, 120);
	const report = await run.getReport(ctx);
	assert.equal(report.entries, 120);
	assert.equal(report.counts.titleDuplicate, 3, "entries 0, 40 and 80 share an SEO title");
	assert.equal(report.counts.descriptionMissing, 3);
	assert.equal(report.counts.socialImageMissing, 0, "every entry has a cover");
	assert.equal(report.previous, null);
	// 120 entries in pages of 50: 3 chunks plus the extra (duplicates) chunk.
	assert.equal(ctx.storage.audit_chunks.rows.size, 4);
	const dupes = await run.findings(ctx, "titleDuplicate");
	assert.deepEqual(dupes.map((f) => f.id).sort(), ["e0", "e40", "e80"]);
	assert.match(dupes[0].detail, /^Same as “Post number \d+ with a long enough title” and 1 more$/);
});

test("the next run compares with the last one, drops its chunks, and says what got worse", async () => {
	resetSchema();
	const entries = many(10);
	const ctx = fakeCtx(entries);
	await run.startRun(ctx, "scheduled");
	await runToEnd(ctx);
	const first = await run.getReport(ctx);
	assert.equal(first.entriesWithIssues, 0);
	assert.deepEqual(run.worsened(first), []);

	entries[3].seo = { ...entries[3].seo, description: "" };
	entries[4].data = { ...entries[4].data, body: [text("p", "Too short")] };
	await new Promise((r) => setTimeout(r, 5));
	await run.startRun(ctx, "scheduled");
	await runToEnd(ctx);
	const second = await run.getReport(ctx);
	assert.equal(second.previous.runId, first.runId);
	assert.deepEqual(run.trend(second), { descriptionMissing: 1, thin: 1 });
	assert.deepEqual(run.worsened(second).map((w) => w.check).sort(), ["descriptionMissing", "thin"]);
	assert.ok([...ctx.storage.audit_chunks.rows.values()].every((c) => c.runId === second.runId), "the first run's chunks are gone");
});

test("two steps at once: one runs, the other reports busy; a started run isn't restarted", async () => {
	resetSchema();
	const ctx = fakeCtx(many(60));
	const started = await run.startRun(ctx, "admin");
	assert.equal((await run.startRun(ctx, "scheduled")).runId, started.runId);
	const [a, b] = await Promise.all([run.auditStep(ctx, new Ops(40), { socialImages: false, links: false }), run.auditStep(ctx, new Ops(40), { socialImages: false, links: false })]);
	assert.equal([a, b].filter((s) => s.busy).length, 1);
});

test("generated social images count, and broken internal links come from Link Manager", async () => {
	resetSchema();
	const entries = many(3, () => ({ data: { title: "x", body: [text("p", words(400))] } }));
	const ctx = fakeCtx(entries);
	await ctx.storage.socialImages.put("posts:e1", { key: "coywolf-og/posts/e1-abc.png", status: "ready" });
	await ctx.storage.socialImages.put("posts:e0", { key: null, status: "pending" }); // Queued, not made yet: still missing.
	await ctx.storage.links_urls.put("u1", { url: "/gone/", internal: true, status: "broken", ignored: false });
	await ctx.storage.links_refs.put("posts/e2|u1", { urlId: "u1", entryKey: "posts/e2" });
	await run.startRun(ctx, "admin");
	await runToEnd(ctx, () => new Ops(40), { socialImages: true, links: true, now: NOW });
	const report = await run.getReport(ctx);
	assert.equal(report.counts.socialImageMissing, 2, "e1 has a generated image");
	assert.equal(report.counts.brokenLinks, 1);
	assert.equal(report.linksChecked, true);
	const broken = await run.findings(ctx, "brokenLinks");
	assert.deepEqual(broken.map((f) => [f.id, f.detail]), [["e2", "1 link: /gone/"]]);
});

test("only the chosen collections are audited, and a run can be cancelled", async () => {
	resetSchema();
	const ctx = fakeCtx([...many(2), ...many(2).map((e) => ({ ...e, collection: "pages" }))], { settings: { auditSettings: { collections: ["pages"] } }, collections: ["posts", "pages"] });
	const state = await run.startRun(ctx, "admin");
	assert.deepEqual(state.collections, ["pages"]);
	await run.cancelRun(ctx);
	assert.equal((await run.getRun(ctx)).status, "idle");
	await run.startRun(ctx, "admin");
	await runToEnd(ctx);
	assert.deepEqual([...new Set(ctx.lists)], ["pages"]);
});

test("progress is saved after every page, and a run that keeps failing stops with the error", async () => {
	resetSchema();
	const ctx = fakeCtx(many(120));
	await run.startRun(ctx, "admin");
	const put = ctx.storage.audit_chunks.put.bind(ctx.storage.audit_chunks);
	let puts = 0;
	ctx.storage.audit_chunks.put = async (id, data) => {
		if (++puts >= 2) throw new Error("D1 is down");
		return put(id, data);
	};
	await assert.rejects(run.auditStep(ctx, new Ops(40), { socialImages: false, links: false }), /D1 is down/);
	let state = await run.getRun(ctx);
	assert.equal(state.processed, 50, "the first page was kept");
	assert.equal(state.failures, 1);
	assert.equal(state.status, "running");
	for (let i = 0; i < 2; i++) await assert.rejects(run.auditStep(ctx, new Ops(40), { socialImages: false, links: false }), /D1 is down/);
	state = await run.getRun(ctx);
	assert.equal(state.status, "idle", "stopped after three failed steps in a row");
	assert.match(state.error, /stopped after 3 failed steps in a row: Error: D1 is down/);
});

test("text fields count toward words, headings are checked per field, a bare URL image isn't missing alt", () => {
	const shape = { ...SHAPE, fields: [...SHAPE.fields, { slug: "intro", type: "text" }, { slug: "sidebar", type: "portableText" }] };
	const e = entry({ data: { title: "A good title for this post", body: [h(2, "a"), text("p", words(200))], sidebar: [h(3, "b")], intro: words(150), cover: "https://cdn.example/cover.jpg" } });
	const found = Object.fromEntries(checks.checkEntry(e, shape, checks.AUDIT_DEFAULTS, { now: NOW }));
	assert.equal(found.thin, undefined, "200 + 150 words, plus headings");
	assert.equal(found.altMissing, undefined);
	assert.equal(found.headings, "H1 → H3", "the sidebar field starts at H3; the body's H2 doesn't hide it");
});

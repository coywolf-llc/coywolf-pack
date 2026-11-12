// Run: node --test test/coediting.test.mjs
// EmDash 1.5's co-editing (off on the sites for now): an open editor saves the entry every 2 to 10 seconds, each save
// fires content:beforeSave with only the changed fields and content:afterSave, and writes that send _rev meet a version
// conflict more often. The pack's hooks must not multiply work, lose the last save, touch fields a save didn't send, or
// fail an edit on a conflict.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { coalesced, AFTER_SAVE_HOLD_MS } = await import("../src/core/compose.ts");
const { isConflict } = await import("../src/core/conflict.ts");
const { stampContent } = await import("../src/headings/stamp.ts");
const { beforeSave: breadcrumbsBeforeSave } = await import("../src/breadcrumbs/pack.ts");
const { beforeSave: reviewsBeforeSave } = await import("../src/reviews/pack.ts");
const { draftSave } = await import("../src/social/pack.ts");

const save = (n, id = "e1") => ({ collection: "posts", content: { id, n } });

test("afterSave: saves of one entry during a run make one more run, with the newest event", async () => {
	const seen = [];
	let release;
	const first = new Promise((r) => (release = r));
	const run = async (event) => {
		seen.push(event.content.n);
		if (event.content.n === 1) await first;
	};
	const a = coalesced("links", save(1), run);
	await coalesced("links", save(2), run);
	await coalesced("links", save(3), run);
	assert.deepEqual(seen, [1], "the saves during the run waited");
	release();
	await a;
	assert.deepEqual(seen, [1, 3], "one more run, with the last save");
});

test("afterSave: different entries and different modules don't wait for each other", async () => {
	const seen = [];
	let release;
	const held = new Promise((r) => (release = r));
	const slow = async (event) => {
		seen.push(`${event.content.id}`);
		await held;
	};
	const a = coalesced("links", save(1, "e1"), slow);
	const b = coalesced("links", save(1, "e2"), slow);
	const c = coalesced("videos", save(1, "e1"), slow);
	assert.deepEqual(seen.sort(), ["e1", "e1", "e2"]);
	release();
	await Promise.all([a, b, c]);
});

test("afterSave: a run that never settles (a canceled request) stops holding saves back after a while", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const seen = [];
	void coalesced("ai", save(1, "stuck"), () => new Promise(() => {}));
	await coalesced("ai", save(2, "stuck"), async (e) => void seen.push(e.content.n));
	assert.deepEqual(seen, [], "held while the first run is recent");
	t.mock.timers.tick(AFTER_SAVE_HOLD_MS + 1);
	await coalesced("ai", save(3, "stuck"), async (e) => void seen.push(e.content.n));
	assert.deepEqual(seen, [3]);
});

test("afterSave: an event without an entry id runs as is", async () => {
	let ran = 0;
	await coalesced("links", { collection: "posts", content: {} }, async () => void ran++);
	await coalesced("links", { collection: "posts", content: {} }, async () => void ran++);
	assert.equal(ran, 2);
});

test("beforeSave with only the changed fields: hooks leave fields they weren't sent alone", async () => {
	const titleOnly = { title: "A new title" };
	assert.equal(stampContent(titleOnly, { anchors: true, toc: true, prefix: "", previous: null }), null);
	assert.equal(breadcrumbsBeforeSave({ content: titleOnly }), undefined);
	assert.equal(await reviewsBeforeSave({ content: titleOnly }), undefined);
	// A body-only save gets its anchors, and nothing else is added.
	const body = [{ _type: "block", _key: "h1", style: "h2", children: [{ _type: "span", text: "Hello world" }] }];
	const stamped = stampContent({ body }, { anchors: true, toc: true, prefix: "", previous: null });
	assert.deepEqual(Object.keys(stamped), ["body"]);
	assert.equal(stamped.body[0].anchor, "hello-world");
});

test("a version conflict is recognized in the forms EmDash raises it", () => {
	assert.equal(isConflict({ code: "CONFLICT", message: "x" }), true);
	assert.equal(isConflict({ status: 409 }), true);
	assert.equal(isConflict(new Error("Content has been modified since last read (version conflict)")), true);
	assert.equal(isConflict(Object.assign(new Error("x"), { name: "ContentMutationConflictError" })), true);
	assert.equal(isConflict(new Error("D1_ERROR: Network connection lost.")), false);
	assert.equal(isConflict(null), false);
});

test("Social Images: only saves that change the live page render, not draft saves", () => {
	assert.equal(draftSave({ status: "published", draftRevisionId: null }), false, "a collection without drafts: the save is the publish");
	assert.equal(draftSave({ status: "published", draftRevisionId: "r2", liveRevisionId: "r1" }), true, "an autosave or a room's save");
	assert.equal(draftSave({ status: "published", draftRevisionId: "r1", liveRevisionId: "r1" }), false);
	assert.equal(draftSave({ status: "draft" }), true);
});

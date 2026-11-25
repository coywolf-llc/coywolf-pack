/**
 * Unit tests for the AI Enrich panel's core (src/admin/enrich-core.ts): the
 * request body, the run from a click to a review or a message, the automatic
 * rounds (only while the draft is unchanged, at most 6), waiting for another
 * request and retrying a lost answer, Apply and its refusals, the description
 * box, and the run store that outlives the panel.
 * Run: node --import ./test/ts-resolve.mjs --test src/admin/enrich-core.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as EC from "./enrich-core.ts";

const core = EC as typeof import("./enrich-core.js");
type Answer = import("./enrich-core.js").EnrichAnswer;
type Op = import("./enrich-core.js").DraftOperation;
type PatchResult = import("./enrich-core.js").PatchResult;

// ── A fake editor draft, as EmDash 1.6's createContentEditorDraft behaves ──

function fakeDraft(values: Record<string, unknown> = { title: "Post", content: [{ _type: "block", _key: "b" }], slug: "post", "seo.description": null }) {
	const state = { values: structuredClone(values), counter: 0, last: JSON.stringify(values), readOnly: false, refuse: null as PatchResult | null, patches: [] as Array<{ ops: Op[]; expectedRevision: string }> };
	const revision = () => {
		const now = JSON.stringify(state.values);
		if (now !== state.last) {
			state.counter++;
			state.last = now;
		}
		return `rev:${state.counter}`;
	};
	const draft = {
		get: () => ({ revision: revision(), readOnly: state.readOnly, fields: structuredClone(state.values), fieldDefinitions: Object.keys(state.values).map((slug) => ({ slug, type: "string" })) }),
		patch(ops: readonly Op[], options: { expectedRevision: string }): PatchResult {
			state.patches.push({ ops: [...ops], expectedRevision: options.expectedRevision });
			if (revision() !== options.expectedRevision) return { ok: false, code: "EDITOR_DRAFT_STALE", message: "The draft changed after this revision was read." };
			if (state.readOnly) return { ok: false, code: "EDITOR_DRAFT_READ_ONLY", message: "The editor doesn't accept edits right now." };
			if (state.refuse) return state.refuse;
			for (const op of ops) state.values[op.field] = op.value;
			return { ok: true };
		},
	};
	return { draft, state, edit: (field: string, value: unknown) => void (state.values[field] = value) };
}

/** The route, scripted: each call takes the next answer (or throws it). */
function script(...answers: Array<Answer | Error | ((body: { round: number; draft: { revision: string } }) => Answer)>) {
	const bodies: Array<{ round: number; draft: { revision: string } }> = [];
	const waits: number[] = [];
	core.enrichIo.send = async (body: unknown) => {
		bodies.push(body as never);
		const next = answers.shift();
		if (!next) throw new Error("no more answers");
		if (next instanceof Error) throw next;
		return typeof next === "function" ? next(body as never) : next;
	};
	core.enrichIo.wait = async (ms: number) => void waits.push(ms);
	core.enrichIo.deadline = () => undefined;
	return { bodies, waits };
}

const OPS: Op[] = [
	{ op: "set", field: "content", value: [{ _type: "block", _key: "b", children: [] }] },
	{ op: "set", field: "seo.description", value: "A summary." },
];
const REVIEW = { links: [{ name: "Fastmail", slug: "fastmail", url: "https://glossary.io/fastmail/", field: "content" }], possessives: 0, images: [], description: "A summary.", leftAlone: 0, remaining: 0 };
const patched = (revision: string, more: Partial<Answer> = {}): Answer => ({ toast: { type: "success", message: "Added 1 glossary.io link (Fastmail)." }, patch: { type: "editor-draft-patch", operations: OPS }, review: REVIEW, revision, ...more });
const told = (type: "success" | "error" | "info", message: string, more: Partial<Answer> = {}): Answer => ({ toast: { type, message }, ...more });

test("the body is the draft's whole snapshot, the entry and the round", () => {
	const { draft } = fakeDraft();
	const snap = draft.get();
	assert.deepEqual(core.buildBody("posts", "E1", snap, 2), { collection: "posts", entryId: "E1", draft: { revision: "rev:0", fields: snap.fields, fieldDefinitions: snap.fieldDefinitions }, round: 2 });
});

test("a click to a review, then Apply: one patch with the revision the click read, and nothing before it", async () => {
	core.resetRunsForTests();
	const { draft, state } = fakeDraft();
	const { bodies } = script(patched("rev:0"));
	const seen: string[] = [];
	const stop = core.subscribeRun("posts:E1", () => seen.push(core.runState("posts:E1").phase));
	const ended = await core.startRun("posts", "E1", draft);
	assert.equal(ended.phase, "review");
	assert.deepEqual(seen, ["running", "review"]);
	assert.equal(bodies[0].round, 1);
	assert.equal(state.patches.length, 0, "nothing changes until Apply");
	const applied = core.applyReview("posts:E1", draft);
	assert.deepEqual(applied, { phase: "applied", message: core.MESSAGES.applied });
	assert.deepEqual(state.patches, [{ ops: OPS, expectedRevision: "rev:0" }]);
	assert.equal(state.values["seo.description"], "A summary.");
	stop();
});

test("the description box removes exactly that operation; with only the description and the box off there's nothing to apply", async () => {
	core.resetRunsForTests();
	const { draft, state } = fakeDraft();
	script(patched("rev:0"));
	await core.startRun("posts", "E1", draft);
	core.setIncludeDescription("posts:E1", false);
	assert.deepEqual(core.operationsToApply((core.runState("posts:E1") as { answer: Answer }).answer, false), [OPS[0]]);
	assert.equal(core.applyReview("posts:E1", draft).phase, "applied");
	assert.deepEqual(state.patches[0].ops, [OPS[0]]);
	assert.equal(state.values["seo.description"], null, "the SEO panel untouched");

	core.resetRunsForTests();
	const only = fakeDraft();
	script(patched("rev:0", { patch: { type: "editor-draft-patch", operations: [OPS[1]] } }));
	await core.startRun("posts", "E1", only.draft);
	core.setIncludeDescription("posts:E1", false);
	assert.equal(core.applyReview("posts:E1", only.draft).phase, "idle");
	assert.equal(only.state.patches.length, 0);
});

test("typing while it runs: no review, the stale message, and Run again reads the draft afresh", async () => {
	core.resetRunsForTests();
	const { draft, edit } = fakeDraft();
	script((body) => {
		edit("title", "Post, edited");
		return patched(body.draft.revision);
	});
	assert.deepEqual(await core.startRun("posts", "E1", draft), { phase: "stale", message: core.MESSAGES.stale });
	const { bodies } = script(patched("rev:1"));
	assert.equal((await core.startRun("posts", "E1", draft)).phase, "review");
	assert.equal(bodies[0].draft.revision, "rev:1");
});

test("an edit between the review and Apply: stale, nothing applied; a read-only editor keeps the review open; an invalid patch offers Apply without the description", async () => {
	core.resetRunsForTests();
	const one = fakeDraft();
	script(patched("rev:0"));
	await core.startRun("posts", "E1", one.draft);
	one.edit("title", "Changed");
	assert.deepEqual(core.applyReview("posts:E1", one.draft), { phase: "stale", message: core.MESSAGES.stale });
	assert.equal(one.state.values.content instanceof Array && (one.state.values.content as Array<{ children?: unknown }>)[0].children, undefined, "nothing applied");

	core.resetRunsForTests();
	const two = fakeDraft();
	script(patched("rev:0"));
	await core.startRun("posts", "E2", two.draft);
	two.state.readOnly = true;
	const kept = core.applyReview("posts:E2", two.draft);
	assert.equal(kept.phase, "review");
	assert.equal((kept as { error?: string }).error, core.MESSAGES.readOnlyApply);
	two.state.readOnly = false;
	assert.equal(core.applyReview("posts:E2", two.draft).phase, "applied", "Apply works once the version is closed");

	core.resetRunsForTests();
	const three = fakeDraft();
	script(patched("rev:0"));
	await core.startRun("posts", "E3", three.draft);
	three.state.refuse = { ok: false, code: "EDITOR_DRAFT_INVALID", message: 'Operation 2 (set "seo.description"): longer than 500 characters' };
	const warned: unknown[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => void warned.push(args);
	let invalid;
	try {
		invalid = core.applyReview("posts:E3", three.draft) as { phase: string; error?: string; withoutDescription?: boolean };
	} finally {
		console.warn = warn;
	}
	assert.deepEqual([invalid.phase, invalid.error, invalid.withoutDescription], ["review", core.MESSAGES.invalid, true]);
	assert.equal(warned.length, 1, "EmDash's message goes to the console");
	three.state.refuse = null;
	core.setIncludeDescription("posts:E3", false);
	assert.equal(core.applyReview("posts:E3", three.draft).phase, "applied");
	assert.deepEqual(three.state.patches.at(-1)!.ops, [OPS[0]]);
});

test("messageFor: the three codes", () => {
	assert.equal(core.messageFor("EDITOR_DRAFT_STALE"), core.MESSAGES.stale);
	assert.equal(core.messageFor("EDITOR_DRAFT_READ_ONLY"), core.MESSAGES.readOnlyApply);
	assert.equal(core.messageFor("EDITOR_DRAFT_INVALID"), core.MESSAGES.invalid);
});

test("more: asked again at once with the next round, one review at the end; at most 6 rounds; never once the draft changed", async () => {
	core.resetRunsForTests();
	const { draft } = fakeDraft();
	const notes: string[] = [];
	core.subscribeRun("posts:E1", () => {
		const s = core.runState("posts:E1");
		if (s.phase === "running") notes.push(s.note);
	});
	const { bodies, waits } = script(patched("rev:0", { more: true, progress: { imagesDone: 8, imagesTotal: 12 } }), patched("rev:0", { more: true, progress: { imagesDone: 12, imagesTotal: 12 } }), patched("rev:0"));
	assert.equal((await core.startRun("posts", "E1", draft)).phase, "review");
	assert.deepEqual(bodies.map((b) => b.round), [1, 2, 3]);
	assert.deepEqual(waits, [], "no wait between rounds");
	assert.deepEqual(notes, [core.MESSAGES.working, "Working… 8 of 12 images done.", "Working… 12 of 12 images done."]);

	core.resetRunsForTests();
	const capped = fakeDraft();
	const always = (body: { round: number; draft: { revision: string } }) => patched("rev:0", { more: true, review: { ...REVIEW, remaining: 3 }, toast: { type: "success", message: `round ${body.round}` } });
	const six = script(always, always, always, always, always, always, always);
	const last = await core.startRun("posts", "E1", capped.draft);
	assert.equal(six.bodies.length, core.MAX_ROUNDS);
	assert.equal(last.phase, "review", "the sixth round's answer is reviewed");
	assert.equal(core.reviewNote((last as { answer: Answer }).answer), "3 images still to do: click AI Enrich again.");

	core.resetRunsForTests();
	const moving = fakeDraft();
	const paid = script((body) => {
		moving.edit("title", `typed in round ${body.round}`);
		return patched(body.draft.revision, { more: true });
	});
	assert.deepEqual(await core.startRun("posts", "E1", moving.draft), { phase: "stale", message: core.MESSAGES.stale });
	assert.equal(paid.bodies.length, 1, "no further paid round for a result that can't be applied");
});

test("another request holds the entry: wait 10 s and ask again, up to 6 times, then the server's message", async () => {
	core.resetRunsForTests();
	const { draft } = fakeDraft();
	const running = told("info", "AI Enrich is already running for this entry. Wait for it to finish.", { running: true, revision: "rev:0" });
	const { waits } = script(running, running, patched("rev:0"));
	assert.equal((await core.startRun("posts", "E1", draft)).phase, "review");
	assert.deepEqual(waits, [core.RUNNING_WAIT_MS, core.RUNNING_WAIT_MS]);

	core.resetRunsForTests();
	const many = script(...Array.from({ length: 8 }, () => running));
	assert.deepEqual(await core.startRun("posts", "E1", fakeDraft().draft), { phase: "failed", message: running.toast.message });
	assert.equal(many.waits.length, core.RUNNING_TRIES);
});

test("a lost answer (network, 524, timeout): Still checking…, one more try after 5 s, then AI Enrich didn't finish", async () => {
	core.resetRunsForTests();
	const { draft } = fakeDraft();
	const notes: string[] = [];
	core.subscribeRun("posts:E1", () => {
		const s = core.runState("posts:E1");
		if (s.phase === "running") notes.push(s.note);
	});
	const once = script(new TypeError("Failed to fetch"), patched("rev:0"));
	assert.equal((await core.startRun("posts", "E1", draft)).phase, "review");
	assert.deepEqual(once.waits, [core.RETRY_WAIT_MS]);
	assert.ok(notes.includes(core.MESSAGES.checking));
	assert.deepEqual(once.bodies.map((b) => b.round), [1, 1], "the same round again");

	core.resetRunsForTests();
	const warn = console.warn;
	console.warn = () => undefined;
	try {
		script(new DOMException("timed out", "TimeoutError"), new Error("The request failed"));
		assert.deepEqual(await core.startRun("posts", "E1", fakeDraft().draft), { phase: "failed", message: core.MESSAGES.didntFinish });
	} finally {
		console.warn = warn;
	}
	assert.equal(core.ANSWER_TIMEOUT_MS, 95_000);
});

test("answers without a patch end in their message; a read-only editor never sends anything", async () => {
	core.resetRunsForTests();
	script(told("info", "Nothing to add: the links and image text are already in place.", { revision: "rev:0" }));
	assert.deepEqual(await core.startRun("posts", "E1", fakeDraft().draft), { phase: "done", message: "Nothing to add: the links and image text are already in place." });
	script(told("error", "Today's AI call limit is reached.", { revision: "rev:0" }));
	assert.deepEqual(await core.startRun("posts", "E1", fakeDraft().draft), { phase: "failed", message: "Today's AI call limit is reached." });

	const readOnly = fakeDraft();
	readOnly.state.readOnly = true;
	const { bodies } = script(patched("rev:0"));
	assert.deepEqual(await core.startRun("posts", "E9", readOnly.draft), { phase: "failed", message: core.MESSAGES.readOnly });
	assert.equal(bodies.length, 0);
	// A late answer for another revision than the one sent is never reviewed.
	script(patched("rev:7"));
	assert.equal((await core.startRun("posts", "E8", fakeDraft().draft)).phase, "stale");
});

test("the run store outlives the panel: a run started, the panel unmounted (Hide settings), mounted again: the review is there, and a second click while it runs does nothing", async () => {
	core.resetRunsForTests();
	const { draft } = fakeDraft();
	let release!: (a: Answer) => void;
	core.enrichIo.send = () => new Promise<Answer>((resolve) => (release = resolve));
	core.enrichIo.wait = async () => undefined;
	core.enrichIo.deadline = () => undefined;
	const unmount = core.subscribeRun("posts:E1", () => undefined);
	const run = core.startRun("posts", "E1", draft);
	assert.equal(core.runState("posts:E1").phase, "running");
	assert.equal((await core.startRun("posts", "E1", draft)).phase, "running", "the button is disabled: a second click starts nothing");
	unmount();
	release(patched("rev:0"));
	await run;
	let renders = 0;
	core.subscribeRun("posts:E1", () => renders++);
	const state = core.runState("posts:E1");
	assert.equal(state.phase, "review");
	assert.equal(core.runState("posts:E1"), state, "the same object until it changes");
	core.dismissRun("posts:E1");
	assert.equal(core.runState("posts:E1").phase, "idle", "Cancel: back to the button");
	assert.equal(renders, 1);
	assert.equal(core.runState("posts:E2").phase, "idle", "each entry its own");
});

test("the line under the button says what it adds and where the content goes", () => {
	assert.equal(core.explain({ links: true, images: true, describe: true, provider: "Anthropic (Claude)" }), "Adds glossary.io links, alt text and captions for images that have none, and a meta description if there isn't one. Sends this entry's text and images to Anthropic (Claude).");
	assert.equal(core.explain({ links: true, images: false, describe: false, provider: "OpenAI" }), "Adds glossary.io links. Sends this entry's text to OpenAI.");
	assert.equal(core.explain({ links: false, images: true, describe: false, provider: "OpenAI" }), "Adds alt text and captions for images that have none. Sends this entry's text and images to OpenAI.");
	assert.equal(core.explain({ links: true, images: false, describe: true, provider: "OpenAI" }), "Adds glossary.io links and a meta description if there isn't one. Sends this entry's text to OpenAI.");
	assert.equal(core.leftAloneNote(2), `2 images are left as they are. ${core.LEFT_ALONE_REASON}`);
	assert.equal(core.reviewNote(told("info", "Wikidata asked to slow down. Try again in 2 minutes.")), "Wikidata asked to slow down. Try again in 2 minutes.");
	assert.equal(core.reviewNote(patched("rev:0")), null, "a plain success has nothing more to say than the lists");
});

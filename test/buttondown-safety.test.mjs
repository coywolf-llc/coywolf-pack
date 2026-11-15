// Run: node --test test/buttondown-safety.test.mjs
//
// Buttondown Drafts: the cases where a draft could be overwritten, deleted, doubled or forgotten.
// - "Untouched" comes only from Buttondown's own times, never from the hash in the Pack's metadata.
// - Refresh draft from post is one attempt, and writes only while Buttondown shows what the admin saw.
// - A read that fails (the post, its terms, the settings, the collection's fields) is an error to retry,
//   never "not published" or "doesn't match".
// - A draft that was scheduled or sent before a create's retry is found, not made twice.
// - A record with work left always has something that runs it.
//
// The fake Buttondown fails any test in which the Pack PATCHes or DELETEs an email a person changed
// (afterEach), unless the test called fake.allowOverwrite (the admin confirmed Refresh draft from post).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import "./ts-resolve.mjs";
import { fakeButtondown } from "./fixtures/buttondown-fake.mjs";
import { fakeCollection } from "./fixtures/fake-plugin.mjs";
import { T0, fakes, para, site } from "./fixtures/buttondown-site.mjs";

const core = await import("../src/buttondown/sync-core.ts");
const sync = await import("../src/buttondown/sync.ts");
const { failingRecords, recordView } = await import("../src/buttondown/store.ts");
const { invalidateFeatures } = await import("../src/core/features.ts");
await import("../src/buttondown/pack.ts");

const { recordId } = core;
const { handleEvent, runEntry, runManual, manualRefusal, retryDue, settleJobsForTests } = sync;

afterEach(() => {
	invalidateFeatures();
	const violations = [...fakes].flatMap((fake) => fake.violations);
	fakes.clear();
	assert.deepEqual(violations, []);
});

const bodyOf = (s, id) => s.fake.emails.get(id)?.body ?? null;
const seenOf = (s, id) => s.fake.emails.get(id).modification_date;

/** A post whose create reached Buttondown while its answer was lost: the record is in error, the draft exists. */
async function lostCreate(s, id = "A") {
	s.post(id);
	s.fake.fail({ method: "POST", path: "/v1/emails" }, { lose: true });
	await s.event("publish", id);
	assert.equal((await s.record(id)).state, "error");
	assert.equal(s.fake.drafts().length, 1, "the create landed");
	return s.fake.drafts()[0].id;
}

// ── H1 ───────────────────────────────────────────────────────────

test("H1: a create whose answer was lost, then edited in Buttondown: the retry records it as edited; a republish doesn't overwrite it", async () => {
	const s = site();
	const id = await lostCreate(s);
	s.fake.edit(id, { body: "My own words", subject: "My subject" });
	s.advance(6 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 1);
	let r = await s.record("A");
	assert.equal(r.state, "edited", "the same hash in the metadata doesn't make it untouched");
	assert.equal(r.emailId, id);
	assert.equal(r.remoteModifiedAt, null, "no modification date that a later check could take for the Pack's own");
	await s.republish("A", { content: [para("Changed post.")] });
	r = await s.record("A");
	assert.equal(r.state, "edited");
	assert.equal(bodyOf(s, id), "My own words");
	assert.equal(s.fake.emails.get(id).subject, "My subject");
	assert.equal(s.fake.count("PATCH"), 0);
	assert.equal(s.fake.count("POST /v1/emails"), 1, "and no second draft");
});

test("H1: a create whose answer was lost, then edited in Buttondown: an unpublish or a trash keeps it", async () => {
	for (const leave of ["unpublish", "trash"]) {
		const s = site();
		const id = await lostCreate(s);
		s.fake.edit(id, { body: "My own words" });
		s.advance(6 * 60_000);
		await retryDue(s.ctx, s.deps);
		if (leave === "unpublish") await s.unpublish("A");
		else await s.event("trash", "A");
		assert.equal(s.fake.emails.has(id), true, leave);
		assert.equal(s.fake.count("DELETE"), 0, leave);
		assert.equal((await s.record("A")).state, "edited", leave);
	}
});

test("H1: Create draft now on a post whose draft was edited in Buttondown never takes it for untouched", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	// The category is removed: the Pack stops watching. Then the draft is edited in Buttondown.
	s.terms.set("A", []);
	await s.republish("A");
	assert.equal((await s.record("A")).state, "stopped");
	s.fake.edit(id, { body: "My own words" });
	s.terms.set("A", ["newsletter"]);
	assert.equal(await manualRefusal(s.ctx, s.deps, "create", "posts", "A", await s.record("A")), null);
	const out = await runManual(s.ctx, s.deps, "create", "posts", "A");
	assert.equal(out.state, "edited");
	assert.equal(out.emailId, id);
	assert.equal(s.fake.drafts().length, 1, "no second draft");
	await s.republish("A", { content: [para("New text")] });
	assert.equal(bodyOf(s, id), "My own words");
	await s.unpublish("A");
	assert.equal(s.fake.emails.has(id), true);
});

test("H1: Create draft now on a stopped post whose draft nobody touched picks it up again (checked against the Pack's own recorded date)", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	// Updated once by the Pack, so its modification date is well after its creation date.
	s.advance(60_000);
	await s.republish("A", { content: [para("Second version.")] });
	s.terms.set("A", []);
	await s.republish("A");
	s.terms.set("A", ["newsletter"]);
	const out = await runManual(s.ctx, s.deps, "create", "posts", "A");
	assert.equal(out.state, "draft");
	assert.equal(out.emailId, id);
	await s.republish("A", { content: [para("Third version.")] });
	assert.match(bodyOf(s, id), /Third version\./);
	assert.equal(s.fake.drafts().length, 1);
});

test("H1: Create draft now on a stopped post whose draft was deleted in Buttondown makes one new draft", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	s.terms.set("A", []);
	await s.republish("A");
	s.fake.emails.clear();
	s.terms.set("A", ["newsletter"]);
	const out = await runManual(s.ctx, s.deps, "create", "posts", "A");
	assert.equal(out.state, "draft");
	assert.equal(s.fake.drafts().length, 1);
	assert.equal(out.emailId, s.fake.drafts()[0].id);
	assert.equal(s.fake.count("POST /v1/emails"), 2);
});

test("H1: a lost create nobody touched is adopted without a write, and later updates and deletes work", async () => {
	const s = site();
	const id = await lostCreate(s);
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	let r = await s.record("A");
	assert.equal(r.state, "draft");
	assert.equal(r.remoteModifiedAt, seenOf(s, id));
	assert.equal(s.fake.count("PATCH"), 0, "it already shows the post");
	await s.republish("A", { content: [para("Changed post.")] });
	assert.match(bodyOf(s, id), /Changed post\./);
	await s.unpublish("A");
	r = await s.record("A");
	assert.equal(r.state, "removed");
	assert.equal(s.fake.emails.size, 0);
});

test("H1: adoptable looks only at Buttondown's creation and modification times", () => {
	assert.equal(core.adoptable({ modificationDate: "2026-11-15T12:00:00.001Z", creationDate: "2026-11-15T12:00:00.000Z" }), true);
	assert.equal(core.adoptable({ modificationDate: "2026-11-15T12:05:00.000Z", creationDate: "2026-11-15T12:00:00.000Z" }), false);
	// A second argument (the old "same hash" shortcut) changes nothing.
	assert.equal(core.adoptable({ modificationDate: "2026-11-15T12:05:00.000Z", creationDate: "2026-11-15T12:00:00.000Z" }, true), false);
	assert.equal(core.adoptable({ modificationDate: null, creationDate: "2026-11-15T12:00:00.000Z" }), false);
});

// ── H2 ───────────────────────────────────────────────────────────

test("H2: a Refresh that fails is one attempt: the hourly retry doesn't overwrite what was changed in Buttondown afterwards", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.entries.get("A").data.content = [para("Post v2")];
	s.fake.fail({ method: "GET", path: `/v1/emails/${id}` }, { status: 500 });
	const out = await runManual(s.ctx, s.deps, "refresh", "posts", "A", { seen: seenOf(s, id) });
	assert.equal(out.state, "error");
	assert.ok(!("force" in out) || out.force === false, "nothing on the record asks for an overwrite");
	s.fake.edit(id, { body: "Fixed by hand after the failure" });
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	const r = await s.record("A");
	assert.equal(r.state, "edited");
	assert.equal(bodyOf(s, id), "Fixed by hand after the failure");
	assert.equal(s.fake.count("PATCH"), 0);
});

test("H2: a Refresh that fails, then a republish: the draft changed in Buttondown is left alone", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.fake.fail({ method: "GET", path: `/v1/emails/${id}` }, { status: 500 });
	await runManual(s.ctx, s.deps, "refresh", "posts", "A", { seen: seenOf(s, id) });
	s.fake.edit(id, { body: "Mine" });
	await s.republish("A", { content: [para("v3")] });
	assert.equal((await s.record("A")).state, "edited");
	assert.equal(bodyOf(s, id), "Mine");
});

test("H2: with Update drafts off, a Refresh whose write fails isn't tried again as a forced write", async () => {
	const s = site({ features: { "buttondown.updates": false } });
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.entries.get("A").data.content = [para("v2")];
	s.fake.fail({ method: "PATCH" }, { status: 503 });
	const out = await runManual(s.ctx, s.deps, "refresh", "posts", "A", { seen: seenOf(s, id) });
	assert.equal(out.state, "error");
	s.fake.edit(id, { body: "Mine" });
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal(bodyOf(s, id), "Mine");
	assert.equal((await s.record("A")).state, "edited");
});

test("H2: Refresh writes only while Buttondown still shows the modification date the admin saw", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.fake.edit(id, { body: "First edit" });
	await s.republish("A", { content: [para("v2")] });
	assert.equal((await s.record("A")).state, "edited");
	// The admin reads the draft and confirms. Before the Refresh arrives, the draft changes again in Buttondown.
	const seen = seenOf(s, id);
	s.fake.edit(id, { body: "Second edit, after the admin looked" });
	const moved = await sync.refreshDraft(s.ctx, s.deps, "posts", "A", seen);
	assert.equal(moved.moved, true);
	assert.equal(moved.record.state, "edited");
	assert.equal(bodyOf(s, id), "Second edit, after the admin looked");
	assert.equal(s.fake.count("PATCH"), 0);
	// No date seen: refused before anything runs.
	assert.match(await manualRefusal(s.ctx, s.deps, "refresh", "posts", "A", await s.record("A")), /again/i);
	await assert.rejects(sync.refreshDraft(s.ctx, s.deps, "posts", "A", ""));
	// Confirmed against what Buttondown shows now: written (still only a draft).
	s.fake.allowOverwrite(id);
	const done = await sync.refreshDraft(s.ctx, s.deps, "posts", "A", seenOf(s, id));
	assert.equal(done.moved, false);
	assert.equal(done.record.state, "draft");
	assert.match(bodyOf(s, id), /v2/);
	assert.equal(s.fake.emails.get(id).status, "draft");
});

test("H2: a Refresh while another job holds the record does nothing, and nothing forced is left for that job", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.fake.edit(id, { body: "Mine" });
	const rid = recordId("posts", "A");
	const store = s.ctx.storage.buttondownEmails;
	// Another isolate's job holds a fresh claim.
	await store.put(rid, { ...(await store.get(rid)), claimToken: "another-job", claimedAt: new Date(s.now()).toISOString() });
	s.entries.get("A").data.content = [para("v2")];
	const out = await sync.refreshDraft(s.ctx, s.deps, "posts", "A", seenOf(s, id));
	assert.equal(out.busy, true);
	assert.equal(s.fake.calls.filter((c) => c.method !== "GET").length, 1, "only the first create");
	// That job ends; whatever runs the record next does a plain update check, never a forced write.
	await store.put(rid, { ...(await store.get(rid)), claimToken: null, claimedAt: null });
	await runEntry(s.ctx, s.deps, "posts", "A", s.now() + 25_000);
	assert.equal(bodyOf(s, id), "Mine");
	assert.equal((await s.record("A")).state, "edited");
});

// ── M1 ───────────────────────────────────────────────────────────

test("M1: the post can't be read during a republish: an error to retry, and the untouched draft is not deleted", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.hooks.contentGet = async () => {
		throw new Error("D1_ERROR: no such thing as a free read");
	};
	s.entries.get("A").data.content = [para("v2")];
	await s.event("publish", "A");
	let r = await s.record("A");
	assert.equal(s.fake.count("DELETE"), 0);
	assert.equal(s.fake.emails.has(id), true);
	assert.equal(r.state, "error");
	assert.equal(r.lastError.code, "read_failed");
	assert.ok(r.nextRetryAt, "tried again by the hourly task");
	assert.ok(!r.lastError.message.includes("D1_ERROR"), "the database's own words aren't stored");
	// The read works again: the retry updates the draft.
	s.hooks.contentGet = null;
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	r = await s.record("A");
	assert.equal(r.state, "draft");
	assert.match(bodyOf(s, id), /v2/);
});

test("M1: the post can't be read while a delete runs: nothing is deleted and nothing is settled until it can be", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.hooks.contentGet = async () => {
		throw new Error("D1 down");
	};
	s.entries.get("A").status = "draft";
	await s.event("unpublish", "A");
	let r = await s.record("A");
	assert.equal(s.fake.emails.has(id), true);
	assert.equal(r.state, "error");
	assert.equal(r.job, "remove");
	s.hooks.contentGet = null;
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	r = await s.record("A");
	assert.equal(r.state, "removed");
	assert.equal(s.fake.emails.has(id), false);
});

test("M1: the terms can't be read: a first publish is retried, not skipped; a republish doesn't stop watching", async () => {
	const s = site();
	s.post("A");
	s.hooks.terms = async () => {
		throw new Error("D1 down");
	};
	await s.event("publish", "A");
	let r = await s.record("A");
	assert.ok(r, "a record is left, so there's something to retry");
	assert.equal(r.state, "error");
	assert.equal(r.lastError.code, "read_failed");
	assert.equal(s.fake.calls.length, 0);
	s.hooks.terms = null;
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal((await s.record("A")).state, "draft");
	const id = s.fake.drafts()[0].id;

	// Now with a draft: a republish while the terms can't be read.
	s.hooks.terms = async () => {
		throw new Error("D1 down");
	};
	await s.republish("A", { content: [para("v2")] });
	r = await s.record("A");
	assert.notEqual(r.state, "stopped");
	assert.equal(r.state, "error");
	assert.equal(s.fake.emails.has(id), true);
	s.hooks.terms = null;
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal((await s.record("A")).state, "draft");
	assert.match(bodyOf(s, id), /v2/);
});

test("M1: the terms can't be read and the post doesn't match after all: no draft, and the record goes", async () => {
	const s = site();
	s.post("A");
	s.terms.set("A", ["other"]);
	s.hooks.terms = async () => {
		throw new Error("D1 down");
	};
	await s.event("publish", "A");
	assert.equal((await s.record("A")).state, "error");
	s.hooks.terms = null;
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal(await s.record("A"), null);
	assert.equal(s.fake.calls.length, 0);
});

test("M1: the settings can't be read: a first publish is retried with the rule's since still applied", async () => {
	const s = site();
	s.post("NEW");
	s.post("OLD", { publishedAt: "2026-11-01T00:00:00.000Z" });
	s.hooks.settings = async () => {
		throw new Error("D1 down");
	};
	await s.event("publish", "NEW");
	await s.event("publish", "OLD");
	await handleEvent(s.ctx, s.deps, "publish", { collection: "pages", content: { id: "X", status: "published" } });
	await settleJobsForTests();
	assert.equal(s.fake.calls.length, 0);
	const r = await s.record("NEW");
	assert.equal(r.state, "error");
	assert.equal(r.lastError.code, "read_failed");
	assert.ok(r.nextRetryAt);
	s.hooks.settings = null;
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal((await s.record("NEW")).state, "draft");
	assert.equal(await s.record("OLD"), null, "published before the rule: no draft on its own");
	assert.equal(await s.ctx.storage.buttondownEmails.get("pages:X"), null, "no rule for the collection: forgotten");
	assert.equal(s.fake.drafts().length, 1);
});

test("M1: the settings can't be read during a republish or an unpublish: the draft isn't stopped or deleted", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.hooks.settings = async () => {
		throw new Error("D1 down");
	};
	await s.republish("A", { content: [para("v2")] });
	assert.equal((await s.record("A")).state, "error");
	s.entries.get("A").status = "draft";
	await s.event("unpublish", "A");
	assert.equal(s.fake.emails.has(id), true);
	assert.equal(s.fake.count("DELETE"), 0);
	s.hooks.settings = null;
	// The second failure in a row waits 15 minutes.
	s.advance(16 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal((await s.record("A")).state, "removed");
});

test("M1: Create draft now says so when the post can't be read", async () => {
	const s = site();
	s.post("A");
	s.hooks.contentGet = async () => {
		throw new Error("D1 down");
	};
	assert.match(await manualRefusal(s.ctx, s.deps, "create", "posts", "A", null), /couldn't be read/i);
});

test("M1: a site URL that isn't there (EmDash's site read failed) is an error to retry, never another key", async () => {
	const s = site();
	s.post("A");
	s.ctx.site.url = "";
	await s.event("publish", "A");
	const r = await s.record("A");
	assert.equal(r.state, "error");
	assert.equal(r.lastError.code, "read_failed");
	assert.equal(s.fake.calls.length, 0);
});

// ── M2 ───────────────────────────────────────────────────────────

test("M2: a create whose answer was lost, then scheduled or sent in Buttondown: the retry finds it and makes no second draft", async () => {
	for (const status of ["scheduled", "sent"]) {
		const s = site();
		const id = await lostCreate(s);
		s.fake.setStatus(id, status);
		s.advance(6 * 60_000);
		await retryDue(s.ctx, s.deps);
		const r = await s.record("A");
		assert.equal(s.fake.count("POST /v1/emails"), 1, status);
		assert.equal(s.fake.emails.size, 1, status);
		assert.equal(r.state, "left", status);
		assert.equal(r.emailId, id, status);
		assert.equal(r.remoteStatus, status, status);
		assert.equal(s.fake.count("PATCH"), 0, status);
	}
});

// ── M3 ───────────────────────────────────────────────────────────

test("M3: more events during a job than it has passes: the record is handed to the hourly task, which brings the draft up to date", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	let n = 0;
	// Every PATCH is slow, and during each one another isolate handles a live save (it marks the record dirty).
	s.fake.fail({ method: "PATCH" }, { persist: true, during: async () => {
		n++;
		s.entries.get("A").data.content = [para(`edit ${n + 1}`)];
		const rid = recordId("posts", "A");
		const store = s.ctx.storage.buttondownEmails;
		const current = await store.getVersioned(rid);
		await store.compareAndSet(rid, current.revision, { ...current.value, dirty: true });
	} });
	s.entries.get("A").data.content = [para("edit 1")];
	await s.event("publish", "A");
	assert.equal(n, 3, "three passes");
	const r = await s.record("A");
	assert.equal(r.job, "sync");
	assert.ok(r.nextRetryAt && Date.parse(r.nextRetryAt) <= s.now(), "due now for the hourly task");
	assert.match(bodyOf(s, id), /edit 3/);
	s.fake.clearFailures();
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 1);
	assert.match(bodyOf(s, id), /edit 4/);
	const after = await s.record("A");
	assert.equal(after.job, null);
	assert.equal(after.nextRetryAt, null);
});

test("M3: an update whose job was dropped (the hook queued it, waitUntil lost it) is finished by the hourly task", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.entries.get("A").data.content = [para("Second version.")];
	// The hook runs; its job never does.
	await s.fire("publish", "A");
	const dropped = sync.dropJobsForTests();
	assert.equal(dropped, 1);
	const r = await s.record("A");
	assert.equal(r.state, "draft");
	assert.equal(r.job, "sync");
	assert.ok(r.nextRetryAt, "a time for the hourly task");
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 0, "too soon");
	s.advance(5 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 1);
	assert.match(bodyOf(s, id), /Second version\./);
});

// ── M4 ───────────────────────────────────────────────────────────

test("M4: a create that failed for good, then the post is unpublished or trashed: the record settles and stops alerting", async () => {
	for (const leave of ["unpublish", "trash"]) {
		const s = site();
		s.post("A");
		s.fake.fail({ method: "POST", path: "/v1/emails" }, { status: 422, code: "invalid", detail: "No." });
		await s.event("publish", "A");
		let r = await s.record("A");
		assert.equal(r.state, "error");
		assert.equal(r.nextRetryAt, null);
		s.advance(2 * 3600_000);
		assert.equal((await failingRecords(s.ctx, s.now())).length, 1, "alerts while the post is live");
		if (leave === "unpublish") await s.unpublish("A");
		else await s.event("trash", "A");
		s.advance(3 * 86_400_000);
		await retryDue(s.ctx, s.deps);
		r = await s.record("A");
		assert.notEqual(r.state, "error", leave);
		assert.equal(r.lastError, null, leave);
		assert.equal((await failingRecords(s.ctx, s.now())).length, 0, leave);
		assert.match(core.stateText(r), /No draft was made/, leave);
		assert.equal(s.fake.drafts().length, 0, leave);
		if (leave === "unpublish") {
			// Publishing it again tries again.
			await s.republish("A");
			assert.equal((await s.record("A")).state, "draft");
		}
	}
});

test("M4: an unpublish that arrives while the failing create runs settles it too", async () => {
	const s = site();
	s.post("A");
	// The job is looking for an earlier draft when the post is unpublished; its create then fails for good.
	s.fake.fail({ method: "GET", path: "/v1/emails" }, { during: async () => {
		s.entries.get("A").status = "draft";
		await s.fire("unpublish", "A");
		s.fake.fail({ method: "POST", path: "/v1/emails" }, { status: 422, code: "invalid", detail: "No." });
	} });
	await s.event("publish", "A");
	const r = await s.record("A");
	assert.notEqual(r.state, "error");
	assert.equal(r.unpublished, true);
	s.advance(2 * 3600_000);
	assert.equal((await failingRecords(s.ctx, s.now())).length, 0);
});

test("M4: a delete that keeps failing still alerts (the post is unpublished by then)", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	s.fake.fail({ method: "DELETE" }, { status: 403, code: "forbidden", detail: "No.", persist: true });
	await s.unpublish("A");
	const r = await s.record("A");
	assert.equal(r.state, "error");
	assert.equal(r.job, "remove");
	s.advance(2 * 3600_000);
	assert.equal((await failingRecords(s.ctx, s.now())).length, 1);
});

// ── LOW ──────────────────────────────────────────────────────────

test("L1: a publish or save in a collection without a rule reads nothing; an unpublish, trash, delete or restore reads the entry's record once", async () => {
	const s = site();
	let reads = 0;
	const store = s.ctx.storage.buttondownEmails;
	for (const name of ["get", "getVersioned", "query"]) {
		const real = store[name].bind(store);
		store[name] = async (...args) => (reads++, real(...args));
	}
	await handleEvent(s.ctx, s.deps, "publish", { collection: "pages", content: { id: "X", status: "published" } });
	await handleEvent(s.ctx, s.deps, "save", { collection: "pages", content: { id: "X", status: "published" } });
	assert.equal(reads, 0);
	await handleEvent(s.ctx, s.deps, "unpublish", { collection: "pages", content: { id: "X", status: "draft" } });
	await handleEvent(s.ctx, s.deps, "trash", { collection: "pages", id: "X", permanent: false });
	await handleEvent(s.ctx, s.deps, "restore", { collection: "pages", content: { id: "X", status: "draft" } });
	await handleEvent(s.ctx, s.deps, "delete", { collection: "pages", id: "X", permanent: true });
	assert.equal(reads, 4, "one read each: a record can outlive its rule");
	assert.equal(store.rows.size, 0);
	assert.equal(s.fake.calls.length, 0);
});

test("L2: a post with no content gets a draft with just the footer link, not a frontmatter error", async () => {
	const s = site();
	s.post("A", { data: { title: "Only a title", excerpt: "x", content: [] } });
	await s.event("publish", "A");
	const r = await s.record("A");
	assert.equal(r.state, "draft");
	const body = s.fake.drafts()[0].body;
	assert.match(body, /\[Read it on coywolf\.com\]\(https:\/\/coywolf\.com\/newsletter\/post-a\/\)/);
	assert.ok(!/^---/m.test(body), "no rule with nothing above it");
});

test("L2: the collection's fields can't be read: an error to retry, never a draft with an empty body", async () => {
	for (const schemaGet of [async () => { throw new Error("D1 down"); }, async () => null]) {
		const s = site({ settings: { buttondownSettings: { rules: [{ collection: "posts", taxonomy: "category", terms: ["newsletter"], since: "2026-11-10T00:00:00.000Z" }], footerLink: false } } });
		sync.clearSchemaCacheForTests();
		s.post("A");
		s.hooks.schemaGet = schemaGet;
		await s.event("publish", "A");
		const r = await s.record("A");
		assert.equal(r.state, "error");
		assert.equal(r.lastError.code, "read_failed");
		assert.ok(r.nextRetryAt);
		assert.equal(s.fake.drafts().length, 0);
		s.hooks.schemaGet = null;
		s.advance(6 * 60_000);
		await retryDue(s.ctx, s.deps);
		assert.equal((await s.record("A")).state, "draft");
		assert.match(s.fake.drafts()[0].body, /Hello\./);
	}
});

test("L3: the draft is deleted in Buttondown between the Pack's read and its write (404 on the PATCH): recorded as deleted there", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	s.fake.fail({ method: "PATCH" }, { status: 404, code: "not_found", detail: "Not found." });
	await s.republish("A", { content: [para("v2")] });
	const r = await s.record("A");
	assert.equal(r.state, "gone");
	assert.equal(r.lastError, null);
});

test("L5: a publish during a running delete, with Update drafts off: the post ends with a draft", async () => {
	const s = site({ features: { "buttondown.updates": false } });
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.entries.get("A").status = "draft";
	// The delete job has checked the post and is reading the email when the post is published again.
	s.fake.fail({ method: "GET", path: `/v1/emails/${id}` }, { during: async () => {
		s.entries.get("A").status = "published";
		await s.fire("publish", "A");
	} });
	await s.event("unpublish", "A");
	const r = await s.record("A");
	assert.equal(r.state, "draft");
	assert.equal(r.unpublished, false);
	assert.equal(s.fake.drafts().length, 1, "a live post has its draft");
});

test("L6: a 403 is tried once more an hour later (Buttondown also answers 403 when it throttles), then waits for a new key or Retry", async () => {
	const fresh = { attempts: 0, errorSince: null };
	assert.deepEqual(core.failure({ status: 403, code: null, retryAfter: null }, fresh, T0), { kind: "auth", nextRetryAt: new Date(T0 + 60 * 60_000).toISOString() });
	assert.deepEqual(core.failure({ status: 403, code: null, retryAfter: null }, { attempts: 1, errorSince: new Date(T0).toISOString() }, T0), { kind: "auth", nextRetryAt: null });
	assert.deepEqual(core.failure({ status: 401, code: null, retryAfter: null }, fresh, T0), { kind: "auth", nextRetryAt: null });

	const s = site();
	s.post("A");
	s.fake.fail({ method: "GET", path: "/v1/emails" }, { status: 403, code: "forbidden", detail: "Slow down." });
	await s.event("publish", "A");
	const r = await s.record("A");
	assert.equal(r.state, "error");
	assert.equal(r.nextRetryAt, new Date(s.now() + 60 * 60_000).toISOString());
	s.advance(60 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal((await s.record("A")).state, "draft");
});

// ── The hook across isolates ─────────────────────────────────────

test("two isolates handle the same publish through their hooks (each with its own job list): one POST, one draft", async () => {
	const other = await import("../src/buttondown/sync.ts?isolate=b");
	assert.notEqual(other.handleEvent, handleEvent, "a second copy of the module, as a second isolate has");
	const storage = fakeCollection();
	const fake = fakeButtondown();
	const a = site({ fake, storage });
	const b = site({ fake, storage, handleEvent: other.handleEvent, settle: other.settleJobsForTests });
	a.post("P1");
	b.post("P1");
	// Isolate A's create is on its way when isolate B handles the same publish (its hook and its job).
	fake.fail({ method: "POST" }, { during: async () => {
		await b.event("publish", "P1");
	} });
	await a.event("publish", "P1");
	await other.settleJobsForTests();
	assert.equal(fake.count("POST /v1/emails"), 1);
	assert.equal(fake.drafts().length, 1);
	const r = await a.record("P1");
	assert.equal(r.state, "draft");
	assert.equal(r.claimToken, null);
	assert.equal(r.dirty, false);
	assert.equal(r.job, null);
});

test("the fake Buttondown flags a PATCH or DELETE of an email a person changed, unless the overwrite was confirmed", async () => {
	const fake = fakeButtondown();
	const headers = { Authorization: `Token ${fake.key}` };
	const make = async () => (await (await fake.fetch("https://api.buttondown.com/v1/emails", { method: "POST", headers, body: JSON.stringify({ subject: "x", body: "y", status: "draft" }) })).json()).id;
	const one = await make();
	await fake.fetch(`https://api.buttondown.com/v1/emails/${one}`, { method: "PATCH", headers, body: JSON.stringify({ subject: "z" }) });
	assert.deepEqual(fake.violations, [], "the Pack's own draft: fine");
	fake.edit(one, { body: "by hand" });
	assert.equal(fake.changedByHand(one), true);
	await fake.fetch(`https://api.buttondown.com/v1/emails/${one}`, { method: "PATCH", headers, body: JSON.stringify({ subject: "again" }) });
	assert.ok(fake.violations.some((v) => /PATCH of an email changed in Buttondown/.test(v)));
	const two = await make();
	fake.edit(two, { body: "by hand" });
	await fake.fetch(`https://api.buttondown.com/v1/emails/${two}`, { method: "GET", headers });
	await fake.fetch(`https://api.buttondown.com/v1/emails/${two}`, { method: "DELETE", headers });
	assert.ok(fake.violations.some((v) => /DELETE of an email changed in Buttondown/.test(v)));
	const three = await make();
	fake.edit(three, { body: "by hand" });
	const before = fake.violations.length;
	fake.allowOverwrite(three);
	await fake.fetch(`https://api.buttondown.com/v1/emails/${three}`, { method: "PATCH", headers, body: JSON.stringify({ subject: "confirmed" }) });
	assert.equal(fake.violations.length, before, "a confirmed Refresh may overwrite");
	assert.equal(fake.changedByHand(three), false);
});

test("a record never carries a standing order to overwrite", () => {
	assert.ok(!("force" in core.newRecord("posts", "1", T0)));
	assert.ok(!("force" in recordView(core.newRecord("posts", "1", T0))));
});

// ── N1 to N8 (the verification's low findings) ───────────────────

const { loadSettings } = await import("../src/buttondown/settings.ts");
const allRecords = async (s) => (await s.ctx.storage.buttondownEmails.query({ limit: 100 })).items.map((i) => core.readRecord(i.data));
const listCalls = (s) => s.fake.count("GET /v1/emails");

test("N1: a post from before the rule, queued while the rules couldn't be read, gets no draft when a second event lands during its job", async () => {
	const s = site();
	s.post("OLD", { publishedAt: "2026-11-01T00:00:00.000Z" });
	// The first hook can't read the rules (the record waits with sinceUnchecked). The job can.
	let reads = 0;
	s.hooks.settings = async (c) => {
		if (++reads === 1) throw new Error("D1 blip");
		return loadSettings(c, true);
	};
	// A second publish hook lands while that job reads the post.
	let fired = false;
	s.hooks.contentGet = async (_collection, id) => {
		if (!fired) {
			fired = true;
			await s.fire("publish", "OLD");
		}
		return structuredClone(s.entries.get(id));
	};
	await s.event("publish", "OLD");
	assert.equal(s.fake.drafts().length, 0, "published before the rule: never a draft on its own");
	assert.equal(s.fake.count("POST /v1/emails"), 0);
	assert.equal(await s.record("OLD"), null, "and the record goes");
});

test("N1: the same race with an unpublish as the second event leaves no draft and nothing that makes one later", async () => {
	const s = site();
	s.post("OLD", { publishedAt: "2026-11-01T00:00:00.000Z" });
	let reads = 0;
	s.hooks.settings = async (c) => {
		if (++reads === 1) throw new Error("D1 blip");
		return loadSettings(c, true);
	};
	let fired = false;
	s.hooks.contentGet = async (_collection, id) => {
		if (!fired) {
			fired = true;
			await s.fire("unpublish", "OLD");
		}
		return structuredClone(s.entries.get(id));
	};
	await s.event("publish", "OLD");
	s.hooks.contentGet = null;
	await s.republish("OLD");
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal(s.fake.count("POST /v1/emails"), 0);
});

test("N2: a delete that landed but whose answer was lost is the Pack's own delete: publishing again makes a new draft", async () => {
	for (const updates of [true, false]) {
		const s = site({ features: { "buttondown.updates": updates } });
		s.post("A");
		await s.event("publish", "A");
		const id = s.fake.drafts()[0].id;
		s.fake.fail({ method: "DELETE" }, { lose: true });
		await s.unpublish("A");
		let r = await s.record("A");
		assert.equal(r.state, "error");
		assert.equal(r.job, "remove");
		assert.equal(s.fake.emails.has(id), false, "the delete landed");
		await s.republish("A");
		r = await s.record("A");
		assert.equal(r.state, "draft", `updates ${updates}`);
		assert.equal(s.fake.drafts().length, 1);
		assert.equal(r.emailId, s.fake.drafts()[0].id);
		assert.notEqual(r.emailId, id);
		assert.equal(r.deleteSentAt, null, "settled: nothing left of the lost answer");
	}
});

test("N2: the retry of a delete whose answer was lost records it as removed, not as deleted in Buttondown", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	s.fake.fail({ method: "DELETE" }, { lose: true });
	await s.unpublish("A");
	s.advance(6 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 1);
	let r = await s.record("A");
	assert.equal(r.state, "removed");
	assert.equal(r.emailId, null);
	await s.republish("A");
	r = await s.record("A");
	assert.equal(r.state, "draft");
	assert.equal(s.fake.count("POST /v1/emails"), 2);
});

test("N2: after a delete whose answer was lost, the new draft's create is lost too, then the post is unpublished: nothing is left in Buttondown", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	s.fake.fail({ method: "DELETE" }, { lose: true });
	await s.unpublish("A");
	s.fake.fail({ method: "POST", path: "/v1/emails" }, { lose: true });
	await s.republish("A");
	let r = await s.record("A");
	assert.equal(r.state, "error");
	assert.equal(r.emailId, null, "the deleted email isn't named any more");
	assert.equal(s.fake.drafts().length, 1, "the second create landed");
	await s.unpublish("A");
	r = await s.record("A");
	assert.equal(s.fake.emails.size, 0);
	assert.equal(r.state, "removed");
});

test("N2: a delete whose answer was lost but that never landed: a republish finds the untouched draft and keeps using it", async () => {
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.fake.fail({ method: "DELETE" }, { network: true });
	await s.unpublish("A");
	assert.equal(s.fake.emails.has(id), true);
	await s.republish("A", { content: [para("v2")] });
	const r = await s.record("A");
	assert.equal(r.state, "draft");
	assert.equal(r.emailId, id);
	assert.match(bodyOf(s, id), /v2/);
	assert.equal(s.fake.count("POST /v1/emails"), 1);
});

test("N2: a delete Buttondown refused, or one that was never sent, then the draft deleted by hand: deleted in Buttondown, never made again", async () => {
	for (const failing of ["the delete is refused", "the read before it gets no answer"]) {
		const s = site();
		s.post("A");
		await s.event("publish", "A");
		const id = s.fake.drafts()[0].id;
		if (failing === "the delete is refused") s.fake.fail({ method: "DELETE" }, { status: 400, code: "nope", detail: "No." });
		else s.fake.fail({ method: "GET", path: `/v1/emails/${id}` }, { network: true });
		await s.unpublish("A");
		assert.equal((await s.record("A")).state, "error", failing);
		assert.equal((await s.record("A")).deleteSentAt, null, failing);
		// Deleted by hand in Buttondown.
		s.fake.emails.delete(id);
		await runManual(s.ctx, s.deps, "retry", "posts", "A");
		assert.equal((await s.record("A")).state, "gone", failing);
		await s.republish("A");
		assert.equal((await s.record("A")).state, "gone", failing);
		assert.equal(s.fake.count("POST /v1/emails"), 1, failing);
	}
});

test("N3: a create whose answer was lost, then an unpublish before the retry: the untouched draft is found and deleted", async () => {
	for (const leave of ["unpublish", "trash"]) {
		const s = site();
		const id = await lostCreate(s);
		assert.ok((await s.record("A")).createSentAt, "the record knows a create went out unanswered");
		if (leave === "unpublish") await s.unpublish("A");
		else await s.event("trash", "A");
		const r = await s.record("A");
		assert.equal(s.fake.emails.has(id), false, leave);
		assert.equal(s.fake.count("DELETE"), 1, leave);
		assert.equal(r.state, "removed", leave);
		assert.equal(r.emailId, null, leave);
		assert.equal(r.createSentAt, null, leave);
		assert.equal((await failingRecords(s.ctx, s.now() + 2 * 3600_000)).length, 0, leave);
		if (leave === "unpublish") {
			await s.republish("A");
			assert.equal((await s.record("A")).state, "draft");
			assert.equal(s.fake.drafts().length, 1);
		}
	}
});

test("N3: that draft was edited, scheduled or deleted in Buttondown meanwhile: kept and named on the record, never deleted", async () => {
	for (const [change, state] of [["edited", "edited"], ["scheduled", "left"], ["deleted", "stopped"]]) {
		const s = site();
		const id = await lostCreate(s);
		if (change === "edited") s.fake.edit(id, { body: "My own words" });
		if (change === "scheduled") s.fake.setStatus(id, "scheduled");
		if (change === "deleted") s.fake.emails.delete(id);
		await s.unpublish("A");
		const r = await s.record("A");
		assert.equal(s.fake.count("DELETE"), 0, change);
		assert.equal(r.state, state, change);
		assert.equal(r.emailId, change === "deleted" ? null : id, change);
		assert.equal(r.remoteModifiedAt, null, change);
		assert.equal(r.lastError, null, change);
		if (change === "edited") assert.equal(bodyOf(s, id), "My own words");
	}
});

test("N3: an unpublish that lands while the create's answer is being lost: the job looks for the draft and deletes it", async () => {
	const s = site();
	s.post("A");
	s.fake.fail({ method: "GET", path: "/v1/emails" }, { during: async () => {
		s.entries.get("A").status = "draft";
		await s.fire("unpublish", "A");
	} });
	s.fake.fail({ method: "POST", path: "/v1/emails" }, { lose: true });
	await s.event("publish", "A");
	const r = await s.record("A");
	assert.equal(s.fake.emails.size, 0, "the draft the lost create made is gone");
	assert.equal(r.state, "removed");
	assert.equal(r.job, null);
});

test("N3: the decisions: an unanswered create is looked for when the post leaves, and a publish before that look creates (and so adopts)", () => {
	const lost = { ...core.newRecord("posts", "1", T0), state: "error", job: "sync", createSentAt: new Date(T0).toISOString(), lastError: { at: "", status: 0, code: "network", message: "" } };
	const on = { live: true, matches: true, newEnough: true, updatesOn: true };
	for (const kind of ["unpublish", "trash", "delete"]) {
		const d = core.decideEvent(kind, lost, on);
		assert.equal(d.run, "remove", kind);
		assert.equal(d.patch.state, "removing", kind);
		assert.equal(d.patch.lastError, null, kind);
	}
	assert.equal(core.decideEvent("unpublish", { ...lost, createSentAt: null }, on).run, null, "a create that was refused: nothing to look for");
	assert.equal(core.decideEvent("unpublish", { ...lost, createSentAt: null }, on).patch.state, "stopped");
	// Published again while that look is still waiting (its job was dropped), with updates on or off: a create, never a "draft" with no email.
	for (const updatesOn of [true, false]) {
		const waiting = { ...lost, state: "removing", job: "remove", unpublished: true, lastError: null };
		const d = core.decideEvent("publish", waiting, { ...on, updatesOn });
		assert.equal(d.run, "sync", `updates ${updatesOn}`);
		assert.equal(d.patch.state, "pending");
		assert.equal(d.patch.unpublished, false);
		const failed = core.decideEvent("publish", { ...lost, job: "remove", unpublished: true }, { ...on, updatesOn });
		assert.equal(failed.run, "sync", `updates ${updatesOn}`);
	}
});

test("N3: a create Buttondown refused, then an unpublish: no lookup, no call at all", async () => {
	const s = site();
	s.post("A");
	s.fake.fail({ method: "POST", path: "/v1/emails" }, { status: 422, code: "invalid", detail: "No." });
	await s.event("publish", "A");
	assert.equal((await s.record("A")).createSentAt, null);
	const calls = s.fake.calls.length;
	await s.unpublish("A");
	assert.equal(s.fake.calls.length, calls);
	assert.equal((await s.record("A")).state, "stopped");
});

test("N3: a lost create, an unpublish whose lookup fails, then a republish: the draft is adopted, not doubled", async () => {
	for (const updates of [true, false]) {
		const s = site({ features: { "buttondown.updates": updates } });
		const id = await lostCreate(s);
		s.fake.fail({ method: "GET", path: "/v1/emails" }, { status: 500 });
		await s.unpublish("A");
		let r = await s.record("A");
		assert.equal(r.state, "error");
		assert.equal(r.job, "remove");
		assert.equal(s.fake.emails.has(id), true);
		await s.republish("A");
		r = await s.record("A");
		assert.equal(r.state, "draft", `updates ${updates}`);
		assert.equal(r.emailId, id);
		assert.equal(s.fake.count("POST /v1/emails"), 1);
		assert.equal(s.fake.count("DELETE"), 0);
	}
});

test("N4: failures end after 3 days: 429 stops being retried too, the alert stops, and the record is pruned with the others", async () => {
	const longAgo = { attempts: 20, errorSince: new Date(T0 - 3 * 86_400_000).toISOString() };
	assert.equal(core.failure({ status: 429, code: null, retryAfter: 60 }, longAgo, T0).nextRetryAt, null, "429 for 3 days: not on its own any more");
	assert.ok(core.failure({ status: 429, code: null, retryAfter: 60 }, { attempts: 20, errorSince: new Date(T0 - 2 * 86_400_000).toISOString() }, T0).nextRetryAt);

	const s = site();
	s.post("A");
	s.fake.fail({ method: "POST", path: "/v1/emails" }, { status: 422, code: "invalid", detail: "No." });
	await s.event("publish", "A");
	s.advance(2 * 3600_000);
	assert.equal((await failingRecords(s.ctx, s.now())).length, 1, "reported while it's fresh");
	s.advance(3 * 86_400_000);
	assert.equal((await failingRecords(s.ctx, s.now())).length, 0, "not after 3 days");
	assert.equal((await s.record("A")).state, "error", "still listed as failed on the page, with Retry");
	s.advance(178 * 86_400_000);
	assert.equal((await retryDue(s.ctx, s.deps)).pruned, 1);
	assert.equal(await s.record("A"), null);
});

test("N4: rules that couldn't be read leave nothing behind for collections without a rule, once they read again", async () => {
	const s = site();
	s.hooks.settings = async () => {
		throw new Error("D1 down");
	};
	for (const id of ["P1", "P2", "P3"]) await handleEvent(s.ctx, s.deps, "save", { collection: "pages", content: { id, status: "published", draftRevisionId: null } });
	await settleJobsForTests();
	assert.equal((await allRecords(s)).length, 3);
	// Down for over 3 days: the records are out of retries.
	for (let h = 0; h < 100; h++) {
		s.advance(3600_000);
		await retryDue(s.ctx, s.deps);
	}
	assert.ok((await allRecords(s)).every((r) => r.state === "error" && r.nextRetryAt === null));
	assert.equal((await failingRecords(s.ctx, s.now())).length, 0, "no alert for a collection that has no rule");
	// The rules read again: the next hourly run forgets them.
	s.hooks.settings = null;
	s.advance(3600_000);
	await retryDue(s.ctx, s.deps);
	assert.deepEqual(await allRecords(s), []);
	assert.equal(s.fake.calls.length, 0);
});

test("N4: a short outage of the rules: no alert for a page without a rule, and a post with a rule is still reported", async () => {
	const s = site();
	s.post("A");
	s.hooks.settings = async () => {
		throw new Error("D1 down");
	};
	await handleEvent(s.ctx, s.deps, "save", { collection: "pages", content: { id: "P1", status: "published", draftRevisionId: null } });
	await s.event("publish", "A");
	s.advance(2 * 3600_000);
	assert.deepEqual((await failingRecords(s.ctx, s.now())).map((r) => r.collection), ["posts"]);
});

test("N5: Refresh draft from post writes nothing when the email no longer carries the Pack's key for the post", async () => {
	assert.equal(core.classifyRemote({ status: "draft", modificationDate: "m2", key: "other" }, { remoteModifiedAt: "m1" }, "k", "m2"), "edited");
	assert.equal(core.classifyRemote({ status: "draft", modificationDate: "m2", key: null }, { remoteModifiedAt: "m1" }, "k", "m2"), "edited");
	const s = site();
	s.post("A");
	await s.event("publish", "A");
	const id = s.fake.drafts()[0].id;
	s.fake.edit(id, { body: "Mine", metadata: { coywolf_pack: { key: "coywolf.com:posts:OTHER" } } });
	s.entries.get("A").data.content = [para("v2")];
	const out = await sync.refreshDraft(s.ctx, s.deps, "posts", "A", seenOf(s, id));
	assert.equal(out.unkeyed, true);
	assert.equal(out.moved, false);
	assert.equal(out.record.state, "edited");
	assert.equal(bodyOf(s, id), "Mine");
	assert.equal(s.fake.count("PATCH"), 0);
	assert.equal(s.fake.emails.get(id).metadata.coywolf_pack.key, "coywolf.com:posts:OTHER");
});

test("N6: a refused key isn't tried again by a republish, and the 403's one retry an hour later is kept", async () => {
	const s = site();
	s.post("A");
	s.fake.fail({ method: "POST", path: "/v1/emails" }, { status: 403, code: "forbidden", detail: "No.", persist: true });
	await s.event("publish", "A");
	const planned = (await s.record("A")).nextRetryAt;
	assert.equal(planned, new Date(s.now() + 60 * 60_000).toISOString());
	assert.match((await s.record("A")).lastError.message, /tries once more/);
	const calls = s.fake.calls.length;
	for (let i = 0; i < 3; i++) {
		s.advance(60_000);
		await s.republish("A", { content: [para(`v${i}`)] });
	}
	let r = await s.record("A");
	assert.equal(s.fake.calls.length, calls, "no call with the refused key");
	assert.equal(r.nextRetryAt, planned, "the planned retry stands");
	assert.equal(r.attempts, 1);
	s.advance(60 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 1);
	r = await s.record("A");
	assert.equal(s.fake.count("POST /v1/emails"), 2);
	assert.equal(r.nextRetryAt, null, "refused again: parked");
	assert.doesNotMatch(r.lastError.message, /tries once more/);
	for (let h = 0; h < 5; h++) {
		s.advance(3600_000);
		await retryDue(s.ctx, s.deps);
		await s.republish("A");
	}
	assert.equal(s.fake.count("POST /v1/emails"), 2, "nothing more until the key changes or Retry");
	// Retry (the permissions were fixed in Buttondown) runs it, with the post as it is now.
	s.fake.clearFailures();
	await runManual(s.ctx, s.deps, "retry", "posts", "A");
	assert.equal((await s.record("A")).state, "draft");
	assert.match(s.fake.drafts()[0].body, /v2/);
});

test("N6: once another key is saved, a republish runs at once", async () => {
	const s = site({ settings: { buttondownApiKey: "the-old-key-0123456789abcdef" } });
	s.post("A");
	await s.event("publish", "A");
	assert.equal((await s.record("A")).lastError.status, 401);
	const calls = s.fake.calls.length;
	await s.republish("A");
	assert.equal(s.fake.calls.length, calls, "same key: no call");
	await s.ctx.settings.set("buttondownApiKey", s.fake.key);
	await s.republish("A");
	assert.equal((await s.record("A")).state, "draft");
});

/** Emails made through the API long ago, for other posts (sent since). */
async function oldApiEmails(s, n) {
	const headers = { Authorization: `Token ${s.fake.key}` };
	for (let i = 0; i < n; i++) {
		const made = await (await s.fake.fetch("https://api.buttondown.com/v1/emails", { method: "POST", headers, body: JSON.stringify({ subject: `Old ${i}`, body: "x", status: "draft", metadata: { coywolf_pack: { key: `coywolf.com:posts:OLD${i}` } } }) })).json();
		const email = s.fake.emails.get(made.id);
		email.status = "sent";
		email.creation_date = new Date(T0 - (30 - i) * 86_400_000).toISOString();
		email.modification_date = email.creation_date;
	}
	s.fake.calls.length = 0;
}

test("N7: the lookup stops at emails older than the post's record: one list call, however many old emails there are", async () => {
	const s = site({ fake: fakeButtondown({ pageSize: 2 }) });
	await oldApiEmails(s, 7);
	const id = await lostCreate(s);
	assert.equal(listCalls(s), 1, "the first create's lookup");
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal(listCalls(s), 2, "and the retry's");
	const r = await s.record("A");
	assert.equal(r.state, "draft");
	assert.equal(r.emailId, id);
	assert.equal(s.fake.drafts().length, 1);
});

test("N7: newer emails don't hide the lost draft: the lookup reads on while a page holds only newer ones, three pages at most", async () => {
	const s = site({ fake: fakeButtondown({ pageSize: 2 }) });
	await oldApiEmails(s, 7);
	const id = await lostCreate(s);
	for (const other of ["B", "C"]) {
		s.post(other);
		await s.event("publish", other);
	}
	const before = listCalls(s);
	s.advance(6 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal(listCalls(s) - before, 2, "page 1 holds only newer drafts; page 2 has it, and an older email ends the search");
	assert.equal((await s.record("A")).emailId, id);
	assert.equal(s.fake.count("POST /v1/emails"), 3, "no second draft for A");
	// Never more than three list calls for one lookup.
	for (const other of ["E", "F", "G", "H", "I", "J"]) {
		s.post(other);
		const n = listCalls(s);
		await s.event("publish", other);
		assert.ok(listCalls(s) - n <= 3, other);
	}
});

const failingSetting = (s, key) => {
	const get = s.ctx.settings.get.bind(s.ctx.settings);
	s.ctx.settings.get = async (k) => {
		if (k === key) throw new Error("D1 down");
		return get(k);
	};
	return () => (s.ctx.settings.get = get);
};

test("N8: a read the email is built from fails during a republish: an error to retry, never a poorer body over the draft", async () => {
	const { PODCAST_SETTINGS_KEY, SETTINGS_KEY } = await import("../src/customBlocks/settings.ts");
	const cases = [
		["the disclosure settings", { _type: "coywolf-disclosure", _key: "d", kind: "amazon" }, (s) => failingSetting(s, SETTINGS_KEY)],
		["the podcast settings", { _type: "coywolf-podcast", _key: "p" }, (s) => failingSetting(s, PODCAST_SETTINGS_KEY)],
		["the post's files", { _type: "coywolf-file", _key: "f", id: "01FILE", title: "The guide" }, (s) => {
			const files = s.deps.files;
			s.deps.files = async () => {
				throw new Error("D1 down");
			};
			return () => (s.deps.files = files);
		}],
	];
	for (const [what, block, breakIt] of cases) {
		const s = site();
		s.post("A", { data: { title: "Post A", excerpt: "Short.", content: [para("Hello."), block] } });
		await s.event("publish", "A");
		const id = s.fake.drafts()[0].id;
		const before = bodyOf(s, id);
		const mend = breakIt(s);
		await s.republish("A", { content: [para("Second version."), block] });
		let r = await s.record("A");
		assert.equal(r.state, "error", what);
		assert.equal(r.lastError.code, "read_failed", what);
		assert.ok(r.nextRetryAt, what);
		assert.equal(s.fake.count("PATCH"), 0, what);
		assert.equal(bodyOf(s, id), before, what);
		mend();
		s.advance(6 * 60_000);
		await retryDue(s.ctx, s.deps);
		r = await s.record("A");
		assert.equal(r.state, "draft", what);
		assert.match(bodyOf(s, id), /Second version\./, what);
	}
});

// Run: node --test test/buttondown-sync.test.mjs
//
// Buttondown Drafts' lifecycle (src/buttondown/sync-core.ts, src/buttondown/sync.ts) against the fake
// Buttondown: one row of docs/buttondown.md's table per case, the since rule, the Updates part, deletes of
// untouched drafts only (D2), no duplicates (one claim wins, a lost answer is adopted, a stale claim is taken
// over), failures and their retries, and never a call that could send.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import "./ts-resolve.mjs";
import { FAKE_KEY, fakeButtondown } from "./fixtures/buttondown-fake.mjs";
import { fakeCollection } from "./fixtures/fake-plugin.mjs";
import { T0, fakes, site } from "./fixtures/buttondown-site.mjs";

const core = await import("../src/buttondown/sync-core.ts");
const sync = await import("../src/buttondown/sync.ts");
const { invalidateFeatures } = await import("../src/core/features.ts");
await import("../src/buttondown/pack.ts");

const { decideEvent, failure, classifyRemote, adoptable, isStuck, recordId } = core;
const { handleEvent, runEntry, runManual, manualRefusal, retryDue, settleJobsForTests, keyFingerprint } = sync;

afterEach(() => {
	invalidateFeatures();
	// No call with a non-draft status, a send or publish path, the Live-Dangerously header, a forbidden PATCH field,
	// or a DELETE without its own read just before, in any test.
	const violations = [...fakes].flatMap((fake) => fake.violations);
	fakes.clear();
	assert.deepEqual(violations, []);
});

const facts = (f = {}) => ({ live: true, matches: true, newEnough: true, updatesOn: true, ...f });
const rec = (state, extra = {}) => ({ ...core.newRecord("posts", "1", T0), state, job: null, emailId: "em_0000000000000000000000000a", ...extra });

test("the state machine, row by row (docs/buttondown.md, What happens when)", () => {
	const cases = [
		["first publish, matches", "publish", null, facts(), "sync"],
		["first publish, doesn't match", "publish", null, facts({ matches: false }), null],
		["published before the rule", "publish", null, facts({ newEnough: false }), null],
		["draft revision save", "save", rec("draft"), facts({ live: false }), null],
		["republish, updates on", "publish", rec("draft"), facts(), "sync"],
		["republish, updates off", "publish", rec("draft"), facts({ updatesOn: false }), null],
		["republish, not a draft any more: checked again", "publish", rec("left"), facts(), "sync"],
		["republish, edited in Buttondown", "publish", rec("edited"), facts(), null],
		["republish, deleted in Buttondown", "publish", rec("gone"), facts(), null],
		["category removed", "publish", rec("draft"), facts({ matches: false }), null],
		["unpublish, untouched draft", "unpublish", rec("draft"), facts(), "remove"],
		["unpublish, edited", "unpublish", rec("edited"), facts(), null],
		["unpublish, sent: its own read decides", "unpublish", rec("left"), facts(), "remove"],
		["publish again after the Pack deleted it", "publish", rec("removed", { emailId: null }), facts(), "sync"],
		["trash", "trash", rec("draft"), facts(), "remove"],
		["restore", "restore", rec("removed", { trashed: true }), facts(), null],
		["permanent delete", "delete", rec("draft"), facts(), "remove"],
		["publish while a delete waits: cancelled, updated", "publish", rec("removing", { job: "remove" }), facts(), "sync"],
		["a job holds it", "publish", rec("creating", { emailId: null, job: "sync" }), facts(), "sync"],
		["stopped, matches again", "publish", rec("stopped"), facts(), "sync"],
		["no record, unpublish", "unpublish", null, facts(), null],
	];
	for (const [name, kind, record, f, run] of cases) assert.equal(decideEvent(kind, record, f).run, run, name);
	assert.deepEqual(decideEvent("publish", rec("draft"), facts({ matches: false })).patch, { state: "stopped", job: null, nextRetryAt: null }, "category removed: stopped, the draft left alone");
	assert.equal(decideEvent("unpublish", rec("edited"), facts()).patch.unpublished, true, "kept with a note");
	assert.deepEqual(decideEvent("restore", rec("removed", { trashed: true }), facts()).patch, { trashed: false });
	assert.equal(decideEvent("delete", rec("edited"), facts()).patch.state, "stopped");
	assert.equal(decideEvent("publish", rec("removing", { job: "remove" }), facts({ updatesOn: false })).patch.state, "draft", "delete cancelled with updates off");
	assert.equal(decideEvent("publish", rec("draft", { unpublished: true }), facts()).patch.unpublished, false, "published again: the flag clears");
	assert.equal(decideEvent("unpublish", rec("creating", { emailId: null, job: "sync" }), facts()).patch.dirty, true, "a job under way checks again when it's done");
});

test("Buttondown's answer for an update: only an untouched draft with the Pack's key is written (unless Refresh asks)", () => {
	const r = { remoteModifiedAt: "m1" };
	assert.equal(classifyRemote(null, r, "k"), "gone");
	assert.equal(classifyRemote({ status: "scheduled", modificationDate: "m1", key: "k" }, r, "k"), "left");
	assert.equal(classifyRemote({ status: "sent", modificationDate: "m1", key: "k" }, r, "k", "m1"), "left", "Refresh never writes a sent email");
	assert.equal(classifyRemote({ status: "draft", modificationDate: "m2", key: "k" }, r, "k"), "edited");
	assert.equal(classifyRemote({ status: "draft", modificationDate: "m1", key: "other" }, r, "k"), "edited");
	assert.equal(classifyRemote({ status: "draft", modificationDate: "m2", key: "k" }, r, "k", "m2"), "update", "Refresh: Buttondown shows what the admin saw");
	assert.equal(classifyRemote({ status: "draft", modificationDate: "m3", key: "k" }, r, "k", "m2"), "edited", "Refresh: changed again since the admin looked");
	assert.equal(classifyRemote({ status: "draft", modificationDate: "m1", key: "k" }, r, "k", "m2"), "edited", "Refresh: only the exact date the admin saw");
	assert.equal(classifyRemote({ status: "draft", modificationDate: null, key: "k" }, r, "k", ""), "edited", "Refresh: no date seen, no write");
	assert.equal(classifyRemote({ status: "draft", modificationDate: "m1", key: "k" }, { remoteModifiedAt: null }, "k"), "edited", "no date of the Pack's own: never taken for untouched");
	assert.equal(classifyRemote({ status: "draft", modificationDate: "m1", key: "k" }, r, "k"), "update");
	assert.equal(adoptable({ modificationDate: "2026-11-15T12:00:00.001Z", creationDate: "2026-11-15T12:00:00.000Z" }), true);
	assert.equal(adoptable({ modificationDate: "2026-11-15T12:05:00.000Z", creationDate: "2026-11-15T12:00:00.000Z" }), false);
});

test("failures: 429 after Retry-After (5 minutes at least), backoff for 5xx and no answer for 3 days, no retry for refused keys or bad requests", () => {
	const r = { attempts: 0, errorSince: null };
	assert.equal(failure({ status: 429, code: null, retryAfter: 30 }, r, T0).nextRetryAt, new Date(T0 + 5 * 60_000).toISOString());
	assert.equal(failure({ status: 429, code: null, retryAfter: 900 }, r, T0).nextRetryAt, new Date(T0 + 900_000).toISOString());
	const steps = [5, 15, 60, 180, 360, 360].map((m) => new Date(T0 + m * 60_000).toISOString());
	steps.forEach((at, attempts) => assert.equal(failure({ status: 503, code: null, retryAfter: null }, { attempts, errorSince: new Date(T0).toISOString() }, T0).nextRetryAt, at));
	assert.equal(failure({ status: 0, code: "timeout", retryAfter: null }, { attempts: 9, errorSince: new Date(T0 - 3 * 86_400_000).toISOString() }, T0).nextRetryAt, null, "given up after 3 days");
	assert.deepEqual(failure({ status: 401, code: null, retryAfter: null }, r, T0), { kind: "auth", nextRetryAt: null });
	// 403: once more an hour later (Buttondown throttles with 403 too), then like 401.
	assert.deepEqual(failure({ status: 403, code: null, retryAfter: null }, r, T0), { kind: "auth", nextRetryAt: new Date(T0 + 60 * 60_000).toISOString() });
	assert.deepEqual(failure({ status: 403, code: null, retryAfter: null }, { attempts: 1, errorSince: null }, T0), { kind: "auth", nextRetryAt: null });
	assert.deepEqual(failure({ status: 0, code: "no_key", retryAfter: null }, r, T0), { kind: "auth", nextRetryAt: null });
	for (const status of [400, 422]) assert.deepEqual(failure({ status, code: "subject_invalid", retryAfter: null }, r, T0), { kind: "fatal", nextRetryAt: null });
	assert.equal(failure({ status: 0, code: null, retryAfter: null, refused: true }, r, T0).kind, "refused");
});

test("first publish of a matching post: one draft, status draft, with the post's fields; the record says draft", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	const drafts = s.fake.drafts();
	assert.equal(drafts.length, 1);
	assert.equal(drafts[0].subject, "Post P1");
	assert.equal(drafts[0].canonical_url, "https://coywolf.com/newsletter/post-p1/");
	assert.equal(drafts[0].description, "Short.");
	assert.equal(drafts[0].metadata.coywolf_pack.key, "coywolf.com:posts:P1");
	const r = await s.record("P1");
	assert.equal(r.state, "draft");
	assert.equal(r.emailId, drafts[0].id);
	assert.equal(r.remoteModifiedAt, drafts[0].modification_date);
	assert.equal(r.title, "Post P1");
	assert.equal(r.claimToken, null);
	assert.equal(s.fake.count("POST /v1/emails"), 1);
	assert.deepEqual(s.fake.violations, []);
	// Logs name the entry and the email, never the subject, the body, the description or the key.
	const logs = JSON.stringify(s.ctx.log.lines);
	assert.match(logs, /draft created/);
	for (const secret of ["Post P1", "Hello.", "Short.", FAKE_KEY]) assert.ok(!logs.includes(secret), secret);
});

test("posts that don't match, draft revision saves and unrelated collections cost no call and no record", async () => {
	const s = site();
	s.post("P1");
	s.terms.set("P1", ["other"]);
	await s.event("publish", "P1");
	s.post("P2", { draftRevisionId: "rev1" });
	await s.event("save", "P2");
	await handleEvent(s.ctx, s.deps, "publish", { collection: "pages", content: { id: "X", status: "published" } });
	await s.event("unpublish", "P1");
	assert.equal(s.fake.calls.length, 0);
	assert.equal(s.ctx.storage.buttondownEmails.rows.size, 0);
});

test("a child term of a chosen term counts", async () => {
	const s = site();
	s.post("P1");
	s.terms.set("P1", ["newsletter-extra"]);
	await s.event("publish", "P1");
	assert.equal(s.fake.drafts().length, 1);
});

test("since: a post first published before the rule gets no draft on its own, and Create draft now makes one", async () => {
	const s = site();
	s.post("OLD", { publishedAt: "2026-11-01T00:00:00.000Z" });
	await s.event("publish", "OLD");
	await s.event("save", "OLD");
	assert.equal(s.fake.calls.length, 0);
	assert.equal(await s.record("OLD"), null);
	assert.equal(await manualRefusal(s.ctx, s.deps, "create", "posts", "OLD", null), null);
	const r = await runManual(s.ctx, s.deps, "create", "posts", "OLD");
	assert.equal(r.state, "draft");
	assert.equal(r.manual, true);
	assert.equal(s.fake.drafts().length, 1);
	// Create draft now needs a published post that matches, and no draft already.
	assert.match(await manualRefusal(s.ctx, s.deps, "create", "posts", "OLD", r), /already has a draft/);
	s.post("DRAFTONLY", { status: "draft" });
	assert.match(await manualRefusal(s.ctx, s.deps, "create", "posts", "DRAFTONLY", null), /Publish the post first/);
	s.post("NOMATCH");
	s.terms.set("NOMATCH", []);
	assert.match(await manualRefusal(s.ctx, s.deps, "create", "posts", "NOMATCH", null), /doesn't have one of the rule's terms/);
	assert.deepEqual(s.fake.violations, []);
});

test("republish with the Updates part on updates the draft; an unchanged post costs no call; with the part off nothing is written", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	const calls = s.fake.calls.length;
	await s.republish("P1");
	assert.equal(s.fake.calls.length, calls, "same hash: no call");
	await s.republish("P1", { title: "Post P1, revised" });
	assert.equal(s.fake.count("PATCH"), 1);
	const email = s.fake.drafts()[0];
	assert.equal(email.subject, "Post P1, revised");
	assert.equal((await s.record("P1")).remoteModifiedAt, email.modification_date);
	// The Updates part off: no write.
	await s.ctx.settings.set("features", { _defaults036: true, buttondown: true, "buttondown.updates": false });
	invalidateFeatures();
	await s.republish("P1", { title: "Third" });
	assert.equal(s.fake.count("PATCH"), 1);
	assert.equal(s.fake.drafts()[0].subject, "Post P1, revised");
	assert.equal(s.fake.drafts().length, 1);
	assert.deepEqual(s.fake.violations, []);
});

test("a live edit (afterSave of a published entry without a draft revision) counts as a republish", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	s.entries.get("P1").data.title = "Edited live";
	await s.event("save", "P1");
	assert.equal(s.fake.drafts()[0].subject, "Edited live");
});

test("not a draft in Buttondown (scheduled, sent): left alone; when it's an untouched draft again, updates resume", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	const id = s.fake.drafts()[0].id;
	s.fake.setStatus(id, "scheduled", { keepModified: true });
	await s.republish("P1", { title: "Changed" });
	assert.equal(s.fake.count("PATCH"), 0);
	let r = await s.record("P1");
	assert.equal(r.state, "left");
	assert.equal(r.remoteStatus, "scheduled");
	s.fake.setStatus(id, "draft", { keepModified: true });
	await s.republish("P1", { title: "Changed again" });
	r = await s.record("P1");
	assert.equal(r.state, "draft");
	assert.equal(s.fake.emails.get(id).subject, "Changed again");
	// Sent: never written, even by Refresh draft from post.
	s.fake.setStatus(id, "sent");
	await s.republish("P1", { title: "After sending" });
	assert.equal((await s.record("P1")).state, "left");
	assert.match(await manualRefusal(s.ctx, s.deps, "refresh", "posts", "P1", await s.record("P1")), /Only a draft/);
	assert.equal(s.fake.emails.get(id).subject, "Changed again");
	assert.deepEqual(s.fake.violations, []);
});

test("edited in Buttondown: not updated; Refresh draft from post overwrites it (still only a draft)", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	const id = s.fake.drafts()[0].id;
	s.fake.edit(id, { body: "My own words" });
	await s.republish("P1", { title: "Changed" });
	assert.equal(s.fake.count("PATCH"), 0);
	assert.equal((await s.record("P1")).state, "edited");
	assert.equal(s.fake.emails.get(id).body, "My own words");
	// The admin is shown the draft as Buttondown has it now, and confirms.
	const seen = s.fake.emails.get(id).modification_date;
	assert.equal(await manualRefusal(s.ctx, s.deps, "refresh", "posts", "P1", await s.record("P1"), seen), null);
	s.fake.allowOverwrite(id);
	const r = await runManual(s.ctx, s.deps, "refresh", "posts", "P1", { seen });
	assert.equal(r.state, "draft");
	assert.ok(!("force" in r));
	assert.equal(r.remoteModifiedAt, s.fake.emails.get(id).modification_date);
	assert.equal(s.fake.emails.get(id).subject, "Changed");
	// Buttondown's own metadata keys stay.
	assert.equal(s.fake.emails.get(id).metadata.coywolf_pack.key, "coywolf.com:posts:P1");
	assert.deepEqual(s.fake.violations, []);
});

test("deleted in Buttondown: never made again on its own; Create draft now makes a new one", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	s.fake.emails.clear();
	await s.republish("P1", { title: "Changed" });
	assert.equal((await s.record("P1")).state, "gone");
	await s.republish("P1", { title: "Again" });
	assert.equal(s.fake.count("POST /v1/emails"), 1, "not recreated");
	const r = await runManual(s.ctx, s.deps, "create", "posts", "P1");
	assert.equal(r.state, "draft");
	assert.equal(s.fake.drafts().length, 1);
	assert.equal(s.fake.count("POST /v1/emails"), 2);
});

test("category removed after publish: on the next event the Pack stops watching and leaves the draft alone", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	const calls = s.fake.calls.length;
	s.terms.set("P1", ["other"]);
	await s.republish("P1", { title: "Changed" });
	assert.equal(s.fake.calls.length, calls);
	assert.equal((await s.record("P1")).state, "stopped");
	assert.equal(s.fake.drafts().length, 1);
	// Unpublished while stopped: kept.
	await s.unpublish("P1");
	assert.equal(s.fake.drafts().length, 1);
});

test("D2: unpublish deletes an untouched draft (removed); publishing again makes one new draft", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	await s.unpublish("P1");
	assert.equal(s.fake.emails.size, 0);
	assert.equal(s.fake.count("DELETE"), 1);
	let r = await s.record("P1");
	assert.equal(r.state, "removed");
	assert.equal(r.unpublished, true);
	assert.equal(r.emailId, null);
	await s.republish("P1");
	r = await s.record("P1");
	assert.equal(r.state, "draft");
	assert.equal(r.unpublished, false);
	assert.equal(s.fake.drafts().length, 1);
	assert.deepEqual(s.fake.violations, []);
});

test("D2: an edited draft is kept on unpublish, with a note; a sent one is left; a deleted one is gone", async () => {
	for (const [name, change, state] of [
		["edited", (fake, id) => fake.edit(id, { subject: "Mine" }), "edited"],
		["sent", (fake, id) => fake.setStatus(id, "sent"), "left"],
		["scheduled", (fake, id) => fake.setStatus(id, "scheduled"), "left"],
		["deleted there", (fake, id) => fake.emails.delete(id), "gone"],
	]) {
		const s = site();
		s.post("P1");
		await s.event("publish", "P1");
		change(s.fake, [...s.fake.emails.keys()][0]);
		await s.unpublish("P1");
		assert.equal(s.fake.count("DELETE"), 0, name);
		const r = await s.record("P1");
		assert.equal(r.state, state, name);
		assert.equal(r.unpublished, true, name);
		if (state === "edited") assert.match(core.stateText(r), /Kept because you edited it in Buttondown/);
		assert.deepEqual(s.fake.violations, [], name);
	}
});

test("trash deletes an untouched draft; restoring makes no call (EmDash restores it as a draft); a permanent delete deletes and stops", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	await s.event("trash", "P1");
	assert.equal(s.fake.emails.size, 0);
	let r = await s.record("P1");
	assert.equal(r.state, "removed");
	assert.equal(r.trashed, true);
	const calls = s.fake.calls.length;
	s.entries.get("P1").status = "draft";
	await s.event("restore", "P1");
	assert.equal(s.fake.calls.length, calls);
	assert.equal((await s.record("P1")).trashed, false);

	const d = site();
	d.post("P2");
	await d.event("publish", "P2");
	d.entries.delete("P2");
	await d.event("delete", "P2");
	assert.equal(d.fake.emails.size, 0);
	r = await d.record("P2");
	assert.equal(r.state, "stopped");
	assert.equal(r.deleted, true);
	assert.deepEqual([...s.fake.violations, ...d.fake.violations], []);
});

test("a delete that's waiting for a retry is cancelled when the post is published again first: the draft is updated instead", async () => {
	const s = site();
	s.post("P1");
	await s.event("publish", "P1");
	s.fake.fail({ method: "GET", path: /^\/v1\/emails\/em_/ }, { status: 503 });
	await s.unpublish("P1");
	let r = await s.record("P1");
	assert.equal(r.state, "error");
	assert.equal(r.job, "remove");
	assert.ok(r.nextRetryAt);
	await s.republish("P1", { title: "Back" });
	r = await s.record("P1");
	assert.equal(r.state, "draft");
	assert.equal(s.fake.count("DELETE"), 0);
	assert.equal(s.fake.drafts()[0].subject, "Back");
	// The hourly task has nothing left to do.
	s.advance(60 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 0);
	assert.equal(s.fake.count("DELETE"), 0);
});

test("the hook firing twice in one isolate (afterSave and afterPublish of one publish): one POST", async () => {
	const s = site();
	s.post("P1");
	const item = s.entries.get("P1");
	await Promise.all([handleEvent(s.ctx, s.deps, "save", { collection: "posts", content: item }), handleEvent(s.ctx, s.deps, "publish", { collection: "posts", content: item })]);
	await settleJobsForTests();
	assert.equal(s.fake.count("POST /v1/emails"), 1);
	assert.equal(s.fake.drafts().length, 1);
});

test("two isolates at once (two contexts on one store): only one claim wins, one POST", async () => {
	const storage = fakeCollection();
	const fake = fakeButtondown();
	const a = site({ fake, storage });
	const b = site({ fake, storage });
	a.post("P1");
	b.post("P1");
	await storage.put(recordId("posts", "P1"), core.newRecord("posts", "P1", T0));
	const [ra, rb] = await Promise.all([runEntry(a.ctx, a.deps, "posts", "P1", T0 + 25_000), runEntry(b.ctx, b.deps, "posts", "P1", T0 + 25_000)]);
	assert.equal(fake.count("POST /v1/emails"), 1);
	assert.equal(fake.drafts().length, 1);
	assert.ok([ra?.state, rb?.state].includes("draft"));
	const r = core.readRecord(await storage.get(recordId("posts", "P1")));
	assert.equal(r.state, "draft");
	assert.equal(r.claimToken, null);
	assert.equal(r.dirty, false);
});

test("a POST that lands but whose answer is lost: the retry finds the draft by its key and adopts it (still one draft)", async () => {
	const s = site();
	s.post("P1");
	s.fake.fail({ method: "POST" }, { lose: true });
	await s.event("publish", "P1");
	let r = await s.record("P1");
	assert.equal(r.state, "error");
	assert.equal(r.lastError.code, "network");
	assert.equal(s.fake.drafts().length, 1, "it landed");
	s.advance(6 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 1);
	r = await s.record("P1");
	assert.equal(r.state, "draft");
	assert.equal(r.emailId, s.fake.drafts()[0].id);
	assert.equal(s.fake.drafts().length, 1);
	assert.equal(s.fake.count("POST /v1/emails"), 1);
	assert.deepEqual(s.fake.violations, []);
});

test("a stale claim (its job was cut off) is taken over by the hourly task: one draft, adopted when the POST had landed", async () => {
	for (const landed of [false, true]) {
		const s = site();
		s.post("P1");
		if (landed) {
			// The cut-off job's POST reached Buttondown.
			s.fake.fail({ method: "POST" }, { lose: true });
			await s.event("publish", "P1");
		}
		await s.ctx.storage.buttondownEmails.put(recordId("posts", "P1"), { ...core.newRecord("posts", "P1", T0), state: "creating", claimToken: "dead-job", claimedAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() });
		assert.equal(isStuck(await s.record("P1"), T0 + 4 * 60_000), false);
		s.advance(6 * 60_000);
		assert.equal((await retryDue(s.ctx, s.deps)).retried, 1, `landed: ${landed}`);
		assert.equal((await s.record("P1")).state, "draft");
		assert.equal(s.fake.drafts().length, 1, `landed: ${landed}`);
	}
});

test("a job that runs past its claim while another takes over: the second draft it made is named on the record, never lost", async () => {
	const { recordView } = await import("../src/buttondown/store.ts");
	const s = site();
	s.post("P1");
	await s.ctx.storage.buttondownEmails.put(recordId("posts", "P1"), core.newRecord("posts", "P1", T0));
	// Job A's POST is slow: meanwhile its claim goes stale and job B (the hourly task, say) takes over and creates first.
	s.fake.fail({ method: "POST" }, { during: async () => {
		s.advance(3 * 60_000);
		await runEntry(s.ctx, s.deps, "posts", "P1", s.now() + 25_000);
	} });
	await runEntry(s.ctx, s.deps, "posts", "P1", T0 + 25 * 60_000);
	const r = await s.record("P1");
	assert.equal(s.fake.drafts().length, 2);
	assert.equal(r.state, "draft");
	assert.equal(r.extraEmails.length, 1);
	assert.notEqual(r.extraEmails[0], r.emailId);
	assert.ok(recordView(r).warnings.some((w) => w.includes(r.extraEmails[0]) && /Delete it there/.test(w)));
});

test("a dropped job: the record waits as pending and the hourly task finishes it", async () => {
	const s = site();
	s.post("P1");
	// The hook queued the record, but its job never ran (waitUntil dropped it).
	await s.ctx.storage.buttondownEmails.put(recordId("posts", "P1"), core.newRecord("posts", "P1", T0));
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 0, "too soon");
	s.advance(5 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 1);
	assert.equal((await s.record("P1")).state, "draft");
});

test("429: a short Retry-After is waited for in the job; a long one leaves it to the hourly task (5 minutes at least)", async () => {
	const s = site();
	s.post("P1");
	s.fake.fail({ method: "POST" }, { status: 429, headers: { "retry-after": "2" } });
	await s.event("publish", "P1");
	assert.deepEqual(s.slept, [2000]);
	assert.equal((await s.record("P1")).state, "draft");

	const l = site();
	l.post("P1");
	l.fake.fail({ method: "POST" }, { status: 429, headers: { "retry-after": "60" } });
	await l.event("publish", "P1");
	const r = await l.record("P1");
	assert.equal(r.state, "error");
	assert.equal(r.nextRetryAt, new Date(l.now() + 5 * 60_000).toISOString());
	assert.match(r.lastError.message, /slow down/);
	l.advance(5 * 60_000);
	await retryDue(l.ctx, l.deps);
	assert.equal((await l.record("P1")).state, "draft");
	assert.equal(l.fake.drafts().length, 1);
});

test("5xx and timeouts back off: 5 minutes, then 15, then an hour", async () => {
	const s = site();
	s.post("P1");
	s.fake.fail({ method: "GET", path: "/v1/emails" }, { status: 500, persist: true });
	await s.event("publish", "P1");
	const gaps = [];
	for (let i = 0; i < 3; i++) {
		const r = await s.record("P1");
		assert.equal(r.state, "error");
		gaps.push(Date.parse(r.nextRetryAt) - s.now());
		s.advance(Date.parse(r.nextRetryAt) - s.now());
		await retryDue(s.ctx, s.deps);
	}
	assert.deepEqual(gaps, [5 * 60_000, 15 * 60_000, 60 * 60_000]);
	const next = (await s.record("P1")).nextRetryAt;
	assert.equal(Date.parse(next) - s.now(), 3 * 60 * 60_000, "then 3 hours");
	s.fake.clearFailures();
	s.advance(60 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 0, "not due yet");
	s.advance(2 * 60 * 60_000);
	await retryDue(s.ctx, s.deps);
	assert.equal((await s.record("P1")).state, "draft");
	assert.equal((await s.record("P1")).attempts, 0);
});

test("a refused key (401, 403) or no key: no retry on its own; once the key is changed, the hourly task tries again", async () => {
	const s = site({ settings: { buttondownApiKey: "the-old-key-0123456789abcdef" } });
	s.post("P1");
	await s.event("publish", "P1");
	let r = await s.record("P1");
	assert.equal(r.state, "error");
	assert.equal(r.lastError.status, 401);
	assert.equal(r.nextRetryAt, null);
	assert.match(r.lastError.message, /refused the key/);
	assert.ok(!JSON.stringify(r).includes("the-old-key-0123456789abcdef"), "the key is nowhere in the record");
	assert.ok(!JSON.stringify(s.ctx.log.lines).includes("the-old-key-0123456789abcdef"), "nor in the logs");
	assert.equal(r.authFingerprint, await keyFingerprint("the-old-key-0123456789abcdef"));
	s.advance(2 * 60 * 60_000);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 0, "same key: not again");
	await s.ctx.settings.set("buttondownApiKey", FAKE_KEY);
	assert.equal((await retryDue(s.ctx, s.deps)).retried, 1);
	r = await s.record("P1");
	assert.equal(r.state, "draft");
	assert.equal(r.authFingerprint, null);

	const n = site({ settings: { buttondownApiKey: null } });
	n.post("P1");
	await n.event("publish", "P1");
	r = await n.record("P1");
	assert.equal(r.lastError.code, "no_key");
	assert.match(r.lastError.message, /No Buttondown API key saved/);
	assert.equal(n.fake.calls.length, 0);
	await n.ctx.settings.set("buttondownApiKey", FAKE_KEY);
	await retryDue(n.ctx, n.deps);
	assert.equal((await n.record("P1")).state, "draft");
});

test("400 and 422: no retry on its own (Retry runs it again); slug_invalid is tried once without the slug", async () => {
	const s = site();
	s.post("P1");
	s.fake.fail({ method: "POST" }, { status: 400, code: "subject_invalid", detail: "Subject is too long." });
	await s.event("publish", "P1");
	let r = await s.record("P1");
	assert.equal(r.state, "error");
	assert.equal(r.nextRetryAt, null);
	assert.equal(r.lastError.code, "subject_invalid");
	assert.match(r.lastError.message, /Subject is too long/);
	assert.equal(await manualRefusal(s.ctx, s.deps, "retry", "posts", "P1", r), null);
	r = await runManual(s.ctx, s.deps, "retry", "posts", "P1");
	assert.equal(r.state, "draft");

	const g = site({ fake: fakeButtondown({ rejectSlugs: ["post-p1"] }) });
	g.post("P1");
	await g.event("publish", "P1");
	r = await g.record("P1");
	assert.equal(r.state, "draft");
	assert.equal(r.noSlug, true);
	assert.equal(g.fake.count("POST /v1/emails"), 2);
	assert.equal(g.fake.drafts().length, 1);
	assert.ok(!("slug" in g.fake.calls.filter((c) => c.method === "POST")[1].body));
});

test("duplicates found in Buttondown: the oldest is used, with a warning to delete the others", async () => {
	const s = site();
	s.post("P1");
	const bd = (await import("../src/buttondown/client.ts")).createButtondownClient({ key: FAKE_KEY, fetch: s.fake.fetch });
	const meta = { coywolf_pack: { v: 1, key: "coywolf.com:posts:P1", collection: "posts", entry: "P1", hash: "x" } };
	const first = await bd.createDraft({ subject: "One", body: "a", metadata: meta });
	await bd.createDraft({ subject: "Two", body: "b", metadata: meta });
	await s.event("publish", "P1");
	const r = await s.record("P1");
	assert.equal(r.emailId, first.id);
	assert.ok(r.warnings.some((w) => /has 2 drafts for this post/.test(w)));
	assert.equal(s.fake.count("POST /v1/emails"), 2, "no third draft");
	assert.equal(s.fake.emails.get(first.id).subject, "Post P1", "untouched since it was made: written");
});

test("an old draft someone edited, found by its key, is adopted without being overwritten", async () => {
	const s = site();
	s.post("P1");
	const bd = (await import("../src/buttondown/client.ts")).createButtondownClient({ key: FAKE_KEY, fetch: s.fake.fetch });
	const old = await bd.createDraft({ subject: "Edited by hand", body: "a", metadata: { coywolf_pack: { key: "coywolf.com:posts:P1", hash: "x" } } });
	s.fake.edit(old.id, { body: "hand written" });
	await s.event("publish", "P1");
	const r = await s.record("P1");
	assert.equal(r.state, "edited");
	assert.equal(r.emailId, old.id);
	assert.equal(s.fake.emails.get(old.id).body, "hand written");
	assert.equal(s.fake.count("PATCH"), 0);
});

test("the hourly task prunes finished records after 180 days, and leaves the rest", async () => {
	const s = site();
	const store = s.ctx.storage.buttondownEmails;
	const old = new Date(T0 - 181 * 86_400_000).toISOString();
	await store.put("posts:A", { ...core.newRecord("posts", "A", T0), state: "gone", job: null, updatedAt: old });
	await store.put("posts:B", { ...core.newRecord("posts", "B", T0), state: "draft", job: null, updatedAt: old });
	await store.put("posts:C", { ...core.newRecord("posts", "C", T0), state: "removed", job: null, updatedAt: new Date(T0).toISOString() });
	assert.equal((await retryDue(s.ctx, s.deps)).pruned, 1);
	assert.deepEqual([...store.rows.keys()].sort(), ["posts:B", "posts:C"]);
});

test("no test above ever sent a call that could send, schedule or publish: the fake's own check", () => {
	// Every test asserts fake.violations is empty where it writes; this one checks the fake catches what it should.
	const fake = fakeButtondown();
	return (async () => {
		await fake.fetch("https://api.buttondown.com/v1/emails", { method: "POST", headers: { Authorization: `Token ${FAKE_KEY}`, "X-Buttondown-Live-Dangerously": "true" }, body: JSON.stringify({ subject: "x", status: "about_to_send" }) });
		await fake.fetch("https://api.buttondown.com/v1/emails/em_1/send-draft", { method: "POST", headers: { Authorization: `Token ${FAKE_KEY}` } });
		await fake.fetch("https://api.buttondown.com/v1/emails/em_1", { method: "DELETE", headers: { Authorization: `Token ${FAKE_KEY}` } });
		assert.ok(fake.violations.some((v) => /Live-Dangerously/.test(v)));
		assert.ok(fake.violations.some((v) => /status about_to_send/.test(v)));
		assert.ok(fake.violations.some((v) => /sending path/.test(v)));
		assert.ok(fake.violations.some((v) => /DELETE without its own read/.test(v)));
	})();
});

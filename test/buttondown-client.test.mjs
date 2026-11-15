// Run: node --test test/buttondown-client.test.mjs
//
// The Buttondown client (src/buttondown/client.ts): one host, one function per allowed call, every create
// a draft, no send or publish, never the Live-Dangerously header, PATCH without the fields that schedule or
// send, DELETE only through deleteDraft after its own read shows an untouched draft, and the key never in
// an error.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";
import { FAKE_KEY, fakeButtondown } from "./fixtures/buttondown-fake.mjs";

const client = await import("../src/buttondown/client.ts");
const { createButtondownClient, guardForTests, ButtondownError, ButtondownRefused, retryAfterSeconds, safeDetail, EMAIL_ID, packKeyOf } = client;
const { scrubToken } = await import("../src/core/cloudflare-api.ts");

const fields = (extra = {}) => ({ subject: "Hello", body: "<!-- buttondown-editor-mode: plaintext -->\nHi", metadata: { coywolf_pack: { v: 1, key: "example.com:posts:1", collection: "posts", entry: "1", hash: "h" } }, ...extra });
const make = (fake = fakeButtondown(), opts = {}) => ({ fake, bd: createButtondownClient({ key: FAKE_KEY, fetch: fake.fetch, ...opts }) });

test("one function per allowed call, and no generic request", () => {
	const { bd } = make();
	assert.deepEqual(Object.keys(bd).sort(), ["checkKey", "createDraft", "deleteDraft", "getEmail", "listApiEmails", "ping", "updateDraft"]);
	assert.equal(typeof client.request, "undefined");
	assert.equal(typeof client.send, "undefined");
});

test("every call goes to https://api.buttondown.com/v1 with Authorization: Token <key>, no redirects, never the Live-Dangerously header", async () => {
	const { fake, bd } = make();
	await bd.ping();
	const draft = await bd.createDraft(fields());
	await bd.getEmail(draft.id);
	await bd.listApiEmails(1);
	await bd.updateDraft(draft.id, { subject: "Changed" });
	await bd.deleteDraft(draft.id, (await bd.getEmail(draft.id)).modificationDate, "example.com:posts:1");
	await bd.checkKey();
	assert.ok(fake.calls.length >= 10);
	for (const call of fake.calls) {
		assert.equal(call.host, "api.buttondown.com");
		assert.ok(call.path.startsWith("/v1/"), call.path);
		assert.equal(call.headers.authorization, `Token ${FAKE_KEY}`);
		assert.equal(call.redirect, "error");
		assert.ok(!("x-buttondown-live-dangerously" in call.headers));
	}
	assert.deepEqual(fake.violations, []);
});

test("createDraft always sends status draft, whatever the caller passes, and only the Pack's fields", async () => {
	const { fake, bd } = make();
	await bd.createDraft(fields({ status: "about_to_send", publish_date: "2026-01-01T00:00:00Z", filters: { x: 1 }, email_type: "public" }));
	const post = fake.calls.find((c) => c.method === "POST");
	assert.equal(post.body.status, "draft");
	assert.deepEqual(Object.keys(post.body).sort(), ["body", "metadata", "status", "subject"]);
	assert.equal([...fake.emails.values()][0].status, "draft");
	assert.deepEqual(fake.violations, []);
});

test("updateDraft never carries status, publish_date, filters, email_type or archival_mode", async () => {
	const { fake, bd } = make();
	const draft = await bd.createDraft(fields());
	await bd.updateDraft(draft.id, { ...fields({ subject: "New" }), status: "scheduled", publish_date: "x", filters: {}, email_type: "premium", archival_mode: "disabled" });
	const patch = fake.calls.find((c) => c.method === "PATCH");
	for (const f of client.NEVER_PATCHED) assert.ok(!(f in patch.body), f);
	assert.equal(patch.body.subject, "New");
	assert.deepEqual(fake.violations, []);
});

test("the guard refuses send-draft, publish, other methods and paths, a DELETE outside deleteDraft, the Live-Dangerously header, a non-draft status, forbidden PATCH fields, unknown fields and other hosts", () => {
	const refused = (fn) => assert.throws(fn, ButtondownRefused);
	refused(() => guardForTests("POST", "/emails/em_0000000000000000000000000a/send-draft"));
	refused(() => guardForTests("POST", "/emails/em_0000000000000000000000000a/publish"));
	refused(() => guardForTests("GET", "/emails/em_0000000000000000000000000a/send-draft"));
	refused(() => guardForTests("DELETE", "/emails/em_0000000000000000000000000a"), "no DELETE without deleteDraft's grant");
	refused(() => guardForTests("PUT", "/emails"));
	refused(() => guardForTests("POST", "/subscribers", {}, { status: "draft" }));
	refused(() => guardForTests("GET", "/automations"));
	refused(() => guardForTests("GET", "/ping", { "X-Buttondown-Live-Dangerously": "true" }));
	refused(() => guardForTests("GET", "/ping", { "x-buttondown-live-dangerously": "1" }));
	refused(() => guardForTests("POST", "/emails", {}, { subject: "x", status: "about_to_send" }));
	refused(() => guardForTests("POST", "/emails", {}, { subject: "x" }), "a create without status draft");
	refused(() => guardForTests("POST", "/emails", {}, { subject: "x", status: "scheduled" }));
	for (const f of ["status", "publish_date", "filters", "email_type", "archival_mode"]) refused(() => guardForTests("PATCH", "/emails/em_0000000000000000000000000a", {}, { [f]: f === "status" ? "draft" : "x" }));
	refused(() => guardForTests("PATCH", "/emails/em_0000000000000000000000000a", {}, { template: "x" }), "an unknown field");
	refused(() => guardForTests("GET", "//evil.example/v1/ping"));
	refused(() => guardForTests("GET", "@evil.example/ping"));
	refused(() => guardForTests("GET", "/../../evil"));
	// Allowed: what the client really sends.
	assert.equal(guardForTests("POST", "/emails", {}, { subject: "x", status: "draft" }).href, "https://api.buttondown.com/v1/emails");
	assert.equal(guardForTests("GET", "/emails?status=draft&source=api&excluded_fields=body&ordering=-creation_date&page=1").hostname, "api.buttondown.com");
});

test("an email id that isn't Buttondown's never goes in a path", async () => {
	const { fake, bd } = make();
	await assert.rejects(bd.getEmail("../ping"), ButtondownRefused);
	await assert.rejects(bd.updateDraft("em_x/publish", { subject: "x" }), ButtondownRefused);
	await assert.rejects(bd.deleteDraft("em_X?", null, "k"), ButtondownRefused);
	assert.equal(fake.calls.length, 0);
	assert.ok(EMAIL_ID.test("em_734hrschwa8fgbnpb4s9f05bxm"), "a real id from the probe");
	assert.ok(EMAIL_ID.test("2a4ee30a-e6d2-4d27-b4e2-1df1e3b8f9a0"));
	assert.ok(!EMAIL_ID.test("em_734hrschwa8fgbnpb4s9f05bxmu"));
});

test("deleteDraft deletes only after its own read shows an untouched draft the Pack made", async () => {
	const key = "example.com:posts:1";
	const setup = async () => {
		const { fake, bd } = make();
		const draft = await bd.createDraft(fields());
		return { fake, bd, draft, modified: draft.modificationDate };
	};
	// Untouched: one GET, then the DELETE.
	{
		const { fake, bd, draft, modified } = await setup();
		assert.deepEqual(await bd.deleteDraft(draft.id, modified, key), { outcome: "deleted" });
		assert.equal(fake.emails.size, 0);
		assert.deepEqual(fake.calls.slice(-2).map((c) => c.method), ["GET", "DELETE"]);
		assert.deepEqual(fake.violations, []);
	}
	// Edited in Buttondown, scheduled, sent, someone else's key, no recorded date, already gone: no DELETE.
	const cases = [
		["edited", (fake, id) => fake.edit(id, { subject: "Mine now" }), "edited"],
		["scheduled", (fake, id) => fake.setStatus(id, "scheduled"), "left"],
		["sent", (fake, id) => fake.setStatus(id, "sent"), "left"],
		["about to send", (fake, id) => fake.setStatus(id, "about_to_send"), "left"],
		["another key", (fake, id) => (fake.emails.get(id).metadata = { coywolf_pack: { key: "example.com:posts:2" } }), "edited"],
		["gone", (fake, id) => fake.emails.delete(id), "gone"],
	];
	for (const [name, change, outcome] of cases) {
		const { fake, bd, draft, modified } = await setup();
		change(fake, draft.id);
		const result = await bd.deleteDraft(draft.id, modified, key);
		assert.equal(result.outcome, outcome, name);
		assert.equal(fake.count("DELETE"), 0, `${name}: no DELETE`);
	}
	{
		const { fake, bd, draft } = await setup();
		assert.equal((await bd.deleteDraft(draft.id, null, key)).outcome, "edited", "no recorded modification date: never deleted");
		assert.equal(fake.count("DELETE"), 0);
	}
});

test("errors carry Buttondown's code and detail, cut to 300 characters, never the key", async () => {
	const fake = fakeButtondown();
	const { bd } = make(fake);
	fake.fail({ method: "POST" }, { status: 400, code: "subject_invalid", detail: `Bad subject for ${FAKE_KEY} ${"x".repeat(500)}` });
	const error = await bd.createDraft(fields()).catch((e) => e);
	assert.ok(error instanceof ButtondownError);
	assert.equal(error.status, 400);
	assert.equal(error.code, "subject_invalid");
	assert.ok(error.detail.length <= 300);
	assert.ok(!error.message.includes(FAKE_KEY) && !error.detail.includes(FAKE_KEY));
	// A refused key: the fake echoes what it got, and the error still doesn't carry it.
	const wrong = createButtondownClient({ key: "wrong-key-0123456789abcdefghij", fetch: fake.fetch });
	const refused = await wrong.getEmail("em_0000000000000000000000000a").catch((e) => e);
	assert.equal(refused.status, 401);
	assert.ok(!refused.message.includes("wrong-key-0123456789abcdefghij"));
	// A network error whose message holds the key and its header.
	fake.fail({ method: "GET" }, { network: true, message: `connect failed: Authorization: Token ${FAKE_KEY}` });
	const network = await bd.getEmail("em_0000000000000000000000000a").catch((e) => e);
	assert.equal(network.status, 0);
	assert.equal(network.code, "network");
	assert.ok(!network.message.includes(FAKE_KEY));
	assert.equal(safeDetail(`a\u0000b Token ${FAKE_KEY}`, null), "a b Token …");
});

test("a call past its deadline is aborted and reported as a timeout; no call starts without time left", async () => {
	const fake = fakeButtondown();
	fake.fail({ method: "GET" }, { hang: true });
	const now = Date.now();
	const bd = createButtondownClient({ key: FAKE_KEY, fetch: fake.fetch, deadlineAt: now + 600, now: () => now });
	const error = await bd.getEmail("em_0000000000000000000000000a").catch((e) => e);
	assert.equal(error.code, "timeout");
	const late = createButtondownClient({ key: FAKE_KEY, fetch: fake.fetch, deadlineAt: now + 100, now: () => now });
	const calls = fake.calls.length;
	assert.equal((await late.getEmail("em_0000000000000000000000000a").catch((e) => e)).code, "timeout");
	assert.equal(fake.calls.length, calls, "not sent");
});

test("429 carries Retry-After in seconds (a number or an HTTP date)", async () => {
	const fake = fakeButtondown();
	fake.fail({ method: "GET" }, { status: 429, headers: { "retry-after": "7" } });
	const error = await make(fake).bd.getEmail("em_0000000000000000000000000a").catch((e) => e);
	assert.equal(error.status, 429);
	assert.equal(error.retryAfter, 7);
	assert.equal(retryAfterSeconds(new Date(Date.UTC(2026, 0, 1, 0, 0, 30)).toUTCString(), Date.UTC(2026, 0, 1)), 30);
	assert.equal(retryAfterSeconds("soon"), null);
	assert.equal(retryAfterSeconds(null), null);
});

test("the email list: emails made through the API in any status (a draft may have been scheduled or sent since), newest first, without bodies, page by page", async () => {
	const fake = fakeButtondown({ pageSize: 2 });
	const { bd } = make(fake);
	for (let i = 0; i < 3; i++) await bd.createDraft(fields({ subject: `S${i}` }));
	const first = await bd.listApiEmails(1);
	assert.equal(first.results.length, 2);
	assert.equal(first.hasMore, true);
	assert.deepEqual(first.results.map((e) => e.subject), ["S2", "S1"]);
	assert.equal((await bd.listApiEmails(2)).hasMore, false);
	const call = fake.calls.find((c) => c.method === "GET" && c.path === "/v1/emails");
	assert.equal(call.search, "?source=api&excluded_fields=body&ordering=-creation_date&page=1");
	fake.setStatus(first.results[0].id, "scheduled");
	assert.deepEqual((await bd.listApiEmails(1)).results.map((e) => e.status), ["scheduled", "draft"], "not only drafts");
	assert.ok(!("body" in first.results[0]), "the Pack's email objects never hold a body");
	assert.equal(packKeyOf(first.results[0]), "example.com:posts:1");
});

test("the key check reads status codes only: the bodies are cancelled unread", async () => {
	const cancelled = [];
	const fetchStatus = async (url) => {
		const status = /\/(ping|emails)/.test(url) ? 200 : 403;
		return { status, headers: new Headers(), body: { cancel: async () => void cancelled.push(url) }, text: () => assert.fail("a body was read"), json: () => assert.fail("a body was read") };
	};
	const bd = createButtondownClient({ key: FAKE_KEY, fetch: fetchStatus });
	assert.deepEqual(await bd.checkKey(), { ping: 200, emails: 200, newsletters: 403, subscribers: 403 });
	assert.equal(cancelled.length, 4);
	// A key with more access shows it, and a failed call is 0.
	const fake = fakeButtondown({ newsletters: 200, subscribers: 200 });
	assert.deepEqual(await make(fake).bd.checkKey(), { ping: 200, emails: 200, newsletters: 200, subscribers: 200 });
	fake.fail({ path: "/v1/ping" }, { network: true });
	assert.equal((await make(fake).bd.checkKey()).ping, 0);
});

test("scrubToken masks a Token credential, not the word in prose", () => {
	assert.equal(scrubToken(`Authorization: Token ${FAKE_KEY}`), "Authorization: Token …");
	assert.equal(scrubToken("Token expired"), "Token expired");
	assert.equal(scrubToken("Bearer abc.def"), "Bearer …");
});

test("no key: the client won't be made", () => {
	assert.throws(() => createButtondownClient({ key: " ", fetch: async () => new Response() }), ButtondownRefused);
});

test("a create or a delete that went out unanswered is marked (it may have landed); a clear no, a read, or a call that was never sent isn't", async () => {
	const caught = async (run) => run().then(() => null, (error) => error);
	// No answer, a 5xx: the write may have landed.
	for (const failure of [{ lose: true }, { network: true }, { status: 502 }]) {
		const { fake, bd } = make();
		fake.fail({ method: "POST" }, failure);
		assert.equal((await caught(() => bd.createDraft(fields()))).unanswered, "create");
		const draft = await bd.createDraft(fields());
		fake.fail({ method: "DELETE" }, failure);
		assert.equal((await caught(() => bd.deleteDraft(draft.id, draft.modificationDate, "example.com:posts:1"))).unanswered, "delete");
	}
	// Buttondown said no: nothing landed.
	for (const status of [400, 401, 403, 422, 429]) {
		const { fake, bd } = make();
		fake.fail({ method: "POST" }, { status });
		assert.equal((await caught(() => bd.createDraft(fields()))).unanswered, null, String(status));
		const draft = await bd.createDraft(fields());
		fake.fail({ method: "DELETE" }, { status });
		assert.equal((await caught(() => bd.deleteDraft(draft.id, draft.modificationDate, "example.com:posts:1"))).unanswered, null, String(status));
	}
	// The read before a delete, an update and the list are never marked.
	const { fake, bd } = make();
	const draft = await bd.createDraft(fields());
	fake.fail({ method: "GET" }, { network: true });
	assert.equal((await caught(() => bd.deleteDraft(draft.id, draft.modificationDate, "example.com:posts:1"))).unanswered, null);
	fake.fail({ method: "PATCH" }, { network: true });
	assert.equal((await caught(() => bd.updateDraft(draft.id, { subject: "x" }))).unanswered, null);
	// Out of time before anything was sent: not marked, and no call made.
	let clock = 1_000_000;
	const late = make(fakeButtondown(), { deadlineAt: clock + 60_000, now: () => clock });
	const made = await late.bd.createDraft(fields());
	clock += 59_900;
	const calls = late.fake.calls.length;
	const error = await caught(() => late.bd.createDraft(fields()));
	assert.equal(error.code, "timeout");
	assert.equal(error.unanswered, null);
	assert.equal(late.fake.calls.length, calls);
	// The same for a delete whose own read used up the time.
	clock = 1_000_000;
	late.fake.fail({ method: "GET" }, { during: async () => void (clock += 59_900) });
	const lateDelete = await caught(() => late.bd.deleteDraft(made.id, made.modificationDate, "example.com:posts:1"));
	assert.equal(lateDelete.code, "timeout");
	assert.equal(lateDelete.unanswered, null);
	assert.equal(late.fake.count("DELETE"), 0);
});

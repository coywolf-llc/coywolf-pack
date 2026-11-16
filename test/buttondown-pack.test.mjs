// Run: node --test test/buttondown-pack.test.mjs
//
// Buttondown Drafts' wiring (src/buttondown/pack.ts): off by default, one host, the hooks and the hourly task
// gated by the switch, admin-only read-only routes, the key never returned, the settings' since stamp, the
// module's place in the sidebar and the Features page, and Alerts' buttondownFailed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import "./ts-resolve.mjs";
import { FAKE_KEY, fakeButtondown } from "./fixtures/buttondown-fake.mjs";
import { fakeCollection, fakeKv, fakeSettings, quietLog } from "./fixtures/fake-plugin.mjs";

const { buttondownPack, BUTTONDOWN_FEATURE_DEFS } = await import("../src/buttondown/pack.ts");
const { composeHooks, TASK_NAME } = await import("../src/core/compose.ts");
const { isReadOnlyRoute } = await import("../src/core/routes.ts");
const { invalidateFeatures, featureCatalog } = await import("../src/core/features.ts");
const { normalizeSettings, stampRules } = await import("../src/buttondown/settings.ts");
const { BUTTONDOWN_STORAGE } = await import("../src/buttondown/keys.ts");
const core = await import("../src/buttondown/sync-core.ts");
const { recordView, failingRecords } = await import("../src/buttondown/store.ts");

afterEach(() => invalidateFeatures());

function context({ on = true, key = FAKE_KEY, fake = fakeButtondown(), input, settings = {} } = {}) {
	invalidateFeatures();
	return {
		fake,
		storage: { [BUTTONDOWN_STORAGE]: fakeCollection() },
		kv: fakeKv(),
		log: quietLog(),
		site: { url: "https://coywolf.com", name: "Coywolf" },
		settings: fakeSettings({ features: { _defaults036: true, buttondown: on }, ...(key ? { buttondownApiKey: key } : {}), ...settings }),
		http: fake.http,
		content: { get: async () => null },
		schema: { listCollections: async () => [{ slug: "posts", label: "Posts", routable: true }], getCollection: async () => null },
		input,
	};
}

test("off by default, both switches; the module is in MODULES and on the Features page", () => {
	assert.deepEqual(BUTTONDOWN_FEATURE_DEFS.map((f) => [f.id, f.default]), [["buttondown", false], ["buttondown.updates", false]]);
	assert.ok(featureCatalog().some((f) => f.id === "buttondown"));
	// In the module list (read from the source: the whole list can't be loaded under Node's type stripping), after Alerts.
	const modules = readFileSync(new URL("../src/modules.ts", import.meta.url), "utf8");
	assert.match(modules, /\(o\) => \(o\.buttondown === false \? null : buttondownPack\(o\.buttondown \?\? \{\}\)\),/);
	assert.ok(modules.indexOf("buttondownPack(o.buttondown") > modules.indexOf("alertsPack()"));
	assert.match(BUTTONDOWN_FEATURE_DEFS[0].description, /Never sends/);
});

test("one host, the capabilities it needs, its storage indexes, its page and its hourly task (scheduled only while on)", () => {
	const m = buttondownPack();
	assert.deepEqual(m.allowedHosts, ["api.buttondown.com"]);
	assert.deepEqual(m.capabilities, ["content:read", "schema:read", "network:request"]);
	assert.deepEqual(m.storage, { buttondownEmails: { indexes: ["state", "nextRetryAt", "updatedAt"] } });
	assert.deepEqual(m.adminPages, [{ path: "/buttondown", label: "Buttondown Drafts", icon: "envelope-simple" }]);
	assert.equal(m.tasks.length, 1);
	assert.equal(m.tasks[0].name, "buttondown-retry");
	assert.match(m.tasks[0].name, TASK_NAME);
	assert.equal(m.tasks[0].schedule, "@hourly");
	assert.equal(m.tasks[0].onlyWhileOn, true);
	assert.deepEqual(Object.keys(m.hooks).sort(), ["content:afterDelete", "content:afterPublish", "content:afterRestore", "content:afterSave", "content:afterUnpublish"]);
	// The client's base URL is the same host, as a constant.
	const client = readFileSync(new URL("../src/buttondown/client.ts", import.meta.url), "utf8");
	assert.doesNotMatch(client.replace(/^\s*(\*|\/\/).*$/gm, ""), /https:\/\/(?!api\.buttondown\.com)[a-z]/i, "no other URL in the client's code");
});

test("routes: admins only (plugins:manage), all read-only for the page cache, and 404 while the module is off", async () => {
	const { routes } = buttondownPack();
	assert.deepEqual(Object.keys(routes).sort(), ["buttondown/entry", "buttondown/key/check", "buttondown/retry", "buttondown/settings/save", "buttondown/status", "buttondown/sync"]);
	for (const [name, route] of Object.entries(routes)) {
		assert.equal(route.permission, "plugins:manage", name);
		assert.ok(isReadOnlyRoute(route), name);
		await assert.rejects(route.handler(context({ on: false, input: { collection: "posts", id: "1", action: "create" } })), /turned off/, name);
	}
});

test("the hooks and the task do nothing while the module is off", async () => {
	const m = buttondownPack();
	const { hooks } = composeHooks([m], { tasks: [] });
	const ctx = context({ on: false });
	let reads = 0;
	const store = ctx.storage[BUTTONDOWN_STORAGE];
	const get = store.get.bind(store);
	store.get = async (id) => (reads++, get(id));
	await hooks["content:afterPublish"]({ collection: "posts", content: { id: "1", status: "published" } }, ctx);
	await hooks["content:afterUnpublish"]({ collection: "posts", content: { id: "1", status: "draft" } }, ctx);
	await hooks["content:afterDelete"]({ collection: "posts", id: "1", permanent: false }, ctx);
	assert.equal(reads, 0);
	assert.equal(ctx.fake.calls.length, 0);
	// The task: cancels itself while off.
	const cancelled = [];
	ctx.cron = { cancel: async (name) => void cancelled.push(name), schedule: async () => {} };
	await composeHooks([m], { tasks: [] }).hooks.cron.handler({ name: "buttondown-retry" }, ctx);
	assert.deepEqual(cancelled, ["buttondown-retry"]);
});

test("the status route: settings, whether a key is saved and the recent records, never the key", async () => {
	const { routes } = buttondownPack();
	const ctx = context({ settings: { buttondownSettings: { rules: [{ collection: "posts", taxonomy: "category", terms: ["newsletter"], since: "2026-11-10T00:00:00.000Z" }], footerLink: true } } });
	await ctx.storage[BUTTONDOWN_STORAGE].put("posts:1", { ...core.newRecord("posts", "1", Date.parse("2026-11-15T12:00:00Z")), state: "draft", job: null, emailId: "em_0000000000000000000000000a", title: "Hi", hash: "secret-hash", claimToken: "tok", authFingerprint: "fp" });
	const status = await routes["buttondown/status"].handler(ctx);
	assert.equal(status.keySaved, true);
	assert.equal(status.keyUnreadable, false);
	assert.equal(status.siteHost, "coywolf.com");
	assert.equal(status.settings.rules[0].terms[0], "newsletter");
	assert.equal(status.recent.length, 1);
	assert.equal(status.recent[0].appUrl, "https://buttondown.com/emails/em_0000000000000000000000000a");
	const text = JSON.stringify(status);
	assert.ok(!text.includes(FAKE_KEY), "never the key");
	assert.ok(!text.includes("secret-hash") && !text.includes('"tok"') && !text.includes('"fp"'), "nor the record's internals");
	// An unreadable key says so (and isn't "saved").
	const broken = context();
	broken.settings.get = async (k) => (k === "buttondownApiKey" ? Promise.reject(new Error("decrypt")) : null);
	const s2 = await routes["buttondown/status"].handler({ ...broken, settings: { get: async (k) => (k === "buttondownApiKey" ? Promise.reject(new Error("decrypt")) : k === "features" ? { _defaults036: true, buttondown: true } : null) } });
	assert.equal(s2.keySaved, false);
	assert.equal(s2.keyUnreadable, true);
});

test("Check key: status codes only, a warning when the key reaches newsletters or subscribers, and the key never in the answer", async () => {
	const { routes } = buttondownPack();
	const ok = await routes["buttondown/key/check"].handler(context());
	assert.deepEqual(ok.check, { ping: 200, emails: 200, newsletters: 403, subscribers: 403 });
	assert.equal(ok.tooBroad, false);
	const broad = await routes["buttondown/key/check"].handler(context({ fake: fakeButtondown({ newsletters: 200 }) }));
	assert.equal(broad.tooBroad, true);
	assert.ok(!JSON.stringify(broad).includes("secret"), "the newsletters' answer (with their keys) is never read");
	const none = await routes["buttondown/key/check"].handler(context({ key: null }));
	assert.deepEqual(none, { keySaved: false, keyUnreadable: false, check: null });
	const wrong = context({ key: "a-wrong-key-0123456789abcdef" });
	const refused = await routes["buttondown/key/check"].handler(wrong);
	assert.equal(refused.check.ping, 401);
	assert.ok(!JSON.stringify(refused).includes("a-wrong-key-0123456789abcdef"));
	assert.deepEqual(wrong.fake.violations, []);
});

test("saving the settings stamps a new or changed rule with the time it was saved; an unchanged rule keeps its since", async () => {
	const before = [{ collection: "posts", taxonomy: "category", terms: ["newsletter"], since: "2026-11-01T00:00:00.000Z" }];
	const now = new Date("2026-11-15T12:00:00Z");
	assert.equal(stampRules([{ collection: "posts", taxonomy: "category", terms: ["newsletter"] }], before, now)[0].since, "2026-11-01T00:00:00.000Z");
	assert.equal(stampRules([{ collection: "posts", taxonomy: "category", terms: ["newsletter", "podcast"] }], before, now)[0].since, now.toISOString());
	assert.equal(stampRules([{ collection: "pages", taxonomy: "category", terms: ["x"] }], before, now)[0].since, now.toISOString());
	assert.throws(() => stampRules([{ collection: "posts", taxonomy: "category", terms: ["a"] }, { collection: "posts", taxonomy: "tag", terms: ["b"] }], [], now), /one rule per collection/);
	const { routes } = buttondownPack();
	const ctx = context({ settings: { buttondownSettings: { rules: before, footerLink: true } }, input: { rules: [{ collection: "posts", taxonomy: "category", terms: ["newsletter"] }], footerLink: false } });
	const { settings } = await routes["buttondown/settings/save"].handler(ctx);
	assert.deepEqual(settings, { rules: before, footerLink: false });
	assert.deepEqual(await ctx.settings.get("buttondownSettings"), settings);
	await assert.rejects(routes["buttondown/settings/save"].handler({ ...ctx, input: { rules: [{ collection: "posts", taxonomy: "category", terms: [] }], footerLink: true } }), /at least one term/);
	await assert.rejects(routes["buttondown/settings/save"].handler({ ...ctx, input: { rules: [{ collection: "Bad Slug", taxonomy: "category", terms: ["x"] }], footerLink: true } }), /collection/);
	// Stored values are cleaned on the way in.
	assert.deepEqual(normalizeSettings({ rules: [{ collection: "posts", taxonomy: "category", terms: ["a", "a", "bad term"], since: "2026-11-01" }, { collection: "posts", taxonomy: "tag", terms: ["b"], since: "2026-11-01" }, { collection: "x" }] }), { rules: [{ collection: "posts", taxonomy: "category", terms: ["a"], since: "2026-11-01T00:00:00.000Z" }], footerLink: true });
});

test("the entry route: not covered without a rule; Create draft now refused for a post that isn't published", async () => {
	const { routes } = buttondownPack();
	assert.deepEqual(await routes["buttondown/entry"].handler(context({ input: { collection: "posts", id: "1" } })), { covered: false });
	const ctx = context({ input: { collection: "posts", id: "1", action: "create" }, settings: { buttondownSettings: { rules: [{ collection: "posts", taxonomy: "category", terms: ["n"], since: "2026-11-01T00:00:00.000Z" }] } } });
	const entry = await routes["buttondown/entry"].handler(ctx);
	assert.equal(entry.covered, true);
	assert.equal(entry.published, false);
	assert.equal(entry.canCreate, false);
	await assert.rejects(routes["buttondown/sync"].handler(ctx), /Publish the post first/);
	await assert.rejects(routes["buttondown/retry"].handler(ctx), /nothing to retry/);
	assert.equal(ctx.fake.calls.length, 0);
});

test("the admin's actions use a rule as soon as it's saved, while this isolate's cached rules are still the old ones", async () => {
	// The hooks' read (settings) is still the per-isolate copy from before the rule was saved: no rules.
	let cached = 0;
	const pack = buttondownPack({}, { now: () => Date.parse("2026-11-16T06:21:00Z"), settings: async () => (cached++, normalizeSettings({ rules: [] })), terms: async () => ["newsletter"], termParents: async () => new Map(), postUrl: async () => "https://coywolf.com/newsletter/one/", files: async () => new Map(), background: () => {} });
	const { routes } = pack;
	// Saved a moment ago, in another isolate: the site's settings have it.
	const rule = { collection: "posts", taxonomy: "category", terms: ["newsletter"], since: "2026-11-16T06:19:42.594Z" };
	const base = context({ settings: { buttondownSettings: { rules: [rule], footerLink: true } } });
	// Published before the rule: only Create draft now makes its draft.
	const item = { id: "1", slug: "one", status: "published", publishedAt: "2026-03-21T19:58:24.000Z", data: { title: "One", content: [{ _type: "block", _key: "b", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s", text: "First.", marks: [] }] }] } };
	base.content = { get: async () => structuredClone(item) };
	base.schema = { ...base.schema, getCollection: async (slug) => ({ slug, label: "Posts", titleField: "title", fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "content", type: "portableText", sortOrder: 1 }] }) };
	const call = (route, input) => routes[`buttondown/${route}`].handler({ ...base, input: { collection: "posts", id: "1", ...input } });

	const panel = await call("entry", {});
	assert.equal(panel.canCreate, true, "the panel offers it");
	// Create draft now runs (instead of "No rule covers this collection"). Buttondown refuses this first create.
	base.fake.fail({ method: "POST" }, { status: 400, body: { code: "invalid", detail: "Refused once." } });
	const refused = await call("sync", { action: "create" });
	assert.equal(refused.record.state, "error");
	assert.equal(base.fake.drafts().length, 0);
	// Retry reads the rules the same way, and makes the draft.
	const made = await call("retry", {});
	assert.equal(made.record.state, "draft");
	assert.equal(base.fake.drafts().length, 1);
	assert.equal(cached, 0, "the actions and their jobs never read the cached rules");
	// With no rule saved at all, the action is refused with the plain message.
	const none = context({ settings: { buttondownSettings: { rules: [], footerLink: true } } });
	none.content = base.content;
	await assert.rejects(routes["buttondown/sync"].handler({ ...none, input: { collection: "posts", id: "1", action: "create" } }), /No rule covers this collection/);
});

test("Refresh draft from post through the routes: the date the admin saw goes back with it, it writes only while that's current, and a failure is never tried again as an overwrite", async () => {
	let clock = Date.parse("2026-11-15T12:00:00Z");
	const pack = buttondownPack({}, { now: () => clock, terms: async () => ["n"], termParents: async () => new Map(), postUrl: async () => "https://coywolf.com/newsletter/one/", files: async () => new Map(), background: () => {} });
	const { routes } = pack;
	const rules = { buttondownSettings: { rules: [{ collection: "posts", taxonomy: "category", terms: ["n"], since: "2026-11-01T00:00:00.000Z" }] } };
	const base = context({ settings: { ...rules, features: { _defaults036: true, buttondown: true, "buttondown.updates": true } } });
	const item = { id: "1", slug: "one", status: "published", publishedAt: "2026-11-15T10:00:00.000Z", data: { title: "One", content: [{ _type: "block", _key: "b", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s", text: "First.", marks: [] }] }] } };
	base.content = { get: async () => structuredClone(item) };
	base.schema = { ...base.schema, getCollection: async (slug) => ({ slug, label: "Posts", titleField: "title", fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "content", type: "portableText", sortOrder: 1 }] }) };
	const call = (route, input) => routes[`buttondown/${route}`].handler({ ...base, input: { collection: "posts", id: "1", ...input } });
	const fake = base.fake;

	assert.equal((await call("sync", { action: "create" })).record.state, "draft");
	const id = fake.drafts()[0].id;
	// Edited in Buttondown. The panel reads the email's status and date (nothing else of it) before it asks.
	fake.edit(id, { body: "Mine" });
	const read = await call("entry", { remote: true });
	assert.deepEqual(read.remote, { status: "draft", modifiedAt: fake.emails.get(id).modification_date });
	assert.equal(read.canRefresh, true);
	assert.ok(!JSON.stringify(read).includes("Mine") && !JSON.stringify(read).includes(FAKE_KEY));
	assert.ok(!("remote" in (await call("entry", {}))), "only when asked");
	// No date: refused. A date that's no longer current: nothing written, and the answer says so.
	await assert.rejects(call("sync", { action: "refresh" }), /Select Refresh draft from post again/);
	fake.edit(id, { body: "Mine, changed again" });
	const stale = await call("sync", { action: "refresh", seen: read.remote.modifiedAt });
	assert.match(stale.notice, /changed in Buttondown after you confirmed, so nothing was written/);
	assert.equal(fake.count("PATCH"), 0);
	assert.equal(fake.emails.get(id).body, "Mine, changed again");
	// The write fails: the answer says it isn't tried again as an overwrite, and it isn't.
	const seen = (await call("entry", { remote: true })).remote.modifiedAt;
	fake.fail({ method: "PATCH" }, { status: 503 });
	fake.allowOverwrite(id);
	const failed = await call("sync", { action: "refresh", seen });
	assert.equal(failed.record.state, "error");
	assert.match(failed.notice, /Nothing overwrites the draft on its own/);
	assert.equal(fake.emails.get(id).body, "Mine, changed again", "the failed write changed nothing");
	fake.edit(id, { body: "Fixed by hand after the failure" });
	clock += 6 * 60_000;
	await pack.tasks[0].handler(base);
	assert.equal(fake.emails.get(id).body, "Fixed by hand after the failure");
	const after = core.readRecord(await base.storage[BUTTONDOWN_STORAGE].get("posts:1"));
	assert.equal(after.state, "edited");
	// Asked again, with what Buttondown shows now: written, still a draft.
	const again = (await call("entry", { remote: true })).remote.modifiedAt;
	fake.allowOverwrite(id);
	const done = await call("sync", { action: "refresh", seen: again });
	assert.equal(done.record.state, "draft");
	assert.equal(done.notice, undefined);
	assert.match(fake.emails.get(id).body, /First\./);
	assert.equal(fake.emails.get(id).status, "draft");
	// A scheduled email: its status comes back, so the panel doesn't ask at all; and the route refuses anyway.
	fake.setStatus(id, "scheduled");
	assert.equal((await call("entry", { remote: true })).remote.status, "scheduled");
	fake.emails.delete(id);
	assert.deepEqual((await call("entry", { remote: true })).remote, { status: "deleted", modifiedAt: null });
	assert.deepEqual(fake.violations, []);
});

// Found live (2026-11-15): a draft edited in Buttondown, then deleted there, left the post with no way to a new draft.
test("the entry route: a remote read that finds the email gone settles the record as gone, so Create draft now is offered; nothing is made until it's asked", async () => {
	let clock = Date.parse("2026-11-15T12:00:00Z");
	const pack = buttondownPack({}, { now: () => clock, terms: async () => ["n"], termParents: async () => new Map(), postUrl: async () => "https://coywolf.com/newsletter/one/", files: async () => new Map(), background: () => {} });
	const { routes, hooks } = pack;
	const rules = { buttondownSettings: { rules: [{ collection: "posts", taxonomy: "category", terms: ["n"], since: "2026-11-01T00:00:00.000Z" }] } };
	const base = context({ settings: { ...rules, features: { _defaults036: true, buttondown: true, "buttondown.updates": true } } });
	const item = { id: "1", slug: "one", status: "published", publishedAt: "2026-11-15T10:00:00.000Z", draftRevisionId: null, data: { title: "One", content: [{ _type: "block", _key: "b", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s", text: "First.", marks: [] }] }] } };
	base.content = { get: async () => structuredClone(item) };
	base.schema = { ...base.schema, getCollection: async (slug) => ({ slug, label: "Posts", titleField: "title", fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "content", type: "portableText", sortOrder: 1 }] }) };
	const call = (route, input) => routes[`buttondown/${route}`].handler({ ...base, input: { collection: "posts", id: "1", ...input } });
	const stored = async () => core.readRecord(await base.storage[BUTTONDOWN_STORAGE].get("posts:1"));
	const fake = base.fake;
	const { settleJobsForTests } = await import("../src/buttondown/sync.ts");

	assert.equal((await call("sync", { action: "create" })).record.state, "draft");
	const first = fake.drafts()[0].id;
	// Edited in Buttondown, and the Pack has seen that (a republish).
	fake.edit(first, { body: "Mine" });
	item.data.title = "One, changed";
	await hooks["content:afterPublish"]({ collection: "posts", content: structuredClone(item) }, base);
	await settleJobsForTests();
	assert.equal((await stored()).state, "edited");
	// Then deleted in Buttondown. The plain read (the panel's first) makes no call and still says edited.
	fake.emails.delete(first);
	const before = fake.calls.length;
	const plain = await call("entry", {});
	assert.equal(fake.calls.length, before, "no call to Buttondown without `remote`");
	assert.deepEqual([plain.record.state, plain.canCreate, plain.canRefresh], ["edited", false, true]);
	// A republish makes no read of an edited draft, so it can't find out.
	await hooks["content:afterPublish"]({ collection: "posts", content: structuredClone(item) }, base);
	await settleJobsForTests();
	assert.equal(fake.calls.length, before);
	// The read before Refresh finds it gone: the record is settled, and the same answer offers Create draft now.
	clock += 60_000;
	const read = await call("entry", { remote: true });
	assert.deepEqual(read.remote, { status: "deleted", modifiedAt: null });
	assert.deepEqual([read.record.state, read.canCreate, read.canRefresh, read.canRetry], ["gone", true, false, false]);
	assert.equal(read.record.appUrl, null, "no link to an email that's gone");
	assert.match(read.record.text, /Deleted in Buttondown/);
	const gone = await stored();
	assert.deepEqual([gone.state, gone.job, gone.nextRetryAt, gone.claimToken, gone.remoteStatus], ["gone", null, null, null, null]);
	assert.equal(gone.updatedAt, new Date(clock).toISOString());
	assert.deepEqual(fake.calls.slice(before).map((c) => `${c.method} ${c.path}`), [`GET /v1/emails/${first}`], "one read, and nothing written to Buttondown");
	// Still never made again on its own: a republish and the hourly task make nothing.
	await hooks["content:afterPublish"]({ collection: "posts", content: structuredClone(item) }, base);
	await settleJobsForTests();
	clock += 2 * 3_600_000;
	await pack.tasks[0].handler(base);
	assert.equal(fake.count("POST /v1/emails"), 1, "not recreated");
	assert.equal((await stored()).state, "gone");
	// Create draft now makes the new one, as a draft.
	const made = await call("sync", { action: "create" });
	assert.equal(made.record.state, "draft");
	assert.notEqual(made.record.emailId, first);
	assert.deepEqual(fake.drafts().map((e) => e.status), ["draft"]);
	assert.match(fake.drafts()[0].subject, /One, changed/);
	assert.deepEqual(fake.violations, []);
});

test("the entry route's remote read settles only a record at rest: a draft or a sent email found gone; an email marked deleted counts as gone; a waiting job is left to itself", async () => {
	const pack = buttondownPack({}, { terms: async () => ["n"], termParents: async () => new Map(), background: () => {} });
	const rules = { buttondownSettings: { rules: [{ collection: "posts", taxonomy: "category", terms: ["n"], since: "2026-11-01T00:00:00.000Z" }] } };
	const EMAIL = "em_0000000000000000000000000a";
	const read = async (record, { marked = false } = {}) => {
		const base = context({ settings: rules });
		base.content = { get: async () => ({ id: "1", slug: "one", status: "published", data: {} }) };
		await base.storage[BUTTONDOWN_STORAGE].put("posts:1", { ...core.newRecord("posts", "1", 0), job: null, emailId: EMAIL, ...record });
		// Marked deleted: Buttondown still returns the email, with status "deleted".
		if (marked) base.fake.emails.set(EMAIL, { id: EMAIL, status: "deleted", source: "api", subject: "", body: "", metadata: {}, creation_date: "2026-11-15T12:00:00.000Z", modification_date: "2026-11-15T12:05:00.000Z" });
		const out = await pack.routes["buttondown/entry"].handler({ ...base, input: { collection: "posts", id: "1", remote: true } });
		assert.deepEqual(base.fake.calls.map((c) => c.method), ["GET"]);
		assert.deepEqual(base.fake.violations, []);
		return { out, stored: core.readRecord(await base.storage[BUTTONDOWN_STORAGE].get("posts:1")) };
	};
	for (const state of ["draft", "edited", "left"]) {
		const { out, stored } = await read({ state, remoteStatus: state === "left" ? "sent" : "draft" });
		assert.deepEqual([out.remote.status, out.record.state, out.canCreate, out.canRefresh, stored.state], ["deleted", "gone", true, false, "gone"], state);
	}
	const marked = await read({ state: "edited" }, { marked: true });
	assert.deepEqual([marked.out.remote, marked.out.record.state, marked.out.canCreate], [{ status: "deleted", modifiedAt: null }, "gone", true]);
	// Left to their own job, which reads the email itself (and can tell the Pack's own delete from one made in Buttondown).
	for (const [name, record] of [
		["an update waiting", { state: "draft", job: "sync" }],
		["a job under way", { state: "draft", claimToken: "t", claimedAt: new Date().toISOString() }],
		["a delete waiting", { state: "removing", job: "remove" }],
		["a failed delete of the Pack's own that may have landed", { state: "error", job: "remove", deleteSentAt: "2026-11-15T12:00:00.000Z" }],
		["not watched", { state: "stopped" }],
	]) {
		const { out, stored } = await read(record);
		assert.equal(out.remote.status, "deleted", name);
		assert.equal(stored.state, record.state, name);
		assert.equal(out.record.state, record.state, name);
	}
});

test("the entry route says when the post can't be read, instead of \"not published\"", async () => {
	const { routes } = buttondownPack();
	const ctx = context({ input: { collection: "posts", id: "1" }, settings: { buttondownSettings: { rules: [{ collection: "posts", taxonomy: "category", terms: ["n"], since: "2026-11-01T00:00:00.000Z" }] } } });
	ctx.content = { get: async () => { throw new Error("D1 down"); } };
	const entry = await routes["buttondown/entry"].handler(ctx);
	assert.equal(entry.unread, true);
	assert.equal(entry.canCreate, false);
	await assert.rejects(routes["buttondown/sync"].handler({ ...ctx, input: { collection: "posts", id: "1", action: "create" } }), /couldn't be read/);
});

test("a record as the admin sees it: plain-words state and a link to the draft in Buttondown, nothing internal", () => {
	const r = { ...core.newRecord("posts", "1", 0), state: "edited", job: null, emailId: "em_0000000000000000000000000a", unpublished: true, hash: "h", claimToken: "t", authFingerprint: "f", remoteModifiedAt: "m" };
	const view = recordView(r);
	assert.match(view.text, /Edited in Buttondown/);
	assert.match(view.text, /Kept because you edited it in Buttondown/);
	assert.equal(view.appUrl, "https://buttondown.com/emails/em_0000000000000000000000000a");
	for (const internal of ["hash", "claimToken", "claimedAt", "authFingerprint", "remoteModifiedAt", "dirty", "force"]) assert.ok(!(internal in view), internal);
	assert.equal(recordView({ ...r, state: "removed" }).appUrl, null, "a deleted draft has no link");
});

test("Alerts: buttondownFailed lists records in error for over an hour, when Buttondown Drafts is on", async () => {
	await import("../src/alerts/pack.ts");
	const alerts = await import("../src/alerts/run.ts");
	assert.ok(alerts.ALERT_TYPES.includes("buttondownFailed"));
	assert.equal(alerts.ALERT_INFO.buttondownFailed.feature, "buttondown");
	assert.equal(alerts.ALERTS_DEFAULTS.alerts.buttondownFailed, true);
	const NOW = Date.parse("2026-11-15T12:00:00Z");
	const storage = { [BUTTONDOWN_STORAGE]: fakeCollection() };
	const failing = (id, since) => ({ ...core.newRecord("posts", id, NOW), state: "error", job: "sync", title: `Post ${id}`, errorSince: new Date(since).toISOString(), lastError: { at: new Date(NOW).toISOString(), status: 401, code: null, message: "Buttondown refused the key (401)." } });
	await storage[BUTTONDOWN_STORAGE].put("posts:old", failing("old", NOW - 2 * 3600_000));
	await storage[BUTTONDOWN_STORAGE].put("posts:new", failing("new", NOW - 10 * 60_000));
	assert.deepEqual((await failingRecords({ storage }, NOW)).map((r) => r.entryId), ["old"]);
	const sent = [];
	const ctx = {
		kv: fakeKv(),
		settings: fakeSettings({ features: { _defaults036: true, alerts: true, buttondown: true } }),
		storage,
		log: quietLog(),
		site: { url: "https://coywolf.com", name: "Coywolf" },
		users: { list: async () => ({ items: [{ email: "jon@example.com" }] }) },
		email: { send: async (m) => void sent.push(m) },
	};
	const first = await alerts.checkAlerts(ctx, NOW);
	assert.equal(first.sent.length, 1);
	assert.match(sent[0].subject, /A Buttondown draft couldn't be created/);
	assert.match(sent[0].text, /Post old: Buttondown refused the key \(401\)\./);
	assert.match(sent[0].text, /plugins\/coywolf-pack\/buttondown/);
	await alerts.checkAlerts(ctx, NOW + 3600_000);
	assert.equal(sent.length, 1, "at most once a day, even with a new failure that day");
	await alerts.checkAlerts(ctx, NOW + 86_400_000);
	assert.equal(sent.length, 2, "the next day, while they still fail");
	assert.match(sent[1].subject, /2 Buttondown drafts couldn't be created/);
	// The title says what failed: a delete or an update isn't "couldn't be created".
	const { failedJob } = await import("../src/buttondown/store.ts");
	assert.equal(failedJob({ job: "remove", emailId: "em_x" }), "deleted");
	assert.equal(failedJob({ job: "sync", emailId: "em_x" }), "updated");
	assert.equal(failedJob({ job: "sync", emailId: null }), "created");
	const titles = async (records) => {
		const s = { [BUTTONDOWN_STORAGE]: fakeCollection() };
		for (const r of records) await s[BUTTONDOWN_STORAGE].put(`posts:${r.entryId}`, r);
		const out = [];
		await alerts.checkAlerts({ ...ctx, kv: fakeKv(), storage: s, email: { send: async (m) => void out.push(m) } }, NOW);
		return out.map((m) => m.subject).join(" | ");
	};
	const old = NOW - 2 * 3600_000;
	assert.match(await titles([{ ...failing("d", old), job: "remove", emailId: "em_x", unpublished: true }]), /A Buttondown draft couldn't be deleted/);
	assert.match(await titles([{ ...failing("u", old), emailId: "em_x" }]), /A Buttondown draft couldn't be updated/);
	assert.match(await titles([{ ...failing("u", old), emailId: "em_x" }, failing("c", old)]), /2 Buttondown drafts couldn't be created, updated or deleted/);
	// A failed create of a post that's unpublished, trashed or deleted since: not reported.
	const gone = { [BUTTONDOWN_STORAGE]: fakeCollection() };
	await gone[BUTTONDOWN_STORAGE].put("posts:t", { ...failing("t", old), trashed: true });
	await gone[BUTTONDOWN_STORAGE].put("posts:r", { ...failing("r", old), job: "remove", emailId: "em_x", trashed: true });
	assert.deepEqual((await failingRecords({ storage: gone }, NOW)).map((r) => r.entryId), ["r"]);
	// Off: not gathered.
	const off = { ...ctx, settings: fakeSettings({ features: { _defaults036: true, alerts: true, buttondown: false } }) };
	assert.equal((await alerts.checkAlerts(off, NOW + 2 * 86_400_000)).issues, 0);
});

test("the sidebar and the README list the page", async () => {
	const { SIDEBAR_FOLDERS } = await import("../src/core/sidebar.ts");
	assert.deepEqual(SIDEBAR_FOLDERS[0].pages.slice(5, 7), ["/alerts", "/buttondown"]);
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	assert.match(readme, /^\| \[Buttondown Drafts\]\(docs\/buttondown\.md\) \|/m);
});

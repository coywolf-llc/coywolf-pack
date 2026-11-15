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
	// Off: not gathered.
	const off = { ...ctx, settings: fakeSettings({ features: { _defaults036: true, alerts: true, buttondown: false } }) };
	assert.equal((await alerts.checkAlerts(off, NOW + 2 * 86_400_000)).issues, 0);
});

test("the sidebar lists the page", async () => {
	const { SIDEBAR_FOLDERS } = await import("../src/core/sidebar.ts");
	assert.deepEqual(SIDEBAR_FOLDERS[0].pages.slice(5, 7), ["/alerts", "/buttondown"]);
});

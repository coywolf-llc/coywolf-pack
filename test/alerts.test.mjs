// Run: node --test test/alerts.test.mjs
// Alerts & Digest: what's alerted (from what other modules already stored), at most
// once a day per issue and once while a lasting one lasts, through ctx.email, with
// plain-text and HTML bodies; the weekly digest and its sources; task outcomes.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeCollection, fakeKv, fakeSettings, quietLog } from "./fixtures/fake-plugin.mjs";

// The modules whose switches Alerts reads (their features register when they load).
await import("../src/backups/pack.ts");
await import("../src/links/pack.ts");
await import("../src/updates/pack.ts");
await import("../src/audit/pack.ts");
await import("../src/alerts/pack.ts");

const email = await import("../src/alerts/email.ts");
const alerts = await import("../src/alerts/run.ts");
const health = await import("../src/core/task-health.ts");
const digest = await import("../src/core/digest.ts");

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-10T12:00:00Z");

function fakeCtx({ features = {}, settings = {}, kv = {}, admins = ["owner@example.com"], provider = true, failSends = 0 } = {}) {
	const sent = [];
	let failures = failSends;
	return {
		sent,
		kv: fakeKv(kv),
		// _defaults036: a site set up after 0.36.0 (Backups starts off).
		settings: fakeSettings({ features: { _defaults036: true, alerts: true, ...features }, ...settings }),
		storage: { links_urls: fakeCollection(), links_refs: fakeCollection(), audit_chunks: fakeCollection() },
		log: quietLog(),
		site: { url: "https://example.com", name: "Example" },
		users: {
			async list({ role }) {
				assert.equal(role, 50, "admins only");
				return { items: admins.map((address, i) => ({ id: `u${i}`, email: address, name: null, role: 50, createdAt: "" })) };
			},
		},
		...(provider
			? {
					email: {
						async send(message) {
							if (failures > 0) {
								failures--;
								throw new Error("Provider is down");
							}
							sent.push(message);
						},
					},
				}
			: {}),
	};
}

test("emails: escaped HTML and plain text with the same sections, a one-line subject, links to the admin", () => {
	const built = email.buildEmail({
		siteName: "Joe's <Site>",
		siteUrl: "https://example.com",
		subject: "Backup failed\nnow",
		heading: "Backup failed",
		intro: "Something <b>broke</b>.",
		sections: [{ title: "Backup failed", lines: ["Error: <script>alert(1)</script>"], page: "/backups", pageLabel: "Open Backups" }],
		footer: "Sent by Coywolf Pack.",
	});
	assert.equal(built.subject, "Joe's <Site>: Backup failed now");
	assert.doesNotMatch(built.html, /<script>|<b>broke/);
	assert.match(built.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(built.html, /href="https:\/\/example\.com\/_emdash\/admin\/plugins\/coywolf-pack\/backups"/);
	assert.match(built.text, /BACKUP FAILED\n- Error: <script>alert\(1\)<\/script>\nOpen Backups: https:\/\/example\.com\/_emdash\/admin\/plugins\/coywolf-pack\/backups/);
	assert.match(built.html, /^<!doctype html><html lang="en">/);
});

test("recipients: typed lists are split, lowercased, deduplicated and checked", () => {
	assert.deepEqual(email.parseRecipients("A@Example.com, b@example.com;\na@example.com  nope"), { valid: ["a@example.com", "b@example.com"], invalid: ["nope"] });
	assert.equal(email.isEmail("x@y"), false);
	const s = alerts.normalizeAlertsSettings({ recipients: "list", emails: ["one@example.com", "bad"], alerts: { bill: false, nope: true }, billThreshold: 12.345 });
	assert.deepEqual(s.emails, ["one@example.com"]);
	assert.equal(s.alerts.bill, false);
	assert.equal(s.alerts.update, true);
	assert.equal(s.billThreshold, 12.35);
	assert.deepEqual(alerts.normalizeAlertsSettings(null), alerts.ALERTS_DEFAULTS);
});

test("a failed backup is emailed to the admins once that day; another failure is a new alert", async () => {
	const ctx = fakeCtx({ features: { backups: true }, admins: ["a@example.com", "B@example.com"] });
	await health.recordTaskOutcome(ctx.kv, "backups-daily", new Error("R2 said no"), new Date(NOW - 3600_000));
	const first = await alerts.checkAlerts(ctx, NOW);
	assert.equal(first.sent.length, 1);
	assert.deepEqual(ctx.sent.map((m) => m.to), ["a@example.com", "b@example.com"], "one email each");
	assert.match(ctx.sent[0].subject, /^Example: Backup failed$/);
	assert.match(ctx.sent[0].text, /Error: R2 said no/);
	assert.ok(ctx.sent[0].html.includes("Backup failed"));

	await alerts.checkAlerts(ctx, NOW + 3600_000);
	assert.equal(ctx.sent.length, 2, "not again the same day");
	await health.recordTaskOutcome(ctx.kv, "backups-daily", new Error("Again"), new Date(NOW + 2 * 3600_000));
	await alerts.checkAlerts(ctx, NOW + 3 * 3600_000);
	assert.equal(ctx.sent.length, 4, "a new failure is a new issue");
	// A successful run clears it.
	await health.recordTaskOutcome(ctx.kv, "backups-daily", null, new Date(NOW + 4 * 3600_000));
	assert.equal((await alerts.checkAlerts(ctx, NOW + DAY)).issues, 0);
});

test("alerts for modules that are off, or turned off in settings, aren't gathered", async () => {
	const ctx = fakeCtx({ settings: { alertsSettings: { alerts: { backupFailed: false } } }, features: { backups: true } });
	await health.recordTaskOutcome(ctx.kv, "backups-daily", new Error("x"), new Date(NOW));
	assert.equal((await alerts.checkAlerts(ctx, NOW)).issues, 0);
	const off = fakeCtx();
	await health.recordTaskOutcome(off.kv, "backups-daily", new Error("x"), new Date(NOW));
	assert.equal((await alerts.checkAlerts(off, NOW)).issues, 0, "Backups is off");
});

test("broken links: the first check only records them; links that break later are alerted, listed by URL", async () => {
	const ctx = fakeCtx({ features: { links: true, "links.check": true } });
	await ctx.storage.links_urls.put("u1", { url: "https://old.test/", status: "broken", ignored: false, code: 404 });
	assert.equal((await alerts.checkAlerts(ctx, NOW)).issues, 0);
	await ctx.storage.links_urls.put("u2", { url: "https://gone.test/page", status: "broken", ignored: false, code: 410 });
	await ctx.storage.links_urls.put("u3", { url: "https://ignored.test/", status: "broken", ignored: true });
	const out = await alerts.checkAlerts(ctx, NOW + 3600_000);
	assert.equal(out.sent.length, 1);
	assert.match(ctx.sent[0].text, /1 NEW BROKEN LINK\n- https:\/\/gone\.test\/page \(410\)/);
	assert.equal((await alerts.checkAlerts(ctx, NOW + 2 * 3600_000)).sent.length, 0, "known now");
});

test("lasting conditions (the bill, an update) are sent once while they last, and again after they clear and return", async () => {
	const usage = (total) => ({ at: new Date(NOW).toISOString(), bill: { base: 5, overage: {}, total }, plan: "paid", periods: {}, storage: {}, warming: null, notes: [] });
	const ctx = fakeCtx({ settings: { alertsSettings: { billThreshold: 10 } }, kv: { "cache:usage": usage(14.5) } });
	await alerts.checkAlerts(ctx, NOW);
	assert.equal(ctx.sent.length, 1);
	assert.match(ctx.sent[0].text, /about \$14\.50, over your threshold of \$10\.00/);
	await alerts.checkAlerts(ctx, NOW + DAY);
	assert.equal(ctx.sent.length, 1, "still over: not again");
	await ctx.kv.set("cache:usage", usage(8));
	await alerts.checkAlerts(ctx, NOW + 2 * DAY);
	await ctx.kv.set("cache:usage", usage(11));
	await alerts.checkAlerts(ctx, NOW + 3 * DAY);
	assert.equal(ctx.sent.length, 2, "over again after dropping below");

	const updates = fakeCtx({ features: { updates: true }, settings: { updateState: { checkedAt: new Date(NOW).toISOString(), latest: "99.0.0" } } });
	await alerts.checkAlerts(updates, NOW);
	await alerts.checkAlerts(updates, NOW + DAY);
	assert.equal(updates.sent.length, 1);
	assert.match(updates.sent[0].text, /Version 99\.0\.0 is available/);
});

test("a worse content audit is alerted once per run (the first report seen is the baseline)", async () => {
	const report = (runId, counts, previous) => ({ runId, startedAt: runId, finishedAt: runId, entries: 10, entriesWithIssues: 3, counts: { ...Object.fromEntries(["seoTitleMissing", "titleDuplicate", "titleLength", "descriptionMissing", "descriptionDuplicate", "descriptionLength", "altMissing", "socialImageMissing", "thin", "stale", "headings", "brokenLinks"].map((c) => [c, 0])), ...counts }, off: [], linksChecked: false, previous });
	const ctx = fakeCtx({ features: { audit: true } });
	const r1 = report("2026-11-01T00:00:00.000Z", { thin: 2 }, null);
	await ctx.kv.set("audit:report", r1);
	assert.equal((await alerts.checkAlerts(ctx, NOW)).issues, 0);
	await ctx.kv.set("audit:report", report("2026-11-08T00:00:00.000Z", { thin: 5, altMissing: 1 }, { runId: r1.runId, finishedAt: r1.finishedAt, entries: 10, counts: r1.counts }));
	await alerts.checkAlerts(ctx, NOW);
	assert.equal(ctx.sent.length, 1);
	assert.match(ctx.sent[0].text, /Thin content: 2 → 5 entries/);
	assert.match(ctx.sent[0].text, /Images without alt text: 0 → 1 entries/);
	await alerts.checkAlerts(ctx, NOW + DAY);
	assert.equal(ctx.sent.length, 1);
});

test("without an email provider nothing is sent and nothing is marked sent; a failed send is retried", async () => {
	const ctx = fakeCtx({ features: { backups: true }, provider: false });
	await health.recordTaskOutcome(ctx.kv, "backups-daily", new Error("x"), new Date(NOW));
	const out = await alerts.checkAlerts(ctx, NOW);
	assert.match(out.result.error, /No email provider/);
	assert.deepEqual((await alerts.readState(ctx)).sent, {});
	assert.equal(alerts.emailConfigured(ctx), false);

	const flaky = fakeCtx({ features: { backups: true }, failSends: 1 });
	await health.recordTaskOutcome(flaky.kv, "backups-daily", new Error("x"), new Date(NOW));
	await alerts.checkAlerts(flaky, NOW);
	assert.equal(flaky.sent.length, 0);
	await alerts.checkAlerts(flaky, NOW + 3600_000);
	assert.equal(flaky.sent.length, 1, "retried the next hour");
	assert.equal((await alerts.readState(flaky)).log.length, 2);
});

test("per recipient: one address failing doesn't mark the alert sent for it; it's retried, the others aren't sent twice", async () => {
	const ctx = fakeCtx({ features: { backups: true }, admins: ["ok@example.com", "flaky@example.com"] });
	let flaky = 1;
	ctx.email.send = async (message) => {
		if (message.to === "flaky@example.com" && flaky-- > 0) throw new Error("Mailbox busy");
		ctx.sent.push(message);
	};
	await health.recordTaskOutcome(ctx.kv, "backups-daily", new Error("x"), new Date(NOW));
	const first = await alerts.checkAlerts(ctx, NOW);
	assert.deepEqual(first.result, { sent: 1, failed: 1, unconfirmed: 0, error: "Mailbox busy" });
	assert.deepEqual(ctx.sent.map((m) => m.to), ["ok@example.com"]);
	await alerts.checkAlerts(ctx, NOW + 3600_000);
	assert.deepEqual(ctx.sent.map((m) => m.to), ["ok@example.com", "flaky@example.com"], "only the failed address, the next hour");
});

test("a send the provider doesn't confirm in time counts as sent (unconfirmed): no resend storm", async () => {
	const { DeadlineError } = await import("../src/core/single-flight.ts");
	const ctx = fakeCtx({ features: { backups: true } });
	let calls = 0;
	ctx.email.send = async () => {
		calls++;
		throw new DeadlineError("Sending an email", 20_000);
	};
	await health.recordTaskOutcome(ctx.kv, "backups-daily", new Error("x"), new Date(NOW));
	const out = await alerts.checkAlerts(ctx, NOW);
	assert.equal(out.result.unconfirmed, 1);
	await alerts.checkAlerts(ctx, NOW + 3600_000);
	assert.equal(calls, 1, "not sent again the same day");
	assert.equal((await alerts.readState(ctx)).log.at(-1).unconfirmed, 1);
});

test("the digest isn't sent twice within six days", async () => {
	const ctx = fakeCtx({ features: { backups: true, "alerts.digest": true } });
	await health.recordTaskOutcome(ctx.kv, "backups-daily", null, new Date(NOW));
	assert.equal((await alerts.sendDigest(ctx, NOW)).result.sent, 1);
	const again = await alerts.sendDigest(ctx, NOW + 3600_000);
	assert.match(again.skipped, /A digest went out/);
	assert.equal((await alerts.sendDigest(ctx, NOW + 7 * DAY)).result.sent, 1);
	assert.equal(ctx.sent.length, 2);
});

test("a list of addresses replaces the admins", async () => {
	const ctx = fakeCtx({ settings: { alertsSettings: { recipients: "list", emails: ["ops@example.com"] } } });
	assert.deepEqual(await alerts.recipients(ctx, await alerts.readAlertsSettings(ctx)), ["ops@example.com"]);
	const result = await alerts.sendTest(ctx);
	assert.equal(result.sent, 1);
	assert.equal(ctx.sent[0].to, "ops@example.com");
	assert.match(ctx.sent[0].subject, /Test alert/);
});

test("the digest sums up what's on, includes registered sources (Insights), and skips a failing or slow one", async () => {
	const empty = fakeCtx({ features: { "alerts.digest": true } });
	assert.deepEqual(await alerts.sendDigest(empty, NOW), { sections: 0 });
	assert.equal(empty.sent.length, 0, "nothing to report: nothing sent");

	digest.registerDigestSource({ id: "test.traffic", feature: "alerts", read: async () => ({ title: "Traffic", lines: ["1,234 visits in the last 7 days", 42], page: "/insights" }) });
	digest.registerDigestSource({ id: "test.broken", feature: "alerts", read: async () => Promise.reject(new Error("no data")) });
	digest.registerDigestSource({ id: "test.off", feature: "insights", read: async () => ({ title: "Never", lines: ["x"] }) });
	const ctx = fakeCtx({ features: { backups: true, "alerts.digest": true } });
	await health.recordTaskOutcome(ctx.kv, "backups-daily", null, new Date(NOW - 3600_000));
	const out = await alerts.sendDigest(ctx, NOW);
	assert.equal(out.sections, 2);
	assert.equal(ctx.sent.length, 1);
	assert.match(ctx.sent[0].subject, /Your weekly site digest/);
	assert.match(ctx.sent[0].text, /BACKUPS\n- Last successful run:/);
	assert.match(ctx.sent[0].text, /TRAFFIC\n- 1,234 visits in the last 7 days\nOpen: https:\/\/example\.com\/_emdash\/admin\/plugins\/coywolf-pack\/insights/);
	assert.doesNotMatch(ctx.sent[0].text, /Never/);
	assert.ok(ctx.log.lines.some((l) => l.data?.source === "test.broken"), "the failing source is logged and left out");
	assert.equal(digest.cleanSection({ title: "x", lines: [] }), null);
	assert.equal(digest.cleanSection({ title: "x", lines: ["a"], page: "javascript:alert(1)" }).page, undefined);
});

test("task outcomes: success and failure are recorded, and the failure is thrown again", async () => {
	const kv = fakeKv();
	await health.withOutcome(kv, "t", async () => {});
	const ok = await health.readTaskOutcome(kv, "t");
	assert.ok(ok.lastOkAt && !ok.lastFailedAt && ok.error === null);
	await assert.rejects(health.withOutcome(kv, "t", async () => Promise.reject(new Error("boom"))), /boom/);
	const failed = await health.readTaskOutcome(kv, "t");
	assert.equal(failed.error, "boom");
	assert.equal(failed.lastOkAt, ok.lastOkAt, "the last success is kept");
});

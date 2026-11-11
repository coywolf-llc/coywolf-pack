// Run: node --test test/usage.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

// Worker secrets are also read from process.env: a developer's shell may export these.
for (const name of ["CLOUDFLARE_API_TOKEN", "USAGE_API_TOKEN", "CF_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]) delete process.env[name];

const { estimateBill, estimateWarming, foldTotals, planFromDailyPeaks, planFromEntitlements, PAID } = await import("../src/pageCache/usage-core.ts");
const { usageReport } = await import("../src/pageCache/usage.ts");

const totals = (over = {}) => ({
	d1: { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0, ...over.d1 },
	workers: { requests: 0, cpuMs: 0, errors: 0, ...over.workers },
});

test("plan from the entitlements: D1's per-database limit", () => {
	const ent = (mb) => [{ id: "workers.enabled", allocation: { value: true } }, { id: "d1.max_storage_per_db_mb", feature: { key: "d1.max_storage_per_db_mb" }, allocation: { value: mb, type: "max_count" } }];
	assert.equal(planFromEntitlements(ent(10000)), "paid");
	assert.equal(planFromEntitlements(ent(500)), "free");
	assert.equal(planFromEntitlements([]), null);
	assert.equal(planFromEntitlements(null), null);
	assert.equal(planFromEntitlements({ error: "forbidden" }), null);
});

test("plan from usage: a day over Free's limits means Paid; otherwise unknown", () => {
	assert.equal(planFromDailyPeaks({ requests: 150_000, rowsRead: 0, rowsWritten: 0 }), "paid");
	assert.equal(planFromDailyPeaks({ requests: 0, rowsRead: 9_000_000, rowsWritten: 0 }), "paid");
	assert.equal(planFromDailyPeaks({ requests: 1000, rowsRead: 1000, rowsWritten: 10 }), null);
});

test("bill: the $5 base, plus only what's over the included amounts", () => {
	const inside = estimateBill(totals({ workers: { requests: 655_000, cpuMs: 19_000_000 }, d1: { rowsRead: 298e6, rowsWritten: 2.9e6 } }), 80 * 1024 ** 2);
	assert.equal(inside.total, 5);
	assert.deepEqual(Object.values(inside.overage), [0, 0, 0, 0, 0]);
	const over = estimateBill(totals({ workers: { requests: 20_000_000, cpuMs: 40_000_000 }, d1: { rowsRead: 26e9, rowsWritten: 52e6 } }), 6e9);
	assert.deepEqual(over.overage, { requests: 3, cpu: 0.2, rowsRead: 1, rowsWritten: 2, storage: 0.75 });
	assert.equal(over.total, 11.95);
	assert.equal(PAID.base, 5);
});

test("warming: shares of the site's requests and CPU, D1 rows by the request share", () => {
	const w = estimateWarming({ visits: 7470, cpuMs: 198_350 }, totals({ workers: { requests: 96_000, cpuMs: 3_000_000 }, d1: { rowsRead: 60e6 } }), 7);
	assert.ok(Math.abs(w.requestShare - 7470 / 96000) < 1e-9);
	assert.ok(Math.abs(w.cpuShare - 198350 / 3e6) < 1e-9);
	assert.equal(w.rowsRead, Math.round(60e6 * (7470 / 96000)));
	assert.equal(estimateWarming({ visits: 5, cpuMs: 1 }, totals(), 7).requestShare, 0, "no traffic: no share (no division by zero)");
	assert.equal(estimateWarming({ visits: 500, cpuMs: 1 }, totals({ workers: { requests: 100, cpuMs: 1 } }), 7).requestShare, 1, "capped at 100%");
});

test("fold GraphQL rows: the site's database and Worker, and the account's totals", () => {
	const out = foldTotals(
		[
			{ dimensions: { databaseId: "db1" }, sum: { rowsRead: 10, rowsWritten: 2, readQueries: 3, writeQueries: 1 } },
			{ dimensions: { databaseId: "db2" }, sum: { rowsRead: 5, rowsWritten: 1, readQueries: 1, writeQueries: 1 } },
		],
		[
			{ dimensions: { scriptName: "coywolf" }, sum: { requests: 100, errors: 1, cpuTimeUs: 2_500_000 } },
			{ dimensions: { scriptName: "other" }, sum: { requests: 50, errors: 0, cpuTimeUs: 500_000 } },
		],
		{ databaseId: "db1", worker: "coywolf" },
	);
	assert.deepEqual(out.site, { d1: { rowsRead: 10, rowsWritten: 2, readQueries: 3, writeQueries: 1 }, workers: { requests: 100, cpuMs: 2500, errors: 1 } });
	assert.deepEqual(out.account, { d1: { rowsRead: 15, rowsWritten: 3, readQueries: 4, writeQueries: 2 }, workers: { requests: 150, cpuMs: 3000, errors: 1 } });
});

// ── The whole read, against a fake Cloudflare API ──

function fakeCtx(settings = {}) {
	const kv = new Map();
	const logs = [];
	return {
		settings: { get: async (k) => settings[k] ?? null },
		kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) },
		log: { info() {}, warn: (...a) => logs.push(a), error() {} },
		logs,
		kvMap: kv,
	};
}

const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });

function fakeApi(over = {}) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		const path = url.replace("https://api.cloudflare.com/client/v4", "");
		calls.push({ path, method: init.method ?? "GET", auth: init.headers?.Authorization });
		if (over[path]) return over[path](init);
		if (path === "/accounts?per_page=5") return ok([{ id: "acct" }]);
		if (path === "/accounts/acct/workers/scripts") return ok([{ id: "other", modified_on: "2026-10-01T00:00:00Z" }, { id: "coywolf", modified_on: "2026-11-01T00:00:00Z" }]);
		if (path === "/accounts/acct/workers/scripts/coywolf/deployments") return ok({ deployments: [{ versions: [{ version_id: "v-123", percentage: 100 }] }] });
		if (path === "/accounts/acct/workers/scripts/other/deployments") return ok({ deployments: [{ versions: [{ version_id: "v-other" }] }] });
		if (path === "/accounts/acct/workers/scripts/coywolf/settings") return ok({ bindings: [{ type: "kv_namespace", name: "X" }, { type: "d1", name: "DB", id: "db1", database_id: "db1" }] });
		if (path === "/accounts/acct/entitlements") return ok([{ id: "d1.max_storage_per_db_mb", allocation: { value: 10000 } }]);
		if (path === "/accounts/acct/workers/observability/telemetry/query") return ok({ calculations: [{ alias: "visits", aggregates: [{ value: 70 }] }, { alias: "cpu", aggregates: [{ value: 1400 }] }] });
		if (path === "/graphql") {
			const d1 = [{ dimensions: { databaseId: "db1" }, sum: { rowsRead: 1000, rowsWritten: 10, readQueries: 100, writeQueries: 5 } }];
			const w = [{ dimensions: { scriptName: "coywolf" }, sum: { requests: 700, errors: 0, cpuTimeUs: 14_000_000 } }, { dimensions: { scriptName: "other" }, sum: { requests: 300, errors: 0, cpuTimeUs: 1_000_000 } }];
			const data = { viewer: { accounts: [{ d1Day: d1, d1Week: d1, d1Month: d1, d1Daily: [], wDay: w, wWeek: w, wMonth: w, wDaily: [], storage: [{ dimensions: { databaseId: "db1" }, max: { databaseSizeBytes: 55_926_784 } }] }] } };
			return new Response(JSON.stringify({ data, errors: null }), { status: 200 });
		}
		return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${path}` }] }), { status: 404 });
	};
	return { fetch, calls };
}

test("not configured without a token: says how to add one", async () => {
	const r = await usageReport(fakeCtx(), false, {});
	assert.equal(r.configured, false);
	assert.match(r.reason, /Add the Cloudflare API token on the plugin's Settings page \(or the CLOUDFLARE_API_TOKEN Worker secret\)/);
	assert.match(r.reason, /Workers → Metadata Read-Only/);
});

test("finds the site's Worker by its deployed version and its D1 database, then reads usage", async () => {
	const api = fakeApi();
	const ctx = { ...fakeCtx({ usageApiToken: "tok" }), http: { fetch: api.fetch } };
	const r = await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" } });
	assert.equal(r.configured, true);
	assert.equal(r.worker, "coywolf");
	assert.equal(r.databaseId, "db1");
	assert.equal(r.plan, "paid");
	assert.equal(r.planSource, "entitlements");
	assert.equal(r.periods.month.site.workers.requests, 700);
	assert.equal(r.periods.month.account.workers.requests, 1000);
	assert.equal(r.periods.month.site.workers.cpuMs, 14_000);
	assert.equal(r.storage.siteBytes, 55_926_784);
	assert.equal(r.bill.total, 5);
	assert.equal(r.warming.visits, 70);
	assert.ok(Math.abs(r.warming.requestShare - 0.1) < 1e-9);
	assert.deepEqual(r.notes, []);
	assert.ok(api.calls.every((c) => c.auth === "Bearer tok"));
	// The most recently deployed Worker is checked first, so "other" isn't needed.
	assert.ok(!api.calls.some((c) => c.path.includes("/other/")));

	// Kept: a second read makes no calls.
	const before = api.calls.length;
	await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" } });
	assert.equal(api.calls.length, before);
});

test("parts the token can't read become notes; the rest still shows", async () => {
	const forbidden = () => new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 });
	const api = fakeApi({ "/accounts/acct/entitlements": forbidden, "/accounts/acct/workers/observability/telemetry/query": forbidden });
	const ctx = { ...fakeCtx({ usageApiToken: "tok" }), http: { fetch: api.fetch } };
	const r = await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" } });
	assert.equal(r.configured, true);
	assert.equal(r.plan, null, "no entitlements and no day over Free's limits");
	assert.equal(r.warming, null);
	assert.equal(r.notes.length, 2);
	assert.match(r.notes.join(" "), /Account Settings → Read/);
	assert.match(r.notes.join(" "), /Metadata Read-Only/);
});

test("analytics refused: not configured, with the reason", async () => {
	const api = fakeApi({ "/graphql": () => new Response(JSON.stringify({ data: null, errors: [{ message: "not authorized for that account" }] }), { status: 200 }) });
	const ctx = { ...fakeCtx({ usageApiToken: "tok" }), http: { fetch: api.fetch } };
	const r = await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" } });
	assert.equal(r.configured, false);
	assert.match(r.reason, /Account Analytics → Read/);
});

test("a failed read isn't retried for five minutes (rate limits), then is", async () => {
	let graphql = 0;
	const api = fakeApi({ "/graphql": () => (graphql++, new Response(JSON.stringify({ success: false, errors: [{ message: "rate limited" }] }), { status: 429 })) });
	const ctx = { ...fakeCtx({ usageApiToken: "tok" }), http: { fetch: api.fetch } };
	const first = await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" } });
	assert.equal(first.configured, false);
	const second = await usageReport(ctx, true, { CF_VERSION_METADATA: { id: "v-123" } });
	assert.equal(graphql, 1, "no second call while the failure is recent");
	assert.match(second.reason, /Trying again after/);
	const failed = ctx.kvMap.get("state:usage:failed");
	ctx.kvMap.set("state:usage:failed", { ...failed, at: new Date(Date.now() - 6 * 60_000).toISOString() });
	await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" } });
	assert.equal(graphql, 2);
});

test("a Worker that isn't found is remembered for this version, not searched for on every read", async () => {
	const api = fakeApi();
	const ctx = { ...fakeCtx({ usageApiToken: "tok" }), http: { fetch: api.fetch } };
	const r = await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-unknown" } });
	assert.equal(r.worker, null);
	const scans = api.calls.filter((c) => c.path.endsWith("/deployments")).length;
	ctx.kvMap.delete("cache:usage");
	await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-unknown" } });
	assert.equal(api.calls.filter((c) => c.path.endsWith("/deployments")).length, scans);
});

test("the remembered Worker and database are still used while Cloudflare can't be asked for the account", async () => {
	const ok1 = fakeApi();
	const ctx = { ...fakeCtx({ usageApiToken: "tok" }), http: { fetch: ok1.fetch } };
	assert.equal((await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" } })).configured, true);
	// A new reading, with the account lookup forgotten and Cloudflare answering 500 for it.
	ctx.kvMap.delete("cache:usage");
	ctx.kvMap.delete("state:cloudflare:account");
	const down = fakeApi({ "/accounts?per_page=5": () => new Response(JSON.stringify({ success: false, errors: [{ message: "Internal error" }] }), { status: 500 }) });
	ctx.http = { fetch: down.fetch };
	const r = await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" } });
	assert.equal(r.configured, true);
	assert.equal(r.worker, "coywolf");
	assert.ok(!down.calls.some((c) => c.path === "/accounts?per_page=5"), "the remembered target's account is used without asking");
});

test("the Cloudflare API token wins over the older usage token; the older one, and its Worker secret, still work alone", async () => {
	const read = async (settings, env) => {
		const api = fakeApi();
		const ctx = { ...fakeCtx(settings), http: { fetch: api.fetch } };
		const r = await usageReport(ctx, false, { CF_VERSION_METADATA: { id: "v-123" }, ...env });
		assert.equal(r.configured, true);
		return [...new Set(api.calls.map((c) => c.auth))];
	};
	assert.deepEqual(await read({ cloudflareApiToken: "new-token", usageApiToken: "old-token" }, { USAGE_API_TOKEN: "env-token" }), ["Bearer new-token"]);
	assert.deepEqual(await read({ usageApiToken: "old-token" }, { CLOUDFLARE_API_TOKEN: "shared-env" }), ["Bearer old-token"]);
	assert.deepEqual(await read({}, { USAGE_API_TOKEN: "env-token", CLOUDFLARE_API_TOKEN: "shared-env" }), ["Bearer env-token"], "CLOUDFLARE_API_TOKEN ranks last");
	assert.deepEqual(await read({}, { CLOUDFLARE_API_TOKEN: "shared-env" }), ["Bearer shared-env"]);
});

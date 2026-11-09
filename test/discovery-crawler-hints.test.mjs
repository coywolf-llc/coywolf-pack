// Discovery → Crawler Hints (0.35.18): reading Cloudflare's setting for the site's zone with the
// read-only token, what the card says when it can't, the route, and the cleanup of IndexNow and
// Bing submission, which it replaced.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { crawlerHintsDashboardUrl, readCrawlerHints, zoneCandidates } = await import("../src/discovery/crawler-hints.ts");
const { DEADLINES } = await import("../src/core/single-flight.ts");
const { discoveryPack, discoveryMiddleware } = await import("../src/discovery/pack.ts");
const { RETIRED_BING_TASK, retireIndexNow } = await import("../src/discovery/module.ts");
const { composeHooks } = await import("../src/core/compose.ts");
const { SECRET_SETTINGS } = await import("../src/core/secrets.ts");
const { GUIDES } = await import("../src/core/guide-content.ts");

const TOKEN = "cf-read-only-token-0123456789";
const ACCOUNT = "8e89c2f5fd978059eb0899213b185e7f";
const API = "https://api.cloudflare.com/client/v4";
const ok = (result) => Response.json({ success: true, errors: [], messages: [], result });
const fail = (status, code, message) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

/** A scripted Cloudflare API: zones by name, and each zone's flags. */
function cloudflare({ zones = {}, flags = {}, onZones, onFlags } = {}) {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url, auth: init?.headers?.Authorization });
		const u = new URL(url);
		if (u.pathname === "/client/v4/zones") {
			if (onZones) return onZones(u);
			const name = u.searchParams.get("name");
			return ok(zones[name] ? [{ id: zones[name], name, account: { id: ACCOUNT } }] : []);
		}
		const m = u.pathname.match(/^\/client\/v4\/zones\/([^/]+)\/flags$/);
		if (m) {
			if (onFlags) return onFlags(m[1]);
			return ok({ cache: { crawlhints_card: true, crawlhints_enabled: flags[m[1]] } });
		}
		throw new Error(`unexpected fetch ${url}`);
	};
	return { calls, fetch };
}

test("zone names for a host: most specific first, never a bare TLD", () => {
	assert.deepEqual(zoneCandidates("get.essential.support"), ["get.essential.support", "essential.support"]);
	assert.deepEqual(zoneCandidates("coywolf.com"), ["coywolf.com"]);
	assert.deepEqual(zoneCandidates("WWW.Example.co.uk."), ["www.example.co.uk", "example.co.uk", "co.uk"]);
	assert.deepEqual(zoneCandidates("localhost"), []);
	assert.equal(zoneCandidates("a.b.c.d.e.f.example.com").length, 4, "at most four lookups");
});

test("the dashboard link opens the zone's Caching → Configuration, or asks for the account and zone", () => {
	assert.equal(crawlerHintsDashboardUrl({ name: "coywolf.com", accountId: ACCOUNT }), `https://dash.cloudflare.com/${ACCOUNT}/coywolf.com/caching/configuration`);
	assert.equal(crawlerHintsDashboardUrl(null), "https://dash.cloudflare.com/?to=/:account/:zone/caching/configuration");
	assert.equal(crawlerHintsDashboardUrl({ name: "coywolf.com", accountId: null }), "https://dash.cloudflare.com/?to=/:account/:zone/caching/configuration");
});

test("without a token nothing is fetched, and the card says which token to add", async () => {
	const cf = cloudflare();
	const status = await readCrawlerHints("coywolf.com", { token: null, fetch: cf.fetch });
	assert.equal(status.enabled, null);
	assert.equal(status.problem.kind, "no-token");
	assert.match(status.problem.message, /Zone → Zone → Read/);
	assert.match(status.problem.message, /Cloudflare usage token/);
	assert.equal(cf.calls.length, 0);
});

test("on: the zone is found from the site's host (a subdomain finds its parent zone), then its flags are read", async () => {
	const cf = cloudflare({ zones: { "essential.support": "zone-es" }, flags: { "zone-es": true } });
	const status = await readCrawlerHints("get.essential.support", { token: TOKEN, fetch: cf.fetch, now: () => Date.parse("2026-11-09T12:00:00Z") });
	assert.equal(status.enabled, true);
	assert.equal(status.problem, undefined, "no message when the token can read it");
	assert.deepEqual(status.zone, { id: "zone-es", name: "essential.support", accountId: ACCOUNT });
	assert.equal(status.dashboardUrl, `https://dash.cloudflare.com/${ACCOUNT}/essential.support/caching/configuration`);
	assert.equal(status.checkedAt, "2026-11-09T12:00:00.000Z");
	assert.deepEqual(
		cf.calls.map((c) => c.url),
		[`${API}/zones?name=get.essential.support&per_page=5`, `${API}/zones?name=essential.support&per_page=5`, `${API}/zones/zone-es/flags`],
	);
	for (const call of cf.calls) assert.equal(call.auth, `Bearer ${TOKEN}`);
	assert.ok(!JSON.stringify(status).includes(TOKEN), "the token is never in the answer");
});

test("off", async () => {
	const cf = cloudflare({ zones: { "recollect.fyi": "zone-r" }, flags: { "zone-r": false } });
	const status = await readCrawlerHints("recollect.fyi", { token: TOKEN, fetch: cf.fetch });
	assert.equal(status.enabled, false);
	assert.equal(status.problem, undefined);
});

test("a zone found before isn't looked up again", async () => {
	const cf = cloudflare({ flags: { "zone-c": true } });
	const status = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: cf.fetch, knownZone: { id: "zone-c", name: "coywolf.com", accountId: ACCOUNT } });
	assert.equal(status.enabled, true);
	assert.deepEqual(cf.calls.map((c) => c.url), [`${API}/zones/zone-c/flags`]);
	// A remembered zone of another host is ignored.
	const other = cloudflare({ zones: { "wellbeing.io": "zone-w" }, flags: { "zone-w": false } });
	await readCrawlerHints("wellbeing.io", { token: TOKEN, fetch: other.fetch, knownZone: { id: "zone-c", name: "coywolf.com", accountId: ACCOUNT } });
	assert.equal(other.calls[0].url, `${API}/zones?name=wellbeing.io&per_page=5`);
});

test("a token without Zone Read sees no zone: the card says to add it", async () => {
	const cf = cloudflare(); // Cloudflare answers an empty list, not an error, for zones a token can't see.
	const status = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: cf.fetch });
	assert.equal(status.enabled, null);
	assert.equal(status.problem.kind, "no-zone");
	assert.match(status.problem.message, /can't see a zone for coywolf\.com\. Add Zone → Zone → Read/);
	const refused = cloudflare({ onZones: () => fail(403, 9109, "Unauthorized to access requested resource") });
	const r = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: refused.fetch });
	assert.equal(r.problem.kind, "no-zone");
	assert.match(r.problem.message, /can't list zones \(HTTP 403: Unauthorized to access requested resource \(code 9109\)\)\. Add Zone → Zone → Read/);
});

test("a token that sees the zone but not the setting: the card links to the dashboard instead", async () => {
	const cf = cloudflare({ zones: { "coywolf.com": "zone-c" }, onFlags: () => fail(403, 10000, "Authentication error") });
	const status = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: cf.fetch });
	assert.equal(status.enabled, null);
	assert.equal(status.problem.kind, "no-access");
	assert.match(status.problem.message, /sees coywolf\.com, but Cloudflare didn't show it the Crawler Hints setting/);
	assert.equal(status.dashboardUrl, `https://dash.cloudflare.com/${ACCOUNT}/coywolf.com/caching/configuration`, "the exact link still works");
	// An answer without the setting.
	const odd = cloudflare({ zones: { "coywolf.com": "zone-c" }, onFlags: () => ok({ cache: {} }) });
	assert.equal((await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: odd.fetch })).problem.kind, "error");
});

test("Cloudflare unreachable or stalled: an error on the card, never a hang, never the token", async () => {
	const down = { fetch: async (url) => Promise.reject(new TypeError(`fetch failed for ${url} with Bearer ${TOKEN}`)) };
	const status = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: down.fetch });
	assert.equal(status.problem.kind, "error");
	assert.ok(!status.problem.message.includes(TOKEN));
	const before = DEADLINES.cloudflareReadMs;
	DEADLINES.cloudflareReadMs = 20;
	try {
		const started = Date.now();
		const stalled = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: () => new Promise(() => {}) });
		assert.equal(stalled.problem.kind, "error");
		assert.match(stalled.problem.message, /took longer than 20 ms/);
		assert.ok(Date.now() - started < 1000);
	} finally {
		DEADLINES.cloudflareReadMs = before;
	}
});

// ── The module: route, pack, cleanup ─────────────────────────────

function fakeCtx({ features = { discovery: true }, settings: initial = {}, kv: initialKv = {}, fetch, failDelete } = {}) {
	const settings = new Map([["features", features], ...Object.entries(initial)]);
	const kv = new Map(Object.entries(initialKv));
	const cancelled = [];
	const logs = [];
	const log = (level) => (message, data) => logs.push({ level, message, data });
	return {
		site: { url: "https://coywolf.com/", name: "Coywolf" },
		settings: {
			get: async (k) => settings.get(k) ?? null,
			set: async (k, v) => void settings.set(k, v),
			delete: async (k) => {
				if (failDelete === k) throw new Error("D1 busy");
				return settings.delete(k);
			},
		},
		kv: {
			get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
			set: async (k, v) => void kv.set(k, structuredClone(v)),
			delete: async (k) => kv.delete(k),
			list: async (prefix = "") => [...kv.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
		},
		cron: { cancel: async (name) => void cancelled.push(name), schedule: async () => undefined },
		http: fetch ? { fetch } : undefined,
		schema: { listCollections: async () => [] },
		log: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
		settingsMap: settings,
		kvMap: kv,
		cancelled,
		logs,
	};
}

const pack = discoveryPack({});

test("IndexNow and Bing submission are gone: no switch, routes, key file or hosts; Crawler Hints reads Cloudflare's API", () => {
	assert.deepEqual(pack.features.map((f) => f.id), ["discovery", "discovery.newsSitemap", "discovery.feed", "discovery.llms"]);
	assert.deepEqual(pack.allowedHosts, ["api.cloudflare.com"]);
	for (const name of ["discovery/public/key", "discovery/regenerate-key", "discovery/submit", "discovery/bing-key", "discovery/bing-check"]) assert.equal(pack.routes[name], undefined, name);
	assert.equal(pack.tasks.length, 0);
	assert.deepEqual(Object.keys(pack.retiredTasks), [RETIRED_BING_TASK]);
	assert.equal(SECRET_SETTINGS.discoveryBingApiKey, undefined);
	assert.equal(GUIDES.bing, undefined);
	assert.match(GUIDES["crawler-hints-token"].steps.join(" "), /Zone → Zone → Read/);
	assert.deepEqual(discoveryMiddleware.map((m) => m.feature), ["discovery.newsSitemap", "discovery.feed", "discovery.llms"]);
	// A GET: it changes nothing, so it clears no cache (only POSTs to pack routes do).
	assert.equal(pack.routes["discovery/crawler-hints"].methods, undefined);
	assert.equal(pack.routes["discovery/crawler-hints"].permission, "plugins:manage");
});

test("the route reads Crawler Hints with the Performance page's token, and remembers the zone", async () => {
	const cf = cloudflare({ zones: { "coywolf.com": "zone-c" }, flags: { "zone-c": true } });
	const ctx = fakeCtx({ settings: { usageApiToken: ` ${TOKEN} ` }, fetch: cf.fetch });
	const status = await pack.routes["discovery/crawler-hints"].handler(ctx);
	assert.equal(status.enabled, true);
	assert.equal(status.host, "coywolf.com");
	assert.equal(cf.calls[0].auth, `Bearer ${TOKEN}`, "the saved token, trimmed");
	assert.deepEqual(ctx.kvMap.get("state:discovery:crawlerHintsZone"), { host: "coywolf.com", zone: { id: "zone-c", name: "coywolf.com", accountId: ACCOUNT } });
	// The next read uses the remembered zone.
	await pack.routes["discovery/crawler-hints"].handler(ctx);
	assert.deepEqual(cf.calls.slice(2).map((c) => c.url), [`${API}/zones/zone-c/flags`]);
});

test("the route without a token, and with Discovery off", async () => {
	const ctx = fakeCtx({ fetch: async () => assert.fail("nothing is fetched") });
	const status = await pack.routes["discovery/crawler-hints"].handler(ctx);
	assert.equal(status.problem.kind, "no-token");
	assert.equal(ctx.kvMap.has("state:discovery:crawlerHintsZone"), false);
	await assert.rejects(pack.routes["discovery/crawler-hints"].handler(fakeCtx({ features: { discovery: false }, settings: { usageApiToken: TOKEN } })));
});

const leftovers = () => ({
	settings: { discoveryIndexnowKey: "7f8c4466cdb78749188a0a083451cc76", discoveryBingApiKey: { $emdash: "plugin-setting", v: 1, ciphertext: "…" }, discoverySettings: { news: { collections: ["posts"] } } },
	kv: {
		"state:discovery:indexnowLog": [{ at: "2026-11-09T00:00:00Z" }],
		"state:discovery:bingQuota": { daily: 10 },
		"state:discovery:bingPending": ["https://coywolf.com/a/"],
		"state:discovery:url:posts:1": "https://coywolf.com/a/",
		"state:discovery:url:pages:2": "https://coywolf.com/b/",
		"cache:discovery:llms": { count: 3 },
	},
});

test("the cleanup deletes IndexNow and Bing's settings, state and task once, and leaves the rest", async () => {
	const ctx = fakeCtx(leftovers());
	await retireIndexNow(ctx);
	assert.deepEqual([...ctx.settingsMap.keys()].sort(), ["discoverySettings", "features"]);
	assert.deepEqual([...ctx.kvMap.keys()].sort(), ["cache:discovery:llms", "state:discovery:indexnowRetired"]);
	assert.deepEqual(ctx.cancelled, [RETIRED_BING_TASK]);
	assert.ok(ctx.logs.some((l) => l.level === "info" && /removed IndexNow and Bing/.test(l.message)));
	// Once: the marker stops it.
	ctx.settingsMap.set("discoveryIndexnowKey", "x");
	await retireIndexNow(ctx);
	assert.equal(ctx.settingsMap.get("discoveryIndexnowKey"), "x");
	assert.deepEqual(ctx.cancelled, [RETIRED_BING_TASK]);
});

test("a cleanup step that fails is logged, the rest still runs, and it's tried again next time", async () => {
	const ctx = fakeCtx({ ...leftovers(), failDelete: "discoveryBingApiKey" });
	await retireIndexNow(ctx);
	assert.ok(ctx.settingsMap.has("discoveryBingApiKey"));
	assert.equal(ctx.kvMap.has("state:discovery:bingPending"), false, "the other steps ran");
	assert.equal(ctx.kvMap.has("state:discovery:indexnowRetired"), false, "no marker");
	assert.ok(ctx.logs.some((l) => l.level === "warn" && /setting discoveryBingApiKey/.test(l.message)));
	const retry = { ...ctx, settings: { ...ctx.settings, delete: async (k) => ctx.settingsMap.delete(k) } };
	await retireIndexNow(retry);
	assert.equal(ctx.settingsMap.has("discoveryBingApiKey"), false);
	assert.equal(ctx.kvMap.get("state:discovery:indexnowRetired"), true);
});

test("the old daily task runs the cleanup when it fires, whatever the switches say; opening Discovery runs it too", async () => {
	const { hooks } = composeHooks([pack], { tasks: [] });
	const ctx = fakeCtx({ ...leftovers(), features: { discovery: false } });
	await hooks.cron.handler({ name: RETIRED_BING_TASK }, ctx);
	assert.deepEqual(ctx.cancelled, [RETIRED_BING_TASK, RETIRED_BING_TASK], "cancelled by the cleanup, then by the task itself (harmless twice)");
	assert.equal(ctx.settingsMap.has("discoveryBingApiKey"), false);
	// An unknown task still does nothing.
	await hooks.cron.handler({ name: "no-such-task" }, fakeCtx());
	// Cleaned up before (from a context without cron access): the task still cancels itself when it fires.
	const earlier = fakeCtx(leftovers());
	const { cron } = earlier;
	delete earlier.cron;
	await retireIndexNow(earlier);
	assert.equal(earlier.kvMap.get("state:discovery:indexnowRetired"), true);
	earlier.cron = cron;
	await hooks.cron.handler({ name: RETIRED_BING_TASK }, earlier);
	assert.deepEqual(earlier.cancelled, [RETIRED_BING_TASK]);

	const opened = fakeCtx(leftovers());
	const status = await pack.routes["discovery/status"].handler(opened);
	assert.equal(opened.settingsMap.has("discoveryBingApiKey"), false);
	assert.deepEqual(Object.keys(status).sort(), ["cache", "collections", "features", "settings", "urls"]);
	assert.equal(status.settings.indexnow, undefined, "the old settings part is dropped");
	assert.deepEqual(status.features, { news: false, llms: false, feed: false });
});

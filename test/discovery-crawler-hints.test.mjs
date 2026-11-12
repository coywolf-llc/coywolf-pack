// Discovery → Crawler Hints (0.35.18): reading Cloudflare's setting for the site's zone with the
// read-only token, what the card says when it can't, the route, and the cleanup of IndexNow and
// Bing submission, which it replaced.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { crawlerHintsDashboardUrl, readCrawlerHints, zoneCandidates } = await import("../src/discovery/crawler-hints.ts");
const { DEADLINES } = await import("../src/core/single-flight.ts");
const { discoveryPack, discoveryMiddleware } = await import("../src/discovery/pack.ts");
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
	assert.match(status.problem.message, /Add the Cloudflare API token on the plugin's Settings page/);
	assert.match(status.problem.message, /Here it needs Zone → Read\./);
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
	assert.match(status.problem.message, /can't see a zone for coywolf\.com\. Add Zone → Read to it, for this site's domain/);
	const refused = cloudflare({ onZones: () => fail(403, 9109, "Unauthorized to access requested resource") });
	const r = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: refused.fetch });
	assert.equal(r.problem.kind, "no-zone");
	assert.match(r.problem.message, /can't list zones \(HTTP 403: Unauthorized to access requested resource \(code 9109\)\)\. Add Zone → Read/);
});

test("a token Cloudflare doesn't accept (malformed, deleted, expired) says so, not that a permission is missing", async () => {
	// Cloudflare's own answers (checked November 2026 with made-up tokens).
	const malformed = cloudflare({
		onZones: () =>
			Response.json({ success: false, errors: [{ code: 6003, message: "Invalid request headers", error_chain: [{ code: 6111, message: "Invalid format for Authorization header" }] }], messages: [], result: null }, { status: 400 }),
	});
	const m = await readCrawlerHints("coywolf.com", { token: "not a token", fetch: malformed.fetch });
	assert.equal(m.problem.kind, "bad-token");
	assert.match(m.problem.message, /doesn't accept the Cloudflare API token \(HTTP 400: Invalid format for Authorization header \(code 6111\)\)/);
	const unknown = cloudflare({ onZones: () => fail(403, 9109, "Invalid access token") });
	const u = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: unknown.fetch });
	assert.equal(u.problem.kind, "bad-token");
	assert.match(u.problem.message, /mistyped, deleted or expired/);
	assert.ok(!u.problem.message.includes(TOKEN));
	// A token revoked after its zone was remembered.
	const later = cloudflare({ onFlags: () => fail(403, 9109, "Invalid access token") });
	const l = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: later.fetch, knownZone: { id: "zone-c", name: "coywolf.com", accountId: ACCOUNT } });
	assert.equal(l.problem.kind, "bad-token");
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
		let signal;
		const stalled = await readCrawlerHints("coywolf.com", {
			token: TOKEN,
			fetch: (_url, init) => {
				signal = init.signal;
				return new Promise(() => {});
			},
		});
		assert.equal(stalled.problem.kind, "error");
		assert.match(stalled.problem.message, /took longer than 20 ms/);
		assert.ok(Date.now() - started < 1000);
		assert.equal(signal.aborted, true, "the stalled call is aborted");
		// A body that never finishes counts too.
		const slowBody = await readCrawlerHints("coywolf.com", { token: TOKEN, fetch: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) });
		assert.match(slowBody.problem.message, /took longer than 20 ms/);
	} finally {
		DEADLINES.cloudflareReadMs = before;
	}
});

// ── The module: route, pack, cleanup ─────────────────────────────

function fakeCtx({ features = { discovery: true }, settings: initial = {}, kv: initialKv = {}, fetch, failDelete, unreadable } = {}) {
	const settings = new Map([["features", features], ...Object.entries(initial)]);
	const kv = new Map(Object.entries(initialKv));
	const cancelled = [];
	const logs = [];
	const log = (level) => (message, data) => logs.push({ level, message, data });
	return {
		site: { url: "https://coywolf.com/", name: "Coywolf" },
		settings: {
			get: async (k) => {
				if (unreadable === k) throw Object.assign(new Error("Plugin secret setting was encrypted with an unavailable key"), { name: "PluginSettingEncryptionError" });
				return settings.get(k) ?? null;
			},
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
	assert.deepEqual(pack.features.map((f) => f.id), ["discovery", "discovery.newsSitemap", "discovery.feed", "discovery.llms", "discovery.securityTxt"]);
	assert.deepEqual(pack.allowedHosts, ["api.cloudflare.com"]);
	for (const name of ["discovery/public/key", "discovery/regenerate-key", "discovery/submit", "discovery/bing-key", "discovery/bing-check"]) assert.equal(pack.routes[name], undefined, name);
	assert.equal(pack.tasks.length, 0);
	assert.equal(pack.retiredTasks, undefined, "the old daily task's clean-up was removed in 0.38.0");
	assert.equal(SECRET_SETTINGS.discoveryBingApiKey, undefined);
	assert.equal(GUIDES.bing, undefined);
	assert.match(GUIDES["crawler-hints-token"].steps.join(" "), /Here it needs <strong[^>]*>Zone → Read<\/strong>\./);
	assert.deepEqual(discoveryMiddleware.map((m) => m.feature), ["discovery.newsSitemap", "discovery.feed", "discovery.llms", "discovery.securityTxt"]);
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

test("the Cloudflare API token wins over the older usage token; the older one still works alone", async () => {
	const zones = { zones: { "coywolf.com": "zone-c" }, flags: { "zone-c": true } };
	const both = cloudflare(zones);
	await pack.routes["discovery/crawler-hints"].handler(fakeCtx({ settings: { cloudflareApiToken: "cf-new-token-0123456789", usageApiToken: TOKEN }, fetch: both.fetch }));
	assert.deepEqual([...new Set(both.calls.map((c) => c.auth))], ["Bearer cf-new-token-0123456789"]);
	const older = cloudflare(zones);
	assert.equal((await pack.routes["discovery/crawler-hints"].handler(fakeCtx({ settings: { usageApiToken: TOKEN }, fetch: older.fetch }))).enabled, true);
	assert.deepEqual([...new Set(older.calls.map((c) => c.auth))], [`Bearer ${TOKEN}`]);
	// A message names the token that was used, so it never sends you to fix the other one.
	const blind = await pack.routes["discovery/crawler-hints"].handler(fakeCtx({ settings: { usageApiToken: TOKEN }, fetch: cloudflare().fetch }));
	assert.match(blind.problem.message, /^The older Cloudflare usage token can't see a zone for coywolf\.com/);
	const blindNew = await pack.routes["discovery/crawler-hints"].handler(fakeCtx({ settings: { cloudflareApiToken: TOKEN }, fetch: cloudflare().fetch }));
	assert.match(blindNew.problem.message, /^The Cloudflare API token can't see a zone/);
});

test("a remembered zone that stopped working is looked up again, once, and replaced", async () => {
	// The zone was deleted and added again in Cloudflare: a new id for the same name.
	const cf = cloudflare({ zones: { "coywolf.com": "zone-new" }, onFlags: (id) => (id === "zone-new" ? ok({ cache: { crawlhints_enabled: true } }) : fail(404, 7003, "Could not route to /zones/zone-old/flags")) });
	const ctx = fakeCtx({ settings: { usageApiToken: TOKEN }, fetch: cf.fetch, kv: { "state:discovery:crawlerHintsZone": { host: "coywolf.com", zone: { id: "zone-old", name: "coywolf.com", accountId: ACCOUNT } } } });
	const status = await pack.routes["discovery/crawler-hints"].handler(ctx);
	assert.equal(status.enabled, true);
	assert.deepEqual(cf.calls.map((c) => c.url), [`${API}/zones/zone-old/flags`, `${API}/zones?name=coywolf.com&per_page=5`, `${API}/zones/zone-new/flags`]);
	assert.equal(ctx.kvMap.get("state:discovery:crawlerHintsZone").zone.id, "zone-new");
	// A token Cloudflare rejects isn't a stale zone: no second lookup.
	const revoked = cloudflare({ onFlags: () => fail(403, 9109, "Invalid access token") });
	const r = fakeCtx({ settings: { usageApiToken: TOKEN }, fetch: revoked.fetch, kv: { "state:discovery:crawlerHintsZone": { host: "coywolf.com", zone: { id: "zone-c", name: "coywolf.com", accountId: ACCOUNT } } } });
	assert.equal((await pack.routes["discovery/crawler-hints"].handler(r)).problem.kind, "bad-token");
	assert.equal(revoked.calls.length, 1);
});

test("a saved token that can't be decrypted says so, instead of asking for a token", async () => {
	const ctx = fakeCtx({ unreadable: "usageApiToken", fetch: async () => assert.fail("nothing is fetched") });
	const status = await pack.routes["discovery/crawler-hints"].handler(ctx);
	assert.equal(status.problem.kind, "bad-token");
	assert.match(status.problem.message, /can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed/);
});

test("the route without a token, and with Discovery off", async () => {
	const ctx = fakeCtx({ fetch: async () => assert.fail("nothing is fetched") });
	const status = await pack.routes["discovery/crawler-hints"].handler(ctx);
	assert.equal(status.problem.kind, "no-token");
	assert.equal(ctx.kvMap.has("state:discovery:crawlerHintsZone"), false);
	await assert.rejects(pack.routes["discovery/crawler-hints"].handler(fakeCtx({ features: { discovery: false }, settings: { usageApiToken: TOKEN } })));
});

test("the Discovery page answers with its status (IndexNow and Bing's clean-up, 0.35.18–0.37.x, is gone)", async () => {
	const status = await pack.routes["discovery/status"].handler(fakeCtx({ settings: { discoverySettings: { news: { collections: ["posts"] } } } }));
	assert.deepEqual(Object.keys(status).sort(), ["cache", "collections", "features", "origin", "settings", "urls"]);
	assert.equal(status.settings.indexnow, undefined, "the old settings part is dropped");
	assert.deepEqual(status.features, { news: false, llms: false, feed: false, securityTxt: false });
	assert.equal(pack.hooks["plugin:activate"], undefined, "Discovery has nothing to do at activation");
});

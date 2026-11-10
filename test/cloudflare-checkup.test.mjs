// Run: node --test test/cloudflare-checkup.test.mjs
//
// Cloudflare Checkup (src/cloudflare/): the rows made from a zone's settings, what's read with
// which permission, and the one-click fixes: one zone setting each, only when needed, never HSTS,
// never with the token in an error. Cloudflare's API is a stand-in: nothing here calls it.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { FIXES, checkupRows, dashboardUrl, otherHostnames, tlsAtLeast } = await import("../src/cloudflare/checkup-core.ts");
const { applyFix, readCheckup } = await import("../src/cloudflare/zone.ts");
const { cloudflarePack } = await import("../src/cloudflare/pack.ts");
const { SIDEBAR_FOLDERS } = await import("../src/core/sidebar.ts");
const routes = await import("../src/core/routes.ts");

const TOKEN = "cf-test-token-0123456789";
const ZONE = { id: "zone-1", name: "recollect.fyi", accountId: "acc-1" };

const SETTINGS = {
	speed_brain: "on",
	early_hints: "off",
	http3: "on",
	always_use_https: "off",
	min_tls_version: "1.0",
	tls_1_3: "zrt",
	security_header: { strict_transport_security: { enabled: false, max_age: 0, include_subdomains: false, preload: false } },
	rocket_loader: "on",
	email_obfuscation: "on",
	automatic_https_rewrites: "on",
};

/** Cloudflare's API, answering from `state`; records every call. `deny` lists path prefixes answered 403. */
function cloudflare(state = {}) {
	const calls = [];
	const settings = { ...SETTINGS, ...(state.settings ?? {}) };
	const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const ok = (result) => respond(200, { success: true, errors: [], result });
	const fetch = async (url, init = {}) => {
		const u = new URL(url);
		const path = u.pathname.replace("/client/v4", "");
		const method = init.method ?? "GET";
		calls.push({ method, path, search: u.search, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
		if ((state.deny ?? []).some((p) => path.startsWith(p))) return respond(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
		if (path === "/zones") return ok(u.searchParams.get("name") === "recollect.fyi" ? [{ id: ZONE.id, name: ZONE.name, account: { id: ZONE.accountId } }] : []);
		if (path === `/zones/${ZONE.id}/flags`) return ok({ cache: { crawlhints_enabled: state.crawlHints ?? true } });
		if (path === `/zones/${ZONE.id}/settings` && method === "GET") {
			// The bulk read leaves speed_brain out, as an older answer would: it's read on its own.
			return ok(Object.entries(settings).filter(([id]) => id !== "speed_brain").map(([id, value]) => ({ id, value, editable: true })));
		}
		const one = path.match(/^\/zones\/zone-1\/settings\/([a-z0-9_]+)$/);
		if (one && method === "GET") return ok({ id: one[1], value: settings[one[1]] });
		if (one && method === "PATCH") {
			settings[one[1]] = JSON.parse(init.body).value;
			return ok({ id: one[1], value: state.patchAnswer ?? settings[one[1]] });
		}
		if (path === `/zones/${ZONE.id}/bot_management`) return ok(state.bots ?? { fight_mode: true, ai_bots_protection: "block", is_robots_txt_managed: true, crawler_protection: "enabled" });
		if (path === `/zones/${ZONE.id}/dns_records`) {
			return ok([
				{ name: "recollect.fyi", type: "AAAA", proxied: true },
				{ name: "app.recollect.fyi", type: "CNAME", proxied: true },
				{ name: "mail.recollect.fyi", type: "A", proxied: false },
				{ name: "recollect.fyi", type: "TXT", proxied: false },
			]);
		}
		return respond(404, { success: false, errors: [{ code: 7003, message: "No route" }] });
	};
	return { fetch, calls, settings };
}

const local = { trackingWrapper: false, speculationOn: false, robotsOn: true };

test("off by default, its page in the Coywolf Pack folder", () => {
	const pack = cloudflarePack();
	assert.deepEqual(pack.features.map((f) => [f.id, f.default]), [["cloudflareCheckup", false]]);
	assert.deepEqual(pack.adminPages, [{ path: "/cloudflare", label: "Cloudflare Checkup", icon: "cloud-check" }]);
	assert.ok(SIDEBAR_FOLDERS[0].pages.includes("/cloudflare"));
	assert.deepEqual(pack.allowedHosts, ["api.cloudflare.com"]);
	// Fixes and the token save change no page: they clear no cache (src/core/routes.ts).
	const { isReadOnlyRoute } = routes;
	assert.equal(isReadOnlyRoute(pack.routes["cloudflare/fix"]), true);
	assert.equal(isReadOnlyRoute(pack.routes["cloudflare/token/save"]), true);
	assert.equal(pack.routes["cloudflare/checkup"].methods, undefined, "the checkup is a GET");
});

test("the fixes: Speed Brain off, Always Use HTTPS on, TLS 1.2; never HSTS", () => {
	assert.deepEqual(Object.keys(FIXES).sort(), ["always-use-https-on", "min-tls-1.2", "speed-brain-off"]);
	assert.deepEqual(Object.values(FIXES).map((f) => [f.setting, f.target]), [["speed_brain", "off"], ["always_use_https", "on"], ["min_tls_version", "1.2"]]);
	assert.ok(!Object.values(FIXES).some((f) => f.setting === "security_header"));
	// Idempotent: each knows when there's nothing to do.
	assert.equal(FIXES["speed-brain-off"].needed("off"), false);
	assert.equal(FIXES["always-use-https-on"].needed("on"), false);
	for (const v of ["1.2", "1.3"]) assert.equal(FIXES["min-tls-1.2"].needed(v), false, v);
	for (const v of ["1.0", "1.1", undefined]) assert.equal(FIXES["min-tls-1.2"].needed(v), true, String(v));
	assert.equal(tlsAtLeast("1.3", "1.2"), true);
	assert.equal(tlsAtLeast("bogus", "1.2"), false);
});

test("rows from a zone that needs work: what's flagged, what's offered, what's only explained", () => {
	const rows = checkupRows({ zone: ZONE, settings: new Map(Object.entries(SETTINGS)), bots: { fight_mode: true, ai_bots_protection: "block", is_robots_txt_managed: true }, crawlerHints: false, ...local });
	const row = (id) => rows.find((r) => r.id === id);
	assert.deepEqual([row("speed_brain").status, row("speed_brain").fix], ["warn", "speed-brain-off"]);
	assert.deepEqual([row("always_use_https").status, row("always_use_https").fix], ["warn", "always-use-https-on"]);
	assert.deepEqual([row("min_tls_version").status, row("min_tls_version").fix, row("min_tls_version").value], ["warn", "min-tls-1.2", "TLS 1.0"]);
	assert.equal(row("hsts").status, "info");
	assert.equal(row("hsts").fix, undefined, "HSTS is never one click");
	assert.match(row("hsts").caution, /Hard to undo/);
	assert.equal(row("tls_1_3").status, "good");
	assert.equal(row("rocket_loader").status, "warn");
	assert.equal(row("crawler_hints").status, "warn");
	assert.match(row("crawler_hints").recommendation, /dashboard/);
	assert.equal(row("bot_fight_mode").status, "warn");
	assert.equal(row("ai_bots").status, "warn", "blocks AI bots while Robots.txt Rules decides too");
	assert.equal(row("managed_robots").status, "warn");
	assert.equal(row("tracking_params").status, "info");
	assert.equal(row("tracking_params").zoneWide, false);
	for (const r of rows.filter((r) => r.id !== "tracking_params")) {
		assert.equal(r.zoneWide, true, r.id);
		assert.ok(r.dashboardUrl.startsWith("https://dash.cloudflare.com/acc-1/recollect.fyi/"), r.id);
	}
	// Every row explains itself and says what to do.
	for (const r of rows) assert.ok(r.explanation.length > 20 && r.recommendation.length > 5, r.id);
});

test("rows from a zone in good shape offer no fixes", () => {
	const good = { ...SETTINGS, speed_brain: "off", always_use_https: "on", min_tls_version: "1.2", rocket_loader: "off", email_obfuscation: "off", security_header: { strict_transport_security: { enabled: true, max_age: 31536000, include_subdomains: false } } };
	const rows = checkupRows({
		zone: ZONE,
		settings: new Map(Object.entries(good)),
		bots: { fight_mode: false },
		crawlerHints: true,
		trackingWrapper: true,
		trackingState: { at: "2026-11-10T09:00:00.000Z", loopback: true, status: 200, cache: "HIT" },
		speculationOn: true,
		robotsOn: false,
	});
	assert.deepEqual(rows.filter((r) => r.fix).map((r) => r.id), []);
	assert.deepEqual(rows.filter((r) => r.status === "warn").map((r) => r.id), []);
	assert.equal(rows.find((r) => r.id === "hsts").value, "On, 1 year");
	assert.equal(rows.find((r) => r.id === "tracking_params").status, "good");
	assert.match(rows.find((r) => r.id === "speed_brain").recommendation, /Speculation Rules does the prefetching/);
});

test("the tracking row says 'Removed before the cache' only once a tracked visit came from the cache", async () => {
	const { trackingRow } = await import("../src/cloudflare/checkup-core.ts");
	const at = "2026-11-10T09:00:00.000Z";
	assert.deepEqual([trackingRow(false, null).status, trackingRow(false, null).guide], ["info", "tracking-params"]);
	assert.match(trackingRow(true, null).value, /waiting for the first tracked visit/);
	assert.equal(trackingRow(true, null).guide, undefined);
	const noLoop = trackingRow(true, { at, loopback: false });
	assert.deepEqual([noLoop.status, noLoop.value], ["warn", "Installed, but the Worker can't call itself"]);
	assert.match(noLoop.recommendation, /2025-11-17|SELF/);
	const miss = trackingRow(true, { at, loopback: true, status: 200, cache: "MISS" });
	assert.deepEqual([miss.status, miss.value], ["info", "Installed, no cache hit seen yet"]);
	assert.equal(trackingRow(true, { at, loopback: true, status: 200, cache: null }).value, "Installed, no cache hit seen yet");
	const hit = trackingRow(true, { at, loopback: true, status: 200, cache: "HIT" });
	assert.deepEqual([hit.status, hit.value], ["good", "Removed before the cache"]);
	assert.match(hit.recommendation, /2026-11-10 09:00 UTC/);
	// In the rows, wrapped without a record is not "good".
	const rows = checkupRows({ zone: ZONE, settings: new Map(Object.entries(SETTINGS)), bots: {}, crawlerHints: true, trackingWrapper: true, trackingState: null, speculationOn: false, robotsOn: false });
	assert.equal(rows.find((r) => r.id === "tracking_params").status, "info");
});

test("a bulk settings read that fails for another reason than permissions falls back to one read per setting", async () => {
	const cf = cloudflare();
	const flaky = async (url, init) => (new URL(url).pathname.endsWith("/zones/zone-1/settings") ? new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "Internal" }] }), { status: 500 }) : cf.fetch(url, init));
	const result = await readCheckup("recollect.fyi", { token: TOKEN, fetch: flaky, ...local });
	assert.equal(result.problem, undefined);
	assert.equal(result.rows.find((r) => r.id === "always_use_https").value, "Off");
	assert.equal(result.rows.find((r) => r.id === "speed_brain").value, "On");
	// Nothing at all could be read: one problem, not a row per setting.
	const down = async (url, init) => (/\/zones\/zone-1\/settings/.test(new URL(url).pathname) ? new Response("{}", { status: 503 }) : cf.fetch(url, init));
	const none = await readCheckup("recollect.fyi", { token: TOKEN, fetch: down, ...local });
	assert.equal(none.problem.kind, "error");
	assert.match(none.problem.message, /Couldn't read the zone's settings/);
});

test("a zone with more proxied records than one page says so", async () => {
	const cf = cloudflare();
	const many = async (url, init) => {
		if (new URL(url).pathname.endsWith("/dns_records")) {
			const records = Array.from({ length: 500 }, (_, i) => ({ name: `h${i}.recollect.fyi`, type: "CNAME", proxied: true }));
			return new Response(JSON.stringify({ success: true, errors: [], result: records }), { headers: { "content-type": "application/json" } });
		}
		return cf.fetch(url, init);
	};
	const result = await readCheckup("recollect.fyi", { token: TOKEN, fetch: many, ...local });
	assert.equal(result.otherHostsMore, true);
	assert.equal(result.otherHosts.length, 500);
	assert.equal((await readCheckup("recollect.fyi", { token: TOKEN, fetch: cf.fetch, ...local })).otherHostsMore, undefined);
});

test("dashboard links and the zone's other hostnames", () => {
	assert.equal(dashboardUrl(null, "speed/optimization"), "https://dash.cloudflare.com/?to=/:account/:zone/speed/optimization");
	assert.equal(dashboardUrl(ZONE, "ssl-tls/edge-certificates"), "https://dash.cloudflare.com/acc-1/recollect.fyi/ssl-tls/edge-certificates");
	assert.deepEqual(otherHostnames([{ name: "A.example.com", type: "CNAME", proxied: true }, { name: "example.com", type: "A", proxied: true }, { name: "b.example.com", type: "MX", proxied: true }, { name: "a.example.com", type: "AAAA", proxied: true }], "example.com"), ["a.example.com"]);
});

test("reading: the zone, every setting (one by one for any the bulk read left out), the bots and the other hostnames", async () => {
	const cf = cloudflare();
	const result = await readCheckup("recollect.fyi", { token: TOKEN, fetch: cf.fetch, ...local });
	assert.equal(result.problem, undefined);
	assert.deepEqual(result.zone, ZONE);
	assert.deepEqual(result.otherHosts, ["app.recollect.fyi"]);
	assert.equal(result.rows.find((r) => r.id === "speed_brain").value, "On", "read on its own");
	assert.equal(result.rows.find((r) => r.id === "bot_fight_mode").value, "On");
	assert.ok(cf.calls.every((c) => c.method === "GET"), "reading changes nothing");
	assert.ok(cf.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
	assert.ok(cf.calls.some((c) => c.path === "/zones/zone-1/settings/speed_brain"));
});

test("reading with missing permissions: each part says which one to add", async () => {
	const cf = cloudflare({ deny: ["/zones/zone-1/bot_management", "/zones/zone-1/dns_records"] });
	const partial = await readCheckup("recollect.fyi", { token: TOKEN, fetch: cf.fetch, ...local });
	assert.equal(partial.problem, undefined);
	assert.equal(partial.otherHosts, null);
	assert.match(partial.otherHostsProblem, /DNS → Edit \(or Read\) to the Cloudflare API token/);
	assert.equal(partial.rows.find((r) => r.id === "bot_fight_mode").status, "unknown");
	assert.match(partial.rows.find((r) => r.id === "bot_fight_mode").recommendation, /Bot Management → Read/);

	const noSettings = await readCheckup("recollect.fyi", { token: TOKEN, fetch: cloudflare({ deny: ["/zones/zone-1/settings"] }).fetch, ...local });
	assert.equal(noSettings.problem.kind, "no-access");
	assert.match(noSettings.problem.message, /Cloudflare API token can't read this zone's settings\. Add Zone Settings → Edit/);
	assert.equal(noSettings.rows.find((r) => r.id === "speed_brain").status, "unknown");

	const none = await readCheckup("recollect.fyi", { token: null, fetch: cloudflare().fetch, ...local });
	assert.equal(none.problem.kind, "no-token");
	assert.deepEqual(none.rows.map((r) => r.id), ["tracking_params"], "only what needs no token");

	const elsewhere = await readCheckup("other.example", { token: TOKEN, fetch: cloudflare().fetch, ...local });
	assert.equal(elsewhere.problem.kind, "no-zone");
});

test("a fix changes one setting, once; a second press changes nothing", async () => {
	const cf = cloudflare();
	const first = await applyFix("speed-brain-off", ZONE, { token: TOKEN, fetch: cf.fetch });
	assert.deepEqual([first.changed, first.before, first.after, first.setting], [true, "on", "off", "speed_brain"]);
	assert.match(first.message, /from on to off on recollect\.fyi/);
	const writes = cf.calls.filter((c) => c.method !== "GET");
	assert.deepEqual(writes.map((c) => [c.method, c.path, c.body]), [["PATCH", "/zones/zone-1/settings/speed_brain", { value: "off" }]]);
	const again = await applyFix("speed-brain-off", ZONE, { token: TOKEN, fetch: cf.fetch });
	assert.equal(again.changed, false);
	assert.match(again.message, /Nothing to change/);
	assert.equal(cf.calls.filter((c) => c.method !== "GET").length, 1, "no second write");

	// TLS: only ever raised to 1.2, never lowered from 1.3.
	const tls = cloudflare({ settings: { min_tls_version: "1.3" } });
	assert.equal((await applyFix("min-tls-1.2", ZONE, { token: TOKEN, fetch: tls.fetch })).changed, false);
	assert.equal(tls.calls.filter((c) => c.method !== "GET").length, 0);
});

test("the fix route: a typed token, else the Cloudflare API token, else the older setup token; the checkup tells the page which", async () => {
	const pack = cloudflarePack();
	const ctx = (settings, cf) => {
		const stored = new Map([["features", { cloudflareCheckup: true }], ...Object.entries(settings)]);
		const kv = new Map();
		return {
			site: { url: "https://recollect.fyi/", name: "Recollect" },
			settings: { get: async (k) => stored.get(k) ?? null, set: async (k, v) => void stored.set(k, v), delete: async (k) => void stored.delete(k) },
			kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
			http: { fetch: cf.fetch },
			log: { info() {}, warn() {}, error() {} },
		};
	};
	const fix = async (settings, token) => {
		const cf = cloudflare();
		await pack.routes["cloudflare/fix"].handler({ ...ctx(settings, cf), input: { fix: "speed-brain-off", ...(token ? { token } : {}) } });
		return [...new Set(cf.calls.map((c) => c.auth))];
	};
	assert.deepEqual(await fix({ cloudflareApiToken: "new-token", cloudflareSetupToken: "setup-token" }), ["Bearer new-token"]);
	assert.deepEqual(await fix({ cloudflareApiToken: "new-token", cloudflareSetupToken: "setup-token" }, "typed-token"), ["Bearer typed-token"]);
	assert.deepEqual(await fix({ cloudflareSetupToken: "setup-token" }), ["Bearer setup-token"], "the older setup token still works alone");
	await assert.rejects(fix({}), /Add the Cloudflare API token on the plugin's Settings page.*Zone Settings → Edit/);

	const page = async (settings) => (await pack.routes["cloudflare/checkup"].handler(ctx(settings, cloudflare()))).sharedToken;
	assert.equal(await page({ cloudflareApiToken: "new-token", cloudflareSetupToken: "setup-token" }), true, "the page hides the setup token");
	assert.equal(await page({ cloudflareSetupToken: "setup-token", usageApiToken: TOKEN }), false);
});

test("a refused fix reports what the token needs, without the token", async () => {
	const cf = cloudflare({ deny: ["/zones/zone-1/settings/always_use_https"] });
	await assert.rejects(applyFix("always-use-https-on", ZONE, { token: TOKEN, fetch: cf.fetch }), (error) => {
		assert.match(error.message, /Zone Settings → Edit/);
		assert.ok(!error.message.includes(TOKEN));
		return true;
	});
	// Cloudflare says yes but reports another value: not reported as done.
	await assert.rejects(applyFix("always-use-https-on", ZONE, { token: TOKEN, fetch: cloudflare({ patchAnswer: "off" }).fetch }), /reports always_use_https as off/);
});

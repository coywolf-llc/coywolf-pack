// Run: node --test test/insights-reports.test.mjs
//
// Insights' external reports: the parsers (Cloudflare HTTP analytics and Web Analytics, Fathom, Search Console),
// the beacon loader, Google's service-account JWT, the KV cache, and each report end to end against a fake
// provider (no real network, no real credentials).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

import "./ts-resolve.mjs";

const E = await import("../src/insights/edge-core.ts");
const V = await import("../src/insights/vitals-core.ts");
const Fa = await import("../src/insights/fathom-core.ts");
const G = await import("../src/insights/gsc-core.ts");
const { cachedReport, forgetReport, fingerprintOf } = await import("../src/insights/report-cache.ts");
const { sharedSlot } = await import("../src/core/single-flight.ts");
const { baselineBots } = await import("../src/robots/directory.ts");
const { redirectPrefillHref, readRedirectPrefill } = await import("../src/admin/redirect-prefill.ts");

const kvStore = () => {
	const map = new Map();
	return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, structuredClone(v)), delete: async (k) => map.delete(k) };
};

// ── Edge errors and crawlers ─────────────────────────────────────

test("dataset settings: limits and available fields, matched by name or path", () => {
	const body = { data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: { enabled: true, maxDuration: 2_678_400, notOlderThan: "2764800", availableFields: ["count", "dimensions_userAgent", "dimensions_verifiedBotCategory"] } } }] } } };
	const limits = E.parseDatasetSettings(body, E.EDGE_DATASET);
	assert.deepEqual(limits, { enabled: true, maxDurationS: 2_678_400, notOlderThanS: 2_764_800, fields: ["count", "dimensions_userAgent", "dimensions_verifiedBotCategory"] });
	assert.equal(E.fieldAvailable(limits, "verifiedBotCategory"), true);
	assert.equal(E.fieldAvailable(limits, "botScore"), false);
	assert.equal(E.fieldAvailable(null, "verifiedBotCategory"), false, "unknown: only the base fields");
	assert.equal(E.parseDatasetSettings({ data: null }, E.EDGE_DATASET), null);
});

test("the window: 30 days, or less when the zone allows less", () => {
	const now = Date.UTC(2026, 10, 10);
	assert.equal(E.reportWindow(null, now).days, 30);
	const short = E.reportWindow({ enabled: true, maxDurationS: 8 * 86400, notOlderThanS: 31 * 86400, fields: null }, now);
	assert.equal(short.days, 8);
	assert.ok(Date.parse(short.end) - Date.parse(short.start) < 8 * 86_400_000);
	assert.equal(short.end, new Date(now).toISOString());
});

test("the query asks for verifiedBotCategory only when the zone can query it, eyeball requests only", () => {
	assert.doesNotMatch(E.edgeQuery({ verifiedBotCategory: false }), /verifiedBotCategory/);
	const q = E.edgeQuery({ verifiedBotCategory: true });
	assert.match(q, /userAgent verifiedBotCategory/);
	assert.equal(q.match(/requestSource: "eyeball"/g)?.length, 6);
	assert.match(q, /edgeResponseStatus_geq: 404, edgeResponseStatus_lt: 405/);
	assert.match(q, /edgeResponseStatus_geq: 500, edgeResponseStatus_lt: 600/);
});

test("crawler patterns from the bundled directory name real crawlers and never browsers", async () => {
	const patterns = E.crawlerPatterns(await baselineBots());
	assert.ok(patterns.length > 100);
	const name = (ua) => E.matchCrawler(ua, patterns)?.name ?? null;
	assert.match(name("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), /Googlebot/i);
	assert.match(name("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"), /GPTBot/i);
	assert.match(name("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"), /bing/i);
	assert.equal(name("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"), null);
	assert.equal(name("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), null);
	// The longest match wins.
	const two = [{ name: "Applebot", category: "SEARCH_ENGINE_CRAWLER", needles: ["applebot"] }, { name: "Applebot-Extended", category: "AI_CRAWLER", needles: ["applebot-extended"] }];
	assert.equal(E.matchCrawler("Mozilla/5.0 (compatible; Applebot-Extended/0.1)", two).name, "Applebot-Extended");
});

const zone = {
	hosts: [
		{ count: 9000, dimensions: { clientRequestHTTPHost: "example.com" } },
		{ count: 1000, dimensions: { clientRequestHTTPHost: "media.example.com" } },
		{ count: 5000, dimensions: { clientRequestHTTPHost: "mail.example.com" } },
	],
	statuses: [
		{ count: 120, dimensions: { clientRequestHTTPHost: "example.com", edgeResponseStatus: 404 } },
		{ count: 30, dimensions: { clientRequestHTTPHost: "media.example.com", edgeResponseStatus: 404 } },
		{ count: 4, dimensions: { clientRequestHTTPHost: "example.com", edgeResponseStatus: 410 } },
		{ count: 6, dimensions: { clientRequestHTTPHost: "example.com", edgeResponseStatus: 500 } },
		{ count: 2, dimensions: { clientRequestHTTPHost: "example.com", edgeResponseStatus: 522 } },
		{ count: 999, dimensions: { clientRequestHTTPHost: "mail.example.com", edgeResponseStatus: 503 } },
	],
	notFound: [
		{ count: 80, dimensions: { clientRequestHTTPHost: "example.com", clientRequestPath: "/wp-content/uploads/2019/04/photo.jpg" } },
		{ count: 30, dimensions: { clientRequestHTTPHost: "media.example.com", clientRequestPath: "/old.png" } },
		{ count: 40, dimensions: { clientRequestHTTPHost: "example.com", clientRequestPath: "/old-post/" } },
		{ count: 500, dimensions: { clientRequestHTTPHost: "mail.example.com", clientRequestPath: "/x" } },
	],
	gone: [{ count: 4, dimensions: { clientRequestHTTPHost: "example.com", clientRequestPath: "/removed/" } }],
	serverErrors: [{ count: 6, dimensions: { clientRequestHTTPHost: "example.com", clientRequestPath: "/search", edgeResponseStatus: 500 } }],
	agents: [
		{ count: 300, dimensions: { clientRequestHTTPHost: "example.com", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", verifiedBotCategory: "Search Engine Crawler" } },
		{ count: 200, dimensions: { clientRequestHTTPHost: "example.com", userAgent: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) Chrome/141.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", verifiedBotCategory: "Search Engine Crawler" } },
		{ count: 50, dimensions: { clientRequestHTTPHost: "example.com", userAgent: "SomeNewBot/1.0 (+https://example.org)", verifiedBotCategory: "" } },
		{ count: 5000, dimensions: { clientRequestHTTPHost: "example.com", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36", verifiedBotCategory: "" } },
		{ count: 70, dimensions: { clientRequestHTTPHost: "mail.example.com", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)", verifiedBotCategory: "Search Engine Crawler" } },
	],
};

test("the report: the site's and media host's rows only, 404s and 410s together, 5xx, crawlers by name", () => {
	const crawlers = [{ name: "Googlebot", category: "SEARCH_ENGINE_CRAWLER", needles: ["googlebot"] }];
	const r = E.parseEdgeReport(zone, { host: "Example.com", mediaHost: "media.example.com", crawlers, days: 30 });
	assert.equal(r.requests, 10_000, "mail.example.com isn't the site");
	assert.deepEqual(r.statuses.map((s) => [s.status, s.count]), [[404, 150], [500, 6], [410, 4], [522, 2]]);
	assert.deepEqual(r.notFound.map((p) => [p.host, p.path, p.status, p.count, p.media]), [
		["example.com", "/wp-content/uploads/2019/04/photo.jpg", 404, 80, false],
		["example.com", "/old-post/", 404, 40, false],
		["media.example.com", "/old.png", 404, 30, true],
		["example.com", "/removed/", 410, 4, false],
	]);
	assert.equal(r.serverErrors.count, 8);
	assert.deepEqual(r.serverErrors.paths.map((p) => [p.path, p.status]), [["/search", 500]]);
	assert.deepEqual(r.crawlers, [{ name: "Googlebot", category: "SEARCH_ENGINE_CRAWLER", count: 500 }]);
	assert.equal(r.otherBots, 50);
	assert.deepEqual(r.verifiedCategories, [{ category: "Search Engine Crawler", count: 500 }]);
	// Without the field, no categories at all (not an empty list that looks like "none").
	const plain = E.parseEdgeReport({ agents: [{ count: 1, dimensions: { clientRequestHTTPHost: "example.com", userAgent: "x" } }] }, { host: "example.com", mediaHost: null, crawlers, days: 7 });
	assert.equal(plain.verifiedCategories, null);
	assert.deepEqual(E.parseEdgeReport(null, { host: "example.com", mediaHost: null, crawlers, days: 30 }).notFound, []);
});

test("Create redirect: site paths only, never the media host, EmDash's own routes or /cdn-cgi/", () => {
	assert.equal(E.redirectable({ path: "/old-post/", media: false }), true);
	assert.equal(E.redirectable({ path: "/wp-content/uploads/a.jpg", media: false }), true);
	assert.equal(E.redirectable({ path: "/old.png", media: true }), false);
	assert.equal(E.redirectable({ path: "/_emdash/api/x", media: false }), false);
	assert.equal(E.redirectable({ path: "/cdn-cgi/rum", media: false }), false);
	const href = redirectPrefillHref("/old post?/");
	assert.equal(href, "/_emdash/admin/plugins/coywolf-pack/redirects?source=%2Fold+post%3F%2F");
	assert.equal(readRedirectPrefill(new URL(href, "https://x.test").search), null, "a space isn't a path a 404 can have");
	assert.equal(readRedirectPrefill("?source=%2Fwp-content%2Fuploads%2Fa.jpg"), "/wp-content/uploads/a.jpg");
	assert.equal(readRedirectPrefill('?source="%2Fold"'), "/old", "TanStack's JSON-quoted value");
	assert.equal(readRedirectPrefill("?source=https%3A%2F%2Fevil.test%2F"), null);
	assert.equal(readRedirectPrefill("?source=%2F%2Fevil.test"), null);
	assert.equal(readRedirectPrefill(""), null);
});

// ── Core Web Vitals ──────────────────────────────────────────────

test("vitals: microseconds to milliseconds, -1 means not measured, ratings by web.dev's thresholds", () => {
	const v = V.toVitals({ count: "42", quantiles: { largestContentfulPaintP75: 2_412_345, interactionToNextPaintP75: -1, cumulativeLayoutShiftP75: 0.0834 } });
	assert.deepEqual(v, { count: 42, lcpMs: 2412, inpMs: null, cls: 0.083 });
	assert.equal(V.rate("lcp", 2500), "good");
	assert.equal(V.rate("lcp", 2501), "needs-improvement");
	assert.equal(V.rate("lcp", 4001), "poor");
	assert.equal(V.rate("inp", 200), "good");
	assert.equal(V.rate("cls", 0.26), "poor");
	assert.equal(V.rate("inp", null), null);
	const report = V.parseVitals(
		{
			week: [{ count: 10, quantiles: { largestContentfulPaintP75: 1_800_000, interactionToNextPaintP75: 90_000, cumulativeLayoutShiftP75: 0.01 } }],
			month: [{ count: 50, quantiles: { largestContentfulPaintP75: 2_000_000, interactionToNextPaintP75: 120_000, cumulativeLayoutShiftP75: 0.02 } }],
			pages: [
				{ count: 30, dimensions: { requestPath: "/" }, quantiles: { largestContentfulPaintP75: 1_000_000 } },
				{ count: 12, dimensions: { requestPath: "/slow/" }, quantiles: { largestContentfulPaintP75: 4_500_000 } },
				{ count: 2, dimensions: { requestPath: "/rare/" }, quantiles: { largestContentfulPaintP75: 9_000_000 } },
			],
		},
		{ siteTag: "tag", autoInstall: false },
	);
	assert.equal(report.month.lcpMs, 2000);
	assert.deepEqual(report.slowPages.map((p) => p.path), ["/slow/", "/"], "slowest first, pages with too few views left out");
	assert.match(V.vitalsQuery(), /bot: 0/);
	assert.doesNotMatch(V.vitalsQuery({ botFilter: false }), /bot: 0/);
});

test("the Web Analytics site: by the saved token, else by host or zone", () => {
	const sites = V.parseSites([
		{ site_tag: "t1", site_token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", auto_install: true, ruleset: { zone_name: "other.com" }, rules: [{ host: "other.com" }] },
		{ site_tag: "t2", site_token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", auto_install: false, ruleset: { zone_name: "Example.com" } },
		{ site_token: "no tag" },
	]);
	assert.equal(sites.length, 2);
	assert.equal(V.matchSite(sites, { token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", host: "example.com", zoneNames: ["example.com"] }).tag, "t1");
	assert.equal(V.matchSite(sites, { token: null, host: "www.example.com", zoneNames: ["example.com"] }).tag, "t2");
	assert.equal(V.matchSite(sites, { token: null, host: "nope.test", zoneNames: ["nope.test"] }), null);
});

test("the beacon loader: one beacon per page, as a module, only with a real token", () => {
	assert.equal(V.isBeaconToken("0123456789abcdef0123456789ABCDEF"), true);
	assert.equal(V.isBeaconToken("0123"), false);
	assert.equal(V.isBeaconToken('"><script>'), false);
	assert.throws(() => V.beaconLoader("nope"));
	const code = V.beaconLoader("0123456789abcdef0123456789ABCDEF");
	assert.doesNotMatch(code, /<\/script/i);
	const run = (html) => {
		const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
		window.document.write(html);
		new Function("document", code)(window.document);
		return [...window.document.querySelectorAll('script[src*="cloudflareinsights.com/beacon.min.js"]')];
	};
	const added = run("<!doctype html><html><body><p>Hi</p></body></html>");
	assert.equal(added.length, 1);
	assert.equal(added[0].getAttribute("type"), "module");
	assert.equal(added[0].getAttribute("src"), "https://static.cloudflareinsights.com/beacon.min.js?token=0123456789abcdef0123456789abcdef");
	// The theme's beacon, or the one Cloudflare's automatic setup inserts: no second one.
	assert.equal(run(`<!doctype html><html><body><script defer src="https://static.cloudflareinsights.com/beacon.min.js/v8c78df7" data-cf-beacon='{"token":"x"}'></script></body></html>`).length, 1);
});

// ── Fathom ───────────────────────────────────────────────────────

test("Fathom: site IDs, aggregation URLs, string numbers, and errors in words", () => {
	assert.equal(Fa.normalizeSiteId(" jzzosmvg "), "JZZOSMVG");
	assert.equal(Fa.normalizeSiteId("no spaces please"), null);
	assert.equal(Fa.fathomFrom(Date.UTC(2026, 10, 10, 15), 7), "2026-11-04 00:00:00");
	const url = new URL(Fa.aggregationUrl("JZZOSMVG", { from: "2026-11-04 00:00:00", aggregates: ["pageviews", "uniques"], grouping: "pathname", sort: "pageviews:desc", limit: 10 }));
	assert.equal(url.origin + url.pathname, "https://api.usefathom.com/v1/aggregations");
	assert.deepEqual(Object.fromEntries(url.searchParams), { entity: "pageview", entity_id: "JZZOSMVG", aggregates: "pageviews,uniques", date_from: "2026-11-04 00:00:00", field_grouping: "pathname", sort_by: "pageviews:desc", limit: "10" });
	assert.deepEqual(Fa.fathomTotals([{ visits: "1200", pageviews: "3400" }]), { visitors: 1200, pageviews: 3400 });
	assert.deepEqual(Fa.fathomTotals([]), { visitors: 0, pageviews: 0 });
	assert.deepEqual(Fa.fathomPages([{ pathname: "/b", pageviews: "5", uniques: "4" }, { pathname: "/a", pageviews: "9", uniques: "7" }, { pageviews: "1" }]), [
		{ path: "/a", pageviews: 9, uniques: 7 },
		{ path: "/b", pageviews: 5, uniques: 4 },
	]);
	assert.match(Fa.fathomError(401, { error: "Unauthenticated" }, null, "X"), /doesn't accept the API key/);
	assert.match(Fa.fathomError(429, { message: "Too Many Attempts." }, "30", "X"), /wait 30 seconds/);
	assert.match(Fa.fathomError(400, { error: "This token doesn't have permission to access this endpoint" }, null, "X"), /can't read this site/);
	assert.match(Fa.fathomError(404, {}, null, "JZZOSMVG"), /JZZOSMVG/);
});

// ── Google Search Console ────────────────────────────────────────

async function serviceAccountFile() {
	const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
	const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
	const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
	const file = JSON.stringify({ type: "service_account", project_id: "p", private_key_id: "kid123", private_key: pem, client_email: "pack@p.iam.gserviceaccount.com", client_id: "1", token_uri: "https://oauth2.googleapis.com/token" }, null, 2);
	return { file, publicKey: pair.publicKey, pem };
}

test("the service account key: only the fields the pack needs; errors never repeat what was pasted", async () => {
	const { file, pem } = await serviceAccountFile();
	assert.deepEqual(G.parseServiceAccount(file), { client_email: "pack@p.iam.gserviceaccount.com", private_key: pem, private_key_id: "kid123", project_id: "p" });
	const secretish = "-----BEGIN PRIVATE KEY-----SECRETSTUFF";
	for (const bad of ["not json " + secretish, JSON.stringify({ type: "authorized_user", private_key: secretish }), JSON.stringify({ client_email: "x@y.z" }), JSON.stringify({ private_key: secretish })]) {
		assert.throws(() => G.parseServiceAccount(bad), (error) => !error.message.includes("SECRETSTUFF"));
	}
});

test("the JWT: RS256, Google's audience and the read-only scope, an hour long, and a signature the public key verifies", async () => {
	const { file, publicKey } = await serviceAccountFile();
	const jwt = await G.signServiceJwt(G.parseServiceAccount(file), { scope: G.GSC_SCOPE, nowS: 1_800_000_000 });
	const [h, c, s] = jwt.split(".");
	const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
	assert.deepEqual(decode(h), { alg: "RS256", typ: "JWT", kid: "kid123" });
	assert.deepEqual(decode(c), { iss: "pack@p.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: 1_800_000_000, exp: 1_800_003_600 });
	assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${c}`)));
	const body = new URLSearchParams(G.tokenRequestBody(jwt));
	assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
	assert.equal(body.get("assertion"), jwt);
	await assert.rejects(G.signServiceJwt({ client_email: "a@b.c", private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }, { scope: G.GSC_SCOPE, nowS: 1 }), /couldn't be read/);
});

test("properties, the Pacific Time range, rows, and Google's errors with the step that fixes them", () => {
	assert.equal(G.normalizeProperty("sc-domain:Example.com"), "sc-domain:example.com");
	assert.equal(G.normalizeProperty("example.com"), "sc-domain:example.com");
	assert.equal(G.normalizeProperty("https://example.com"), "https://example.com/");
	assert.equal(G.normalizeProperty("https://example.com/blog/"), "https://example.com/blog/");
	assert.equal(G.normalizeProperty("https://example.com/?a=1"), null);
	assert.equal(G.normalizeProperty("not a site"), null);
	const entries = [
		{ siteUrl: "https://other.com/", permissionLevel: "siteFullUser" },
		{ siteUrl: "https://www.example.com/", permissionLevel: "siteRestrictedUser" },
		{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" },
		{ siteUrl: "sc-domain:unverified.com", permissionLevel: "siteUnverifiedUser" },
	];
	assert.equal(G.pickProperty(entries, "https://www.example.com"), "sc-domain:example.com");
	assert.equal(G.pickProperty(entries.slice(0, 2), "https://www.example.com"), "https://www.example.com/");
	assert.equal(G.pickProperty(entries, "https://unverified.com"), null);
	// 06:00 UTC on Nov 10 is still Nov 9 in Los Angeles: the range ends Nov 8.
	assert.deepEqual(G.gscRange(Date.UTC(2026, 10, 10, 6)), { startDate: "2026-10-12", endDate: "2026-11-08" });
	const report = G.gscReport("sc-domain:example.com", { startDate: "a", endDate: "b" }, {
		totals: { rows: [{ clicks: 10, impressions: 1000, ctr: 0.01, position: 12.3 }], metadata: { first_incomplete_date: "2026-11-08" } },
		queries: { rows: [{ keys: ["coyote"], clicks: 5, impressions: 50, ctr: 0.1, position: 3 }] },
		pages: {},
	});
	assert.deepEqual(report.totals, { clicks: 10, impressions: 1000, ctr: 0.01, position: 12.3 });
	assert.equal(report.queries[0].key, "coyote");
	assert.deepEqual(report.pages, []);
	assert.equal(report.incompleteFrom, "2026-11-08");
	assert.match(G.googleError(403, { error: { message: "Google Search Console API has not been used in project 1 before or it is disabled." } }, "a@b"), /isn't turned on/);
	assert.match(G.googleError(403, { error: { message: "User does not have sufficient permission for site." } }, "pack@p.iam"), /pack@p\.iam can't read/);
	assert.match(G.googleError(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." }, "a@b"), /refused the service account key/);
});

// ── The cache ────────────────────────────────────────────────────

test("cache: kept for its lifetime, Refresh at most once a minute, failures wait, settings changes read again, setup isn't kept", async () => {
	const kv = kvStore();
	const policy = { key: "cache:test", ttlMs: 3_600_000, refreshMinMs: 60_000, retryAfterMs: 300_000, label: "test" };
	const slot = sharedSlot();
	let now = Date.UTC(2026, 10, 10, 12);
	let reads = 0;
	let fail = false;
	const load = async () => {
		reads++;
		if (fail) throw new Error("Provider down.");
		return { report: { n: reads }, notes: ["a note"] };
	};
	const read = (fingerprint = "fp1", refresh = false, loader = load) => cachedReport(kv, policy, fingerprint, refresh, slot, loader, () => now);
	assert.deepEqual(await read(), { state: "ready", at: new Date(now).toISOString(), report: { n: 1 }, notes: ["a note"] });
	now += 30_000;
	assert.equal((await read("fp1", true)).report.n, 1, "Refresh within a minute: the same reading");
	now += 60_000;
	assert.equal((await read("fp1", true)).report.n, 2);
	now += 3_600_001;
	fail = true;
	const stale = await read();
	assert.equal(stale.report.n, 2, "the last good reading, with what went wrong");
	assert.match(stale.notes.at(-1), /Couldn't refresh: Provider down\./);
	const before = reads;
	now += 60_000;
	await read();
	assert.equal(reads, before, "no new call within the retry wait");
	fail = false;
	assert.equal((await read("fp2")).report.n, before + 1, "new settings read again at once");
	assert.deepEqual(await read("fp3", false, async () => ({ setup: "Add a key.", missing: ["key"] })), { state: "setup", reason: "Add a key.", missing: ["key"] });
	assert.equal((await kv.get("cache:test")).fingerprint, "fp2", "setup answers aren't stored");
	await forgetReport(kv, "cache:test");
	assert.equal(kv.map.size, 0);
	assert.notEqual(await fingerprintOf(["a", "secret-1"]), await fingerprintOf(["a", "secret-2"]));
	assert.doesNotMatch(await fingerprintOf(["secret-token"]), /secret/);
});

// ── End to end, against fake providers ───────────────────────────

/** A fake provider: routes by method + path prefix, records each call. */
function fakeFetch(routes) {
	const calls = [];
	const fetch = async (url, init = {}) => {
		const u = new URL(url);
		calls.push({ url: u, init, body: typeof init.body === "string" ? init.body : null });
		for (const [match, answer] of routes) {
			if (match(u, init)) {
				const { status = 200, body, headers = {} } = typeof answer === "function" ? await answer(u, init) : answer;
				return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
			}
		}
		return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: "No route" }] }), { status: 404 });
	};
	return { calls, fetch };
}

function ctxWith(settings, fetch) {
	return { settings: { get: async (k) => settings[k] ?? null, set: async () => undefined, delete: async () => undefined }, kv: kvStore(), site: { url: "https://example.com", name: "Example" }, http: { fetch }, log: { info() {}, warn() {}, error() {} } };
}

test("edge report end to end: zone, dataset limits, one report query; the token stays out of everything", async () => {
	const { edgeReport } = await import("../src/insights/edge.ts");
	const api = fakeFetch([
		[(u) => u.pathname === "/client/v4/zones" && u.searchParams.get("name") === "example.com", { body: { success: true, result: [{ id: "z1", name: "example.com", account: { id: "acc" } }] } }],
		[
			(u, init) => u.pathname === "/client/v4/graphql" && /settings/.test(init.body),
			{ body: { data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: { enabled: true, maxDuration: 2_678_400, notOlderThan: 2_764_800, availableFields: ["dimensions_userAgent"] } } }] } }, errors: null } },
		],
		[(u) => u.pathname === "/client/v4/graphql", { body: { data: { viewer: { zones: [zone] } }, errors: null } }],
	]);
	const ctx = ctxWith({}, api.fetch);
	const r = await edgeReport(ctx, false, { USAGE_API_TOKEN: "secret-cf-token-123" });
	assert.equal(r.state, "ready", JSON.stringify(r));
	assert.equal(r.report.days, 30);
	assert.equal(r.report.notFound[0].path, "/wp-content/uploads/2019/04/photo.jpg");
	const reportCall = api.calls.find((c) => c.body && !/settings/.test(c.body) && /PackInsightsEdge/.test(c.body));
	const sent = JSON.parse(reportCall.body);
	assert.equal(sent.variables.zone, "z1");
	assert.doesNotMatch(sent.query, /verifiedBotCategory/, "the zone didn't list it");
	assert.equal(reportCall.init.headers.Authorization, "Bearer secret-cf-token-123");
	assert.doesNotMatch(JSON.stringify([...ctx.kv.map.values()]), /secret-cf-token/);
	// Cached: no new calls within the hour.
	const count = api.calls.length;
	assert.equal((await edgeReport(ctx, false, { USAGE_API_TOKEN: "secret-cf-token-123" })).state, "ready");
	assert.equal(api.calls.length, count);
});

test("edge report: no token, or a token that can't see the zone, is a setup step (with the guide), not an error", async () => {
	const { edgeReport } = await import("../src/insights/edge.ts");
	const none = await edgeReport(ctxWith({}, async () => assert.fail("no call without a token")), false, {});
	assert.equal(none.state, "setup");
	const api = fakeFetch([[(u) => u.pathname === "/client/v4/zones", { body: { success: true, result: [] } }]]);
	const blind = await edgeReport(ctxWith({}, api.fetch), false, { USAGE_API_TOKEN: "tok-abcdefgh" });
	assert.equal(blind.state, "setup");
	assert.match(blind.reason, /Zone → Zone → Read/);
	const refused = fakeFetch([
		[(u) => u.pathname === "/client/v4/zones", { body: { success: true, result: [{ id: "z1", name: "example.com" }] } }],
		[(u) => u.pathname === "/client/v4/graphql", { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } }],
	]);
	const denied = await edgeReport(ctxWith({}, refused.fetch), false, { USAGE_API_TOKEN: "tok-abcdefgh" });
	assert.equal(denied.state, "error");
	assert.match(denied.message, /Zone → Analytics → Read/);
	assert.doesNotMatch(denied.message, /tok-abcdefgh/);
});

test("vitals end to end: the site's tag from the account's Web Analytics sites, then one RUM query", async () => {
	const { vitalsReport } = await import("../src/insights/vitals.ts");
	const api = fakeFetch([
		[(u) => u.pathname === "/client/v4/zones", { body: { success: true, result: [{ id: "z1", name: "example.com", account: { id: "acc1" } }] } }],
		[(u) => u.pathname === "/client/v4/accounts/acc1/rum/site_info/list", { body: { success: true, result: [{ site_tag: "tag-1", site_token: "0123456789abcdef0123456789abcdef", auto_install: false, ruleset: { zone_name: "example.com" } }] } }],
		[(u) => u.pathname === "/client/v4/graphql", { body: { data: { viewer: { accounts: [{ week: [{ count: 3, quantiles: { largestContentfulPaintP75: 1_500_000, interactionToNextPaintP75: 80_000, cumulativeLayoutShiftP75: 0.02 } }], month: [{ count: 9, quantiles: { largestContentfulPaintP75: 1_700_000 } }], pages: [] }] } }, errors: null } }],
	]);
	const r = await vitalsReport(ctxWith({ insightsBeaconToken: "0123456789abcdef0123456789abcdef" }, api.fetch), false, { USAGE_API_TOKEN: "tok-abcdefgh" });
	assert.equal(r.state, "ready", JSON.stringify(r));
	assert.equal(r.report.siteTag, "tag-1");
	assert.equal(r.report.week.lcpMs, 1500);
	const sent = JSON.parse(api.calls.find((c) => /PackInsightsVitals/.test(c.body ?? "")).body);
	assert.equal(sent.variables.account, "acc1");
	assert.equal(sent.variables.site, "tag-1");
});

test("Fathom end to end: four requests one after another, the key only in the Authorization header, errors in words", async () => {
	const { fathomReport } = await import("../src/insights/fathom.ts");
	let inFlight = 0;
	let most = 0;
	const api = fakeFetch([
		[
			(u) => u.hostname === "api.usefathom.com",
			async (u) => {
				inFlight++;
				most = Math.max(most, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
				return { body: u.searchParams.get("field_grouping") ? [{ pathname: "/", pageviews: "10", uniques: "8" }] : [{ visits: "7", pageviews: "12" }] };
			},
		],
	]);
	const ctx = ctxWith({ insightsFathomSiteId: "JZZOSMVG", insightsFathomApiKey: "fathom-secret-key" }, api.fetch);
	const r = await fathomReport(ctx);
	assert.equal(r.state, "ready", JSON.stringify(r));
	assert.deepEqual(r.report.week, { visitors: 7, pageviews: 12 });
	assert.equal(r.report.monthPages[0].path, "/");
	assert.equal(api.calls.length, 4);
	assert.equal(most, 1, "never more than one at once");
	for (const call of api.calls) {
		assert.equal(call.init.headers.Authorization, "Bearer fathom-secret-key");
		assert.doesNotMatch(call.url.href, /fathom-secret-key/);
	}
	const missing = await fathomReport(ctxWith({ insightsFathomSiteId: "JZZOSMVG" }, api.fetch));
	assert.equal(missing.state, "setup");
	assert.deepEqual(missing.missing, ["key"]);
	const limited = fakeFetch([[() => true, { status: 429, body: { message: "Too Many Attempts." }, headers: { "Retry-After": "60" } }]]);
	const busy = await fathomReport(ctxWith({ insightsFathomSiteId: "JZZOSMVG", insightsFathomApiKey: "fathom-secret-key" }, limited.fetch));
	assert.equal(busy.state, "error");
	assert.match(busy.message, /limit was reached.*60 seconds/);
	assert.doesNotMatch(busy.message, /fathom-secret-key/);
});

test("Search Console end to end: token exchange, the property found when it's not set, three queries", async () => {
	const { searchConsoleReport } = await import("../src/insights/gsc.ts");
	const { file } = await serviceAccountFile();
	const stored = JSON.stringify(G.parseServiceAccount(file));
	const api = fakeFetch([
		[(u) => u.href === "https://oauth2.googleapis.com/token", { body: { access_token: "ya29.access", expires_in: 3599, token_type: "Bearer" } }],
		[(u) => u.pathname === "/webmasters/v3/sites", { body: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }] } }],
		[(u) => u.pathname.endsWith("/searchAnalytics/query"), (_u, init) => ({ body: JSON.parse(init.body).dimensions ? { rows: [{ keys: ["k"], clicks: 1, impressions: 2, ctr: 0.5, position: 1.5 }] } : { rows: [{ clicks: 3, impressions: 30, ctr: 0.1, position: 8 }] } })],
	]);
	const ctx = ctxWith({ insightsGoogleServiceAccount: stored }, api.fetch);
	const r = await searchConsoleReport(ctx);
	assert.equal(r.state, "ready", JSON.stringify(r));
	assert.equal(r.report.property, "sc-domain:example.com");
	assert.equal(r.report.totals.clicks, 3);
	const token = api.calls.find((c) => c.url.hostname === "oauth2.googleapis.com");
	assert.equal(token.init.headers["Content-Type"], "application/x-www-form-urlencoded");
	assert.equal(new URLSearchParams(token.body).get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
	const queries = api.calls.filter((c) => c.url.pathname.endsWith("/searchAnalytics/query"));
	assert.equal(queries.length, 3);
	assert.equal(queries[0].url.pathname, "/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
	for (const q of queries) assert.equal(q.init.headers.Authorization, "Bearer ya29.access");
	assert.doesNotMatch(JSON.stringify([...ctx.kv.map.values()]), /PRIVATE KEY|ya29/);
	// Not added to the property yet: a setup step that names the email to add.
	const lonely = fakeFetch([
		[(u) => u.href === "https://oauth2.googleapis.com/token", { body: { access_token: "ya29.other", expires_in: 3599 } }],
		[(u) => u.pathname === "/webmasters/v3/sites", { body: {} }],
	]);
	const setup = await searchConsoleReport(ctxWith({ insightsGoogleServiceAccount: stored, insightsSearchConsoleProperty: "" }, lonely.fetch));
	assert.equal(setup.state, "setup");
	assert.match(setup.reason, /pack@p\.iam\.gserviceaccount\.com/);
});

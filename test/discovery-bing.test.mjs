// Bing Webmaster API submissions (Discovery → IndexNow): request building, batching, the
// quota, deadlines, the log, and the admin routes (the key is never sent back).
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const bing = await import("../src/discovery/bing.ts");
const { sendIndexNow, buildPayload } = await import("../src/discovery/indexnow.ts");
const { SECRET_SETTINGS } = await import("../src/core/secrets.ts");
const { BING_KEY_SETTING } = await import("../src/discovery/settings.ts");
const { discoveryPack } = await import("../src/discovery/pack.ts");

const KEY = "0123456789abcdef0123456789abcdef";
const SITE = "https://example.com";
const QUOTA_URL = "https://ssl.bing.com/webmaster/api.svc/json/GetUrlSubmissionQuota";
const SUBMIT_URL = "https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlBatch";
const urls = (n, prefix = "p") => Array.from({ length: n }, (_, i) => `${SITE}/${prefix}/${i}/`);
const quotaAnswer = (daily, monthly) => Response.json({ d: { __type: "UrlSubmissionQuota:#Microsoft.Bing.Webmaster.Api", DailyQuota: daily, MonthlyQuota: monthly } });

/** BingDeps with a scripted fetch and an in-memory quota slot. */
function deps({ fetch, quota = null, ...rest } = {}) {
	const calls = [];
	const state = { quota, writes: 0 };
	return {
		calls,
		state,
		deps: {
			fetch: fetch
				? async (url, init) => {
						calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
						return fetch(url, init);
					}
				: null,
			readQuota: async () => state.quota,
			writeQuota: async (q) => {
				state.quota = q;
				state.writes++;
			},
			...rest,
		},
	};
}

/** Answers like Bing: the quota, then {"d":null} for every batch. */
const bingOk =
	(daily = 100, monthly = 2800) =>
	async (url) =>
		url.startsWith(QUOTA_URL) ? quotaAnswer(daily, monthly) : Response.json({ d: null });

// ── Requests ─────────────────────────────────────────────────────

test("SubmitUrlBatch and GetUrlSubmissionQuota requests follow Microsoft's JSON samples", () => {
	const { url, init } = bing.submitRequest(SITE, "a b&c", [`${SITE}/a/`, `${SITE}/b/`]);
	assert.equal(url, `${SUBMIT_URL}?apikey=a%20b%26c`);
	assert.equal(init.method, "POST");
	assert.equal(init.headers["Content-Type"], "application/json; charset=utf-8");
	assert.deepEqual(JSON.parse(init.body), { siteUrl: SITE, urlList: [`${SITE}/a/`, `${SITE}/b/`] });
	assert.equal(bing.quotaRequestUrl(SITE, KEY), `${QUOTA_URL}?siteUrl=https%3A%2F%2Fexample.com&apikey=${KEY}`);
	assert.equal(bing.bingSiteUrl("https://example.com/"), SITE);
	assert.equal(bing.BING_API_HOST, "ssl.bing.com");
});

test("URLs are deduped, kept to the site's host, and chunked to 500", () => {
	assert.deepEqual(bing.siteUrls(SITE, [`${SITE}/a/`, "https://other.com/x", `${SITE}/a/`, "nonsense", `${SITE}/b/`]), [`${SITE}/a/`, `${SITE}/b/`]);
	assert.deepEqual(bing.chunk(urls(1201), bing.BING_BATCH_LIMIT).map((c) => c.length), [500, 500, 201]);
	assert.deepEqual(bing.chunk([], 500), []);
});

test("quota answers and Bing's error bodies are read", () => {
	assert.deepEqual(bing.parseQuota(JSON.stringify({ d: { __type: "UrlSubmissionQuota:#Microsoft.Bing.Webmaster.Api", DailyQuota: 5, MonthlyQuota: 24 } })), { daily: 5, monthly: 24 });
	assert.equal(bing.parseQuota('{"d":null}'), null);
	assert.equal(bing.parseQuota("<html>"), null);
	assert.equal(bing.parseQuota('{"d":{"DailyQuota":-1,"MonthlyQuota":3}}'), null);

	const invalid = bing.bingErrorText({ status: 400, statusText: "Error", text: '{"ErrorCode":3,"Message":"InvalidApiKey"}' }, SITE);
	assert.match(invalid, /^InvalidApiKey \(ErrorCode 3\)\. Bing doesn't accept this key/);
	const unverified = bing.bingErrorText({ status: 400, statusText: "Error", text: '{"ErrorCode":14,"Message":"NotAuthorized"}' }, SITE);
	assert.match(unverified, /NotAuthorized \(ErrorCode 14\)\. The key's Bing Webmaster Tools account must have example\.com added and verified\./);
	// Bing's real answer to a made-up key (one call, November 9, 2026).
	assert.equal(
		bing.bingErrorText({ status: 400, statusText: "Bad Request", text: '{"ErrorCode":3,"Message":"ERROR!!! InvalidApiKey"}' }, SITE),
		"InvalidApiKey (ErrorCode 3). Bing doesn't accept this key: copy it again from Bing Webmaster Tools → Settings → API access.",
	);
	assert.match(bing.bingErrorText({ status: 400, statusText: "", text: '{"ErrorCode":2,"Message":"ERROR!!! Quota remaining for today: 0, Submitted: 1"}' }, SITE), /^UnknownError \(ErrorCode 2\): Quota remaining for today: 0/);
	assert.equal(bing.bingErrorText({ status: 503, statusText: "Service Unavailable", text: "" }, SITE), "Service Unavailable");
	assert.ok(bing.isQuotaError('{"ErrorCode":2,"Message":"ERROR!!! Quota remaining for today: 0"}'));
	assert.ok(!bing.isQuotaError('{"ErrorCode":3,"Message":"InvalidApiKey"}'));
});

test("the key is scrubbed from error text", () => {
	const text = `TypeError: fetch failed for ${SUBMIT_URL}?apikey=${KEY}&x=1 (${KEY}, ${encodeURIComponent("k+y/=")})`;
	const out = bing.redact(text, KEY);
	assert.ok(!out.includes(KEY));
	assert.match(out, /apikey=…&x=1/);
	assert.ok(!bing.redact(`bad ${encodeURIComponent("k+y/=")}`, "k+y/=").includes("k%2By"));
});

test("a quota reading is fresh for an hour, on the same UTC day", () => {
	const at = Date.parse("2026-11-09T10:00:00Z");
	const q = { daily: 1, monthly: 1, checkedAt: new Date(at).toISOString() };
	assert.ok(bing.quotaFresh(q, at + 59 * 60_000));
	assert.ok(!bing.quotaFresh(q, at + 61 * 60_000));
	assert.ok(!bing.quotaFresh({ ...q, checkedAt: "2026-11-08T23:50:00Z" }, Date.parse("2026-11-09T00:10:00Z")), "a new UTC day reads again");
	assert.ok(!bing.quotaFresh(null, at));
	assert.ok(!bing.quotaFresh({ ...q, checkedAt: "nonsense" }, at));
});

// ── Submitting ───────────────────────────────────────────────────

test("no stored quota: it's read first, then one batch goes out and the quota counts down", async () => {
	const d = deps({ fetch: bingOk(100, 2800) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, [`${SITE}/a/`, `${SITE}/a/`, "https://other.com/"], "content");
	assert.deepEqual(d.calls.map((c) => c.init.method), ["GET", "POST"]);
	assert.ok(d.calls[0].url.startsWith(QUOTA_URL));
	assert.deepEqual(d.calls[1].body, { siteUrl: SITE, urlList: [`${SITE}/a/`] });
	assert.equal(entries.length, 1);
	assert.deepEqual({ ...entries[0], at: undefined }, { at: undefined, endpoint: "bing-api", count: 1, urls: [`${SITE}/a/`], status: 200, ok: true, trigger: "content", quotaLeft: 99 });
	assert.equal(d.state.quota.daily, 99);
	assert.equal(d.state.quota.monthly, 2799);
});

test("a fresh stored quota isn't read again", async () => {
	const d = deps({ fetch: bingOk(), quota: { daily: 10, monthly: 10, checkedAt: new Date().toISOString() } });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(3), "content");
	assert.deepEqual(d.calls.map((c) => c.init.method), ["POST"]);
	assert.equal(entries[0].quotaLeft, 7);
});

test("batches of 500, never past the quota left; the rest is logged as not sent", async () => {
	const d = deps({ fetch: bingOk(1200, 5000) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(1201), "content");
	assert.deepEqual(d.calls.filter((c) => c.init.method === "POST").map((c) => c.body.urlList.length), [500, 500, 200]);
	assert.deepEqual(entries.map((e) => [e.ok, e.count]), [[true, 500], [true, 500], [true, 200], [false, 1]]);
	assert.match(entries[3].error, /^Not sent: over Bing's daily \(1200 left today\) URL submission quota/);
	assert.equal(entries[3].status, 0);
	assert.equal(entries[2].quotaLeft, 0);
	assert.equal(entries[3].quotaLeft, 0, "what's left after the batches that went out");
	assert.equal(d.state.quota.daily, 0);
	assert.ok(entries.every((e) => e.endpoint === "bing-api" && e.urls.length <= 10));
});

test("the monthly quota limits too", async () => {
	const d = deps({ fetch: bingOk(100, 2) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(5), "manual");
	assert.deepEqual(entries.map((e) => [e.ok, e.count]), [[true, 2], [false, 3]]);
	assert.match(entries[1].error, /monthly \(2 left this month\)/);
	assert.equal(entries[1].quotaLeft, 98);
});

test("no quota left: nothing is sent", async () => {
	const d = deps({ fetch: bingOk(), quota: { daily: 0, monthly: 50, checkedAt: new Date().toISOString() } });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(2), "content");
	assert.equal(d.calls.length, 0);
	assert.deepEqual(entries.map((e) => [e.ok, e.count, e.status]), [[false, 2, 0]]);
});

test("a quota check that fails doesn't stop the submission (Bing enforces the quota)", async () => {
	const d = deps({ fetch: async (url) => (url.startsWith(QUOTA_URL) ? new Response("busy", { status: 503 }) : Response.json({ d: null })) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(2), "content");
	assert.deepEqual(entries.map((e) => [e.ok, e.status, e.quotaLeft]), [[true, 200, undefined]]);
	assert.equal(d.state.writes, 0);
});

test("Bing's quota error holds later submissions until the next reading", async () => {
	const d = deps({
		fetch: async (url) => (url.startsWith(QUOTA_URL) ? quotaAnswer(5, 50) : new Response('{"ErrorCode":2,"Message":"ERROR!!! Quota remaining for today: 0, Submitted: 3"}', { status: 400 })),
	});
	const first = await bing.submitToBing(d.deps, SITE, KEY, urls(3), "content");
	assert.deepEqual(first.map((e) => [e.ok, e.status, e.quotaLeft]), [[false, 400, 0]]);
	assert.equal(d.state.quota.daily, 0);
	const before = d.calls.length;
	const second = await bing.submitToBing(d.deps, SITE, KEY, urls(1, "q"), "content");
	assert.equal(d.calls.length, before, "nothing sent while the quota is used up");
	assert.match(second[0].error, /^Not sent/);
});

test("a failed batch stops the rest and says how many weren't sent", async () => {
	let posts = 0;
	const d = deps({
		fetch: async (url) => {
			if (url.startsWith(QUOTA_URL)) return quotaAnswer(5000, 5000);
			posts++;
			return posts === 1 ? Response.json({ d: null }) : new Response('{"ErrorCode":3,"Message":"InvalidApiKey"}', { status: 400 });
		},
	});
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(1600), "content");
	assert.equal(posts, 2);
	assert.deepEqual(entries.map((e) => [e.ok, e.count]), [[true, 500], [false, 500]]);
	assert.match(entries[1].error, /^InvalidApiKey \(ErrorCode 3\).*\(600 more URLs not sent\.\)$/);
	assert.equal(d.state.quota.daily, 4500, "only the batch that went through counts");
});

test("every Bing call has a deadline, and a stalled one is logged, not thrown", async () => {
	const signals = [];
	const d = deps({
		timeoutMs: 30,
		fetch: (url, init) => {
			signals.push(init.signal);
			return new Promise(() => {}); // never answers
		},
	});
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(1), "content");
	assert.equal(signals.length, 2, "the quota check and the batch");
	assert.ok(signals.every((s) => s instanceof AbortSignal));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].ok, false);
	assert.match(entries[0].error, /took longer than 30 ms/);
});

test("a submission stops starting batches when its time budget runs low", async () => {
	let clock = 1_000_000;
	const d = deps({
		now: () => clock,
		timeoutMs: 10_000,
		budgetMs: 20_000,
		fetch: async (url) => {
			clock += 6_000; // each call takes 6 s
			return url.startsWith(QUOTA_URL) ? quotaAnswer(5000, 5000) : Response.json({ d: null });
		},
	});
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(1500), "content");
	// quota (6 s) + batch 1 (12 s elapsed: 8 s left < 10 s) → stop.
	assert.deepEqual(entries.map((e) => [e.ok, e.count]), [[true, 500], [false, 1000]]);
	assert.match(entries[1].error, /^Not sent: this submission ran out of time after 1 batch\./);
});

test("the key never appears in log entries, even in a thrown error", async () => {
	const d = deps({
		fetch: async (url) => {
			throw new TypeError(`network error for ${url}`);
		},
	});
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(1), "content");
	assert.equal(entries.length, 1);
	assert.ok(!JSON.stringify(entries).includes(KEY));
	assert.match(entries[0].error, /apikey=…/);
	const check = await bing.checkQuota(d.deps, SITE, KEY);
	assert.equal(check.ok, false);
	assert.ok(!JSON.stringify(check).includes(KEY));
});

test("checkQuota stores Bing's reading; no network capability is an error, not a throw", async () => {
	const d = deps({ fetch: bingOk(7, 70) });
	const check = await bing.checkQuota(d.deps, SITE, KEY);
	assert.equal(check.ok, true);
	assert.deepEqual([check.quota.daily, check.quota.monthly], [7, 70]);
	assert.deepEqual(d.state.quota, check.quota);
	const none = deps();
	assert.deepEqual(await bing.checkQuota(none.deps, SITE, KEY), { ok: false, status: 0, error: "Error: network:request capability missing" });
	const failed = await bing.submitToBing(none.deps, SITE, KEY, urls(1), "manual");
	assert.match(failed[0].error, /network:request capability missing/);
});

// ── IndexNow ping ────────────────────────────────────────────────

test("an IndexNow ping has a deadline and logs a 429 as an entry", async () => {
	const payload = buildPayload(SITE, "abc12345", [`${SITE}/`]);
	const throttled = await sendIndexNow(
		async () => new Response('{"errorCode":"TooManyRequests","message":"We\'re sorry, but you have sent too many requests to us recently."}', { status: 429 }),
		"api.indexnow.org",
		payload,
		"manual",
	);
	assert.deepEqual([throttled.endpoint, throttled.status, throttled.ok], ["api.indexnow.org", 429, false]);
	assert.match(throttled.error, /TooManyRequests/);
	let signal;
	const stalled = await sendIndexNow(
		(url, init) => {
			signal = init.signal;
			return new Promise(() => {});
		},
		"www.bing.com",
		payload,
		"content",
		25,
	);
	assert.ok(signal instanceof AbortSignal);
	assert.match(stalled.error, /took longer than 25 ms/);
});

// ── Module: routes, log, settings ────────────────────────────────

/** A plugin context with the Discovery + IndexNow switches on and a scripted fetch. */
function fakeCtx({ key, fetch } = {}) {
	const settings = new Map([["features", { discovery: true, "discovery.indexnow": true }]]);
	if (key) settings.set(BING_KEY_SETTING, key);
	const kv = new Map();
	const calls = [];
	const logs = [];
	const log = (level) => (message, data) => logs.push({ level, message, data });
	return {
		site: { url: `${SITE}/`, name: "Example" },
		settings: {
			get: async (k) => settings.get(k) ?? null,
			set: async (k, v) => void settings.set(k, v),
			delete: async (k) => settings.delete(k),
		},
		kv: {
			get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
			set: async (k, v) => void kv.set(k, structuredClone(v)),
			delete: async (k) => kv.delete(k),
		},
		http: {
			fetch: async (url, init) => {
				calls.push({ url, init });
				return fetch(url, init);
			},
		},
		schema: { listCollections: async () => [] },
		log: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
		settingsMap: settings,
		kvMap: kv,
		calls,
		logs,
	};
}

/** IndexNow answers 429 (as from Workers' shared IPs); Bing's API works. */
const throttledIndexNow = async (url) => {
	if (url.startsWith(QUOTA_URL)) return quotaAnswer(100, 2800);
	if (url.startsWith(SUBMIT_URL)) return Response.json({ d: null });
	if (url === "https://api.indexnow.org/indexnow") return new Response('{"errorCode":"TooManyRequests"}', { status: 429 });
	throw new Error(`unexpected fetch ${url}`);
};

const { routes } = discoveryPack({});
const call = (name, ctx, input = {}) => routes[name].handler({ ...ctx, input });

test("the pack may fetch ssl.bing.com, and the key is a declared (encrypted) secret", () => {
	assert.ok(discoveryPack({}).allowedHosts.includes("ssl.bing.com"));
	assert.equal(SECRET_SETTINGS[BING_KEY_SETTING].type, "secret");
	for (const name of ["discovery/bing-key", "discovery/bing-check", "discovery/submit"]) {
		assert.equal(routes[name].permission, "plugins:manage", name);
		assert.deepEqual(routes[name].methods, ["POST"], name);
	}
});

test("Submit home page: IndexNow's 429 and Bing's success are logged separately", async () => {
	const ctx = fakeCtx({ key: KEY, fetch: throttledIndexNow });
	const out = await call("discovery/submit", ctx);
	assert.deepEqual(out.entries.map((e) => [e.endpoint, e.status, e.ok]), [["bing-api", 200, true], ["api.indexnow.org", 429, false]]);
	assert.equal(out.endpoint, "bing-api", "the first entry's fields stay at the top level");
	assert.deepEqual(out.entries[0].urls, [`${SITE}/`]);
	assert.equal(out.entries[0].trigger, "manual");
	const log = ctx.kvMap.get("state:discovery:indexnowLog");
	assert.deepEqual(log.map((e) => [e.endpoint, e.ok]), [["bing-api", true], ["api.indexnow.org", false]]);
	assert.ok(ctx.logs.some((l) => l.level === "info" && l.message === "Bing Webmaster API submitted"));
	assert.ok(ctx.logs.some((l) => l.level === "warn" && l.message === "IndexNow submission failed"));
	assert.ok(!JSON.stringify([out, log, ctx.logs]).includes(KEY), "the key is in no response, log entry or log line");
	const submitted = ctx.calls.find((c) => c.url.startsWith(SUBMIT_URL));
	assert.deepEqual(JSON.parse(submitted.init.body), { siteUrl: SITE, urlList: [`${SITE}/`] });

	// The next submission reuses the stored quota (no second check) and appends to the log.
	await call("discovery/submit", ctx);
	assert.equal(ctx.calls.filter((c) => c.url.startsWith(QUOTA_URL)).length, 1);
	assert.equal(ctx.kvMap.get("state:discovery:indexnowLog").length, 4);
	assert.equal(ctx.kvMap.get("state:discovery:bingQuota").daily, 98);
});

test("without a key nothing changes: IndexNow only", async () => {
	const ctx = fakeCtx({ fetch: throttledIndexNow });
	const out = await call("discovery/submit", ctx);
	assert.deepEqual(out.entries.map((e) => e.endpoint), ["api.indexnow.org"]);
	assert.ok(ctx.calls.every((c) => !c.url.includes("ssl.bing.com")));
});

test("the key routes save, check and remove the key and never send it back", async () => {
	const ctx = fakeCtx({ fetch: throttledIndexNow });
	let status = await call("discovery/status", ctx);
	assert.equal(status.bing.keySaved, false);

	await assert.rejects(call("discovery/bing-check", ctx), /Save a Bing Webmaster API key first/);
	await assert.rejects(call("discovery/bing-key", ctx, { key: "has spaces in it" }), /doesn't look like a Bing Webmaster API key/);
	await assert.rejects(call("discovery/bing-key", ctx, {}), /Enter a Bing Webmaster API key/);

	const saved = await call("discovery/bing-key", ctx, { key: `  ${KEY}  ` });
	assert.equal(saved.keySaved, true);
	assert.equal(saved.check.ok, true);
	assert.deepEqual([saved.check.quota.daily, saved.check.quota.monthly], [100, 2800]);
	assert.equal(ctx.settingsMap.get(BING_KEY_SETTING), KEY, "stored trimmed, under the secret setting's key");

	status = await call("discovery/status", ctx);
	assert.equal(status.bing.keySaved, true);
	assert.equal(status.bing.quota.daily, 100);
	const checked = await call("discovery/bing-check", ctx);
	assert.equal(checked.ok, true);
	assert.ok(!JSON.stringify([saved, status, checked, ctx.logs]).includes(KEY), "the key is never echoed");

	const removed = await call("discovery/bing-key", ctx, { clear: true });
	assert.deepEqual(removed, { keySaved: false, check: null });
	assert.equal(ctx.settingsMap.has(BING_KEY_SETTING), false);
	assert.equal(ctx.kvMap.has("state:discovery:bingQuota"), false);
});

test("Check key shows Bing's error, without the key", async () => {
	const ctx = fakeCtx({ key: KEY, fetch: async () => new Response('{"ErrorCode":3,"Message":"InvalidApiKey"}', { status: 400 }) });
	const out = await call("discovery/bing-check", ctx);
	assert.equal(out.ok, false);
	assert.equal(out.status, 400);
	assert.match(out.error, /^InvalidApiKey \(ErrorCode 3\)/);
	assert.ok(!JSON.stringify(out).includes(KEY));
});

test("the key routes are off with IndexNow off", async () => {
	const ctx = fakeCtx({ key: KEY, fetch: throttledIndexNow });
	ctx.settingsMap.set("features", { discovery: true, "discovery.indexnow": false });
	await assert.rejects(call("discovery/bing-key", ctx, { key: KEY }), /turned off/);
	await assert.rejects(call("discovery/bing-check", ctx), /turned off/);
	await assert.rejects(call("discovery/submit", ctx), /turned off/);
	assert.equal(ctx.calls.length, 0);
});

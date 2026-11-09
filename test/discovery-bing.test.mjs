// Bing Webmaster API submissions (Discovery → IndexNow): request building, batching, the
// quota, the queue of URLs that wait, deadlines, the log, and the admin routes (the key is
// never sent back).
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const bing = await import("../src/discovery/bing.ts");
const { sendIndexNow, buildPayload } = await import("../src/discovery/indexnow.ts");
const { SECRET_SETTINGS } = await import("../src/core/secrets.ts");
const { BING_KEY_SETTING } = await import("../src/discovery/settings.ts");
const { discoveryPack } = await import("../src/discovery/pack.ts");
const { submissionBatcher, BING_DRAIN_TASK } = await import("../src/discovery/module.ts");
const { PluginRouteError, PluginSettingEncryptionError } = await import("emdash");

const KEY = "0123456789abcdef0123456789abcdef";
const SITE = "https://example.com";
const QUOTA_URL = "https://ssl.bing.com/webmaster/api.svc/json/GetUrlSubmissionQuota";
const SUBMIT_URL = "https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlBatch";
const QUOTA_KEY = "state:discovery:bingQuota";
const PENDING_KEY = "state:discovery:bingPending";
const LOG_KEY = "state:discovery:indexnowLog";
const urls = (n, prefix = "p") => Array.from({ length: n }, (_, i) => `${SITE}/${prefix}/${i}/`);
const quotaAnswer = (daily, monthly) => Response.json({ d: { __type: "UrlSubmissionQuota:#Microsoft.Bing.Webmaster.Api", DailyQuota: daily, MonthlyQuota: monthly } });
const bingError = (code, message, status = 400) => new Response(JSON.stringify({ ErrorCode: code, Message: `ERROR!!! ${message}` }), { status });
const fresh = (daily, monthly, now = Date.now()) => ({ daily, monthly, checkedAt: new Date(now).toISOString() });

/** BingDeps with a scripted fetch and in-memory quota and queue slots. */
function deps({ fetch, quota = null, pending = [], ...rest } = {}) {
	const calls = [];
	const state = { quota, pending, writes: 0 };
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
			updateQuota: async (change) => {
				const next = change(state.quota);
				if (next === null && state.quota === null) return;
				state.quota = next;
				state.writes++;
			},
			readPending: async () => state.pending,
			updatePending: async (change) => {
				state.pending = change(state.pending);
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
	// NotAuthorized: the usual cause is the site added in Bing under the other URL form, or not verified.
	const unverified = bing.bingErrorText({ status: 400, statusText: "Error", text: '{"ErrorCode":14,"Message":"NotAuthorized"}' }, SITE);
	assert.match(unverified, /^NotAuthorized \(ErrorCode 14\)\. Bing has no site matching https:\/\/example\.com in the key's Bing Webmaster Tools account: most often the site was added there as https:\/\/www\.example\.com \(https:\/\/ vs http:\/\/, www\. or not\), or it isn't verified in that account\.$/);
	assert.match(bing.bingErrorText({ status: 400, statusText: "", text: '{"ErrorCode":13,"Message":"NotAllowed"}' }, "https://www.example.com"), /added there as https:\/\/example\.com /);
	// Bing's real answer to a made-up key (one call, November 9, 2026).
	assert.equal(
		bing.bingErrorText({ status: 400, statusText: "Bad Request", text: '{"ErrorCode":3,"Message":"ERROR!!! InvalidApiKey"}' }, SITE),
		"InvalidApiKey (ErrorCode 3). Bing doesn't accept this key: copy it again from Bing Webmaster Tools → Settings → API access.",
	);
	assert.match(bing.bingErrorText({ status: 400, statusText: "", text: '{"ErrorCode":2,"Message":"ERROR!!! Quota remaining for today: 0, Submitted: 1"}' }, SITE), /^UnknownError \(ErrorCode 2\): Quota remaining for today: 0/);
	assert.equal(bing.bingErrorText({ status: 503, statusText: "Service Unavailable", text: "" }, SITE), "Service Unavailable");
	assert.ok(bing.isQuotaError('{"ErrorCode":2,"Message":"ERROR!!! Quota remaining for today: 0"}'));
	assert.ok(!bing.isQuotaError('{"ErrorCode":3,"Message":"InvalidApiKey"}'));

	assert.equal(bing.bingErrorCode('{"ErrorCode":14,"Message":"NotAuthorized"}'), 14);
	assert.equal(bing.bingErrorCode("busy"), undefined);
	assert.equal(bing.bingErrorCode('{"d":null}'), undefined);
	// Final for the key: wrong key, blocked or unknown account. Not for NotAuthorized (the site may just be unverified).
	assert.deepEqual([...bing.PERMANENT_KEY_ERRORS].sort((a, b) => a - b), [3, 6, 10]);
	assert.ok(!bing.PERMANENT_KEY_ERRORS.has(14));
	// Final for a batch: the key errors plus a bad URL/parameter and a site the account doesn't own.
	assert.deepEqual([...bing.PERMANENT_BATCH_ERRORS].sort((a, b) => a - b), [3, 6, 7, 8, 10, 13, 14]);
	for (const transient of [1, 2, 4, 5]) assert.ok(!bing.PERMANENT_BATCH_ERRORS.has(transient), `ErrorCode ${transient} is temporary`);
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
	assert.deepEqual(d.state.pending, [], "nothing waits");
});

test("a fresh stored quota isn't read again", async () => {
	const d = deps({ fetch: bingOk(), quota: fresh(10, 10) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(3), "content");
	assert.deepEqual(d.calls.map((c) => c.init.method), ["POST"]);
	assert.equal(entries[0].quotaLeft, 7);
});

test("batches of 500, never past the quota left; the rest is queued for the next submission", async () => {
	const d = deps({ fetch: bingOk(1200, 5000) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(1201), "content");
	assert.deepEqual(d.calls.filter((c) => c.init.method === "POST").map((c) => c.body.urlList.length), [500, 500, 200]);
	assert.deepEqual(entries.map((e) => [e.ok, e.count]), [[true, 500], [true, 500], [true, 200], [false, 1]]);
	assert.match(entries[3].error, /^Queued for the next submission: over Bing's daily \(1200 left today\) URL submission quota/);
	assert.equal(entries[3].queued, true);
	assert.equal(entries[3].status, 0);
	assert.equal(entries[2].quotaLeft, 0);
	assert.equal(entries[3].quotaLeft, 0, "what's left after the batches that went out");
	assert.equal(d.state.quota.daily, 0);
	assert.deepEqual(d.state.pending, urls(1201).slice(1200), "the URL over the quota waits");
	assert.ok(entries.every((e) => e.endpoint === "bing-api" && e.urls.length <= 10));
});

test("the monthly quota limits too", async () => {
	const d = deps({ fetch: bingOk(100, 2) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(5), "manual");
	assert.deepEqual(entries.map((e) => [e.ok, e.count]), [[true, 2], [false, 3]]);
	assert.match(entries[1].error, /^Queued for the next submission: over Bing's monthly \(2 left this month\)/);
	assert.equal(entries[1].quotaLeft, 98);
	assert.deepEqual(d.state.pending, urls(5).slice(2));
});

test("no quota left: nothing is sent, everything waits", async () => {
	const d = deps({ fetch: bingOk(), quota: fresh(0, 50) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(2), "content");
	assert.equal(d.calls.length, 0);
	assert.deepEqual(entries.map((e) => [e.ok, e.count, e.status, e.queued]), [[false, 2, 0, true]]);
	assert.deepEqual(d.state.pending, urls(2));
});

test("a quota check that fails doesn't stop the submission (Bing enforces the quota)", async () => {
	const d = deps({ fetch: async (url) => (url.startsWith(QUOTA_URL) ? new Response("busy", { status: 503 }) : Response.json({ d: null })) });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(2), "content");
	assert.deepEqual(entries.map((e) => [e.ok, e.status, e.quotaLeft]), [[true, 200, undefined]]);
	assert.equal(d.state.writes, 0);
});

test("Bing's quota error queues the batch and holds later submissions until the next reading", async () => {
	const d = deps({
		fetch: async (url) => (url.startsWith(QUOTA_URL) ? quotaAnswer(5, 50) : bingError(2, "Quota remaining for today: 0, Submitted: 3")),
	});
	const first = await bing.submitToBing(d.deps, SITE, KEY, urls(3), "content");
	assert.deepEqual(first.map((e) => [e.ok, e.status, e.quotaLeft, e.queued]), [[false, 400, 0, true]]);
	assert.match(first[0].error, /^UnknownError \(ErrorCode 2\): Quota remaining for today: 0, Submitted: 3\. Queued for the next submission\.$/);
	assert.equal(d.state.quota.daily, 0);
	assert.deepEqual(d.state.pending, urls(3));
	const before = d.calls.length;
	const second = await bing.submitToBing(d.deps, SITE, KEY, urls(1, "q"), "content");
	assert.equal(d.calls.length, before, "nothing sent while the quota is used up");
	assert.deepEqual(second.map((e) => [e.count, e.queued]), [[4, true]], "the queue and the new URL wait together");
	assert.match(second[0].error, /^Queued for the next submission/);
	assert.deepEqual(d.state.pending, [...urls(3), ...urls(1, "q")], "oldest first, nothing twice");
});

test("a failed batch Bing won't ever take stops the rest and says how many weren't sent; nothing is queued", async () => {
	let posts = 0;
	const d = deps({
		fetch: async (url) => {
			if (url.startsWith(QUOTA_URL)) return quotaAnswer(5000, 5000);
			posts++;
			return posts === 1 ? Response.json({ d: null }) : bingError(3, "InvalidApiKey");
		},
	});
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(1600), "content");
	assert.equal(posts, 2);
	assert.deepEqual(entries.map((e) => [e.ok, e.count]), [[true, 500], [false, 500]]);
	assert.match(entries[1].error, /^InvalidApiKey \(ErrorCode 3\).*\(600 more URLs not sent\.\)$/);
	assert.equal(entries[1].queued, undefined);
	assert.equal(d.state.quota.daily, 4500, "only the batch that went through counts");
	assert.deepEqual(d.state.pending, [], "sending it again with the same key can't help");
});

test("a batch Bing couldn't take now waits; one it rejects for good leaves the queue", async () => {
	let answer = () => new Response("", { status: 503, statusText: "Service Unavailable" });
	const d = deps({ pending: urls(2, "old"), fetch: async (url) => (url.startsWith(QUOTA_URL) ? quotaAnswer(100, 1000) : answer()) });
	const first = await bing.submitToBing(d.deps, SITE, KEY, urls(1, "new"), "content");
	assert.deepEqual(first.map((e) => [e.ok, e.status, e.count, e.queued]), [[false, 503, 3, true]]);
	assert.match(first[0].error, /^Service Unavailable\. Queued for the next submission\.$/);
	assert.deepEqual(d.state.pending, [...urls(2, "old"), ...urls(1, "new")]);
	assert.equal(d.state.writes, 1, "the reading was stored; nothing was sent to count down");

	answer = () => bingError(7, "InvalidUrl");
	const second = await bing.submitToBing(d.deps, SITE, KEY, [], "queue");
	assert.deepEqual(second.map((e) => [e.ok, e.status, e.count, e.queued]), [[false, 400, 3, undefined]]);
	assert.deepEqual(d.state.pending, [], "a bad URL isn't tried again and again");
});

test("the queue goes first: a fresh quota day sends what waited before the new URLs, and empties the queue", async () => {
	let clock = Date.parse("2026-11-09T10:30:00Z");
	const d = deps({ now: () => clock, quota: fresh(0, 50, clock - 30 * 60_000), pending: urls(2, "old"), fetch: bingOk(5, 50) });
	const held = await bing.submitToBing(d.deps, SITE, KEY, urls(1, "new"), "content");
	assert.deepEqual(held.map((e) => [e.count, e.queued]), [[3, true]]);
	assert.equal(d.calls.length, 0);
	assert.deepEqual(d.state.pending, [...urls(2, "old"), ...urls(1, "new")]);

	clock = Date.parse("2026-11-10T00:05:00Z"); // the next UTC day: the reading is stale, Bing's quota is new
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(1, "newer"), "content");
	assert.deepEqual(d.calls.map((c) => c.init.method), ["GET", "POST"]);
	assert.deepEqual(d.calls[1].body.urlList, [...urls(2, "old"), ...urls(1, "new"), ...urls(1, "newer")], "oldest first, the new URL last");
	assert.deepEqual(entries.map((e) => [e.ok, e.count, e.quotaLeft]), [[true, 4, 1]]);
	assert.deepEqual(d.state.pending, []);
	assert.equal(d.state.quota.daily, 1);
});

test("a daily drain with nothing new and nothing waiting does nothing; URLs of another host leave the queue", async () => {
	const d = deps({ fetch: bingOk() });
	assert.deepEqual(await bing.submitToBing(d.deps, SITE, KEY, [], "queue"), []);
	assert.equal(d.calls.length, 0);
	// The site moved: what waited under the old host can't be submitted for this one.
	const moved = deps({ fetch: bingOk(), pending: ["https://old.example/a/", "https://old.example/b/"] });
	assert.deepEqual(await bing.submitToBing(moved.deps, SITE, KEY, [], "queue"), []);
	assert.deepEqual(moved.state.pending, []);
	assert.equal(moved.calls.length, 0);
});

test("the queue holds at most 1,000 URLs: the oldest leave it, and the log says which", async () => {
	assert.equal(bing.BING_PENDING_LIMIT, 1000);
	const d = deps({ fetch: bingOk(), quota: fresh(0, 50), pending: urls(1000, "old") });
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(3, "new"), "content");
	assert.deepEqual(entries.map((e) => [e.ok, e.count, e.queued]), [[false, 1003, true], [false, 3, undefined]]);
	assert.equal(entries[1].error, "Dropped: the queue for Bing holds at most 1,000 URLs, so the oldest 3 URLs left it.");
	assert.deepEqual(entries[1].urls, urls(3, "old"));
	assert.equal(d.state.pending.length, 1000);
	assert.equal(d.state.pending[0], urls(4, "old")[3]);
	assert.equal(d.state.pending.at(-1), urls(3, "new")[2]);
});

test("the stored quota is changed as a function of what's stored, so a concurrent reading is counted down, not replaced", async () => {
	const d = deps({ fetch: bingOk(), quota: fresh(10, 100) });
	// Another isolate stored a newer reading between our read and our write.
	d.deps.updateQuota = async (change) => {
		d.state.quota = change(fresh(50, 500));
	};
	const entries = await bing.submitToBing(d.deps, SITE, KEY, urls(3), "content");
	assert.equal(entries[0].quotaLeft, 7, "the log shows this submission's own count");
	assert.deepEqual([d.state.quota.daily, d.state.quota.monthly], [47, 497]);
	// And the queue: URLs another isolate queued meanwhile stay, ours join.
	const q = deps({ fetch: bingOk(), quota: fresh(0, 50), pending: [] });
	q.deps.updatePending = async (change) => {
		q.state.pending = change([`${SITE}/theirs/`]);
	};
	await bing.submitToBing(q.deps, SITE, KEY, urls(1, "ours"), "content");
	assert.deepEqual(q.state.pending, [`${SITE}/theirs/`, ...urls(1, "ours")]);
});

test("every Bing call has a deadline, and a stalled one is logged and queued, not thrown", async () => {
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
	assert.equal(entries[0].queued, true);
	assert.match(entries[0].error, /took longer than 30 ms.*Queued for the next submission\.$/);
	assert.deepEqual(d.state.pending, urls(1));
});

test("a submission stops starting batches when its time budget runs low; the rest waits", async () => {
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
	assert.deepEqual(entries.map((e) => [e.ok, e.count, e.queued]), [[true, 500, undefined], [false, 1000, true]]);
	assert.match(entries[1].error, /^Queued for the next submission: this one ran out of time after 1 batch\.$/);
	assert.deepEqual(d.state.pending, urls(1500).slice(500));
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

test("checkQuota stores Bing's reading, and says whether a failure is final for the key", async () => {
	const d = deps({ fetch: bingOk(7, 70) });
	const check = await bing.checkQuota(d.deps, SITE, KEY);
	assert.equal(check.ok, true);
	assert.deepEqual([check.quota.daily, check.quota.monthly], [7, 70]);
	assert.deepEqual(d.state.quota, check.quota);

	const none = deps();
	assert.deepEqual(await bing.checkQuota(none.deps, SITE, KEY), { ok: false, status: 0, permanent: false, error: "Error: network:request capability missing" });
	const failed = await bing.submitToBing(none.deps, SITE, KEY, urls(1), "manual");
	assert.match(failed[0].error, /network:request capability missing/);

	const answer = (response) => bing.checkQuota(deps({ fetch: async () => response }).deps, SITE, KEY);
	const invalid = await answer(bingError(3, "InvalidApiKey"));
	assert.deepEqual([invalid.ok, invalid.status, invalid.code, invalid.permanent], [false, 400, 3, true]);
	const blocked = await answer(bingError(6, "UserBlocked"));
	assert.deepEqual([blocked.code, blocked.permanent], [6, true]);
	const unverified = await answer(bingError(14, "NotAuthorized"));
	assert.deepEqual([unverified.ok, unverified.status, unverified.code, unverified.permanent], [false, 400, 14, false]);
	const busy = await answer(new Response("busy", { status: 503 }));
	assert.deepEqual([busy.ok, busy.status, busy.code, busy.permanent], [false, 503, undefined, false]);
	const odd = await answer(Response.json({ d: null }));
	assert.deepEqual([odd.ok, odd.permanent, odd.error], [false, false, "Bing's answer had no quota in it."]);
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

// ── Module: routes, hooks, task, log, settings ───────────────────

/**
 * A plugin context with the Discovery + IndexNow switches on, a scripted fetch, and a KV store with
 * EmDash's compare-and-set (revisions per key, conflicts counted).
 */
function fakeCtx({ key, fetch, content } = {}) {
	const settings = new Map([["features", { discovery: true, "discovery.indexnow": true }]]);
	if (key) settings.set(BING_KEY_SETTING, key);
	const kv = new Map();
	const revisions = new Map();
	const cas = { conflicts: 0 };
	let revision = 0;
	const bump = (k) => {
		revisions.set(k, String(++revision));
		return revisions.get(k);
	};
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
			set: async (k, v) => {
				kv.set(k, structuredClone(v));
				bump(k);
			},
			delete: async (k) => {
				revisions.delete(k);
				return kv.delete(k);
			},
			getVersioned: async (k) => (kv.has(k) ? { value: structuredClone(kv.get(k)), revision: revisions.get(k) } : null),
			compareAndSet: async (k, expected, v) => {
				if ((revisions.get(k) ?? null) !== expected) {
					cas.conflicts++;
					return { applied: false };
				}
				kv.set(k, structuredClone(v));
				return { applied: true, revision: bump(k) };
			},
			compareAndDelete: async (k, expected) => {
				if (revisions.get(k) !== expected) {
					cas.conflicts++;
					return { applied: false };
				}
				revisions.delete(k);
				kv.delete(k);
				return { applied: true };
			},
		},
		http: {
			fetch: async (url, init) => {
				calls.push({ url, init });
				return fetch(url, init);
			},
		},
		schema: { listCollections: async () => [], getCollection: async () => ({ urlPattern: "/posts/{slug}", routable: true }) },
		...(content ? { content } : {}),
		log: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
		settingsMap: settings,
		kvMap: kv,
		cas,
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

const pack = discoveryPack({});
const { routes, hooks, tasks } = pack;
const call = (name, ctx, input = {}) => routes[name].handler({ ...ctx, input });
const bingPosts = (ctx) => ctx.calls.filter((c) => c.url.startsWith(SUBMIT_URL)).map((c) => JSON.parse(c.init.body).urlList);

test("the pack may fetch ssl.bing.com, and the key is a declared (encrypted) secret", () => {
	assert.ok(pack.allowedHosts.includes("ssl.bing.com"));
	assert.equal(SECRET_SETTINGS[BING_KEY_SETTING].type, "secret");
	for (const name of ["discovery/bing-key", "discovery/bing-check", "discovery/submit"]) {
		assert.equal(routes[name].permission, "plugins:manage", name);
		assert.deepEqual(routes[name].methods, ["POST"], name);
	}
	assert.deepEqual(
		tasks.map((t) => [t.name, t.schedule, t.feature]),
		[[BING_DRAIN_TASK, "@daily", "discovery.indexnow"]],
		"the queue is drained once a day, only with IndexNow on",
	);
	assert.equal(BING_DRAIN_TASK, "discovery-bing-drain");
});

test("Submit home page: IndexNow's 429 and Bing's success are logged separately", async () => {
	const ctx = fakeCtx({ key: KEY, fetch: throttledIndexNow });
	const out = await call("discovery/submit", ctx);
	assert.deepEqual(out.entries.map((e) => [e.endpoint, e.status, e.ok]), [["bing-api", 200, true], ["api.indexnow.org", 429, false]]);
	assert.equal(out.endpoint, "bing-api", "the first entry's fields stay at the top level");
	assert.deepEqual(out.entries[0].urls, [`${SITE}/`]);
	assert.equal(out.entries[0].trigger, "manual");
	const log = ctx.kvMap.get(LOG_KEY);
	assert.deepEqual(log.map((e) => [e.endpoint, e.ok]), [["bing-api", true], ["api.indexnow.org", false]]);
	assert.ok(ctx.logs.some((l) => l.level === "info" && l.message === "Bing Webmaster API submitted"));
	assert.ok(ctx.logs.some((l) => l.level === "warn" && l.message === "IndexNow submission failed"));
	assert.ok(!JSON.stringify([out, log, ctx.logs]).includes(KEY), "the key is in no response, log entry or log line");
	assert.deepEqual(bingPosts(ctx), [[`${SITE}/`]]);

	// The next submission reuses the stored quota (no second check) and appends to the log.
	await call("discovery/submit", ctx);
	assert.equal(ctx.calls.filter((c) => c.url.startsWith(QUOTA_URL)).length, 1);
	assert.equal(ctx.kvMap.get(LOG_KEY).length, 4);
	assert.equal(ctx.kvMap.get(QUOTA_KEY).daily, 98);
	assert.equal(ctx.kvMap.has(PENDING_KEY), false, "an empty queue isn't stored");
	assert.equal(ctx.cas.conflicts, 0);
});

test("the key is in no log line, log entry or response, even when fetch throws with the request URL in its message", async () => {
	const ctx = fakeCtx({
		key: KEY,
		fetch: async (url) => {
			throw new TypeError(`fetch failed: ${url}`);
		},
	});
	const out = await call("discovery/submit", ctx);
	assert.deepEqual(out.entries.map((e) => [e.endpoint, e.ok, e.queued]), [["bing-api", false, true], ["api.indexnow.org", false, undefined]]);
	const check = await call("discovery/bing-check", ctx);
	assert.equal(check.ok, false);
	const everything = JSON.stringify([out, check, ctx.kvMap.get(LOG_KEY), ctx.logs, ctx.kvMap.get(PENDING_KEY)]);
	assert.ok(!everything.includes(KEY), "the key is nowhere");
	assert.ok(!everything.includes(encodeURIComponent(KEY)), "not URL-encoded either");
	assert.match(out.entries[0].error, /apikey=…/, "the request URL is kept, without the key");
	assert.match(check.error, /apikey=…/);
	// Every log line about Bing mentions the failure, but the URL was scrubbed before it got there.
	const bingLines = ctx.logs.filter((l) => /Bing/.test(l.message));
	assert.ok(bingLines.length >= 1);
	assert.ok(bingLines.every((l) => !JSON.stringify(l).includes(KEY)));
});

test("a published entry goes through the hook, the batcher and submit to Bing and IndexNow", async () => {
	const ctx = fakeCtx({
		key: KEY,
		fetch: throttledIndexNow,
		content: { get: async (collection, id) => ({ id, slug: "hello", status: "published", collection }) },
	});
	await hooks["content:afterPublish"]({ content: { id: "e1", status: "published" }, collection: "posts" }, ctx);
	assert.equal(ctx.calls.length, 0, "nothing goes out until the batching window closes");
	assert.equal(submissionBatcher.size, 1);
	await submissionBatcher.flush();
	assert.deepEqual(bingPosts(ctx), [[`${SITE}/posts/hello`]]);
	assert.ok(ctx.calls.some((c) => c.url === "https://api.indexnow.org/indexnow"), "IndexNow gets it too");
	const log = ctx.kvMap.get(LOG_KEY);
	assert.deepEqual(log.map((e) => [e.endpoint, e.ok, e.trigger, e.urls]), [["bing-api", true, "content", [`${SITE}/posts/hello`]], ["api.indexnow.org", false, "content", [`${SITE}/posts/hello`]]]);
	assert.equal(ctx.kvMap.get("state:discovery:url:posts:e1"), `${SITE}/posts/hello`, "the URL is remembered for a later unpublish");
	assert.ok(!JSON.stringify([log, ctx.logs]).includes(KEY));
});

test("the daily task sends the queue to Bing only, and the status shows how many URLs wait", async () => {
	const ctx = fakeCtx({ key: KEY, fetch: throttledIndexNow });
	ctx.kvMap.set(PENDING_KEY, [`${SITE}/a/`, `${SITE}/b/`]);
	let status = await call("discovery/status", ctx);
	assert.equal(status.bing.pending, 2);

	await tasks[0].handler(ctx);
	assert.deepEqual(bingPosts(ctx), [[`${SITE}/a/`, `${SITE}/b/`]]);
	assert.ok(ctx.calls.every((c) => !c.url.includes("indexnow")), "IndexNow had these when they changed");
	assert.equal(ctx.kvMap.has(PENDING_KEY), false);
	assert.deepEqual(ctx.kvMap.get(LOG_KEY).map((e) => [e.endpoint, e.ok, e.trigger, e.count]), [["bing-api", true, "queue", 2]]);
	status = await call("discovery/status", ctx);
	assert.equal(status.bing.pending, 0);
	assert.equal(status.bing.quota.daily, 98);

	// Nothing waiting, or no key: nothing happens.
	const before = ctx.calls.length;
	await tasks[0].handler(ctx);
	assert.equal(ctx.calls.length, before);
	const noKey = fakeCtx({ fetch: throttledIndexNow });
	noKey.kvMap.set(PENDING_KEY, [`${SITE}/a/`]);
	await tasks[0].handler(noKey);
	assert.equal(noKey.calls.length, 0);
});

test("the quota is counted down with compare-and-set: a write that lost a race is applied again to the newer value", async () => {
	const ctx = fakeCtx({ key: KEY, fetch: throttledIndexNow });
	ctx.kvMap.set(QUOTA_KEY, fresh(100, 2800));
	ctx.kv.set(QUOTA_KEY, fresh(100, 2800)); // a revision for the row
	const read = ctx.kv.getVersioned;
	let raced = false;
	ctx.kv.getVersioned = async (k) => {
		const current = await read(k);
		if (k === QUOTA_KEY && current && !raced) {
			raced = true;
			// Another isolate's submission lands between our read and our write.
			await ctx.kv.set(k, { ...current.value, daily: current.value.daily - 10, monthly: current.value.monthly - 10 });
		}
		return current;
	};
	const out = await call("discovery/submit", ctx);
	assert.equal(out.entries[0].ok, true);
	assert.equal(ctx.cas.conflicts, 1);
	assert.deepEqual([ctx.kvMap.get(QUOTA_KEY).daily, ctx.kvMap.get(QUOTA_KEY).monthly], [89, 2789], "both submissions count");
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
	assert.equal(saved.message, "Key saved. Bing accepts it: 100 URL submissions left today, 2800 this month.");
	assert.equal(ctx.settingsMap.get(BING_KEY_SETTING), KEY, "stored trimmed, under the secret setting's key");

	status = await call("discovery/status", ctx);
	assert.equal(status.bing.keySaved, true);
	assert.equal(status.bing.quota.daily, 100);
	const checked = await call("discovery/bing-check", ctx);
	assert.equal(checked.ok, true);
	assert.ok(!JSON.stringify([saved, status, checked, ctx.logs]).includes(KEY), "the key is never echoed");

	ctx.kvMap.set(PENDING_KEY, [`${SITE}/a/`]);
	const removed = await call("discovery/bing-key", ctx, { clear: true });
	assert.deepEqual(removed, { keySaved: false, check: null, message: "Key removed. Changed URLs go to IndexNow only." });
	assert.equal(ctx.settingsMap.has(BING_KEY_SETTING), false);
	assert.equal(ctx.kvMap.has(QUOTA_KEY), false);
	assert.equal(ctx.kvMap.has(PENDING_KEY), false, "the queue goes with the key");
});

test("a key Bing rejects for good isn't kept; one Bing couldn't check, or refused for the site, stays saved", async () => {
	const invalid = fakeCtx({ fetch: async () => bingError(3, "InvalidApiKey") });
	const rejected = await call("discovery/bing-key", invalid, { key: KEY });
	assert.equal(rejected.keySaved, false);
	assert.equal(rejected.check.permanent, true);
	assert.match(rejected.message, /^Key not saved: InvalidApiKey \(ErrorCode 3\)\. Bing doesn't accept this key/);
	assert.equal(invalid.settingsMap.has(BING_KEY_SETTING), false, "deleted again");
	assert.ok(invalid.logs.some((l) => l.level === "warn" && /not saved/.test(l.message)));
	assert.equal((await call("discovery/status", invalid)).bing.keySaved, false);
	assert.ok(!JSON.stringify([rejected, invalid.logs]).includes(KEY));

	const blocked = fakeCtx({ fetch: async () => bingError(6, "UserBlocked") });
	assert.equal((await call("discovery/bing-key", blocked, { key: KEY })).keySaved, false);
	assert.equal(blocked.settingsMap.has(BING_KEY_SETTING), false);

	const down = fakeCtx({ fetch: async () => new Response("", { status: 503, statusText: "Service Unavailable" }) });
	const kept = await call("discovery/bing-key", down, { key: KEY });
	assert.equal(kept.keySaved, true);
	assert.equal(kept.message, "Key saved; Bing couldn't be reached to check it (Service Unavailable). Check key tries again.");
	assert.equal(down.settingsMap.get(BING_KEY_SETTING), KEY);

	const offline = fakeCtx({
		fetch: async (url) => {
			throw new TypeError(`fetch failed: ${url}`);
		},
	});
	const unreachable = await call("discovery/bing-key", offline, { key: KEY });
	assert.equal(unreachable.keySaved, true);
	assert.match(unreachable.message, /^Key saved; Bing couldn't be reached to check it \(TypeError: fetch failed: .*apikey=…\)\. Check key tries again\.$/);
	assert.ok(!unreachable.message.includes(KEY));
	assert.equal(offline.settingsMap.get(BING_KEY_SETTING), KEY);

	// NotAuthorized: the key may be fine and the site unverified (or added as http:// or www.) in that account.
	const unverified = fakeCtx({ fetch: async () => bingError(14, "NotAuthorized") });
	const refused = await call("discovery/bing-key", unverified, { key: KEY });
	assert.equal(refused.keySaved, true);
	assert.match(refused.message, /^Key saved, but Bing didn't accept the check \(HTTP 400\): NotAuthorized \(ErrorCode 14\)\. Bing has no site matching https:\/\/example\.com/);
	assert.equal(unverified.settingsMap.get(BING_KEY_SETTING), KEY);
});

test("without EMDASH_ENCRYPTION_KEY the key routes answer a clear 400, not a 500", async () => {
	const missing = new PluginSettingEncryptionError("PLUGIN_SETTING_ENCRYPTION_KEY_MISSING", "EMDASH_ENCRYPTION_KEY is not configured");
	const ctx = fakeCtx({ fetch: throttledIndexNow });
	ctx.settings.set = async () => {
		throw missing;
	};
	await assert.rejects(call("discovery/bing-key", ctx, { key: KEY }), (error) => {
		assert.ok(error instanceof PluginRouteError);
		assert.equal(error.status, 400);
		assert.match(error.message, /Couldn't store the Bing Webmaster API key\. Secret plugin settings need the EMDASH_ENCRYPTION_KEY Worker secret\./);
		return true;
	});
	assert.equal(ctx.calls.length, 0, "no check for a key that wasn't stored");

	// Saved under a key that's gone: Check key says what's wrong instead of "save a key first".
	const unreadable = fakeCtx({ key: KEY, fetch: throttledIndexNow });
	unreadable.settings.get = async (k) => {
		if (k === BING_KEY_SETTING) throw new PluginSettingEncryptionError("PLUGIN_SETTING_DECRYPTION_FAILED", "cannot decrypt");
		return unreadable.settingsMap.get(k) ?? null;
	};
	await assert.rejects(call("discovery/bing-check", unreadable), (error) => error instanceof PluginRouteError && error.status === 400 && /can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed/.test(error.message));
	// Submissions still go to IndexNow, with a warning, rather than failing.
	const out = await call("discovery/submit", unreadable);
	assert.deepEqual(out.entries.map((e) => e.endpoint), ["api.indexnow.org"]);
	assert.ok(unreadable.logs.some((l) => l.level === "warn" && /can't be read/.test(l.message)));

	// Any other failure to store is still an error of its own.
	const broken = fakeCtx({ fetch: throttledIndexNow });
	broken.settings.set = async () => {
		throw new Error("D1 is down");
	};
	await assert.rejects(call("discovery/bing-key", broken, { key: KEY }), (error) => !(error instanceof PluginRouteError) && /D1 is down/.test(error.message));
});

test("Check key shows Bing's error, without the key", async () => {
	const ctx = fakeCtx({ key: KEY, fetch: async () => bingError(3, "InvalidApiKey") });
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

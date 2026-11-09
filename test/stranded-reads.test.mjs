// Run: node --import ./test/ts-resolve.mjs --test test/stranded-reads.test.mjs
// The hang that took coywolf.com pages down (November 7 and 9, 2026): the pack shared
// work under way between the requests of an isolate with no deadline, and a request
// that's canceled (the 100-second wall, a client that leaves) never settles what it
// started, so every later request that waited for it hung until the isolate died.
// Here a read that never settles stands in for one whose request was canceled, and a
// dropped zero-delay timer for the flush timer a canceled request takes with it.
// Each case has a test timeout: on the code before 0.35.16 these hang.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => { (globalThis.__anchored ??= []).push(p); }; export const cache = { purge: async (scope) => { (globalThis.__purges ??= []).push(scope); return { success: true }; } };`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

const { DEADLINES, DeadlineError, pollUntil, sharedRead, sharedSlot, withDeadline } = await import("../src/core/single-flight.ts");
// Short deadlines, so these run in milliseconds (the production values and why are in DEADLINES).
Object.assign(DEADLINES, { sharedWaitMs: 40, d1ReadMs: 150, d1FlushReclaimMs: 20, warmRecordMarginMs: 10, purgeMs: 100 });

// shared.ts loads cloudflare:workers once at import; let that settle, as it has long before a Worker's first request.
await import("../src/shared.ts");
await new Promise((resolve) => setTimeout(resolve, 0));

const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LIMIT = { timeout: 3_000 };

/** Run `fn` with console[level] captured; returns the lines. */
async function quietly(level, fn) {
	const lines = [];
	const original = console[level];
	console[level] = (...args) => lines.push(args.map(String).join(" "));
	try {
		await fn();
	} finally {
		console[level] = original;
	}
	return lines;
}

/** A D1 stand-in over node:sqlite that counts round trips; `hang` makes the next N calls never answer. */
function d1(setup = "") {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT DEFAULT '0' NOT NULL);
		${setup}
	`);
	const stats = { roundTrips: 0, sql: [] };
	const exec = (sql, params) => {
		const st = db.prepare(sql);
		return /^\s*(select|with)/i.test(sql) ? { results: st.all(...params) } : { results: [], meta: { changes: Number(st.run(...params).changes) } };
	};
	const binding = {
		stats,
		sqlite: db,
		/** The next N calls never answer. */
		hang: 0,
		/** Calls whose SQL matches never answer (`times` of them). */
		hangOn: null,
		prepare: (sql) => statement(sql),
		async batch(statements) {
			stats.roundTrips++;
			for (const s of statements) stats.sql.push(s.sql);
			if (hangs(statements.map((s) => s.sql).join(";"))) return never();
			return statements.map((s) => exec(s.sql, s.params));
		},
	};
	const hangs = (sql) => {
		if (binding.hang > 0) return binding.hang-- > 0;
		if (binding.hangOn && binding.hangOn.times > 0 && binding.hangOn.re.test(sql)) return binding.hangOn.times-- > 0;
		return false;
	};
	const call = async (sql, params) => {
		stats.roundTrips++;
		stats.sql.push(sql);
		if (hangs(sql)) return never();
		return exec(sql, params);
	};
	const statement = (sql, params = []) => ({
		sql,
		params,
		bind: (...p) => statement(sql, p),
		all: () => call(sql, params),
		first: async () => (await call(sql, params)).results[0] ?? null,
		run: () => call(sql, params),
	});
	return binding;
}

// ── The helper ───────────────────────────────────────────────────

test("deadline helpers: withDeadline rejects on time; pollUntil gives up at its deadline", async () => {
	await assert.rejects(withDeadline(never(), 10, "the test"), (error) => error instanceof DeadlineError && /the test took longer than 10 ms/.test(error.message));
	assert.equal(await withDeadline(Promise.resolve(1), 10), 1);
	await assert.rejects(withDeadline(Promise.reject(new Error("no")), 10), /no/);
	assert.equal(await pollUntil(() => false, Date.now() + 20, 5), false);
	let flag = false;
	setTimeout(() => (flag = true), 10);
	assert.equal(await pollUntil(() => flag, Date.now() + 500, 5), true);
	assert.equal(await pollUntil(() => true, 0), true, "already done: no wait");
});

test("shared read: concurrent callers share one read, which is anchored and then forgotten", async () => {
	const slot = sharedSlot();
	const anchored = [];
	let reads = 0;
	let open;
	const gate = new Promise((resolve) => (open = resolve));
	const read = async () => {
		reads++;
		await gate;
		return "value";
	};
	const all = Promise.all([0, 1, 2].map(() => sharedRead(slot, read, { anchor: (p) => anchored.push(p) })));
	open();
	assert.deepEqual(await all, ["value", "value", "value"]);
	assert.equal(reads, 1);
	assert.equal(anchored.length, 1, "the one read is handed to waitUntil");
	assert.equal(slot.flight, null, "a settled read isn't kept");
	assert.equal(await sharedRead(slot, read), "value");
	assert.equal(reads, 2);
});

test("shared read: a read that never settles doesn't hold later callers; their own read replaces it and is shared", LIMIT, async () => {
	const slot = sharedSlot();
	const calls = [];
	let open;
	const gate = new Promise((resolve) => (open = resolve));
	const read = () => {
		calls.push(calls.length);
		return calls.length === 1 ? never() : gate.then(() => "fresh");
	};
	void sharedRead(slot, read, { label: "the test read" }); // Its request is gone: this never settles.
	const stranded = slot.flight;
	const warnings = await quietly("warn", async () => {
		const started = Date.now();
		const b = sharedRead(slot, read, { label: "the test read" });
		await sleep(60);
		assert.equal(calls.length, 2, "the waiter read itself once the deadline passed");
		assert.ok(slot.flight && slot.flight !== stranded, "and its read took the stranded one's place");
		const c = sharedRead(slot, read);
		open();
		assert.deepEqual([await b, await c], ["fresh", "fresh"]);
		assert.equal(calls.length, 2, "a later caller shares the fresh read");
		assert.ok(Date.now() - started < 1_000);
	});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /^coywolf-pack: shared read stalled: the test read didn't settle within 40 ms; reading again$/);
	assert.equal(slot.flight, null);
});

test("shared read: once a read is past its deadline, the next caller doesn't wait at all", LIMIT, async () => {
	const slot = sharedSlot();
	let n = 0;
	const read = () => (++n === 1 ? never() : Promise.resolve(n));
	void sharedRead(slot, read);
	await sleep(50);
	const started = Date.now();
	await quietly("warn", async () => assert.equal(await sharedRead(slot, read), 2));
	assert.ok(Date.now() - started < 20, "no wait for a read already known to be stale");
});

test("shared read: of two callers giving up at once, the first one's read is shared and the second doesn't replace it", LIMIT, async () => {
	const slot = sharedSlot();
	let n = 0;
	let open;
	const gate = new Promise((resolve) => (open = resolve));
	const read = () => (++n === 1 ? never() : gate.then(() => "fresh"));
	void sharedRead(slot, read);
	const stranded = slot.flight;
	await quietly("warn", async () => {
		const both = Promise.all([sharedRead(slot, read), sharedRead(slot, read)]);
		await sleep(60);
		assert.equal(n, 3, "each read for itself (neither waits past its deadline)");
		const installed = slot.flight;
		assert.ok(installed && installed !== stranded);
		const later = sharedRead(slot, read);
		assert.equal(slot.flight, installed, "still the first one's read");
		open();
		assert.deepEqual([...(await both), await later], ["fresh", "fresh", "fresh"]);
		assert.equal(n, 3, "the later caller shared it");
	});
});

test("shared read: a failure in time fails every caller waiting for it, and isn't kept", async () => {
	const slot = sharedSlot();
	let n = 0;
	const read = async () => {
		n++;
		await sleep(5);
		throw new Error("D1 down");
	};
	const results = await Promise.allSettled([sharedRead(slot, read), sharedRead(slot, read)]);
	assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
	assert.equal(n, 1);
	await assert.rejects(sharedRead(slot, read));
	assert.equal(n, 2);
});

// ── Feature switches and settings (src/core/features.ts) ─────────

test("feature switches: a read that never answers doesn't hang the next request; it fails closed by its own deadline", LIMIT, async () => {
	const features = await import("../src/core/features.ts");
	const { readFailures } = await import("../src/core/read-failures.ts");
	features.invalidateFeatures();
	features.registerSiteSetting("strandTest");
	const db = d1(`INSERT INTO options (name, value) VALUES ('plugin:coywolf-pack:settings:strandTest', '"value"');`);
	db.hang = 1; // The first request's read: its request is canceled mid-read, so it never answers.
	const anchoredBefore = globalThis.__anchored?.length ?? 0;
	const before = readFailures();
	const first = features.readSiteSetting("strandTest", db);
	const anchored = globalThis.__anchored?.length ?? 0;
	await sleep(5);
	const started = Date.now();
	const warnings = await quietly("warn", async () => assert.deepEqual(await features.readSiteSetting("strandTest", db), { value: "value" }));
	const waited = Date.now() - started;
	assert.ok(waited >= 30 && waited < 500, `the next request read for itself after the shared-read deadline (${waited} ms)`);
	assert.match(warnings[0], /shared read stalled: the feature switches and settings/);
	// The stranded read ends by the D1 read deadline: a noted read failure (that page isn't edge-cached), never a hang.
	const errors = await quietly("error", async () => assert.equal(await first, null));
	assert.match(errors[0], /could not read feature switches/);
	assert.ok(readFailures() > before);
	// The fresh read was cached; nothing else is read.
	const queries = db.stats.roundTrips;
	assert.deepEqual(await features.readSiteSetting("strandTest", db), { value: "value" });
	assert.equal(db.stats.roundTrips, queries);
	assert.equal(anchored, anchoredBefore + 1, "the read was anchored with waitUntil as it started");
	features.invalidateFeatures();
});

// ── Redirects (src/redirects/middleware.ts, rules.ts) ────────────

test("redirects: a pattern load that never answers doesn't hang later requests; concurrent requests still share one load", LIMIT, async () => {
	const { serveRedirect, invalidateRedirectCache } = await import("../src/redirects/middleware.ts");
	const { saveRule } = await import("../src/redirects/rules.ts");
	const db = d1();
	await saveRule(db, { source: "^/a/(\\d+)$", target: "/b/$1", isRegex: true });
	invalidateRedirectCache();
	const go = (path, env = { DB: db }) => serveRedirect(new URL(`https://example.com${path}`), env, () => {}).then((res) => res && [res.status, res.headers.get("Location")]);

	db.hang = 1; // The first request's batch (its exact lookup and the shared pattern load) never answers.
	const first = go("/a/1");
	await sleep(5);
	const warnings = await quietly("warn", async () => assert.deepEqual(await go("/a/2"), [301, "https://example.com/b/2"]));
	assert.match(warnings[0], /shared read stalled: the redirect patterns/);
	// The stranded request fails closed by the D1 read deadline (the page renders instead; not edge-cached).
	const errors = await quietly("error", async () => assert.equal(await first, undefined));
	assert.match(errors[0], /could not load rules/);

	const PATTERNS = /FROM coywolf_redirects WHERE is_regex = 1/;
	invalidateRedirectCache();
	db.stats.sql = [];
	assert.deepEqual(await Promise.all([go("/a/3"), go("/a/4"), go("/a/5")]), [
		[301, "https://example.com/b/3"],
		[301, "https://example.com/b/4"],
		[301, "https://example.com/b/5"],
	]);
	assert.equal(db.stats.sql.filter((s) => PATTERNS.test(s)).length, 1, "one pattern load for three concurrent requests");
	invalidateRedirectCache();
});

test("redirects: creating the table, stranded, doesn't hang the admin's next request", LIMIT, async () => {
	const { listRules } = await import("../src/redirects/rules.ts");
	const db = d1();
	db.hang = 1; // The first listing's CREATE batch never answers.
	void listRules(db);
	await sleep(5);
	await quietly("warn", async () => assert.deepEqual(await listRules(db), []));
});

// ── robots.txt takeover (src/robots/middleware.ts) ───────────────

test("robots.txt: an import of EmDash's file that never answers doesn't hang the next request", LIMIT, async () => {
	const { serveRobots } = await import("../src/robots/middleware.ts");
	const db = d1();
	db.hangOn = { re: /WHERE name = \?/, times: 1 }; // The first request's read of EmDash's SEO settings (the import) never answers.
	void serveRobots(new URL("https://example.com/robots.txt"), "GET", { DB: db });
	await sleep(5);
	let res;
	const warnings = await quietly("warn", async () => {
		res = await serveRobots(new URL("https://example.com/robots.txt"), "GET", { DB: db });
	});
	assert.equal(res?.status, 200);
	assert.match(await res.text(), /User-agent: \*/);
	assert.match(warnings[0], /shared read stalled: importing EmDash's robots.txt/);
});

// ── Update check (src/updates/check.ts) ──────────────────────────

test("update check: a check whose npm request never answers doesn't hang the next admin page", LIMIT, async () => {
	const { checkForUpdate } = await import("../src/updates/check.ts");
	Object.assign(DEADLINES, { updateCheckWaitMs: 40 });
	const settings = new Map();
	let calls = 0;
	const ctx = {
		settings: { get: async (k) => settings.get(k) ?? null, set: async (k, v) => void settings.set(k, structuredClone(v)) },
		log: { warn() {}, info() {} },
		http: { fetch: async () => (++calls === 1 ? never() : new Response(JSON.stringify({ latest: "99.0.0" }))) },
	};
	void checkForUpdate(ctx);
	await sleep(5);
	await quietly("warn", async () => assert.equal((await checkForUpdate(ctx)).latest, "99.0.0"));
	assert.equal(calls, 2);
	Object.assign(DEADLINES, { updateCheckWaitMs: 10_000 });
});

// ── D1 batches (src/core/d1-batch.ts) ────────────────────────────

test("d1 batch: a flush whose timer was dropped (its request was canceled) is taken over by the next read", LIMIT, async () => {
	const { batchedFirst } = await import("../src/core/d1-batch.ts");
	const db = d1("INSERT INTO options (name, value) VALUES ('a', '1'), ('b', '2');");
	// workerd drops a canceled request's timers: drop the first read's zero-delay flush.
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => (ms === 0 ? 0 : realSetTimeout(fn, ms, ...args));
	const a = batchedFirst(db, db.prepare("SELECT value FROM options WHERE name = ?").bind("a"));
	globalThis.setTimeout = realSetTimeout;
	await sleep(30); // Past DEADLINES.d1FlushReclaimMs.
	const b = batchedFirst(db, db.prepare("SELECT value FROM options WHERE name = ?").bind("b"));
	assert.deepEqual([(await a).value, (await b).value], ["1", "2"]);
	assert.equal(db.stats.roundTrips, 1, "the stranded read went out with the next one, in one batch");
});

test("d1 batch: reads of the same tick still share one batch; a batch that never answers fails its reads by their deadline", LIMIT, async () => {
	const { batchedAll, batchedFirst } = await import("../src/core/d1-batch.ts");
	const db = d1("INSERT INTO options (name, value) VALUES ('a', '1'), ('b', '2');");
	const [a, b] = await Promise.all(["a", "b"].map((n) => batchedFirst(db, db.prepare("SELECT value FROM options WHERE name = ?").bind(n))));
	assert.deepEqual([a.value, b.value], ["1", "2"]);
	assert.equal(db.stats.roundTrips, 1);
	db.hang = 1;
	const started = Date.now();
	const results = await Promise.allSettled(["a", "b"].map((n) => batchedAll(db, db.prepare("SELECT value FROM options WHERE name = ?").bind(n))));
	assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
	assert.ok(results.every((r) => r.reason instanceof DeadlineError));
	assert.ok(Date.now() - started < 1_000);
});

// ── Cache warmer (src/pageCache/warm.ts) ─────────────────────────

/** The slice of D1 the warm queue uses: one options table (see src/pageCache/warm.test.mjs). */
function warmDb() {
	const rows = new Map();
	const db = {
		rows,
		hang: false,
		prepare(sql) {
			let args = [];
			const stmt = {
				bind(...a) {
					args = a;
					return stmt;
				},
				async first() {
					if (db.hang) return never();
					return rows.has(args[0]) ? { value: rows.get(args[0]) } : null;
				},
				async all() {
					return { results: args.filter((n) => rows.has(n)).map((name) => ({ name, value: rows.get(name) })) };
				},
				async run() {
					if (sql.startsWith("INSERT")) {
						if (sql.includes("DO NOTHING") && rows.has(args[0])) return { meta: { changes: 0 } };
						rows.set(args[0], args[1]);
						return { meta: { changes: 1 } };
					}
					if (sql.startsWith("DELETE")) {
						const [from, to, keepFrom, keepTo] = args;
						for (const name of [...rows.keys()]) if (name >= from && name < to && !(keepFrom !== undefined && name >= keepFrom && name < keepTo)) rows.delete(name);
						return { meta: { changes: 1 } };
					}
					const [value, name, before] = args;
					if (rows.get(name) !== before) return { meta: { changes: 0 } };
					rows.set(name, value);
					return { meta: { changes: 1 } };
				},
			};
			return stmt;
		},
		async batch(statements) {
			return Promise.all(statements.map((s) => s.run()));
		},
	};
	return db;
}

test("warmer: a visit that never answers, or whose body never ends, fails at its deadline and is logged once with its URL", LIMIT, async () => {
	const { visit, VISIT_TIMEOUT_LOG } = await import("../src/pageCache/warm.ts");
	const signals = [];
	const self = {
		async fetch(req) {
			signals.push(req.signal);
			if (req.url.endsWith("/hang/")) return never();
			// Headers arrive, the body never ends.
			if (req.url.endsWith("/stuck-body/")) return new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([60])) }), { headers: { "content-type": "text/html" } });
			return new Response("ok");
		},
	};
	const started = Date.now();
	const warnings = await quietly("warn", async () => {
		const { warmed, failed, results } = await visit(self, ["https://x.com/hang/", "https://x.com/stuck-body/", "https://x.com/ok/"], 40);
		assert.deepEqual([warmed, failed], [1, 2]);
		assert.deepEqual(results.map((r) => r.ok), [false, false, true]);
	});
	assert.ok(Date.now() - started < 1_000);
	assert.deepEqual(warnings.sort(), [`${VISIT_TIMEOUT_LOG} after 40 ms: https://x.com/hang/`, `${VISIT_TIMEOUT_LOG} after 40 ms: https://x.com/stuck-body/`]);
	await sleep(5);
	assert.ok(signals[0].aborted, "the hung fetch was aborted too (its request's signal)");
});

test("warmer: a step with a page that hangs still records its batch and finishes the run", LIMIT, async () => {
	const warm = await import("../src/pageCache/warm.ts");
	const db = warmDb();
	const state = { ...warm.newWarmState("x"), phase: "warm", next: 0, total: 3 };
	await warm.writeWarmState(db, state);
	await warm.writeWarmQueue(db, state.generation, ["https://x.com/", "https://x.com/hang/", "https://x.com/b/"]);
	const self = { fetch: async (req) => (req.url.endsWith("/hang/") ? never() : new Response("ok")) };
	let did;
	await quietly("warn", async () => {
		did = await warm.warmStep(db, self, "https://x.com", { budgetMs: 1_000, batchSize: 4, deadlineMs: 2_000, visitTimeoutMs: 40 });
	});
	assert.equal(did, "warmed");
	const after = await warm.readWarmState(db);
	assert.equal(after.phase, "done");
	assert.deepEqual([after.warmed, after.failed], [2, 1]);
});

test("warmer: a step stops claiming in time for its last visits, and never outlives its hard deadline", LIMIT, async () => {
	const warm = await import("../src/pageCache/warm.ts");
	// Plenty of work, every visit 25 ms: claims stop once a visit plus the record margin wouldn't fit before the deadline.
	const db = warmDb();
	const urls = Array.from({ length: 60 }, (_, i) => `https://x.com/p${i}/`);
	const state = { ...warm.newWarmState("x"), phase: "warm", next: 0, total: urls.length };
	await warm.writeWarmState(db, state);
	await warm.writeWarmQueue(db, state.generation, urls);
	const self = { fetch: async () => (await sleep(25), new Response("ok")) };
	const started = Date.now();
	const warnings = await quietly("warn", async () => assert.equal(await warm.warmStep(db, self, "https://x.com", { budgetMs: 10_000, batchSize: 1, deadlineMs: 500, visitTimeoutMs: 100 }), "warmed"));
	assert.ok(Date.now() - started < 500, "done before the hard deadline");
	assert.deepEqual(warnings, [], "not cut off");
	const progress = await warm.readWarmState(db);
	assert.ok(progress.next > 0 && progress.next < urls.length, "the rest is left for later steps");
	assert.equal(progress.warmed, progress.next, "every claimed batch was recorded");

	// Its D1 reads hang: the step ends at its hard deadline anyway (so its waitUntil isn't cut off at 30 s).
	db.hang = true;
	const cutOff = Date.now();
	const stepWarnings = await quietly("warn", async () => assert.equal(await warm.warmStep(db, self, "https://x.com", { budgetMs: 10_000, batchSize: 1, deadlineMs: 100, visitTimeoutMs: 40 }), "timed out"));
	assert.ok(Date.now() - cutOff < 1_000);
	assert.deepEqual(stepWarnings, [`${warm.STEP_TIMEOUT_LOG} after 100 ms`]);
});

test("warmer: a sitemap read that times out leaves the collect step to be tried again, instead of failing the run", LIMIT, async () => {
	const warm = await import("../src/pageCache/warm.ts");
	const db = warmDb();
	await warm.startWarm(db, "deploy");
	const self = { fetch: async (req) => (req.url.endsWith("/sitemap.xml") ? never() : new Response("<a href='/x/'>x</a>")) };
	let did;
	const warnings = await quietly("warn", async () => {
		did = await warm.warmStep(db, self, "https://x.com", { budgetMs: 1_000, batchSize: 4, deadlineMs: 2_000, visitTimeoutMs: 40 });
	});
	assert.equal(did, "collect timed out");
	assert.deepEqual(warnings, [`${warm.VISIT_TIMEOUT_LOG} after 40 ms: https://x.com/sitemap.xml`]);
	const state = await warm.readWarmState(db);
	assert.equal(state.phase, "collect", "not failed: the collect step is taken again once it's stale");
	assert.ok(state.collectingAt);
});

// ── The Stream webhook (src/videos/module.ts) ───────────────────

test("Stream webhook: clears only the pages that show the video (no full purge), and never everything", LIMIT, async () => {
	const { videoPagesScope, hmacHex } = await import("../src/videos/lib.ts");
	const UID = "a67dcf0925d0747f8c5419df6400c2b5";
	const OTHER = "b67dcf0925d0747f8c5419df6400c2b5";
	const entry = (url, uids = [UID], status = "published") => ({ uids, status, url });
	assert.deepEqual(
		videoPagesScope([entry("https://x.com/news/a/"), entry("https://x.com/news/b"), entry("https://x.com/draft/", [UID], "draft"), entry("https://x.com/other/", [OTHER]), entry(null)], UID),
		{ pathPrefixes: ["/news/a", "/news/b"] },
	);
	assert.equal(videoPagesScope([entry("https://x.com/other/", [OTHER])], UID), null, "no page shows it: nothing to clear");
	assert.equal(videoPagesScope([entry("https://x.com/"), entry("https://x.com/a/")], UID), null, "the home page: never a '/' prefix (everything)");
	assert.equal(videoPagesScope(Array.from({ length: 31 }, (_, i) => entry(`https://x.com/p${i}/`)), UID), null, "more than the cap: left to expire");

	// The route itself: refreshes the video, then clears its pages after the response.
	const { invalidateFeatures } = await import("../src/core/features.ts");
	const { videosPack } = await import("../src/videos/pack.ts");
	const { routes } = videosPack({});
	invalidateFeatures();
	const body = JSON.stringify({ uid: UID, readyToStream: true });
	const time = Math.floor(Date.now() / 1000);
	const signature = `time=${time},sig1=${await hmacHex("s3cret", `${time}.${body}`)}`;
	const settings = { features: { videos: true, "videos.webhook": true }, videosWebhookSecret: "s3cret", videosAccountId: "acc", videosApiToken: "tok" };
	const docs = new Map();
	const collection = (items = []) => ({
		get: async (id) => docs.get(id) ?? null,
		put: async (id, data) => void docs.set(id, data),
		query: async () => ({ items, hasMore: false }),
	});
	const ctx = {
		input: body,
		request: new Request("https://x.com/_emdash/api/plugins/coywolf-pack/videos/webhook", { method: "POST", headers: { "webhook-signature": signature } }),
		settings: { get: async (key) => settings[key] ?? null },
		kv: { get: async () => null, set: async () => undefined, delete: async () => undefined },
		storage: {
			videosEmbeds: collection([{ id: "posts:1", data: entry("https://x.com/news/a/") }, { id: "posts:2", data: entry("https://x.com/news/other/", [OTHER]) }]),
			videosMeta: collection(),
		},
		log: { info() {}, warn: (msg, data) => assert.fail(`${msg} ${JSON.stringify(data)}`), error() {} },
	};
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		assert.match(String(url), new RegExp(`/stream/${UID}$`));
		return Response.json({ success: true, result: { uid: UID, readyToStream: true, duration: 12, input: { width: 1920, height: 1080 }, meta: { name: "Clip" } } });
	};
	globalThis.__purges = [];
	globalThis.__anchored = [];
	try {
		assert.deepEqual(await routes["videos/webhook"].handler(ctx), { ok: true });
		await Promise.all(globalThis.__anchored);
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.equal(docs.get(UID)?.duration, 12, "the video's details were refreshed");
	assert.deepEqual(globalThis.__purges, [{ pathPrefixes: ["/news/a"] }], "only the page that shows it");
});

// ── Off the request path: crops and posters (src/images/pack.ts, src/videos/poster.ts) ──

test("posters: a copy that never settles (its timer dropped with its request) is given up on and tried again", LIMIT, async () => {
	const { mirrorPoster, resetMirroredPosters } = await import("../src/videos/poster.ts");
	resetMirroredPosters();
	Object.assign(DEADLINES, { posterMirrorMs: 40 });
	const objects = new Map();
	const stuck = { head: () => never(), put: async () => undefined };
	const good = { head: async (key) => (objects.has(key) ? {} : null), put: async (key, value) => void objects.set(key, value) };
	const image = async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
	// The copy's own deadline timer is dropped too, as a canceled request's would be.
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => (ms === DEADLINES.posterMirrorMs ? 0 : realSetTimeout(fn, ms, ...args));
	void mirrorPoster(stuck, "k.jpg", "https://stream/x.jpg", image);
	globalThis.setTimeout = realSetTimeout;
	await sleep(50);
	assert.equal(await mirrorPoster(good, "k.jpg", "https://stream/x.jpg", image), "copied");
	assert.ok(objects.has("k.jpg"));
	// A copy that's merely slow ends at its deadline (false), and is retried.
	resetMirroredPosters();
	assert.equal(await mirrorPoster(stuck, "s.jpg", "https://stream/s.jpg", image), false);
	assert.equal(await mirrorPoster(good, "s.jpg", "https://stream/s.jpg", image), "copied");
	Object.assign(DEADLINES, { posterMirrorMs: 15_000 });
});

// Run: node --test test/insights-search.test.mjs
//
// Search insights: what a search becomes before it's counted (privacy rules, normalizing), the settled-search
// signal (the live client in happy-dom, the SearchBox's module, the search/seen endpoint), the batched recorder
// and the report on a D1 stand-in (node:sqlite), and the Insights module's shape.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Window } from "happy-dom";

import "./ts-resolve.mjs";

const S = await import("../src/insights/search-core.ts");
const { noteSearch, searchReport, pruneSearches, clearSearches, searchRecorderForTests: recorder } = await import("../src/insights/search.ts");
const { FEATURES, insightsPack } = await import("../src/insights/pack.ts");
const { isReadOnlyRoute } = await import("../src/core/routes.ts");
const { createSeenSignal, SEEN_DELAY_MS } = await import("../src/search/seen-signal.ts");
const { liveScript } = await import("../src/search/live-client.ts");
const { SEEN_ENDPOINT, searchLiveMiddleware, notePackMiddleware } = await import("../src/search/live-serve.ts");
const { searchPack } = await import("../src/search/pack.ts");
const { composeHooks } = await import("../src/core/compose.ts");
const { invalidateFeatures } = await import("../src/core/features.ts");

test("queries are kept lower-case, trimmed and with spaces collapsed; long ones are cut at a word", () => {
	assert.equal(S.normalizeSearchQuery("  Coyote   Habitat?! "), "coyote habitat");
	assert.equal(S.normalizeSearchQuery('"Wolf"'), "wolf");
	assert.equal(S.normalizeSearchQuery("ＣＯＹＯＴＥ"), "coyote", "NFKC: full-width letters");
	assert.equal(S.normalizeSearchQuery("a"), null, "too short");
	assert.equal(S.normalizeSearchQuery(42), null);
	const long = S.normalizeSearchQuery(`${"wolves ".repeat(20)}end`);
	assert.ok(long.length <= S.MAX_QUERY_LENGTH);
	assert.ok(long.endsWith("wolves"), long);
});

test("privacy: emails, handles, long numbers and keys are never counted", () => {
	for (const personal of ["jane.doe@example.com", "@janedoe", "call 555-123-4567", "+1 (555) 123 4567", "4111 1111 1111 1111", "order 12345678", "sk_live_51HxyzABCDEF1234567890", "ghp_ABCDEFGHIJKLMNOPQRSTUV1234"]) {
		assert.equal(S.normalizeSearchQuery(personal), null, personal);
	}
	for (const fine of ["iphone 15", "2026 budget", "zip 90210", "top 10 seo tips", "html5 video", "coywolf pack 0.35.19", "error 404"]) {
		assert.notEqual(S.normalizeSearchQuery(fine), null, fine);
	}
});

test("a batch is a plain count per query: no folding across visitors", () => {
	const e = (q, results = 3, source = "live") => ({ q, results, source });
	const out = S.collapseBatch([e("seo"), e("seo tips"), e("wolf", 0), e("wolf", 0, "page"), e("coyote")]);
	assert.deepEqual(Object.fromEntries(out), { seo: { n: 1, z: 0 }, "seo tips": { n: 1, z: 0 }, wolf: { n: 2, z: 2 }, coyote: { n: 1, z: 0 } });
	assert.equal(S.rowId("2026-11-10", "coyote"), "2026-11-10:coyote");
	assert.equal(S.firstDay(Date.UTC(2026, 10, 10), 30), "2026-10-12");
	assert.deepEqual(S.parseSeen({ q: "coyote", n: 3 }), { q: "coyote", n: 3 });
	for (const bad of [null, "x", { q: 1, n: 1 }, { q: "x".repeat(201), n: 1 }, { q: "x", n: -1 }, { q: "x", n: 1.5 }, { q: "x", n: "3" }, { q: "x", n: 101 }]) assert.equal(S.parseSeen(bad), null, JSON.stringify(bad));
});

// ── The settled-search signal ────────────────────────────────────

function fakeTimers() {
	let now = 0;
	let id = 0;
	const timers = new Map();
	return {
		setTimer: (run, ms) => (timers.set(++id, { at: now + ms, run }), id),
		clearTimer: (t) => timers.delete(t),
		advance(ms) {
			now += ms;
			for (const [t, timer] of [...timers]) if (timer.at <= now) (timers.delete(t), timer.run());
		},
	};
}

test("SearchBox signal: once the visitor stops typing, once per query; keystrokes and submits cancel; opening a result counts at once", () => {
	const sent = [];
	const clock = fakeTimers();
	let field = "";
	const seen = createSeenSignal({ endpoint: "/seen", current: () => field, send: (url, body) => sent.push([url, JSON.parse(body)]), ...clock });
	field = "coy";
	seen.settle("coy", 2);
	clock.advance(800);
	seen.cancel(); // another keystroke
	field = "coyote";
	seen.settle("coyote", 5);
	clock.advance(SEEN_DELAY_MS - 1);
	assert.equal(sent.length, 0, "not before the delay");
	clock.advance(1);
	assert.deepEqual(sent, [["/seen", { q: "coyote", n: 5 }]]);
	seen.settle("coyote", 5);
	clock.advance(SEEN_DELAY_MS);
	assert.equal(sent.length, 1, "once per query per page view");
	field = "wolf";
	seen.settle("wolf", 0);
	seen.cancel(); // submitted: the search page counts it
	clock.advance(SEEN_DELAY_MS);
	assert.equal(sent.length, 1);
	field = "wolves";
	seen.settle("wolves", 1);
	seen.flush(); // a result opened
	assert.deepEqual(sent.at(-1), ["/seen", { q: "wolves", n: 1 }]);
	const off = createSeenSignal({ endpoint: null, current: () => "x", send: () => assert.fail("nothing without an endpoint"), ...clock });
	off.settle("x", 1);
	off.flush();
	clock.advance(SEEN_DELAY_MS);
});

/** The live results client in happy-dom, with a fake server: returns what it posted to search/seen. */
async function liveClient(config) {
	const window = new Window({ url: "https://example.test/", settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
	const posts = [];
	window.fetch = async (url, init = {}) => {
		const u = String(url);
		if (init.method === "POST") {
			posts.push({ url: u, body: JSON.parse(init.body), keepalive: init.keepalive });
			return new window.Response(null, { status: 204 });
		}
		const q = new URL(u, "https://example.test/").searchParams.get("q") ?? "";
		const items = q.startsWith("coy") ? [{ title: "Coyote", url: "/coyote/", type: "Post", titleHtml: "Coyote", snippet: "" }] : [];
		return new window.Response(JSON.stringify({ success: true, data: { items, fallback: false } }), { headers: { "Content-Type": "application/json" } });
	};
	window.document.write(`<!doctype html><html><body><form action="/search" method="get"><input type="search" name="q"></form><script>${liveScript(config)}</script></body></html>`);
	const input = window.document.querySelector("input");
	input.focus();
	const type = (value) => {
		input.value = value;
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	};
	const settle = (ms) => new Promise((r) => setTimeout(r, ms));
	return { window, input, posts, type, settle };
}

const LIVE = { endpoint: "/_emdash/api/plugins/coywolf-pack/search/live", indexEndpoint: null, version: "v1", limit: 8, minChars: 2, debounce: 5, locale: null, enterOpensTop: true };

test("live client: a search counts once the visitor stops typing, never the keystrokes on the way, never while the part is off", async () => {
	const c = await liveClient({ ...LIVE, seenEndpoint: "/_emdash/api/plugins/coywolf-pack/search/seen", seenDelay: 60 });
	c.type("co");
	await c.settle(30);
	c.type("coy");
	await c.settle(30);
	c.type("coyote");
	await c.settle(200);
	assert.deepEqual(
		c.posts.map((p) => [p.url, p.body, p.keepalive]),
		[["/_emdash/api/plugins/coywolf-pack/search/seen", { q: "coyote", n: 1 }, true]],
	);
	// A submitted search isn't reported (the search page counts it).
	c.type("wolves");
	await c.settle(20);
	c.input.form.dispatchEvent(new c.window.Event("submit", { bubbles: true, cancelable: true }));
	await c.settle(150);
	assert.equal(c.posts.length, 1);
	await c.window.happyDOM.close();

	const off = await liveClient(LIVE);
	off.type("coyote");
	await off.settle(1700);
	assert.equal(off.posts.length, 0, "no seenEndpoint in the config: nothing is sent");
	await off.window.happyDOM.close();
});

// ── search/seen, and the config that turns it on ────────────────

/** A post to search/seen as the site's own client sends it (`headers` adds or overrides; null removes one). */
function seenContext(body, method = "POST", headers = {}) {
	const all = { "Content-Type": "application/json", "X-EmDash-Request": "1", "Sec-Fetch-Site": "same-origin", Origin: "https://example.test", "CF-Connecting-IP": "203.0.113.7", ...headers };
	for (const [k, v] of Object.entries(all)) if (v === null) delete all[k];
	const request = new Request(`https://example.test${SEEN_ENDPOINT}`, { method, headers: all, ...(method === "POST" ? { body } : {}) });
	return { url: new URL(request.url), request, cache: { enabled: true, set() {} } };
}

test("search/seen accepts posts from the site's own pages only", async () => {
	const h = (headers) => (name) => headers[name] ?? null;
	assert.equal(S.seenFromSite(h({ "x-emdash-request": "1", "sec-fetch-site": "same-origin", origin: "https://example.test" }), "https://example.test"), true);
	assert.equal(S.seenFromSite(h({ "x-emdash-request": "1" }), "https://example.test"), true, "older browsers send neither Sec-Fetch-Site nor, for same-origin, always Origin");
	assert.equal(S.seenFromSite(h({}), "https://example.test"), false, "no X-EmDash-Request: a cross-site form can't send it");
	assert.equal(S.seenFromSite(h({ "x-emdash-request": "1", "sec-fetch-site": "cross-site" }), "https://example.test"), false);
	assert.equal(S.seenFromSite(h({ "x-emdash-request": "1", "sec-fetch-site": "same-site" }), "https://example.test"), false);
	assert.equal(S.seenFromSite(h({ "x-emdash-request": "1", origin: "https://evil.test" }), "https://example.test"), false);
	recorder.reset();
	recorder.setPartOn(async () => false, () => true);
	for (const headers of [{ "X-EmDash-Request": null }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.test" }]) {
		const response = await searchLiveMiddleware.handle(seenContext(JSON.stringify({ q: "coyote", n: 1 }), "POST", headers), { DB: d1() }, () => assert.fail("nothing counted"));
		assert.equal(response.status, 403, JSON.stringify(headers));
	}
	assert.equal(recorder.pending, 0);
	recorder.reset();
});

test("search/seen is always rate limited: the site's binding with seen: keys, else per isolate", async () => {
	recorder.reset();
	recorder.setPartOn(async () => false, () => true);
	const keys = [];
	const binding = { limit: async ({ key }) => (keys.push(key), { success: false }) };
	const limited = await searchLiveMiddleware.handle(seenContext(JSON.stringify({ q: "coyote", n: 1 })), { DB: d1(), COYWOLF_RATE_LIMITER: binding }, () => undefined);
	assert.equal(limited.status, 429);
	assert.match(keys[0], /^seen:[0-9a-f]{32}$/, "a salted hash of the address, never the address");
	// Without a binding (and with search.rateLimit off): 30 a minute per visitor in this isolate.
	const statuses = [];
	for (let i = 0; i < 31; i++) {
		const r = await searchLiveMiddleware.handle(seenContext(JSON.stringify({ q: `q${i}`, n: 1 }), "POST", { "CF-Connecting-IP": "198.51.100.9" }), { DB: d1() }, () => undefined);
		statuses.push(r.status);
	}
	assert.deepEqual([statuses.slice(0, 30).every((s) => s === 204), statuses[30]], [true, 429]);
	recorder.reset();
});

test("the fallback search/seen route checks both switches and where the post came from", async () => {
	const pack = searchPack({});
	const route = pack.routes["search/seen"];
	const ctx = (features, headers = {}) => ({
		settings: { get: async (k) => (k === "features" ? features : null) },
		input: { q: "coyote", n: 1 },
		request: new Request(`https://example.test${SEEN_ENDPOINT}`, { method: "POST", headers: { "X-EmDash-Request": "1", "CF-Connecting-IP": "192.0.2.5", ...headers } }),
		log: { info() {}, warn() {}, error() {} },
	});
	invalidateFeatures();
	await assert.rejects(route.handler(ctx({ search: true })), (error) => error.status === 404 || /turned off/.test(error.message), "insights.search off");
	invalidateFeatures();
	await assert.rejects(route.handler(ctx({ search: true, insights: true, "insights.search": true }, { "Sec-Fetch-Site": "cross-site" })), (error) => error.status === 403 || /Not from this site/.test(error.message));
	invalidateFeatures();
});

test("search/seen: counts a well-formed { q, n } (204, never cached), refuses anything else", async () => {
	recorder.reset();
	recorder.setDelay(5);
	recorder.setPartOn(async () => false, () => true);
	const db = d1();
	const held = [];
	const ok = await searchLiveMiddleware.handle(seenContext(JSON.stringify({ q: "Coyote", n: 2 })), { DB: db }, (p) => held.push(p));
	assert.equal(ok.status, 204);
	assert.equal(ok.headers.get("Cache-Control"), "no-store");
	assert.equal(recorder.pending, 1);
	assert.equal(held.length, 1);
	const bad = await searchLiveMiddleware.handle(seenContext(JSON.stringify({ q: "x", n: "lots" })), { DB: db }, () => undefined);
	assert.equal(bad.status, 400);
	const huge = await searchLiveMiddleware.handle(seenContext(JSON.stringify({ q: "x".repeat(2000), n: 1 })), { DB: db }, () => undefined);
	assert.equal(huge.status, 400);
	assert.equal(await searchLiveMiddleware.handle(seenContext(null, "GET"), { DB: db }, () => undefined), undefined, "GET isn't answered");
	await settle();
	recorder.reset();
});

test("the live results config carries search/seen only while Search insights is on", async () => {
	const { hooks } = composeHooks([searchPack({}), insightsPack()], { tasks: [] });
	const ctx = (features) => ({ settings: { get: async (k) => (k === "features" ? features : null) }, log: { info() {}, warn() {}, error() {} } });
	const config = async (features) => {
		invalidateFeatures();
		notePackMiddleware();
		const fragments = await hooks["page:fragments"]({ page: { locale: null } }, ctx(features));
		notePackMiddleware(false);
		const live = fragments.find((f) => f.key === "search-live");
		return JSON.parse(live.attributes["data-cw-live"]);
	};
	assert.equal((await config({ search: true })).seenEndpoint, undefined);
	assert.equal((await config({ search: true, insights: true })).seenEndpoint, undefined);
	assert.equal((await config({ search: true, insights: true, "insights.search": true })).seenEndpoint, SEEN_ENDPOINT);
	invalidateFeatures();
});

// ── The recorder and the report on a D1 stand-in ─────────────────

function d1() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE _plugin_storage (plugin_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT, updated_at TEXT, revision TEXT DEFAULT '0' NOT NULL, PRIMARY KEY (plugin_id, collection, id));");
	const statement = (sql, values) => {
		const stmt = db.prepare(sql);
		return {
			async run() {
				const r = stmt.run(...values);
				return { meta: { changes: Number(r.changes) } };
			},
			async first() {
				return stmt.get(...values) ?? null;
			},
			async all() {
				return { results: stmt.all(...values) };
			},
		};
	};
	let batches = 0;
	return {
		sqlite: db,
		get batches() {
			return batches;
		},
		prepare: (sql) => ({ bind: (...values) => statement(sql, values) }),
		async batch(statements) {
			batches++;
			for (const s of statements) await s.run();
		},
	};
}

async function settle() {
	for (let i = 0; i < 200 && !recorder.idle; i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(recorder.idle, "the flush finished");
}

const rowsOf = (db) => db.sqlite.prepare("SELECT id, data FROM _plugin_storage ORDER BY id").all().map((r) => ({ id: r.id, ...JSON.parse(r.data) }));

test("recorder: one batch after the response, per day and query, nothing about the visitor", async () => {
	recorder.reset();
	recorder.setDelay(10);
	recorder.setPartOn(async () => true);
	const db = d1();
	const held = [];
	const waitUntil = (p) => held.push(p);
	noteSearch(db, "Coyote", 4, "live", waitUntil);
	noteSearch(db, "coyote", 4, "page", waitUntil);
	noteSearch(db, "unicorns", 0, "page", waitUntil);
	noteSearch(db, "me@example.com", 0, "page", waitUntil);
	assert.ok(held.length >= 1 && held.every((p) => p === held[0]), "every search shares one flush, held open with waitUntil");
	await settle();
	assert.equal(db.batches, 1);
	const day = S.dayOf(Date.now());
	assert.deepEqual(rowsOf(db), [
		{ id: `${day}:coyote`, d: day, q: "coyote", n: 2, z: 0 },
		{ id: `${day}:unicorns`, d: day, q: "unicorns", n: 1, z: 1 },
	]);
	assert.doesNotMatch(JSON.stringify(rowsOf(db)), /example\.com|ip|agent/i);
	noteSearch(db, "unicorns", 0, "page", waitUntil);
	await settle();
	const unicorns = rowsOf(db).find((r) => r.q === "unicorns");
	assert.deepEqual([unicorns.n, unicorns.z], [2, 2]);
	recorder.reset();
});

test("recorder: nothing while the part is off, before the switches are read, or without a database", async () => {
	recorder.reset();
	recorder.setDelay(5);
	const db = d1();
	recorder.setPartOn(async () => false);
	noteSearch(db, "coyote", 1, "page", () => undefined);
	await settle();
	recorder.setPartOn(async () => assert.fail("no switch read when they're unknown"), () => null);
	noteSearch(db, "coyote", 1, "page", () => assert.fail("no flush when they're unknown"));
	recorder.setPartOn(async () => true, () => false);
	noteSearch(db, "coyote", 1, "page", () => assert.fail("no flush when they're off"));
	noteSearch(null, "coyote", 1, "page", () => assert.fail("no database: no flush"));
	await settle();
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _plugin_storage").get().n, 0);
	recorder.reset();
});

test("recorder: past the site's daily cap, searches add to today's queries but never start new ones", async () => {
	recorder.reset();
	recorder.setDelay(5);
	recorder.setPartOn(async () => true);
	const db = d1();
	const day = S.dayOf(Date.now());
	const insert = db.sqlite.prepare("INSERT INTO _plugin_storage (plugin_id, collection, id, data) VALUES ('coywolf-pack', 'searchInsights', ?, ?)");
	for (let i = 0; i < S.MAX_QUERIES_PER_DAY; i++) insert.run(S.rowId(day, `q${i}`), JSON.stringify({ d: day, q: `q${i}`, n: 1, z: 0 }));
	noteSearch(db, "q7", 2, "page", () => undefined);
	noteSearch(db, "brand new", 1, "page", () => undefined);
	await settle();
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _plugin_storage").get().n, S.MAX_QUERIES_PER_DAY);
	assert.equal(rowsOf(db).find((r) => r.q === "q7").n, 2);
	recorder.reset();
});

test("report: totals, and only queries searched 3 times on 2 different days; prune keeps 90 days; clear deletes all, pending too", async () => {
	const db = d1();
	const now = Date.UTC(2026, 10, 10, 12);
	const put = (day, q, n, z) => db.sqlite.prepare("INSERT INTO _plugin_storage (plugin_id, collection, id, data) VALUES ('coywolf-pack', 'searchInsights', ?, ?)").run(S.rowId(day, q), JSON.stringify({ d: day, q, n, z }));
	put("2026-11-10", "coyote", 5, 0);
	put("2026-11-01", "coyote", 3, 1);
	put("2026-11-09", "unicorns", 2, 2);
	put("2026-11-08", "unicorns", 1, 1);
	put("2026-11-09", "one day", 9, 9);
	put("2026-11-09", "twice", 1, 0);
	put("2026-11-08", "twice", 1, 0);
	put("2026-09-01", "old", 9, 9);
	put("2026-09-02", "old", 1, 1);
	put("2026-07-01", "ancient", 4, 0);
	db.sqlite.prepare("INSERT INTO _plugin_storage (plugin_id, collection, id, data) VALUES ('coywolf-pack', 'other', 'x', '{}')").run();
	const r30 = await searchReport(db, 30, now);
	assert.equal(r30.searches, 22);
	assert.equal(r30.noResults, 13);
	assert.deepEqual(r30.top.map((t) => [t.q, t.searches, t.noResults]), [["coyote", 8, 1], ["unicorns", 3, 3]], "'one day' (one day) and 'twice' (2 searches) aren't listed");
	assert.deepEqual(r30.zero.map((t) => t.q), ["unicorns", "coyote"]);
	assert.deepEqual([r30.minShown, r30.minDays], [3, 2]);
	assert.equal(r30.since, "2026-11-01");
	const r90 = await searchReport(db, 90, now);
	assert.ok(r90.top.some((t) => t.q === "old"));
	assert.ok(!r90.top.some((t) => t.q === "ancient"), "older than 90 days");
	assert.equal(await pruneSearches(db, now), 1);
	recorder.reset();
	recorder.setDelay(10_000);
	recorder.setPartOn(async () => true);
	noteSearch(db, "waiting", 1, "page", () => undefined);
	assert.equal(recorder.pending, 1);
	assert.equal(await clearSearches(db), 9);
	assert.equal(recorder.pending, 0, "searches still in memory go too");
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _plugin_storage").get().n, 1, "other collections are left alone");
	recorder.reset();
});

test("the module: everything off by default, its hosts declared, saves that change no page marked read-only", () => {
	assert.deepEqual(FEATURES.map((f) => f.id), ["insights", "insights.edge", "insights.vitals", "insights.beacon", "insights.fathom", "insights.searchConsole", "insights.search"]);
	for (const f of FEATURES) assert.equal(f.default, false, f.id);
	const pack = insightsPack();
	assert.deepEqual(pack.allowedHosts.sort(), ["api.cloudflare.com", "api.usefathom.com", "oauth2.googleapis.com", "www.googleapis.com"]);
	assert.deepEqual(pack.capabilities, ["network:request"]);
	assert.deepEqual(pack.storage, { searchInsights: { indexes: ["d"] } });
	assert.equal(pack.hookFeature["page:fragments"], "insights.beacon");
	assert.deepEqual(pack.tasks.map((t) => [t.name, t.schedule, t.feature]), [["insights-search-prune", "@daily", ""]], "the 90-day prune runs whatever the switches say");
	assert.equal(isReadOnlyRoute(pack.routes["insights/settings/save"]), true);
	assert.equal(isReadOnlyRoute(pack.routes["insights/searches/clear"]), true);
	assert.equal(isReadOnlyRoute(pack.routes["insights/beacon/save"]), false, "the beacon token changes every page: the cache is cleared");
	assert.deepEqual(pack.adminPages, [{ path: "/insights", label: "Insights", icon: "chart-line" }]);
});

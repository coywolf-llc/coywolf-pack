// Run: node --test test/insights-search.test.mjs
//
// Search insights: what a search becomes before it's counted (privacy rules, normalizing, folding a visitor's
// keystrokes), the batched recorder and the report on a D1 stand-in (node:sqlite), and the Insights module's shape.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import "./ts-resolve.mjs";

const S = await import("../src/insights/search-core.ts");
const { noteSearch, liveAnswerCount, searchReport, pruneSearches, clearSearches, searchRecorderForTests: recorder } = await import("../src/insights/search.ts");
const { FEATURES, insightsPack } = await import("../src/insights/pack.ts");
const { isReadOnlyRoute } = await import("../src/core/routes.ts");

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

test("a batch folds typing into the search it ended with, and a typed-then-submitted search counts once", () => {
	const live = (q, results = 3) => ({ q, results, source: "live" });
	const page = (q, results = 3) => ({ q, results, source: "page" });
	const out = S.collapseBatch([live("co", 9), live("coy", 0), live("coyote"), page("coyote"), live("wolf", 0), live("wolf", 0), page("seo")]);
	assert.deepEqual(Object.fromEntries(out), { coyote: { n: 1, z: 0 }, wolf: { n: 2, z: 2 }, seo: { n: 1, z: 0 } });
	// A submitted search is never dropped, even when it's the start of another.
	assert.deepEqual(Object.fromEntries(S.collapseBatch([page("co", 0), live("coyote")])), { co: { n: 1, z: 1 }, coyote: { n: 1, z: 0 } });
	assert.equal(S.rowId("2026-11-10", "coyote"), "2026-11-10:coyote");
	assert.equal(S.firstDay(Date.UTC(2026, 10, 10), 30), "2026-10-12");
});

test("a live answer's result count, from its cached JSON", () => {
	assert.equal(liveAnswerCount(JSON.stringify({ success: true, data: { items: [{}, {}], fallback: false } })), 2);
	assert.equal(liveAnswerCount("not json"), 0);
});

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

test("recorder: one batch after the response, per day and query, nothing about the visitor", async () => {
	recorder.reset();
	recorder.setDelay(10);
	recorder.setPartOn(async () => true);
	const db = d1();
	const held = [];
	const waitUntil = (p) => held.push(p);
	for (const q of ["Co", "Coy", "Coyote"]) noteSearch(db, q, q === "Coyote" ? 4 : 1, "live", waitUntil);
	noteSearch(db, "coyote", 4, "page", waitUntil);
	noteSearch(db, "unicorns", 0, "page", waitUntil);
	noteSearch(db, "me@example.com", 0, "page", waitUntil);
	noteSearch(db, "unicorns", () => 0, "live", waitUntil);
	assert.ok(held.length >= 1 && held.every((p) => p === held[0]), "every search shares one flush, held open with waitUntil");
	await settle();
	assert.equal(db.batches, 1);
	const rows = db.sqlite.prepare("SELECT id, data FROM _plugin_storage ORDER BY id").all().map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
	const day = S.dayOf(Date.now());
	assert.deepEqual(rows, [
		{ id: `${day}:coyote`, d: day, q: "coyote", n: 1, z: 0 },
		{ id: `${day}:unicorns`, d: day, q: "unicorns", n: 1, z: 1 },
	]);
	assert.doesNotMatch(JSON.stringify(rows), /example\.com|ip|agent/i);
	// A later batch adds to the same rows.
	noteSearch(db, "unicorns", 0, "page", waitUntil);
	await settle();
	const unicorns = JSON.parse(db.sqlite.prepare("SELECT data FROM _plugin_storage WHERE id = ?").get(`${day}:unicorns`).data);
	assert.deepEqual([unicorns.n, unicorns.z], [2, 2]);
	recorder.reset();
});

test("recorder: nothing is written while the part is off, and nothing at all without a database", async () => {
	recorder.reset();
	recorder.setDelay(5);
	recorder.setPartOn(async () => false);
	const db = d1();
	noteSearch(db, "coyote", 1, "page", () => undefined);
	noteSearch(null, "coyote", 1, "page", () => assert.fail("no database: no flush"));
	await settle();
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _plugin_storage").get().n, 0);
	recorder.reset();
});

test("report: totals, top searches and no-result searches, never one seen once; prune keeps 90 days; clear deletes all", async () => {
	const db = d1();
	const now = Date.UTC(2026, 10, 10, 12);
	const put = (day, q, n, z) => db.sqlite.prepare("INSERT INTO _plugin_storage (plugin_id, collection, id, data) VALUES ('coywolf-pack', 'searchInsights', ?, ?)").run(S.rowId(day, q), JSON.stringify({ d: day, q, n, z }));
	put("2026-11-10", "coyote", 5, 0);
	put("2026-11-01", "coyote", 3, 1);
	put("2026-11-09", "unicorns", 2, 2);
	put("2026-11-09", "once", 1, 1);
	put("2026-09-01", "old", 9, 9);
	put("2026-07-01", "ancient", 4, 0);
	db.sqlite.prepare("INSERT INTO _plugin_storage (plugin_id, collection, id, data) VALUES ('coywolf-pack', 'other', 'x', '{}')").run();
	const r30 = await searchReport(db, 30, now);
	assert.equal(r30.searches, 11);
	assert.equal(r30.noResults, 4);
	assert.deepEqual(r30.top.map((t) => [t.q, t.searches, t.noResults]), [["coyote", 8, 1], ["unicorns", 2, 2]]);
	assert.deepEqual(r30.zero.map((t) => t.q), ["unicorns", "coyote"]);
	assert.equal(r30.since, "2026-11-01");
	const r90 = await searchReport(db, 90, now);
	assert.ok(r90.top.some((t) => t.q === "old"));
	assert.ok(!r90.top.some((t) => t.q === "ancient"), "older than 90 days");
	assert.equal(await pruneSearches(db, now), 1);
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _plugin_storage WHERE collection = 'searchInsights'").get().n, 5);
	assert.equal(await clearSearches(db), 5);
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _plugin_storage").get().n, 1, "other collections are left alone");
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

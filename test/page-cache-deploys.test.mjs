// Run: node --test test/page-cache-deploys.test.mjs
// A deploy: Workers Cache keys responses by Worker version (unless the site sets
// cache.cross_version_cache), so a new version starts from a cold cache by itself. The pack
// only notices the new version, once, to start cache warming; it clears the cache only for
// sites that share it across versions (pageCache: { crossVersionCache: true }).
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => { globalThis.__waitUntil?.push(p); }; export const cache = { purge: async (o) => { globalThis.__purges.push(o); return { success: globalThis.__purgeOk !== false }; } };`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

globalThis.__purges = [];
const { noteNewVersion, parseVersionRow, VERSION_OPTION, VERSION_HISTORY, ROLLBACK_PURGE_EVERY_MS } = await import("../src/pageCache/lib.ts");
const { pageCacheMiddleware, configurePageCache, pageCachePack, pageCacheConfig } = await import("../src/pageCache/pack.ts");

/** A D1 stand-in over node:sqlite (the options table, as EmDash creates it). RETURNING statements return their rows, as D1's do. */
function d1() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const exec = (sql, params) => {
		const st = db.prepare(sql);
		return /^\s*(select|with)|\breturning\b/i.test(sql) ? { results: st.all(...params) } : { results: [], meta: { changes: Number(st.run(...params).changes) } };
	};
	const statement = (sql, params = []) => ({
		sql,
		params,
		bind: (...p) => statement(sql, p),
		all: async () => exec(sql, params),
		first: async () => exec(sql, params).results[0] ?? null,
		run: async () => exec(sql, params),
	});
	return { sqlite: db, prepare: (sql) => statement(sql), batch: async (statements) => statements.map((s) => exec(s.sql, s.params)) };
}
const raw = (db) => db.sqlite.prepare("SELECT value FROM options WHERE name = ?").get(VERSION_OPTION)?.value ?? null;
const stored = (db) => parseVersionRow(raw(db));

test("a new version is recorded once and not purged (Workers Cache is already per version)", async () => {
	const db = d1();
	globalThis.__purges = [];
	assert.equal(await noteNewVersion(db, "v1", undefined, { purge: false }), true, "the first isolate of v1 starts warming");
	assert.deepEqual(stored(db), { current: "v1", seen: ["v1"] });
	assert.equal(await noteNewVersion(db, "v1", undefined, { purge: false }), false, "already recorded");
	assert.equal(await noteNewVersion(db, "v2", null, { purge: false }), false, "a racing isolate that read no row loses the compare-and-set");
	assert.equal(await noteNewVersion(db, "v1", raw(db), { purge: false }), false, "known from the switches' read: no query");
	assert.equal(await noteNewVersion(db, "v2", raw(db), { purge: false }), true);
	const before = raw(db);
	assert.equal(await noteNewVersion(db, "v3", JSON.stringify({ current: "old", seen: ["old"] }), { purge: false }), false, "a stale read of the row loses too");
	assert.equal(raw(db), before);
	assert.deepEqual(globalThis.__purges, [], "no purge spent on a cache nobody can reach");
});

test("a row from before 0.35.19 (a plain version id) is read as the current version", async () => {
	const db = d1();
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run(VERSION_OPTION, JSON.stringify("v1"));
	assert.equal(await noteNewVersion(db, "v1", undefined, { purge: false }), false);
	assert.equal(await noteNewVersion(db, "v2", undefined, { purge: false }), true);
	assert.deepEqual(stored(db).seen, ["v1", "v2"]);
	assert.deepEqual(parseVersionRow("not json"), { current: null, seen: [] }, "unreadable: like no row");
});

test("with cross-version caching, a new version clears every page first; a refused purge is tried again by the next isolate", async () => {
	const db = d1();
	globalThis.__purges = [];
	globalThis.__purgeOk = false;
	assert.equal(await noteNewVersion(db, "v1", null, { purge: true }), false);
	assert.equal(raw(db), null, "not recorded, so another isolate purges");
	globalThis.__purgeOk = true;
	assert.equal(await noteNewVersion(db, "v1", null, { purge: true }), true);
	assert.deepEqual(globalThis.__purges, [{ purgeEverything: true }, { purgeEverything: true }]);
	assert.equal(stored(db).current, "v1");
});

test("a rollback to a version seen before clears every page (its partition may hold pages from before the edits); gradual-deployment flips at most every 10 minutes", async () => {
	const db = d1();
	globalThis.__purges = [];
	const t0 = Date.UTC(2026, 10, 10, 12);
	await noteNewVersion(db, "A", undefined, { purge: false, now: t0 });
	await noteNewVersion(db, "B", undefined, { purge: false, now: t0 + 1000 });
	assert.deepEqual(globalThis.__purges, [], "new versions: no purge");
	// Rolled back to A.
	assert.equal(await noteNewVersion(db, "A", undefined, { purge: false, now: t0 + 60_000 }), true, "cleared, so warming starts");
	assert.deepEqual(globalThis.__purges, [{ purgeEverything: true }]);
	assert.equal(stored(db).rollbackPurgedAt, t0 + 60_000);
	// A gradual deployment: requests go to A and B in turn. Within 10 minutes, no more purges and no warm-up restarts.
	assert.equal(await noteNewVersion(db, "B", undefined, { purge: false, now: t0 + 120_000 }), false);
	assert.equal(await noteNewVersion(db, "A", undefined, { purge: false, now: t0 + 180_000 }), false);
	assert.equal(globalThis.__purges.length, 1);
	assert.equal(stored(db).current, "A", "still recorded, so the next isolate of A doesn't check again");
	// Later, another flip clears again.
	assert.equal(await noteNewVersion(db, "B", undefined, { purge: false, now: t0 + 60_000 + ROLLBACK_PURGE_EVERY_MS }), true);
	assert.equal(globalThis.__purges.length, 2);
	// The history is bounded.
	for (let i = 0; i < VERSION_HISTORY + 5; i++) await noteNewVersion(db, `n${i}`, undefined, { purge: false, now: t0 + 10 * ROLLBACK_PURGE_EVERY_MS + i });
	assert.equal(stored(db).seen.length, VERSION_HISTORY);
	assert.ok(!stored(db).seen.includes("A"), "a version from long ago counts as new again");
});

test("the option reaches the middleware; it's off by default", () => {
	configurePageCache({});
	assert.equal(pageCacheConfig().crossVersionCache, undefined);
	pageCachePack({ crossVersionCache: true });
	assert.equal(pageCacheConfig().crossVersionCache, true);
	pageCachePack();
	assert.equal(pageCacheConfig().crossVersionCache, undefined);
	assert.equal(pageCacheMiddleware.handle({}, {}, () => {}), undefined, "never answers a request");
});

test("the hourly warming fallback is scheduled with the pack, runs whatever the switches say, and does nothing while warming is off", async () => {
	const { composeHooks } = await import("../src/core/compose.ts");
	const { WARM_TASK } = await import("../src/pageCache/warm.ts");
	const module = pageCachePack();
	const task = module.tasks.find((t) => t.name === WARM_TASK);
	assert.ok(task);
	assert.equal(task.schedule, "@hourly");
	const { tasks, hooks } = composeHooks([module], { tasks: [] });
	assert.equal(tasks.find((t) => t.name === WARM_TASK).feature, "", "Performance has no switch: not gated on one");
	const asked = [];
	const ctx = { settings: { get: async (k) => (asked.push(k), k === "features" ? {} : null) }, site: { url: "https://example.com" }, log: { info() {}, warn() {}, error() {} } };
	await hooks.cron.handler({ name: WARM_TASK }, ctx);
	assert.ok(asked.includes("pageCacheWarm"), "the task itself checks the warming switch");
});

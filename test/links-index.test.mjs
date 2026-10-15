// Run: node --test test/links-index.test.mjs
// Link Manager lookups by entry (and the orphan count by URL) use their own
// expression index, not the generic list index plus a scan of every reference row.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => p;`, shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const store = await import("../src/links/store.ts");

/** The _plugin_storage table and indexes as EmDash creates them (migration 001 + the pack's declared links_refs indexes). */
function database(rows = 3000) {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE _plugin_storage (plugin_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, revision TEXT, CONSTRAINT pk_plugin_storage PRIMARY KEY (plugin_id, collection, id));
		CREATE INDEX idx_plugin_storage_list ON _plugin_storage (plugin_id, collection, created_at);
	`);
	for (const field of store.STORAGE.links_refs.indexes) {
		db.exec(`CREATE INDEX IF NOT EXISTS "idx_plugin_coywolf-pack_links_refs_${field}" ON _plugin_storage(plugin_id, collection, json_extract(data, '$.${field}'))`);
	}
	const insert = db.prepare("INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at) VALUES ('coywolf-pack', 'links_refs', ?, ?, ?)");
	for (let i = 0; i < rows; i++) {
		const entryKey = `posts/${i % 600}`;
		const urlId = `u${i % 900}`;
		insert.run(`${entryKey}|${urlId}|${i}`, JSON.stringify({ entryKey, urlId, seenAt: "2026-01-01" }), `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`);
	}
	db.exec("ANALYZE");
	return db;
}

const plan = (db, sql, ...params) =>
	db
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.all(...params)
		.map((r) => r.detail)
		.join("\n");

test("the lookup by entry uses the entryKey index (no list index, no temp sort)", () => {
	const db = database();
	const detail = plan(db, store.refsWhereSql("entryKey"), "coywolf-pack", "links_refs", "posts/7");
	assert.match(detail, /USING INDEX idx_plugin_coywolf-pack_links_refs_entryKey/);
	assert.doesNotMatch(detail, /idx_plugin_storage_list|TEMP B-TREE|SCAN/);
	assert.match(plan(db, store.refsWhereSql("urlId"), "coywolf-pack", "links_refs", "u7"), /USING INDEX idx_plugin_coywolf-pack_links_refs_urlId/);
});

test("the orphan check (storage count by urlId, no ORDER BY) uses the urlId index", () => {
	const db = database();
	const sql = `SELECT COUNT(*) AS count FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND json_extract(data, '$.urlId') = ?`;
	assert.match(plan(db, sql, "coywolf-pack", "links_refs", "u7"), /USING (COVERING )?INDEX idx_plugin_coywolf-pack_links_refs_urlId/);
});

test("refsWhere reads every matching row from D1 in one statement, and falls back to storage without D1", async () => {
	const sqlite = database(50);
	const statements = [];
	globalThis.__testEnv = {
		DB: {
			prepare(sql) {
				statements.push(sql);
				return { bind: (...values) => ({ all: async () => ({ results: sqlite.prepare(sql).all(...values) }) }) };
			},
		},
	};
	const ops = new store.Ops();
	const rows = await store.refsWhere({ storage: {} }, "entryKey", "posts/3", ops);
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0].data, { entryKey: "posts/3", urlId: "u3", seenAt: "2026-01-01" });
	assert.equal(statements.length, 1);
	assert.doesNotMatch(statements[0], /ORDER BY/i);
	assert.equal(ops.used, 1);

	globalThis.__testEnv = undefined;
	const queried = [];
	const ctx = {
		storage: {
			links_refs: {
				async query(options) {
					queried.push(options.where);
					return { items: [{ id: "a", data: { entryKey: "posts/3" } }], hasMore: false };
				},
			},
		},
	};
	assert.equal((await store.refsWhere(ctx, "entryKey", "posts/3")).length, 1);
	assert.deepEqual(queried, [{ entryKey: "posts/3" }]);
});

test("the scan cleanup lists entries with references from the entryKey index, without a sort or a row scan", () => {
	const detail = plan(database(), store.referencedEntriesSql, "coywolf-pack", "links_refs");
	assert.match(detail, /USING COVERING INDEX idx_plugin_coywolf-pack_links_refs_entryKey/);
	assert.doesNotMatch(detail, /idx_plugin_storage_list|TEMP B-TREE/);
});

test("staleEntries with D1: trashed, deleted and unknown-collection entries, a few statements in all", async () => {
	const sqlite = database(0);
	sqlite.exec("CREATE TABLE ec_posts (id TEXT PRIMARY KEY, status TEXT, deleted_at TEXT)");
	sqlite.exec("INSERT INTO ec_posts VALUES ('live', 'published', NULL), ('draft', 'draft', NULL), ('trashed', 'published', '2026-10-01')");
	const insert = sqlite.prepare("INSERT INTO _plugin_storage (plugin_id, collection, id, data) VALUES ('coywolf-pack', 'links_refs', ?, ?)");
	for (const key of ["posts/live", "posts/live", "posts/draft", "posts/trashed", "posts/gone", "old/x"]) insert.run(`${key}|${Math.random()}`, JSON.stringify({ entryKey: key }));
	const statements = [];
	globalThis.__testEnv = {
		DB: {
			prepare(sql) {
				statements.push(sql);
				return { bind: (...values) => ({ all: async () => ({ results: sqlite.prepare(sql).all(...values) }) }) };
			},
		},
	};
	const ctx = {
		log: { warn() {} },
		schema: { listCollections: async () => [{ slug: "posts", label: "Posts", titleField: null, supports: [], fields: [{ slug: "body", type: "portableText" }] }] },
	};
	const ops = new store.Ops();
	const stale = await store.staleEntries(ctx, ops);
	globalThis.__testEnv = undefined;
	assert.deepEqual(stale.sort(), ["old/x", "posts/gone", "posts/trashed"]);
	assert.equal(statements.length, 2, "one DISTINCT over the index, one id lookup for the posts");
	assert.equal(ops.used, 2);
});

// Unit tests for the D1 dump: rows bigger than D1's statement limit restore intact.
// Run: node --test src/backups/dump.test.mjs   (Node 22.6+ strips the types from dump.ts)
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const { dumpDatabase, splitText, MAX_STATEMENT_BYTES, nextPageSize, PAGE_TARGET_BYTES } = await import("./dump.ts");

/** The slice of the D1 binding that dumpDatabase uses, over node:sqlite. */
function d1(db) {
	return {
		prepare(sql) {
			let params = [];
			const stmt = {
				bind(...args) {
					params = args;
					return stmt;
				},
				async all() {
					return { results: db.prepare(sql).all(...params) };
				},
			};
			return stmt;
		},
	};
}

function seed() {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT, revision INTEGER);
		CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, content TEXT, excerpt TEXT);
		CREATE TABLE log (line TEXT);`);
	const insert = (sql, ...v) => db.prepare(sql).run(...v);
	// 250 KB with quotes, CR/LF, emoji (surrogate pairs) and accents, so pieces split on awkward characters.
	const big = Array.from({ length: 5000 }, (_, i) => `Line ${i}: it's "quoted" — café 🦊\r\n`).join("");
	insert("INSERT INTO ec_posts VALUES (?, ?, ?, ?)", "p1", "long", big, big.slice(0, 120_000));
	insert("INSERT INTO ec_posts VALUES (?, ?, ?, ?)", "p2", "short", "hello\nworld", null);
	insert("INSERT INTO options VALUES (?, ?, ?)", "site:title", "Coywolf", 1);
	insert("INSERT INTO options VALUES (?, ?, ?)", "plugin:coywolf-pack:cache:discovery:llms", big, 1);
	insert("INSERT INTO log VALUES (?)", big);
	return { db, big };
}

test("oversized rows are split into statements under the limit and restore intact", async () => {
	const { db, big } = seed();
	const { sql } = await dumpDatabase(d1(db));
	const statements = sql.trim().split("\n");
	for (const s of statements) assert.ok(new TextEncoder().encode(s).length <= MAX_STATEMENT_BYTES, `statement of ${s.length} chars`);
	assert.ok(statements.some((s) => s.startsWith('UPDATE "ec_posts"')), "long post written in pieces");

	const restored = new DatabaseSync(":memory:");
	for (const s of statements) restored.exec(s);
	const post = restored.prepare("SELECT * FROM ec_posts WHERE id = 'p1'").get();
	assert.equal(post.content, big);
	assert.equal(post.excerpt, big.slice(0, 120_000));
	assert.equal(restored.prepare("SELECT content FROM ec_posts WHERE id = 'p2'").get().content, "hello\nworld");
	assert.equal(restored.prepare("SELECT line FROM log").get().line, big, "table without a primary key uses rowid");
});

test("plugin caches are left out; other options are kept", async () => {
	const { db } = seed();
	const { sql, rows } = await dumpDatabase(d1(db));
	assert.ok(!sql.includes("cache:discovery:llms"));
	assert.ok(sql.includes("site:title"));
	assert.equal(rows, 4);
});

test("splitText never cuts a surrogate pair and rejoins exactly", () => {
	const text = "🦊".repeat(40_000);
	const pieces = splitText(text);
	assert.ok(pieces.length > 1);
	assert.equal(pieces.join(""), text);
	for (const p of pieces) assert.ok(!/^[\udc00-\udfff]/.test(p));
});

test("rows are paged by rowid across pages, in rowid order, and restore intact", async () => {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, n INTEGER);
		CREATE TABLE plain (line TEXT);
		CREATE TABLE odd (oid TEXT, v INTEGER);
		CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;`);
	for (let i = 0; i < 1234; i++) {
		db.prepare("INSERT INTO items VALUES (?, ?)").run(`id-${String(1234 - i).padStart(4, "0")}`, i);
		db.prepare("INSERT INTO plain VALUES (?)").run(`line ${i}`);
		db.prepare("INSERT INTO odd VALUES (?, ?)").run(`o${i}`, i);
		db.prepare("INSERT INTO kv VALUES (?, ?)").run(`k${i}`, `v${i}`);
	}
	// Gaps in the rowids, as deletes leave them.
	db.exec("DELETE FROM items WHERE n % 7 = 0; DELETE FROM plain WHERE rowid BETWEEN 400 AND 650;");
	const queries = [];
	const binding = d1(db);
	const spy = { prepare: (sql) => (queries.push(sql), binding.prepare(sql)) };
	const { sql, rows } = await dumpDatabase(spy);
	assert.ok(queries.some((q) => /FROM "items" WHERE rowid > \? ORDER BY rowid LIMIT \?/.test(q)), "paged by rowid");
	assert.ok(queries.some((q) => /FROM "odd" ORDER BY rowid LIMIT \? OFFSET \?/.test(q)), "a column named oid falls back to OFFSET");
	assert.ok(queries.some((q) => /FROM "kv" LIMIT \? OFFSET \?/.test(q)), "WITHOUT ROWID uses OFFSET");
	assert.ok(!sql.includes("__coywolf_rowid"), "the paging cursor is never written");

	const restored = new DatabaseSync(":memory:");
	for (const s of sql.trim().split("\n")) restored.exec(s);
	for (const table of ["items", "plain", "odd", "kv"]) {
		assert.deepEqual(restored.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), table);
	}
	// Same order as before (rowid order): the n column of items rises.
	const ns = [...sql.matchAll(/INSERT INTO "items" \("id","n"\) VALUES\('[^']+',(\d+)\);/g)].map((m) => Number(m[1]));
	assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
	assert.equal(rows, db.prepare("SELECT (SELECT count(*) FROM items) + (SELECT count(*) FROM plain) + 1234 + 1234 AS n").get().n);
});

/** An R2 bucket that keeps what's put and records multipart uploads. */
function fakeBucket() {
	const store = new Map();
	const uploads = [];
	return {
		store,
		uploads,
		async put(key, body) {
			store.set(key, Buffer.from(body));
		},
		async createMultipartUpload(key) {
			const parts = [];
			const upload = { key, parts, completed: false, aborted: false };
			uploads.push(upload);
			return {
				async uploadPart(n, body) {
					parts.push({ n, size: body.byteLength, body: Buffer.from(body) });
					return { partNumber: n, etag: `e${n}` };
				},
				async complete(list) {
					upload.completed = true;
					store.set(key, Buffer.concat(list.map((p) => parts.find((x) => x.n === p.partNumber).body)));
				},
				async abort() {
					upload.aborted = true;
				},
			};
		},
	};
}

test("the dump streams into the bucket: multipart parts of one size, same bytes as the whole", async () => {
	const { writeDumpStream } = await import("./store.ts");
	const { dumpLines } = await import("./dump.ts");
	const { gunzipSync } = await import("node:zlib");
	const { createHash } = await import("node:crypto");
	const { db } = seed();
	const lines = [];
	for await (const line of dumpLines(d1(db))) lines.push(line);
	async function* replay() {
		yield* lines;
	}

	const big = fakeBucket();
	const result = await writeDumpStream(big, "2026-10-05T1200Z", "site.sql.gz", replay(), 4096);
	const stored = big.store.get("d1/2026-10-05T1200Z/site.sql.gz");
	assert.equal(big.uploads.length, 1);
	const sizes = big.uploads[0].parts.map((p) => p.size);
	assert.ok(sizes.length > 2, `${sizes.length} parts`);
	assert.ok(sizes.slice(0, -1).every((s) => s === 4096), "every part but the last is exactly one part size");
	assert.equal(result.bytes, stored.length);
	assert.equal(result.sha256, createHash("sha256").update(stored).digest("hex"));
	assert.equal(gunzipSync(stored).toString("utf8"), `${lines.join("\n")}\n`);

	const small = fakeBucket();
	await writeDumpStream(small, "2026-10-05T1200Z", "site.sql.gz", replay());
	assert.equal(small.uploads.length, 0, "under one part: a single put");
	assert.equal(gunzipSync(small.store.get("d1/2026-10-05T1200Z/site.sql.gz")).toString("utf8"), (await dumpDatabase(d1(db))).sql);
});

test("a failed dump aborts the upload and reports the dump's error", async () => {
	const { writeDumpStream } = await import("./store.ts");
	const bucket = fakeBucket();
	async function* failing() {
		for (let i = 0; i < 4000; i++) yield `${Math.random().toString(36)}${Math.random().toString(36)}`;
		throw new Error("D1 went away");
	}
	await assert.rejects(() => writeDumpStream(bucket, "2026-10-05T1200Z", "x.sql.gz", failing(), 1024), /D1 went away/);
	assert.equal(bucket.uploads.length, 1);
	assert.equal(bucket.uploads[0].aborted, true);
	assert.equal(bucket.store.size, 0);
});

test("a failed upload stops the dump instead of hanging", async () => {
	const { writeDumpStream } = await import("./store.ts");
	let aborted = false;
	const bucket = {
		async put() {},
		async createMultipartUpload() {
			return {
				uploadPart: async () => {
					throw new Error("R2 unavailable");
				},
				complete: async () => {},
				abort: async () => {
					aborted = true;
				},
			};
		},
	};
	let produced = 0;
	async function* endless() {
		for (;;) {
			produced++;
			yield `${Math.random().toString(36)}${Math.random().toString(36)}${Math.random().toString(36)}`;
		}
	}
	await assert.rejects(() => writeDumpStream(bucket, "2026-10-05T1200Z", "x.sql.gz", endless(), 1024), /R2 unavailable/);
	assert.equal(aborted, true);
	const stopped = produced;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(produced, stopped, "the dump stops reading rows");
});

test("reads are sized by bytes: big rows mean fewer rows per read, never more than 500", () => {
	assert.equal(nextPageSize(0, 0), 500);
	assert.equal(nextPageSize(500 * 200, 500), 500, "small rows: the full page");
	assert.equal(nextPageSize(10 * 1024 * 1024, 10), Math.floor(PAGE_TARGET_BYTES / (1024 * 1024)), "1 MB rows: about 8 a read");
	assert.equal(nextPageSize(50 * 1024 * 1024, 1), 1, "never below one row");
});

test("a read D1 refuses as too large is asked again for fewer rows; offset paging skips nothing", async () => {
	// 600 rows of ~40 KB each in a table paged by OFFSET (a column named rowid shadows the real one),
	// with a fake D1 that refuses any result over 5 MB, as D1 does over 50 MB.
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE odd (rowid TEXT, body TEXT)");
	const body = "x".repeat(40_000);
	for (let i = 0; i < 600; i++) db.prepare("INSERT INTO odd VALUES (?, ?)").run(`r${i}`, `${i}:${body}`);
	const base = d1(db);
	let refused = 0;
	const limited = {
		prepare(sql) {
			const stmt = base.prepare(sql);
			let params = [];
			return {
				bind(...args) {
					params = args;
					stmt.bind(...args);
					return this;
				},
				async all() {
					const out = await stmt.all();
					const size = JSON.stringify(out.results).length;
					if (/FROM "odd"/.test(sql) && size > 5_000_000) {
						refused++;
						throw new Error("D1_ERROR: result too large");
					}
					return out;
				},
			};
		},
	};
	const { sql, rows } = await dumpDatabase(limited);
	assert.ok(refused >= 1, "the first 500-row read was refused");
	assert.equal(rows, 600);
	const restored = new DatabaseSync(":memory:");
	for (const s of sql.trim().split("\n")) restored.exec(s);
	assert.equal(restored.prepare("SELECT count(*) AS n FROM odd").get().n, 600, "every row once");
	assert.equal(restored.prepare("SELECT count(DISTINCT rowid) AS n FROM odd").get().n, 600, "no row twice");
});

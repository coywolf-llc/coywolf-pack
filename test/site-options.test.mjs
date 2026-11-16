// Run: node --test test/site-options.test.mjs
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { invalidateFeatures, readSiteSetting, registerSiteSetting, siteSetting } = await import("../src/core/features.ts");
const { readSiteSettings } = await import("../src/files/site.ts");

const option = (key) => `plugin:coywolf-pack:settings:${key}`;

/** A fake D1 with an options table; counts queries and can hold them open or fail. */
function fakeDb(rows) {
	const db = {
		queries: 0,
		fail: false,
		gate: null,
		prepare(sql) {
			let args = [];
			return {
				bind(...a) {
					args = a;
					return this;
				},
				async all() {
					db.queries++;
					assert.match(sql, /WHERE name IN/);
					// What the database held when the query arrived.
					const results = args.filter((n) => n in rows).map((name) => ({ name, value: rows[name] }));
					if (db.gate) await db.gate;
					if (db.fail) throw new Error("D1 unavailable");
					return { results };
				},
			};
		},
	};
	return db;
}

test("concurrent misses share one query, and later reads come from the cache", async () => {
	invalidateFeatures();
	registerSiteSetting("testA");
	registerSiteSetting("testB");
	const db = fakeDb({ [option("testA")]: '"a"', [option("testB")]: "42" });
	let open;
	db.gate = new Promise((resolve) => (open = resolve));
	const pending = Promise.all([readSiteSetting("testA", db), readSiteSetting("testB", db), readSiteSetting("testA", db)]);
	open();
	assert.deepEqual(await pending, [{ value: "a" }, { value: 42 }, { value: "a" }]);
	assert.equal(db.queries, 1);
	assert.equal(await siteSetting("testB", db), 42);
	assert.equal(db.queries, 1);
});

test("a key registered after the first read is fetched, not reported unset", async () => {
	invalidateFeatures();
	const db = fakeDb({ [option("lateKey")]: '"late"' });
	await readSiteSetting("testA", db);
	assert.equal(db.queries, 1);
	assert.deepEqual(await readSiteSetting("lateKey", db), { value: "late" });
	assert.equal(db.queries, 2);
	assert.deepEqual(await readSiteSetting("lateKey", db), { value: "late" });
	assert.equal(db.queries, 2);
});

test("an unreadable database reads as null (not unset) and isn't cached", async () => {
	invalidateFeatures();
	const db = fakeDb({ [option("testA")]: '"a"' });
	db.fail = true;
	assert.equal(await readSiteSetting("testA", db), null);
	assert.equal(await siteSetting("testA", db), null);
	db.fail = false;
	assert.deepEqual(await readSiteSetting("testA", db), { value: "a" });
});

test("a save during a read: the stale read isn't cached", async () => {
	invalidateFeatures();
	const rows = { [option("testA")]: '"old"' };
	const db = fakeDb(rows);
	let open;
	db.gate = new Promise((resolve) => (open = resolve));
	const stale = readSiteSetting("testA", db);
	// Reads go out with the others of their tick (src/core/d1-batch.ts): let this one reach the database.
	await new Promise((resolve) => setTimeout(resolve, 5));
	rows[option("testA")] = '"new"';
	invalidateFeatures();
	db.gate = null;
	open();
	assert.deepEqual(await stale, { value: "old" });
	assert.deepEqual(await readSiteSetting("testA", db), { value: "new" });
});

test("a save during a plugin-context read: cachedCtxFeatures doesn't cache the stale switches", async () => {
	const { cachedCtxFeatures } = await import("../src/core/features.ts");
	await import("../src/search/pack.ts"); // Registers the "search" switch.
	invalidateFeatures();
	let stored = { search: false };
	let open;
	const gate = new Promise((resolve) => (open = resolve));
	let reads = 0;
	const ctx = {
		settings: {
			get: async (key) => {
				if (key !== "features") return null;
				reads++;
				const value = stored;
				if (reads === 1) await gate;
				return value;
			},
		},
	};
	const stale = cachedCtxFeatures(ctx);
	stored = { search: true };
	invalidateFeatures(); // Saved while the first read was in flight.
	open();
	assert.equal((await stale).search, false, "the in-flight read still answers its caller");
	assert.equal((await cachedCtxFeatures(ctx)).search, true, "but wasn't cached over the save");
	assert.equal(reads, 2);
	assert.equal((await cachedCtxFeatures(ctx)).search, true);
	assert.equal(reads, 2, "a read with no save in between is cached");
	invalidateFeatures();
});

test("File Downloads settings come from the shared read with their defaults", async () => {
	invalidateFeatures();
	const db = fakeDb({ [option("filesBase")]: '"get"', [option("filesScheme")]: '"dark"', [option("filesAccent")]: '"#123456"' });
	const settings = await readSiteSettings(db);
	assert.equal(settings.scheme, "dark");
	assert.equal(settings.accent, "#123456");
	assert.equal(settings.publicBaseUrl, "");
	assert.equal(await readSiteSettings(db), settings);
	assert.equal(db.queries, 1);
});

test("File Downloads settings, strict (Buttondown Drafts): an unreadable database rejects; without strict it's the defaults, as before", async () => {
	invalidateFeatures();
	const db = fakeDb({ [option("filesBase")]: '"get"', [option("filesScheme")]: '"dark"' });
	db.fail = true;
	const error = console.error;
	console.error = () => {};
	try {
		await assert.rejects(readSiteSettings(db, true), /couldn't be read/);
		const defaults = await readSiteSettings(db);
		assert.equal(defaults.scheme, "auto");
		assert.equal(defaults.publicBaseUrl, "");
	} finally {
		console.error = error;
	}
	// Readable: strict changes nothing.
	db.fail = false;
	invalidateFeatures();
	const strict = await readSiteSettings(db, true);
	assert.equal(strict.scheme, "dark");
	assert.equal(await readSiteSettings(db), strict);
});

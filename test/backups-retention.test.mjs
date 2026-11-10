// Run: node --test test/backups-retention.test.mjs
//
// Retention on Cloudflare (src/backups/retention.ts and its routes in src/backups/module.ts): the
// pack's lifecycle and lock rules, merged with the bucket's own; what a bucket's rules do to the
// backups; the bucket check; the daily task skipping its pruning once a lifecycle rule does it; and
// a backup writing its manifest once when d1/ is locked.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import "./ts-resolve.mjs";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: "data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = () => {};", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const R = await import("../src/backups/retention.ts");
const { backupsModule, RETENTION_STATE_KEY, RETENTION_SETTINGS } = await import("../src/backups/module.ts");

const DAY = 86_400;

test("the pack's lifecycle rules cover only what ages out, at the retention days", () => {
	const rules = R.retentionRules(30);
	assert.deepEqual(rules.map((r) => r.conditions.prefix), ["d1/", "media/changed/", "uploads/changed/", "mirrors/"], "plus the mirror counts kept beside locked manifests");
	for (const rule of rules) {
		assert.equal(rule.enabled, true);
		assert.deepEqual(rule.deleteObjectsTransition, { condition: { type: "Age", maxAge: 30 * DAY } });
		assert.match(rule.id, /^coywolf-pack-backups-retention:/);
	}
	// A dump upload cut off midway is aborted even if the bucket's default rule is gone.
	assert.deepEqual(rules[0].abortMultipartUploadsTransition, { condition: { type: "Age", maxAge: 7 * DAY } });
	assert.ok(!rules.some((r) => /current/.test(r.conditions.prefix)), "the mirrors are never in a rule");
	const locks = R.lockRules(30);
	assert.deepEqual(locks.map((r) => [r.prefix, r.condition]), R.RETENTION_PREFIXES.map((p) => [p, { type: "Age", maxAgeSeconds: 30 * DAY }]));
});

test("merging keeps the bucket's own rules and replaces only the pack's", () => {
	const theirs = { id: "Default Multipart Abort Rule", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * DAY } } };
	const merged = R.mergeRules([theirs, ...R.retentionRules(14)], R.retentionRules(30));
	assert.equal(merged.length, 5);
	assert.deepEqual(merged[0], theirs);
	assert.ok(merged.slice(1).every((r) => r.deleteObjectsTransition.condition.maxAge === 30 * DAY));
	assert.deepEqual(R.mergeRules([theirs, ...R.retentionRules(14)], []), [theirs], "removing leaves only theirs");
});

test("what a bucket's rules do to the backups", () => {
	const on = R.retentionStatus(R.retentionRules(30), [], 30);
	assert.equal(on.lifecycle, "on");
	assert.equal(on.coveredDays, 30);
	assert.equal(on.ours, true);
	assert.equal(R.pruningRedundant(on, 30), true);

	const different = R.retentionStatus(R.retentionRules(60), [], 30);
	assert.equal(different.lifecycle, "different");
	assert.equal(R.pruningRedundant(different, 30), false, "a rule that keeps backups longer than the setting: the pack still prunes");
	// A rule that deletes sooner than the setting (Keep backups for raised after it was set) is a mismatch, not "on".
	assert.equal(R.pruningRedundant(R.retentionStatus(R.retentionRules(7), [], 30), 30), false);
	assert.equal(R.deletesSooner(R.retentionStatus(R.retentionRules(7), [], 30), 30), true);
	assert.equal(R.deletesSooner(R.retentionStatus(R.retentionRules(60), [], 30), 30), false);
	// A rule that deletes on a fixed date isn't coverage, and is flagged.
	const dated = R.retentionStatus([{ id: "purge 2027", enabled: true, conditions: { prefix: "d1/" }, deleteObjectsTransition: { condition: { type: "Date", date: "2027-01-01T00:00:00Z" } } }], [], 30);
	assert.equal(dated.dateDeletes, true);
	assert.equal(dated.byPrefix["d1/"], null);
	assert.equal(R.pruningRedundant(dated, 30), false);

	assert.equal(R.retentionStatus(R.retentionRules(30).slice(0, 1), [], 30).lifecycle, "partial");
	assert.equal(R.pruningRedundant(R.retentionStatus(R.retentionRules(30).slice(0, 1), [], 30), 30), false);
	const off = R.retentionStatus([], [], 30);
	assert.equal(off.lifecycle, "off");
	assert.equal(R.pruningRedundant(off, 30), false);
	assert.equal(R.pruningRedundant(null, 30), false);

	// Someone's own whole-bucket rule counts for the backups, and is flagged: it deletes the mirrors too.
	const wholeBucket = R.retentionStatus([{ id: "expire everything", enabled: true, conditions: { prefix: "" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * DAY } } }], [], 30);
	assert.equal(wholeBucket.lifecycle, "on");
	assert.equal(wholeBucket.ours, false);
	assert.equal(wholeBucket.mirrorDeleted, true);
	// A disabled rule doesn't count.
	assert.equal(R.retentionStatus(R.retentionRules(30).map((r) => ({ ...r, enabled: false })), [], 30).lifecycle, "off");

	// Locks: the pack's, and others that reach the mirrors or d1/.
	const locked = R.retentionStatus(R.retentionRules(30), R.lockRules(30), 30);
	assert.equal(locked.lockDays, 30);
	assert.equal(locked.d1Locked, true);
	assert.equal(locked.mirrorLocked, false);
	const theirLock = R.retentionStatus([], [{ id: "keep all", enabled: true, condition: { type: "Indefinite" } }], 30);
	assert.equal(theirLock.lockDays, null);
	assert.equal(theirLock.mirrorLocked, true);
	assert.equal(theirLock.d1Locked, true);
	assert.equal(theirLock.otherLocks, 1);
});

/** Cloudflare's API for one bucket: its lifecycle and lock rules, and the objects its binding wrote. */
function cloudflare({ lifecycle = [], locks = [], keys = () => [] } = {}) {
	const calls = [];
	const state = { lifecycle, locks };
	const fetch = async (url, init = {}) => {
		const u = new URL(url);
		calls.push(`${init.method ?? "GET"} ${u.pathname}${u.search}`);
		const json = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200, headers: { "content-type": "application/json" } });
		if (!init.headers?.Authorization?.endsWith("tok-123")) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
		if (u.pathname.endsWith("/lifecycle")) {
			if (init.method === "PUT") state.lifecycle = JSON.parse(init.body).rules;
			return json(init.method === "PUT" ? {} : { rules: state.lifecycle });
		}
		if (u.pathname.endsWith("/lock")) {
			if (init.method === "PUT") state.locks = JSON.parse(init.body).rules;
			return json(init.method === "PUT" ? {} : { rules: state.locks });
		}
		if (u.pathname.endsWith("/objects")) return json(keys().filter((k) => k.startsWith(u.searchParams.get("prefix"))).map((key) => ({ key })));
		return new Response("not found", { status: 404 });
	};
	return { fetch, calls, state };
}

test("the API calls: the bucket's lifecycle and lock rules, read and replaced, and the object check", async () => {
	const cf = cloudflare({ keys: () => ["coywolf-pack/bucket-check/x.txt"] });
	const access = { token: "tok-123", accountId: "a".repeat(32), bucket: "coywolf-backups", fetch: cf.fetch };
	assert.deepEqual(await R.getLifecycle(access), []);
	await R.putLifecycle(access, R.retentionRules(30));
	assert.equal((await R.getLifecycle(access)).length, 4);
	await R.putLocks(access, R.lockRules(30));
	assert.equal((await R.getLocks(access)).length, 3);
	assert.equal(await R.bucketHasKey(access, "coywolf-pack/bucket-check/x.txt"), true);
	assert.equal(await R.bucketHasKey(access, "coywolf-pack/bucket-check/y.txt"), false);
	assert.ok(cf.calls.includes(`PUT /client/v4/accounts/${"a".repeat(32)}/r2/buckets/coywolf-backups/lifecycle`));
	await assert.rejects(R.getLifecycle({ ...access, token: "wrong" }), /Workers R2 Storage → Edit/);
});

// ── The routes and the daily task ─────────────────────────────

/** An R2 bucket in memory: what the backups module uses. */
function bucket() {
	const store = new Map();
	const refused = new Set();
	return {
		store,
		refused,
		async put(key, body) {
			if (refused.has(key) && store.has(key)) throw new Error("ObjectLockedByBucketPolicy");
			store.set(key, typeof body === "string" ? body : "stream");
			return { key };
		},
		async get(key) {
			return store.has(key) ? { body: store.get(key), json: async () => JSON.parse(store.get(key)), httpMetadata: {} } : null;
		},
		async delete(keys) {
			for (const k of [].concat(keys)) store.delete(k);
		},
		async list({ prefix = "", delimiter } = {}) {
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			if (delimiter) return { objects: [], delimitedPrefixes: [...new Set(keys.map((k) => k.slice(prefix.length)).filter((k) => k.includes(delimiter)).map((k) => prefix + k.split(delimiter)[0] + delimiter))], truncated: false };
			return { objects: keys.map((key) => ({ key, etag: key })), truncated: false };
		},
	};
}

function context(cf, settings = {}) {
	const kv = new Map();
	const stored = new Map(Object.entries(settings));
	const logs = [];
	return {
		kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) },
		settings: { get: async (k) => stored.get(k) ?? null, set: async (k, v) => void stored.set(k, v), delete: async (k) => void stored.delete(k) },
		http: { fetch: cf.fetch },
		log: { info: (m, d) => logs.push(["info", m, d]), warn: (m, d) => logs.push(["warn", m, d]) },
		cron: { schedule: async () => {} },
		kvMap: kv,
		stored,
		logs,
	};
}

const ACCOUNT = "b".repeat(32);

test("check: the bucket named must be the one bound as BACKUPS, then its rules are read and remembered", async () => {
	const backups = bucket();
	globalThis.__testEnv = { DB: {}, MEDIA: bucket(), BACKUPS: backups };
	const cf = cloudflare({ keys: () => [...backups.store.keys()] });
	const { routes } = backupsModule({ name: "coywolf" });
	const ctx = context(cf);
	const state = await routes["backups/cloudflare/check"].handler({ ...ctx, input: { accountId: ACCOUNT, bucket: "coywolf-backups", token: "tok-123" } });
	assert.equal(state.bucket, "coywolf-backups");
	assert.equal(state.status.lifecycle, "off");
	assert.deepEqual(ctx.kvMap.get(RETENTION_STATE_KEY), state);
	assert.equal(ctx.stored.get(RETENTION_SETTINGS.bucket), "coywolf-backups", "the account and bucket that worked are saved");
	assert.equal(ctx.stored.get(RETENTION_SETTINGS.token), undefined, "the token isn't saved unless asked");
	assert.ok(![...backups.store.keys()].some((k) => k.startsWith(R.PROBE_PREFIX)), "the probe is deleted");

	// Another site's bucket (the probe isn't there): refused, nothing changed.
	const other = cloudflare({ keys: () => [] });
	const ctx2 = context(other);
	await assert.rejects(
		routes["backups/cloudflare/check"].handler({ ...ctx2, input: { accountId: ACCOUNT, bucket: "wellbeing-backups", token: "tok-123" } }),
		/isn't the one bound as BACKUPS/,
	);
	assert.equal(ctx2.kvMap.get(RETENTION_STATE_KEY), undefined);
	assert.ok(!other.calls.some((c) => c.startsWith("PUT")));
});

test("apply: sets the rule to the retention days, keeps the bucket's own rules, and locks only with LOCK typed", async () => {
	const backups = bucket();
	globalThis.__testEnv = { DB: {}, MEDIA: bucket(), BACKUPS: backups, BACKUPS_API_TOKEN: "tok-123" };
	const theirs = { id: "Default Multipart Abort Rule", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * DAY } } };
	const cf = cloudflare({ lifecycle: [theirs], keys: () => [...backups.store.keys()] });
	const { routes } = backupsModule({ name: "coywolf", restore: { accountId: ACCOUNT, databaseId: "d" } });
	const ctx = context(cf, { backupsRetentionDays: 21, [RETENTION_SETTINGS.bucket]: "coywolf-backups" });
	// The token comes from the restore token's Worker secret, the account from backups.restore.
	await assert.rejects(routes["backups/cloudflare/apply"].handler({ ...ctx, input: { lock: true } }), /Type LOCK/);
	const state = await routes["backups/cloudflare/apply"].handler({ ...ctx, input: { lock: false } });
	assert.equal(state.status.lifecycle, "on");
	assert.equal(state.status.coveredDays, 21);
	assert.deepEqual(cf.state.lifecycle[0], theirs, "the bucket's own rule is kept");
	assert.equal(cf.state.lifecycle.length, 5);
	assert.ok(!cf.calls.some((c) => c.startsWith("PUT") && c.endsWith("/lock")), "no lock call without a lock");

	const locked = await routes["backups/cloudflare/apply"].handler({ ...ctx, input: { lock: true, confirm: "LOCK" } });
	assert.equal(locked.status.lockDays, 21);
	assert.equal(cf.state.locks.length, 3);

	// Unticking the lock removes the pack's lock rules (and only those).
	cf.state.locks.push({ id: "their lock", enabled: true, prefix: "legal/", condition: { type: "Indefinite" } });
	const unlocked = await routes["backups/cloudflare/apply"].handler({ ...ctx, input: { lock: false } });
	assert.equal(unlocked.status.lockDays, null);
	assert.deepEqual(cf.state.locks.map((r) => r.id), ["their lock"]);

	// Remove: the pack's lifecycle rules go, theirs stay.
	const removed = await routes["backups/cloudflare/remove"].handler({ ...ctx, input: {} });
	assert.equal(removed.status.lifecycle, "off", "their default rule only aborts unfinished uploads: nothing deletes backups now");
	assert.equal(removed.status.ours, false);
	assert.deepEqual(cf.state.lifecycle, [theirs]);
});

test("the daily task skips its pruning while the bucket's rule does it, and prunes again when it doesn't", async () => {
	const backups = bucket();
	backups.store.set("d1/2020-01-01T0000Z/manifest.json", "{}");
	backups.store.set("d1/2020-01-01T0000Z/coywolf.sql.gz", "x");
	globalThis.__testEnv = { DB: {}, MEDIA: bucket(), BACKUPS: backups };
	const { daily } = backupsModule({ name: "coywolf" });

	// A fresh look found the rule, on the bucket the binding writes to (its marker): nothing deleted by the site.
	const cf = cloudflare();
	const ctx = context(cf);
	ctx.kvMap.set(RETENTION_STATE_KEY, { checkedAt: new Date().toISOString(), bucket: "b", retentionDays: 30, status: R.retentionStatus(R.retentionRules(30), [], 30) });
	backups.store.set(R.BUCKET_MARKER, JSON.stringify({ bucket: "b" }));
	const warnings = [];
	ctx.log.warn = (m) => warnings.push(m);
	await daily(ctx);
	assert.ok(backups.store.has("d1/2020-01-01T0000Z/manifest.json"), "left to the lifecycle rule");
	assert.ok(warnings.some((m) => /older than half the retention days/.test(m)), "the newest backup is years old: the log warns");

	// The BACKUPS binding now points at another bucket (no marker for "b" there): the site prunes again.
	backups.store.set(R.BUCKET_MARKER, JSON.stringify({ bucket: "another" }));
	const { routes } = backupsModule({ name: "coywolf" });
	const kept = await routes["backups/list"].handler(ctx);
	assert.equal(kept.items.length, 1);
	backups.store.set("d1/2020-01-01T0000Z/manifest.json", "{}");
	await daily(ctx);
	assert.ok(!backups.store.has("d1/2020-01-01T0000Z/manifest.json"), "pruned: the rule was checked on another bucket");
	backups.store.set("d1/2020-01-01T0000Z/manifest.json", "{}");
	backups.store.set(R.BUCKET_MARKER, JSON.stringify({ bucket: "b" }));

	// The setting raised to 90 while the rule still deletes at 30: not covered, the site prunes (and the card warns).
	ctx.stored.set("backupsRetentionDays", 90);
	await daily(ctx);
	assert.ok(!backups.store.has("d1/2020-01-01T0000Z/manifest.json"), "pruned at 90 days: the 2020 backup is older");
	ctx.stored.delete("backupsRetentionDays");
	backups.store.set("d1/2020-01-01T0000Z/manifest.json", "{}");

	// A look older than a week (no token to look again): the site prunes, as before.
	ctx.kvMap.set(RETENTION_STATE_KEY, { checkedAt: new Date(Date.now() - 8 * DAY * 1000).toISOString(), bucket: "b", retentionDays: 30, status: R.retentionStatus(R.retentionRules(30), [], 30) });
	await daily(ctx);
	assert.ok(!backups.store.has("d1/2020-01-01T0000Z/manifest.json"), "pruned");
});

test("the daily task looks at the rule again when it has a token, and prunes when the rule is gone", async () => {
	const backups = bucket();
	backups.store.set("d1/2020-01-01T0000Z/manifest.json", "{}");
	globalThis.__testEnv = { DB: {}, MEDIA: bucket(), BACKUPS: backups };
	const cf = cloudflare({ lifecycle: [] });
	const { daily } = backupsModule({ name: "coywolf" });
	const ctx = context(cf, { [RETENTION_SETTINGS.token]: "tok-123", [RETENTION_SETTINGS.accountId]: ACCOUNT, [RETENTION_SETTINGS.bucket]: "coywolf-backups" });
	ctx.kvMap.set(RETENTION_STATE_KEY, { checkedAt: new Date(Date.now() - 2 * DAY * 1000).toISOString(), bucket: "coywolf-backups", retentionDays: 30, status: R.retentionStatus(R.retentionRules(30), [], 30) });
	await daily(ctx);
	assert.ok(cf.calls.some((c) => c.endsWith("/lifecycle")), "it read the rules again");
	assert.equal(ctx.kvMap.get(RETENTION_STATE_KEY).status.lifecycle, "off");
	assert.ok(!backups.store.has("d1/2020-01-01T0000Z/manifest.json"), "the rule was removed in the dashboard: the site prunes again");
});

test("a manual backup applies the same trust window: a look older than a week means the site prunes", async () => {
	const backups = bucket();
	backups.store.set("d1/2020-01-01T0000Z/manifest.json", "{}");
	backups.store.set(R.BUCKET_MARKER, JSON.stringify({ bucket: "b" }));
	const { DatabaseSync } = await import("node:sqlite");
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT);");
	globalThis.__testEnv = { DB: sqliteD1(sqlite), MEDIA: bucket(), BACKUPS: streamingBucket(backups) };
	const { routes } = backupsModule({ name: "coywolf", uploads: false });
	const ctx = context(cloudflare());
	ctx.kvMap.set(RETENTION_STATE_KEY, { checkedAt: new Date(Date.now() - 8 * DAY * 1000).toISOString(), bucket: "b", retentionDays: 30, status: R.retentionStatus(R.retentionRules(30), [], 30) });
	await routes["backups/run"].handler({ ...ctx, input: undefined });
	assert.ok(!backups.store.has("d1/2020-01-01T0000Z/manifest.json"), "pruned");
});

test("saving a new Keep backups for moves the pack's rule (and its lock) with it, or says it couldn't", async () => {
	const backups = bucket();
	globalThis.__testEnv = { DB: {}, MEDIA: bucket(), BACKUPS: backups };
	const cf = cloudflare({ lifecycle: R.retentionRules(30), locks: R.lockRules(30), keys: () => [...backups.store.keys()] });
	const { routes } = backupsModule({ name: "coywolf" });
	const ctx = context(cf, { [RETENTION_SETTINGS.token]: "tok-123", [RETENTION_SETTINGS.accountId]: ACCOUNT, [RETENTION_SETTINGS.bucket]: "coywolf-backups" });
	ctx.kvMap.set(RETENTION_STATE_KEY, { checkedAt: new Date().toISOString(), bucket: "coywolf-backups", retentionDays: 30, status: R.retentionStatus(R.retentionRules(30), R.lockRules(30), 30) });
	const saved = await routes["backups/settings/save"].handler({ ...ctx, input: { scheduled: false, retentionDays: 90, staleAfterHours: 36 } });
	assert.equal(saved.retentionWarning, undefined);
	assert.ok(cf.state.lifecycle.filter((r) => r.id.startsWith("coywolf-pack-backups-retention:")).every((r) => r.deleteObjectsTransition.condition.maxAge === 90 * DAY));
	assert.ok(cf.state.locks.every((r) => r.condition.maxAgeSeconds === 90 * DAY), "the lock follows");
	assert.equal(ctx.kvMap.get(RETENTION_STATE_KEY).status.byPrefix["d1/"], 90);

	// No token anywhere: the save goes through, and says the rule still deletes sooner.
	const ctx2 = context(cloudflare({ lifecycle: R.retentionRules(30) }));
	ctx2.kvMap.set(RETENTION_STATE_KEY, { checkedAt: new Date().toISOString(), bucket: "coywolf-backups", retentionDays: 30, status: R.retentionStatus(R.retentionRules(30), [], 30) });
	const warned = await routes["backups/settings/save"].handler({ ...ctx2, input: { scheduled: false, retentionDays: 90, staleAfterHours: 36 } });
	assert.match(warned.retentionWarning, /still deletes backups after 30 days/);
	assert.equal(warned.retentionDays, 90);
});

test("the card's summary: only an exact match is On, a rule that deletes sooner is called out, and stopped backups are warned about", async () => {
	const { lifecycleSummary, backupsStoppedWarning } = await import("../src/admin/backups-retention-core.ts");
	const state = (d) => ({ status: R.retentionStatus(R.retentionRules(d), [], 30) });
	assert.equal(lifecycleSummary(state(30), 30).badge, "On");
	assert.equal(lifecycleSummary(state(30), 90).badge, "Deletes sooner");
	assert.match(lifecycleSummary(state(30), 90).text, /sooner than Keep backups for \(90 days\)/);
	assert.equal(lifecycleSummary(state(90), 30).badge, "Different");
	assert.equal(lifecycleSummary({ status: R.retentionStatus([], [], 30) }, 30).badge, "Off");
	assert.equal(lifecycleSummary(null, 30).badge, "Not checked");
	const now = Date.parse("2026-11-10T00:00:00Z");
	assert.equal(backupsStoppedWarning("2026-11-09T00:00:00Z", 30, true, now), null);
	assert.match(backupsStoppedWarning("2026-10-20T00:00:00Z", 30, true, now), /21 days old/);
	assert.equal(backupsStoppedWarning("2026-10-20T00:00:00Z", 30, false, now), null, "without the rule the site keeps the last backups when they fail");
	assert.match(backupsStoppedWarning(null, 30, true, now), /no backups/);
});

test("pruning leaves a folder R2 refuses to delete (a longer lock) and prunes the rest", async () => {
	const { pruneBackups } = await import("../src/backups/store.ts");
	const backups = bucket();
	backups.store.set("d1/2020-01-01T0000Z/manifest.json", "{}");
	backups.store.set("d1/2020-01-02T0000Z/manifest.json", "{}");
	const remove = backups.delete.bind(backups);
	backups.delete = async (keys) => {
		if ([].concat(keys).some((k) => k.startsWith("d1/2020-01-01"))) throw new Error("ObjectLockedByBucketPolicy");
		return remove(keys);
	};
	const warn = console.warn;
	console.warn = () => {};
	try {
		assert.equal(await pruneBackups(backups, 1), 1);
	} finally {
		console.warn = warn;
	}
	assert.ok(backups.store.has("d1/2020-01-01T0000Z/manifest.json"));
	assert.ok(!backups.store.has("d1/2020-01-02T0000Z/manifest.json"));
});

/** A D1 binding over node:sqlite, as the dump reads it. */
function sqliteD1(sqlite) {
	return {
		prepare(sql) {
			let params = [];
			const stmt = {
				bind: (...args) => ((params = args), stmt),
				all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
				first: async () => sqlite.prepare(sql).get(...params) ?? null,
				raw: async () => sqlite.prepare(sql).all(...params).map((r) => Object.values(r)),
			};
			return stmt;
		},
	};
}

/** The in-memory bucket, reading streamed bodies (the dump) before storing them. */
function streamingBucket(backups, onPut = () => {}) {
	const put = backups.put.bind(backups);
	backups.put = async (key, body, opts) => {
		onPut(key, body);
		if (typeof body?.getReader === "function") await new Response(body).arrayBuffer();
		return put(key, body, opts);
	};
	return backups;
}

test("the manifest is written right after the dump; with d1/ locked, the mirror counts go to mirrors/<stamp>.json instead of a rewrite", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { listBackups, MIRRORS_PREFIX } = await import("../src/backups/store.ts");
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT); INSERT INTO options VALUES ('site:title', 'Coywolf');");
	for (const locked of [false, true]) {
		const writes = [];
		const backups = streamingBucket(bucket(), (key, body) => key.endsWith("manifest.json") && writes.push(JSON.parse(body)));
		const media = bucket();
		media.store.set("photo.jpg", "P");
		globalThis.__testEnv = { DB: sqliteD1(sqlite), MEDIA: media, BACKUPS: backups };
		const { routes } = backupsModule({ name: "coywolf", uploads: false });
		const ctx = context(cloudflare());
		if (locked) ctx.kvMap.set(RETENTION_STATE_KEY, { checkedAt: new Date().toISOString(), bucket: "b", retentionDays: 30, status: R.retentionStatus([], R.lockRules(30), 30) });
		const manifest = await routes["backups/run"].handler({ ...ctx, input: undefined });
		assert.equal(manifest.media?.total, 1, `${locked ? "locked" : "unlocked"}: the run reports the media counts`);
		assert.equal(writes[0].file, "coywolf.sql.gz");
		assert.equal(writes[0].media, undefined, "the first manifest is written before the mirrors");
		assert.equal(writes.length, locked ? 1 : 2, locked ? "never rewritten under a lock" : "rewritten with the media counts");
		const sidecars = [...backups.store.keys()].filter((k) => k.startsWith(MIRRORS_PREFIX));
		assert.equal(sidecars.length, locked ? 1 : 0);
		// Either way the listing shows the counts.
		const [listed] = await listBackups(backups);
		assert.equal(listed.media?.total, 1);
	}
});

test("a backup cut off in the middle of its mirrors is still listed (the manifest came first)", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { listBackups } = await import("../src/backups/store.ts");
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT);");
	const backups = streamingBucket(bucket());
	const media = bucket();
	media.list = () => new Promise(() => {}); // The Worker is stopped while the mirror lists the media bucket.
	globalThis.__testEnv = { DB: sqliteD1(sqlite), MEDIA: media, BACKUPS: backups };
	const { routes } = backupsModule({ name: "coywolf", uploads: false });
	const ctx = context(cloudflare());
	ctx.kvMap.set(RETENTION_STATE_KEY, { checkedAt: new Date().toISOString(), bucket: "b", retentionDays: 30, status: R.retentionStatus([], R.lockRules(30), 30) });
	void routes["backups/run"].handler({ ...ctx, input: undefined });
	for (let i = 0; i < 100 && !(await listBackups(backups)).length; i++) await new Promise((r) => setTimeout(r, 5));
	const listed = await listBackups(backups);
	assert.equal(listed.length, 1, "listed (and restorable) although the run never finished");
	assert.equal(listed[0].file, "coywolf.sql.gz");
});

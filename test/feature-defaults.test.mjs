// Run: node --test test/feature-defaults.test.mjs
//
// Redirect Manager, Slug changes and Backups start off on new sites from 0.36.0, while
// sites set up earlier keep them as they were (src/core/features.ts: legacyDefault,
// DEFAULTS_RECORDED, recordDefaults). The migration runs on EmDash's real plugin manager
// and schema (in-memory SQLite), the way a site's first boot or upgrade runs it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { DEFAULTS_RECORDED, FEATURES_SETTING, invalidateFeatures, recordDefaults, registerFeatures, resolveFeatures, siteFeatures, withRecordedDefaults } = await import("../src/core/features.ts");

// Stand-ins with the same shape as the real three (two on before 0.36.0, one of them a part), and one that was always off.
registerFeatures([
	{ id: "cwRedirects", label: "Redirect Manager", description: "", default: false, legacyDefault: true },
	{ id: "cwRedirects.slugs", label: "Slug changes", description: "", default: false, legacyDefault: true },
	{ id: "cwBackups", label: "Backups", description: "", default: false, legacyDefault: true },
	{ id: "cwSchema", label: "Schema & Social", description: "", default: false },
]);

const pick = (features) => ({ redirects: features.cwRedirects, slugs: features["cwRedirects.slugs"], backups: features.cwBackups, schema: features.cwSchema });

test("unrecorded switches keep the pre-0.36.0 defaults: no row, an empty map, a failed read", () => {
	for (const stored of [null, undefined, {}, { cwSchema: true }]) {
		assert.deepEqual(pick(resolveFeatures(stored)), { redirects: true, slugs: true, backups: true, schema: stored?.cwSchema ?? false }, JSON.stringify(stored));
	}
	// A stored choice still wins, and a part is off while its module is.
	assert.deepEqual(pick(resolveFeatures({ cwRedirects: false })), { redirects: false, slugs: false, backups: true, schema: false });
});

test("once recorded, the new defaults apply to whatever the site hasn't chosen", () => {
	assert.deepEqual(pick(resolveFeatures({ [DEFAULTS_RECORDED]: true })), { redirects: false, slugs: false, backups: false, schema: false });
	assert.deepEqual(pick(resolveFeatures({ [DEFAULTS_RECORDED]: true, cwRedirects: true })), { redirects: true, slugs: false, backups: false, schema: false });
	assert.equal(resolveFeatures({ [DEFAULTS_RECORDED]: true })[DEFAULTS_RECORDED], undefined, "the marker isn't a feature");
});

test("recording an existing site stores what it had; a new site gets only the marker", () => {
	const existing = withRecordedDefaults({ cwSchema: true, cwBackups: false }, true);
	assert.deepEqual(existing, { cwSchema: true, cwBackups: false, cwRedirects: true, "cwRedirects.slugs": true, [DEFAULTS_RECORDED]: true });
	assert.deepEqual(pick(resolveFeatures(existing)), { redirects: true, slugs: true, backups: false, schema: true }, "the same as before recording");
	assert.deepEqual(pick(resolveFeatures(existing)), pick(resolveFeatures({ cwSchema: true, cwBackups: false })));

	// The module was off: its part is recorded on (as its old default), so it stays off now and comes back as it was if the module is turned on.
	const off = withRecordedDefaults({ cwRedirects: false }, true);
	assert.equal(off["cwRedirects.slugs"], true);
	assert.deepEqual(pick(resolveFeatures(off)), pick(resolveFeatures({ cwRedirects: false })));

	assert.deepEqual(withRecordedDefaults(null, false), { [DEFAULTS_RECORDED]: true });
	const done = { [DEFAULTS_RECORDED]: true, cwRedirects: false };
	assert.equal(withRecordedDefaults(done, true), done, "already recorded: unchanged");
});

// ── On EmDash's plugin manager ─────────────────────────────────

const PLUGIN_ID = "coywolf-pack";

/**
 * A fresh EmDash database, optionally with rows a site already has, booted the way EmDash's runtime boots a
 * config plugin with no _plugin_state row (test/emdash-contract.test.mjs checks it does): plugin:install, then
 * plugin:activate, here with the calls compose.ts makes in them, on the context EmDash's plugin manager builds.
 */
async function site(seed = async () => {}) {
	const { Kysely, sql } = await import("kysely");
	const { createDialect } = await import("emdash/db/sqlite");
	const { runMigrations } = await import("emdash/db");
	const { createPluginManager } = await import("emdash");
	const db = new Kysely({ dialect: createDialect({ url: ":memory:" }) });
	await runMigrations(db);
	await seed(db, sql);
	let ctx;
	const manager = createPluginManager({ db });
	manager.register({
		id: PLUGIN_ID,
		version: "0.36.0",
		capabilities: [],
		storage: { redirectsRemoved: { indexes: [] } },
		hooks: { cron: { handler: async (_event, context) => void (ctx = context) } },
	});
	await manager.activate(PLUGIN_ID);
	await manager.invokeCronHook(PLUGIN_ID, { name: "boot", scheduledAt: new Date().toISOString() });
	assert.ok(ctx, "EmDash's plugin manager didn't hand the plugin a context");
	await recordDefaults(ctx, { fresh: true }); // plugin:install
	await recordDefaults(ctx); // plugin:activate
	const stored = async () => {
		const { rows } = await sql`SELECT value FROM options WHERE name = ${`plugin:${PLUGIN_ID}:settings:${FEATURES_SETTING}`}`.execute(db);
		return rows[0] ? JSON.parse(rows[0].value) : null;
	};
	return { db, ctx, stored, close: () => db.destroy() };
}

test("a new site: plugin:install finds nothing of the pack's and records the new defaults (all three off)", async () => {
	const s = await site();
	try {
		assert.deepEqual(await s.stored(), { [DEFAULTS_RECORDED]: true });
		assert.deepEqual(pick(resolveFeatures(await s.stored())), { redirects: false, slugs: false, backups: false, schema: false });
	} finally {
		await s.close();
	}
});

test("an existing site with saved switches keeps all three on, and its own choices", async () => {
	const s = await site(async (db, sql) => {
		await sql`INSERT INTO options (name, value) VALUES (${`plugin:${PLUGIN_ID}:settings:${FEATURES_SETTING}`}, ${JSON.stringify({ cwSchema: true, cwBackups: false })})`.execute(db);
	});
	try {
		const stored = await s.stored();
		assert.equal(stored[DEFAULTS_RECORDED], true);
		assert.deepEqual(pick(resolveFeatures(stored)), { redirects: true, slugs: true, backups: false, schema: true });
	} finally {
		await s.close();
	}
});

test("an existing site that never saved a switch but has pack data (a setting, a KV row or a stored document) keeps them on", async () => {
	const seeds = {
		setting: (db, sql) => sql`INSERT INTO options (name, value) VALUES (${`plugin:${PLUGIN_ID}:settings:headings`}, '{}')`.execute(db),
		kv: (db, sql) => sql`INSERT INTO options (name, value) VALUES (${`plugin:${PLUGIN_ID}:state:settingsGeneration`}, '{"id":"x"}')`.execute(db),
	};
	for (const [name, seed] of Object.entries(seeds)) {
		const s = await site(seed);
		try {
			assert.deepEqual(pick(resolveFeatures(await s.stored())), { redirects: true, slugs: true, backups: true, schema: false }, name);
		} finally {
			await s.close();
		}
	}
	// A document in one of the pack's storage collections (before the defaults were recorded).
	const s = await site();
	try {
		await s.ctx.storage.redirectsRemoved.put("posts:1", { url: "/old/" });
		await s.db.deleteFrom("options").where("name", "=", `plugin:${PLUGIN_ID}:settings:${FEATURES_SETTING}`).execute();
		await recordDefaults(s.ctx, { fresh: true });
		assert.deepEqual(pick(resolveFeatures(await s.stored())), { redirects: true, slugs: true, backups: true, schema: false });
	} finally {
		await s.close();
	}
});

test("only plugin:install can treat a site as new: any later call records an unrecorded site as existing", async () => {
	const s = await site();
	try {
		await s.db.deleteFrom("options").execute();
		await recordDefaults(s.ctx);
		assert.deepEqual(pick(resolveFeatures(await s.stored())), { redirects: true, slugs: true, backups: true, schema: false });
	} finally {
		await s.close();
	}
});

test("recording never overwrites a save made meanwhile (compare-and-set), and runs once", async () => {
	const s = await site(async (db, sql) => {
		await sql`INSERT INTO options (name, value) VALUES (${`plugin:${PLUGIN_ID}:settings:${FEATURES_SETTING}`}, '{"cwSchema":true}')`.execute(db);
	});
	try {
		const before = await s.stored();
		assert.equal(await recordDefaults(s.ctx), true, "already recorded");
		assert.deepEqual(await s.stored(), before, "a second call changes nothing");

		// A save lands between the read and the write: the write is refused, the save kept.
		await s.db.deleteFrom("options").execute();
		const racing = {
			...s.ctx,
			settings: {
				...s.ctx.settings,
				getVersioned: async (key) => {
					const read = await s.ctx.settings.getVersioned(key);
					await s.ctx.settings.set(FEATURES_SETTING, { cwRedirects: false });
					return read;
				},
				compareAndSet: (...args) => s.ctx.settings.compareAndSet(...args),
			},
		};
		assert.equal(await recordDefaults(racing), false);
		assert.deepEqual(await s.stored(), { cwRedirects: false });
	} finally {
		await s.close();
	}
});

test("the middleware's read of the switches: an unrecorded site, or a failed read, keeps Redirect Manager on", async () => {
	invalidateFeatures();
	const failing = {
		prepare() {
			throw new Error("D1 is unavailable");
		},
	};
	const originalError = console.error;
	console.error = () => {};
	try {
		const features = await siteFeatures(failing, true);
		assert.equal(features.cwRedirects, true);
		assert.equal(features["cwRedirects.slugs"], true);
	} finally {
		console.error = originalError;
		invalidateFeatures();
	}
});

test("the real switches: Redirect Manager, Slug changes and Backups default off, on for sites set up before 0.36.0; plugin:install and plugin:activate record it", () => {
	const redirects = readFileSync(new URL("../src/redirects/pack.ts", import.meta.url), "utf8");
	assert.match(redirects, /id: "redirects",[\s\S]*?default: false,\s*legacyDefault: true,/);
	assert.match(redirects, /id: SLUG_CHANGES_FEATURE,[\s\S]*?default: false,\s*legacyDefault: true,/);
	const backups = readFileSync(new URL("../src/backups/pack.ts", import.meta.url), "utf8");
	assert.match(backups, /id: "backups",[^}]*default: false, legacyDefault: true/);
	const compose = readFileSync(new URL("../src/core/compose.ts", import.meta.url), "utf8");
	assert.match(compose, /hooks\["plugin:install"\] = \{[\s\S]*?recordDefaults\(ctx, \{ fresh: true \}\)/);
	assert.match(compose, /hooks\["plugin:activate"\] = \{[\s\S]*?recordDefaults\(ctx\)/);
	const routes = readFileSync(new URL("../src/core/features-module.ts", import.meta.url), "utf8");
	assert.match(routes, /"features\/list"[\s\S]*?recordDefaults\(ctx\)/);
	assert.match(routes, /withRecordedDefaults\(await ctx\.settings\.get<FeatureMap>\(FEATURES_SETTING\), true\)/);
	// No other feature was on by default before 0.36.0 except Search's live results (a part of Search, which is off).
	const all = ["redirects", "backups", "search", "schema", "discovery", "images", "videos", "files", "links", "robots"]
		.map((m) => readFileSync(new URL(`../src/${m}/pack.ts`, import.meta.url), "utf8"))
		.join("\n");
	assert.doesNotMatch(all.replace(/id: "search\.live"[\s\S]*?default: true/, ""), /default: true/);
});

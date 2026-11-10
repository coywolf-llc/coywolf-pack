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

const { DEFAULTS_RECORDED, FEATURES_SETTING, FRESH_INSTALL_KEY, HOUSEKEEPING_KEYS, invalidateFeatures, recordDefaults, registerFeatures, resetFreshInstallForTests, resolveFeatures, siteFeatures, withRecordedDefaults } = await import("../src/core/features.ts");

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

// ── On EmDash's hook pipeline, with the pack's composed hooks ─────

const PLUGIN_ID = "coywolf-pack";
const SWITCHES_ROW = `plugin:${PLUGIN_ID}:settings:${FEATURES_SETTING}`;

/**
 * A fresh EmDash database (optionally with rows a site already has), and the pack's real plugin:install and
 * plugin:activate (composeHooks, as src/index.ts builds them) registered on EmDash's own hook pipeline, run the
 * way EmDash's runtime runs them at boot for a config plugin with no _plugin_state row (install, then activate;
 * test/emdash-contract.test.mjs checks the runtime still does).
 */
async function site(seed = async () => {}) {
	const { Kysely, sql } = await import("kysely");
	const { createDialect } = await import("emdash/db/sqlite");
	const { runMigrations } = await import("emdash/db");
	const { createHookPipeline, definePlugin } = await import("emdash");
	const { composeHooks } = await import("../src/core/compose.ts");
	const db = new Kysely({ dialect: createDialect({ url: ":memory:" }) });
	await runMigrations(db);
	await seed(db, sql);
	resetFreshInstallForTests();
	const module = { id: "cwRedirects", label: "Redirect Manager", features: [{ id: "cwRedirects", label: "Redirect Manager", description: "", default: false, legacyDefault: true }] };
	const { hooks } = composeHooks([module], { tasks: [] });
	const plugin = definePlugin({ id: PLUGIN_ID, version: "0.36.0", capabilities: [], storage: { redirectsRemoved: { indexes: [] } }, hooks });
	const pipeline = createHookPipeline([plugin], { db });
	const stored = async () => {
		const { rows } = await sql`SELECT value FROM options WHERE name = ${SWITCHES_ROW}`.execute(db);
		return rows[0] ? JSON.parse(rows[0].value) : null;
	};
	return {
		db,
		sql,
		stored,
		ctx: () => pipeline.getContext(PLUGIN_ID),
		/** EmDash's boot for an unrecorded config plugin. */
		async boot() {
			for (const results of [await pipeline.runPluginInstall(PLUGIN_ID), await pipeline.runPluginActivate(PLUGIN_ID)]) {
				assert.equal(results.length, 1, "the pack's hook ran");
				assert.ok(results[0].success, String(results[0].error));
			}
		},
		close: () => db.destroy(),
	};
}

test("a new site: the real plugin:install finds nothing of the pack's and records the new defaults (all three off)", async () => {
	const s = await site();
	try {
		await s.boot();
		assert.deepEqual(await s.stored(), { [DEFAULTS_RECORDED]: true });
		assert.deepEqual(pick(resolveFeatures(await s.stored())), { redirects: false, slugs: false, backups: false, schema: false });
		assert.equal(await s.ctx().kv.get(FRESH_INSTALL_KEY), null, "the fresh-install flag is gone once recorded");
	} finally {
		await s.close();
	}
});

test("an existing site with saved switches keeps all three on, and its own choices", async () => {
	const s = await site(async (db, sql) => {
		await sql`INSERT INTO options (name, value) VALUES (${SWITCHES_ROW}, ${JSON.stringify({ cwSchema: true, cwBackups: false })})`.execute(db);
	});
	try {
		await s.boot();
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
		document: (db, sql) =>
			sql`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES (${PLUGIN_ID}, 'redirectsRemoved', 'posts:1', '{"url":"/old/"}', '2026-01-01', '2026-01-01')`.execute(db),
	};
	for (const [name, seed] of Object.entries(seeds)) {
		const s = await site(seed);
		try {
			await s.boot();
			assert.deepEqual(pick(resolveFeatures(await s.stored())), { redirects: true, slugs: true, backups: true, schema: false }, name);
		} finally {
			await s.close();
		}
	}
});

test("the pack's own housekeeping rows (the deployed version, the IndexNow clean-up marker) don't make a site existing", async () => {
	const s = await site(async (db, sql) => {
		await sql`INSERT INTO options (name, value) VALUES ('plugin:coywolf-pack:pageCache:version', '{"current":"v1"}')`.execute(db);
		await sql`INSERT INTO options (name, value) VALUES ('plugin:coywolf-pack:state:discovery:indexnowRetired', 'true')`.execute(db);
	});
	try {
		await s.boot();
		assert.deepEqual(await s.stored(), { [DEFAULTS_RECORDED]: true });
	} finally {
		await s.close();
	}
});

test("install's recording fails: a later call (another isolate) still records a new site as new, while it has no pack data", async () => {
	const s = await site();
	try {
		const ctx = s.ctx();
		// plugin:install, with the switches unreadable after it left its flag.
		const failing = { ...ctx, settings: { ...ctx.settings, getVersioned: async () => Promise.reject(new Error("D1 is unavailable")) } };
		await assert.rejects(recordDefaults(failing, { fresh: true }), /D1 is unavailable/);
		assert.equal(await ctx.kv.get(FRESH_INSTALL_KEY), true, "install left its flag");
		assert.equal(await s.stored(), null);
		resetFreshInstallForTests(); // the next call comes from another isolate
		// Meanwhile the middleware recorded the deployed version (housekeeping, not pack data).
		await s.sql`INSERT INTO options (name, value) VALUES ('plugin:coywolf-pack:pageCache:version', '{"current":"v1"}')`.execute(s.db);
		await recordDefaults(s.ctx()); // the Features page
		assert.deepEqual(await s.stored(), { [DEFAULTS_RECORDED]: true });
		assert.equal(await s.ctx().kv.get(FRESH_INSTALL_KEY), null);
	} finally {
		await s.close();
	}
	// The same, but someone saved a pack setting before the defaults were recorded: in doubt, an existing site.
	const t = await site();
	try {
		const ctx = t.ctx();
		const failing = { ...ctx, settings: { ...ctx.settings, getVersioned: async () => Promise.reject(new Error("D1 is unavailable")) } };
		await assert.rejects(recordDefaults(failing, { fresh: true }));
		resetFreshInstallForTests();
		await ctx.settings.set("headings", { prefix: "x-" });
		await recordDefaults(t.ctx());
		assert.deepEqual(pick(resolveFeatures(await t.stored())), { redirects: true, slugs: true, backups: true, schema: false });
	} finally {
		await t.close();
	}
	// And the flag can't even be written (D1 down for the whole install): the same isolate still remembers it.
	const u = await site();
	try {
		const ctx = u.ctx();
		const down = { ...ctx, kv: { ...ctx.kv, set: async () => Promise.reject(new Error("down")) }, settings: { ...ctx.settings, getVersioned: async () => Promise.reject(new Error("down")) } };
		await assert.rejects(recordDefaults(down, { fresh: true }));
		await recordDefaults(u.ctx()); // plugin:activate, right after, in the same isolate
		assert.deepEqual(await u.stored(), { [DEFAULTS_RECORDED]: true });
	} finally {
		await u.close();
	}
});

test("only a fresh install can make a site new: without its flag, any later call records an unrecorded site as existing", async () => {
	const s = await site();
	try {
		await recordDefaults(s.ctx());
		assert.deepEqual(pick(resolveFeatures(await s.stored())), { redirects: true, slugs: true, backups: true, schema: false });
	} finally {
		await s.close();
	}
});

test("recording never overwrites a save made meanwhile (compare-and-set), and runs once", async () => {
	const s = await site(async (db, sql) => {
		await sql`INSERT INTO options (name, value) VALUES (${SWITCHES_ROW}, '{"cwSchema":true}')`.execute(db);
	});
	try {
		await s.boot();
		const before = await s.stored();
		assert.equal(await recordDefaults(s.ctx()), true, "already recorded");
		assert.deepEqual(await s.stored(), before, "a second call changes nothing");

		// A save lands between the read and the write: the write is refused, the save kept.
		await s.db.deleteFrom("options").execute();
		const ctx = s.ctx();
		const racing = {
			...ctx,
			settings: {
				...ctx.settings,
				getVersioned: async (key) => {
					const read = await ctx.settings.getVersioned(key);
					await ctx.settings.set(FEATURES_SETTING, { cwRedirects: false });
					return read;
				},
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

test("the real switches: Redirect Manager, Slug changes and Backups default off, on for sites set up before 0.36.0; the Features routes record it", () => {
	const redirects = readFileSync(new URL("../src/redirects/pack.ts", import.meta.url), "utf8");
	assert.match(redirects, /id: "redirects",[\s\S]*?default: false,\s*legacyDefault: true,/);
	assert.match(redirects, /id: SLUG_CHANGES_FEATURE,[\s\S]*?default: false,\s*legacyDefault: true,/);
	const backups = readFileSync(new URL("../src/backups/pack.ts", import.meta.url), "utf8");
	assert.match(backups, /id: "backups",[^}]*default: false, legacyDefault: true/);
	// The housekeeping rows are the modules' own keys.
	const lib = readFileSync(new URL("../src/pageCache/lib.ts", import.meta.url), "utf8");
	const warm = readFileSync(new URL("../src/pageCache/warm.ts", import.meta.url), "utf8");
	const discovery = readFileSync(new URL("../src/discovery/module.ts", import.meta.url), "utf8");
	assert.match(lib, /VERSION_OPTION = "plugin:coywolf-pack:pageCache:version"/);
	assert.match(warm, /WARM_STATE_OPTION = "plugin:coywolf-pack:pageCache:warmState"/);
	assert.match(discovery, /RETIRED_MARKER = "state:discovery:indexnowRetired"/);
	for (const key of ["pageCache:version", "pageCache:warmState", "state:discovery:indexnowRetired", FRESH_INSTALL_KEY]) assert.ok(HOUSEKEEPING_KEYS.has(key), key);
	const routes = readFileSync(new URL("../src/core/features-module.ts", import.meta.url), "utf8");
	assert.match(routes, /"features\/list"[\s\S]*?recordDefaults\(ctx\)/);
	assert.match(routes, /"features\/save"[\s\S]*?recordDefaults\(ctx\)[\s\S]*?withRecordedDefaults\(await ctx\.settings\.get<FeatureMap>\(FEATURES_SETTING\), true\)/);
	// No other feature was on by default before 0.36.0 except Search's live results (a part of Search, which is off).
	const all = ["redirects", "backups", "search", "schema", "discovery", "images", "videos", "files", "links", "robots"]
		.map((m) => readFileSync(new URL(`../src/${m}/pack.ts`, import.meta.url), "utf8"))
		.join("\n");
	assert.doesNotMatch(all.replace(/id: "search\.live"[\s\S]*?default: true/, ""), /default: true/);
});

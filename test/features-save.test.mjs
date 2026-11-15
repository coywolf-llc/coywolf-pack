// Run: node --test test/features-save.test.mjs
//
// features/list and features/save (src/core/features-module.ts), which the Features page saves through with one
// request for all its changes: several switches in one write, a module turned off with its parts in the same
// request, and both the switches as they apply (`features`) and each one's own switch (`choices`) in the answer.
// On EmDash's real plugin context and schema (in-memory SQLite).
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { DEFAULTS_RECORDED, FEATURES_SETTING, featureChoices, invalidateFeatures, registerFeatures, resetFreshInstallForTests, resolveFeatures } = await import("../src/core/features.ts");
const { featuresRoutes } = await import("../src/core/features-module.ts");

const PLUGIN_ID = "coywolf-pack";

const feature = (id, extra = {}) => ({ id, label: id, description: "", ...extra });
const modules = [
	{ id: "cwA", label: "A", features: [feature("cwA", { default: true }), feature("cwA.one", { default: true }), feature("cwA.two")] },
	{ id: "cwB", label: "B", features: [feature("cwB"), feature("cwB.x")] },
];
registerFeatures(modules.flatMap((m) => m.features));

// A task that runs only while cwA.one is on, so the save schedules or cancels it.
const tasks = [{ name: "cwAOne", schedule: "@daily", feature: "cwA.one", onlyWhileOn: true }];

async function site(stored) {
	const { Kysely, sql } = await import("kysely");
	const { createDialect } = await import("emdash/db/sqlite");
	const { runMigrations } = await import("emdash/db");
	const { createHookPipeline, definePlugin } = await import("emdash");
	const db = new Kysely({ dialect: createDialect({ url: ":memory:" }) });
	await runMigrations(db);
	await sql`INSERT INTO options (name, value) VALUES (${`plugin:${PLUGIN_ID}:settings:${FEATURES_SETTING}`}, ${JSON.stringify({ [DEFAULTS_RECORDED]: true, ...stored })})`.execute(db);
	resetFreshInstallForTests();
	invalidateFeatures();
	const pipeline = createHookPipeline([definePlugin({ id: PLUGIN_ID, version: "0.37.0", capabilities: [], hooks: {} })], { db });
	const base = pipeline.getContext(PLUGIN_ID);
	const writes = [];
	const cron = [];
	const ctx = (input) => ({
		...base,
		input,
		log: { ...base.log, info() {} },
		settings: {
			...base.settings,
			set: async (key, value) => {
				writes.push(key);
				return base.settings.set(key, value);
			},
		},
		cron: { schedule: async (name) => void cron.push(`schedule ${name}`), cancel: async (name) => void cron.push(`cancel ${name}`) },
	});
	return { ctx, writes, cron, stored: () => base.settings.get(FEATURES_SETTING), close: () => db.destroy() };
}

test("a part keeps its own switch while its module is off: choices, and the switches as they apply", () => {
	const stored = { [DEFAULTS_RECORDED]: true, cwA: false, "cwA.two": true };
	assert.deepEqual(featureChoices(stored), { cwA: false, "cwA.one": true, "cwA.two": true, cwB: false, "cwB.x": false });
	assert.deepEqual(resolveFeatures(stored), { cwA: false, "cwA.one": false, "cwA.two": false, cwB: false, "cwB.x": false });
});

test("save: several switches across modules in one request are stored in one write", async () => {
	const s = await site({});
	try {
		const routes = featuresRoutes(modules, tasks);
		const out = await routes["features/save"].handler(s.ctx({ features: { "cwA.two": true, cwB: true, "cwB.x": true } }));
		assert.deepEqual(s.writes, [FEATURES_SETTING], "one write of the switches");
		const stored = await s.stored();
		assert.equal(stored["cwA.two"], true);
		assert.equal(stored.cwB, true);
		assert.equal(stored["cwB.x"], true);
		assert.equal(stored.cwA, undefined, "switches that weren't sent are left as they were");
		assert.deepEqual(out.features, { cwA: true, "cwA.one": true, "cwA.two": true, cwB: true, "cwB.x": true });
		assert.deepEqual(out.choices, out.features);
	} finally {
		await s.close();
	}
});

test("save: a module turned off with its parts in the same request; a part turned on with it stays off until the module is on", async () => {
	const s = await site({ "cwA.two": false });
	try {
		const routes = featuresRoutes(modules, tasks);
		const out = await routes["features/save"].handler(s.ctx({ features: { cwA: false, "cwA.one": false, "cwA.two": true } }));
		assert.deepEqual(s.writes, [FEATURES_SETTING]);
		const stored = await s.stored();
		assert.deepEqual({ a: stored.cwA, one: stored["cwA.one"], two: stored["cwA.two"] }, { a: false, one: false, two: true }, "each part's own value is stored");
		// As they apply: everything in the module is off. Each one's own switch: what the page shows once the module is on again.
		assert.deepEqual({ a: out.features.cwA, one: out.features["cwA.one"], two: out.features["cwA.two"] }, { a: false, one: false, two: false });
		assert.deepEqual({ a: out.choices.cwA, one: out.choices["cwA.one"], two: out.choices["cwA.two"] }, { a: false, one: false, two: true });
		assert.deepEqual(s.cron, ["cancel cwAOne"], "the part's task is cancelled with its module");

		// features/list says the same, per feature.
		const { modules: listed } = await routes["features/list"].handler(s.ctx(undefined));
		const a = listed.find((m) => m.id === "cwA").features;
		assert.deepEqual(
			a.map((f) => [f.id, f.enabled, f.choice]),
			[
				["cwA", false, false],
				["cwA.one", false, false],
				["cwA.two", false, true],
			],
		);

		// The module back on, alone: its parts come back as they were stored.
		s.cron.length = 0;
		const back = await routes["features/save"].handler(s.ctx({ features: { cwA: true } }));
		assert.deepEqual({ one: back.features["cwA.one"], two: back.features["cwA.two"] }, { one: false, two: true });
		assert.deepEqual(s.cron, ["cancel cwAOne"], "cwA.one is still off");
	} finally {
		await s.close();
	}
});

test("save: unknown ids are ignored, and the request still makes one write", async () => {
	const s = await site({});
	try {
		const out = await featuresRoutes(modules, tasks)["features/save"].handler(s.ctx({ features: { nope: true, "cwB.x": true } }));
		assert.deepEqual(s.writes, [FEATURES_SETTING]);
		assert.equal((await s.stored()).nope, undefined);
		assert.equal(out.choices["cwB.x"], true);
		assert.equal(out.features["cwB.x"], false, "cwB is off");
	} finally {
		await s.close();
	}
});

test("save: modules with featuresChanged get the switches as they applied before and after (Child Pages re-settles its URLs)", async () => {
	const s = await site({ cwB: false });
	try {
		const calls = [];
		const watching = [...modules, { id: "cwW", label: "W", features: [], featuresChanged: async (_ctx, before, after) => void calls.push([before.cwB, after.cwB]) }];
		const failing = { id: "cwF", label: "F", features: [], featuresChanged: async () => { throw new Error("boom"); } };
		const routes = featuresRoutes([...watching, failing], tasks);
		const out = await routes["features/save"].handler(s.ctx({ features: { cwB: true } }));
		assert.deepEqual(calls, [[false, true]]);
		assert.equal(out.features.cwB, true, "a module that fails doesn't fail the save");
		await routes["features/save"].handler(s.ctx({ features: { "cwA.two": true } }));
		assert.deepEqual(calls[1], [true, true], "called on every save: the module checks its own switch");
	} finally {
		await s.close();
	}
});

test("save: featuresChanged gets the switches from the same read the save builds on; when that read fails the save fails, and nothing is written or missed", async () => {
	const s = await site({ cwB: false });
	try {
		const calls = [];
		const watching = [...modules, { id: "cwW", label: "W", features: [], featuresChanged: async (_ctx, before, after) => void calls.push([before.cwB, after.cwB]) }];
		const routes = featuresRoutes(watching, tasks);
		// The stored switches can't be read (recordDefaults' own failed read is only logged; the save's read is the one that counts).
		const failing = (input) => {
			const ctx = s.ctx(input);
			return { ...ctx, log: { ...ctx.log, warn() {} }, settings: { ...ctx.settings, get: async (key) => (key === FEATURES_SETTING ? Promise.reject(new Error("D1 down")) : ctx.settings.get(key)) } };
		};
		await assert.rejects(routes["features/save"].handler(failing({ features: { cwB: true } })), /D1 down/);
		assert.deepEqual(s.writes.filter((k) => k === FEATURES_SETTING), [], "nothing saved");
		assert.deepEqual(calls, [], "and no module told of a change that didn't happen");
		// The save works: the module hears of the change (it used to be skipped when its own earlier read failed).
		await routes["features/save"].handler(s.ctx({ features: { cwB: true } }));
		assert.deepEqual(calls, [[false, true]]);
	} finally {
		await s.close();
	}
});

test("list: a module's note for the Features page (work left over from turning it off); one that can't be read is left out", async () => {
	const s = await site({});
	try {
		const notice = { text: "Left 1 URL without a redirect.", items: ["Delete /a → /b"], action: { label: "Re-check redirects", route: "cwN/recheck" } };
		const noted = { id: "cwN", label: "N", features: [feature("cwN")], featureNotice: async (_ctx, features) => (features.cwN ? null : notice) };
		const broken = { id: "cwX", label: "X", features: [feature("cwX")], featureNotice: async () => { throw new Error("KV down"); } };
		registerFeatures([...noted.features, ...broken.features]);
		const routes = featuresRoutes([...modules, noted, broken], tasks);
		const quiet = (input) => ({ ...s.ctx(input), log: { info() {}, warn() {}, error() {} } });
		const list = await routes["features/list"].handler(quiet());
		assert.deepEqual(list.modules.find((m) => m.id === "cwN").notice, notice);
		assert.equal("notice" in list.modules.find((m) => m.id === "cwX"), false);
		assert.equal("notice" in list.modules.find((m) => m.id === "cwA"), false);
		// The save's answer carries them too, as they are after it (the page doesn't read the list again).
		const off = await routes["features/save"].handler(quiet({ features: { cwB: true } }));
		assert.deepEqual(off.notices, { cwN: notice });
		const on = await routes["features/save"].handler(quiet({ features: { cwN: true } }));
		assert.deepEqual(on.notices, {});
	} finally {
		await s.close();
	}
});

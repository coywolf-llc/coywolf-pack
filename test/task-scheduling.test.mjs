// Run: node --test test/task-scheduling.test.mjs
// Tasks marked onlyWhileOn are scheduled only while their feature is on: cancelled
// while it's off (by the Features routes, plugin:activate, or the task itself when it
// fires off), so a module that's off costs no scheduled runs at all.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeSettings, quietLog } from "./fixtures/fake-plugin.mjs";

const { ensureTasks, composeHooks } = await import("../src/core/compose.ts");
const { registerFeatures } = await import("../src/core/features.ts");
registerFeatures([{ id: "quiet", label: "Quiet", description: "", default: false }]);

function fakeCron() {
	const calls = [];
	return {
		calls,
		schedule: async (name, opts) => void calls.push(["schedule", name, opts.schedule]),
		cancel: async (name) => void calls.push(["cancel", name]),
	};
}

const tasks = [
	{ name: "always", schedule: "@daily", feature: "quiet", handler: async () => {} },
	{ name: "while-on", schedule: "@hourly", feature: "quiet", onlyWhileOn: true, handler: async () => {} },
];

test("ensureTasks: an onlyWhileOn task is cancelled while its feature is off, scheduled while on; others are always scheduled", async () => {
	const cron = fakeCron();
	await ensureTasks({ cron }, tasks, { quiet: false });
	assert.deepEqual(cron.calls, [["schedule", "always", "@daily"], ["cancel", "while-on"]]);
	cron.calls.length = 0;
	await ensureTasks({ cron }, tasks, { quiet: true });
	assert.deepEqual(cron.calls, [["schedule", "always", "@daily"], ["schedule", "while-on", "@hourly"]]);
	cron.calls.length = 0;
	await ensureTasks({ cron }, tasks, null);
	assert.deepEqual(cron.calls.map((c) => c[0]), ["schedule", "schedule"], "switches unknown: scheduled, and the handler stays gated");
});

test("ensureTasks reports tasks it couldn't schedule (the Features save shows it) and still does the rest", async () => {
	const cron = fakeCron();
	cron.schedule = async (name) => {
		if (name === "while-on") throw new Error("D1 is busy");
		cron.calls.push(["schedule", name]);
	};
	const failures = await ensureTasks({ cron, log: quietLog() }, tasks, { quiet: true });
	assert.deepEqual(failures, [{ task: "while-on", scheduling: true, error: "D1 is busy" }]);
	assert.deepEqual(cron.calls, [["schedule", "always"]]);
});

test("a task that fires while its feature is off cancels itself (onlyWhileOn) and doesn't run", async () => {
	let ran = 0;
	const module = { id: "quiet", label: "Quiet", features: [{ id: "quiet", label: "Quiet", description: "" }], tasks: [{ name: "while-on", schedule: "@hourly", onlyWhileOn: true, handler: async () => void ran++ }] };
	const { hooks } = composeHooks([module], { tasks: [] });
	const cron = fakeCron();
	const ctx = { cron, settings: fakeSettings({ features: { quiet: false } }), log: quietLog(), kv: { get: async () => null, set: async () => {} } };
	await hooks.cron.handler({ name: "while-on" }, ctx);
	assert.equal(ran, 0);
	assert.deepEqual(cron.calls, [["cancel", "while-on"]]);
	ctx.settings = fakeSettings({ features: { quiet: true } });
	await hooks.cron.handler({ name: "while-on" }, ctx);
	assert.equal(ran, 1);
});

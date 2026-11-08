// Run: node --test test/emdash-next.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { composeHooks } = await import("../src/core/compose.ts");
const { siteInStaging } = await import("../src/core/site.ts");

test("plugin:activate never throws: a failing step is logged and the others still run", async () => {
	const ran = [];
	const errors = [];
	const modules = [
		{ id: "first", features: [], hooks: { "plugin:activate": async () => { throw new Error("D1 hiccup"); } } },
		{ id: "second", features: [], hooks: { "plugin:activate": async () => { ran.push("second"); } } },
	];
	const { hooks } = composeHooks(modules, { tasks: [] });
	const ctx = {
		settings: { get: async () => null },
		cron: { schedule: async () => { throw new Error("cron table busy"); }, list: async () => [] },
		log: { info() {}, warn() {}, error: (msg) => errors.push(msg) },
	};
	await assert.doesNotReject(hooks["plugin:activate"].handler({}, ctx));
	assert.deepEqual(ran, ["second"]);
	assert.ok(errors.some((m) => m.includes("first: plugin:activate failed")));
});

test("staging: a site without EmDash's staging setting (or where it can't be read) counts as live", async () => {
	assert.equal(await siteInStaging(), false);
});

test("the plugin names itself for EmDash's Plugins list", async () => {
	// src/index.ts loads every module (some use syntax Node's type stripping can't run), so check the descriptor's source.
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(src, /displayName: "Coywolf Pack",/);
	assert.match(src, /description: "Enhances EmDash's features/);
});

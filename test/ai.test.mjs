// AI Enrichment unit tests live next to the module (src/ai/*.test.ts); this pulls them into `node --test test/*.test.mjs`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

await import("../src/ai/logic.test.ts");
await import("../src/ai/queue.test.ts");
await import("../src/ai/wikidata.test.ts");
await import("../src/ai/glossary.test.ts");
await import("../src/ai/glossary-links.test.ts");
await import("../src/ai/keep-date.test.ts");
await import("../src/ai/glossary-unlink.test.ts");
await import("../src/ai/glossary-gone.test.ts");
await import("../src/ai/glossary-possessive.test.ts");

// src/ai/pack.ts and src/ai/worker.ts load the model providers, which Node can't run here: their wiring is checked in the source.
const source = (file) => readFileSync(new URL(`../src/ai/${file}`, import.meta.url), "utf8");

test("Remove links to deleted glossary.io terms is one of AI Enrichment's parts: off by default, needs glossary.io links", async () => {
	const { REMOVE_GONE_FEATURE } = await import("../src/ai/glossary-gone.ts");
	assert.equal(REMOVE_GONE_FEATURE.default, false);
	assert.deepEqual(REMOVE_GONE_FEATURE.requires, ["ai.glossaryLinks"]);
	const features = /const FEATURES = \[([\s\S]*?)\n\];/.exec(source("pack.ts"))[1];
	assert.match(features, /\n\tREMOVE_GONE_FEATURE,\n/);
	assert.ok(features.indexOf('id: "ai.glossaryLinks"') < features.indexOf("REMOVE_GONE_FEATURE"), "listed after glossary.io links");
});

test("the scheduled run checks for deleted terms only while the part is on, and removes links only when the check says so", () => {
	const worker = source("worker.ts");
	const calls = [...worker.matchAll(/checkGoneTerms\(/g)];
	assert.equal(calls.length, 1, "one call");
	const guarded = /if \(removeGoneOn\(features\)\) \{\n(?:[^\n]*\n){0,3}?[^\n]*checkGoneTerms\(ctx, options, budget,/.exec(worker);
	assert.ok(guarded, "checkGoneTerms runs only under removeGoneOn(features)");
	assert.match(worker, /let unlink = false;/);
	assert.match(worker, /unlink = !gone\.paused;/);
	assert.match(worker, /retryDue\(ctx, options, room, \{ unlink \}\)/);
});

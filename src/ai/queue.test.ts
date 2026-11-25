/**
 * Unit tests for AI Enrichment queue batching.
 * Run: node --test test/*.test.mjs (or node --test src/ai/*.test.ts)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as L from "./logic.ts";

const logic = L as typeof import("./logic.js");
type Job = import("./logic.js").QueueJob;

const job = (id: string, due: number, kind: Job["kind"] = "entry"): { id: string; data: Job } => ({
	id,
	data: { kind, due, attempts: 0, enqueuedAt: 0, ...(kind === "media" ? { mediaId: id } : { collection: "posts", entryId: id }) },
});

test("planBatch takes due jobs in due order up to the per-tick limit", () => {
	const jobs = [job("c", 300), job("a", 100), job("future", 10_000), job("b", 200)];
	const out = logic.planBatch(jobs, { now: 1000, perTick: 2, remainingCalls: 100, callsPerJob: () => 3 });
	assert.deepEqual(
		out.map((j) => j.id),
		["a", "b"],
	);
});

test("planBatch respects the daily call budget and keeps each kind in order", () => {
	const jobs = [job("entry1", 1), job("img", 2, "media"), job("entry2", 3)];
	const cost = (j: Job) => (j.kind === "media" ? 1 : 3);
	assert.deepEqual(
		logic.planBatch(jobs, { now: 10, perTick: 10, remainingCalls: 4, callsPerJob: cost }).map((j) => j.id),
		["entry1", "img"],
	);
	// Not enough budget for the first entry: no entry runs (entry2 doesn't jump the line), but the image can.
	assert.deepEqual(
		logic.planBatch(jobs, { now: 10, perTick: 10, remainingCalls: 2, callsPerJob: cost }).map((j) => j.id),
		["img"],
	);
	assert.deepEqual(logic.planBatch(jobs, { now: 10, perTick: 10, remainingCalls: -5, callsPerJob: cost }), []);
});

test("deferJob pushes the job to Retry-After without an attempt, and gives up deferring after MAX_DEFERRALS in a row", () => {
	const j = job("a", 0).data;
	const once = logic.deferJob(j, 1_000, 30_000);
	assert.deepEqual(once, { ...j, deferrals: 1, due: 31_000 });
	assert.equal(once!.attempts, 0);
	const tenth = logic.deferJob({ ...j, deferrals: logic.MAX_DEFERRALS - 1 }, 1_000, 30_000);
	assert.equal(tenth?.deferrals, logic.MAX_DEFERRALS);
	assert.equal(logic.deferJob({ ...j, deferrals: logic.MAX_DEFERRALS }, 1_000, 30_000), null, "the next one counts as a failed attempt");
	assert.equal(logic.MAX_DEFERRALS, 10);
});

test("retryAt backs off and gives up after MAX_ATTEMPTS", () => {
	const j = job("a", 0).data;
	assert.equal(logic.retryAt({ ...j, attempts: 0 }, 0), 5 * 60_000);
	assert.equal(logic.retryAt({ ...j, attempts: 1 }, 0), 20 * 60_000);
	assert.equal(logic.retryAt({ ...j, attempts: logic.MAX_ATTEMPTS - 1 }, 0), null);
});

test("mergeJob debounces: later due wins, force sticks, attempts reset", () => {
	const first: Job = { kind: "entry", collection: "posts", entryId: "1", due: 100, attempts: 2, enqueuedAt: 50, force: true };
	const next: Job = { kind: "entry", collection: "posts", entryId: "1", due: 500, attempts: 0, enqueuedAt: 400 };
	assert.deepEqual(logic.mergeJob(first, next), { ...next, force: true, enqueuedAt: 50, attempts: 0 });
	assert.deepEqual(logic.mergeJob(null, next), next);
});

test("mergeJob keeps a save's mark only when both jobs are saves'", () => {
	const saved: Job = { kind: "entry", collection: "posts", entryId: "1", due: 500, attempts: 0, enqueuedAt: 400, source: "save" };
	const bulk: Job = { kind: "entry", collection: "posts", entryId: "1", due: 100, attempts: 1, enqueuedAt: 50, force: false };
	assert.deepEqual(logic.mergeJob(bulk, saved), { kind: "entry", collection: "posts", entryId: "1", due: 500, attempts: 0, enqueuedAt: 50, force: false });
	assert.deepEqual(logic.mergeJob(saved, bulk), { ...bulk, attempts: 0, enqueuedAt: 50, force: false });
	assert.deepEqual(logic.mergeJob(saved, { ...saved, due: 900, enqueuedAt: 800 }), { ...saved, due: 900, force: false });
	assert.deepEqual(logic.mergeJob(null, saved), saved);
});

test("mergeJob keeps the outputs a job already paid for, unless the new one brings its own or is forced (Analyze again)", () => {
	const paid = { hash: "h1", mentions: [], entities: [] };
	const queued: Job = { kind: "entry", collection: "posts", entryId: "1", due: 100, attempts: 1, enqueuedAt: 50, source: "save", cache: paid };
	const save: Job = { kind: "entry", collection: "posts", entryId: "1", due: 500, attempts: 0, enqueuedAt: 400, source: "save" };
	assert.deepEqual(logic.mergeJob(queued, save).cache, paid, "a second publish hook for the same save, or a later save");
	const own = { hash: "h2", description: "d" };
	assert.deepEqual(logic.mergeJob(queued, { ...save, cache: own }).cache, own);
	assert.equal("cache" in logic.mergeJob(queued, { ...save, force: true }), false);
	assert.equal("cache" in logic.mergeJob({ ...queued, cache: undefined }, save), false);
	assert.deepEqual(logic.mergeJob(queued, { ...save, cache: { hash: "h1", description: "d" } }).cache, { ...paid, description: "d" }, "of the same text: both are kept");
});

test("mergeJob: a forced job never takes outputs a later save brings (AI Enrich's staged analysis), and keeps its own attempt's", () => {
	const forced: Job = { kind: "entry", collection: "posts", entryId: "1", due: 100, attempts: 0, enqueuedAt: 50, force: true };
	const save: Job = { kind: "entry", collection: "posts", entryId: "1", due: 500, attempts: 0, enqueuedAt: 400, source: "save", cache: { hash: "h1", entities: [] } };
	const merged = logic.mergeJob(forced, save);
	assert.equal(merged.force, true);
	assert.equal("cache" in merged, false);
	const own = { hash: "h1", mentions: [] };
	assert.deepEqual(logic.mergeJob({ ...forced, attempts: 1, cache: own }, save).cache, own, "what its own failed attempt paid for");
});

test("queueId and dayKey", () => {
	assert.equal(logic.queueId({ kind: "entry", collection: "posts", entryId: "x" }), "entry:posts:x");
	assert.equal(logic.queueId({ kind: "media", mediaId: "m" }), "media:m");
	assert.equal(logic.dayKey(Date.UTC(2026, 9, 3, 23, 59)), "2026-10-03");
});

test("planBatch alternates kinds so a backlog of entries can't starve images", () => {
	const jobs = [job("e1", 1), job("e2", 2), job("e3", 3), job("e4", 4), job("m1", 50, "media"), job("m2", 60, "media")];
	const out = logic.planBatch(jobs, { now: 100, perTick: 4, remainingCalls: 100, callsPerJob: () => 1 });
	assert.deepEqual(
		out.map((j) => j.id),
		["e1", "m1", "e2", "m2"],
	);
});

test("planBatch stays within the subrequest budget; an expensive kind stops without blocking a cheap one", () => {
	const jobs = [job("e1", 1), job("e2", 2), job("m1", 3, "media"), job("m2", 4, "media")];
	const out = logic.planBatch(jobs, {
		now: 100,
		perTick: 10,
		remainingCalls: 100,
		callsPerJob: () => 1,
		subrequests: 20,
		subrequestsPerJob: (j: Job) => (j.kind === "entry" ? 16 : 1),
	});
	assert.deepEqual(
		out.map((j) => j.id),
		["e1", "m1", "m2"],
	);
});

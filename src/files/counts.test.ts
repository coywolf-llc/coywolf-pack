/**
 * Run: node --test src/files/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { createDownloadCounter } from "./counts.ts";
// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { ifRangeMatches, parseRange, resolveRange } from "./range.ts";

/** A D1 stand-in that records the (id, n) of each upsert, with a controllable write delay. */
function stubDb(writeMs = 0) {
	const writes: Array<Array<[string, number]>> = [];
	return {
		writes,
		prepare: () => ({ bind: (...v: unknown[]) => [v[2] as string, v[3] as number] }),
		batch: async (statements: unknown[]) => {
			await new Promise((r) => setTimeout(r, writeMs));
			writes.push(statements as Array<[string, number]>);
		},
	};
}

const total = (writes: Array<Array<[string, number]>>) => {
	const out: Record<string, number> = {};
	for (const batch of writes) for (const [id, n] of batch) out[id] = (out[id] ?? 0) + n;
	return out;
};

test("counts in a burst are written in one batch", async () => {
	const counter = createDownloadCounter("p", "c", 5);
	const db = stubDb();
	const waits: Promise<unknown>[] = [];
	for (let i = 0; i < 3; i++) counter.count(db, "a", (p: Promise<unknown>) => waits.push(p));
	counter.count(db, "b", (p: Promise<unknown>) => waits.push(p));
	await Promise.all(waits);
	assert.equal(db.writes.length, 1);
	assert.deepEqual(total(db.writes), { a: 3, b: 1 });
	assert.ok(counter.idle);
});

test("a count made during a write is not lost", async () => {
	const counter = createDownloadCounter("p", "c", 5);
	const db = stubDb(20);
	const waits: Promise<unknown>[] = [];
	const waitUntil = (p: Promise<unknown>) => waits.push(p);
	counter.count(db, "a", waitUntil);
	await new Promise((r) => setTimeout(r, 12)); // First batch is now being written.
	counter.count(db, "a", waitUntil);
	await Promise.all(waits);
	assert.deepEqual(total(db.writes), { a: 2 });
	assert.equal(counter.pendingSize, 0);
	// After the flush finished, a new count starts a new flush.
	counter.count(db, "z", waitUntil);
	assert.ok(!counter.idle);
	await Promise.all(waits);
	assert.deepEqual(total(db.writes), { a: 2, z: 1 });
	assert.equal(counter.pendingSize, 0);
});

test("a failed write doesn't stop later counts", async () => {
	const counter = createDownloadCounter("p", "c", 1);
	let fail = true;
	const db = stubDb();
	const batch = db.batch;
	db.batch = async (s: unknown[]) => {
		if (fail) {
			fail = false;
			throw new Error("D1 down");
		}
		return batch(s);
	};
	const waits: Promise<unknown>[] = [];
	const orig = console.error;
	console.error = () => undefined;
	counter.count(db, "a", (p: Promise<unknown>) => waits.push(p));
	await Promise.all(waits);
	console.error = orig;
	assert.ok(counter.idle);
	counter.count(db, "b", (p: Promise<unknown>) => waits.push(p));
	await Promise.all(waits);
	assert.deepEqual(total(db.writes), { b: 1 });
});

test("a flush whose timer was dropped (its request was canceled) is replaced, and its counts still land", { timeout: 3_000 }, async () => {
	const counter = createDownloadCounter("p", "c", 5, 30);
	const db = stubDb();
	const waits: Promise<unknown>[] = [];
	const waitUntil = (p: Promise<unknown>) => waits.push(p);
	// workerd drops a canceled request's timers: the first flush's wait never ends.
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => (ms === 5 ? 0 : realSetTimeout(fn, ms))) as typeof setTimeout;
	counter.count(db, "a", () => undefined);
	globalThis.setTimeout = realSetTimeout;
	await new Promise((r) => setTimeout(r, 40)); // Past staleMs.
	counter.count(db, "a", waitUntil);
	await Promise.all(waits);
	assert.deepEqual(total(db.writes), { a: 2 }, "the stranded flush's count went out with the new one");
	assert.ok(counter.idle);
});

test("Range parsing: single ranges only", () => {
	assert.deepEqual(parseRange("bytes=0-99"), { offset: 0, end: 99 });
	assert.deepEqual(parseRange("bytes=100-"), { offset: 100 });
	assert.deepEqual(parseRange("bytes=-500"), { suffix: 500 });
	assert.equal(parseRange("bytes=0-99,200-299"), null); // Multi-range → whole file (200).
	assert.equal(parseRange("bytes=5-1"), null);
	assert.equal(parseRange("bytes=-0"), null);
	assert.equal(parseRange("items=0-1"), null);
	assert.equal(parseRange(null), null);
});

test("Range resolution clamps to the file", () => {
	assert.deepEqual(resolveRange({ suffix: 5000 }, 1000), { offset: 0, length: 1000 });
	assert.deepEqual(resolveRange({ suffix: 10 }, 1000), { offset: 990, length: 10 });
	assert.deepEqual(resolveRange({ offset: 900, end: 5000 }, 1000), { offset: 900, length: 100 });
	assert.deepEqual(resolveRange({ offset: 10 }, 1000), { offset: 10, length: 990 });
	assert.equal(resolveRange({ offset: 1000 }, 1000), null);
	assert.equal(resolveRange({ suffix: 1 }, 0), null);
});

test("If-Range", () => {
	const modified = new Date("2026-10-01T12:00:00Z");
	assert.ok(ifRangeMatches(null, '"abc"', modified));
	assert.ok(ifRangeMatches('"abc"', '"abc"', modified));
	assert.ok(!ifRangeMatches('"old"', '"abc"', modified));
	assert.ok(!ifRangeMatches('W/"abc"', '"abc"', modified));
	assert.ok(ifRangeMatches("Thu, 01 Oct 2026 12:00:00 GMT", '"abc"', modified));
	assert.ok(!ifRangeMatches("Wed, 30 Sep 2026 12:00:00 GMT", '"abc"', modified));
});

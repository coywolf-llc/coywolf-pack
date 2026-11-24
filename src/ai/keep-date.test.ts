/**
 * Unit tests for keepDates' restore (src/ai/keep-date.ts), on an in-memory
 * SQLite table with the columns EmDash gives every content table.
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/keep-date.test.ts
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as KD from "./keep-date.ts";

const keep = KD as typeof import("./keep-date.js");

const ORIGINAL = "2026-10-04T23:01:54.489Z";
const PUBLISHED = "2026-11-24T12:00:00.000Z";

/** A D1-shaped wrapper around node:sqlite, recording every statement. */
function database(row: Partial<Record<string, string | number | null>> = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, status TEXT, updated_at TEXT, published_at TEXT, deleted_at TEXT, version INTEGER, live_revision_id TEXT, draft_revision_id TEXT)`);
	const values = { id: "E1", slug: "joy", status: "published", updated_at: PUBLISHED, published_at: "2026-10-01T00:00:00.000Z", deleted_at: null, version: 5, live_revision_id: "R2", draft_revision_id: null, ...row };
	sqlite.prepare(`INSERT INTO ec_posts (id, slug, status, updated_at, published_at, deleted_at, version, live_revision_id, draft_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		values.id,
		values.slug,
		values.status,
		values.updated_at,
		values.published_at,
		values.deleted_at,
		values.version,
		values.live_revision_id,
		values.draft_revision_id,
	);
	const statements: string[] = [];
	const db = {
		prepare(sql: string) {
			statements.push(sql);
			return {
				bind: (...args: Array<string | number | null>) => ({
					run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
				}),
			};
		},
	};
	const read = () => sqlite.prepare("SELECT updated_at, version, published_at FROM ec_posts WHERE id = 'E1'").get() as { updated_at: string; version: number; published_at: string };
	return { db: db as unknown as D1Database, statements, read };
}

const after = { updatedAt: PUBLISHED, version: 5, liveRevisionId: "R2" };

test("restores the date when the row is exactly what the publish left; version stays", async () => {
	const d = database();
	assert.equal(await keep.restoreUpdatedAt(d.db, "posts", "E1", ORIGINAL, after), true);
	assert.deepEqual({ ...d.read() }, { updated_at: ORIGINAL, version: 5, published_at: "2026-10-01T00:00:00.000Z" });
	// A second try matches nothing (the date is already back).
	assert.equal(await keep.restoreUpdatedAt(d.db, "posts", "E1", ORIGINAL, after), false);
});

test("a row anything else touched is left alone: updated_at, version, live revision, a draft, trashed, unpublished", async () => {
	for (const [row, why] of [
		[{ updated_at: "2026-11-24T12:00:05.000Z" }, "saved since"],
		[{ version: 6 }, "version moved"],
		[{ live_revision_id: "R3" }, "another revision is live"],
		[{ draft_revision_id: "R4" }, "a draft is pending"],
		[{ deleted_at: "2026-11-24T12:01:00.000Z" }, "trashed"],
		[{ status: "draft" }, "unpublished"],
	] as const) {
		const d = database(row);
		assert.equal(await keep.restoreUpdatedAt(d.db, "posts", "E1", ORIGINAL, after), false, why);
		assert.notEqual(d.read().updated_at, ORIGINAL, why);
	}
});

test("a collection without revisions leaves the revision column out, but still needs no draft", async () => {
	const d = database({ live_revision_id: null });
	assert.equal(await keep.restoreUpdatedAt(d.db, "posts", "E1", ORIGINAL, { ...after, liveRevisionId: null }), true);
	assert.equal(d.read().updated_at, ORIGINAL);
	assert.ok(!d.statements[0].includes("live_revision_id"));
	const drafted = database({ live_revision_id: null, draft_revision_id: "R4" });
	assert.equal(await keep.restoreUpdatedAt(drafted.db, "posts", "E1", ORIGINAL, { ...after, liveRevisionId: null }), false);
});

test("a malformed collection slug throws before any SQL; nothing to restore runs no SQL", async () => {
	for (const slug of ["posts; DROP TABLE ec_posts", "Posts", "1posts", 'posts"', ""]) {
		const d = database();
		await assert.rejects(keep.restoreUpdatedAt(d.db, slug, "E1", ORIGINAL, after), /collection slug/);
		assert.deepEqual(d.statements, []);
	}
	const d = database();
	assert.equal(await keep.restoreUpdatedAt(d.db, "posts", "E1", PUBLISHED, after), false, "the date didn't move");
	assert.equal(await keep.restoreUpdatedAt(d.db, "posts", "E1", "", after), false, "no original date");
	assert.equal(await keep.restoreUpdatedAt(d.db, "posts", "E1", ORIGINAL, { ...after, version: Number.NaN }), false, "no version");
	assert.deepEqual(d.statements, []);
});

// Run: node --test test/coediting.test.mjs
// EmDash 1.5's co-editing (off on the sites for now): an open editor saves the entry every 2 to 10 seconds, each save
// fires content:beforeSave with only the changed fields, and writes that send _rev meet a version conflict more often.
// The pack's beforeSave hooks must not touch fields a save didn't send, and a conflict must leave an edit as a draft.
// (afterSave on every room save is the open item before co-editing can be turned on: see docs/internals.md.)
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { isConflict } = await import("../src/core/conflict.ts");
const { stampContent } = await import("../src/headings/stamp.ts");
const { beforeSave: breadcrumbsBeforeSave } = await import("../src/breadcrumbs/pack.ts");
const { beforeSave: reviewsBeforeSave } = await import("../src/reviews/pack.ts");
const { beforeSave: wpImportBeforeSave } = await import("../src/wpImport/pack.ts");

test("beforeSave with only the changed fields: hooks leave fields they weren't sent alone", async () => {
	const titleOnly = { title: "A new title" };
	assert.equal(stampContent(titleOnly, { anchors: true, toc: true, prefix: "", previous: null }), null);
	assert.equal(breadcrumbsBeforeSave({ content: titleOnly }), undefined);
	assert.equal(await reviewsBeforeSave({ content: titleOnly }), undefined);
	const ctx = { settings: { get: async () => null }, log: { info() {}, warn() {} } };
	assert.equal(await wpImportBeforeSave({ content: titleOnly, collection: "posts", editedBy: { id: "u2" } }, ctx), undefined);
	// A body-only save gets its anchors, and nothing else is added.
	const body = [{ _type: "block", _key: "h1", style: "h2", children: [{ _type: "span", text: "Hello world" }] }];
	const stamped = stampContent({ body }, { anchors: true, toc: true, prefix: "", previous: null });
	assert.deepEqual(Object.keys(stamped), ["body"]);
	assert.equal(stamped.body[0].anchor, "hello-world");
});

test("a version conflict is recognized in the forms EmDash raises it", () => {
	assert.equal(isConflict({ code: "CONFLICT", message: "x" }), true);
	assert.equal(isConflict(Object.assign(new Error("x"), { name: "ContentMutationConflictError" })), true);
	assert.equal(isConflict(new Error("ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint")), false, "SQLite's ON CONFLICT isn't one");
	assert.equal(isConflict({ code: "SLUG_CONFLICT" }), false);
	assert.equal(isConflict(new Error("D1_ERROR: Network connection lost.")), false);
	assert.equal(isConflict(null), false);
});

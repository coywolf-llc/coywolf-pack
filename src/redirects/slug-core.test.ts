/**
 * Run: node --test src/redirects/slug-core.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { SLUG_NOTE_PREFIX, planSlugChange } from "./slug-core.ts";

const ours = (id: string, source: string, target: string) => ({ id, source, target, note: `${SLUG_NOTE_PREFIX} Post` });
const manual = (id: string, source: string, target: string) => ({ id, source, target, note: null });

test("a new slug: one rule from the old URL to the new one", () => {
	assert.deepEqual(planSlugChange("/news/seo/old/", "/news/seo/new/", []), { kind: "apply", deleteIds: [], retargetIds: [], upsert: {} });
});

test("unchanged or unknown URLs do nothing", () => {
	assert.equal(planSlugChange("/a/", "/a", []).kind, "none");
	assert.equal(planSlugChange(null, "/a/", []).kind, "none");
	assert.equal(planSlugChange("/a/", null, []).kind, "none");
});

test("a second rename points the first rule at the new URL (no chain)", () => {
	const plan = planSlugChange("/b/", "/c/", [ours("r1", "/a", "/b/")]);
	assert.deepEqual(plan, { kind: "apply", deleteIds: [], retargetIds: ["r1"], upsert: {} });
});

test("renaming back deletes the rule that would shadow the live URL", () => {
	const plan = planSlugChange("/b/", "/a/", [ours("r1", "/a", "/b/")]);
	assert.equal(plan.kind, "apply");
	if (plan.kind !== "apply") return;
	assert.deepEqual(plan.deleteIds, ["r1"]);
	assert.deepEqual(plan.retargetIds, [], "the deleted rule isn't retargeted too");
	assert.deepEqual(plan.upsert, {});
});

test("our existing rule for the old URL is updated, not duplicated", () => {
	const plan = planSlugChange("/b/", "/c/", [ours("r2", "/b", "/somewhere/")]);
	assert.equal(plan.kind, "apply");
	if (plan.kind === "apply") assert.deepEqual(plan.upsert, { id: "r2" });
});

test("a hand-made rule for the old URL is left alone, and hand-made rules are never edited", () => {
	const plan = planSlugChange("/b/", "/c/", [manual("m1", "/b", "/elsewhere/"), manual("m2", "/x", "/b/"), manual("m3", "/c", "/b/")]);
	assert.equal(plan.kind, "apply");
	if (plan.kind !== "apply") return;
	assert.equal(plan.keptManual?.id, "m1");
	assert.deepEqual(plan.deleteIds, []);
	assert.deepEqual(plan.retargetIds, []);
});

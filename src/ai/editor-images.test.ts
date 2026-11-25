/**
 * Unit tests for AI Enrich's image text (src/ai/editor-images.ts): which images
 * miss text, filling only what's empty, and EmDash's limits on an action's answer.
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/editor-images.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as EI from "./editor-images.ts";

const images = EI as typeof import("./editor-images.js");

const img = (key: string, ref: unknown, more: Record<string, unknown> = {}) => ({ _type: "image", _key: key, asset: { _type: "reference", _ref: ref, url: `/_emdash/api/media/file/${key}.png` }, ...more });
const para = (text: string) => ({ _type: "block", _key: `b-${text.length}`, style: "normal", markDefs: [], children: [{ _type: "span", _key: "s", text, marks: [] }] });

test("the images that miss text: image fields first, then Portable Text at any depth (galleries too); ones with both are left out", () => {
	const data = {
		content: [
			para("Intro."),
			img("i1", "M1", { alt: "" }),
			img("i2", "M2", { alt: "A person wrote this.", caption: "And this." }),
			img("i3", "M3", { alt: "Written.", caption: "  " }),
			{ _type: "gallery", _key: "g1", images: [img("gi1", "M4"), img("gi2", "M5", { alt: "x", caption: "y" })] },
			{ _type: "columns", _key: "c1", columns: [{ content: [img("ci1", "M6", { caption: "Has one." })] }] },
		],
		featured_image: { id: "M7", provider: "local", alt: "", caption: "" },
		other_image: { id: "M8", alt: "Set", caption: "Set" },
	};
	const slots = images.imageSlots(data, ["content"], ["featured_image", "other_image"]);
	assert.deepEqual(
		slots.map((s) => [s.field, s.mediaId, s.needsAlt, s.needsCaption]),
		[
			["featured_image", "M7", true, true],
			["content", "M1", true, true],
			["content", "M3", false, true],
			["content", "M4", true, true],
			["content", "M6", true, false],
		],
	);
	assert.deepEqual(slots[3].path, [4, "images", 0]);
	assert.deepEqual(slots[4].path, [5, "columns", 0, "content", 0]);
	assert.deepEqual(slots[0].path, []);
});

test("an image added by URL or from another provider has no media item", () => {
	const data = {
		content: [img("u1", "/_emdash/api/media/file/abc.png"), { _type: "image", _key: "p1", asset: { _ref: "cf-123", provider: "cloudflare-images" } }, { _type: "image", _key: "n1", asset: { id: "M9" } }],
		hero: { id: "ext-1", provider: "external", src: "https://example.com/a.png" },
	};
	const slots = images.imageSlots(data, ["content"], ["hero"]);
	assert.deepEqual(slots.map((s) => s.mediaId), [null, null, null, "M9"]);
});

test("filling sets only what's empty, on a copy", () => {
	const content = [para("Intro."), img("i1", "M1", { alt: "" }), img("i2", "M2", { alt: "Mine." }), { _type: "gallery", _key: "g", images: [img("gi1", "M4")] }];
	const before = structuredClone(content);
	const out = images.withImageText(content, [
		{ path: [1], alt: "New alt.", caption: "New caption." },
		{ path: [2], alt: "Never this.", caption: "A caption." },
		{ path: [3, "images", 0], alt: "Gallery alt." },
		{ path: [9], alt: "No such node." },
	]) as Array<Record<string, unknown>>;
	assert.deepEqual(content, before, "the input is unchanged");
	assert.equal(out[1].alt, "New alt.");
	assert.equal(out[1].caption, "New caption.");
	assert.equal(out[2].alt, "Mine.", "text a person wrote stays");
	assert.equal(out[2].caption, "A caption.");
	assert.equal(((out[3].images as unknown[])[0] as Record<string, unknown>).alt, "Gallery alt.");
	assert.equal(((out[3].images as unknown[])[0] as Record<string, unknown>).caption, undefined);
	assert.equal(out.length, 4);
	assert.equal(out[0], content[0], "untouched blocks are shared, not copied");
	const field = images.withImageText({ id: "M7", alt: "", caption: "Kept." }, [{ path: [], alt: "Field alt.", caption: "Not this." }]);
	assert.deepEqual(field, { id: "M7", alt: "Field alt.", caption: "Kept." });
});

test("EmDash's response bounds: nodes, depth, array length, string and total size", async () => {
	const ok = { toast: { message: "Done.", type: "success" }, patch: { type: "editor-draft-patch", operations: [{ op: "set", field: "content", value: [para("Hello.")] }] } };
	assert.equal(images.responseFits(ok), true);
	// Each paragraph is 11 nodes (the block, its 3 strings, markDefs, children, the span, its 3 strings and marks).
	const many = (n: number) => ({ ...ok, patch: { ...ok.patch, operations: [{ op: "set", field: "content", value: Array.from({ length: n }, () => para("x")) }] } });
	assert.equal(images.responseFits(many(180)), true);
	assert.equal(images.responseFits(many(182)), false, "over 2000 nodes");
	// The same answers through EmDash's own check.
	const { validateContentEditorActionResponse } = await import("@emdash-cms/blocks/server");
	const policy = { pluginPagePaths: [], allowedImageHosts: [] };
	assert.equal(validateContentEditorActionResponse(many(180), policy).valid, true);
	assert.equal(validateContentEditorActionResponse(many(182), policy).valid, false);
	let deep: unknown = "x";
	for (let i = 0; i < 25; i++) deep = [deep];
	assert.equal(images.responseFits({ toast: ok.toast, deep }), false, "deeper than 20");
	assert.equal(images.responseFits({ list: Array.from({ length: 1001 }, () => 0) }), false, "an array over 1000 items");
	assert.equal(images.responseFits({ text: "x".repeat(64 * 1024 + 1) }), false, "a string over 64 KB");
	assert.equal(images.responseFits({ a: "x".repeat(60_000), b: "x".repeat(60_000), c: "x".repeat(60_000), d: "x".repeat(60_000), e: "x".repeat(60_000) }), false, "over 256 KB in all");
	assert.equal(images.jsonBytes({ a: "é" }), 10);
});

test("fitPatch: the fields with links first, each as full as fits: captions go from the last image back, then alt text", () => {
	const content = [para("Text."), img("i1", "M1"), img("i2", "M2")];
	const linked = [{ ...para("Text."), markDefs: [{ _key: "l", _type: "link", href: "https://glossary.io/x/" }] }, img("i1", "M1"), img("i2", "M2")];
	const fills: Array<{ path: number[]; alt: string; caption?: string }> = [{ path: [1], alt: "Alt one.", caption: "Caption one." }, { path: [2], alt: "Alt two.", caption: "Caption two." }];
	const fields = [
		{ field: "featured_image", base: { id: "M3", alt: "", caption: "" }, fills: [{ path: [], alt: "Featured alt.", caption: "Featured caption." }] },
		{ field: "content", base: content, linked, fills },
	];
	const all = images.fitPatch(fields, () => true);
	assert.equal(all.trimmed, false);
	assert.deepEqual([...all.values.keys()], ["content", "featured_image"]);
	assert.deepEqual(all.fills.get("content"), fills);
	assert.deepEqual([...all.linked], ["content"]);
	assert.deepEqual(all.values.get("content"), images.withImageText(linked, fills));

	// Room in one field for all but a caption: the last image's goes, then (with less room) the first's, then alt text.
	const one = [{ field: "content", base: content, linked, fills }];
	const size = (fs: typeof fills) => images.jsonBytes(images.withImageText(linked, fs));
	const room = (bytes: number) => images.fitPatch(one, (map) => images.jsonBytes(map.get("content")) <= bytes);
	assert.deepEqual(room(size([fills[0], { path: [2], alt: "Alt two." }])).fills.get("content"), [fills[0], { path: [2], alt: "Alt two." }]);
	assert.deepEqual(room(size([{ path: [1], alt: "Alt one." }, { path: [2], alt: "Alt two." }])).fills.get("content"), [{ path: [1], alt: "Alt one." }, { path: [2], alt: "Alt two." }]);
	const bare = room(size([]));
	assert.equal(bare.fills.has("content"), false);
	assert.deepEqual(bare.values.get("content"), linked, "the links alone");
	assert.equal(bare.trimmed, true);
});

test("fitPatch: a field whose links don't fit keeps its image text, and one that can't fit at all costs no other field its text", () => {
	const content = [para("Text."), img("i1", "M1")];
	const linked = [{ ...para("Text."), markDefs: [{ _key: "l", _type: "link", href: "https://glossary.io/x/" }] }, img("i1", "M1")];
	const featured = { field: "featured_image", base: { id: "M3", alt: "", caption: "" }, fills: [{ path: [], alt: "Featured alt.", caption: "Featured caption." }] };
	const fields = [featured, { field: "content", base: content, linked, fills: [{ path: [1], alt: "Alt one.", caption: "Caption one." }] }];

	// Over the field limit with its links (a 64 KB field): its image text without them.
	const noLinks = images.fitPatch(fields, (map) => !JSON.stringify(map.get("content") ?? "").includes("glossary.io"));
	assert.deepEqual(noLinks.values.get("content"), images.withImageText(content, fields[1].fills));
	assert.equal(noLinks.linked.size, 0);
	assert.deepEqual(noLinks.fills.get("featured_image"), featured.fills);
	assert.equal(noLinks.trimmed, true);

	// Too big in any version (the answer's node or size limits): left out, and the featured image keeps all its text.
	const without = images.fitPatch(fields, (map) => !map.has("content"));
	assert.deepEqual([...without.values.keys()], ["featured_image"]);
	assert.deepEqual(without.fills.get("featured_image"), featured.fills);
	assert.equal(without.trimmed, true);

	// A field with neither links nor image text isn't in the patch.
	assert.equal(images.fitPatch([{ field: "excerpt", base: "x", fills: [] }], () => true).values.size, 0);
});

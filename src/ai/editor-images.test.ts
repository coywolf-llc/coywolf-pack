/**
 * Unit tests for AI Enrich's image text (src/ai/editor-images.ts): which images
 * miss text, filling only what's empty, and the size of a value as JSON.
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

test("jsonBytes counts UTF-8 bytes of the JSON (the route's 2 MiB body cap)", () => {
	assert.equal(images.jsonBytes({ a: "é" }), Buffer.byteLength(JSON.stringify({ a: "é" })));
	assert.equal(images.jsonBytes(undefined), 0);
	assert.ok(images.LEFT_ALONE_REASON.startsWith("AI Enrich skips images"));
});

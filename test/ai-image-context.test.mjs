// Run: node --test test/ai-image-context.test.mjs
// AI image text with the article an image is used in (as Coywolf SEO's WordPress plugin did): title, the heading
// above the image, and a window of text on each side with the image's place marked.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { buildImageContext, CONTEXT_MARKER, CONTEXT_WINDOW_CHARS } = await import("../src/ai/image-context.ts");
const { imagePrompt } = await import("../src/ai/prompts.ts");

const block = (text, style = "normal") => ({ _type: "block", _key: text.slice(0, 8), style, children: [{ _type: "span", text }] });
const image = (ref, extra = {}) => ({ _type: "image", _key: `i-${ref}`, asset: { _ref: ref, url: `/_emdash/api/media/file/${ref}.jpg` }, ...extra });

test("title, the nearest heading above the image, and the text around its marker", () => {
	const body = [
		block("Intro paragraph."),
		block("Setting up APO", "h2"),
		block("Install the plugin first."),
		image("M1"),
		block("Then turn it on."),
		{ _type: "code", _key: "c", code: "const secret = 1;" },
		block("Later heading", "h2"),
	];
	const out = buildImageContext("Cloudflare APO for WordPress", [body], "M1", null);
	assert.equal(
		out,
		`Article title: Cloudflare APO for WordPress\nSection heading: Setting up APO\n\nIntro paragraph.\nSetting up APO\nInstall the plugin first.\n${CONTEXT_MARKER}\nThen turn it on.\nLater heading`,
	);
	assert.doesNotMatch(out, /secret/, "code blocks aren't sent");
});

test("the window is capped on each side; only the first use is marked; HTML blocks count as text", () => {
	const long = "word ".repeat(600).trim();
	const out = buildImageContext("T", [[block(long), image("M1"), { _type: "htmlBlock", _key: "h", html: "<p>After <strong>this</strong>.</p>" }, image("M1"), block(long)]], "M1", null);
	const [before, after] = out.split(CONTEXT_MARKER);
	assert.ok(before.startsWith("Article title: T\n\n…"), "trimmed before");
	assert.ok([...before.split("\n\n")[1]].length <= CONTEXT_WINDOW_CHARS + 1);
	assert.ok(after.endsWith("…"));
	assert.ok(after.includes("After this ."), "HTML stripped to text");
	assert.equal(out.split(CONTEXT_MARKER).length, 2, "one marker");
});

test("found by storage key when the block has only a URL; the title alone when the image isn't found", () => {
	const urlOnly = { _type: "image", _key: "u", asset: { url: "/_emdash/api/media/file/01KEY.webp" } };
	assert.match(buildImageContext("T", [[block("Before."), urlOnly]], "M9", "01KEY.webp"), new RegExp(`Before\\.\\n${CONTEXT_MARKER}`));
	assert.equal(buildImageContext("Only the title", [[block("No image here.")]], "M9", null), "Article title: Only the title");
	assert.equal(buildImageContext("", [[block("x")]], "M9", null), "");
});

test("the prompt: article context switches the intro and is appended with the marker rules; none keeps the stand-alone intro", () => {
	const base = { filename: "a.jpg", site: "Coywolf", locale: "en" };
	const without = imagePrompt(base);
	assert.match(without, /you are given no specific post context, so it must stand on its own/);
	assert.doesNotMatch(without, /appears in the article below/);
	const ctx = `Article title: T\n\nBefore.\n${CONTEXT_MARKER}\nAfter.`;
	const withIt = imagePrompt({ ...base, articleContext: ctx });
	assert.match(withIt, /it appears in the article shown below, so make the alternative text and caption fit how it is used there/);
	assert.match(withIt, /The marker «THE IMAGE BEING DESCRIBED» shows exactly where it sits/);
	assert.match(withIt, /never restate or summarize the article text/);
	assert.ok(withIt.endsWith(ctx));
	assert.match(withIt, /Add editorial context a sighted reader would value/);
});

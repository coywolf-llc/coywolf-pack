import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { escapeLineStart, escapeText, estimateTokens, frontmatter, markdownUrl, pagePathFromMarkdownPath, portableTextToMarkdown } = await import("../src/discovery/markdown.ts");

const span = (text, marks = []) => ({ _type: "span", _key: Math.random().toString(36).slice(2), text, marks });
const block = (children, extra = {}) => ({ _type: "block", _key: "b", style: "normal", markDefs: [], children, ...extra });

test("paragraphs and headings", () => {
	const md = portableTextToMarkdown([
		block([span("Title")], { style: "h2" }),
		block([span("Hello "), span("bold", ["strong"]), span(" and "), span("italic", ["em"]), span(" "), span("x()", ["code"])]),
		block([span("Sub")], { style: "h6" }),
	]);
	assert.equal(md, "## Title\n\nHello **bold** and _italic_ `x()`\n\n###### Sub");
});

test("links use markDefs and are absolutized; unsafe schemes are dropped", () => {
	const md = portableTextToMarkdown(
		[
			block([span("Read "), span("this", ["l1"]), span(" or "), span("that", ["l2"])], {
				markDefs: [
					{ _type: "link", _key: "l1", href: "/about/" },
					{ _type: "link", _key: "l2", href: "javascript:alert(1)" },
				],
			}),
		],
		{ absolute: (u) => new URL(u, "https://example.com/").href },
	);
	assert.equal(md, "Read [this](https://example.com/about/) or that");
});

test("bullet and numbered lists with nesting", () => {
	const md = portableTextToMarkdown([
		block([span("One")], { listItem: "bullet", level: 1 }),
		block([span("Nested")], { listItem: "number", level: 2 }),
		block([span("Nested two")], { listItem: "number", level: 2 }),
		block([span("Two")], { listItem: "bullet", level: 1 }),
		block([span("After")]),
		block([span("First")], { listItem: "number", level: 1 }),
		block([span("Second")], { listItem: "number", level: 1 }),
	]);
	assert.equal(md, "- One\n   1. Nested\n   2. Nested two\n- Two\n\nAfter\n\n1. First\n2. Second");
});

test("blockquote, break, code, image", () => {
	const md = portableTextToMarkdown(
		[
			block([span("Quoted")], { style: "blockquote" }),
			{ _type: "break", _key: "x", style: "lineBreak" },
			{ _type: "code", _key: "c", language: "ts", code: "const a = 1;\n```\n" },
			{ _type: "image", _key: "i", asset: { _ref: "m1", url: "/_emdash/api/media/file/a.jpg" }, alt: "A [cat]", caption: "Caption *here*" },
		],
		{ absolute: (u) => new URL(u, "https://example.com/").href },
	);
	assert.equal(
		md,
		"> Quoted\n\n---\n\n````ts\nconst a = 1;\n```\n````\n\n![A \\[cat\\]](https://example.com/_emdash/api/media/file/a.jpg)\n\n_Caption \\*here\\*_",
	);
});

test("tables become GFM tables, pipes escaped, colspan padded", () => {
	const cell = (text, extra = {}) => ({ _type: "tableCell", _key: text, content: [span(text)], ...extra });
	const md = portableTextToMarkdown([
		{
			_type: "table",
			_key: "t",
			hasHeaderRow: true,
			rows: [
				{ _type: "tableRow", _key: "r1", cells: [cell("Name", { isHeader: true }), cell("Value", { isHeader: true })] },
				{ _type: "tableRow", _key: "r2", cells: [cell("a|b"), cell("1")] },
				{ _type: "tableRow", _key: "r3", cells: [cell("wide", { colspan: 2 })] },
			],
		},
	]);
	assert.equal(md, "| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| wide |  |");
});

test("unknown blocks are skipped, JSON strings are parsed, empty blocks dropped", () => {
	const md = portableTextToMarkdown(JSON.stringify([{ _type: "embed", _key: "e", url: "https://x" }, block([span("")]), block([span("Kept")])]));
	assert.equal(md, "Kept");
	assert.equal(portableTextToMarkdown(null), "");
	assert.equal(portableTextToMarkdown("not json"), "");
});

test("text that looks like Markdown is escaped", () => {
	assert.equal(escapeText("a*b_c [d]"), "a\\*b\\_c \\[d\\]");
	assert.equal(portableTextToMarkdown([block([span("# not a heading")])]), "\\# not a heading");
	assert.equal(portableTextToMarkdown([block([span("1. not a list")])]), "1\\. not a list");
});

test("fences, thematic breaks and setext underlines at line start are escaped", () => {
	assert.equal(escapeLineStart("~~~ts"), "\\~~~ts");
	assert.equal(escapeLineStart("  ~~~"), "  \\~~~");
	assert.equal(escapeLineStart("---"), "\\---");
	assert.equal(escapeLineStart("- - -"), "\\- - -");
	assert.equal(escapeLineStart("==="), "\\===");
	assert.equal(escapeLineStart("___"), "\\___");
	assert.equal(escapeLineStart("* * *"), "\\* * *");
	assert.equal(escapeLineStart("~~ok~~"), "~~ok~~");
	assert.equal(escapeLineStart("--> arrow"), "--> arrow");
	assert.equal(escapeLineStart("a --- b"), "a --- b");
	// End to end: escapeText already escapes * and _, the rest are caught here.
	assert.equal(portableTextToMarkdown([block([span("Title\n===\n---\n~~~\n***")])]), "Title  \n\\===  \n\\---  \n\\~~~  \n\\*\\*\\*");
});

test("frontmatter, tokens, and .md URLs", () => {
	assert.equal(frontmatter({ title: 'Say "hi"', empty: "", sources: ["https://a/"] }), '---\ntitle: "Say \\"hi\\""\nsources:\n  - "https://a/"\n---\n');
	assert.equal(estimateTokens("abcdefgh"), 2);
	assert.equal(estimateTokens(""), 1);
	assert.equal(markdownUrl("https://example.com/blog/post?x=1#y"), "https://example.com/blog/post/index.html.md");
	assert.equal(markdownUrl("https://example.com/blog/post/"), "https://example.com/blog/post/index.html.md");
	assert.equal(pagePathFromMarkdownPath("/blog/post/index.html.md"), "/blog/post/");
	assert.equal(pagePathFromMarkdownPath("/index.html.md"), "/");
	assert.equal(pagePathFromMarkdownPath("/blog/post"), null);
});

test("images in Markdown point at the media host when there is one (not the site's /_emdash/api/media/ route)", async () => {
	const lib = await import("../src/images/lib.ts");
	const md = portableTextToMarkdown;
	lib.setStoragePublicUrl("https://media.example.com");
	try {
		const out = md([{ _type: "image", _key: "i", asset: { _ref: "m1", url: "/_emdash/api/media/file/a.jpg" }, alt: "A cat" }], { absolute: (u) => new URL(u, "https://example.com").href });
		assert.match(out, /!\[A cat\]\(https:\/\/media\.example\.com\/a\.jpg\)/);
		const byKey = md([{ _type: "image", _key: "k", asset: { _ref: "m2", meta: { storageKey: "B.png" } }, alt: "B" }], { absolute: (u) => new URL(u, "https://example.com").href });
		assert.match(byKey, /!\[B\]\(https:\/\/media\.example\.com\/B\.png\)/);
	} finally {
		lib.setStoragePublicUrl(null);
	}
});

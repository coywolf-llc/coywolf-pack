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

test("the optional hooks (Buttondown Drafts): image swaps an image's URL, unknownBlock renders blocks it would skip; without them nothing changes", () => {
	const value = [
		{ _type: "image", _key: "i", asset: { url: "/_emdash/api/media/file/a.webp" }, alt: "A" },
		{ _type: "coywolf-note", _key: "n", body: "Hi" },
		{ _type: "mystery", _key: "m" },
	];
	assert.equal(portableTextToMarkdown(value), "![A](/_emdash/api/media/file/a.webp)", "the default: unknown blocks are skipped");
	const seen = [];
	const md = portableTextToMarkdown(value, {
		image: (url, node) => (seen.push(node._key), `${url}?email`),
		unknownBlock: (node) => (node._type === "coywolf-note" ? "> Hi" : null),
	});
	assert.equal(md, "![A](/_emdash/api/media/file/a.webp?email)\n\n> Hi");
	assert.deepEqual(seen, ["i"]);
});

test("links: a dangerous scheme hidden with a tab, a line break or a control character is dropped too (as a browser reads it)", async () => {
	const { dangerousHref, normalizeHref, safeHref } = await import("../src/discovery/markdown.ts");
	// What build.ts passes: new URL(href, base) removes tabs, line breaks and leading control characters.
	const absolute = (href) => (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") ? href : new URL(href, "https://coywolf.com/").href);
	const hidden = ["java\tscript:alert(1)", "\u0001javascript:alert(1)", "java\nscript:alert(1)", "java\r\nscript:alert(1)", " \u0000 JaVa\tScRiPt:alert(1)", "javascript\t:alert(1)", "\u001f javascript:alert(1)", "vb\tscript:msgbox(1)", "\u0002vbscript:x", "d\nata:text/html,x", "\tdata:text/html,x"];
	for (const href of hidden) {
		const name = JSON.stringify(href);
		assert.equal(dangerousHref(href), true, name);
		for (const options of [{ absolute }, {}, { absolute: (u) => u }]) {
			assert.equal(safeHref(href, options), null, name);
			const md = portableTextToMarkdown([block([span("x", ["l"])], { markDefs: [{ _type: "link", _key: "l", href }] }), { _type: "image", _key: "i", asset: { url: "/a.png" }, alt: "A", link: href }, { _type: "image", _key: "j", asset: { url: href }, alt: "B" }], options);
			assert.equal(md, `x\n\n![A](${options.absolute === absolute ? "https://coywolf.com" : ""}/a.png)`, name);
			assert.doesNotMatch(md, /script:|data:/i, name);
		}
	}
	// A link that `absolute` itself would turn into one is dropped as it goes out.
	assert.equal(safeHref("/x", { absolute: () => "javascript:alert(1)" }), null);
	// Real links come out as they did.
	assert.equal(normalizeHref(" \u0001\thttps://a.com/x\ty \n"), "https://a.com/xy");
	for (const href of ["https://a.com/x", "/about/", "#top", "mailto:hi@coywolf.com", "about/javascript:x", "/data:x", "https://a.com/?u=javascript:alert(1)", "java%09script:alert(1)", "javascripts:x", "database:x"]) assert.equal(dangerousHref(href), false, href);
	assert.equal(safeHref(" /a b(c) ", { absolute }), "https://coywolf.com/a%20b(c)");
	assert.equal(safeHref("https://a.com/a\tb", {}), "https://a.com/a%09b", "as before");
	assert.equal(safeHref("javascript:alert(1)", {}), null);
	assert.equal(safeHref("", {}), null);
	assert.equal(safeHref(null, {}), null);
});

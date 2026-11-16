// Run: node --test test/buttondown-body.test.mjs
//
// The email Buttondown Drafts writes for a post (src/buttondown/body.ts, src/buttondown/blocks.ts): the
// plaintext editor-mode comment and no frontmatter, email-safe images, absolute links, the Pack's blocks as
// Markdown (a placeholder and a warning for anything else), the footer link, template code escaped for Buttondown (verbatim), the
// fields' rules and a hash that changes with any of them.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { buildEmail, emailImage, imageValueUrl, MODE_COMMENT, siteHost, entryKey, packMetadata, startsWithFrontmatter } = await import("../src/buttondown/body.ts");
const { renderTableBlock, renderUnknownBlock, richToMarkdown, watchUrl } = await import("../src/buttondown/blocks.ts");
const lib = await import("../src/images/lib.ts");

const span = (text, marks = []) => ({ _type: "span", _key: Math.random().toString(36).slice(2), text, marks });
const block = (children, extra = {}) => ({ _type: "block", _key: "b", style: "normal", markDefs: [], children, ...extra });
const image = (url, extra = {}) => ({ _type: "image", _key: Math.random().toString(36).slice(2), asset: { url }, alt: "Alt", ...extra });
/** A table block: each row is a list of cells, a cell is its text or its spans. */
const tableCell = (content, extra = {}) => ({ _type: "tableCell", _key: Math.random().toString(36).slice(2), content: typeof content === "string" ? [span(content)] : content, ...extra });
const tableBlock = (rows, extra = {}) => ({ _type: "table", _key: "t", rows: rows.map((cells) => ({ _type: "tableRow", cells: cells.map((c) => (c?._type === "tableCell" ? c : tableCell(c))) })), ...extra });
/** The email's table tag: Buttondown's class, and the space above and below that its CSS leaves out. */
const TABLE_OPEN = '<table class="buttondown-block-styled" style="margin:16px 0;">';
/** The email's HTML table, from each cell's inner HTML: the first row is the header. */
const tableHtml = ([head, ...rows]) => {
	const row = (cells, tag) => ["<tr>", ...cells.map((c) => `<${tag}>${c}</${tag}>`), "</tr>"];
	return [TABLE_OPEN, "<thead>", ...row(head, "th"), "</thead>", ...(rows.length ? ["<tbody>", ...rows.flatMap((r) => row(r, "td")), "</tbody>"] : []), "</table>"].join("\n");
};

const source = (extra = {}) => ({
	collection: "posts",
	entryId: "01POST",
	key: "coywolf.com:posts:01POST",
	title: "Why Claude has my attention",
	excerpt: "An excerpt.",
	seoDescription: "SEO description.",
	slug: "why-claude-has-my-attention",
	postUrl: "https://coywolf.com/newsletter/why-claude-has-my-attention/",
	siteUrl: "https://coywolf.com",
	bodyFields: [[block([span("Hello.")])]],
	featuredImage: null,
	footerLink: true,
	...extra,
});

function withMediaHost(fn) {
	lib.setStoragePublicUrl("https://media.coywolf.com");
	try {
		return fn();
	} finally {
		lib.setStoragePublicUrl(null);
	}
}

test("the body starts with the plaintext mode comment and never with frontmatter (a leading rule is dropped)", async () => {
	const { fields } = await buildEmail(source({ bodyFields: [[{ _type: "break", _key: "x" }, { _type: "break", _key: "y" }, block([span("First")])]] }));
	assert.ok(fields.body.startsWith(`${MODE_COMMENT}\nFirst`), fields.body);
	assert.doesNotMatch(fields.body.slice(MODE_COMMENT.length).trimStart(), /^---/);
	assert.doesNotMatch(fields.body, /^title:/m, "no frontmatter fields");
});

test("Portable Text fields in order, relative links absolute, and the footer link after a rule (or not)", async () => {
	const link = block([span("our "), span("about page", ["l"])], { markDefs: [{ _type: "link", _key: "l", href: "/about/" }] });
	const built = await buildEmail(source({ bodyFields: [[link], [block([span("Second field")])]] }));
	assert.equal(
		built.fields.body,
		`${MODE_COMMENT}\nour [about page](https://coywolf.com/about/)\n\nSecond field\n\n---\n\n[Read it on coywolf.com](https://coywolf.com/newsletter/why-claude-has-my-attention/)\n`,
	);
	const plain = await buildEmail(source({ footerLink: false }));
	assert.equal(plain.fields.body, `${MODE_COMMENT}\nHello.\n`);
});

test("images: media-library JPEG, PNG and GIF keep their format at 1200 px; WebP and HEIC become JPEG; AVIF, SVG and no media host use the original with a warning", async () => {
	withMediaHost(() => {
		const abs = (u) => new URL(u, "https://coywolf.com/").href;
		assert.equal(emailImage("/_emdash/api/media/file/01ABC.jpg", abs).url, "https://media.coywolf.com/cdn-cgi/image/width=1200,fit=scale-down,quality=85/01ABC.jpg");
		assert.equal(emailImage("https://media.coywolf.com/01ABC.png", abs).url, "https://media.coywolf.com/cdn-cgi/image/width=1200,fit=scale-down,quality=85/01ABC.png");
		assert.equal(emailImage("https://media.coywolf.com/s/800/01ABC.gif", abs).url, "https://media.coywolf.com/cdn-cgi/image/width=1200,fit=scale-down,quality=85/01ABC.gif");
		assert.equal(emailImage("/_emdash/api/media/file/01ABC.webp", abs).url, "https://media.coywolf.com/cdn-cgi/image/width=1200,fit=scale-down,quality=85,format=jpeg/01ABC.webp");
		assert.equal(emailImage("/_emdash/api/media/file/01ABC.heic", abs).url, "https://media.coywolf.com/cdn-cgi/image/width=1200,fit=scale-down,quality=85,format=jpeg/01ABC.heic");
		// Cloudflare doesn't resize or convert SVG (it ignores the options and serves the SVG): the original, with the warning.
		assert.deepEqual(emailImage("/_emdash/api/media/file/01ABC.svg", abs), { url: "https://media.coywolf.com/01ABC.svg", kind: "original", risky: false });
		assert.deepEqual(emailImage("https://other.example/logo.svg", abs), { url: "https://other.example/logo.svg", kind: "external", risky: true });
		assert.deepEqual(emailImage("/_emdash/api/media/file/01ABC.avif", abs), { url: "https://media.coywolf.com/01ABC.avif", kind: "original", risky: false });
		assert.deepEqual(emailImage("https://other.example/pic.webp", abs), { url: "https://other.example/pic.webp", kind: "external", risky: true });
		assert.deepEqual(emailImage("https://other.example/pic.jpg?x=1", abs), { url: "https://other.example/pic.jpg?x=1", kind: "external", risky: false });
	});
	const abs = (u) => new URL(u, "https://coywolf.com/").href;
	assert.deepEqual(emailImage("/_emdash/api/media/file/01ABC.webp", abs), { url: "https://coywolf.com/_emdash/api/media/file/01ABC.webp", kind: "original", risky: false });

	const built = await withMediaHost(() => buildEmail(source({ bodyFields: [[image("/_emdash/api/media/file/a.webp"), image("/_emdash/api/media/file/b.avif"), image("https://x.example/c.webp")]], featuredImage: "/_emdash/api/media/file/f.png" })));
	assert.match(built.fields.body, /!\[Alt\]\(https:\/\/media\.coywolf\.com\/cdn-cgi\/image\/width=1200,fit=scale-down,quality=85,format=jpeg\/a\.webp\)/);
	assert.equal(built.fields.image, "https://media.coywolf.com/cdn-cgi/image/width=1200,fit=scale-down,quality=85/f.png");
	assert.ok(built.warnings.some((w) => /1 image can't be resized/.test(w)), built.warnings.join("\n"));
	assert.ok(built.warnings.some((w) => /1 image is WebP, AVIF or SVG/.test(w)), built.warnings.join("\n"));
	const svg = await withMediaHost(() => buildEmail(source({ bodyFields: [[image("/_emdash/api/media/file/logo.svg")]] })));
	assert.match(svg.fields.body, /!\[Alt\]\(https:\/\/media\.coywolf\.com\/logo\.svg\)/);
	assert.ok(svg.warnings.some((w) => /1 image can't be resized for email \(an AVIF or SVG file/.test(w)), svg.warnings.join("\n"));
});

test("an image field's value: a URL, EmDash's media value (src, url, or the storage key), else nothing", () => {
	assert.equal(imageValueUrl("https://x.example/a.jpg"), "https://x.example/a.jpg");
	assert.equal(imageValueUrl({ id: "m1", src: "/_emdash/api/media/file/a.jpg" }), "/_emdash/api/media/file/a.jpg");
	assert.equal(imageValueUrl({ id: "m1", meta: { storageKey: "01AB.png" } }), "/_emdash/api/media/file/01AB.png");
	assert.equal(imageValueUrl({ id: "m1" }), null);
	assert.equal(imageValueUrl(null), null);
});

const ctx = (extra = {}) => {
	const warnings = [];
	return {
		warnings,
		postUrl: "https://coywolf.com/newsletter/p/",
		siteHost: "coywolf.com",
		absolute: (u) => new URL(u, "https://coywolf.com/").href,
		image: (u) => `IMG(${u})`,
		warn: (w) => warnings.push(w),
		...extra,
	};
};

test("the Pack's blocks as Markdown", () => {
	const c = ctx({ files: new Map([["01FILE", { name: "guide.pdf", size: 2_516_582, href: "https://coywolf.com/files/01FILE/guide.pdf" }]]) });
	assert.equal(renderUnknownBlock({ _type: "coywolf-video", title: "The demo", posterImage: "/_emdash/api/media/file/p.jpg" }, c), "[![The demo](https://coywolf.com/IMG%28/_emdash/api/media/file/p.jpg%29)](https://coywolf.com/newsletter/p/)\n\n[▶ Watch the video: The demo](https://coywolf.com/newsletter/p/)");
	assert.equal(renderUnknownBlock({ _type: "coywolf-video" }, c), "[▶ Watch the video](https://coywolf.com/newsletter/p/)");
	assert.equal(renderUnknownBlock({ _type: "coywolf-file", id: "01FILE", title: "The guide" }, c), "[Download: The guide (2.4 MB)](https://coywolf.com/files/01FILE/guide.pdf)");
	assert.equal(renderUnknownBlock({ _type: "coywolf-file", id: "01MISSING" }, c), "[Download: the file](https://coywolf.com/newsletter/p/)");
	assert.equal(renderUnknownBlock({ _type: "coywolf-note", variant: "tip", body: "Use **this** [link](/x/)." }, c), "> **Tip**\n>\n> Use **this** [link](https://coywolf.com/x/).");
	// Found live (2026-11-15): a note's bold was dropped. Bold and italic stay in the note, details, disclosure and quote fallbacks.
	assert.equal(renderUnknownBlock({ _type: "coywolf-note", variant: "tip", body: "A **tip** note block" }, c), "> **Tip**\n>\n> A **tip** note block");
	assert.equal(renderUnknownBlock({ _type: "coywolf-details", summary: "More", body: "<strong>Bold</strong> and <em>italic</em>" }, c), "> **More**\n>\n> **Bold** and *italic*");
	assert.equal(renderUnknownBlock({ _type: "coywolf-disclosure", kind: "affiliate", text: "Some links **pay** me." }, c), "> _Some links **pay** me._");
	assert.equal(renderUnknownBlock({ _type: "coywolf-quote", quote: "To **be**, or <i>not</i>.", citation: "<b>Someone</b>" }, c), "> To **be**, or *not*.\n>\n> — **Someone**");
	assert.equal(renderUnknownBlock({ _type: "coywolf-testimonial", quote: "**Great.**", name: "Ana" }, c), "> **Great.**\n>\n> — Ana");
	assert.equal(renderUnknownBlock({ _type: "coywolf-note", title: "Heads up", hideTitle: true, body: "Body" }, c), "> Body");
	assert.equal(renderUnknownBlock({ _type: "coywolf-details", summary: "More", body: "Line one\nLine two" }, c), "> **More**\n>\n> Line one  \n> Line two");
	assert.equal(renderUnknownBlock({ _type: "coywolf-disclosure", kind: "amazon" }, c), "> _As an Amazon Associate I earn from qualifying purchases._");
	assert.equal(renderUnknownBlock({ _type: "coywolf-quote", quote: "To be.", citation: "Someone" }, c), "> To be.\n>\n> — Someone");
	assert.equal(renderUnknownBlock({ _type: "coywolf-testimonial", quote: "Great.", name: "Ana", title: "CEO", nameUrl: "https://ana.example/" }, c), "> Great.\n>\n> — [Ana](https://ana.example/), CEO");
	assert.equal(
		renderUnknownBlock({ _type: "coywolf-podcast", source: "block", heading: "Listen", apple: "https://podcasts.apple.com/x", rss: "https://coywolf.com/feed.xml" }, c),
		"**Listen**\n\n- [Apple Podcasts](https://podcasts.apple.com/x)\n- [RSS feed](https://coywolf.com/feed.xml)",
	);
	assert.equal(renderUnknownBlock({ _type: "coywolf-podcast", source: "site" }, c), null, "no links anywhere: nothing");
	assert.equal(
		renderUnknownBlock({ _type: "coywolf-review", itemName: "Widget", rating: 4.5, pros: "Fast\nCheap", cons: "Loud" }, c),
		"**Widget**\n\nRating: 4.5 / 5\n\n**What I liked most**\n\n- Fast\n- Cheap\n\n**Could be better**\n\n- Loud",
	);
	assert.equal(renderUnknownBlock({ _type: "embed", url: "https://www.youtube.com/watch?v=1", title: "A talk" }, c), "[A talk](https://www.youtube.com/watch?v=1)");
	assert.equal(renderUnknownBlock({ _type: "button", url: "/signup/", text: "Sign up" }, c), "[Sign up](https://coywolf.com/signup/)");
	assert.deepEqual(c.warnings, [], "nothing above is a warning");
});

test("a video player embed links to the video's own page: YouTube (and youtube-nocookie) to watch?v=, Vimeo to vimeo.com/<id>; other embeds stay", () => {
	const c = ctx();
	const embed = (url, extra = {}) => renderUnknownBlock({ _type: "iframe", src: url, ...extra }, c);
	// Found live (2026-11-15): an iframe of YouTube came out as a link to /embed/<id>.
	assert.equal(embed("https://www.youtube.com/embed/dQw4w9WgXcQ"), "[https://www.youtube.com/watch?v=dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ)");
	assert.equal(embed("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0", { title: "A talk" }), "[A talk](https://www.youtube.com/watch?v=dQw4w9WgXcQ)");
	assert.equal(embed("//youtube.com/embed/dQw4w9WgXcQ?start=90&autoplay=1", { title: "A talk" }), "[A talk](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s)");
	assert.equal(renderUnknownBlock({ _type: "embed", url: "https://player.vimeo.com/video/76979871?h=8272103f6e&title=0", title: "A film" }, c), "[A film](https://vimeo.com/76979871/8272103f6e)");
	assert.equal(embed("https://player.vimeo.com/video/76979871"), "[https://vimeo.com/76979871](https://vimeo.com/76979871)");
	assert.equal(watchUrl("https://m.youtube.com/embed/dQw4w9WgXcQ/"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
	// Left as they are: a playlist player, a watch link, another host (also one that only looks like YouTube), a button.
	for (const url of ["https://www.youtube.com/embed/videoseries?list=PL123", "https://www.youtube.com/embed/live_stream?channel=UC1", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://vimeo.com/76979871", "https://player.vimeo.com/video/abc", "https://youtube.com.evil.example/embed/dQw4w9WgXcQ", "https://open.spotify.com/embed/episode/1", "not a url"]) assert.equal(watchUrl(url), url, url);
	assert.equal(embed("https://open.spotify.com/embed/episode/1", { title: "Listen" }), "[Listen](https://open.spotify.com/embed/episode/1)");
	assert.equal(renderUnknownBlock({ _type: "button", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", text: "Player" }, c), "[Player](https://www.youtube.com/embed/dQw4w9WgXcQ)", "a button's link is the author's own");
	assert.equal(embed("javascript:alert(1)").startsWith("_[Part of"), true);
	assert.deepEqual(c.warnings, ["block:iframe"]);
});

test("navigation blocks are left out quietly; anything else is a placeholder linking to the post, and a warning naming it", () => {
	const c = ctx();
	assert.equal(renderUnknownBlock({ _type: "coywolf-toc" }, c), null);
	assert.equal(renderUnknownBlock({ _type: "coywolf-breadcrumbs" }, c), null);
	assert.deepEqual(c.warnings, []);
	assert.equal(renderUnknownBlock({ _type: "gallery" }, c), "_[Part of this post isn't shown in email. Read it on coywolf.com.](https://coywolf.com/newsletter/p/)_");
	assert.equal(renderUnknownBlock({ _type: "embed" }, c), "_[Part of this post isn't shown in email. Read it on coywolf.com.](https://coywolf.com/newsletter/p/)_", "an embed without a URL");
	assert.equal(renderUnknownBlock({ _type: "button", url: "javascript:alert(1)" }, c).startsWith("_[Part of"), true);
	assert.deepEqual(c.warnings, ["block:gallery", "block:embed", "block:button"]);
});

test("a post's skipped blocks become one warning on the email", async () => {
	const built = await buildEmail(source({ bodyFields: [[block([span("Hi")]), { _type: "gallery", _key: "g" }, { _type: "gallery", _key: "h" }, { _type: "coywolf-toc", _key: "t" }]] }));
	assert.deepEqual(built.warnings, ["2 blocks can't be shown in email (gallery): the email links to the post there."]);
	assert.equal((built.fields.body.match(/Part of this post isn't shown in email/g) ?? []).length, 2);
});

test("rich text keeps links and paragraphs, and stays text (no stray Markdown)", () => {
	const abs = { absolute: (u) => new URL(u, "https://coywolf.com/").href };
	assert.equal(richToMarkdown('<p>One <a href="/a/">two</a> &amp; <script>x</script>three</p><p># not a heading</p>', abs), "One [two](https://coywolf.com/a/) & three\n\n\\# not a heading");
	// A javascript: link isn't a link (and its text stays escaped text).
	// Bold stays bold. A single *star* is text on the site too (its rich text reads only **bold** and links), so it stays text.
	assert.equal(richToMarkdown("**Bold** and *stars* and [x](javascript:alert(1))", abs), "**Bold** and \\*stars\\* and \\[x\\](javascript:alert(1))");
	assert.equal(richToMarkdown("[x](javascript:alert)", abs), "x");
	assert.equal(richToMarkdown("", abs), "");
});

test("rich text keeps bold and italic: **bold**, <strong>, <b>, <em>, <i>; everything else stays escaped text", () => {
	const abs = { absolute: (u) => new URL(u, "https://coywolf.com/").href };
	assert.equal(richToMarkdown("A **tip** note block", abs), "A **tip** note block");
	assert.equal(richToMarkdown('<strong class="x">Bold</strong>, <b>bold</b>, <em>italic</em> and <i>italic</i>', abs), "**Bold**, **bold**, *italic* and *italic*");
	assert.equal(richToMarkdown("<strong><em>Both</em></strong> and **a [link](/x/)**", abs), "***Both*** and **a [link](https://coywolf.com/x/)**");
	// Spaces just inside a pair move outside it (Markdown wouldn't read "** x **" as bold).
	assert.equal(richToMarkdown("one<strong> two </strong>three", abs), "one **two** three");
	// Characters inside stay escaped; a mark without its pair, an empty pair and other tags leave nothing behind.
	assert.equal(richToMarkdown("**a_b [c]** <strong>open <em></em> <u>under</u> **", abs), "**a\\_b \\[c\\]** open under \\*\\*");
	// Bold doesn't cross a paragraph; within one, it crosses a line break.
	assert.equal(richToMarkdown("<p><strong>One</p><p>Two</strong></p>", abs), "One\n\nTwo");
	assert.equal(richToMarkdown("<strong>One<br>Two</strong>", abs), "**One  \nTwo**");
	// <br>, <blockquote> and <img> aren't bold or italic; control characters in the text can't forge a mark.
	assert.equal(richToMarkdown('a<br>b <img src="x"> \u0001c\u0002', abs), "a  \nb c");
});

// What Buttondown's Django templating does to a body, as far as the escape goes (django.template.base Lexer): a tag
// never crosses a line; inside a verbatim block everything is text until the one tag that closes it; `templatetag`
// prints a bracket pair. A variable or comment outside verbatim is "run": `ran` collects it. Any other tag throws.
function django(body, ran = []) {
	const names = { openvariable: "{{", closevariable: "}}", openblock: "{%", closeblock: "%}", opencomment: "{#", closecomment: "#}", openbrace: "{", closebrace: "}" };
	let out = "";
	let verbatim = "";
	let last = 0;
	const text = (t) => (out += t);
	for (const m of body.matchAll(/\{%[^\n]*?%\}|\{\{[^\n]*?\}\}|\{#[^\n]*?#\}/g)) {
		text(body.slice(last, m.index));
		last = m.index + m[0].length;
		const token = m[0];
		const content = token.slice(2, -2).trim();
		if (verbatim) {
			if (token.startsWith("{%") && content === verbatim) verbatim = "";
			else text(token);
		} else if (!token.startsWith("{%")) ran.push(token);
		else if (content === "verbatim" || content.startsWith("verbatim ")) verbatim = `end${content}`;
		else if (/^templatetag \w+$/.test(content) && names[content.slice(12)]) text(names[content.slice(12)]);
		else throw new Error(`Django would run ${token}`);
	}
	assert.equal(verbatim, "", "a verbatim block is never left open");
	return out + body.slice(last);
}
const V = (text) => `{% verbatim pack %}${text}{% endverbatim pack %}`;
const noFooter = (bodyFields, extra = {}) => source({ bodyFields: [bodyFields], footerLink: false, ...extra });
/** The email body for the blocks, the same body as Buttondown prints it, and whether Django ran anything. */
async function escaped(blocks) {
	const built = await buildEmail(noFooter(blocks));
	const ran = [];
	const printed = django(built.fields.body, ran);
	assert.deepEqual(ran, [], "nothing is run");
	assert.deepEqual(built.warnings, [], "no warning: it's handled");
	return { body: built.fields.body.slice(MODE_COMMENT.length + 1, -1), printed: printed.slice(MODE_COMMENT.length + 1, -1), hash: built.hash };
}

test("template code: a code block with {{ x }} has its code wrapped in verbatim, first line to last, inside the fence", async () => {
	// The live case (2026-11-15): Buttondown printed this line without "{{ example }}".
	const one = await escaped([{ _type: "code", _key: "c", language: "html", code: "<!-- Template code test: {{ example }} -->" }]);
	assert.equal(one.body, "```html\n{% verbatim pack %}<!-- Template code test: {{ example }} -->{% endverbatim pack %}\n```");
	assert.equal(one.printed, "```html\n<!-- Template code test: {{ example }} -->\n```", "Buttondown prints the code as written");
	const many = await escaped([{ _type: "code", _key: "c", filename: "page.html", code: "<ul>\n{% for x in list %}\n\n  <li>{{ x }}</li>\n{% endfor %}\n</ul>\n" }]);
	assert.equal(many.body, "page.html\n\n```\n{% verbatim pack %}<ul>\n{% for x in list %}\n\n  <li>{{ x }}</li>\n{% endfor %}\n</ul>{% endverbatim pack %}\n```", "one block around the code: the fence lines, the blank line and the indent stay");
	assert.equal(many.printed, "page.html\n\n```\n<ul>\n{% for x in list %}\n\n  <li>{{ x }}</li>\n{% endfor %}\n</ul>\n```");
	// A longer fence (the code has ``` in it) is still the fence.
	const fenced = await escaped([{ _type: "code", _key: "c", code: "```\n{{ x }}\n```" }]);
	assert.equal(fenced.body, "````\n{% verbatim pack %}```\n{{ x }}\n```{% endverbatim pack %}\n````");
});

test("template code: a paragraph with {% if %}, and one with {# c #}, are wrapped on their own line (no line added)", async () => {
	const tag = await escaped([block([span("Before.")]), block([span("Use {% if user %}hi{% endif %} here.")]), block([span("After.")])]);
	assert.equal(tag.body, `Before.\n\n${V("Use {% if user %}hi{% endif %} here.")}\n\nAfter.`);
	assert.equal(tag.printed, "Before.\n\nUse {% if user %}hi{% endif %} here.\n\nAfter.");
	const comment = await escaped([block([span("A comment is {# c #}.")])]);
	assert.equal(comment.body, V("A comment is {# c #}."));
	assert.equal(comment.printed, "A comment is {# c #}.");
	// A hard break: each line with template code is wrapped by itself, and the break's two spaces stay at the line's end.
	const lines = await escaped([block([span("One {{ a }}\nTwo\nThree {{ b }}")])]);
	assert.equal(lines.body, `${V("One {{ a }}")}  \nTwo  \n${V("Three {{ b }}")}`);
	assert.equal(lines.printed, "One {{ a }}  \nTwo  \nThree {{ b }}");
});

test("template code: inline code, a heading, a quote line and an image's alt text", async () => {
	const code = await escaped([block([span("Type "), span("{{ x }}", ["code"]), span(" to print "), span("it", ["strong"]), span(".")])]);
	assert.equal(code.body, V("Type `{{ x }}` to print **it**."));
	assert.equal(code.printed, "Type `{{ x }}` to print **it**.");
	const heading = await escaped([block([span("The {% url %} tag")], { style: "h2" })]);
	assert.equal(heading.body, `## ${V("The {% url %} tag")}`, "the hashes stay in front");
	const quote = await escaped([block([span("Plain\n{{ x }} quoted")], { style: "blockquote" })]);
	assert.equal(quote.body, `> Plain  \n> ${V("{{ x }} quoted")}`, "the quote mark stays in front");
	assert.equal(quote.printed, "> Plain  \n> {{ x }} quoted");
	const img = await escaped([image("https://x.example/a.jpg", { alt: "{{ x }}" })]);
	assert.equal(img.printed, "![{{ x }}](https://x.example/a.jpg)");
});

test("template code: a table cell is wrapped inside its <th> or <td>; the other cells and the table's own tags are untouched", async () => {
	const table = tableBlock([["Variable", "Prints"], [[span("{{ a|upper }}", ["code"])], "A"], ["x", "{% now %} and {"], ["Email", "{{ subscriber.email }}"]]);
	const out = await escaped([table]);
	assert.equal(
		out.body,
		tableHtml([
			["Variable", "Prints"],
			[V("<code>{{ a|upper }}</code>"), "A"],
			["x", "{% templatetag openblock %} now {% templatetag closeblock %} and {% templatetag openbrace %}"],
			["Email", V("{{ subscriber.email }}")],
		]),
	);
	assert.equal(out.printed, tableHtml([["Variable", "Prints"], ["<code>{{ a|upper }}</code>", "A"], ["x", "{% now %} and {"], ["Email", "{{ subscriber.email }}"]]), "Buttondown prints each cell as written");
	assert.equal(out.printed, renderTableBlock(table, { absolute: (u) => u }), "which is the table before the escape");
	// A header cell, a cell that spans columns, and template code inside a link and next to escaped HTML.
	const more = tableBlock([["{{ head }}"], [tableCell([span("if a < b {% x %}", ["k"])], { colspan: 2, markDefs: [{ _key: "k", _type: "link", href: "https://x.example/p/{{ id }}/" }] })]]);
	const moreOut = await escaped([more]);
	assert.equal(moreOut.body, [TABLE_OPEN, "<thead>", "<tr>", `<th>${V("{{ head }}")}</th>`, "<th></th>", "</tr>", "</thead>", "<tbody>", "<tr>", `<td colspan="2">${V('<a href="https://x.example/p/{{%20id%20}}/">if a &lt; b {% x %}</a>')}</td>`, "</tr>", "</tbody>", "</table>"].join("\n"));
	assert.equal(moreOut.printed, renderTableBlock(more, { absolute: (u) => u }));
	// A line that isn't a cell's (the table never writes one) is wrapped whole: nothing in a table can reach Django.
	const { escapeTemplateBlock } = await import("../src/buttondown/template.ts");
	assert.equal(escapeTemplateBlock("| a | {{ b }} |\n| --- | --- |", "table"), `${V("| a | {{ b }} |")}\n| --- | --- |`);
	assert.equal(escapeTemplateBlock("<td>{{ a }}</td><td>b</td>", "table"), `<td>${V("{{ a }}</td><td>b")}</td>`, "two cells on a line: one wrap, first tag to last");
	assert.equal(django(escapeTemplateBlock("<td>a {{</td><td>b }}</td>", "table")), "<td>a {{</td><td>b }}</td>");
});

test("a table goes out as an HTML table in Buttondown's own table style, with 16px above and below: with no header information, the first row in <thead> with <th>, the rest in <tbody> with <td>", async () => {
	// The live case (2026-11-15): the pipe table came out as "Classic Outlook No", with no borders or padding.
	const table = tableBlock([["Email app", "Shows WebP"], ["Apple Mail", "Yes"], ["Classic Outlook", "No"]]);
	const built = await buildEmail(source({ bodyFields: [[block([span("Before.")]), table, block([span("After.")])]], footerLink: false }));
	const html = [
		TABLE_OPEN,
		"<thead>",
		"<tr>",
		"<th>Email app</th>",
		"<th>Shows WebP</th>",
		"</tr>",
		"</thead>",
		"<tbody>",
		"<tr>",
		"<td>Apple Mail</td>",
		"<td>Yes</td>",
		"</tr>",
		"<tr>",
		"<td>Classic Outlook</td>",
		"<td>No</td>",
		"</tr>",
		"</tbody>",
		"</table>",
	].join("\n");
	// One HTML block: on its own lines, a blank line before and after, none inside, and no line indented.
	assert.equal(built.fields.body, `${MODE_COMMENT}\nBefore.\n\n${html}\n\nAfter.\n`);
	assert.deepEqual(built.warnings, []);
	assert.doesNotMatch(built.fields.body, /\|/, "no pipe table");
	// Buttondown's CSS gives its table class no margin, and a code block none: the inline style keeps the table off what follows.
	const beforeCode = await buildEmail(noFooter([table, { _type: "code", _key: "c", code: "x = 1" }]));
	assert.equal(beforeCode.fields.body, `${MODE_COMMENT}\n${html}\n\n\`\`\`\nx = 1\n\`\`\`\n`);
	assert.match(html, /^<table class="buttondown-block-styled" style="margin:16px 0;">\n/, "the class stays, the margin is inline");
	assert.equal(html.match(/style=/g).length, 1, "and nothing else is styled");
	// A table that says nothing about headers (no hasHeaderRow, no isHeader) has its first row as the header: the rule above.
	// A header row alone has no <tbody>; a short row is filled; a cell that spans columns keeps its colspan; no rows, no table.
	const abs = { absolute: (u) => u };
	assert.equal(renderTableBlock(tableBlock([["a", "b"]]), abs), tableHtml([["a", "b"]]));
	assert.equal(renderTableBlock(tableBlock([["a", "b", "c"], ["d"], [tableCell("wide", { colspan: 2 }), "e"]]), abs), [TABLE_OPEN, "<thead>", "<tr>", "<th>a</th>", "<th>b</th>", "<th>c</th>", "</tr>", "</thead>", "<tbody>", "<tr>", "<td>d</td>", "<td></td>", "<td></td>", "</tr>", "<tr>", '<td colspan="2">wide</td>', "<td>e</td>", "</tr>", "</tbody>", "</table>"].join("\n"));
	assert.equal(renderTableBlock(tableBlock([]), abs), null);
	assert.equal(renderTableBlock(tableBlock([[]]), abs), null);
	assert.equal((await buildEmail(noFooter([tableBlock([]), block([span("Only this.")])]))).fields.body, `${MODE_COMMENT}\nOnly this.\n`);
});

test("a table's cells are HTML: &, <, > and quotes escaped, Markdown characters as written", async () => {
	const out = await escaped([tableBlock([['R&D <b>"quoted"</b> it\'s', "a > b"], ["*not em* _nor_ `code` [x](y) | pipe \\ # 1.", "</td></tr></table><script>alert(1)</script>"]])]);
	assert.equal(out.body, tableHtml([["R&amp;D &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; it&#39;s", "a &gt; b"], ["*not em* _nor_ `code` [x](y) | pipe \\ # 1.", "&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;script&gt;alert(1)&lt;/script&gt;"]]));
	assert.equal(out.body.match(/<\/?table/g).length, 2, "a cell can't close the table or open another");
});

test("a table's cells keep bold, italic, code, strike-through and line breaks as HTML", async () => {
	const out = await escaped([
		tableBlock([
			["Mark", "Shown"],
			[[span("bold", ["strong"]), span(" and "), span("italic", ["em"])], [span("npm run <build>", ["code"]), span(" then "), span("gone", ["strike-through"])]],
			[[span("both", ["strong", "em"])], "One\nTwo\r\nThree"],
			[[span("First"), { _type: "break" }, span("Second")], [span("  padded  ")]],
			[[span("\n\nmiddle\n\nlines\n")], [span(" ", ["strong"]), span("")]],
		]),
	]);
	assert.equal(
		out.body,
		tableHtml([
			["Mark", "Shown"],
			["<strong>bold</strong> and <em>italic</em>", "<code>npm run &lt;build&gt;</code> then <s>gone</s>"],
			["<strong><em>both</em></strong>", "One<br>Two<br>Three"],
			["First<br>Second", "padded"],
			["<br><br>middle<br><br>lines<br>", ""],
		]),
	);
	assert.doesNotMatch(out.body, /\n\s*\n/, "no blank line inside the table, whatever the cells hold");
	assert.doesNotMatch(out.body, /^[ \t]/m, "and no indented line");
});

test("a table's links: relative made absolute, the table's and the cell's own link marks, javascript: and data: refused", async () => {
	const defs = [{ _key: "rel", _type: "link", href: "/pricing/?a=1&b=2" }, { _key: "js", _type: "link", href: "javascript:alert(1)" }, { _key: "data", _type: "link", href: " DATA:text/html,x" }, { _key: "abs", _type: "link", href: 'https://x.example/a"b' }];
	const out = await escaped([
		tableBlock(
			[
				["Link", "Out"],
				[[span("Pricing", ["rel"])], [span("Run", ["js"]), span(" "), span("Data", ["data"])]],
				[[span("Quoted", ["abs"])], tableCell([span("Bold link", ["strong", "own"]), span(" #top", ["hash"])], { markDefs: [{ _key: "own", _type: "link", href: "about/" }, { _key: "hash", _type: "link", href: "#top" }] })],
			],
			{ markDefs: defs },
		),
	]);
	assert.equal(
		out.body,
		tableHtml([
			["Link", "Out"],
			['<a href="https://coywolf.com/pricing/?a=1&amp;b=2">Pricing</a>', "Run Data"],
			['<a href="https://x.example/a&quot;b">Quoted</a>', '<a href="https://coywolf.com/about/"><strong>Bold link</strong></a><a href="#top"> #top</a>'],
		]),
	);
	assert.doesNotMatch(out.body, /javascript:|data:/i);
});

test("a table is the email's alone: the public .md keeps its pipe table, and the same blocks give the same hash", async () => {
	const { portableTextToMarkdown } = await import("../src/discovery/markdown.ts");
	const blocks = [tableBlock([["Variable", "Prints"], ["Email", "{{ subscriber.email }}"], [[span("a|b", ["strong"])], "One\nTwo"]])];
	assert.equal(portableTextToMarkdown(blocks), "| Variable | Prints |\n| --- | --- |\n| Email | {{ subscriber.email }} |\n| **a\\|b** | One<br>Two |");
	assert.equal(portableTextToMarkdown(blocks, { absolute: (u) => u }), portableTextToMarkdown(blocks), "no table hook, no change");
	assert.equal(portableTextToMarkdown(blocks, { table: () => "T" }), "T", "the hook's answer is the table");
	assert.equal(portableTextToMarkdown([...blocks, block([span("x")])], { table: () => null }), "x", "null leaves it out");
	const one = await buildEmail(noFooter(blocks));
	assert.equal(one.fields.body, `${MODE_COMMENT}\n${tableHtml([["Variable", "Prints"], ["Email", V("{{ subscriber.email }}")], ["<strong>a|b</strong>", "One<br>Two"]])}\n`);
	assert.equal((await buildEmail(noFooter(blocks))).hash, one.hash);
	// The pipe table's body, as it was before: a post with a table gets one new write.
	const { emailHash } = await import("../src/buttondown/body.ts");
	const { metadata: _metadata, ...shown } = one.fields;
	assert.notEqual(one.hash, await emailHash({ ...shown, body: `${MODE_COMMENT}\n${portableTextToMarkdown(blocks)}\n` }));
});

test("template code: a list item is wrapped after its marker, nested and numbered ones too", async () => {
	const item = (text, extra = {}) => block([span(text)], { listItem: "bullet", level: 1, ...extra });
	const out = await escaped([item("Plain"), item("{{ a }} first"), item("Nested {% b %}\nsecond line {# c #}", { level: 2 }), item("One {{ n }}", { listItem: "number" })]);
	assert.equal(out.body, ["- Plain", `- ${V("{{ a }} first")}`, `   - ${V("Nested {% b %}")}  `, `     ${V("second line {# c #}")}`, `1. ${V("One {{ n }}")}`].join("\n"));
	assert.equal(out.printed, ["- Plain", "- {{ a }} first", "   - Nested {% b %}  ", "     second line {# c #}", "1. One {{ n }}"].join("\n"));
});

test("template code: a note fallback (and the other block fallbacks) is wrapped on its text line, inside the quote", async () => {
	const out = await escaped([{ _type: "coywolf-note", _key: "n", variant: "tip", body: "Use **{{ x }}** here.\nSecond line." }, { _type: "coywolf-review", _key: "r", itemName: "Jinja {% raw %}", pros: "Has {{ vars }}\nFast" }, { _type: "button", _key: "b", url: "/x/", text: "Get {{ it }}" }]);
	assert.equal(out.body, ["> **Tip**", ">", `> ${V("Use **{{ x }}** here.")}  `, "> Second line.", "", V("**Jinja {% raw %}**"), "", "**What I liked most**", "", `- ${V("Has {{ vars }}")}`, "- Fast", "", V("[Get {{ it }}](https://coywolf.com/x/)")].join("\n"));
	assert.equal(out.printed, ["> **Tip**", ">", "> Use **{{ x }}** here.  ", "> Second line.", "", "**Jinja {% raw %}**", "", "**What I liked most**", "", "- Has {{ vars }}", "- Fast", "", "[Get {{ it }}](https://coywolf.com/x/)"].join("\n"));
});

test("template code: text without it stays unwrapped, and a variable added in Buttondown still runs", async () => {
	const plain = [block([span("A plain paragraph with { one brace }, a closing }} and 100%.")]), { _type: "code", _key: "c", code: "const a = { b: 1 };" }, block([span("Item")], { listItem: "bullet", level: 1 })];
	const built = await buildEmail(noFooter(plain));
	assert.equal(built.fields.body, `${MODE_COMMENT}\nA plain paragraph with { one brace }, a closing }} and 100%.\n\n\`\`\`\nconst a = { b: 1 };\n\`\`\`\n\n- Item\n`);
	assert.doesNotMatch(built.fields.body, /verbatim|templatetag/);
	// Only the piece with template code is wrapped: the paragraphs around it are as they were.
	const mixed = await buildEmail(noFooter([block([span("Hello.")]), block([span("Print {{ x }}.")]), block([span("Bye.")])]));
	assert.equal(mixed.fields.body, `${MODE_COMMENT}\nHello.\n\n${V("Print {{ x }}.")}\n\nBye.\n`);
	// What Jon adds to the draft in Buttondown is outside every wrap: Django still runs it.
	const ran = [];
	django(`${mixed.fields.body}\nHi {{ subscriber.metadata.first_name }}!\n`, ran);
	assert.deepEqual(ran, ["{{ subscriber.metadata.first_name }}"]);
});

test("template code: content with {% endverbatim pack %} in it, or a tag opening nothing closes, is rewritten with templatetag instead", async () => {
	const { escapeTemplateText } = await import("../src/buttondown/template.ts");
	const breakout = await escaped([{ _type: "code", _key: "c", code: "{% endverbatim pack %}\n{{ secret }} {# c #}" }]);
	assert.equal(
		breakout.body,
		"```\n{% templatetag openblock %} endverbatim pack {% templatetag closeblock %}\n{% templatetag openvariable %} secret {% templatetag closevariable %} {% templatetag opencomment %} c {% templatetag closecomment %}\n```",
	);
	assert.doesNotMatch(breakout.body, /\{% (end)?verbatim/, "no verbatim block to break out of");
	assert.equal(breakout.printed, "```\n{% endverbatim pack %}\n{{ secret }} {# c #}\n```");
	// Other spellings of the closing tag, and the word alone, take the same road.
	for (const text of ["{%endverbatim pack%} {{ x }}", "{%  endverbatim   pack  %}{{ x }}", "{% endverbatim %} {{ x }}", "endverbatim {{ x }}"]) {
		assert.doesNotMatch(escapeTemplateText(text), /\{% (end)?verbatim/, text);
		assert.equal(django(escapeTemplateText(text)), text, text);
	}
	// A tag that opens and never closes would take the closing verbatim tag as its own end: the block would stay open.
	for (const text of ["Use {% to open a tag", "Print with {{", "A comment starts with {#", "{{ a }} then {", "{{ a }} and {% b", "{{{", "{}} {{ a"]) {
		const out = (await escaped([block([span(text)])]));
		assert.doesNotMatch(out.body, /verbatim/, text);
		assert.equal(out.printed, text, text);
	}
	// Whole tags are fine in verbatim, on the last line of a code block too; an opening on an earlier line can't reach the end.
	assert.equal(escapeTemplateText("{% a\n{{ b }}"), V("{% a\n{{ b }}"));
	assert.equal(escapeTemplateText("{{ b }}\n{% a"), "{% templatetag openvariable %} b {% templatetag closevariable %}\n{% templatetag openblock %} a");
	// Whatever is on the rest of the line can't join an escaped piece: a cell ending in "{{" next to a cell with "}}".
	const row = await escaped([tableBlock([["a {{", "b }}", "{{ c }}"]])]);
	assert.equal(row.printed, tableHtml([["a {{", "b }}", "{{ c }}"]]));
	// The same for a cell that ends with "{" (with verbatim, "{" + the closing tag + a later "}}" would read as one variable),
	// and for a lone "{" in a rewritten cell (the same, with the templatetag after it).
	for (const cells of [["{{ a }} then {", "b }}"], ["{}} {{ a", "b }}"], ["{# a #} {", "b #}"]]) {
		const out = await escaped([tableBlock([cells])]);
		assert.equal(out.printed, tableHtml([cells]), cells[0]);
	}
});

test("template code: any mix of it comes out of Buttondown as it was written, with nothing run", async () => {
	const bits = ["{{", "}}", "{%", "%}", "{#", "#}", "{", "}", " x ", "endverbatim pack", "verbatim pack", "|", "`", "\n", "- ", "> "];
	let seed = 20261115;
	// mulberry32: the same mixes every run.
	const next = (n) => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) % n;
	};
	let fallbacks = 0;
	for (let i = 0; i < 600; i++) {
		const code = Array.from({ length: 1 + next(8) }, () => bits[next(bits.length)]).join("");
		if (!code.trim()) continue;
		// A table's cells are HTML, written here by hand: the header, a body cell, and a cell with the mix as code.
		const html = code.split("\n").map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")).join("<br>");
		const table = tableBlock([[code, "Head"], ["plain {", code], [[span(code, ["code"])], `}} ${code}`]]);
		const tableAsWritten = tableHtml([[html.trim(), "Head"], ["plain {", html.trim()], [`<code>${html}</code>`, `}} ${html}`.trim()]]);
		for (const [blocks, written] of [[[{ _type: "code", _key: "c", code }]], [[block([span("a "), span(code, ["code"]), span(` b ${code}`)])]], [[block([span(code)], { listItem: "bullet", level: 1 })]], [[table], tableAsWritten]]) {
			const escapedBody = (await buildEmail(noFooter(blocks))).fields.body;
			const { portableTextToMarkdown } = await import("../src/discovery/markdown.ts");
			const ran = [];
			assert.equal(django(escapedBody, ran), `${MODE_COMMENT}\n${written ?? portableTextToMarkdown(blocks)}\n`, JSON.stringify(code));
			if (written) assert.doesNotMatch(escapedBody, /\n\s*\n/, JSON.stringify(code));
			assert.deepEqual(ran, [], JSON.stringify(code));
			if (escapedBody.includes("templatetag")) fallbacks++;
		}
	}
	assert.ok(fallbacks > 50, `the mixes reach the templatetag road (${fallbacks})`);
});

test("template code: the subject and the description aren't escaped, so they keep a warning; the body alone gets none", async () => {
	const body = await buildEmail(source({ bodyFields: [[{ _type: "code", _key: "c", code: "{{ example }} and {% if x %}" }]] }));
	assert.deepEqual(body.warnings, [], "the old 'Contains template code' warning is gone: the body is escaped");
	const subject = await buildEmail(source({ title: "The {{ x }} tag" }));
	assert.equal(subject.fields.subject, "The {{ x }} tag", "as written");
	assert.deepEqual(subject.warnings, ["The subject contains template code ({{, {% or {#). The Pack escapes it in the body only: check the subject in Buttondown before sending."]);
	const both = await buildEmail(source({ title: "The {{ x }} tag", excerpt: "About {% y %}." }));
	assert.equal(both.fields.description, "About {% y %}.");
	assert.deepEqual(both.warnings, ["The subject and the description contain template code ({{, {% or {#). The Pack escapes it in the body only: check the subject and the description in Buttondown before sending."]);
	assert.deepEqual((await buildEmail(source())).warnings, []);
});

test("template code: the hash is what it was for a post without it, and changes with the escape for a post with it", async () => {
	// The hash of this post's email before the escape was added (4fcf408): a post without template code gets no new write.
	assert.equal((await buildEmail(source())).hash, "d8d9140584140192554fb38af32720d8df9077d9fcfd6af7970797dee200ebf4");
	// The same post with a code block: its hash before the escape, and now (the body is the only field that differs).
	const post = () => source({ bodyFields: [[{ _type: "code", _key: "c", language: "html", code: "<!-- Template code test: {{ example }} -->" }, block([span("A plain paragraph.")])]] });
	const withCode = await buildEmail(post());
	assert.equal((await buildEmail(post())).hash, withCode.hash, "the same every time");
	assert.notEqual(withCode.hash, "6f04dbb93f759925f52678407e7699fce33b3238877dcd44bd4fa3685a59eec4", "the untouched draft of such a post is written once more");
	const footer = "\n\n---\n\n[Read it on coywolf.com](https://coywolf.com/newsletter/why-claude-has-my-attention/)\n";
	assert.equal(withCode.fields.body, `${MODE_COMMENT}\n\`\`\`html\n${V("<!-- Template code test: {{ example }} -->")}\n\`\`\`\n\nA plain paragraph.${footer}`);
	const { emailHash } = await import("../src/buttondown/body.ts");
	const { metadata: _metadata, ...shown } = withCode.fields;
	assert.equal(withCode.hash, await emailHash(shown), "the hash is of the escaped body: what Buttondown holds");
	assert.equal(await emailHash({ ...shown, body: django(shown.body) }), "6f04dbb93f759925f52678407e7699fce33b3238877dcd44bd4fa3685a59eec4", "and without the tags it's the old body, byte for byte");
});

test("template code: the escape is the email's alone (the public .md converter adds nothing), and a first line in verbatim is still checked for frontmatter", async () => {
	const { portableTextToMarkdown } = await import("../src/discovery/markdown.ts");
	assert.equal(portableTextToMarkdown([{ _type: "code", _key: "c", code: "{{ x }}" }, block([span("{% y %}")])]), "```\n{{ x }}\n```\n\n{% y %}");
	// "--- {{ x }}" isn't a frontmatter fence (see the frontmatter test below): it goes out, escaped.
	assert.equal((await buildEmail(noFooter([block([span("--- {{ x }}")])]))).fields.body, `${MODE_COMMENT}\n${V("--- {{ x }}")}\n`);
});

test("frontmatter: only a first line that is exactly --- (spaces after it or not) is refused; ---x and --- text go out", async () => {
	const body = async (blocks) => (await buildEmail(noFooter(blocks))).fields.body;
	// Text that starts with the three dashes isn't a fence.
	assert.equal(await body([block([span("---x")])]), `${MODE_COMMENT}\n---x\n`);
	assert.equal(await body([block([span("--- text")])]), `${MODE_COMMENT}\n--- text\n`);
	assert.equal(await body([block([span("---- four")])]), `${MODE_COMMENT}\n---- four\n`);
	assert.equal(await body([block([span("---x\nsecond")])]), `${MODE_COMMENT}\n---x  \nsecond\n`);
	// The converter never leaves a fence first: a rule at the top is dropped, and a paragraph that is "---" is escaped.
	assert.equal(await body([{ _type: "break", _key: "r" }, { _type: "break", _key: "r2" }, block([span("---x")])]), `${MODE_COMMENT}\n---x\n`);
	assert.equal(await body([block([span("---")])]), `${MODE_COMMENT}\n\\---\n`);
	assert.equal(await body([block([span("---  ")])]), `${MODE_COMMENT}\n\\---\n`);
	// The check itself (the last guard before the body is written): a fence, with or without the verbatim tags around it.
	for (const content of ["---", "--- ", "---\t ", "---\ntitle: x\n---\nText", `${V("---")}\nmore`, "{% verbatim pack %}---"]) assert.equal(startsWithFrontmatter(content), true, JSON.stringify(content));
	for (const content of ["---x", "--- text", "----", " ---", "-- -", "\\---", "--", "", "Text\n---", "Text\n\n---\n\nMore", V("--- {{ x }}"), "<table>\n---"]) assert.equal(startsWithFrontmatter(content), false, JSON.stringify(content));
});

test("fields: the subject, the excerpt or SEO description, the canonical URL, the image, a slug only when Buttondown takes it, and the metadata", async () => {
	const built = await buildEmail(source());
	assert.equal(built.fields.subject, "Why Claude has my attention");
	assert.equal(built.fields.description, "An excerpt.");
	assert.equal(built.fields.canonical_url, "https://coywolf.com/newsletter/why-claude-has-my-attention/");
	assert.equal(built.fields.image, undefined, "no featured image: none");
	assert.equal(built.fields.slug, "why-claude-has-my-attention");
	assert.deepEqual(built.fields.metadata, { coywolf_pack: { v: 1, key: "coywolf.com:posts:01POST", collection: "posts", entry: "01POST", hash: built.hash } });
	assert.ok(!("status" in built.fields), "the client adds status draft on a create, never the body builder");
	assert.equal((await buildEmail(source({ excerpt: "" }))).fields.description, "SEO description.");
	assert.equal((await buildEmail(source({ slug: "has space" }))).fields.slug, undefined);
	assert.equal((await buildEmail(source({ slug: "a".repeat(101) }))).fields.slug, undefined);
	assert.equal((await buildEmail(source({ noSlug: true }))).fields.slug, undefined);
	assert.equal((await buildEmail(source({ title: "  Two\n lines " }))).fields.subject, "Two lines");
	assert.equal((await buildEmail(source({ title: "", slug: "" }))).fields.subject, "Untitled post");
	assert.equal((await buildEmail(source({ title: "x".repeat(3000) }))).fields.subject.length, 2000);
	// Buttondown's own keys and the site's stay; the Pack's object is replaced.
	assert.deepEqual(packMetadata({ key: "k", collection: "posts", entryId: "1" }, "h", { campaign: "fall", coywolf_pack: { old: true } }), { campaign: "fall", coywolf_pack: { v: 1, key: "k", collection: "posts", entry: "1", hash: "h" } });
	assert.equal(entryKey("https://www.coywolf.com/", "posts", "1"), "coywolf.com:posts:1");
	assert.equal(siteHost("not a url"), "the site");
});

test("the hash is the same for the same post and changes with any field", async () => {
	const a = await buildEmail(source());
	assert.equal((await buildEmail(source())).hash, a.hash);
	assert.match(a.hash, /^[0-9a-f]{64}$/);
	for (const change of [{ title: "Other" }, { excerpt: "Other" }, { slug: "other" }, { postUrl: "https://coywolf.com/x/" }, { featuredImage: "https://x.example/a.jpg" }, { bodyFields: [[block([span("Changed.")])]] }, { footerLink: false }]) {
		assert.notEqual((await buildEmail(source(change))).hash, a.hash, JSON.stringify(change));
	}
});

// --- Review 3 fixes: merged cells, header cells, alignment, adjacent marks, hidden schemes ---

const header = (content, extra = {}) => tableCell(content, { isHeader: true, ...extra });
const data = (content, extra = {}) => tableCell(content, { isHeader: false, ...extra });
/** The table's lines after the opening tag and before the closing one. */
const tableLines = (table) => {
	const lines = renderTableBlock(table, { absolute: (u) => u }).split("\n");
	assert.equal(lines[0], TABLE_OPEN);
	assert.equal(lines.at(-1), "</table>");
	return lines.slice(1, -1);
};

test("a table's merged cell keeps its rowspan, and the cells under it stay in their column (no cell is added for a column it takes)", () => {
	// Review 3, M1: B was moved under Plan, and Pro was one row tall.
	assert.deepEqual(tableLines(tableBlock([["Plan", "Feature"], [tableCell("Pro", { rowspan: 2 }), "A"], ["B"]])), ["<thead>", "<tr>", "<th>Plan</th>", "<th>Feature</th>", "</tr>", "</thead>", "<tbody>", "<tr>", '<td rowspan="2">Pro</td>', "<td>A</td>", "</tr>", "<tr>", "<td>B</td>", "</tr>", "</tbody>"]);
	// Both spans on one cell: colspan first, then rowspan. The rows under it are filled only where nothing is.
	assert.deepEqual(tableLines(tableBlock([["a", "b", "c", "d"], [tableCell("wide and tall", { colspan: 2, rowspan: 2 }), "e"], ["f", "g"], ["h"]])), [
		"<thead>",
		"<tr>",
		"<th>a</th>",
		"<th>b</th>",
		"<th>c</th>",
		"<th>d</th>",
		"</tr>",
		"</thead>",
		"<tbody>",
		"<tr>",
		'<td colspan="2" rowspan="2">wide and tall</td>',
		"<td>e</td>",
		"<td></td>",
		"</tr>",
		"<tr>",
		"<td>f</td>",
		"<td>g</td>",
		"</tr>",
		"<tr>",
		"<td>h</td>",
		"<td></td>",
		"<td></td>",
		"<td></td>",
		"</tr>",
		"</tbody>",
	]);
	// A tall cell in the last column: the short row under it gets one empty cell, for the middle column only.
	assert.deepEqual(tableLines(tableBlock([[data("a"), data("b"), data("c", { rowspan: 2 })], [data("d")]])), ["<tbody>", "<tr>", "<td>a</td>", "<td>b</td>", '<td rowspan="2">c</td>', "</tr>", "<tr>", "<td>d</td>", "<td></td>", "</tr>", "</tbody>"]);
	// A rowspan ends at the table's last row; 1, 0, a fraction or text is no span.
	assert.deepEqual(tableLines(tableBlock([[data("a", { rowspan: 99 }), data("b", { rowspan: 1 })], [data("c", { rowspan: 0, colspan: 1.5 })], [data("d", { rowspan: "2" })]])), ["<tbody>", "<tr>", '<td rowspan="3">a</td>', "<td>b</td>", "</tr>", "<tr>", "<td>c</td>", "</tr>", "<tr>", "<td>d</td>", "</tr>", "</tbody>"]);
	assert.deepEqual(tableLines(tableBlock([[data("a", { rowspan: 2.9 }), data("b")], [data("c")]])), ["<tbody>", "<tr>", '<td rowspan="2">a</td>', "<td>b</td>", "</tr>", "<tr>", "<td>c</td>", "</tr>", "</tbody>"]);
	// A row that tall cells cover whole has no cell of its own.
	assert.deepEqual(tableLines(tableBlock([[data("a", { rowspan: 2 }), data("b", { rowspan: 2 })], []])), ["<tbody>", "<tr>", '<td rowspan="2">a</td>', '<td rowspan="2">b</td>', "</tr>", "<tr>", "</tr>", "</tbody>"]);
});

test("a table's header cells are the ones it marks: no header row when it's off, a header column as <th>, the first row only when the table says nothing", () => {
	// Review 3, L1. The header row off (the editor writes isHeader: false and no hasHeaderRow): no <thead>, no <th>.
	assert.deepEqual(tableLines(tableBlock([[data("Mon"), data("9-5")], [data("Tue"), data("9-5")]])), ["<tbody>", "<tr>", "<td>Mon</td>", "<td>9-5</td>", "</tr>", "<tr>", "<td>Tue</td>", "<td>9-5</td>", "</tr>", "</tbody>"]);
	assert.deepEqual(tableLines(tableBlock([["Mon", "9-5"], ["Tue", "9-5"]], { hasHeaderRow: false })), ["<tbody>", "<tr>", "<td>Mon</td>", "<td>9-5</td>", "</tr>", "<tr>", "<td>Tue</td>", "<td>9-5</td>", "</tr>", "</tbody>"]);
	// A header column alone: <th> for exactly those cells, in the <tbody>.
	assert.deepEqual(tableLines(tableBlock([[header("Sales"), data("1")], [header("Costs"), data("2")]])), ["<tbody>", "<tr>", "<th>Sales</th>", "<td>1</td>", "</tr>", "<tr>", "<th>Costs</th>", "<td>2</td>", "</tr>", "</tbody>"]);
	// A header row and a header column.
	assert.deepEqual(tableLines(tableBlock([[header(""), header("Q1")], [header("Sales"), data("1")]], { hasHeaderRow: true })), ["<thead>", "<tr>", "<th></th>", "<th>Q1</th>", "</tr>", "</thead>", "<tbody>", "<tr>", "<th>Sales</th>", "<td>1</td>", "</tr>", "</tbody>"]);
	// A first row with one cell that isn't a header is no header row: its header cells are still <th>.
	assert.deepEqual(tableLines(tableBlock([[header("a"), data("b")], [data("c"), header("d")]])), ["<tbody>", "<tr>", "<th>a</th>", "<td>b</td>", "</tr>", "<tr>", "<td>c</td>", "<th>d</th>", "</tr>", "</tbody>"]);
	// A mark that isn't `true` is no header. A cell without the mark, in a table that has marks, isn't one either.
	assert.deepEqual(tableLines(tableBlock([[tableCell("a", { isHeader: "yes" }), tableCell("b")], [data("c"), data("d")]])), ["<tbody>", "<tr>", "<td>a</td>", "<td>b</td>", "</tr>", "<tr>", "<td>c</td>", "<td>d</td>", "</tr>", "</tbody>"]);
	// The flag alone (hasHeaderRow, no isHeader on the first row): the first row is the header, as on the site.
	assert.equal(renderTableBlock(tableBlock([["a", "b"], ["c", "d"]], { hasHeaderRow: true }), { absolute: (u) => u }), tableHtml([["a", "b"], ["c", "d"]]));
	// No header information at all: the first row is the header, as before.
	assert.equal(renderTableBlock(tableBlock([["a", "b"], ["c", "d"]]), { absolute: (u) => u }), tableHtml([["a", "b"], ["c", "d"]]));
	// A header row is one row: a first row with a tall cell stays in the <tbody> (a rowspan can't leave a <thead>), its cells still <th>.
	assert.deepEqual(tableLines(tableBlock([[header("a", { rowspan: 2 }), header("b")], [data("c")]], { hasHeaderRow: true })), ["<tbody>", "<tr>", '<th rowspan="2">a</th>', "<th>b</th>", "</tr>", "<tr>", "<td>c</td>", "</tr>", "</tbody>"]);
	// A short row is filled with its own kind of cell: <th> in a row of header cells, <td> in any other.
	assert.deepEqual(tableLines(tableBlock([[header("a")], [data("b"), data("c")], [header("d"), data("e"), data("f")]], { hasHeaderRow: true })), ["<thead>", "<tr>", "<th>a</th>", "<th></th>", "<th></th>", "</tr>", "</thead>", "<tbody>", "<tr>", "<td>b</td>", "<td>c</td>", "<td></td>", "</tr>", "<tr>", "<th>d</th>", "<td>e</td>", "<td>f</td>", "</tr>", "</tbody>"]);
});

test("a table is the email's alone (headers, spans, alignment): the public .md pipe table still has its first row as the header, whatever the cells say", async () => {
	const { portableTextToMarkdown } = await import("../src/discovery/markdown.ts");
	const off = tableBlock([[data("Mon"), data("9-5")], [data("Tue", { rowspan: 2, textAlign: "center" }), data("9-5")]]);
	assert.equal(portableTextToMarkdown([off]), "| Mon | 9-5 |\n| --- | --- |\n| Tue | 9-5 |");
});

test("a table cell keeps its textAlign (left, center or right) as an inline style; anything else, and column widths, are left out", () => {
	// Review 3, L4.
	const table = tableBlock(
		[
			[header("Item", { textAlign: "left" }), header("Price", { textAlign: "right", colwidth: [120] })],
			[data("Tea", { textAlign: "center", colspan: 1 }), data("4.50", { textAlign: "right" })],
			[data("Both", { textAlign: "center", colspan: 2, rowspan: 2 })],
			[],
			[data("j", { textAlign: "justify" }), data("x", { textAlign: 'right;" onclick="x' })],
			[data("u", { textAlign: "RIGHT" }), data("n", { textAlign: 1, colwidth: [50], style: "color:red", width: 50 })],
		],
		{ hasHeaderRow: true },
	);
	const lines = tableLines(table);
	assert.deepEqual(lines, [
		"<thead>",
		"<tr>",
		'<th style="text-align:left;">Item</th>',
		'<th style="text-align:right;">Price</th>',
		"</tr>",
		"</thead>",
		"<tbody>",
		"<tr>",
		'<td style="text-align:center;">Tea</td>',
		'<td style="text-align:right;">4.50</td>',
		"</tr>",
		"<tr>",
		'<td colspan="2" rowspan="2" style="text-align:center;">Both</td>',
		"</tr>",
		"<tr>",
		"</tr>",
		"<tr>",
		"<td>j</td>",
		"<td>x</td>",
		"</tr>",
		"<tr>",
		"<td>u</td>",
		"<td>n</td>",
		"</tr>",
		"</tbody>",
	]);
	assert.doesNotMatch(lines.join("\n"), /width|colgroup|<col\b|onclick|color/, "no widths, and nothing but the three alignments in a style");
});

test("template code: a cell with a rowspan, a colspan or an alignment is still wrapped inside its own tag", async () => {
	const { escapeTemplateBlock } = await import("../src/buttondown/template.ts");
	const table = tableBlock(
		[
			[header("{{ head }}", { textAlign: "center" }), header("Plain"), header("{% h %}", { colspan: 2 })],
			[data("{{ tall }}", { rowspan: 2 }), data("{# c #} {", { rowspan: 2, textAlign: "right" }), data("{{ all }}", { colspan: 2, rowspan: 2, textAlign: "left" })],
			[],
			[header("endverbatim {{ x }}", { colspan: 3, textAlign: "right" }), data("a {{")],
		],
		{ hasHeaderRow: true },
	);
	const out = await escaped([table]);
	const names = { "{{": "openvariable", "}}": "closevariable", "{%": "openblock", "%}": "closeblock", "{#": "opencomment", "#}": "closecomment", "{": "openbrace" };
	const T = (text) => text.replace(/\{\{|\{%|\{#|\}\}|%\}|#\}|\{/g, (m) => `{% templatetag ${names[m]} %}`);
	assert.equal(
		out.body,
		[
			TABLE_OPEN,
			"<thead>",
			"<tr>",
			`<th style="text-align:center;">${V("{{ head }}")}</th>`,
			"<th>Plain</th>",
			`<th colspan="2">${V("{% h %}")}</th>`,
			"</tr>",
			"</thead>",
			"<tbody>",
			"<tr>",
			`<td rowspan="2">${V("{{ tall }}")}</td>`,
			`<td rowspan="2" style="text-align:right;">${T("{# c #} {")}</td>`,
			`<td colspan="2" rowspan="2" style="text-align:left;">${V("{{ all }}")}</td>`,
			"</tr>",
			"<tr>",
			"</tr>",
			"<tr>",
			`<th colspan="3" style="text-align:right;">${T("endverbatim {{ x }}")}</th>`,
			`<td>${T("a {{")}</td>`,
			"</tr>",
			"</tbody>",
			"</table>",
		].join("\n"),
	);
	assert.equal(out.printed, renderTableBlock(table, { absolute: (u) => u }), "Buttondown prints the table as it was before the escape");
	// Every line with an escape is one cell's line, wrapped inside its tag: no tag is ever inside a wrap.
	for (const line of out.body.split("\n")) if (/verbatim|templatetag/.test(line)) assert.match(line, /^<(t[hd])(?: colspan="\d+")?(?: rowspan="\d+")?(?: style="text-align:(?:left|center|right);")?>[^<]*\{% [^<]* %\}<\/\1>$/, line);
	// The table's own tag (class and margin) has no template code, so it's never wrapped.
	const written = (cell) => `${TABLE_OPEN}\n<tbody>\n<tr>\n<td rowspan="2" style="text-align:center;">${cell}</td>\n</tr>\n</tbody>\n</table>`;
	assert.equal(escapeTemplateBlock(written("{{ a }}"), "table"), written(V("{{ a }}")));
	// A line separator in a cell (U+2028, U+2029) is text: the wrap is still inside the tag.
	assert.equal(escapeTemplateBlock(written("a\u2028{{ b }}\u2029c"), "table"), written(V("a\u2028{{ b }}\u2029c")));
	const sep = await escaped([tableBlock([[header("x\u2028{{ y }}", { rowspan: 1, colspan: 2, textAlign: "right" })]], { hasHeaderRow: true })]);
	assert.equal(sep.body, [TABLE_OPEN, "<thead>", "<tr>", `<th colspan="2" style="text-align:right;">${V("x\u2028{{ y }}")}</th>`, "</tr>", "</thead>", "</table>"].join("\n"));
});

test("rich text: bold or italic runs side by side are one run, so the email shows the formatting and not the stars", () => {
	// Review 3, L5: "<i>a</i><i>b</i>" was "*a**b*", which Markdown reads as italic "a**b".
	const abs = { absolute: (u) => new URL(u, "https://coywolf.com/").href };
	assert.equal(richToMarkdown("<i>a</i><i>b</i>", abs), "*ab*");
	assert.equal(richToMarkdown("<b>a</b><b>b</b>", abs), "**ab**");
	assert.equal(richToMarkdown("<em>one</em><i>two</i><em>three</em>, <strong>four</strong><b>five</b>", abs), "*onetwothree*, **fourfive**");
	assert.equal(richToMarkdown("**a**<strong>b</strong><b> c</b> d", abs), "**ab c** d", "the site's **bold** next to a tag's bold too");
	// A space between two runs keeps them apart, which Markdown reads fine.
	assert.equal(richToMarkdown("<i>a</i> <i>b</i> and <b>c</b> <b>d</b>", abs), "*a* *b* and **c** **d**");
	// An empty run between two runs doesn't keep them apart, and a run inside a run of the same mark is part of it.
	assert.equal(richToMarkdown("<i>a</i><b></b><i>b</i>", abs), "*ab*");
	assert.equal(richToMarkdown("<em>a<i>b</i></em><em>c</em>", abs), "*abc*");
	// A closing tag with nothing open joins nothing; runs in two paragraphs stay two runs.
	assert.equal(richToMarkdown("</i><i>x</i>", abs), "*x*");
	assert.equal(richToMarkdown("<p><b>One</b></p><p><b>Two</b></p>", abs), "**One**\n\n**Two**");
	for (const out of ["<i>a</i><i>b</i>", "<b>a</b><b>b</b>", "<b>a</b><b>b</b><b>c</b>", "<i>a</i><i>b</i><i>c</i><i>d</i>"].map((rich) => richToMarkdown(rich, abs))) assert.doesNotMatch(out, /[^*]\*{2,}[^*]/, out);
});

test("links: a javascript:, vbscript: or data: scheme hidden with a tab, a line break or a control character is refused, as a browser would read it", async () => {
	// Review 3, L2: the URL parser removes tabs and line breaks, and control characters at the start, so "java\tscript:" is "javascript:".
	const c = { postUrl: "https://coywolf.com/p/", siteHost: "coywolf.com", absolute: (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("#") ? u : new URL(u, "https://coywolf.com/").href), image: (u) => u, warn() {} };
	const { markdownUrl } = await import("../src/buttondown/blocks.ts");
	const hidden = ["java\tscript:alert(1)", "\u0001javascript:alert(1)", "java\nscript:alert(1)", "java\r\nscript:alert(1)", " \u0000 JaVa\tScRiPt:alert(1)", "javascript\t:alert(1)", "\u001f javascript:alert(1)", "vb\tscript:msgbox(1)", "\u0002vbscript:x", "d\nata:text/html,<script>alert(1)</script>", "\tdata:text/html,x"];
	for (const href of hidden) {
		const name = JSON.stringify(href);
		// A table cell's link (raw HTML): the text stays, the link goes.
		const html = renderTableBlock(tableBlock([[tableCell([span("x", ["k"])], { markDefs: [{ _key: "k", _type: "link", href }] })]]), c);
		assert.deepEqual(html.split("\n").slice(3, 4), ["<th>x</th>"], name);
		assert.doesNotMatch(html, /href|script:|data:/i, name);
		// A paragraph's link and an image's link (Markdown).
		const built = await buildEmail(noFooter([block([span("x", ["k"])], { markDefs: [{ _key: "k", _type: "link", href }] }), image("https://x.example/a.jpg", { link: href })]));
		assert.equal(built.fields.body, `${MODE_COMMENT}\nx\n\n![Alt](https://x.example/a.jpg)\n`, name);
		// The Pack's blocks: a button, an embed, a testimonial's name link.
		assert.equal(markdownUrl(href, c.absolute), null, name);
		assert.equal(renderUnknownBlock({ _type: "button", url: href, text: "Go" }, c).startsWith("_[Part of"), true, name);
		assert.equal(renderUnknownBlock({ _type: "embed", url: href }, c).startsWith("_[Part of"), true, name);
		assert.doesNotMatch(renderUnknownBlock({ _type: "coywolf-testimonial", quote: "q", name: "N", nameUrl: href }, c), /\]\(/, name);
	}
	// In rich text an entity can hide the tab: decoded, then refused.
	assert.equal(richToMarkdown('<a href="java&#9;script:alert(1)">x</a> <a href="&#1;javascript:alert(1)">y</a> <a href="jav&#x0A;ascript:alert(1)">z</a>', c), "x y z");
	// Real links are as they were: the space around them goes, a tab inside one goes too (as in a browser).
	assert.equal(markdownUrl("  https://x.example/a b(c)  ", c.absolute), "https://x.example/a%20b%28c%29");
	assert.equal(markdownUrl("\thttps://x.example/a\tb\n", c.absolute), "https://x.example/ab");
	assert.equal(markdownUrl("/pricing/", c.absolute), "https://coywolf.com/pricing/");
	assert.equal(markdownUrl("mailto:hi@coywolf.com", c.absolute), "mailto:hi@coywolf.com");
	assert.equal(markdownUrl("ht\ttps://x.example/", c.absolute), "https://x.example/");
	// A scheme the Pack's blocks never link to, hidden the same way.
	assert.equal(markdownUrl("\u0001ftp://x.example/", c.absolute), null);
	assert.equal(markdownUrl("f\ttp://x.example/", c.absolute), null);
	// Text that only looks like one isn't a scheme: it's a path on the site.
	assert.equal(markdownUrl("java%09script:alert(1)", c.absolute), "https://coywolf.com/java%09script:alert%281%29");
});

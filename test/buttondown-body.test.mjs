// Run: node --test test/buttondown-body.test.mjs
//
// The email Buttondown Drafts writes for a post (src/buttondown/body.ts, src/buttondown/blocks.ts): the
// plaintext editor-mode comment and no frontmatter, email-safe images, absolute links, the Pack's blocks as
// Markdown (a placeholder and a warning for anything else), the footer link, the template-code warning, the
// fields' rules and a hash that changes with any of them.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { buildEmail, emailImage, imageValueUrl, MODE_COMMENT, siteHost, entryKey, packMetadata } = await import("../src/buttondown/body.ts");
const { renderUnknownBlock, richToMarkdown } = await import("../src/buttondown/blocks.ts");
const lib = await import("../src/images/lib.ts");

const span = (text, marks = []) => ({ _type: "span", _key: Math.random().toString(36).slice(2), text, marks });
const block = (children, extra = {}) => ({ _type: "block", _key: "b", style: "normal", markDefs: [], children, ...extra });
const image = (url, extra = {}) => ({ _type: "image", _key: Math.random().toString(36).slice(2), asset: { url }, alt: "Alt", ...extra });

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
	assert.equal(renderUnknownBlock({ _type: "coywolf-note", variant: "tip", body: "Use **this** [link](/x/)." }, c), "> **Tip**\n>\n> Use this [link](https://coywolf.com/x/).");
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
	assert.equal(richToMarkdown("**Bold** and *stars* and [x](javascript:alert(1))", abs), "Bold and \\*stars\\* and \\[x\\](javascript:alert(1))");
	assert.equal(richToMarkdown("[x](javascript:alert)", abs), "x");
	assert.equal(richToMarkdown("", abs), "");
});

test("template code gets a warning", async () => {
	const built = await buildEmail(source({ bodyFields: [[{ _type: "code", _key: "c", code: "{{ example }} and {% if x %}" }]] }));
	assert.ok(built.warnings.some((w) => w.startsWith("Contains template code")));
	assert.deepEqual((await buildEmail(source())).warnings, []);
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

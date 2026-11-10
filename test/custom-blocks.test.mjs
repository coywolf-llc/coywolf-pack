// Run: node --test test/custom-blocks.test.mjs
// test/fixtures/wp/custom-blocks.html and testimonials-podcast.html are verbatim block markup from coywolf.com
// (testimonials-podcast.html: all 13 testimonial blocks, from pages 7297 and 1690, and the podcast-rss block all 16 uses share).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";

import "./ts-resolve.mjs";

const { renderRich, plainText, safeUrl, cleanStyle } = await import("../src/customBlocks/rich.ts");
const R = await import("../src/customBlocks/render.ts");
const { prepareContent, prepareWxr } = await import("../src/wpImport/prepare.ts");
const { convertPortableText, noteBlock, detailsBlock, quoteBlock, testimonialBlock } = await import("../src/wpImport/convert.ts");
const { markerHtml } = await import("../src/wpImport/markers.ts");
const { wxrGuestAuthors, groupGuests, bylineSlug, bioText, collectionFor, sameName } = await import("../src/wpImport/guests.ts");

const fixture = (name) => readFileSync(new URL(`./fixtures/wp/${name}`, import.meta.url), "utf8");
const keys = () => {
	let n = 0;
	return () => `k${++n}`;
};

// ── Rich text ────────────────────────────────────────────────────

test("rich text: paragraphs, line breaks, markdown-style links and bold", () => {
	assert.equal(renderRich("One & two <3\n\nSecond\nline"), "<p>One &amp; two &lt;3</p><p>Second<br>line</p>");
	assert.equal(renderRich("See [the guide](https://example.com/a?b=1&c=2) and **this**."), '<p>See <a href="https://example.com/a?b=1&amp;c=2">the guide</a> and <strong>this</strong>.</p>');
	assert.equal(renderRich("[bad](javascript:alert(1))"), "<p>[bad](javascript:alert(1))</p>");
	assert.equal(renderRich("Title &amp; more", { inline: true }), "Title &amp; more");
	assert.equal(renderRich("a\nb", { inline: true }), "a<br>b");
	assert.equal(renderRich(""), "");
	assert.equal(renderRich(null), "");
});

test("rich text: keeps WordPress's inline HTML, drops what isn't safe", () => {
	assert.equal(
		renderRich('Adding <strong><code>VideoObject</code></strong> <a href="/guides/x/" rel="sponsored nofollow bogus" onclick="x()">Schema</a> <abbr title="top-level domains">TLDs</abbr>'),
		'<p>Adding <strong><code>VideoObject</code></strong> <a href="/guides/x/" rel="sponsored nofollow">Schema</a> <abbr title="top-level domains">TLDs</abbr></p>',
	);
	assert.equal(renderRich('<a href="javascript:alert(1)">x</a><a href=" jav&#x09;ascript:alert(1)">y</a>'), "<p><a>x</a><a>y</a></p>");
	assert.equal(renderRich('<script>alert(1)</script>ok<style>p{}</style>'), "<p>ok</p>");
	assert.equal(renderRich('<img src="x" onerror="alert(1)"><img src="data:image/png;base64,AAAA">'), '<img src="x">');
	assert.equal(renderRich('<div class="x" style="position:fixed">in</div><iframe src="https://e.com"></iframe>'), "<p>in</p>");
	assert.equal(renderRich('<code style="color:green;font-size:90%;background:url(x)">c</code>'), '<p><code style="color:green;font-size:90%">c</code></p>');
	assert.equal(renderRich('"><svg onload=alert(1)>'), "<p>\"&gt;</p>");
	assert.equal(renderRich("<!-- comment -->text"), "<p>text</p>");
});

test("rich text: unbalanced tags are closed or dropped so the page around the block stays intact", () => {
	assert.equal(renderRich("<strong>open\n\nnext</strong> <em>x"), "<p><strong>open</strong></p><p>next <em>x</em></p>");
	assert.equal(renderRich("</p></div></aside>after"), "<p>after</p>");
	assert.equal(renderRich("<ul><li>one<li>two</ul>"), "<ul><li>one<li>two</li></li></ul>");
	assert.equal(renderRich("<p>a</p>\n\n\n\n<p>b</p>"), "<p>a</p><p>b</p>");
	assert.equal(renderRich("<blockquote>q"), "<blockquote>q</blockquote>");
	assert.equal(renderRich("<p>x</p><h2>T</h2>", { inline: true }), "xT", "block tags aren't allowed in inline fields");
});

test("safeUrl, cleanStyle and plainText", () => {
	assert.equal(safeUrl("https://example.com/"), "https://example.com/");
	assert.equal(safeUrl("/path#x"), "/path#x");
	assert.equal(safeUrl("mailto:a@b.c"), "mailto:a@b.c");
	assert.equal(safeUrl("JavaScript:x"), null);
	assert.equal(safeUrl("data:text/html,x"), null);
	assert.equal(cleanStyle("color: red; position: absolute; font-weight:700"), "color:red;font-weight:700");
	assert.equal(cleanStyle("color: expression(x)"), "");
	assert.equal(plainText('Chad <a href="x">via m</a> &amp; **co**'), "Chad via m & co");
});

// ── Blocks ───────────────────────────────────────────────────────

test("Note: an aside labelled by its title; hidden title labels it with aria-label; escapes the title", () => {
	const note = R.normalizeNote({ variant: "tip", title: "Pro <b>tip</b>", titleTag: "h3", body: "Text **bold**" });
	assert.equal(
		R.renderNoteHtml(note, "cw-note-k1"),
		'<aside class="cw-note cw-note--tip" aria-labelledby="cw-note-k1"><h3 class="cw-note__title" id="cw-note-k1">Pro <b>tip</b></h3><div class="cw-note__body"><p>Text <strong>bold</strong></p></div></aside>',
	);
	const hidden = R.renderNoteHtml(R.normalizeNote({ variant: "editor", hideTitle: true, body: "x" }), "id");
	assert.match(hidden, /^<aside class="cw-note cw-note--editor" aria-label="Editor&#39;s note"><div class="cw-note__body">/);
	const defaulted = R.normalizeNote({ variant: "nope", titleTag: "h1", body: "x" });
	assert.deepEqual([defaulted.variant, defaulted.titleTag], ["note", "p"]);
	assert.match(R.renderNoteHtml(defaulted, "i"), /<p class="cw-note__title" id="i">Note<\/p>/);
	assert.equal(R.renderNoteHtml(R.normalizeNote({}), "i"), "");
	assert.match(R.renderNoteHtml(R.normalizeNote({ title: '"><script>x</script>', body: "b" }), 'a"b'), /aria-labelledby="a&quot;b"/);
});

test("Details: native details/summary, open option, transcript style", () => {
	assert.equal(
		R.renderDetailsHtml(R.normalizeDetails({ summary: "More <em>info</em>", body: "Hidden", open: true })),
		'<details class="cw-details cw-details--details" open><summary class="cw-details__summary">More <em>info</em></summary><div class="cw-details__body"><p>Hidden</p></div></details>',
	);
	assert.match(R.renderDetailsHtml(R.normalizeDetails({ variant: "transcript", body: "<p>JH: Hi</p>" })), /^<details class="cw-details cw-details--transcript"><summary class="cw-details__summary">Read the transcript<\/summary>/);
	assert.equal(R.renderDetailsHtml(R.normalizeDetails({})), "");
});

test("Affiliate disclosure: the site's wording (affiliate or Amazon), the block's own, and an optional link", () => {
	const s = R.normalizeDisclosureSettings({ affiliateText: "Supported by [partnership links](https://coywolf.com/partnerships/).", linkUrl: "javascript:x" });
	assert.equal(s.linkUrl, "");
	assert.equal(s.amazonText, R.DEFAULT_DISCLOSURE.amazonText);
	assert.equal(
		R.renderDisclosureHtml(R.normalizeDisclosure({ kind: "affiliate" }), s),
		'<aside class="cw-disclosure cw-disclosure--affiliate" aria-label="Affiliate disclosure"><p class="cw-disclosure__text">Supported by <a href="https://coywolf.com/partnerships/">partnership links</a>.</p></aside>',
	);
	const linked = R.normalizeDisclosureSettings({ linkUrl: "/disclosures/", linkText: "How we earn <money>" });
	assert.match(R.renderDisclosureHtml(R.normalizeDisclosure({ kind: "amazon" }), linked), /As an Amazon Associate I earn from qualifying purchases\. <a class="cw-disclosure__link" href="\/disclosures\/">How we earn &lt;money&gt;<\/a><\/p><\/aside>$/);
	assert.match(R.renderDisclosureHtml(R.normalizeDisclosure({ kind: "amazon", text: "Our own words" }), linked), /aria-label="Amazon Associates disclosure"><p class="cw-disclosure__text">Our own words /);
});

test("Quote: figure with blockquote cite and a cited caption; unsafe source URLs are dropped", () => {
	assert.equal(
		R.renderQuoteHtml(R.normalizeQuote({ quote: "Line one\n\nLine two", citation: 'Chad <a href="https://m.social/@c">via m</a>', sourceUrl: "https://m.social/@c/1" })),
		'<figure class="cw-quote"><blockquote class="cw-quote__text" cite="https://m.social/@c/1"><p>Line one</p><p>Line two</p></blockquote><figcaption class="cw-quote__caption"><cite>Chad <a href="https://m.social/@c">via m</a></cite></figcaption></figure>',
	);
	assert.doesNotMatch(R.renderQuoteHtml(R.normalizeQuote({ quote: "q", sourceUrl: "javascript:alert(1)" })), /cite=/);
	assert.equal(R.renderQuoteHtml(R.normalizeQuote({ citation: "only" })), "");
});

test("the shared CSS is theme-agnostic (currentColor mixes) and has dark-mode accents", () => {
	assert.match(R.CUSTOM_BLOCKS_CSS, /color-mix\(in srgb,currentColor/);
	assert.match(R.CUSTOM_BLOCKS_CSS, /prefers-color-scheme:dark/);
	assert.ok(!R.CUSTOM_BLOCKS_CSS.includes("</style"));
});

// ── WordPress import ─────────────────────────────────────────────

function importFixture(name, opts = {}, prepareOpts = {}) {
	const prepared = prepareContent(fixture(name), prepareOpts);
	return { prepared, result: convertPortableText(gutenbergToPortableText(prepared.content), { key: keys(), ...opts }) };
}

test("without disclosureBlocks, a site-specific disclosure block is only counted as one EmDash drops", () => {
	const { prepared } = importFixture("custom-blocks.html");
	assert.equal(prepared.counts["genesis-custom-blocks/disclosure → dropped"], 1);
	assert.equal(prepared.counts["genesis-custom-blocks/disclosure → disclosure"], undefined);
	assert.equal(prepared.counts["coywolf-custom-blocks/ftc → disclosure"], 1);
});

test("coywolf.com disclosures, notes and quotes convert to Custom Blocks, content exact", () => {
	const { prepared, result } = importFixture("custom-blocks.html", {}, { disclosureBlocks: ["genesis-custom-blocks/disclosure"] });
	assert.deepEqual(prepared.counts, {
		"coywolf-custom-blocks/ftc → disclosure": 1,
		"coywolf-custom-blocks/amazon → disclosure": 1,
		"genesis-custom-blocks/disclosure → disclosure": 1,
		"coywolf-custom-blocks/editorsnote → note": 1,
		"coywolf-custom-blocks/sidenote → note": 2,
		"coywolf-custom-blocks/blockquote → quote": 3,
	});
	const v = result.value;
	assert.deepEqual(v.map((b) => b._type), ["coywolf-disclosure", "coywolf-disclosure", "coywolf-disclosure", "coywolf-note", "coywolf-note", "coywolf-note", "coywolf-quote", "coywolf-quote", "coywolf-quote"]);
	assert.deepEqual(v.slice(0, 3).map((b) => b.kind), ["affiliate", "amazon", "affiliate"]);
	assert.ok(v[3].body.startsWith('<p><strong>On December 13, 2024, sub.club announced <a href="https://web.archive.org/web/20241217042218/https://mastodon.social/@subclub/113646793698065585">they are shutting down</a>.</strong></p> <p><q cite='));
	assert.equal(v[4].body, '<p>If you don\'t have a Fathom Analytics account, use <a href="https://usefathom.com/ref/AANN81" rel="sponsored">this link</a> to get $10 off.</p>');
	assert.equal(v[5].body, 'Google doesn\'t penalize sites or lower its rankings if it uses <code><strong>rel="sponsored"</strong></code>. Case in point, Coywolf Reviews uses them, and most of its reviews rank well in Google Search.');
	assert.equal(v[6].citation, 'Chad Podoski <a href="https://mastodon.social/@chadpod/116569643204260383">via mastodon.social</a>');
	assert.equal(v[6].sourceUrl, "https://mastodon.social/@chadpod/116569643204260383");
	assert.ok(v[6].quote.includes("velocity.\n\nI’d rather"));
	assert.equal(v[7].sourceUrl, undefined);
	assert.ok(v[7].quote.includes("<ol>"));
	// A cite field that lost its escapes (cite=u0022…u0022) still gives the URL, and the citation's markup is repaired.
	assert.equal(v[8].sourceUrl, "https://developers.google.com/search/docs/advanced/appearance/favicon-in-search");
	assert.match(v[8].citation, /^Guidelines section from <a href="https:\/\/developers\.google\.com\//);

	// Rendered: the sponsored rel, <q cite>, ordered lists and the code styling survive.
	const html = v.map((b) =>
		b._type === "coywolf-note" ? R.renderNoteHtml(R.normalizeNote(b), "n") : b._type === "coywolf-quote" ? R.renderQuoteHtml(R.normalizeQuote(b)) : "",
	);
	assert.match(html[3], /<h2 class="cw-note__title" id="n">📝 Editor's Note<\/h2><div class="cw-note__body"><p><strong>On December 13/);
	assert.match(html[3], /<q cite="https:\/\/web\.archive\.org\/web\/20241217042218\/https:\/\/mastodon\.social\/@subclub\/113646793698065585">Thank you/);
	assert.match(html[4], /rel="sponsored">this link<\/a>/);
	assert.match(html[6], /<blockquote class="cw-quote__text" cite="https:\/\/mastodon\.social\/@chadpod\/116569643204260383"><p>For security-critical software, .*<\/p><p>I’d rather/);
	assert.match(html[7], /<code style="color:green;font-size:90%">DefinedTerm<\/code>/);
	assert.match(html[7], /<ol><li>/);

	assert.equal(convertPortableText(v).changed, false, "converting twice changes nothing");
	assert.equal(prepareContent(prepared.content).changed, false, "preparing twice changes nothing");
});

test("0.10.0 markers (no fields, only WordPress's markup) still convert", () => {
	const sidenote = markerHtml("sidenote", {}, '<aside class="sidenote"><h2>&#x1F4CC; Sidenote</h2><p><a href="https://x.com/">Listen</a></p></aside>');
	const transcript = markerHtml("transcript", {}, '<details class="transcript"><summary>Read the audio transcript</summary><div class="transcript__body"><p>JH: Hi</p></div></details>');
	const details = markerHtml("details", {}, '<details class="wp-block-details" open><summary>Why?</summary>\n<p>Because.</p>\n</details>');
	const quote = markerHtml("blockquote", {}, '<figure class="wp-custom-blockquote"><blockquote cite="https://a.com/?x=1&amp;y=2"><p>Q</p></blockquote><figcaption><cite>Someone</cite></figcaption></figure>');
	const out = convertPortableText([sidenote, transcript, details, quote].map((html, i) => ({ _type: "htmlBlock", _key: `h${i}`, html })));
	assert.deepEqual(out.value.map((b) => b._type), ["coywolf-note", "coywolf-details", "coywolf-details", "coywolf-quote"]);
	assert.equal(out.value[0].body, '<p><a href="https://x.com/">Listen</a></p>');
	assert.deepEqual([out.value[1].variant, out.value[1].summary, out.value[1].body], ["transcript", "Read the audio transcript", "<p>JH: Hi</p>"]);
	assert.deepEqual([out.value[2].summary, out.value[2].body, out.value[2].open], ["Why?", "<p>Because.</p>", true]);
	assert.deepEqual([out.value[3].quote, out.value[3].citation, out.value[3].sourceUrl], ["<p>Q</p>", "Someone", "https://a.com/?x=1&y=2"]);
	assert.equal(out.value[0]._key, "h0", "keys are kept");
	// Unrecognized markup is left alone.
	assert.equal(noteBlock("sidenote", {}, "<p>other</p>"), null);
	assert.equal(detailsBlock("details", {}, "<div>x</div>"), null);
	assert.equal(quoteBlock({}, "<p>x</p>"), null);
});

// ── Guest authors ────────────────────────────────────────────────

const cdata = (text) => `<![CDATA[${text}]]>`;
const meta = (key, value) => `<wp:postmeta><wp:meta_key>${cdata(key)}</wp:meta_key><wp:meta_value>${cdata(value)}</wp:meta_value></wp:postmeta>`;
// Values verbatim from coywolf.com (post 3546 and its avatar attachment).
const GUEST_WXR = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel>
<item><title>${cdata("Why crypto is a waste of energy, full of crime, and isn't really decentralized")}</title><wp:post_id>3546</wp:post_id><wp:post_name>${cdata("why-crypto-is-a-waste-of-energy-full-of-crime-and-isnt-really-decentralized")}</wp:post_name><wp:post_type>${cdata("post")}</wp:post_type><content:encoded>${cdata("<p>x</p>")}</content:encoded>
${meta("_guest_author", "David Rosenthal")}${meta("_guest_author_url", "https://blog.dshr.org/")}${meta("_guest_author_bio", "David S. H. Rosenthal (born 1948) is a British-American computer scientist who co-developed Sun's NeWS windowing system, authored the X Window System's ICCCM, and was Nvidia's fourth employee and chief scientist. He later led the LOCKSS digital preservation project at Stanford, earning the 2025 Paul Evan Peters Award.")}${meta("_guest_author_avatar_id", "10671")}</item>
<item><title>Other</title><wp:post_id>12</wp:post_id><wp:post_name>other</wp:post_name><wp:post_type>${cdata("post")}</wp:post_type>${meta("_guest_author", "")}</item>
<item><title>Avatar</title><wp:post_id>10671</wp:post_id><wp:post_type>${cdata("attachment")}</wp:post_type><wp:attachment_url>${cdata("https://coywolf.com/wp-content/uploads/2022/02/david.s.h.rosenthal.jpg")}</wp:attachment_url></item>
</channel></rss>`;

test("guest authors are read from the export's post meta, with the avatar's URL", () => {
	const guests = prepareWxr(GUEST_WXR).guestAuthors;
	assert.equal(guests.length, 1, "an empty name means no guest");
	const [g] = guests;
	assert.deepEqual(
		{ postId: g.postId, postType: g.postType, slug: g.slug, name: g.name, url: g.url, avatarId: g.avatarId, avatarUrl: g.avatarUrl },
		{
			postId: 3546,
			postType: "post",
			slug: "why-crypto-is-a-waste-of-energy-full-of-crime-and-isnt-really-decentralized",
			name: "David Rosenthal",
			url: "https://blog.dshr.org/",
			avatarId: 10671,
			avatarUrl: "https://coywolf.com/wp-content/uploads/2022/02/david.s.h.rosenthal.jpg",
		},
	);
	assert.ok(g.bio.startsWith("David S. H. Rosenthal (born 1948)"));
	assert.deepEqual(wxrGuestAuthors(GUEST_WXR), [{ ...g, avatarUrl: "" }], "without attachments there's no avatar URL");
});

test("guests group into bylines by name, with a valid slug and the avatar's file name", () => {
	const [g] = wxrGuestAuthors(GUEST_WXR, new Map([[10671, "https://coywolf.com/wp-content/uploads/2022/02/david.s.h.rosenthal.jpg"]]));
	const groups = groupGuests([g, { ...g, slug: "second", name: " david  rosenthal ", url: "", bio: "" }]);
	assert.equal(groups.length, 1);
	assert.deepEqual(
		{ name: groups[0].name, slug: groups[0].slug, url: groups[0].url, avatarFile: groups[0].avatarFile, posts: groups[0].posts.length },
		{ name: "David Rosenthal", slug: "david-rosenthal", url: "https://blog.dshr.org/", avatarFile: "david.s.h.rosenthal.jpg", posts: 2 },
	);
	assert.equal(bylineSlug("José Ñúñez Jr."), "jose-nunez-jr");
	assert.equal(bylineSlug("3D Printing Co"), "d-printing-co");
	assert.equal(bylineSlug("文字"), "guest");
	assert.ok(sameName("David Rosenthal", "david rosenthal"));
	assert.equal(collectionFor("post"), "posts");
	assert.equal(collectionFor("page"), "pages");
	assert.equal(bioText("<p>One &amp; <strong>two</strong></p><p>Three</p>"), "One & two\nThree");
});

// ── Renamed from Content Blocks (0.12.0) ─────────────────────────

test("saved Content Blocks switches carry over to the Custom Blocks feature ids", async () => {
	const { resolveFeatures, featureCatalog } = await import("../src/core/features.ts");
	const { FEATURES, customBlocksPack } = await import("../src/customBlocks/pack.ts");
	assert.deepEqual(
		FEATURES.map((f) => [f.id, f.replaces ?? null]),
		[
			["customBlocks", ["contentBlocks"]],
			["customBlocks.note", ["contentBlocks.note"]],
			["customBlocks.details", ["contentBlocks.details"]],
			["customBlocks.disclosure", ["contentBlocks.disclosure"]],
			["customBlocks.quote", ["contentBlocks.quote"]],
			["customBlocks.testimonial", null],
			["customBlocks.podcast", null],
		],
	);
	assert.ok(FEATURES.every((f) => f.default === false), "new features default off");
	assert.ok(!featureCatalog().some((f) => f.id.startsWith("contentBlocks")), "the old ids are gone from the Features page");

	const stored = { contentBlocks: true, "contentBlocks.note": true, "contentBlocks.details": true, "contentBlocks.disclosure": false };
	const on = resolveFeatures(stored);
	assert.deepEqual(
		[on.customBlocks, on["customBlocks.note"], on["customBlocks.details"], on["customBlocks.disclosure"], on["customBlocks.quote"], on["customBlocks.testimonial"], on["customBlocks.podcast"]],
		[true, true, true, false, false, false, false],
	);
	// Module off before: its blocks stay off.
	assert.equal(resolveFeatures({ contentBlocks: false, "contentBlocks.note": true })["customBlocks.note"], false);
	// A choice saved under the new id wins over the old one.
	assert.equal(resolveFeatures({ ...stored, "customBlocks.note": false })["customBlocks.note"], false);
	assert.equal(resolveFeatures({}).customBlocks, false);

	const pack = customBlocksPack();
	assert.equal(pack.id, "customBlocks");
	assert.equal(pack.label, "Custom Blocks");
	assert.deepEqual(pack.adminPages, [{ path: "/custom-blocks", label: "Custom Blocks", icon: "squares-four" }]);
	assert.deepEqual(
		pack.portableTextBlocks.map((b) => b.type),
		["coywolf-note", "coywolf-details", "coywolf-disclosure", "coywolf-quote", "coywolf-testimonial", "coywolf-podcast"],
		"shipped block types are unchanged",
	);
	assert.ok(pack.routes["customBlocks/settings"] && pack.routes["customBlocks/settings/save"] && pack.routes["customBlocks/podcast/save"]);
	const { SETTINGS_KEY } = await import("../src/customBlocks/settings.ts");
	assert.equal(SETTINGS_KEY, "contentBlocks", "the disclosure wording keeps its storage key");
});

// ── Testimonial ──────────────────────────────────────────────────

test("testimonial: figure, blockquote and figcaption; fields escaped; unsafe links dropped", () => {
	const t = R.normalizeTestimonial({
		quote: "Great <script>x</script>work & **really** good.",
		name: 'Ann "A" <b>Lee</b>',
		title: "CEO & founder",
		photo: "https://example.com/a.jpg?x=1&y=2",
		nameUrl: "javascript:alert(1)",
		titleUrl: "https://example.com/co/",
	});
	assert.equal(t.nameUrl, "", "javascript: links are dropped");
	const html = R.renderTestimonialHtml(t);
	assert.equal(
		html,
		'<figure class="cw-testimonial"><blockquote class="cw-testimonial__quote"><p>Great work &amp; <strong>really</strong> good.</p></blockquote><figcaption class="cw-testimonial__person"><img class="cw-testimonial__photo" src="https://example.com/a.jpg?x=1&amp;y=2" alt="" width="64" height="64" loading="lazy" decoding="async"><span class="cw-testimonial__who"><span class="cw-testimonial__name">Ann &quot;A&quot; &lt;b&gt;Lee&lt;/b&gt;</span><span class="cw-testimonial__title"><a href="https://example.com/co/">CEO &amp; founder</a></span></span></figcaption></figure>',
	);
	assert.equal(R.renderTestimonialHtml(R.normalizeTestimonial({ name: "No quote" })), "", "nothing to show without a quote");
	assert.equal(R.renderTestimonialHtml(R.normalizeTestimonial({ quote: "Just this." })), '<figure class="cw-testimonial"><blockquote class="cw-testimonial__quote"><p>Just this.</p></blockquote></figure>');
	// media_picker values may be objects with a url; site-relative works too.
	assert.equal(R.normalizeTestimonial({ quote: "q", photo: { url: "/_emdash/api/media/file/a.jpg" } }).photo, "/_emdash/api/media/file/a.jpg");
	assert.match(
		R.renderTestimonialHtml({ ...R.normalizeTestimonial({ quote: "q", photo: "/_emdash/api/media/file/a.jpg" }) }, { src: "https://m.x/s/64x64/a.jpg", srcset: "https://m.x/s/64x64/a.jpg 1x, https://m.x/s/128x128/a.jpg 2x" }),
		/<img class="cw-testimonial__photo" src="https:\/\/m\.x\/s\/64x64\/a\.jpg" srcset="https:\/\/m\.x\/s\/64x64\/a\.jpg 1x, https:\/\/m\.x\/s\/128x128\/a\.jpg 2x" alt=""/,
		"resized copies when the caller has them",
	);
	assert.match(R.renderTestimonialHtml(R.normalizeTestimonial({ quote: "q", photo: "/_emdash/api/media/file/a.jpg" }), null), /src="\/_emdash\/api\/media\/file\/a\.jpg" alt=""/, "else the original");

	assert.equal(R.normalizeTestimonial({ quote: "q", photo: "//evil.example/a.jpg" }).photo, "");
	assert.equal(R.normalizeTestimonial({ quote: "q", photo: 'https://x.com/a.jpg" onerror="x' }).photo, "", "no spaces or quotes in URLs");
	assert.match(R.CUSTOM_BLOCKS_CSS, /\.cw-testimonial \.cw-testimonial__quote>:first-child::before\{content:"\\201C";content:"\\201C"\/""\}/);
});

// ── Podcast links ────────────────────────────────────────────────

test("podcast links: site links by default, the block's own on request, accessible names, escaped", () => {
	const site = R.normalizePodcastSettings({
		heading: "Subscribe to <Coywolf> Podcast",
		headingTag: "h3",
		links: { apple: "https://podcasts.apple.com/us/podcast/coywolf/id1441274044", spotify: "javascript:alert(1)", rss: "/feed.xml?a=1&b=2", bogus: "https://x.com/" },
	});
	assert.equal(site.links.spotify, "");
	assert.equal(site.showIcons, true);
	assert.ok(!("bogus" in site.links));
	const html = R.renderPodcastHtml(R.normalizePodcast({}), site, "cw-podcast-k1");
	assert.equal(
		html.replace(/<svg[\s\S]*?<\/svg>/g, "[icon]"),
		'<section class="cw-podcast" aria-labelledby="cw-podcast-k1"><h3 class="cw-podcast__title" id="cw-podcast-k1">Subscribe to &lt;Coywolf&gt; Podcast</h3><ul class="cw-podcast__links" role="list"><li><a class="cw-podcast__link cw-podcast__link--apple" href="https://podcasts.apple.com/us/podcast/coywolf/id1441274044">[icon]<span>Apple Podcasts</span></a></li><li><a class="cw-podcast__link cw-podcast__link--rss" href="/feed.xml?a=1&amp;b=2" type="application/rss+xml">[icon]<span>RSS feed</span></a></li></ul></section>',
	);
	assert.ok(/<svg[^>]*aria-hidden="true" focusable="false"/.test(html), "icons are hidden from assistive tech");
	// The block's own links (and heading) replace the site's entirely.
	const own = R.renderPodcastHtml(R.normalizePodcast({ source: "block", heading: "Listen", spotify: "https://open.spotify.com/show/x", apple: "" }), { ...site, showIcons: false }, "p");
	assert.equal(own, '<section class="cw-podcast" aria-labelledby="p"><h3 class="cw-podcast__title" id="p">Listen</h3><ul class="cw-podcast__links" role="list"><li><a class="cw-podcast__link cw-podcast__link--spotify" href="https://open.spotify.com/show/x"><span>Spotify</span></a></li></ul></section>');
	// No links: nothing at all.
	assert.equal(R.renderPodcastHtml(R.normalizePodcast({}), R.DEFAULT_PODCAST, "x"), "");
	assert.equal(R.normalizePodcastSettings(null).heading, "Subscribe to the podcast");
	assert.equal(R.normalizePodcastSettings({ headingTag: "h1" }).headingTag, "h2");
});

// ── WordPress import: testimonials and podcast links ─────────────

test("coywolf.com's 13 testimonials and the podcast links block convert, content exact", () => {
	const attachments = new Map([[712, "https://coywolf.com/wp-content/uploads/2020/05/aj-kohn.jpg"]]);
	const prepared = prepareContent(fixture("testimonials-podcast.html"), { attachments });
	assert.deepEqual(prepared.counts, { "coywolf-custom-blocks/testimonial → testimonial": 13, "coywolf-custom-blocks/podcast-rss → podcast": 1 });
	const result = convertPortableText(gutenbergToPortableText(prepared.content), { key: keys() });
	const v = result.value;
	assert.deepEqual(v.map((b) => b._type), [...Array(13).fill("coywolf-testimonial"), "coywolf-podcast"]);
	assert.deepEqual(v[0], {
		_type: "coywolf-testimonial",
		_key: v[0]._key,
		quote: "Coywolf is an island oasis of intelligent and actionable content amidst a cookie-cutter firehose of digital hype.",
		name: "AJ Kohn",
		title: "Digital Marketing Executive and Start-Up Advisor",
		photo: "https://coywolf.com/wp-content/uploads/2020/05/aj-kohn.jpg",
		nameUrl: "https://www.linkedin.com/in/ajkohn/",
		titleUrl: "https://www.blindfiveyearold.com",
	});
	assert.equal(v[1].photo, undefined, "no attachment URL: no photo");
	assert.equal(v[10].title, "Marketing & SEO veteran, Founder of De9eR Media", "WordPress's \\u0026 is decoded");
	assert.equal(v[2].quote, "From all the topics I’ve read and interacted with via Coywolf, I’ve always come out learning something new. Jon goes out of his way to share exclusive and valuable materials with the community.");
	assert.equal(v[11].nameUrl, "https://mastodon.social/@mihm");
	assert.deepEqual(v[13], { _type: "coywolf-podcast", _key: v[13]._key, source: "site" });
	assert.deepEqual(result.leftovers, {});

	const html = R.renderTestimonialHtml(R.normalizeTestimonial(v[10]));
	assert.match(html, /<span class="cw-testimonial__title"><a href="https:\/\/www\.linkedin\.com\/company\/de9er-media\/">Marketing &amp; SEO veteran, Founder of De9eR Media<\/a><\/span>/);

	assert.equal(convertPortableText(v).changed, false, "converting twice changes nothing");
	assert.equal(prepareContent(prepared.content).changed, false, "preparing twice changes nothing");

	// Switched off: the markers stay HTML (testimonials with WordPress's markup) and convert later.
	const off = convertPortableText(gutenbergToPortableText(prepared.content), { key: keys(), customBlocks: { testimonial: false, podcast: false } });
	assert.deepEqual(off.leftovers, { "marker:testimonial": 13, "marker:podcast-links": 1 });
	assert.equal(convertPortableText(off.value, { key: keys() }).changes.length, 14);
});

test("0.10/0.11 testimonial and podcast markers (WordPress's markup only) convert too", () => {
	// Exactly what 0.11.0's prepare step wrote for these two blocks.
	const testimonial = markerHtml(
		"testimonial",
		{},
		'<blockquote class="testimonial"><div class="quote"><p><q>Coywolf goes down the rabbit holes so I don\'t have to.</q></p></div><div class="influencer"><img alt="Rob Kerry" height="60" width="60" src="https://coywolf.com/wp-content/uploads/rob.jpg"><p><a href="https://www.linkedin.com/in/robkerry/">Rob Kerry</a></p><p><a href="https://resignal.com/?a=1&amp;b=2">Commercial Director at Re:signal</a></p></div></blockquote>',
	);
	const bare = markerHtml("testimonial", {}, '<blockquote class="testimonial"><div class="quote"><p><q>Q &amp; A</q></p></div><div class="influencer"><p>Debra &amp; Co</p><p></p></div></blockquote>');
	const podcast = markerHtml("podcast-links", { block: "coywolf-custom-blocks/podcast-rss" });
	const out = convertPortableText([testimonial, bare, podcast].map((html, i) => ({ _type: "htmlBlock", _key: `h${i}`, html })));
	assert.deepEqual(out.value, [
		{
			_type: "coywolf-testimonial",
			_key: "h0",
			quote: "Coywolf goes down the rabbit holes so I don't have to.",
			name: "Rob Kerry",
			title: "Commercial Director at Re:signal",
			photo: "https://coywolf.com/wp-content/uploads/rob.jpg",
			nameUrl: "https://www.linkedin.com/in/robkerry/",
			titleUrl: "https://resignal.com/?a=1&b=2",
		},
		{ _type: "coywolf-testimonial", _key: "h1", quote: "Q &amp; A", name: "Debra & Co" },
		{ _type: "coywolf-podcast", _key: "h2", source: "site" },
	]);
	assert.equal(testimonialBlock({}, "<p>other</p>"), null);
	assert.equal(testimonialBlock({ quote: " " }), null);
});

test("sanitizer: unclosed tags can't make a field take seconds (no rescan to the end from every <)", () => {
	for (const input of ["<a b".repeat(100_000), "<a b=c ".repeat(60_000), "<".repeat(400_000), "<script".repeat(60_000), '<a x="'.repeat(60_000)]) {
		const started = performance.now();
		renderRich(input);
		plainText(input);
		assert.ok(performance.now() - started < 1000, `${input.slice(0, 8)}… took ${Math.round(performance.now() - started)} ms`);
	}
	// Output is unchanged where tags close: an unclosed `<` before a real tag stays text, the real tag still counts.
	assert.equal(renderRich("a <b <strong>bold</strong>", { inline: true }), "a &lt;b <strong>bold</strong>");
	assert.equal(plainText("x <script>alert(1)</script> y <style>p{}</style> z"), "x y z");
	assert.equal(plainText("<SCRIPT>a</script > b"), "b", "closing tags in any case, with spaces");
	assert.equal(plainText("x <script never closed <style>gone</style> y"), "x <script never closed y", "as before: an unclosed script stays text, a later style still goes");
	assert.equal(plainText("a < b and c > d"), "a d", "as before: anything between < and > reads as a tag");
});

test("muted text in the blocks keeps at least 80% of the text color (contrast)", () => {
	const textMixes = [...R.CUSTOM_BLOCKS_CSS.matchAll(/(?:^|[;{])color:color-mix\(in srgb,currentColor (\d+)%,transparent\)/g)].map((m) => Number(m[1]));
	assert.ok(textMixes.length >= 3);
	for (const pct of textMixes) assert.ok(pct >= 80, `${pct}%`);
});

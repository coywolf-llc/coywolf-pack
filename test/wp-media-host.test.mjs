// Run: node --test test/wp-media-host.test.mjs
// WordPress Migration → "Media host addresses": the site's own /_emdash/api/media/file/<key> URLs in content point at the
// media host; image blocks' asset URLs, link markDefs and code blocks are left alone; keys keep their case.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { rewriteSiteMediaUrls } = await import("../src/wpImport/pack.ts");
const toHost = (key) => `https://media.example.com/${key}`;

test("HTML blocks: relative and same-site absolute file URLs go to the media host; other strings and other sites stay", () => {
	const html = '<figure><img src="/_emdash/api/media/file/01ABC.webp" alt="A"><img srcset="https://example.com/_emdash/api/media/file/02DEF.png 2x"><a href="https://other.example/_emdash/api/media/file/X.png">x</a></figure>';
	const content = [
		{ _type: "html", _key: "h", html },
		{ _type: "image", _key: "i", asset: { _ref: "m1", url: "/_emdash/api/media/file/01ABC.webp" } },
		{ _type: "block", _key: "b", markDefs: [{ _key: "l", _type: "link", href: "/_emdash/api/media/file/doc.pdf" }], children: [] },
	];
	const { value, count } = rewriteSiteMediaUrls({ content }, "https://example.com", toHost);
	assert.equal(count, 2);
	assert.equal(
		value.content[0].html,
		'<figure><img src="https://media.example.com/01ABC.webp" alt="A"><img srcset="https://media.example.com/02DEF.png 2x"><a href="https://other.example/_emdash/api/media/file/X.png">x</a></figure>',
	);
	assert.equal(value.content[1], content[1], "image blocks are untouched (EmDash's media usage reads them)");
	assert.equal(value.content[2], content[2], "plain link hrefs are untouched");
});

test("nothing to change: the same value back, no count", () => {
	const content = [{ _type: "html", _key: "h", html: "<p>No media</p>" }];
	const out = rewriteSiteMediaUrls({ content }, "https://example.com", toHost);
	assert.equal(out.count, 0);
	assert.equal(out.value.content, content);
	assert.equal(rewriteSiteMediaUrls({ content }, "https://example.com", () => null).count, 0);
});

test("converted blocks' URL strings (a How-To step's image src) are rewritten; code blocks and uppercase keys are safe", () => {
	const content = [
		{ _type: "coywolf-howto", _key: "h", steps: [{ jsonText: 'Click <strong>Speed</strong><img src="/_emdash/api/media/file/A.png">', image: { props: { src: "/_emdash/api/media/file/B.PNG" } } }] },
		{ _type: "code", _key: "c", code: '<img src="/_emdash/api/media/file/EXAMPLE.png">' },
	];
	const { value, count } = rewriteSiteMediaUrls(content, "https://example.com", toHost);
	assert.equal(count, 2);
	assert.equal(value[0].steps[0].jsonText, 'Click <strong>Speed</strong><img src="https://media.example.com/A.png">');
	assert.equal(value[0].steps[0].image.props.src, "https://media.example.com/B.PNG", "the key keeps its case (R2 keys are case-sensitive)");
	assert.equal(value[1], content[1], "example code is untouched");
});


// Run: node --test test/wp-media-host.test.mjs
// WordPress Migration → "Media host URLs in HTML": the site's own /_emdash/api/media/file/<key> URLs inside HTML strings
// (imported HTML blocks) point at the media host; image blocks' asset URLs and plain links are left alone.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { rewriteHtmlMediaUrls } = await import("../src/wpImport/pack.ts");
const toHost = (u) => u.replace("/_emdash/api/media/file/", "https://media.example.com/");

test("HTML blocks: relative and same-site absolute file URLs go to the media host; other strings and other sites stay", () => {
	const html = '<figure><img src="/_emdash/api/media/file/01ABC.webp" alt="A"><img srcset="https://example.com/_emdash/api/media/file/02DEF.png 2x"><a href="https://other.example/_emdash/api/media/file/X.png">x</a></figure>';
	const content = [
		{ _type: "html", _key: "h", html },
		{ _type: "image", _key: "i", asset: { _ref: "m1", url: "/_emdash/api/media/file/01ABC.webp" } },
		{ _type: "block", _key: "b", markDefs: [{ _key: "l", _type: "link", href: "/_emdash/api/media/file/doc.pdf" }], children: [] },
	];
	const { value, count } = rewriteHtmlMediaUrls({ content }, "https://example.com", toHost);
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
	const out = rewriteHtmlMediaUrls({ content }, "https://example.com", toHost);
	assert.equal(out.count, 0);
	assert.equal(out.value.content, content);
	assert.equal(rewriteHtmlMediaUrls({ content }, "https://example.com", () => null).count, 0);
});

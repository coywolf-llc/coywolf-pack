// Run: node --test test/images-preconnect.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { withMediaPreconnect } = await import("../src/images/lib.ts");

const HOST = "https://media.example.com";
const page = (headers = {}) => new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("adds a preconnect to the media host on HTML pages", () => {
	const res = withMediaPreconnect(page(), HOST);
	assert.equal(res.headers.get("link"), "<https://media.example.com>; rel=preconnect");
});

test("keeps an existing Link header and adds to it", () => {
	const res = withMediaPreconnect(page({ link: "</style.css>; rel=preload; as=style" }), HOST);
	assert.equal(res.headers.get("link"), "</style.css>; rel=preload; as=style, <https://media.example.com>; rel=preconnect");
});

test("doesn't add a second preconnect to the same host", () => {
	const res = withMediaPreconnect(page({ link: "<https://media.example.com>; rel=preconnect" }), HOST);
	assert.equal(res.headers.get("link"), "<https://media.example.com>; rel=preconnect");
});

test("leaves responses alone without a host or for anything but HTML", () => {
	assert.equal(withMediaPreconnect(page(), null).headers.get("link"), null);
	const xml = new Response("<urlset/>", { headers: { "content-type": "application/xml" } });
	assert.equal(withMediaPreconnect(xml, HOST).headers.get("link"), null);
});

test("copies a response whose headers can't be changed", async () => {
	const res = page();
	const frozen = new Proxy(res, {
		get(target, prop) {
			if (prop === "headers") {
				const h = new Headers(target.headers);
				h.append = () => {
					throw new TypeError("immutable");
				};
				return h;
			}
			const v = Reflect.get(target, prop, target);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	const out = withMediaPreconnect(frozen, HOST);
	assert.notEqual(out, frozen);
	assert.equal(out.headers.get("link"), "<https://media.example.com>; rel=preconnect");
	assert.equal(await out.text(), "<p>hi</p>");
});

// Run: node --test test/images-og.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { setImageCdn, setSavedImageCdn, setStoragePublicUrl } = await import("../src/images/lib.ts");
const { cleanDefaultOgImage, ownImageOnMediaHost, mediaHostImageInfo, packOwnsOgImage, ogImageTags } = await import("../src/schema/og-image.ts");

const ORIGIN = "https://example.com";
const def = { url: `${ORIGIN}/_emdash/api/media/file/DEF.jpg`, width: 2000, height: 1000, alt: "Default" };

function withHost(host, fn) {
	setImageCdn(host);
	setSavedImageCdn(null);
	try {
		fn();
	} finally {
		setImageCdn(null);
	}
}

const tag = (tags, key) => tags.filter((t) => t.property === key || t.name === key).map((t) => t.content);

test("without a media host the default OG image is left to EmDash", () => {
	withHost(null, () => {
		assert.equal(cleanDefaultOgImage(def, ORIGIN), null);
		assert.equal(cleanDefaultOgImage({ url: "/theme/og.png" }, ORIGIN), null);
		assert.equal(cleanDefaultOgImage(null, ORIGIN), null);
	});
});

test("the default OG image from EmDash's site settings on publicUrl gets the clean 1200x630 size", () => {
	setStoragePublicUrl("https://media.example.com");
	try {
		assert.deepEqual(cleanDefaultOgImage({ url: "https://media.example.com/DEF.png", alt: "Default" }, ORIGIN), {
			url: "https://media.example.com/s/1200x630/DEF.png",
			width: 1200,
			height: 630,
			alt: "Default",
			mimeType: "image/png",
		});
		assert.equal(packOwnsOgImage("https://media.example.com/s/1200x630/DEF.png", ORIGIN, false), true);
	} finally {
		setStoragePublicUrl(null);
	}
});

test("default OG image on the media host keeps the original type", () => {
	withHost("https://media.example.com", () => {
		assert.deepEqual(cleanDefaultOgImage(def, ORIGIN), { url: "https://media.example.com/s/1200x630/DEF.jpg", width: 1200, height: 630, alt: "Default", mimeType: "image/jpeg" });
		assert.equal(cleanDefaultOgImage({ ...def, url: "/_emdash/api/media/file/W.webp" }, ORIGIN).mimeType, "image/webp");
		assert.equal(cleanDefaultOgImage({ ...def, url: "/_emdash/api/media/file/V.svg" }, ORIGIN), null);
	});
});

test("the page's own media-library image becomes its original on the media host", () => {
	withHost("https://media.example.com", () => {
		assert.equal(ownImageOnMediaHost("/_emdash/api/media/file/18E5PEHBYCAWPT0B358WYBF02C.webp"), "https://media.example.com/18E5PEHBYCAWPT0B358WYBF02C.webp");
		// Already on the media host (a theme's choice): left alone.
		assert.equal(ownImageOnMediaHost("https://media.example.com/s/440x231/ABC.jpg"), null);
		assert.equal(ownImageOnMediaHost("https://cdn.other.com/x.jpg"), null);
	});
	withHost(null, () => assert.equal(ownImageOnMediaHost("/_emdash/api/media/file/ABC.webp"), null));
});

test("media-host URLs resolve to their media item's size, alt and type", () => {
	withHost("https://media.example.com", () => {
		const row = { width: 1600, height: 900, alt: "A fox", mime_type: "image/jpeg" };
		assert.deepEqual(mediaHostImageInfo("https://media.example.com/ABC.webp", row), { url: "https://media.example.com/ABC.webp", width: 1600, height: 900, alt: "A fox", mimeType: "image/webp" });
		assert.deepEqual(mediaHostImageInfo("https://media.example.com/s/440x231/ABC.webp", row).height, 231);
		assert.deepEqual(mediaHostImageInfo("https://media.example.com/s/800/ABC.webp", row).height, 450);
		assert.equal(mediaHostImageInfo("https://media.example.com/s/800/ABC.webp", { ...row, width: null }).height, null);
		assert.equal(mediaHostImageInfo("https://example.com/ABC.webp", row), null);
	});
});

test("og:image is output by the pack only for URLs it made (never twice)", () => {
	withHost("https://media.example.com", () => {
		assert.equal(packOwnsOgImage("https://media.example.com/ABC.webp", ORIGIN, true), true);
		assert.equal(packOwnsOgImage("https://media.example.com/s/1200x630/DEF.jpg", ORIGIN, false), true);
		// Old Worker-route URLs aren't the pack's to output any more (they only redirect).
		assert.equal(packOwnsOgImage(`${ORIGIN}/media/DEF-1200x630.jpg`, ORIGIN, false), false);
		assert.equal(packOwnsOgImage(`${ORIGIN}/_emdash/api/media/file/ABC.webp`, ORIGIN, true), false);

		const image = { url: "https://media.example.com/ABC.webp", width: 1600, height: 900, alt: "A fox", mimeType: "image/webp" };
		const tags = ogImageTags(image, true);
		assert.deepEqual(tag(tags, "og:image"), ["https://media.example.com/ABC.webp"]);
		assert.deepEqual(tag(tags, "twitter:image"), ["https://media.example.com/ABC.webp"]);
		assert.deepEqual(tag(tags, "og:image:width"), ["1600"]);
		assert.deepEqual(tag(tags, "og:image:type"), ["image/webp"]);
		assert.deepEqual(tag(tags, "twitter:image:alt"), ["A fox"]);
		// EmDash's own og:image stays when the pack doesn't own the URL.
		assert.deepEqual(tag(ogImageTags(image, false), "og:image"), []);
		assert.deepEqual(ogImageTags(null, true), []);
	});
});

test("rewriteMediaUrls points every media-library file in a graph at the media host", async () => {
	const lib = await import("../src/images/lib.ts");
	const { rewriteMediaUrls } = await import("../src/schema/module.ts");
	lib.setImageCdn("https://media.example.com");
	try {
		const graph = { "@graph": [{ "@type": "Person", image: ["https://site.test/_emdash/api/media/file/A1.jpeg", "/_emdash/api/media/file/B2.webp", "https://elsewhere.test/x.png"] }, { "@type": "Organization", logo: { "@type": "ImageObject", url: "https://site.test/_emdash/api/media/file/C3.png" }, url: "https://site.test/" }] };
		rewriteMediaUrls(graph);
		assert.deepEqual(graph["@graph"][0].image, ["https://media.example.com/A1.jpeg", "https://media.example.com/B2.webp", "https://elsewhere.test/x.png"]);
		assert.equal(graph["@graph"][1].logo.url, "https://media.example.com/C3.png");
		assert.equal(graph["@graph"][1].url, "https://site.test/");
	} finally {
		lib.setImageCdn(null);
	}
});

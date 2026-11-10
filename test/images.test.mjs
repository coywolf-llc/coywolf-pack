// Run: node --test test/images.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { cleanImagePath, parseImagePath, mediaFile } = await import("../src/images/lib.ts");
const { setImageCdn, setSavedImageCdn, setStoragePublicUrl, imageCdn, imageCdnSource, cdnOriginalUrl, parseCdnUrl, cdnRedirectUrl, normalizeMediaHost, mimeForExt } = await import("../src/images/lib.ts");
const { loadStoragePublicUrl, resetStoragePublicUrl } = await import("../src/images/settings.ts");

function withHost(option, saved, fn, storage = null) {
	setImageCdn(option);
	setSavedImageCdn(saved);
	setStoragePublicUrl(storage);
	try {
		fn();
	} finally {
		setImageCdn(null);
		setSavedImageCdn(null);
		setStoragePublicUrl(null);
	}
}

test("builds clean URLs for media-library files on the media host", () => {
	withHost("https://media.example.com", null, () => {
		assert.equal(cleanImagePath("/_emdash/api/media/file/01M44MRR9G4JZH2SQTGN4Y4G0D.webp", { width: 600, height: 320 }), "https://media.example.com/s/600x320/01M44MRR9G4JZH2SQTGN4Y4G0D.webp");
		assert.equal(cleanImagePath("https://example.com/_emdash/api/media/file/ABC.jpeg", { width: 400 }), "https://media.example.com/s/400/ABC.jpeg");
		// Any size: the media host resizes (no grid).
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.png", { width: 641, height: 337 }), "https://media.example.com/s/641x337/ABC.png");
		// EmDash 1.1 upload keys carry an attempt ULID: <stem>.<attempt>.<ext>.
		assert.equal(
			cleanImagePath("/_emdash/api/media/file/01M4526PHAXT6EAJARYNFEQXF4.01M4526PN8A8K4RASN2MDPCEBP.png", { width: 400 }),
			"https://media.example.com/s/400/01M4526PHAXT6EAJARYNFEQXF4.01M4526PN8A8K4RASN2MDPCEBP.png",
		);
	});
	assert.deepEqual(mediaFile("/_emdash/api/media/file/A.B.jpeg"), { id: "A.B", ext: "jpeg" });
	assert.deepEqual(parseImagePath("/media/A.B-400w.webp"), { id: "A.B", width: 400, height: undefined, format: "webp" });
});

test("without a media host there are no clean URLs (the Worker route is gone): themes use their own image code", () => {
	withHost(null, null, () => {
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 600, height: 315 }), null);
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.png", { width: 800, format: "avif" }), null);
	});
});

test("refuses anything else", () => {
	withHost("https://media.example.com", null, () => {
		assert.equal(cleanImagePath("/theme/images/logo.png", { width: 100 }), null);
		assert.equal(cleanImagePath("https://cdn.example.com/x.webp", { width: 100 }), null);
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 0 }), null);
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 9000 }), null);
		// Cloudflare's resizer can't read AVIF originals.
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.avif", { width: 100 }), null);
	});
	assert.equal(mediaFile("/_emdash/api/media/file/../secret.webp"), null);
});

test("parses old Worker-route paths (they redirect to the media host)", () => {
	assert.deepEqual(parseImagePath("/media/ABC-600x315.webp"), { id: "ABC", width: 600, height: 315, format: "webp" });
	assert.deepEqual(parseImagePath("/media/ABC-400w.jpg"), { id: "ABC", width: 400, height: undefined, format: "jpg" });
	assert.equal(parseImagePath("/media/ABC-600x315.svg"), null);
	assert.equal(parseImagePath("/media/ABC-99999x1.webp"), null);
	assert.equal(parseImagePath("/media/../x-1x1.webp"), null);
	assert.equal(parseImagePath("/media/ABC.webp"), null);
});

test("EmDash's storage publicUrl is the media host, ahead of the saved host and images.cdn", () => {
	withHost("https://media.example.com", "https://img.example.com", () => {
		assert.equal(imageCdn(), "https://cdn.example.com");
		assert.equal(imageCdnSource().from, "storage");
		assert.equal(imageCdnSource().storage, "https://cdn.example.com");
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.jpg", { width: 400 }), "https://cdn.example.com/s/400/ABC.jpg");
	}, "https://cdn.example.com/");
	withHost("https://media.example.com", "https://img.example.com", () => assert.equal(imageCdnSource().from, "saved"));
	withHost("https://media.example.com", null, () => assert.equal(imageCdnSource().from, "option"));
	withHost(null, null, () => assert.equal(imageCdnSource().from, null));
	// A publicUrl with a path (or on http) can't take the /s/ rules: the fallback stays the media host.
	withHost("https://media.example.com", null, () => {
		assert.equal(imageCdn(), "https://media.example.com");
		assert.equal(imageCdnSource().storage, null);
		assert.equal(imageCdnSource().storageUrl, "https://bucket.example.com/media");
	}, "https://bucket.example.com/media/");
});

test("media URLs EmDash prints with publicUrl set (<publicUrl>/<file>) are media-library files", () => {
	withHost(null, null, () => {
		assert.deepEqual(mediaFile("https://media.example.com/01M44MRR9G4JZH2SQTGN4Y4G0D.jpg"), { id: "01M44MRR9G4JZH2SQTGN4Y4G0D", ext: "jpg" });
		assert.deepEqual(mediaFile("https://media.example.com/A.B.png?v=2"), { id: "A.B", ext: "png" });
		// Resized and stored sizes aren't files; nor is anything off the host.
		assert.equal(mediaFile("https://media.example.com/s/400/ABC.jpg"), null);
		assert.equal(mediaFile("https://media.example.com/v1/ABC-400.webp"), null);
		assert.equal(mediaFile("https://media.example.com.evil.com/ABC.jpg"), null);
		assert.equal(mediaFile("https://other.example.com/ABC.jpg"), null);
		// Site-settings images (logo, default social image) on publicUrl get clean sizes and originals.
		assert.equal(cleanImagePath("https://media.example.com/DEF.jpg", { width: 1200, height: 630 }), "https://media.example.com/s/1200x630/DEF.jpg");
		assert.equal(cdnOriginalUrl("https://media.example.com/DEF.jpg"), "https://media.example.com/DEF.jpg");
	}, "https://media.example.com");
	// With a path in publicUrl, its URLs are still recognized, and the media host (here images.cdn) serves them.
	withHost("https://img.example.com", null, () => {
		assert.deepEqual(mediaFile("https://bucket.example.com/media/ABC.jpg"), { id: "ABC", ext: "jpg" });
		assert.equal(cdnOriginalUrl("https://bucket.example.com/media/ABC.jpg"), "https://img.example.com/ABC.jpg");
		assert.equal(cleanImagePath("https://bucket.example.com/media/ABC.jpg", { width: 300 }), "https://img.example.com/s/300/ABC.jpg");
		assert.deepEqual(parseCdnUrl("https://bucket.example.com/media/ABC.jpg"), { id: "ABC", ext: "jpg", width: undefined, height: undefined });
		assert.equal(mediaFile("https://bucket.example.com/ABC.jpg"), null);
	}, "https://bucket.example.com/media");
	// A host that was set before (images.cdn) keeps being recognized after the switch to publicUrl.
	withHost("https://old-media.example.com", null, () => {
		assert.equal(cdnOriginalUrl("https://old-media.example.com/ABC.jpg"), "https://media.example.com/ABC.jpg");
	}, "https://media.example.com");
});

test("EmDash's publicUrl is read from its build-time config once per isolate", async () => {
	resetStoragePublicUrl();
	let reads = 0;
	const load = async () => (reads++, { storage: { entrypoint: "@emdash-cms/cloudflare/storage/r2", config: { binding: "MEDIA", publicUrl: "https://media.example.com/" } } });
	await loadStoragePublicUrl(load);
	await loadStoragePublicUrl(load);
	assert.equal(reads, 1);
	assert.equal(imageCdn(), "https://media.example.com");
	resetStoragePublicUrl();
	await loadStoragePublicUrl(async () => ({ storage: { entrypoint: "@emdash-cms/cloudflare/storage/r2", config: { binding: "MEDIA" } } }));
	assert.equal(imageCdn(), null, "no publicUrl: nothing set");
	resetStoragePublicUrl();
	await loadStoragePublicUrl(async () => {
		throw new Error("no virtual module outside a site build");
	});
	assert.equal(imageCdn(), null);
	resetStoragePublicUrl();
});


test("normalizes media hosts to https origins and refuses anything else", () => {
	assert.equal(normalizeMediaHost("media.example.com"), "https://media.example.com");
	assert.equal(normalizeMediaHost(" https://Media.Example.com/ "), "https://media.example.com");
	assert.equal(normalizeMediaHost("http://media.example.com"), null);
	assert.equal(normalizeMediaHost("https://media.example.com/images"), null);
	assert.equal(normalizeMediaHost("https://media.example.com:8443"), null);
	assert.equal(normalizeMediaHost("https://user@media.example.com"), null);
	assert.equal(normalizeMediaHost("localhost"), null);
	assert.equal(normalizeMediaHost("javascript:alert(1)"), null);
	assert.equal(normalizeMediaHost(""), null);
	withHost("http://media.example.com", null, () => assert.equal(imageCdn(), null));
	withHost("not a host", null, () => assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 100 }), null));
});

test("the saved host wins over the option", () => {
	withHost("https://media.example.com", "https://img.example.com", () => assert.equal(imageCdn(), "https://img.example.com"));
	withHost("https://media.example.com", null, () => assert.equal(imageCdn(), "https://media.example.com"));
	withHost(null, null, () => assert.equal(imageCdn(), null));
});

test("builds media-host URLs when a host is set", () => {
	withHost("https://media.example.com/", null, () => {
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.jpg", { width: 440, height: 231 }), "https://media.example.com/s/440x231/ABC.jpg");
		assert.equal(cleanImagePath("https://example.com/_emdash/api/media/file/ABC.png", { width: 800, format: "avif" }), "https://media.example.com/s/800/ABC.png");
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.jpg", { width: 9000 }), null);
		assert.equal(cleanImagePath("/theme/logo.png", { width: 100 }), null);
		assert.equal(cdnOriginalUrl("/_emdash/api/media/file/18E5PEHBYCAWPT0B358WYBF02C.webp"), "https://media.example.com/18E5PEHBYCAWPT0B358WYBF02C.webp");
		assert.equal(cdnOriginalUrl("https://media.example.com/s/440x231/ABC.jpg"), "https://media.example.com/ABC.jpg");
		assert.equal(cdnOriginalUrl("/theme/logo.png"), null);
	});
	withHost(null, null, () => assert.equal(cdnOriginalUrl("/_emdash/api/media/file/ABC.webp"), null));
});

test("parses media-host URLs", () => {
	withHost("https://media.example.com", null, () => {
		assert.deepEqual(parseCdnUrl("https://media.example.com/ABC.webp"), { id: "ABC", ext: "webp", width: undefined, height: undefined });
		assert.deepEqual(parseCdnUrl("https://media.example.com/s/440x231/ABC.jpg"), { id: "ABC", ext: "jpg", width: 440, height: 231 });
		assert.deepEqual(parseCdnUrl("https://media.example.com/s/800/ABC.png?v=1"), { id: "ABC", ext: "png", width: 800, height: undefined });
		assert.equal(parseCdnUrl("https://media.example.com/s/9999/ABC.png"), null);
		assert.equal(parseCdnUrl("https://media.example.com/s/0x10/ABC.png"), null);
		assert.equal(parseCdnUrl("https://media.example.com/other/ABC.png"), null);
		assert.equal(parseCdnUrl("https://media.example.com.evil.com/ABC.png"), null);
		assert.equal(parseCdnUrl("https://other.example.com/ABC.png"), null);
		assert.equal(parseCdnUrl("/media/ABC-1x1.webp"), null);
		const url = cleanImagePath("/_emdash/api/media/file/ID_1.webp", { width: 640, height: 336 });
		assert.deepEqual(parseCdnUrl(url), { id: "ID_1", ext: "webp", width: 640, height: 336 });
	});
	withHost(null, null, () => assert.equal(parseCdnUrl("https://media.example.com/ABC.webp"), null));
});

test("old Worker-route URLs redirect to the same size on the media host", () => {
	withHost("https://media.example.com", null, () => {
		assert.equal(cdnRedirectUrl(parseImagePath("/media/ABC-600x315.webp"), "ABC.jpg"), "https://media.example.com/s/600x315/ABC.jpg");
		assert.equal(cdnRedirectUrl(parseImagePath("/media/ABC-400w.avif"), "ABC.png"), "https://media.example.com/s/400/ABC.png");
		assert.equal(cdnRedirectUrl({ width: 10 }, "../x.png"), null);
		assert.equal(cdnRedirectUrl({ width: 10 }, "a/b.png"), null);
	});
	withHost(null, null, () => assert.equal(cdnRedirectUrl({ width: 10 }, "ABC.png"), null));
});

test("knows original MIME types by extension", () => {
	assert.equal(mimeForExt("JPG"), "image/jpeg");
	assert.equal(mimeForExt("gif"), "image/gif");
	assert.equal(mimeForExt("svg"), "image/svg+xml");
	assert.equal(mimeForExt("bin"), undefined);
});

test("the media host only resizes formats Cloudflare's resizer reads (no AVIF originals)", () => {
	withHost("https://media.example.com", null, () => {
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 400 }), "https://media.example.com/s/400/ABC.webp");
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.gif", { width: 400 }), "https://media.example.com/s/400/ABC.gif");
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.avif", { width: 400 }), null);
		assert.equal(cdnOriginalUrl("/_emdash/api/media/file/ABC.avif"), "https://media.example.com/ABC.avif", "the original still loads from the host");
	});
});

// Run: node --test test/video-upload.test.mjs
// Video uploads go through the site (EmDash's admin CSP is connect-src 'self'): videos/upload
// starts a tus upload and keeps its URL in KV; videos/upload-chunk forwards each piece there.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { invalidateFeatures } = await import("../src/core/features.ts");
const { videosPack } = await import("../src/videos/pack.ts");
const { UPLOAD_CHUNK_BYTES } = await import("../src/videos/module.ts");
const { routes } = videosPack({});

const UID = "0123456789abcdef0123456789abcdef";
const TUS_URL = "https://upload.cloudflarestream.com/tus/0123456789abcdef0123456789abcdef?tusv2=true";

function ctx({ input, headers = {}, kv = new Map() }) {
	return {
		input,
		request: new Request("https://example.com/", { method: "POST", headers }),
		settings: { get: async (key) => (key === "features" ? { videos: true } : null) },
		kv: {
			get: async (key) => kv.get(key) ?? null,
			set: async (key, value) => void kv.set(key, value),
			delete: async (key) => void kv.delete(key),
		},
		log: { info() {}, warn() {}, error() {} },
	};
}

const pending = (size) => new Map([[`videos:upload:${UID}`, { url: TUS_URL, size, createdAt: Date.now() }]]);
const chunkHeaders = (offset, uid = UID) => ({ "x-cw-upload-uid": uid, "x-cw-upload-offset": String(offset) });

async function withFetch(handler, run) {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

test("pieces are 5 MiB, a multiple of 256 KiB and under EmDash's 8 MiB route cap", () => {
	assert.equal(UPLOAD_CHUNK_BYTES % (256 * 1024), 0);
	assert.ok(UPLOAD_CHUNK_BYTES >= 5 * 1024 * 1024 && UPLOAD_CHUNK_BYTES <= 8 * 1024 * 1024);
});

test("an image is refused before anything reaches Stream", async () => {
	invalidateFeatures();
	await withFetch(
		() => assert.fail("no request to Stream"),
		() => assert.rejects(routes["videos/upload"].handler(ctx({ input: { name: "Poster", size: 98410, type: "image/webp" } })), /video file/),
	);
});

test("a piece is forwarded to the stored tus URL at its offset", async () => {
	invalidateFeatures();
	const kv = pending(10);
	const calls = [];
	const result = await withFetch(
		async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers, bytes: init.body.byteLength });
			return new Response(null, { status: 204, headers: { "Upload-Offset": "6" } });
		},
		() => routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(6), headers: chunkHeaders(0), kv })),
	);
	assert.deepEqual(result, { offset: 6, done: false });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, TUS_URL);
	assert.equal(calls[0].method, "PATCH");
	assert.equal(calls[0].headers["Upload-Offset"], "0");
	assert.equal(calls[0].bytes, 6);
	assert.ok(kv.has(`videos:upload:${UID}`), "kept until the last piece");
});

test("the last piece finishes the upload and forgets its URL", async () => {
	invalidateFeatures();
	const kv = pending(10);
	const result = await withFetch(
		async () => new Response(null, { status: 204, headers: { "Upload-Offset": "10" } }),
		() => routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(4), headers: chunkHeaders(6), kv })),
	);
	assert.deepEqual(result, { offset: 10, done: true });
	assert.equal(kv.has(`videos:upload:${UID}`), false);
});

test("unknown, expired or out-of-range pieces never reach Stream", async () => {
	invalidateFeatures();
	const noFetch = () => assert.fail("no request to Stream");
	await withFetch(noFetch, async () => {
		await assert.rejects(routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(1), headers: chunkHeaders(0, "../../evil"), kv: pending(10) })), /Unknown upload/);
		await assert.rejects(routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(1), headers: chunkHeaders(0) })), /expired/);
		const old = new Map([[`videos:upload:${UID}`, { url: TUS_URL, size: 10, createdAt: Date.now() - 7 * 3600_000 }]]);
		await assert.rejects(routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(1), headers: chunkHeaders(0), kv: old })), /expired/);
		await assert.rejects(routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(5), headers: chunkHeaders(6), kv: pending(10) })), /out of range/);
		await assert.rejects(routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(1), headers: chunkHeaders(-1), kv: pending(10) })), /out of range/);
		await assert.rejects(routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(0), headers: chunkHeaders(0), kv: pending(10) })), /Empty/);
	});
});

test("a piece Stream refuses is reported, not counted", async () => {
	invalidateFeatures();
	const kv = pending(10);
	await withFetch(
		async () => new Response("nope", { status: 409 }),
		() => assert.rejects(routes["videos/upload-chunk"].handler(ctx({ input: new Uint8Array(6), headers: chunkHeaders(0), kv })), /HTTP 409/),
	);
	assert.ok(kv.has(`videos:upload:${UID}`));
	invalidateFeatures();
});

// ── Below Admin: a daily number of uploads, no MP4 download URLs ──

test("users below Admin can start 10 uploads a day; Admins and API tokens aren't limited", async () => {
	const { NON_ADMIN_UPLOADS_PER_DAY } = await import("../src/videos/module.ts");
	invalidateFeatures();
	const kv = new Map();
	const stream = async (url, init) => {
		if (String(url).includes("/stream?direct_user=true")) return new Response(null, { status: 201, headers: { Location: TUS_URL, "stream-media-id": UID } });
		return Response.json({ success: true, result: {} }); // tagging the waiting video
	};
	const upload = (user) => {
		const c = ctx({ input: { name: "Clip", size: 1000, type: "video/mp4" }, kv });
		c.settings.get = async (key) => (key === "features" ? { videos: true } : key === "videosAccountId" ? "0123456789abcdef0123456789abcdef" : key === "videosApiToken" ? "t" : null);
		return routes["videos/upload"].handler({ ...c, user });
	};
	const contributor = { id: "u1", role: 20 };
	await withFetch(stream, async () => {
		for (let i = 0; i < NON_ADMIN_UPLOADS_PER_DAY; i++) assert.equal((await upload(contributor)).uid, UID);
		await assert.rejects(upload(contributor), (error) => error.status === 429 && /10 video uploads a day/.test(error.message));
		assert.equal((await upload({ id: "u2", role: 40 })).uid, UID, "each user has their own count");
		assert.equal((await upload({ id: "admin", role: 50 })).uid, UID);
		assert.equal((await upload(undefined)).uid, UID, "an API token (admin scope)");
	});
	assert.equal(kv.get("state:videos:uploadsBy:u1").count, NON_ADMIN_UPLOADS_PER_DAY);
	assert.equal(kv.has("state:videos:uploadsBy:admin"), false);
	invalidateFeatures();
});

test("MP4 download URLs are for Admins only; the download's status still shows", async () => {
	const { seesDownloadUrls, withoutDownloadUrl } = await import("../src/videos/module.ts");
	assert.equal(seesDownloadUrls({ user: { role: 50 } }), true);
	assert.equal(seesDownloadUrls({}), true, "an API token");
	for (const role of [20, 30, 40]) assert.equal(seesDownloadUrls({ user: { role } }), false, String(role));
	assert.deepEqual(withoutDownloadUrl({ name: "A", downloadUrl: "https://x/v.mp4", downloadStatus: "ready" }), { name: "A", downloadStatus: "ready" });
	assert.equal(withoutDownloadUrl(null), null);
	const src = (await import("node:fs")).readFileSync(new URL("../src/videos/module.ts", import.meta.url), "utf8");
	for (const route of ["videos/detail", "videos/update"]) {
		const body = src.slice(src.indexOf(`"${route}":`), src.indexOf("\n\t\t}),", src.indexOf(`"${route}":`)));
		assert.match(body, /seesDownloadUrls\(ctx\)/, route);
	}
});

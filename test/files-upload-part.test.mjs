// Run: node --test test/files-upload-part.test.mjs
// Large Files uploads go through the site (EmDash's admin CSP is connect-src 'self'):
// files/upload-part takes one part of a recorded multipart upload and the Worker sends it
// to R2. Bad requests are refused before anything reaches R2.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { invalidateFeatures } = await import("../src/core/features.ts");
const { filesPack } = await import("../src/files/pack.ts");
const { r2Client, PART_SIZE } = await import("../src/files/s3.ts");
const { routes } = filesPack({});

const ID = "fabcdefghijklmnopqrstuvwxy".slice(0, 16);
const SIZE = PART_SIZE * 2 + 10; // three parts: two full, one of 10 bytes

function ctx({ id = ID, part, bytes, doc }) {
	const uploads = new Map(doc ? [[ID, doc]] : []);
	return {
		input: bytes,
		request: new Request("https://example.com/", { method: "POST", headers: { "x-cw-upload-id": id, "x-cw-part-number": String(part) } }),
		settings: { get: async (key) => (key === "features" ? { files: true, "files.largeUploads": true } : null) },
		storage: { files_uploads: { get: async (key) => uploads.get(key) ?? null } },
		http: { fetch: () => assert.fail("nothing may reach R2") },
		log: { info() {}, warn() {}, error() {} },
	};
}
const uploading = { id: ID, key: `files/${ID}/big.zip`, name: "big.zip", size: SIZE, type: "application/zip", uploadedAt: "", status: "uploading", uploadId: "u1", partSize: PART_SIZE };

test("bad parts are refused before anything reaches R2", async () => {
	invalidateFeatures();
	const route = routes["files/upload-part"].handler;
	await assert.rejects(route(ctx({ id: "", part: 1, bytes: new Uint8Array(1), doc: uploading })), /Unknown upload/);
	await assert.rejects(route(ctx({ part: 1, bytes: new Uint8Array(1) })), /doesn't exist/);
	await assert.rejects(route(ctx({ part: 1, bytes: new Uint8Array(PART_SIZE), doc: { ...uploading, status: "ready", uploadId: undefined } })), /already finished/);
	await assert.rejects(route(ctx({ part: 0, bytes: new Uint8Array(PART_SIZE), doc: uploading })), /out of range/);
	await assert.rejects(route(ctx({ part: 4, bytes: new Uint8Array(10), doc: uploading })), /out of range/);
	await assert.rejects(route(ctx({ part: 1, bytes: new Uint8Array(PART_SIZE - 1), doc: uploading })), /should be/);
	await assert.rejects(route(ctx({ part: 3, bytes: new Uint8Array(11), doc: uploading })), /should be 10 bytes/);
	invalidateFeatures();
});

test("the R2 client PUTs a part to its multipart upload and returns the ETag", async () => {
	const calls = [];
	const r2 = r2Client({ accountId: "a".repeat(32), bucket: "media", accessKeyId: "AKID", secretAccessKey: "secret" }, async (url, init) => {
		calls.push({ url, method: init.method, headers: init.headers, size: init.body.byteLength });
		return new Response("", { status: 200, headers: { ETag: '"abc"' } });
	});
	const etag = await r2.uploadPart("files/x/big.zip", "u1", 2, new Uint8Array(PART_SIZE));
	assert.equal(etag, '"abc"');
	const url = new URL(calls[0].url);
	assert.equal(calls[0].method, "PUT");
	assert.equal(url.host, `${"a".repeat(32)}.r2.cloudflarestorage.com`);
	assert.equal(url.pathname, "/media/files/x/big.zip");
	assert.equal(url.searchParams.get("partNumber"), "2");
	assert.equal(url.searchParams.get("uploadId"), "u1");
	assert.equal(calls[0].size, PART_SIZE);
	const headers = new Headers(calls[0].headers);
	assert.equal(headers.get("x-amz-content-sha256"), "UNSIGNED-PAYLOAD");
	assert.match(headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
});

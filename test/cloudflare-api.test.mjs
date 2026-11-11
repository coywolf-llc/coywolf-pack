// Run: node --test test/cloudflare-api.test.mjs
//
// The pack's one Cloudflare API client (src/core/cloudflare-api.ts): the envelope, one error
// class with the permission hint, a deadline on every call, ctx.http when there is one, and
// the token never in an error message.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { CLOUDFLARE_API, CloudflareApiError, cloudflareApi, contextFetch, scrubToken } = await import("../src/core/cloudflare-api.ts");
const { DeadlineError } = await import("../src/core/single-flight.ts");

const TOKEN = "cf-secret-token-1234567890";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a call: bearer auth, JSON body, the envelope's result", async () => {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url, init });
		return json({ success: true, result: { id: "z1" } });
	};
	const { status, result } = await cloudflareApi("/zones/z1/settings", { token: TOKEN, fetch, method: "PATCH", body: { value: "on" } });
	assert.equal(status, 200);
	assert.deepEqual(result, { id: "z1" });
	assert.equal(calls[0].url, `${CLOUDFLARE_API}/zones/z1/settings`);
	assert.equal(calls[0].init.method, "PATCH");
	assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
	assert.equal(calls[0].init.headers["Content-Type"], "application/json");
	assert.equal(calls[0].init.body, '{"value":"on"}');
	assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("errors: one class with the status and codes, Cloudflare's messages, the permission hint on 401/403", async () => {
	const fetch = async () => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403);
	await assert.rejects(cloudflareApi("/zones", { token: TOKEN, fetch, permission: "Zone → Zone → Read" }), (error) => {
		assert.ok(error instanceof CloudflareApiError);
		assert.equal(error.status, 403);
		assert.deepEqual(error.codes, [10000]);
		assert.equal(error.message, "Cloudflare API 403: Authentication error. The Cloudflare API token needs Zone → Zone → Read.");
		return true;
	});
	// success: false on a 200 is an error too; no hint off 401/403.
	await assert.rejects(cloudflareApi("/x", { token: TOKEN, fetch: async () => json({ success: false, errors: [{ message: "Bad" }] }), permission: "X" }), /^CloudflareApiError: Cloudflare API 200: Bad\.$/);
});

test("the token never appears in an error, whatever Cloudflare or the network says", async () => {
	const echo = async () => json({ success: false, errors: [{ message: `invalid token ${TOKEN} (Bearer ${TOKEN})` }] }, 400);
	await assert.rejects(cloudflareApi("/x", { token: TOKEN, fetch: echo }), (error) => !error.message.includes(TOKEN));
	const down = async () => {
		throw new TypeError(`fetch failed for Authorization: Bearer ${TOKEN}`);
	};
	await assert.rejects(cloudflareApi("/x", { token: TOKEN, fetch: down }), (error) => error instanceof TypeError && !error.message.includes(TOKEN));
	assert.equal(scrubToken(`a ${TOKEN} b`, TOKEN), "a … b");
	assert.equal(scrubToken("Bearer abc.def"), "Bearer …");
});

test("every call has a deadline: a stalled call fails and is aborted", async () => {
	let aborted = false;
	const stall = (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => {
				aborted = true;
				reject(new Error("aborted"));
			});
		});
	await assert.rejects(cloudflareApi("/zones", { token: TOKEN, fetch: stall, deadlineMs: 20 }), DeadlineError);
	assert.equal(aborted, true);
});

test("GraphQL: the whole body comes back; errors without data fail", async () => {
	const ok = await cloudflareApi("/graphql", { token: TOKEN, fetch: async () => json({ data: { viewer: {} }, errors: null }), method: "POST", body: "{}", graphql: true });
	assert.deepEqual(ok.result, { data: { viewer: {} }, errors: null });
	await assert.rejects(cloudflareApi("/graphql", { token: TOKEN, fetch: async () => json({ errors: [{ message: "not authorized" }] }), method: "POST", body: "{}", graphql: true }), /not authorized/);
});

test("ctx.http when the context has it (the plugin's allowed hosts apply), else the global fetch", async () => {
	const seen = [];
	const ctx = { http: { fetch: async (url) => (seen.push(url), json({ success: true, result: 1 })) } };
	await cloudflareApi("/accounts", { token: TOKEN, fetch: contextFetch(ctx) });
	assert.deepEqual(seen, [`${CLOUDFLARE_API}/accounts`]);
	assert.equal(typeof contextFetch(null), "function");
	assert.equal(typeof contextFetch({}), "function");
});

test("no module builds its own Cloudflare API envelope: only the shared client and Stream's two non-JSON calls name /client/v4", () => {
	const src = new URL("../src/", import.meta.url);
	const files = readdirSync(src, { recursive: true }).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
	const offenders = files.filter((f) => {
		const text = readFileSync(new URL(f, src), "utf8");
		return /client\/v4/.test(text.replace(/^\s*(\/\*\*?|\*|\/\/).*$/gm, "")) && !["core/cloudflare-api.ts"].includes(f.replaceAll("\\", "/"));
	});
	assert.deepEqual(offenders, []);
	const stream = readFileSync(new URL("videos/stream.ts", src), "utf8");
	assert.match(stream, /const API = CLOUDFLARE_API;/);
	assert.equal((stream.match(/await fetch\(/g) ?? []).length, 2, "Stream's tus upload and captions download, which aren't JSON envelopes");
});

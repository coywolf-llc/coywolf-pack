// Run: node --test test/admin-api.test.mjs
//
// The admin pages' shared request helpers (src/admin/api.ts): the same requests the
// per-page copies made, and the same error messages.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import "./ts-resolve.mjs";

const { apiGet, apiPost, errorText, postJson } = await import("../src/admin/api.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Records each request and answers with `reply` (an EmDash API envelope). */
function recordFetch(reply = { data: { ok: true } }, status = 200) {
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		const headers = new Headers(init.headers);
		calls.push({ url: String(url), method: init.method ?? "GET", contentType: headers.get("Content-Type"), body: init.body, signal: init.signal });
		return new Response(JSON.stringify(reply), { status, headers: { "Content-Type": "application/json" } });
	};
	return calls;
}

test("errorText: the error's message, else the fallback", () => {
	assert.equal(errorText(new Error("Nope"), "Couldn't save"), "Nope");
	assert.equal(errorText(new Error(""), "Couldn't save"), "Couldn't save");
	assert.equal(errorText("a string", "Couldn't save"), "Couldn't save");
});

test("post: JSON body with its content type; no body (and no content type) when there's none", async () => {
	const calls = recordFetch();
	const post = apiPost("/_emdash/api/plugins/coywolf-pack/backups");
	assert.deepEqual(await post("run", { a: 1 }), { ok: true });
	await post("now");
	assert.equal(calls[0].url, "/_emdash/api/plugins/coywolf-pack/backups/run");
	assert.equal(calls[0].method, "POST");
	assert.equal(calls[0].contentType, "application/json");
	assert.equal(calls[0].body, '{"a":1}');
	assert.equal(calls[1].body, undefined);
	assert.equal(calls[1].contentType, null);
});

test("post: a default body for pages whose routes expect a JSON object", async () => {
	const calls = recordFetch();
	await apiPost("/x", { body: {} })("status");
	assert.equal(calls[0].body, "{}");
	assert.equal(calls[0].contentType, "application/json");
});

test("errors: the route's message, else the call's fallback, else the page's, else \"The request failed\"", async () => {
	recordFetch({ error: { code: "BAD", message: "The source is taken" } }, 400);
	await assert.rejects(apiPost("/x")("save", {}), /The source is taken/);

	recordFetch({}, 500);
	await assert.rejects(apiPost("/x")("save", {}), /The request failed/);
	await assert.rejects(apiPost("/x", { fallback: "Something went wrong" })("save", {}), /Something went wrong/);
	await assert.rejects(apiPost("/x", { fallback: "Something went wrong" })("save", {}, "Couldn't save"), /Couldn't save/);
	await assert.rejects(apiGet("/x")("list", "Couldn't load"), /Couldn't load/);
});

test("an abort signal reaches fetch", async () => {
	const calls = recordFetch();
	const controller = new AbortController();
	await postJson("/x/upload", { part: 1 }, { signal: controller.signal });
	assert.equal(calls[0].signal, controller.signal);
});

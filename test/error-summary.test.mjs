// Run: node --import ./test/ts-resolve.mjs --test test/error-summary.test.mjs
//
// errorSummary (src/core/error-summary.ts): a caught error's text for a log line. Workers Logs shows D1's errors
// ("D1_ERROR: …") by their stack alone, without the message, so the pack's error logs pass this text too.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { errorSummary } = await import("../src/core/error-summary.ts");

test("an error: its name and message; a cause that isn't in the message is added", () => {
	assert.equal(errorSummary(new Error("D1_ERROR: internal error", { cause: new Error("internal error") })), "Error: D1_ERROR: internal error");
	assert.equal(errorSummary(new Error("query failed", { cause: new Error("D1_ERROR: Network connection lost.") })), "Error: query failed (cause: Error: D1_ERROR: Network connection lost.)");
	assert.equal(errorSummary(new TypeError("x is not a function")), "TypeError: x is not a function");
	assert.equal(errorSummary(new Error("failed", { cause: "a string cause" })), "Error: failed (cause: a string cause)");
});

test("an error without a message: its name; anything else thrown: as text (objects as JSON)", () => {
	const nameless = new Error("");
	nameless.name = "D1Error";
	assert.equal(errorSummary(nameless), "D1Error");
	assert.equal(errorSummary("boom"), "boom");
	assert.equal(errorSummary(undefined), "undefined");
	assert.equal(errorSummary({ code: 7, message: "nope" }), '{"code":7,"message":"nope"}');
	const cyclic = {};
	cyclic.self = cyclic;
	assert.equal(errorSummary(cyclic), "[object Object]");
});

test("deeper causes (D1's own error is often a cause's cause), object causes, error-like objects and AggregateErrors", () => {
	const deep = new Error("render failed", { cause: new Error("query failed", { cause: new Error("D1_ERROR: internal error") }) });
	assert.equal(errorSummary(deep), "Error: render failed (cause: Error: query failed (cause: Error: D1_ERROR: internal error))");
	assert.equal(errorSummary(new Error("failed", { cause: { code: "SQLITE_BUSY" } })), 'Error: failed (cause: {"code":"SQLITE_BUSY"})');
	assert.equal(errorSummary({ name: "Error", message: "from another realm" }), "Error: from another realm");
	assert.equal(errorSummary(new AggregateError([new Error("a"), "b"], "")), "AggregateError [Error: a; b]");
	assert.equal(errorSummary(new AggregateError([1, 2, 3, 4], "all failed")), "AggregateError: all failed [1; 2; 3; …]");
});

test("never throws, whatever was thrown (it runs inside catch handlers)", () => {
	assert.equal(errorSummary(new Error("x", { cause: Object.create(null) })), "Error: x (cause: {})");
	const symbolMessage = new Error("x");
	symbolMessage.message = Symbol("odd");
	assert.equal(errorSummary(symbolMessage), "Error: Symbol(odd)");
	const nullProtoMessage = new Error("x");
	nullProtoMessage.message = Object.create(null);
	assert.equal(errorSummary(nullProtoMessage), "Error: {}");
	const getter = new Error("x");
	Object.defineProperty(getter, "cause", {
		get() {
			throw new Error("no");
		},
	});
	assert.equal(errorSummary(getter), "(no error text)");
	assert.equal(errorSummary(Object.create(null)), "{}");
	assert.equal(errorSummary(Symbol("s")), "Symbol(s)");
});

test("at most 1,000 characters", () => {
	assert.equal(errorSummary(new Error("x".repeat(5000))).length, 1000);
	assert.equal(errorSummary("y".repeat(5000)).length, 1000);
});

test("a pack log line passes the error's text before the error (Workers Logs drops D1's message)", async (t) => {
	const { noteRedirectsChanged } = await import("../src/redirects/middleware.ts");
	const errors = t.mock.method(console, "error", () => {});
	const failure = new Error("D1_ERROR: Internal error in D1 DB storage caused object to be reset.");
	const db = { prepare: () => ({ bind: () => ({ run: async () => Promise.reject(failure) }) }) };
	await noteRedirectsChanged(db);
	assert.equal(errors.mock.callCount(), 1);
	const [what, text, error] = errors.mock.calls[0].arguments;
	assert.match(what, /could not record the redirects version/);
	assert.equal(text, "Error: D1_ERROR: Internal error in D1 DB storage caused object to be reset.");
	assert.equal(error, failure, "the error itself still follows, for its stack");
});

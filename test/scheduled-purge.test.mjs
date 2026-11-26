// Run: node --test test/scheduled-purge.test.mjs
//
// Page cache purges during the Worker's scheduled run (src/core/scheduled-purge.ts,
// src/pageCache/lib.ts purgeOutcome, src/worker.ts stripTrackingParams). A Workers Cache
// purge made from the scheduled handler reports success and clears nothing (tested on a
// throwaway Worker on 2026-11-25), so during a scheduled run the pack calls the Worker's own
// default entrypoint by RPC (ctx.exports.default[PURGE_METHOD](scope); the wrapper is a
// WorkerEntrypoint class) and that purges. Not a fetch call with ctx.props: on a Worker with
// placement (all eight sites) the fetch runs in the placed location without its props
// (2026-11-25). Requests purge directly, as before.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import "./ts-resolve.mjs";

// cloudflare:workers: cache.purge records each call (and whether it ran inside the default entrypoint's RPC method), and
// can be absent (globalThis.__noCache); `exports` stands in for the module's loopback export (globalThis.__moduleExports);
// WorkerEntrypoint keeps ctx and env, as the runtime's does.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = () => {};
export const cache = { get purge() { return globalThis.__noCache ? undefined : async (o) => { globalThis.__purges.push({ scope: o, inEntrypoint: globalThis.__inEntrypoint > 0 }); return { success: globalThis.__purgeOk !== false }; }; } };
export const exports = new Proxy({}, { get: (_, k) => globalThis.__moduleExports?.[k] });
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

const { PURGE_METHOD, installScheduledRuns, isPurgeScope, purgeThroughEntrypoint, scheduledRun, warnOutsideScheduledRun } = await import("../src/core/scheduled-purge.ts");
const { purgeOutcome, purgePageCache } = await import("../src/pageCache/lib.ts");
const { stripTrackingParams } = await import("../src/worker.ts");
const { purgeEntryPages } = await import("../src/pageCache/entries.ts");
const { configureContentUrls } = await import("../src/core/content-url.ts");
const { composeHooks } = await import("../src/core/compose.ts");

function reset() {
	globalThis.__purges = [];
	globalThis.__purgeOk = true;
	globalThis.__noCache = false;
	globalThis.__inEntrypoint = 0;
	globalThis.__moduleExports = undefined;
}
reset();

/** The wrapped Worker (a WorkerEntrypoint class) as the runtime uses it: an instance per invocation, with its ctx and env. */
const invoke = (Worker) => ({
	fetch: (request, env = {}, ctx = {}) => new Worker(ctx, env).fetch(request),
	scheduled: (controller, env = {}, ctx = {}) => new Worker(ctx, env).scheduled(controller),
});

/**
 * A site Worker wrapped like the sites' src/worker.ts, whose scheduled() runs `work(ctx)`, and a ctx whose
 * exports.default is the loopback binding: its PURGE_METHOD calls the wrapped Worker's (what ctx.exports does by RPC).
 */
function site(work, { respond } = {}) {
	const loopbacks = [];
	const pages = [];
	const handler = {
		async fetch(request) {
			pages.push(`${request.method} ${request.url}`);
			return new Response("page");
		},
		async scheduled(_controller, _env, ctx) {
			return work(ctx);
		},
	};
	const Worker = stripTrackingParams(handler);
	const wrapped = invoke(Worker);
	const binding = {
		async [PURGE_METHOD](scope) {
			// An RPC stub's method is called on the stub.
			assert.equal(this, binding, "called as a method of the binding");
			loopbacks.push({ scope });
			if (respond) return respond(scope);
			globalThis.__inEntrypoint++;
			try {
				return await new Worker({ props: {} }, {})[PURGE_METHOD](scope);
			} finally {
				globalThis.__inEntrypoint--;
			}
		},
	};
	const waits = [];
	const ctx = { exports: { default: binding }, waitUntil: (p) => waits.push(p) };
	return { Worker, wrapped, ctx, loopbacks, pages, waits };
}

test("outside a scheduled run: purgeOutcome purges directly with the scope as given, as before", async () => {
	reset();
	assert.equal(scheduledRun(), undefined);
	assert.equal(await purgeOutcome({ tags: ["a"] }), "purged");
	assert.equal(await purgePageCache({ pathPrefixes: ["/p"], tags: ["b"] }), true);
	assert.deepEqual(globalThis.__purges, [
		{ scope: { tags: ["a"] }, inEntrypoint: false },
		{ scope: { pathPrefixes: ["/p"], tags: ["b"] }, inEntrypoint: false },
	]);
	globalThis.__purgeOk = false;
	assert.equal(await purgeOutcome(), "refused");
	assert.deepEqual(globalThis.__purges.at(-1).scope, { purgeEverything: true });
	globalThis.__noCache = true;
	assert.equal(await purgeOutcome({ tags: ["a"] }), "unavailable");
});

test("during a scheduled run: the purge goes to the Worker's own default entrypoint by RPC, once, with the exact scope", async () => {
	reset();
	const scope = { pathPrefixes: ["/ladybird-alpha/"], tags: ["01M88AKJRT33R5CNPS2GPYB2N8"] };
	const outcomes = [];
	const { wrapped, ctx, loopbacks, pages } = site(async () => outcomes.push(await purgeOutcome(scope)));
	await wrapped.scheduled({ cron: "0 * * * *" }, {}, ctx);
	assert.deepEqual(outcomes, ["purged"]);
	assert.equal(loopbacks.length, 1, "one call, no recursion");
	assert.deepEqual(loopbacks[0], { scope });
	assert.deepEqual(globalThis.__purges, [{ scope, inEntrypoint: true }], "purged by the default entrypoint, never directly");
	assert.deepEqual(pages, [], "the site's own fetch never sees the call");
	// Clearing everything goes the same way.
	const everything = site(async () => outcomes.push(await purgeOutcome()));
	await everything.wrapped.scheduled({}, {}, everything.ctx);
	assert.deepEqual(outcomes, ["purged", "purged"]);
	assert.deepEqual(everything.loopbacks, [{ scope: { purgeEverything: true } }]);
	assert.deepEqual(globalThis.__purges.at(-1), { scope: { purgeEverything: true }, inEntrypoint: true });
});

test("the cloudflare:workers exports stand in when ctx has none", async () => {
	reset();
	const { wrapped, ctx, loopbacks } = site(async () => assert.equal(await purgeOutcome({ tags: ["t"] }), "purged"));
	globalThis.__moduleExports = { default: ctx.exports.default };
	await wrapped.scheduled({}, {}, { waitUntil() {} });
	assert.equal(loopbacks.length, 1);
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["t"] }, inEntrypoint: true }]);
});

test("the default entrypoint's own outcome comes back as it is (a refused purge stays refused, nothing is tried directly)", async () => {
	reset();
	globalThis.__purgeOk = false;
	const { wrapped, ctx } = site(async () => assert.equal(await purgeOutcome({ tags: ["t"] }), "refused"));
	await wrapped.scheduled({}, {}, ctx);
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["t"] }, inEntrypoint: true }]);
	const unavailable = site(async () => assert.equal(await purgeOutcome({ tags: ["t"] }), "unavailable"), { respond: async () => "unavailable" });
	await unavailable.wrapped.scheduled({}, {}, unavailable.ctx);
});

test("a scheduled run on a Worker without Workers Cache makes no call", async () => {
	reset();
	globalThis.__noCache = true;
	const { wrapped, ctx, loopbacks } = site(async () => assert.equal(await purgeOutcome({ tags: ["t"] }), "unavailable"));
	await wrapped.scheduled({}, {}, ctx);
	assert.equal(loopbacks.length, 0);
});

test("a call that can't be made, fails or answers wrongly is refused (and logged), never purged directly", async (t) => {
	const errors = [];
	t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
	const run = (ctx) => ({ ctx, env: {} });
	const answering = (respond) => ({ exports: { default: { [PURGE_METHOD]: async () => respond() } } });
	const cases = [
		["no ctx.exports and no module exports", { waitUntil() {} }],
		["exports.default isn't a binding", { exports: { default: "SELF" } }],
		["a default export that isn't the pack's class (no such method)", { exports: { default: { fetch: async () => new Response("page") } } }],
		["the call throws", answering(() => { throw new Error("boom"); })],
		["an unknown outcome", answering(() => "done")],
		["no outcome", answering(() => undefined)],
		["not a string", answering(() => ({ outcome: "purged" }))],
	];
	for (const [label, ctx] of cases) {
		reset();
		assert.equal(await purgeThroughEntrypoint(run(ctx), { tags: ["t"] }), "refused", label);
		assert.deepEqual(globalThis.__purges, [], label);
	}
	assert.equal(errors.length, cases.length - 1, "the Worker that can't call itself is said once per isolate (above, the first two cases)");
	assert.match(errors[0], /^coywolf-pack: page cache purges from the scheduled run can't be made: the Worker can't call itself/);
	assert.ok(errors.slice(1).every((e) => e.startsWith("coywolf-pack: page cache purge from the scheduled run failed")));
	assert.ok(errors.some((e) => /is not a function/.test(e)), "a default export without the method says so");
	assert.ok(errors.some((e) => e.includes("the Worker answered \"done\"")), "an unknown answer is logged");
	// No answer in time.
	reset();
	const started = Date.now();
	assert.equal(await purgeThroughEntrypoint(run(answering(() => new Promise(() => {}))), { tags: ["t"] }, 20), "refused");
	assert.ok(Date.now() - started < 1000);
	assert.match(errors.at(-1), /no answer from the Worker in 20 ms/);
});

test("the RPC method purges by the default entrypoint, refuses a scope Workers Cache wouldn't take, and never throws", async (t) => {
	const errors = [];
	t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
	reset();
	const { Worker } = site(async () => {});
	const method = (scope) => new Worker({ props: {} }, {})[PURGE_METHOD](scope);
	assert.equal(await method({ tags: ["t"] }), "purged");
	assert.deepEqual(globalThis.__purges.map((p) => p.scope), [{ tags: ["t"] }]);
	const bad = [null, undefined, "everything", [], {}, { purgeEverything: false }, { purgeEverything: true, tags: ["a"] }, { tags: "x" }, { tags: [1] }, { tags: [""] }, { pathPrefixes: ["no-slash"] }, { tags: ["a"], extra: 1 }, { tags: [], pathPrefixes: [] }];
	for (const scope of bad) assert.equal(await method(scope), "refused", JSON.stringify(scope));
	assert.equal(globalThis.__purges.length, 1, "nothing else purged");
	assert.equal(errors.length, bad.length, "each refusal is logged");
	for (const scope of [{ purgeEverything: true }, { tags: ["a"] }, { pathPrefixes: ["/a"] }, { pathPrefixes: ["/a"], tags: ["b"] }, { pathPrefixes: [], tags: ["a"] }]) assert.ok(isPurgeScope(scope), JSON.stringify(scope));
	// A purge that throws comes back refused.
	globalThis.__purgeOk = false;
	assert.equal(await method({ tags: ["t"] }), "refused");
	globalThis.__noCache = true;
	assert.equal(await method({ tags: ["t"] }), "unavailable");
});

test("no request purges: the props 0.51.1 sent, from anywhere, are the site's request like any other", async () => {
	reset();
	const { wrapped, pages } = site(async () => {});
	const post = () => new Request("https://coywolf-pack.internal/page-cache/purge", { method: "POST" });
	for (const ctx of [{ props: { "coywolf-pack:purge": { tags: ["t"] } } }, { props: {} }, {}, undefined]) {
		const response = await wrapped.fetch(post(), {}, ctx);
		assert.equal(await response.text(), "page");
	}
	assert.equal(pages.length, 4);
	assert.deepEqual(globalThis.__purges, []);
});

test("scheduled(): the site's handler gets the same arguments and this, its result comes back, and the run is known only inside it", async () => {
	reset();
	const seen = [];
	const handler = {
		name: "site",
		fetch: async () => new Response("page"),
		scheduled(controller, env, ctx) {
			seen.push({ self: this, controller, env, ctx, run: scheduledRun() });
			return "done";
		},
	};
	const wrapped = invoke(stripTrackingParams(handler));
	const controller = { cron: "0 * * * *" };
	const env = { DB: {} };
	const ctx = { waitUntil() {} };
	assert.equal(wrapped.scheduled(controller, env, ctx), "done", "a synchronous handler's value");
	assert.equal(seen[0].self, handler);
	assert.equal(seen[0].controller, controller);
	assert.equal(seen[0].env, env);
	assert.equal(seen[0].ctx, ctx);
	assert.deepEqual(seen[0].run, { ctx, env });
	assert.equal(seen[0].run.ctx, ctx);
	assert.equal(scheduledRun(), undefined, "not outside the run");
	// An async handler's promise comes back, so the runtime waits for it.
	const later = invoke(stripTrackingParams({ fetch: handler.fetch, scheduled: async () => (await Promise.resolve(), "later") }));
	const result = later.scheduled({}, {}, ctx);
	assert.ok(result instanceof Promise);
	assert.equal(await result, "later");
	// A handler without scheduled() gets none.
	assert.equal("scheduled" in stripTrackingParams({ fetch: handler.fetch }).prototype, false);
});

test("the run reaches work EmDash starts with ctx.waitUntil, timers and hook timeouts, and doesn't leak into requests", async () => {
	reset();
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	let seen;
	const { wrapped, ctx, waits, loopbacks } = site((runCtx) => {
		// EmDash's createScheduledHandler: ctx.waitUntil((async () => { await import(…); await runScheduledTasks(…) })()).
		runCtx.waitUntil(
			(async () => {
				await import("node:path");
				await new Promise((resolve) => setTimeout(resolve, 5));
				await gate;
				// A plugin hook under EmDash's timeout race.
				seen = await Promise.race([Promise.resolve().then(() => scheduledRun()), new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000))]);
				assert.equal(await purgeOutcome({ tags: ["cron"] }), "purged");
			})(),
		);
	});
	wrapped.scheduled({}, {}, ctx);
	assert.equal(waits.length, 1);
	// While the scheduled run waits, a request in the same isolate purges directly.
	const request = invoke(
		stripTrackingParams({
			fetch: async () => {
				assert.equal(scheduledRun(), undefined);
				assert.equal(await purgeOutcome({ tags: ["request"] }), "purged");
				return new Response("ok");
			},
		}),
	);
	await request.fetch(new Request("https://example.com/_emdash/api/content/posts", { method: "POST" }), {}, { props: {} });
	release();
	await Promise.all(waits);
	assert.equal(seen?.ctx, ctx);
	assert.deepEqual(globalThis.__purges, [
		{ scope: { tags: ["request"] }, inEntrypoint: false },
		{ scope: { tags: ["cron"] }, inEntrypoint: true },
	]);
	assert.equal(loopbacks.length, 1);
});

test("the wrapper is a WorkerEntrypoint class: the handler's event handlers and the purge method on its prototype, nothing else", async () => {
	const { WorkerEntrypoint } = await import("cloudflare:workers");
	const seen = [];
	const handler = {
		marker: "not carried",
		helper: () => "not callable by RPC",
		fetch: async () => new Response("page"),
		scheduled() {},
		queue(batch, env, ctx) {
			seen.push({ self: this, batch, env, ctx });
			return "queued";
		},
	};
	const Worker = stripTrackingParams(handler);
	assert.ok(Worker.prototype instanceof WorkerEntrypoint, "a class the runtime takes as an entrypoint");
	assert.deepEqual(Object.getOwnPropertyNames(Worker.prototype).sort(), ["constructor", "fetch", PURGE_METHOD, "queue", "scheduled"].sort());
	for (const name of ["scheduled", "queue"]) assert.equal(Object.getOwnPropertyDescriptor(Worker.prototype, name).enumerable, false, `${name} is defined like a class method`);
	const ctx = { waitUntil() {} };
	const env = { DB: {} };
	const worker = new Worker(ctx, env);
	assert.deepEqual(Object.keys(worker).sort(), ["ctx", "env"], "no methods on the instance (RPC takes prototype methods only)");
	assert.equal(worker.marker, undefined);
	assert.equal(worker.helper, undefined);
	const batch = { messages: [] };
	assert.equal(worker.queue(batch), "queued");
	assert.deepEqual(seen, [{ self: handler, batch, env, ctx }], "called as the object export would be: (event, env, ctx), with the handler as this");
	// Only the handlers it has.
	assert.deepEqual(Object.getOwnPropertyNames(stripTrackingParams({ fetch: handler.fetch }).prototype).sort(), ["constructor", "fetch", PURGE_METHOD].sort());
});

test("every wrapper in the isolate shares one store", () => {
	const first = installScheduledRuns(() => {
		throw new Error("a second store");
	});
	stripTrackingParams({ fetch: async () => new Response("") });
	assert.equal(installScheduledRuns(() => ({ run: () => {}, getStore: () => undefined })), first);
});

test("an entry's pages (glossary.io keepDates, Social Images) purged from a scheduled run go through the default entrypoint, with the entry's paths and id", async () => {
	configureContentUrls({ urls: { posts: "/{slug}/" }, trailingSlash: "always" });
	const ctx = { site: { url: "https://coywolf.com", trailingSlash: "always" }, log: { warn() {} } };
	const entry = [{ collection: "posts", id: "01M88AKJRT33R5CNPS2GPYB2N8", slug: "ladybird-alpha" }];
	const scope = { pathPrefixes: ["/ladybird-alpha/"], tags: ["01M88AKJRT33R5CNPS2GPYB2N8"] };
	try {
		// From a request: directly, as before.
		reset();
		await purgeEntryPages(ctx, entry, { label: "test", tags: true });
		assert.deepEqual(globalThis.__purges, [{ scope, inEntrypoint: false }]);
		// From the scheduled run (the November 25, 2026 incident's path): through the default entrypoint, by RPC.
		reset();
		const { wrapped, ctx: runCtx, loopbacks } = site(async () => purgeEntryPages(ctx, entry, { label: "test", tags: true }));
		await wrapped.scheduled({}, {}, runCtx);
		assert.deepEqual(loopbacks, [{ scope }]);
		assert.deepEqual(globalThis.__purges, [{ scope, inEntrypoint: true }]);
	} finally {
		configureContentUrls({});
	}
});

test("a pack scheduled task (the cron hook) outside a scheduled run on a Worker with Workers Cache is reported once", async (t) => {
	reset();
	const warnings = [];
	t.mock.method(console, "warn", (message) => warnings.push(message));
	const { hooks } = composeHooks([], { tasks: [] });
	const fire = () => hooks.cron.handler({ name: "no-such-task" }, {});
	const storage = installScheduledRuns(() => {
		throw new Error("installed above");
	});
	await storage.run({ ctx: {}, env: {} }, fire);
	assert.deepEqual(warnings, [], "inside a run: nothing to say");
	globalThis.__noCache = true;
	await fire();
	assert.deepEqual(warnings, [], "no Workers Cache: nothing to purge");
	globalThis.__noCache = false;
	await fire();
	await fire();
	await warnOutsideScheduledRun(false);
	assert.equal(warnings.length, 1, "once per isolate");
	assert.match(warnings[0], /scheduled task ran outside the Worker's scheduled run .*may clear nothing/, "this file's Worker is wrapped");
});

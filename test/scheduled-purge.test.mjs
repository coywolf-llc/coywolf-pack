// Run: node --test test/scheduled-purge.test.mjs
//
// Page cache purges during the Worker's scheduled run (src/core/scheduled-purge.ts,
// src/pageCache/lib.ts purgeOutcome, src/worker.ts stripTrackingParams). A Workers Cache
// purge made from the scheduled handler reports success and clears nothing (tested on a
// throwaway Worker on 2026-11-25), so during a scheduled run the pack sends the purge to
// the Worker's own fetch (ctx.exports.default with the scope in ctx.props) and the
// wrapper purges there. Requests purge directly, as before.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import "./ts-resolve.mjs";

// cloudflare:workers: cache.purge records each call (and whether it ran inside the Worker's own fetch), and can be
// absent (globalThis.__noCache); `exports` stands in for the module's loopback export (globalThis.__moduleExports).
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = () => {};
export const cache = { get purge() { return globalThis.__noCache ? undefined : async (o) => { globalThis.__purges.push({ scope: o, inFetch: globalThis.__inFetch > 0 }); return { success: globalThis.__purgeOk !== false }; }; } };
export const exports = new Proxy({}, { get: (_, k) => globalThis.__moduleExports?.[k] });`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

const { PURGE_PROP, PURGE_URL, installScheduledRuns, isPurgeScope, purgeThroughFetch, scheduledRun, warnOutsideScheduledRun } = await import("../src/core/scheduled-purge.ts");
const { purgeOutcome, purgePageCache } = await import("../src/pageCache/lib.ts");
const { stripTrackingParams } = await import("../src/worker.ts");
const { purgeEntryPages } = await import("../src/pageCache/entries.ts");
const { configureContentUrls } = await import("../src/core/content-url.ts");
const { composeHooks } = await import("../src/core/compose.ts");

function reset() {
	globalThis.__purges = [];
	globalThis.__purgeOk = true;
	globalThis.__noCache = false;
	globalThis.__inFetch = 0;
	globalThis.__moduleExports = undefined;
}
reset();

/**
 * A site Worker wrapped like the sites' src/worker.ts, whose scheduled() runs `work(ctx)`, and a ctx whose
 * exports.default calls the wrapped Worker's fetch with the props it's given (what ctx.exports does).
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
	const wrapped = stripTrackingParams(handler);
	const ownDefault = (options) => ({
		fetch: async (request) => {
			loopbacks.push({ props: options.props, method: request.method, url: request.url });
			if (respond) return respond(request, options);
			globalThis.__inFetch++;
			try {
				return await wrapped.fetch(request, {}, { props: options.props });
			} finally {
				globalThis.__inFetch--;
			}
		},
	});
	const ctx = { exports: { default: ownDefault }, waitUntil: (p) => waits.push(p) };
	const waits = [];
	return { wrapped, ctx, loopbacks, pages, waits };
}

test("outside a scheduled run: purgeOutcome purges directly with the scope as given, as before", async () => {
	reset();
	assert.equal(scheduledRun(), undefined);
	assert.equal(await purgeOutcome({ tags: ["a"] }), "purged");
	assert.equal(await purgePageCache({ pathPrefixes: ["/p"], tags: ["b"] }), true);
	assert.deepEqual(globalThis.__purges, [
		{ scope: { tags: ["a"] }, inFetch: false },
		{ scope: { pathPrefixes: ["/p"], tags: ["b"] }, inFetch: false },
	]);
	globalThis.__purgeOk = false;
	assert.equal(await purgeOutcome(), "refused");
	assert.deepEqual(globalThis.__purges.at(-1).scope, { purgeEverything: true });
	globalThis.__noCache = true;
	assert.equal(await purgeOutcome({ tags: ["a"] }), "unavailable");
});

test("during a scheduled run: the purge goes to the Worker's own fetch, once, with the exact scope in ctx.props", async () => {
	reset();
	const scope = { pathPrefixes: ["/ladybird-alpha/"], tags: ["01M88AKJRT33R5CNPS2GPYB2N8"] };
	const outcomes = [];
	const { wrapped, ctx, loopbacks, pages } = site(async () => outcomes.push(await purgeOutcome(scope)));
	await wrapped.scheduled({ cron: "0 * * * *" }, {}, ctx);
	assert.deepEqual(outcomes, ["purged"]);
	assert.equal(loopbacks.length, 1, "one call, no recursion");
	assert.deepEqual(loopbacks[0], { props: { [PURGE_PROP]: scope }, method: "POST", url: PURGE_URL });
	assert.deepEqual(globalThis.__purges, [{ scope, inFetch: true }], "purged inside the Worker's fetch, never directly");
	assert.deepEqual(pages, [], "the site's own fetch never sees the call");
	// Clearing everything goes the same way.
	const everything = site(async () => outcomes.push(await purgeOutcome()));
	await everything.wrapped.scheduled({}, {}, everything.ctx);
	assert.deepEqual(outcomes, ["purged", "purged"]);
	assert.deepEqual(everything.loopbacks.map((l) => l.props), [{ [PURGE_PROP]: { purgeEverything: true } }]);
	assert.deepEqual(globalThis.__purges.at(-1), { scope: { purgeEverything: true }, inFetch: true });
});

test("the cloudflare:workers exports stand in when ctx has none", async () => {
	reset();
	const { wrapped, ctx, loopbacks } = site(async () => assert.equal(await purgeOutcome({ tags: ["t"] }), "purged"));
	globalThis.__moduleExports = { default: ctx.exports.default };
	await wrapped.scheduled({}, {}, { waitUntil() {} });
	assert.equal(loopbacks.length, 1);
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["t"] }, inFetch: true }]);
});

test("the fetch side's own outcome comes back as it is (a refused purge stays refused, nothing is tried directly)", async () => {
	reset();
	globalThis.__purgeOk = false;
	const { wrapped, ctx } = site(async () => assert.equal(await purgeOutcome({ tags: ["t"] }), "refused"));
	await wrapped.scheduled({}, {}, ctx);
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["t"] }, inFetch: true }]);
	const unavailable = site(async () => assert.equal(await purgeOutcome({ tags: ["t"] }), "unavailable"), {
		respond: () => Response.json({ outcome: "unavailable" }),
	});
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
	const answering = (respond) => ({ exports: { default: () => ({ fetch: async () => respond() }) } });
	const cases = [
		["no ctx.exports and no module exports", { waitUntil() {} }],
		["exports.default isn't callable (a service binding, SELF)", { exports: { default: { fetch: async () => Response.json({ outcome: "purged" }) } } }],
		["the call throws", answering(() => { throw new Error("boom"); })],
		["a server error", answering(() => new Response("oops", { status: 500 }))],
		["not JSON", answering(() => new Response("<html>"))],
		["an unknown outcome", answering(() => Response.json({ outcome: "done" }))],
		["no outcome", answering(() => Response.json(null))],
	];
	for (const [label, ctx] of cases) {
		reset();
		assert.equal(await purgeThroughFetch(run(ctx), { tags: ["t"] }), "refused", label);
		assert.deepEqual(globalThis.__purges, [], label);
	}
	assert.equal(errors.length, cases.length - 1, "the Worker that can't call itself is said once per isolate (above, the first two cases)");
	assert.match(errors[0], /^coywolf-pack: page cache purges from the scheduled run can't be made: the Worker can't call itself/);
	assert.ok(errors.slice(1).every((e) => e.startsWith("coywolf-pack: page cache purge from the scheduled run failed")));
	assert.ok(errors.some((e) => e.includes("the Worker answered 500 oops")), "the Worker's own reason is logged");
	// No answer in time.
	reset();
	const started = Date.now();
	assert.equal(await purgeThroughFetch(run(answering(() => new Promise(() => {}))), { tags: ["t"] }, 20), "refused");
	assert.ok(Date.now() - started < 1000);
	assert.match(errors.at(-1), /no answer from the Worker in 20 ms/);
});

test("the wrapper answers only the pack's own call: ctx.props with the pack's key", async () => {
	reset();
	const { wrapped, pages } = site(async () => {});
	const post = () => new Request(PURGE_URL, { method: "POST" });
	const answer = await wrapped.fetch(post(), {}, { props: { [PURGE_PROP]: { tags: ["t"] } } });
	assert.equal(answer.status, 200);
	assert.deepEqual(await answer.json(), { outcome: "purged" });
	assert.equal(answer.headers.get("Cache-Control"), "no-store");
	assert.deepEqual(globalThis.__purges.map((p) => p.scope), [{ tags: ["t"] }]);
	assert.deepEqual(pages, []);
	// Anything else is the site's: the same request from the internet (props {}), no props at all, other props.
	for (const ctx of [{ props: {} }, {}, undefined, { props: { other: { tags: ["t"] } } }]) {
		const response = await wrapped.fetch(post(), {}, ctx);
		assert.equal(await response.text(), "page");
	}
	assert.equal(pages.length, 4);
	assert.equal(globalThis.__purges.length, 1, "nothing else purged");
	// The pack's key on something other than a POST: not purged.
	const get = await wrapped.fetch(new Request(PURGE_URL), {}, { props: { [PURGE_PROP]: { tags: ["t"] } } });
	assert.equal(get.status, 405);
	assert.equal(globalThis.__purges.length, 1);
});

test("the wrapper refuses a scope Workers Cache wouldn't take", async () => {
	reset();
	const { wrapped } = site(async () => {});
	const bad = [null, "everything", [], {}, { purgeEverything: false }, { purgeEverything: true, tags: ["a"] }, { tags: "x" }, { tags: [1] }, { tags: [""] }, { pathPrefixes: ["no-slash"] }, { tags: ["a"], extra: 1 }, { tags: [], pathPrefixes: [] }];
	for (const scope of bad) {
		const response = await wrapped.fetch(new Request(PURGE_URL, { method: "POST" }), {}, { props: { [PURGE_PROP]: scope } });
		assert.equal(response.status, 400, JSON.stringify(scope));
		assert.equal((await response.json()).outcome, "refused");
	}
	assert.deepEqual(globalThis.__purges, []);
	for (const scope of [{ purgeEverything: true }, { tags: ["a"] }, { pathPrefixes: ["/a"] }, { pathPrefixes: ["/a"], tags: ["b"] }, { pathPrefixes: [], tags: ["a"] }]) assert.ok(isPurgeScope(scope), JSON.stringify(scope));
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
	const wrapped = stripTrackingParams(handler);
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
	const later = stripTrackingParams({ fetch: handler.fetch, scheduled: async () => (await Promise.resolve(), "later") });
	const result = later.scheduled({}, {}, ctx);
	assert.ok(result instanceof Promise);
	assert.equal(await result, "later");
	// A handler without scheduled() gets none.
	assert.equal("scheduled" in stripTrackingParams({ fetch: handler.fetch }), false);
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
	const request = stripTrackingParams({
		fetch: async () => {
			assert.equal(scheduledRun(), undefined);
			assert.equal(await purgeOutcome({ tags: ["request"] }), "purged");
			return new Response("ok");
		},
	});
	await request.fetch(new Request("https://example.com/_emdash/api/content/posts", { method: "POST" }), {}, { props: {} });
	release();
	await Promise.all(waits);
	assert.equal(seen?.ctx, ctx);
	assert.deepEqual(globalThis.__purges, [
		{ scope: { tags: ["request"] }, inFetch: false },
		{ scope: { tags: ["cron"] }, inFetch: true },
	]);
	assert.equal(loopbacks.length, 1);
});

test("every wrapper in the isolate shares one store", () => {
	const first = installScheduledRuns(() => {
		throw new Error("a second store");
	});
	stripTrackingParams({ fetch: async () => new Response("") });
	assert.equal(installScheduledRuns(() => ({ run: () => {}, getStore: () => undefined })), first);
});

test("an entry's pages (glossary.io keepDates, Social Images) purged from a scheduled run go through the Worker's fetch, with the entry's paths and id", async () => {
	configureContentUrls({ urls: { posts: "/{slug}/" }, trailingSlash: "always" });
	const ctx = { site: { url: "https://coywolf.com", trailingSlash: "always" }, log: { warn() {} } };
	const entry = [{ collection: "posts", id: "01M88AKJRT33R5CNPS2GPYB2N8", slug: "ladybird-alpha" }];
	const scope = { pathPrefixes: ["/ladybird-alpha/"], tags: ["01M88AKJRT33R5CNPS2GPYB2N8"] };
	try {
		// From a request: directly, as before.
		reset();
		await purgeEntryPages(ctx, entry, { label: "test", tags: true });
		assert.deepEqual(globalThis.__purges, [{ scope, inFetch: false }]);
		// From the scheduled run (the November 25, 2026 incident's path): through the Worker's own fetch.
		reset();
		const { wrapped, ctx: runCtx, loopbacks } = site(async () => purgeEntryPages(ctx, entry, { label: "test", tags: true }));
		await wrapped.scheduled({}, {}, runCtx);
		assert.deepEqual(loopbacks.map((l) => l.props), [{ [PURGE_PROP]: scope }]);
		assert.deepEqual(globalThis.__purges, [{ scope, inFetch: true }]);
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

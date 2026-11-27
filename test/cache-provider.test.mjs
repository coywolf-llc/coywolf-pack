// Run: node --test test/cache-provider.test.mjs
//
// The pack's Astro cache provider (src/cache-provider.ts, "@coywolf/emdash/cache-provider"): Astro's Cloudflare
// provider (a stand-in with the same invalidate(): test/fixtures/astro-cloudflare-cache-provider.mjs), with
// invalidate() doing nothing when Workers Cache is off, Astro's purge in a request (its result disposed of), and, during the Worker's
// scheduled run (EmDash's scheduled publishing and plugins' scheduled edits), a purge through the Worker's own
// default entrypoint (an RPC call), since Workers Cache ignores purges made in the scheduled run itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

import "./ts-resolve.mjs";

const FIXTURE = new URL("./fixtures/astro-cloudflare-cache-provider.mjs", import.meta.url).href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@astrojs/cloudflare/cache/provider") return { url: FIXTURE, shortCircuit: true };
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = {}; export const waitUntil = () => {};
export const cache = { get purge() { return globalThis.__noCache ? undefined : async function (o) { if (this !== cache) throw new TypeError("Illegal invocation"); if (globalThis.__purgeThrow) throw new Error("purge failed"); globalThis.__purges.push({ scope: o, inEntrypoint: globalThis.__inEntrypoint > 0 }); if (globalThis.__purgeUndefined) return undefined; return { success: globalThis.__purgeOk !== false, errors: globalThis.__purgeOk === false ? [{ message: "rate limited" }] : [], [Symbol.dispose]() { globalThis.__disposed++; } }; }; } };
export const exports = new Proxy({}, { get: (_, k) => globalThis.__moduleExports?.[k] });
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

const { default: coywolfCloudflareCache, batching } = await import("../src/cache-provider.ts");
// Short waits, so the tests don't sit through the real 5 s (with room for a slow CI machine's pauses).
batching.quietMs = 100;
batching.maxWaitMs = 5_000;
const { PURGE_METHOD } = await import("../src/core/scheduled-purge.ts");
const { stripTrackingParams } = await import("../src/worker.ts");

function reset() {
	globalThis.__purges = [];
	globalThis.__purgeOk = true;
	globalThis.__purgeThrow = false;
	globalThis.__disposed = 0;
	globalThis.__purgeUndefined = false;
	globalThis.__noCache = false;
	globalThis.__inEntrypoint = 0;
	globalThis.__moduleExports = undefined;
	globalThis.__astro = { configs: [], invalidates: [], setHeaders: [] };
}
reset();

/**
 * A site Worker wrapped like the sites' src/worker.ts, whose scheduled() runs `work(ctx)`, and a ctx whose
 * exports.default is the loopback binding: its PURGE_METHOD calls the wrapped Worker's (what ctx.exports does by RPC).
 */
function site(work, { respond } = {}) {
	const loopbacks = [];
	const waits = [];
	const Worker = stripTrackingParams({
		fetch: async () => new Response("page"),
		scheduled: async (_controller, _env, ctx) => work(ctx),
	});
	/** The class as the runtime uses it: an instance per invocation. */
	const wrapped = { scheduled: (controller, env = {}, ctx = {}) => new Worker(ctx, env).scheduled(controller) };
	const binding = {
		async [PURGE_METHOD](scope) {
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
	const ctx = { exports: { default: binding }, waitUntil: (p) => waits.push(p) };
	/** Wait for everything the run handed to ctx.waitUntil, including what's handed over meanwhile (the batch's purge). */
	const drain = async () => {
		for (let i = 0; i < waits.length; i++) await waits[i];
	};
	return { wrapped, ctx, loopbacks, waits, drain };
}

test("it's Astro's Cloudflare provider: name, setHeaders and its config are Astro's", () => {
	reset();
	const provider = coywolfCloudflareCache({ some: "config" });
	assert.equal(provider.name, "cloudflare", "Astro's Cloudflare adapter turns Workers Cache on only for a provider named cloudflare");
	assert.deepEqual(globalThis.__astro.configs, [{ some: "config" }]);
	const headers = provider.setHeaders({ maxAge: 60, tags: ["posts"] }, new Request("https://example.com/a/"));
	assert.equal(headers.get("Cache-Tag"), "fixture");
	assert.deepEqual(globalThis.__astro.setHeaders, [{ options: { maxAge: 60, tags: ["posts"] }, url: "https://example.com/a/" }]);
});

test("in a request: the tags Astro's invalidate() would purge, purged directly with its result disposed of; a throwing purge still throws", async () => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	const options = { tags: ["posts", "01X"] };
	await provider.invalidate(options);
	assert.deepEqual(globalThis.__astro.invalidates, [], "Astro's invalidate() isn't called: it never disposes of the purge's result");
	assert.deepEqual(options, { tags: ["posts", "01X"] }, "the options are left untouched");
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["posts", "01X"] }, inEntrypoint: false }]);
	assert.equal(globalThis.__disposed, 1, "the purge's RPC result is disposed of");

	reset();
	await provider.invalidate({ path: "/x" });
	await provider.invalidate({ tags: "one", path: "/y" });
	await provider.invalidate({});
	assert.deepEqual(
		globalThis.__purges.map((p) => p.scope),
		[{ tags: ["astro-path:/x"] }, { tags: ["one", "astro-path:/y"] }],
		"the same tags as Astro's provider (its path tag included); no tags, no purge",
	);
	assert.equal(globalThis.__disposed, 2);

	reset();
	globalThis.__purgeThrow = true;
	await assert.rejects(provider.invalidate({ tags: ["posts"] }), /purge failed/, "a failing purge still throws in a request, as Astro's does");
});

test("in a request: a refused purge is logged and disposed of, not thrown, and the rest isn't sent; over 100 tags go in calls of 100", async (t) => {
	reset();
	const errors = t.mock.method(console, "error", () => {});
	const provider = coywolfCloudflareCache(undefined);
	globalThis.__purgeOk = false;
	await provider.invalidate({ tags: Array.from({ length: 150 }, (_, i) => `r${i}`) });
	assert.equal(globalThis.__purges.length, 1, "after a refusal the second 100 isn't sent: it would only be refused too");
	assert.equal(globalThis.__disposed, 1);
	assert.equal(errors.mock.callCount(), 1);
	assert.match(String(errors.mock.calls[0].arguments[0]), /purge was refused \(150 tags\)/);
	assert.deepEqual(errors.mock.calls[0].arguments[1], [{ message: "rate limited" }]);

	reset();
	const tags = Array.from({ length: 205 }, (_, i) => `t${i}`);
	await provider.invalidate({ tags });
	assert.deepEqual(globalThis.__purges.map((p) => p.scope.tags.length), [100, 100, 5]);
	assert.deepEqual(globalThis.__purges.flatMap((p) => p.scope.tags), tags);
	assert.equal(globalThis.__disposed, 3);
});

test("in a request: a purge that answers nothing is fine; the result is disposed of even when logging the refusal throws", async (t) => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	globalThis.__purgeUndefined = true;
	await provider.invalidate({ tags: ["posts"] });
	assert.equal(globalThis.__purges.length, 1);

	reset();
	t.mock.method(console, "error", () => {
		throw new Error("logging failed");
	});
	globalThis.__purgeOk = false;
	await assert.rejects(provider.invalidate({ tags: ["posts"] }), /logging failed/);
	assert.equal(globalThis.__disposed, 1, "disposed of in a finally");
});

test("Workers Cache off (a staging Worker): nothing is purged and nothing throws, in a request or a scheduled run", async () => {
	reset();
	globalThis.__noCache = true;
	const provider = coywolfCloudflareCache(undefined);
	await provider.invalidate({ tags: ["posts"] });
	const { wrapped, ctx, loopbacks } = site(() => provider.invalidate({ tags: ["posts"] }));
	await wrapped.scheduled({}, {}, ctx);
	assert.deepEqual(globalThis.__purges, []);
	assert.deepEqual(globalThis.__astro.invalidates, []);
	assert.equal(loopbacks.length, 0);
});

test("in a scheduled run: the tags Astro would purge go through the Worker's own default entrypoint, never a direct purge", async () => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	const tags = ["posts", "01X"];
	const { wrapped, ctx, loopbacks, drain } = site(() => provider.invalidate({ tags, path: "/p" }));
	await wrapped.scheduled({}, {}, ctx);
	await drain();
	assert.deepEqual(loopbacks, [{ scope: { tags: ["posts", "01X", "astro-path:/p"] } }]);
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["posts", "01X", "astro-path:/p"] }, inEntrypoint: true }]);
	assert.deepEqual(globalThis.__astro.invalidates, [], "Astro's direct purge, which clears nothing here, isn't made");
	assert.deepEqual(tags, ["posts", "01X"], "the caller's array is left as it was");
});

test("in a scheduled run: no tags, no call; over 100 tags, one call per 100 (duplicates once)", async () => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	const none = site(async () => {
		await provider.invalidate({ tags: [] });
		await provider.invalidate({});
		await provider.invalidate({ tags: [""] });
	});
	await none.wrapped.scheduled({}, {}, none.ctx);
	await none.drain();
	assert.equal(none.waits.length, 0, "nothing to purge: the run isn't held open");
	assert.equal(none.loopbacks.length, 0);

	reset();
	// At 100 tags the batch goes at once, without waiting for quiet.
	const quiet = batching.quietMs;
	batching.quietMs = 5_000;
	const many = ["posts", ...Array.from({ length: 100 }, (_, i) => `id-${i}`), "posts"];
	const big = site(() => provider.invalidate({ tags: many }));
	const started = Date.now();
	try {
		await big.wrapped.scheduled({}, {}, big.ctx);
		await big.drain();
	} finally {
		batching.quietMs = quiet;
	}
	assert.ok(Date.now() - started < 1_000, `purged after ${Date.now() - started} ms`);
	assert.deepEqual(
		big.loopbacks.map((l) => l.scope.tags.length),
		[100, 1],
	);
	assert.deepEqual(big.loopbacks[0].scope.tags.slice(0, 2), ["posts", "id-0"]);
	assert.deepEqual(big.loopbacks[1].scope.tags, ["id-99"]);
});

test("in a scheduled run: a purge that's refused or fails is logged, never thrown", async (t) => {
	t.mock.method(console, "error", () => {});
	const provider = coywolfCloudflareCache(undefined);
	reset();
	globalThis.__purgeOk = false;
	let ran = site(() => provider.invalidate({ tags: ["posts"] }));
	await assert.doesNotReject(ran.wrapped.scheduled({}, {}, ran.ctx));
	await assert.doesNotReject(ran.drain());
	assert.equal(ran.loopbacks.length, 1);

	reset();
	ran = site(() => provider.invalidate({ tags: ["posts"] }), { respond: async () => { throw new Error("oops"); } });
	await assert.doesNotReject(ran.wrapped.scheduled({}, {}, ran.ctx));
	await assert.doesNotReject(ran.drain());
	assert.equal(ran.loopbacks.length, 1);

	reset();
	const held = [];
	ran = site(() => provider.invalidate({ tags: ["posts"] }));
	await assert.doesNotReject(ran.wrapped.scheduled({}, {}, { waitUntil: (p) => held.push(p) }), "no ctx.exports: refused and logged");
	await assert.doesNotReject(Promise.all(held));
	assert.equal(held.length, 1);
	assert.deepEqual(globalThis.__purges, []);
});

test("EmDash's scheduled publishing: the provider it keeps on globalThis purges the published entries' tags through the Worker", async () => {
	reset();
	const KEY = Symbol.for("@emdash-cms/cloudflare:cache-provider");
	const previous = globalThis[KEY];
	globalThis[KEY] = Promise.resolve(coywolfCloudflareCache(undefined));
	try {
		// @emdash-cms/cloudflare's createScheduledHandler and invalidatePublishedTags, as in 1.5.0.
		const published = [
			{ collection: "posts", id: "01A" },
			{ collection: "posts", id: "01B" },
		];
		const { wrapped, ctx, loopbacks, drain } = site((runCtx) => {
			runCtx.waitUntil(
				(async () => {
					await new Promise((resolve) => setTimeout(resolve, 2));
					const provider = await globalThis[KEY];
					const tags = [...new Set(published.flatMap((ref) => [ref.collection, ref.id]))];
					await provider.invalidate({ tags });
				})(),
			);
		});
		wrapped.scheduled({ cron: "0 * * * *" }, {}, ctx);
		await drain();
		assert.deepEqual(loopbacks.map((l) => l.scope), [{ tags: ["posts", "01A", "01B"] }]);
		assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["posts", "01A", "01B"] }, inEntrypoint: true }]);
	} finally {
		globalThis[KEY] = previous;
	}
});

test("in a scheduled run: EmDash's purges are gathered into one (glossary.io's daily run publishes up to 25 entries), and invalidate() doesn't wait for it", async () => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	let loopbacksWhenDone = -1;
	const { wrapped, ctx, loopbacks, drain } = site(async () => {
		// One purge per publish, as EmDash's plugin content actions make them, a few milliseconds apart.
		for (let i = 0; i < 25; i++) {
			await provider.invalidate({ tags: ["terms", `term-${i}`] });
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		loopbacksWhenDone = loopbacks.length;
	});
	await wrapped.scheduled({}, {}, ctx);
	assert.equal(loopbacksWhenDone, 0, "nothing purged while the run is still publishing");
	await drain();
	assert.equal(loopbacks.length, 1, "one purge, not 25");
	assert.deepEqual(loopbacks[0].scope.tags, ["terms", ...Array.from({ length: 25 }, (_, i) => `term-${i}`)]);
	assert.deepEqual(globalThis.__purges.map((p) => p.inEntrypoint), [true]);
});

test("in a scheduled run: a batch is purged at most maxWaitMs after its first tags, even while more keep coming; a string tag counts", async (t) => {
	reset();
	const saved = batching.maxWaitMs;
	batching.maxWaitMs = 300;
	t.after(() => (batching.maxWaitMs = saved));
	const provider = coywolfCloudflareCache(undefined);
	const { wrapped, ctx, loopbacks, drain } = site(async () => {
		const until = Date.now() + batching.maxWaitMs * 2.5;
		let i = 0;
		while (Date.now() < until) {
			await provider.invalidate({ tags: `one-${i++}` });
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
	});
	await wrapped.scheduled({}, {}, ctx);
	await drain();
	assert.ok(loopbacks.length >= 2, `${loopbacks.length} purges`);
	const all = loopbacks.flatMap((l) => l.scope.tags);
	assert.equal(new Set(all).size, all.length, "each tag once");
	assert.equal(all[0], "one-0");
});

test("in a scheduled run: two runs at once (two isolates' worth in one) keep their own batches", async () => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	const a = site(async () => {
		await provider.invalidate({ tags: ["A1"] });
		await new Promise((resolve) => setTimeout(resolve, 5));
		await provider.invalidate({ tags: ["A2"] });
	});
	const b = site(async () => {
		await provider.invalidate({ tags: ["B1"] });
		await new Promise((resolve) => setTimeout(resolve, 5));
		await provider.invalidate({ tags: ["B2"] });
	});
	await Promise.all([a.wrapped.scheduled({}, {}, a.ctx), b.wrapped.scheduled({}, {}, b.ctx)]);
	await Promise.all([a.drain(), b.drain()]);
	assert.deepEqual(a.loopbacks.map((l) => l.scope.tags), [["A1", "A2"]]);
	assert.deepEqual(b.loopbacks.map((l) => l.scope.tags), [["B1", "B2"]]);
});

test("in a scheduled run whose ctx has no waitUntil, the purge is made before invalidate() returns", async () => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	let seen = -1;
	const { wrapped, ctx, loopbacks } = site(async () => {
		await provider.invalidate({ tags: ["posts"] });
		seen = loopbacks.length;
	});
	const { waitUntil: _held, ...unheld } = ctx;
	await wrapped.scheduled({}, {}, unheld);
	assert.equal(seen, 1);
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["posts"] }, inEntrypoint: true }]);
});

test("package.json exports it, and @astrojs/cloudflare is an optional peer (only this file needs it)", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./cache-provider"], "./src/cache-provider.ts");
	assert.ok(readFileSync(new URL(`../${pkg.exports["./cache-provider"]}`, import.meta.url), "utf8").includes("export default coywolfCloudflareCache"));
	assert.ok(pkg.peerDependencies["@astrojs/cloudflare"]);
	assert.equal(pkg.peerDependenciesMeta["@astrojs/cloudflare"]?.optional, true);
});

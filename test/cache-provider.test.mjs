// Run: node --test test/cache-provider.test.mjs
//
// The pack's Astro cache provider (src/cache-provider.ts, "@coywolf/emdash/cache-provider"): Astro's Cloudflare
// provider (a stand-in with the same invalidate(): test/fixtures/astro-cloudflare-cache-provider.mjs), with
// invalidate() doing nothing when Workers Cache is off, Astro's own purge in a request, and, during the Worker's
// scheduled run (EmDash's scheduled publishing and plugins' scheduled edits), a purge through the Worker's own
// fetch, since Workers Cache ignores purges made in the scheduled run itself.
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
export const cache = { get purge() { return globalThis.__noCache ? undefined : async (o) => { if (globalThis.__purgeThrow) throw new Error("purge failed"); globalThis.__purges.push({ scope: o, inFetch: globalThis.__inFetch > 0 }); return { success: globalThis.__purgeOk !== false }; }; } };
export const exports = new Proxy({}, { get: (_, k) => globalThis.__moduleExports?.[k] });`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

const { default: coywolfCloudflareCache, batching } = await import("../src/cache-provider.ts");
// Short waits, so the tests don't sit through the real 1.5 s (with room for a slow CI machine).
batching.quietMs = 20;
batching.maxWaitMs = 2_000;
const { PURGE_PROP } = await import("../src/core/scheduled-purge.ts");
const { stripTrackingParams } = await import("../src/worker.ts");

function reset() {
	globalThis.__purges = [];
	globalThis.__purgeOk = true;
	globalThis.__purgeThrow = false;
	globalThis.__noCache = false;
	globalThis.__inFetch = 0;
	globalThis.__moduleExports = undefined;
	globalThis.__astro = { configs: [], invalidates: [], setHeaders: [] };
}
reset();

/**
 * A site Worker wrapped like the sites' src/worker.ts, whose scheduled() runs `work(ctx)`, and a ctx whose
 * exports.default calls the wrapped Worker's fetch with the props it's given (what ctx.exports does).
 */
function site(work, { respond } = {}) {
	const loopbacks = [];
	const waits = [];
	const wrapped = stripTrackingParams({
		fetch: async () => new Response("page"),
		scheduled: async (_controller, _env, ctx) => work(ctx),
	});
	const ownDefault = (options) => ({
		fetch: async (request) => {
			loopbacks.push({ props: options.props, method: request.method });
			if (respond) return respond(request);
			globalThis.__inFetch++;
			try {
				return await wrapped.fetch(request, {}, { props: options.props });
			} finally {
				globalThis.__inFetch--;
			}
		},
	});
	const ctx = { exports: { default: ownDefault }, waitUntil: (p) => waits.push(p) };
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

test("in a request: Astro's own invalidate(), with the same options (path tags included), and its errors", async () => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	const options = { tags: ["posts", "01X"] };
	await provider.invalidate(options);
	assert.equal(globalThis.__astro.invalidates.length, 1);
	assert.equal(globalThis.__astro.invalidates[0], options, "the same object, untouched");
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["posts", "01X"] }, inFetch: false }]);

	reset();
	await provider.invalidate({ path: "/x" });
	await provider.invalidate({ tags: "one", path: "/y" });
	assert.deepEqual(
		globalThis.__purges.map((p) => p.scope),
		[{ tags: ["astro-path:/x"] }, { tags: ["one", "astro-path:/y"] }],
	);

	reset();
	globalThis.__purgeThrow = true;
	await assert.rejects(provider.invalidate({ tags: ["posts"] }), /purge failed/, "a failing purge still throws in a request, as Astro's does");
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

test("in a scheduled run: the tags Astro would purge go through the Worker's own fetch, never a direct purge", async () => {
	reset();
	const provider = coywolfCloudflareCache(undefined);
	const tags = ["posts", "01X"];
	const { wrapped, ctx, loopbacks, drain } = site(() => provider.invalidate({ tags, path: "/p" }));
	await wrapped.scheduled({}, {}, ctx);
	await drain();
	assert.deepEqual(loopbacks, [{ props: { [PURGE_PROP]: { tags: ["posts", "01X", "astro-path:/p"] } }, method: "POST" }]);
	assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["posts", "01X", "astro-path:/p"] }, inFetch: true }]);
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
	const many = ["posts", ...Array.from({ length: 100 }, (_, i) => `id-${i}`), "posts"];
	const big = site(() => provider.invalidate({ tags: many }));
	await big.wrapped.scheduled({}, {}, big.ctx);
	await big.drain();
	assert.deepEqual(
		big.loopbacks.map((l) => l.props[PURGE_PROP].tags.length),
		[100, 1],
	);
	assert.deepEqual(big.loopbacks[0].props[PURGE_PROP].tags.slice(0, 2), ["posts", "id-0"]);
	assert.deepEqual(big.loopbacks[1].props[PURGE_PROP].tags, ["id-99"]);
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
	ran = site(() => provider.invalidate({ tags: ["posts"] }), { respond: () => new Response("oops", { status: 500 }) });
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
		assert.deepEqual(loopbacks.map((l) => l.props[PURGE_PROP]), [{ tags: ["posts", "01A", "01B"] }]);
		assert.deepEqual(globalThis.__purges, [{ scope: { tags: ["posts", "01A", "01B"] }, inFetch: true }]);
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
	assert.deepEqual(loopbacks[0].props[PURGE_PROP].tags, ["terms", ...Array.from({ length: 25 }, (_, i) => `term-${i}`)]);
	assert.deepEqual(globalThis.__purges.map((p) => p.inFetch), [true]);
});

test("in a scheduled run: a batch is purged at most maxWaitMs after its first tags, even while more keep coming; a string tag counts", async (t) => {
	reset();
	const saved = batching.maxWaitMs;
	batching.maxWaitMs = 60;
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
	const all = loopbacks.flatMap((l) => l.props[PURGE_PROP].tags);
	assert.equal(new Set(all).size, all.length, "each tag once");
	assert.equal(all[0], "one-0");
});

test("package.json exports it, and @astrojs/cloudflare is an optional peer (only this file needs it)", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./cache-provider"], "./src/cache-provider.ts");
	assert.ok(readFileSync(new URL(`../${pkg.exports["./cache-provider"]}`, import.meta.url), "utf8").includes("export default coywolfCloudflareCache"));
	assert.ok(pkg.peerDependencies["@astrojs/cloudflare"]);
	assert.equal(pkg.peerDependenciesMeta["@astrojs/cloudflare"]?.optional, true);
});

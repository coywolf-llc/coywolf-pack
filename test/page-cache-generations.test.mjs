// Run: node --test test/page-cache-generations.test.mjs
// Generation tags: every response the pack lets into the edge cache carries the tag of the
// settings generation its isolate rendered with, so the settling purge after a save that cleared
// every page clears only the pages rendered with the old settings (instead of every page again,
// with a second full warm-up). See src/core/generation.ts.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => { globalThis.__waitUntil?.push(p); }; export const cache = { get purge() { return globalThis.__noCache ? undefined : async (o) => { globalThis.__purges.push(o); return { success: globalThis.__purgeOk !== false }; }; } };`,
				shortCircuit: true,
			};
		}
		if (specifier === "./modules.js" && context.parentURL?.endsWith("/src/middleware.ts")) {
			return { url: "data:text/javascript,export const MIDDLEWARE = [];", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

globalThis.__purges = [];
globalThis.__waitUntil = [];
const features = await import("../src/core/features.ts");
const generation = await import("../src/core/generation.ts");
const { tagGeneration } = await import("../src/pageCache/lib.ts");
const { coywolfPack } = await import("../src/middleware.ts");
const { AstroCache } = await import(new URL("../node_modules/astro/dist/core/cache/runtime/cache.js", import.meta.url).href);
const { recordSettingsChange, claimSettle, currentGenerationTag, generationTag, parseGeneration, UNKNOWN_GENERATION_TAG, FIRST_GENERATION, MAX_SETTLE_TAGS } = generation;
const TTL = features.FEATURES_TTL_MS;

function d1() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL);");
	const exec = (sql, params) => {
		const st = db.prepare(sql);
		return /^\s*(select|with)/i.test(sql) ? { results: st.all(...params) } : { results: [], meta: { changes: Number(st.run(...params).changes) } };
	};
	const statement = (sql, params = []) => ({
		sql,
		params,
		bind: (...p) => statement(sql, p),
		all: async () => exec(sql, params),
		first: async () => exec(sql, params).results[0] ?? null,
		run: async () => exec(sql, params),
	});
	return { sqlite: db, prepare: (sql) => statement(sql), batch: async (statements) => statements.map((s) => exec(s.sql, s.params)) };
}
const row = (db) => parseGeneration(db.sqlite.prepare("SELECT value FROM options WHERE name = ?").get(features.GENERATION_OPTION)?.value);

function freshIsolate(db) {
	globalThis.__testEnv = { DB: db };
	globalThis.__waitUntil = [];
	globalThis.__purges = [];
	features.invalidateFeatures();
}
const settled = () => Promise.allSettled(globalThis.__waitUntil);

test("a full save settles by the tags of the generations isolates may still have, not by clearing everything again", async () => {
	const db = d1();
	const t0 = Date.now();
	const first = await recordSettingsChange(db, { purgeEverything: true }, t0, { byGeneration: true });
	// A site's first save: pages rendered before it carry the first generation's tag.
	assert.deepEqual(first.settle, { tags: [generationTag(FIRST_GENERATION), UNKNOWN_GENERATION_TAG] });
	// A second save a minute later: isolates may have either earlier generation.
	const second = await recordSettingsChange(db, { purgeEverything: true }, t0 + 60_000, { byGeneration: true });
	assert.deepEqual(new Set(second.settle.tags), new Set([generationTag(FIRST_GENERATION), generationTag(first.id), UNKNOWN_GENERATION_TAG]));
	// Long after: generations replaced more than the switches' lifetime ago are gone from every isolate.
	const later = await recordSettingsChange(db, { purgeEverything: true }, t0 + 60_000 + 2 * TTL, { byGeneration: true });
	assert.ok(later.settle.tags.includes(generationTag(second.id)));
	assert.ok(!later.recent.some((r) => r.id === first.id), "the first save's generation has aged out");
});

test("a save that changes no page still counts: a full save soon after settles its generation too", async () => {
	const db = d1();
	const t0 = Date.now();
	const quiet = await recordSettingsChange(db, null, t0, { byGeneration: true }); // e.g. backup settings
	assert.equal(quiet.settle, undefined);
	const full = await recordSettingsChange(db, { purgeEverything: true }, t0 + 1000, { byGeneration: true });
	assert.ok(full.settle.tags.includes(generationTag(quiet.id)) && full.settle.tags.includes(generationTag(FIRST_GENERATION)));
});

test("scoped saves settle their own scope; EmDash's own changes (going live) keep a full settle", async () => {
	const db = d1();
	const scoped = await recordSettingsChange(db, { tags: ["coywolf-redirects"], pathPrefixes: ["/old"] }, Date.now(), { byGeneration: true });
	assert.deepEqual(scoped.settle, { tags: ["coywolf-redirects"], pathPrefixes: ["/old"] });
	const other = d1();
	const live = await recordSettingsChange(other, { purgeEverything: true });
	assert.deepEqual(live.settle, { purgeEverything: true }, "without byGeneration (EmDash's settings reach isolates another way)");
	// A pending full settle absorbs a later scoped one; a pending scoped one merges with generation tags.
	const merged = await recordSettingsChange(db, { purgeEverything: true }, Date.now(), { byGeneration: true });
	assert.ok(merged.settle.tags.includes("coywolf-redirects") && merged.settle.tags.includes(generationTag(scoped.id)));
	assert.deepEqual(merged.settle.pathPrefixes, ["/old"]);
});

test("dozens of saves within minutes settle by clearing everything (Cloudflare takes 100 tags at most)", async () => {
	const db = d1();
	const t0 = Date.now();
	let last;
	for (let i = 0; i <= MAX_SETTLE_TAGS + 1; i++) last = await recordSettingsChange(db, { purgeEverything: true }, t0 + i, { byGeneration: true });
	assert.deepEqual(last.settle, { purgeEverything: true });
	assert.ok(last.recent.length <= MAX_SETTLE_TAGS + 1, "the row stays small");
});

test("the generation tag comes from the isolate's read of the switches", async () => {
	const db = d1();
	freshIsolate(db);
	assert.equal(currentGenerationTag(), UNKNOWN_GENERATION_TAG, "nothing read yet");
	await features.siteFeatures();
	assert.equal(currentGenerationTag(), generationTag(FIRST_GENERATION), "no save yet");
	const saved = await recordSettingsChange(db, { purgeEverything: true }, Date.now(), { byGeneration: true });
	assert.equal(currentGenerationTag(), generationTag(saved.id), "the saving isolate knows its own save at once");
	// Another isolate (a fresh read) sees it too.
	features.invalidateFeatures();
	await features.siteFeatures();
	assert.equal(currentGenerationTag(), generationTag(saved.id));
	await settled();
});

test("tagGeneration only adds to a response already going to the edge cache", () => {
	const page = new AstroCache({});
	page.set({ maxAge: 3600 });
	tagGeneration(page, "coywolf-gen-x");
	assert.deepEqual(page.tags, ["coywolf-gen-x"]);
	const off = new AstroCache({});
	off.set({ maxAge: 3600 });
	off.set(false);
	tagGeneration(off, "coywolf-gen-x");
	assert.equal(off.options.maxAge, undefined);
	assert.deepEqual(off.tags, [], "a response turned off stays off (set() would turn it back on)");
	const untouched = new AstroCache({});
	tagGeneration(untouched, "coywolf-gen-x");
	assert.deepEqual(untouched.tags, [], "a route the site didn't make cacheable");
	tagGeneration(undefined, "coywolf-gen-x");
});

function context(path, cache, method = "GET") {
	const url = new URL(`https://example.com${path}`);
	return { url, request: new Request(url, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json", "content-length": "2" } } : {}) }), cache, locals: {}, site: undefined };
}
const html = async () => new Response("<html>page</html>", { headers: { "content-type": "text/html; charset=utf-8" } });
const cacheable = () => {
	const cache = new AstroCache({});
	cache.set({ maxAge: 3600, tags: ["posts"] });
	return cache;
};

test("end to end: pages and the pack's own edge-cached answers carry the generation tag; a save settles by it", async () => {
	const db = d1();
	freshIsolate(db);
	// A page.
	const before = cacheable();
	await (await coywolfPack({}, [])(context("/post/", before), html)).text();
	const oldTag = generationTag(FIRST_GENERATION);
	assert.ok(before.tags.includes(oldTag), before.tags.join());
	assert.ok(before.tags.includes("posts"), "EmDash's tags are kept");
	// A handler that owns its caching (the feed, redirects…), and one that doesn't (files).
	const owned = cacheable();
	const handlers = [{ module: "x", feature: "*", ownsCache: true, handle: (c) => (c.url.pathname === "/feed/" ? (c.cache.set(false), c.cache.set({ maxAge: 60, tags: ["coywolf:feed"] }), new Response("rss")) : undefined) }];
	await coywolfPack({}, handlers)(context("/feed/", owned), html);
	assert.deepEqual(new Set(owned.tags), new Set(["coywolf:feed", oldTag]));
	const notOwned = cacheable();
	await coywolfPack({}, [{ module: "files", feature: "*", handle: () => new Response("file") }])(context("/file", notOwned), html);
	assert.equal(notOwned.options.maxAge, undefined, "not edge-cached, so not tagged either");

	// An admin save that changes pages: one full purge now, a settle by the old generation later.
	await coywolfPack({}, [])(context("/_emdash/api/plugins/coywolf-pack/schema/site/save", undefined, "POST"), async () => Response.json({ ok: true }));
	await settled();
	assert.deepEqual(globalThis.__purges, [{ purgeEverything: true }]);
	const saved = row(db);
	assert.ok(saved.settle.tags.includes(oldTag));
	// A page this isolate renders now has the new generation's tag.
	const after = cacheable();
	await (await coywolfPack({}, [])(context("/post/", after), html)).text();
	assert.ok(after.tags.includes(generationTag(saved.id)) && !after.tags.includes(oldTag));
	await settled();
	// The settling purge, once due, clears the old generation's pages, not everything.
	globalThis.__purges = [];
	const scope = await claimSettle(db, Date.now() + TTL + 20_000);
	assert.ok(scope && "tags" in scope && scope.tags.includes(oldTag) && !("purgeEverything" in scope));
	await settled();
});

test("a redirect save clears the cached redirects and the pages at its sources in one purge, and settles both", async () => {
	const db = d1();
	freshIsolate(db);
	await features.siteFeatures();
	const body = JSON.stringify({ source: "/old-page/", target: "/new-page/" });
	const url = new URL("https://example.com/_emdash/api/plugins/coywolf-pack/redirects/save");
	const ctx = { url, request: new Request(url, { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length) } }), cache: undefined, locals: {}, site: undefined };
	await coywolfPack({}, [])(ctx, async () => {
		await ctx.request.json(); // The route reads the body.
		return Response.json({ ok: true });
	});
	await settled();
	assert.deepEqual(globalThis.__purges, [{ pathPrefixes: ["/old-page"], tags: ["coywolf-redirects"] }]);
	assert.deepEqual(row(db).settle, { pathPrefixes: ["/old-page"], tags: ["coywolf-redirects"] });
});

// ── Request bodies are read only after the route accepted the write ──

/** A POST that records whether the middleware parsed its copy of the body. */
function trackedPost(path, json) {
	const url = new URL(`https://example.com${path}`);
	const body = JSON.stringify(json);
	const state = { pulled: false };
	const request = new Request(url, { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length) } });
	request.clone = () => {
		const copy = Request.prototype.clone.call(request);
		const parse = copy.json.bind(copy);
		copy.json = () => {
			state.pulled = true;
			return parse();
		};
		return copy;
	};
	return { ctx: { url, request, cache: undefined, locals: {}, site: undefined }, state };
}

test("a refused redirect save or settings save isn't parsed (EmDash checks permissions after the pack middleware)", async () => {
	const db = d1();
	freshIsolate(db);
	await features.siteFeatures();
	const redirect = trackedPost("/_emdash/api/plugins/coywolf-pack/redirects/import", { rules: [{ source: "/a", target: "/b" }] });
	await coywolfPack({}, [])(redirect.ctx, async () => Response.json({ error: "forbidden" }, { status: 403 }));
	const settings = trackedPost("/_emdash/api/settings", { staging: false });
	await coywolfPack({}, [])(settings.ctx, async () => Response.json({ error: "forbidden" }, { status: 401 }));
	await settled();
	assert.equal(redirect.state.pulled, false, "2 MiB of JSON from anyone isn't parsed");
	assert.equal(settings.state.pulled, false);
	assert.deepEqual(globalThis.__purges, []);
	// Accepted: read after the route answered, from the copy (the route consumed the original).
	const accepted = trackedPost("/_emdash/api/settings", { staging: false });
	await coywolfPack({}, [])(accepted.ctx, async () => {
		await accepted.ctx.request.json();
		return Response.json({ ok: true });
	});
	await settled();
	assert.deepEqual(globalThis.__purges, [{ purgeEverything: true }], "going live still clears every page");
});

// ── robots.txt after EmDash's SEO saves and the pack's robots.txt rules saves ──

/** Run `fn` with the clock at `time` (the settling purge is due minutes after a save). */
async function atTime(time, fn) {
	const real = Date.now;
	Date.now = () => time;
	try {
		return await fn();
	} finally {
		Date.now = real;
	}
}

/** A request in another isolate once the settling purge is due: it claims it and purges. Returns those purges. */
async function settleLaterRequest(db, savedAt) {
	freshIsolate(db);
	await atTime(savedAt + TTL + 20_000, async () => (await coywolfPack({}, [])(context("/post/", cacheable()), html)).text());
	await settled();
	return globalThis.__purges;
}

const acceptedSettingsSave = async (json) => {
	const save = trackedPost("/_emdash/api/settings", json);
	await coywolfPack({}, [])(save.ctx, async () => {
		await save.ctx.request.json();
		return Response.json({ ok: true });
	});
	await settled();
};

test("an SEO save clears /robots.txt with Robots.txt Rules off too (EmDash's own file, kept at the edge for a day), and settles it", async () => {
	const db = d1();
	freshIsolate(db);
	await features.siteFeatures();
	assert.equal(features.isOn(await features.siteFeatures(), "robots"), false, "Robots.txt Rules off (the default)");
	const savedAt = Date.now();
	await acceptedSettingsSave({ seo: { robotsTxt: "User-agent: *\nDisallow: /_emdash/\n" } });
	assert.deepEqual(globalThis.__purges, [{ pathPrefixes: ["/robots.txt"] }], "Cloudflare's purge by URL doesn't reach Workers Cache");
	assert.deepEqual(row(db).settle, { pathPrefixes: ["/robots.txt"] });
	assert.deepEqual(await settleLaterRequest(db, savedAt), [{ pathPrefixes: ["/robots.txt"] }], "cleared again once every isolate has the new settings");
	// A save without SEO settings (EmDash's General page on a site that never saved any) doesn't touch robots.txt.
	const other = d1();
	freshIsolate(other);
	await features.siteFeatures();
	await acceptedSettingsSave({ title: "A new title" });
	assert.deepEqual(globalThis.__purges, []);
	assert.equal(row(other), null, "no settings change recorded");
});

test("a settings save with SEO settings and a staging change clears everything once, and settles everything", async () => {
	const db = d1();
	// Count the settings generation's writes (recordSettingsChange's upsert).
	const prepare = db.prepare;
	let recorded = 0;
	db.prepare = (sql) => {
		if (/^INSERT INTO options .* DO UPDATE SET value/.test(sql)) recorded++;
		return prepare(sql);
	};
	freshIsolate(db);
	await features.siteFeatures();
	await acceptedSettingsSave({ seo: { robotsTxt: "User-agent: *\nAllow: /\n" }, staging: false });
	assert.deepEqual(globalThis.__purges, [{ purgeEverything: true }], "/robots.txt is cleared with everything else, not separately");
	assert.deepEqual(row(db).settle, { purgeEverything: true });
	assert.equal(recorded, 1, "one settings change recorded, not two rewriting the row from the same read");
});

test("robots.txt reads its rules on every render: a save in another isolate shows on the next one, so the purge isn't undone", async () => {
	const { serveRobots, CONFIG_OPTION } = await import("../src/robots/middleware.ts");
	const { DEFAULT_CONFIG, EMDASH_MEDIA_PATH } = await import("../src/robots/rules.ts");
	const db = d1();
	const put = (name, value) => db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, JSON.stringify(value));
	put("plugin:coywolf-pack:settings:features", { robots: true });
	put(CONFIG_OPTION, { ...DEFAULT_CONFIG, allowMedia: true });
	put("site:seo", { disallowAiTraining: false });
	freshIsolate(db);
	await features.siteFeatures();
	const served = async () => (await serveRobots(new URL("https://example.com/robots.txt"), "GET", { DB: db })).text();
	const before = await served();
	assert.ok(before.includes(`Allow: ${EMDASH_MEDIA_PATH}`) && !before.includes("Content-Signal"));
	// robots/save in another isolate (coywolf.com, 2026-11-12: the media line removed). This isolate renders next,
	// after that save's purge: it must not put the old file back in the edge cache.
	put(CONFIG_OPTION, { ...DEFAULT_CONFIG, allowMedia: false });
	assert.ok(!(await served()).includes(`Allow: ${EMDASH_MEDIA_PATH}`), "the saved rules, not a copy from before the save");
	// EmDash's "Disallow AI training" (an SEO save, wherever it ran) shows at once too.
	put("site:seo", { disallowAiTraining: true });
	assert.ok((await served()).includes("Content-Signal"));
});

test("a robots.txt rules save clears /robots.txt now and again once settled", async () => {
	const db = d1();
	freshIsolate(db);
	await features.siteFeatures();
	const savedAt = Date.now();
	await coywolfPack({}, [])(context("/_emdash/api/plugins/coywolf-pack/robots/save", undefined, "POST"), async () => Response.json({ saved: true }));
	await settled();
	assert.deepEqual(globalThis.__purges, [{ pathPrefixes: ["/robots.txt"] }]);
	assert.deepEqual(row(db).settle, { pathPrefixes: ["/robots.txt"] });
	// Not before every isolate has the new settings generation…
	freshIsolate(db);
	await atTime(savedAt + 60_000, async () => (await coywolfPack({}, [])(context("/post/", cacheable()), html)).text());
	await settled();
	assert.deepEqual(globalThis.__purges, [], "not due yet");
	// …then the first request in any isolate clears it again, once.
	assert.deepEqual(await settleLaterRequest(db, savedAt), [{ pathPrefixes: ["/robots.txt"] }]);
	assert.equal(row(db).settle, undefined, "claimed");
	assert.deepEqual(await settleLaterRequest(db, savedAt), [], "only one isolate purges");
});

// ── Refused purges (the account's purge rate limit) ──

test("a full save whose first purge is refused settles by clearing everything, not just generation tags", async () => {
	const db = d1();
	freshIsolate(db);
	globalThis.__purgeOk = false;
	try {
		await coywolfPack({}, [])(context("/_emdash/api/plugins/coywolf-pack/schema/site/save", undefined, "POST"), async () => Response.json({ ok: true }));
		await settled();
	} finally {
		globalThis.__purgeOk = true;
	}
	assert.deepEqual(globalThis.__purges, [{ purgeEverything: true }], "tried once");
	assert.deepEqual(row(db).settle, { purgeEverything: true }, "pages cached under older generations would otherwise stay for days");
});

test("a refused settling purge is tried again a minute later, a limited number of times; without Workers Cache nothing is kept", async () => {
	const { SETTLE_RETRY_MS, MAX_SETTLE_RETRIES, settleLater, settleDue } = generation;
	const db = d1();
	freshIsolate(db);
	await recordSettingsChange(db, { tags: ["coywolf-redirects"] }, Date.now(), { byGeneration: true });
	await features.siteFeatures();
	const due = Date.now() + TTL + 20_000;
	const scope = await claimSettle(db, due);
	assert.deepEqual(scope, { tags: ["coywolf-redirects"] });
	assert.equal(row(db).settle, undefined, "claimed");
	await settleLater(db, scope, due, SETTLE_RETRY_MS);
	const retry = row(db);
	assert.deepEqual(retry.settle, scope);
	assert.equal(retry.settleAfter, due + SETTLE_RETRY_MS);
	assert.equal(settleDue(retry, due + 1000), false, "not before the retry time");
	assert.equal(settleDue(retry, due + SETTLE_RETRY_MS + 1), true);
	// Given up after MAX_SETTLE_RETRIES.
	for (let i = 1; i <= MAX_SETTLE_RETRIES + 2; i++) {
		const current = row(db);
		const { settle: _claimed, ...rest } = current;
		db.sqlite.prepare("UPDATE options SET value = ? WHERE name = ?").run(JSON.stringify(rest), features.GENERATION_OPTION);
		await settleLater(db, scope, due, SETTLE_RETRY_MS);
	}
	assert.equal(row(db).settle, undefined, "no endless retries");
	// No Workers Cache: a full save's purge can't happen, and nothing is kept for later.
	const other = d1();
	freshIsolate(other);
	globalThis.__noCache = true;
	try {
		await coywolfPack({}, [])(context("/_emdash/api/plugins/coywolf-pack/schema/site/save", undefined, "POST"), async () => Response.json({ ok: true }));
		await settled();
	} finally {
		globalThis.__noCache = false;
	}
	assert.ok(row(other).settle && "tags" in row(other).settle, "the generation settle as usual, not escalated");
});

// ── Redirects added in another isolate (the in-memory index doesn't have them yet) ──

test("a 404 at a path this isolate's redirect index doesn't know reads the rule after all: a new rule answers at once", async () => {
	const { saveRule } = await import("../src/redirects/rules.ts");
	const { redirectsMiddleware } = await import("../src/redirects/pack.ts");
	const { invalidateRedirectCache, setRedirectHitDelay, REDIRECT_EDGE_MAX_AGE } = await import("../src/redirects/middleware.ts");
	setRedirectHitDelay(0);
	const db = d1();
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify({ redirects: true }));
	await saveRule(db, { source: "/kept", target: "/k" });
	freshIsolate(db);
	invalidateRedirectCache();
	const notFound = async () => new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } });
	const run = (path, cache, next) => coywolfPack({}, [redirectsMiddleware])(context(path, cache), next);
	await (await run("/a-page/", cacheable(), html)).text(); // The index is in memory now.
	await saveRule(db, { source: "/moved", target: "/new-home/" }); // A slug change in another isolate.
	const cache = cacheable();
	// The discarded 404 render is drained to its end in the background, never cancelled midway.
	const render = { cancelled: false, finished: false };
	const streamed404 = async () =>
		new Response(
			new ReadableStream({
				async pull(controller) {
					await new Promise((r) => setTimeout(r, 5));
					controller.enqueue(new TextEncoder().encode("<html>Not found</html>"));
					render.finished = true;
					controller.close();
				},
				cancel() {
					render.cancelled = true;
				},
			}),
			{ status: 404, headers: { "content-type": "text/html" } },
		);
	const res = await run("/moved/", cache, streamed404);
	assert.equal(res.status, 301);
	assert.equal(res.headers.get("location"), "/new-home/");
	assert.equal(cache.options.maxAge, REDIRECT_EDGE_MAX_AGE);
	assert.ok(cache.tags.includes("coywolf-redirects"));
	await settled();
	assert.equal(render.cancelled, false);
	assert.equal(render.finished, true);
	// A real 404 stays a 404.
	assert.equal((await run("/nothing-here/", cacheable(), notFound)).status, 404);
	await settled();
	invalidateRedirectCache();
});

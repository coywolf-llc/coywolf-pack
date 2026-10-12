// Run: node --import ./test/ts-resolve.mjs --test test/images-upload-hook.test.mjs
// Stored sizes for new uploads: EmDash 1.2 runs media:afterUpload without waiting for
// it (emdash-runtime handleMediaCreate fires it right before the upload's response),
// so the composed hook must hand its whole job to waitUntil before anything async, and
// the work must run outside the middleware context (no switches cached, raw bindings).
// 0.30.0–0.33.0 awaited a settings read and a dynamic import first; the request ended
// before waitUntil was reached, and no size, record or log appeared. The job still
// gates each participant by its feature (images, and AI Enrichment's ai.imageText).
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => { (globalThis.__waited ??= []).push(p); };`,
				shortCircuit: true,
			};
		}
		return next(specifier, context);
	},
});

const { composeHooks, hookCapabilities } = await import("../src/core/compose.ts");
const { invalidateFeatures, registerFeatures } = await import("../src/core/features.ts");
const { imagesPack } = await import("../src/images/pack.ts");
const { VARIANTS_VERSION } = await import("../src/images/variants.ts");
const { definePlugin, HookPipeline } = await import("emdash");

// shared.ts loads cloudflare:workers once at import; let that settle, as it has long before a Worker's first request.
await new Promise((resolve) => setTimeout(resolve, 0));

/** A D1 stand-in with the tables the upload path touches. */
function d1({ features = { images: true }, host = "https://media.example.com" } = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT DEFAULT '0' NOT NULL);
		CREATE TABLE _plugin_storage (plugin_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT, updated_at TEXT, revision TEXT DEFAULT '0' NOT NULL, PRIMARY KEY (plugin_id, collection, id));
		CREATE TABLE media (id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, size INTEGER, width INTEGER, height INTEGER, storage_key TEXT, status TEXT, focal_x REAL, focal_y REAL, created_at TEXT DEFAULT '2026-01-01 00:00:00');
	`);
	const option = db.prepare("INSERT INTO options (name, value) VALUES (?, ?)");
	option.run("plugin:coywolf-pack:settings:features", JSON.stringify(features));
	if (host) option.run("plugin:coywolf-pack:settings:imagesMediaHost", JSON.stringify(host));
	db.prepare("INSERT INTO media (id, filename, mime_type, size, width, height, storage_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')").run("01UP", "01UP.png", "image/png", 1000, 1200, 630, "01UP.png");
	const bound = (stmt, values) => ({
		async run() {
			return { meta: { changes: Number(stmt.run(...values).changes) } };
		},
		async first() {
			return stmt.get(...values) ?? null;
		},
		async all() {
			return { results: stmt.all(...values) };
		},
	});
	return {
		sqlite: db,
		features,
		prepare(sql) {
			const stmt = db.prepare(sql);
			return { bind: (...values) => bound(stmt, values), ...bound(stmt, []) };
		},
		records: () => db.prepare("SELECT id, data FROM _plugin_storage WHERE collection = 'imageVariants'").all(),
	};
}

function bucket() {
	const objects = new Map([["01UP.png", new Uint8Array([1, 2, 3]).buffer]]);
	return {
		objects,
		async get(key) {
			const body = objects.get(key);
			return body ? { arrayBuffer: async () => body } : null;
		},
		async put(key, body) {
			objects.set(key, body);
		},
		async list({ prefix }) {
			return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
		},
		async delete() {},
	};
}

const images = () => ({
	input() {
		return {
			transform() {
				return { async output(o) { return { response: () => new Response(new Uint8Array([9]), { headers: { "content-type": o.format } }) }; } };
			},
		};
	},
});

const upload = { id: "01UP", filename: "01UP.png", mimeType: "image/png", size: 1000, url: "/_emdash/api/media/file/01UP.png", createdAt: "2026-10-11T00:00:00.000Z" };

/**
 * EmDash's plugin context: the switches come from its settings store (the same
 * row as the D1 stand-in's), and `storage` is a plugin-storage collection a
 * participant may write to after the response.
 */
function pluginCtx(db) {
	const aiQueue = new Map();
	return {
		settings: { get: async (key) => (key === "features" ? db.features : null) },
		storage: { aiQueue: { put: async (id, value) => void aiQueue.set(id, value), get: async (id) => aiQueue.get(id) ?? null } },
		log: { info() {}, warn() {}, error() {} },
		aiQueue,
	};
}

/** Fresh bindings and an empty switches cache: the hook runs outside any middleware (nothing read yet in this isolate). */
function arrange(options) {
	invalidateFeatures();
	const db = d1(options);
	const b = bucket();
	globalThis.__testEnv = { DB: db, MEDIA: b, IMAGES: images() };
	globalThis.__waited = [];
	return { db, b, ctx: pluginCtx(db) };
}

const madeSizes = (b) => [...b.objects.keys()].filter((k) => k.startsWith(`v${VARIANTS_VERSION}/01UP-`)).sort();
const EXPECTED = [400, 640, 800].flatMap((w) => [`v${VARIANTS_VERSION}/01UP-${w}.avif`, `v${VARIANTS_VERSION}/01UP-${w}.webp`]).sort();
const settled = () => Promise.all(globalThis.__waited);

// AI Enrichment's share of the hook (src/ai/pack.ts), as compose sees it: a participant gated by a sub-feature.
registerFeatures([
	{ id: "ai", label: "AI Enrichment", description: "", default: false },
	{ id: "ai.imageText", label: "Image text", description: "", default: false },
]);
function aiStandIn() {
	const calls = [];
	return {
		calls,
		module: {
			id: "ai",
			label: "AI Enrichment",
			features: [{ id: "ai", label: "AI Enrichment", description: "", default: false }, { id: "ai.imageText", label: "Image text", description: "", default: false }],
			hooks: {
				"media:afterUpload": async (event, ctx) => {
					calls.push(event.media.id);
					await ctx.storage.aiQueue.put(`media:${event.media.id}`, { kind: "media", mediaId: event.media.id });
				},
			},
			hookFeature: { "media:afterUpload": "ai.imageText" },
		},
	};
}

test("the composed media:afterUpload hook hands its work to waitUntil before anything async", async () => {
	const { db, b, ctx } = arrange();
	const { hooks } = composeHooks([imagesPack({ cdn: "https://media.example.com" })], { tasks: [] });
	const returned = hooks["media:afterUpload"](structuredClone({ media: upload }), ctx);
	// Nothing awaited yet: the work is already registered (the request may end at any time now).
	assert.equal(globalThis.__waited.length, 1, "waitUntil called synchronously");
	await returned;
	assert.deepEqual(madeSizes(b), [], "the sizes are made after the response, not during the hook");
	await settled();
	assert.deepEqual(madeSizes(b), EXPECTED);
	const [record] = db.records();
	assert.equal(record?.id, "01UP");
	assert.deepEqual(JSON.parse(record.data).w, [400, 640, 800]);
});

test("EmDash 1.2 registers the hook for the config plugin and its fire-and-forget dispatch still gets the work done", async () => {
	const { db, b } = arrange();
	const modules = [imagesPack({ cdn: "https://media.example.com" })];
	const { hooks } = composeHooks(modules, { tasks: [] });
	// What createPlugin() hands EmDash: the composed hooks with the capabilities they need (media:read for media:afterUpload).
	const plugin = definePlugin({ id: "coywolf-pack", version: "0.0.0", capabilities: [...new Set([...modules.flatMap((m) => m.capabilities ?? []), ...hookCapabilities(modules)])], hooks });
	const pipeline = new HookPipeline([plugin], { db: {}, getDb: () => ({}) });
	assert.equal(pipeline.hasHooks("media:afterUpload"), true, "registered (EmDash skips hooks whose capability is missing)");
	const errors = [];
	const original = console.error;
	console.error = (...args) => errors.push(args.map(String).join(" "));
	try {
		// emdash-runtime handleMediaCreate: not awaited, not attached to anything; the response goes out next.
		const dispatched = pipeline.runMediaAfterUpload(structuredClone(upload));
		assert.equal(globalThis.__waited.length, 1, "registered before EmDash's dispatch yields");
		const results = await dispatched;
		assert.equal(results[0]?.success, true, "EmDash sees the hook succeed at once; the work runs under waitUntil");
		// EmDash's real plugin context here has a bare db, so its settings read (the switches cache is cold)
		// fails inside the job: that's logged and nothing is made, rather than failing the upload.
		await settled();
		assert.deepEqual(madeSizes(b), []);
		assert.equal(db.records().length, 0);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /^coywolf-pack: media:afterUpload failed/);
	} finally {
		console.error = original;
	}
});

test("participants are gated by their feature inside the job: images off, AI on", async () => {
	const ai = aiStandIn();
	const { db, b, ctx } = arrange({ features: { images: false, ai: true, "ai.imageText": true } });
	const { hooks } = composeHooks([ai.module, imagesPack({ cdn: "https://media.example.com" })], { tasks: [] });
	await hooks["media:afterUpload"](structuredClone({ media: upload }), ctx);
	assert.equal(globalThis.__waited.length, 1);
	await settled();
	assert.deepEqual(madeSizes(b), [], "Clean image URLs off: no sizes");
	assert.equal(db.records().length, 0);
	assert.deepEqual(ai.calls, ["01UP"], "AI's image text on: queued");
	assert.ok(ctx.aiQueue.has("media:01UP"), "the plugin context's storage works after the response");
});

test("AI Enrichment's share is skipped while ai.imageText is off (and while ai itself is off)", async () => {
	for (const features of [
		{ images: true, ai: true, "ai.imageText": false },
		{ images: true, ai: false, "ai.imageText": true },
	]) {
		const ai = aiStandIn();
		const { b, ctx } = arrange({ features });
		const { hooks } = composeHooks([ai.module, imagesPack({ cdn: "https://media.example.com" })], { tasks: [] });
		await hooks["media:afterUpload"](structuredClone({ media: upload }), ctx);
		await settled();
		assert.deepEqual(ai.calls, [], JSON.stringify(features));
		assert.equal(ctx.aiQueue.size, 0);
		assert.deepEqual(madeSizes(b), EXPECTED, "the images participant still runs");
	}
});

test("one participant's failure doesn't stop the others", async () => {
	const errors = [];
	const original = console.error;
	console.error = (...args) => errors.push(args.map(String).join(" "));
	try {
		const { b, ctx } = arrange({ features: { images: true, ai: true, "ai.imageText": true } });
		const broken = { ...aiStandIn().module, hooks: { "media:afterUpload": async () => { throw new Error("no model"); } } };
		const { hooks } = composeHooks([broken, imagesPack({ cdn: "https://media.example.com" })], { tasks: [] });
		await hooks["media:afterUpload"](structuredClone({ media: upload }), ctx);
		await settled();
		assert.deepEqual(madeSizes(b), EXPECTED);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /^coywolf-pack: ai: media:afterUpload failed/);
	} finally {
		console.error = original;
	}
});

test("the job is one of EmDash's deferred tasks when a request context is open", async () => {
	const als = new AsyncLocalStorage();
	globalThis[Symbol.for("emdash:request-context")] = als;
	try {
		const tracked = [];
		const store = { deferredTasks: { track: (promise) => (tracked.push(promise), promise) } };
		const { b, ctx } = arrange();
		const { hooks } = composeHooks([imagesPack({ cdn: "https://media.example.com" })], { tasks: [] });
		await als.run(store, () => hooks["media:afterUpload"](structuredClone({ media: upload }), ctx));
		assert.equal(tracked.length, 1, "tracked, so a request-scoped database with a close() waits for it");
		assert.equal(globalThis.__waited[0], tracked[0]);
		await settled();
		assert.deepEqual(madeSizes(b), EXPECTED);
	} finally {
		delete globalThis[Symbol.for("emdash:request-context")];
	}
});

test("src/ai/pack.ts gates its media:afterUpload share with ai.imageText (what the stand-in models)", () => {
	const source = readFileSync(new URL("../src/ai/pack.ts", import.meta.url), "utf8");
	assert.match(source, /hookFeature:\s*\{[^}]*"media:afterUpload":\s*"ai\.imageText"/);
});

test("a missing binding or media host is said out loud, once per upload", async () => {
	const warnings = [];
	const original = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	try {
		const { b, ctx } = arrange();
		delete globalThis.__testEnv.IMAGES;
		const { hooks } = composeHooks([imagesPack({ cdn: "https://media.example.com" })], { tasks: [] });
		await hooks["media:afterUpload"](structuredClone({ media: upload }), ctx);
		await settled();
		assert.deepEqual(madeSizes(b), []);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /^coywolf-pack images: no stored sizes for upload 01UP: the DB, MEDIA or IMAGES binding is missing/);

		const noHost = arrange({ host: null });
		const { hooks: hooksNoHost } = composeHooks([imagesPack()], { tasks: [] });
		await hooksNoHost["media:afterUpload"](structuredClone({ media: upload }), noHost.ctx);
		await settled();
		assert.equal(warnings.length, 2);
		assert.match(warnings[1], /no media host is set$/);
	} finally {
		console.warn = original;
	}
});

test("files that can't have stored sizes are left alone without a word", async () => {
	const warnings = [];
	const original = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	try {
		const { db, ctx } = arrange();
		const { hooks } = composeHooks([imagesPack({ cdn: "https://media.example.com" })], { tasks: [] });
		await hooks["media:afterUpload"]({ media: { ...upload, id: "01SVG", mimeType: "image/svg+xml" } }, ctx);
		await settled();
		assert.equal(db.records().length, 0);
		assert.deepEqual(warnings, []);
	} finally {
		console.warn = original;
	}
});

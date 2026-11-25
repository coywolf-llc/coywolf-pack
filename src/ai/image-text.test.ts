/**
 * Unit tests for AI image text and the text a person wrote (src/ai/worker.ts
 * analyzeMedia and applyImageText). Since EmDash 1.6.0, replacing a file runs
 * media:afterUpload, so a replaced image is queued for image text again
 * (src/ai/pack.ts): that job must leave a person's alt text and caption alone.
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/image-text.test.ts
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// The model providers can't run under Node (see test/ai.test.mjs): the same stand-in as src/ai/text-hash.test.ts,
// whose chat() throws, so a model call fails the test.
const PROVIDERS_STAND_IN = `data:text/javascript,${encodeURIComponent(
	'export const PROVIDERS = [{ id: "workers-ai", label: "Workers AI", textModel: "t", visionModel: "v" }, { id: "anthropic", label: "Anthropic", textModel: "t", visionModel: "v" }]; export const PROVIDER_HOSTS = []; export async function chat() { throw new Error("no model calls in tests"); } export async function listModels() { return []; }',
)}`;
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "./providers.js" && context.parentURL?.includes("/src/ai/")) return { url: PROVIDERS_STAND_IN, shortCircuit: true };
		return next(specifier, context);
	},
});
// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
const worker = (await import("./worker.ts")) as typeof import("./worker.js");
// @ts-ignore -- as above.
const pack = (await import("./pack.ts")) as typeof import("./pack.js");

type Settings = Parameters<typeof worker.analyzeMedia>[2];
type Job = import("./logic.js").QueueJob;
type Ctx = Parameters<typeof worker.analyzeMedia>[0];

interface Media {
	id: string;
	filename: string;
	mimeType: string;
	url: string;
	alt?: string;
	caption?: string;
}

/** A plugin context with one media item: records metadata writes, aiMedia/aiQueue writes and any other media access. */
function context(media: Media) {
	const item = { ...media };
	const writes: Array<Record<string, string>> = [];
	const stored: Record<string, Array<[string, unknown]>> = { aiMedia: [], aiQueue: [] };
	const collection = (name: string) => ({
		put: async (id: string, value: unknown) => void stored[name]?.push([id, value]),
		get: async () => null,
		delete: async () => true,
	});
	const ctx = {
		media: {
			get: async (id: string) => (id === item.id ? { ...item } : null),
			updateMetadata: async (_id: string, patch: Record<string, string>) => {
				writes.push(patch);
				Object.assign(item, patch);
			},
			getUploadUrl: () => assert.fail("the image was fetched"),
		},
		storage: { aiMedia: collection("aiMedia"), aiQueue: collection("aiQueue") },
		kv: { get: async () => null, set: async () => undefined },
		log: { info() {}, warn() {}, error() {}, debug() {} },
	};
	return { ctx: ctx as unknown as Ctx, item, writes, stored };
}

const settings = (over: Partial<Settings> = {}) => ({ imageMode: "apply", imageCaption: true, imageOverwrite: false, ...over }) as Settings;
const job = (over: Partial<Job> = {}): Job => ({ kind: "media", mediaId: "m1", due: 0, attempts: 0, enqueuedAt: 0, ...over });
const budget = {} as Parameters<typeof worker.analyzeMedia>[4];
const options = {} as Parameters<typeof worker.analyzeMedia>[1];
const photo: Media = { id: "m1", filename: "fox.jpg", mimeType: "image/jpeg", url: "https://media.example.com/fox.jpg" };

/** Run with fetch disallowed: the image bytes and the model are both fetched, so neither happens. */
async function withoutFetch<T>(fn: () => Promise<T>): Promise<T> {
	const real = globalThis.fetch;
	globalThis.fetch = (async () => assert.fail("fetch was called")) as typeof fetch;
	try {
		return await fn();
	} finally {
		globalThis.fetch = real;
	}
}

test("a replaced image queues an image-text job, as an upload does (EmDash 1.6.0 runs media:afterUpload on replace)", async () => {
	const { ctx, stored } = context(photo);
	const hook = pack.aiPack({}).hooks!["media:afterUpload"] as unknown as (event: unknown, ctx: Ctx) => Promise<void>;
	await hook({ media: { id: "m1", mimeType: "image/jpeg" } }, ctx);
	assert.deepEqual(
		stored.aiQueue.map(([id, value]) => [id, (value as Job).kind, (value as Job).force ?? false]),
		[["media:m1", "media", false]],
	);
});

test("the job for an image whose alt text and caption a person wrote is skipped: no image fetched, no model call, nothing written", async () => {
	const { ctx, item, writes, stored } = context({ ...photo, alt: "A red fox in snow", caption: "Taken by Jon" });
	assert.equal(await withoutFetch(() => worker.analyzeMedia(ctx, options, settings(), job(), budget)), "skipped");
	assert.deepEqual(writes, []);
	assert.deepEqual(stored.aiMedia, []);
	assert.equal(item.alt, "A red fox in snow");
	assert.equal(item.caption, "Taken by Jon");
});

test("with captions off, a person's alt text alone is enough: skipped", async () => {
	const { ctx, writes } = context({ ...photo, alt: "A red fox in snow" });
	assert.equal(await withoutFetch(() => worker.analyzeMedia(ctx, options, settings({ imageCaption: false }), job(), budget)), "skipped");
	assert.deepEqual(writes, []);
});

test("an image missing only its caption gets the caption; the person's alt text is kept", async () => {
	const { ctx, item, writes } = context({ ...photo, alt: "A red fox in snow" });
	assert.deepEqual(await worker.applyImageText(ctx, "m1", { alt: "Fox", caption: "A fox crossing a field" }, { caption: true, overwrite: false }), ["caption"]);
	assert.deepEqual(writes, [{ caption: "A fox crossing a field" }]);
	assert.equal(item.alt, "A red fox in snow");
});

test("whitespace isn't text: an alt of spaces is filled", async () => {
	const { ctx, writes } = context({ ...photo, alt: "   ", caption: "Taken by Jon" });
	assert.deepEqual(await worker.applyImageText(ctx, "m1", { alt: "Fox", caption: "A fox" }, { caption: true, overwrite: false }), ["alt"]);
	assert.deepEqual(writes, [{ alt: "Fox" }]);
});

test("only Overwrite replaces a person's text", async () => {
	const { ctx, writes } = context({ ...photo, alt: "A red fox in snow", caption: "Taken by Jon" });
	assert.deepEqual(await worker.applyImageText(ctx, "m1", { alt: "Fox", caption: "A fox" }, { caption: true, overwrite: true }), ["alt", "caption"]);
	assert.deepEqual(writes, [{ alt: "Fox", caption: "A fox" }]);
});

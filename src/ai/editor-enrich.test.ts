/**
 * Unit tests for AI Enrich, the entry editor's button (src/ai/editor-enrich.ts),
 * and the publish that follows it (src/ai/pack.ts): the toasts, one patch with
 * links and image text, nothing paid for twice, the analysis staged (never in
 * aiEntries) and promoted by the publish, and the planned links settled then.
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/editor-enrich.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as G from "./glossary.ts";
// @ts-ignore -- as above.
import * as GL from "./glossary-links.ts";

const glossary = G as typeof import("./glossary.js");
const links = GL as typeof import("./glossary-links.js");

// The model providers can't run under Node (see test/ai.test.mjs): a stand-in whose chat() answers from
// globalThis.__aiChat, so each test says what the model returns.
const PROVIDERS_STAND_IN = `data:text/javascript,${encodeURIComponent(
	'export const PROVIDERS = [{ id: "workers-ai", label: "Workers AI", textModel: "t", visionModel: "v" }, { id: "anthropic", label: "Anthropic", textModel: "t", visionModel: "v" }]; export const PROVIDER_HOSTS = []; export async function chat(cfg, req) { const answer = globalThis.__aiChat; if (!answer) throw new Error("no model calls in tests"); return answer(req); } export async function listModels() { return []; }',
)}`;
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "./providers.js" && context.parentURL?.includes("/src/ai/")) return { url: PROVIDERS_STAND_IN, shortCircuit: true };
		return next(specifier, context);
	},
});
// @ts-ignore -- as above.
const pack = (await import("./pack.ts")) as typeof import("./pack.js");
// @ts-ignore -- as above.
const routes = (await import("./routes.ts")) as typeof import("./routes.js");
// @ts-ignore -- as above.
const enrich = (await import("./editor-enrich.ts")) as typeof import("./editor-enrich.js");
// @ts-ignore -- as above.
const store = (await import("./store.ts")) as typeof import("./store.js");
// @ts-ignore -- as above.
const linker = (await import("./glossary-linker.ts")) as typeof import("./glossary-linker.js");

enrich.enrichIo.wait = async () => {};

type Answer = import("./editor-enrich.js").EnrichAnswer;
type ChatRequest = { system: string; user: string; image?: unknown; maxTokens: number; timeoutMs?: number };

// ── The model, Wikidata and glossary.io ──────────────────────────

const ENTITIES = [
	{ surface: "Fastmail", name: "Fastmail", type: "Organization", description: "An email service.", primary: true },
	{ surface: "Google", name: "Google", type: "Organization", description: "A technology company.", primary: false },
];
const QIDS: Record<string, string> = { Fastmail: "Q1", Google: "Q95", "Fastmail Inc.": "Q1", "Google LLC": "Q95" };

interface Model {
	calls: ChatRequest[];
	mentions: unknown[];
	fail?: (req: ChatRequest) => Error | null;
}

function model(more: Partial<Model> = {}): Model {
	const m: Model = { calls: [], mentions: ENTITIES, ...more };
	(globalThis as { __aiChat?: unknown }).__aiChat = async (req: ChatRequest) => {
		m.calls.push(req);
		const error = m.fail?.(req);
		if (error) throw error;
		assert.equal(req.timeoutMs, 40_000, "every call the button makes has its timeout");
		if (req.image) {
			const n = m.calls.filter((c) => c.image).length;
			return { text: JSON.stringify({ alt_text: `Model alt ${n}.`, title: `Title ${n}`, caption: `Model caption ${n}.` }), inputTokens: 1, outputTokens: 1 };
		}
		if (req.system.startsWith("You extract")) return { text: JSON.stringify(m.mentions), inputTokens: 1, outputTokens: 1 };
		if (req.system.startsWith("You write the meta description")) return { text: "A summary of the post.", inputTokens: 1, outputTokens: 1 };
		return { text: "{}", inputTokens: 1, outputTokens: 1 };
	};
	return m;
}
const visionCalls = (m: Model) => m.calls.filter((c) => c.image).length;
const textCalls = (m: Model) => m.calls.filter((c) => !c.image).length;

/** Wikidata: one candidate per name, and P31 "business" for every item asked about. `busy`: the next search answers 429. */
function wikidata(state: { busy?: boolean; searches: number }) {
	return async (url: string) => {
		const u = new URL(url);
		if (u.searchParams.get("action") === "wbsearchentities") {
			state.searches++;
			if (state.busy) {
				state.busy = false;
				return new Response("{}", { status: 429, headers: { "retry-after": "120" } });
			}
			const name = u.searchParams.get("search")!;
			return Response.json({ search: QIDS[name] ? [{ id: QIDS[name], label: name, description: "" }] : [] });
		}
		if (u.host === "query.wikidata.org") {
			const qids = [...(u.searchParams.get("query") ?? "").matchAll(/wd:(Q\d+)/g)].map((m) => m[1]);
			return Response.json({ results: { bindings: qids.map((q) => ({ item: { value: `http://www.wikidata.org/entity/${q}` }, class: { value: "http://www.wikidata.org/entity/Q4830453" } })) } });
		}
		return new Response("{}", { status: 404 });
	};
}

const INDEX = { fetchedAt: Date.now(), format: 2, terms: { Q1: ["fastmail", "An email service.", ["Fastmail"]], Q95: ["google", "A technology company.", ["Google"]] } };

// ── A fake site ──────────────────────────────────────────────────

type Row = { data: unknown; revision: number };
type Where = Record<string, unknown>;
const matches = (data: Record<string, unknown>, where: Where = {}) =>
	Object.entries(where).every(([field, cond]) => {
		const v = data[field] as string | number;
		if (cond && typeof cond === "object") {
			const c = cond as { lt?: string | number; lte?: string | number };
			return (c.lt === undefined || v < c.lt) && (c.lte === undefined || v <= c.lte);
		}
		return v === cond;
	});

function collection() {
	const rows = new Map<string, Row>();
	let seq = 0;
	const write = (id: string, data: unknown) => void rows.set(id, { data: structuredClone(data), revision: ++seq });
	return {
		rows,
		value: <T>(id: string) => rows.get(id)?.data as T | undefined,
		get: async (id: string) => structuredClone(rows.get(id)?.data ?? null),
		getMany: async (ids: string[]) => new Map(ids.filter((id) => rows.has(id)).map((id) => [id, structuredClone(rows.get(id)!.data)])),
		put: async (id: string, data: unknown) => write(id, data),
		delete: async (id: string) => rows.delete(id),
		deleteMany: async (ids: string[]) => ids.filter((id) => rows.delete(id)).length,
		getVersioned: async (id: string) => (rows.has(id) ? { value: structuredClone(rows.get(id)!.data), revision: String(rows.get(id)!.revision) } : null),
		compareAndSet: async (id: string, expected: string | null, data: unknown) => {
			if ((rows.has(id) ? String(rows.get(id)!.revision) : null) !== expected) return { applied: false };
			write(id, data);
			return { applied: true, revision: String(seq) };
		},
		count: async (where?: Where) => [...rows.values()].filter((r) => matches(r.data as Record<string, unknown>, where)).length,
		query: async (opts: { where?: Where; limit?: number } = {}) => {
			const items = [...rows].filter(([, r]) => matches(r.data as Record<string, unknown>, opts.where)).slice(0, opts.limit ?? 50);
			return { items: items.map(([id, r]) => ({ id, data: structuredClone(r.data) })), hasMore: false };
		},
	};
}

type Span = { _type: "span"; _key: string; text: string; marks: string[] };
const para = (key: string, text: string) => ({ _type: "block", _key: key, style: "normal", markDefs: [], children: [{ _type: "span", _key: `${key}s`, text, marks: [] } as Span] });
const img = (key: string, ref: string, more: Record<string, unknown> = {}) => ({ _type: "image", _key: key, asset: { _type: "reference", _ref: ref, url: `/_emdash/api/media/file/${key}.png` }, alt: "", ...more });

/** The post: two entities to link (one with a possessive), and images without text, with a person's alt, from the library and with a stored suggestion. */
const CONTENT = () => [
	para("b1", "I use Fastmail for email, and Google's search too."),
	img("i1", "M1"),
	img("i2", "M2", { alt: "A person wrote this." }),
	{ _type: "gallery", _key: "g1", images: [img("gi1", "M3")] },
];
const FEATURED = () => ({ id: "M4", provider: "local", alt: "", caption: "" });

interface Item {
	id: string;
	slug: string;
	status: string;
	data: Record<string, unknown>;
	seo?: { description: string | null };
	version: number;
	updatedAt: string;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
}

function fakeSite(opts: { features?: Record<string, boolean>; settings?: Record<string, unknown>; index?: boolean; status?: string; skip?: string[] } = {}) {
	const settings = new Map<string, unknown>([
		["features", opts.features ?? { ai: true, "ai.entities": true, "ai.glossaryLinks": true, "ai.imageText": true }],
		["aiProvider", "anthropic"],
		["aiApiKey", "test-key"],
		["aiCollections", "posts"],
		["aiDebounceMinutes", 2],
		...Object.entries(opts.settings ?? {}),
	]);
	const kv = new Map<string, { value: unknown; revision: string }>();
	let kvRevision = 0;
	const storage = {
		aiQueue: collection(),
		aiEntries: collection(),
		aiMedia: collection(),
		aiUsage: collection(),
		aiGlossary: collection(),
		aiLinks: collection(),
		aiDrafts: collection(),
	};
	if (opts.index !== false) storage.aiGlossary.rows.set("index", { data: INDEX, revision: 0 });
	const library = new Map<string, Record<string, unknown>>([
		["M1", { id: "M1", filename: "one.png", mimeType: "image/png", url: "/_emdash/api/media/file/one.png", alt: "", caption: "" }],
		["M2", { id: "M2", filename: "two.png", mimeType: "image/png", url: "/_emdash/api/media/file/two.png", alt: "", caption: "" }],
		["M3", { id: "M3", filename: "three.png", mimeType: "image/png", url: "/_emdash/api/media/file/three.png", alt: "", caption: "" }],
		["M4", { id: "M4", filename: "four.png", mimeType: "image/png", url: "/_emdash/api/media/file/four.png", alt: "Library alt for the featured image.", caption: "" }],
		["SVG", { id: "SVG", filename: "logo.svg", mimeType: "image/svg+xml", url: "/_emdash/api/media/file/logo.svg", alt: "", caption: "" }],
	]);
	storage.aiMedia.rows.set("M3", { data: { mediaId: "M3", filename: "three.png", url: "", suggestion: { alt: "Stored alt for three.", caption: "Stored caption for three.", title: "Three" }, status: "suggested", written: [], error: "", updated: "2026-11-01T00:00:00.000Z" }, revision: 0 });
	const wd = { searches: 0, busy: false };
	const item: Item = { id: "E1", slug: "post", status: opts.status ?? "draft", data: { title: "Email I like", content: [para("b0", "Saved text.")], excerpt: "", featured_image: null }, seo: { description: null }, version: 1, updatedAt: "2026-11-20T00:00:00.000Z", liveRevisionId: null, draftRevisionId: null };
	const items = new Map<string, Item>([["posts:E1", item]]);
	const log: string[] = [];
	const logged = (level: string) => (message: string, data?: unknown) => void log.push(`${level} ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
	const ctx = {
		site: { url: "https://coywolf.com", name: "Coywolf", locale: "en" },
		settings: { get: async (key: string) => structuredClone(settings.get(key) ?? null) },
		kv: {
			get: async (k: string) => structuredClone(kv.get(k)?.value ?? null),
			set: async (k: string, value: unknown) => void kv.set(k, { value: structuredClone(value), revision: String(++kvRevision) }),
			delete: async (k: string) => kv.delete(k),
			getVersioned: async (k: string) => (kv.has(k) ? structuredClone(kv.get(k)!) : null),
			compareAndSet: async (k: string, rev: string | null, value: unknown) => {
				if ((kv.get(k)?.revision ?? null) !== rev) return { applied: false };
				kv.set(k, { value: structuredClone(value), revision: String(++kvRevision) });
				return { applied: true };
			},
			compareAndDelete: async (k: string, rev: string) => {
				if (kv.get(k)?.revision === rev) kv.delete(k);
				return true;
			},
		},
		log: { info: logged("info"), warn: logged("warn"), error: logged("error"), debug: logged("debug") },
		schema: {
			getCollection: async (slug: string) =>
				slug === "posts"
					? {
							slug: "posts",
							hasSeo: true,
							titleField: "title",
							supports: ["revisions", "drafts"],
							fields: [
								{ slug: "title", type: "string", sortOrder: 0, translatable: true },
								{ slug: "content", type: "portableText", sortOrder: 1, translatable: true },
								{ slug: "excerpt", type: "text", sortOrder: 2, translatable: true },
								{ slug: "featured_image", type: "image", sortOrder: 3, translatable: true },
							],
						}
					: null,
			listCollections: async () => [{ slug: "posts", routable: true, hidden: false }],
		},
		storage,
		http: { fetch: wikidata(wd) },
		content: {
			get: async (c: string, id: string) => structuredClone(items.get(`${c}:${id}`) ?? null),
			getRevision: async () => null,
		},
		media: {
			get: async (id: string) => structuredClone(library.get(id) ?? null),
			readBytes: async (id: string) => ({ bytes: new Uint8Array([1, 2, 3]), filename: String(library.get(id)?.filename), mimeType: "image/png", size: 3 }),
			updateMetadata: async (id: string, patch: Record<string, unknown>) => {
				library.set(id, { ...library.get(id)!, ...patch });
				return library.get(id);
			},
		},
	};
	const options = { glossaryLinks: { skip: opts.skip ?? [] } };
	return {
		ctx: ctx as never,
		options,
		settings,
		kv,
		storage,
		library,
		item,
		log,
		wd,
		calls: () => store.callsToday(ctx as never),
		/** A click with the editor's draft (EmDash's snapshot, as the companion plugin hands it on). */
		click: (fields: Record<string, unknown> = { title: "Email I like", content: CONTENT(), excerpt: "", featured_image: FEATURED() }, patch: { fields?: string[]; translatable?: true } = { translatable: true }) =>
			routes.aiRoutes(options)["ai/editor-enrich"].handler({ ...ctx, input: { draft: { collection: "posts", entryId: "E1", locale: null, baseRevision: "rev-1", invocationId: "inv-0123456789abcdef", fields, fieldDefinitions: [] }, patch } } as never) as Promise<Answer>,
		/** The entry published with these fields (EmDash's afterPublish content). */
		publish: async (data: Record<string, unknown>, more: Partial<Item> = {}) => {
			const live: Item = { ...item, ...more, status: "published", data, liveRevisionId: "R2", draftRevisionId: "R2" };
			items.set("posts:E1", live);
			await (pack.aiPack(options).hooks!["content:afterPublish"] as unknown as (event: unknown, ctx: unknown) => Promise<void>)({ content: structuredClone(live), collection: "posts" }, ctx);
		},
	};
}

type Site = ReturnType<typeof fakeSite>;

const valueOf = (answer: Answer, field: string) => answer.patch?.operations.find((o) => o.field === field)?.value;
/** The patched draft, as the editor holds it once the person applies the patch. */
const applied = (fields: Record<string, unknown>, answer: Answer) => ({ ...fields, ...Object.fromEntries((answer.patch?.operations ?? []).map((o) => [o.field, o.value])) });
const draftFields = () => ({ title: "Email I like", content: CONTENT(), excerpt: "", featured_image: FEATURED() });
const node = (content: unknown, ...path: Array<string | number>) => path.reduce<unknown>((v, step) => (v as Record<string | number, unknown>)[step], content) as Record<string, unknown>;

function linksOf(content: unknown): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const b of content as Array<{ children?: Span[]; markDefs?: Array<{ _key: string; href: string }> }>) {
		if (!b.children) continue;
		const defs = new Map((b.markDefs ?? []).map((d) => [d._key, d.href]));
		let cur: [string, string] | null = null;
		for (const c of b.children) {
			const href = c.marks.map((m) => defs.get(m)).find(Boolean);
			if (href && cur && cur[1] === href) cur[0] += c.text;
			else if (href) out.push((cur = [c.text, href]));
			else cur = null;
		}
	}
	return out;
}

function reset() {
	glossary.resetGlossaryForTests();
}

// ── The click ────────────────────────────────────────────────────

test("a click: one patch with the glossary.io links (possessive inside) and the missing alt text and captions; text a person wrote stays", async () => {
	reset();
	const site = fakeSite();
	const m = model();
	const answer = await site.click();
	assert.equal(answer.toast.type, "success");
	assert.match(answer.toast.message, /^Added 2 glossary\.io links \((Fastmail, Google|Google, Fastmail)\)\. Wrote alt text for 3 and captions for 4 of 4 images\. Review the changes, then save\.$/);
	// One set per field, and only fields the draft sent.
	assert.deepEqual(answer.patch!.operations.map((o) => [o.op, o.field]), [["set", "content"], ["set", "featured_image"]]);
	const content = valueOf(answer, "content") as unknown[];
	assert.deepEqual(linksOf(content), [["Fastmail", "https://glossary.io/fastmail/"], ["Google's", "https://glossary.io/google/"]]);
	assert.equal(links.bodyText(content), links.bodyText(CONTENT()), "links never change the text");
	// Images: the model's text where nothing else had any, a stored suggestion reused, the library's alt text reused, a person's alt kept.
	assert.match(String(node(content, 1).alt), /^Model alt \d\.$/);
	assert.match(String(node(content, 1).caption), /^Model caption \d\.$/);
	assert.equal(node(content, 2).alt, "A person wrote this.");
	assert.match(String(node(content, 2).caption), /^Model caption \d\.$/);
	assert.deepEqual([node(content, 3, "images", 0).alt, node(content, 3, "images", 0).caption], ["Stored alt for three.", "Stored caption for three."]);
	const featured = valueOf(answer, "featured_image") as Record<string, unknown>;
	assert.equal(featured.alt, "Library alt for the featured image.");
	assert.match(String(featured.caption), /^Model caption \d\.$/);
	// Paid for: the entity extraction and three images (the stored suggestion and the library's alt cost nothing).
	assert.equal(textCalls(m), 1);
	assert.equal(visionCalls(m), 3);
	assert.equal(await site.calls(), 4);

	// Staged, never in aiEntries; nothing counted as linked; the planned links wait for the publish.
	assert.equal(site.storage.aiEntries.rows.size, 0, "the live entry's analysis is untouched");
	const staged = site.storage.aiDrafts.value<import("./store.js").DraftRecord>("posts:E1")!;
	assert.equal(staged.textHashes.length, 2, "before and after the captions");
	assert.deepEqual(staged.entities.map((e) => e.qid), ["Q1", "Q95"]);
	assert.equal(staged.partial, undefined);
	const memo = site.storage.aiLinks.value<import("./glossary-linker.js").LinkMemo>("posts:E1")!;
	assert.deepEqual(memo.linked, []);
	assert.deepEqual(memo.planned?.qids, ["Q1", "Q95"]);
	assert.deepEqual(memo.planned?.slugs, ["fastmail", "google"]);
	assert.equal(memo.textHash, undefined);
	// Image text: recorded, the library's empty alt filled (Fill empty alt text automatically), captions not (Also write captions is off).
	assert.equal(site.storage.aiMedia.value<{ status: string }>("M1")?.status, "applied");
	assert.equal(site.library.get("M1")!.alt, node(content, 1).alt);
	assert.equal(site.library.get("M1")!.caption, "");
	assert.equal(site.library.get("M4")!.alt, "Library alt for the featured image.", "a library's own alt text is never replaced");
	assert.equal(site.kv.has("state:ai:editor:posts:E1"), false, "the entry's lock is released");
});

test("a second click pays for nothing: the staged analysis and the stored image text are reused", async () => {
	reset();
	const site = fakeSite();
	const m = model();
	const first = await site.click();
	const paid = m.calls.length;
	// The same draft again (the patch was cancelled): the same patch (new mark keys aside), free.
	const again = await site.click();
	assert.equal(m.calls.length, paid);
	assert.equal(again.toast.message, first.toast.message);
	assert.deepEqual(linksOf(valueOf(again, "content")), linksOf(valueOf(first, "content")));
	assert.deepEqual(valueOf(again, "featured_image"), valueOf(first, "featured_image"));
	for (const path of [[1], [2], [3, "images", 0]]) {
		assert.deepEqual([node(valueOf(again, "content"), ...path).alt, node(valueOf(again, "content"), ...path).caption], [node(valueOf(first, "content"), ...path).alt, node(valueOf(first, "content"), ...path).caption]);
	}
	// The patched draft: nothing left to add.
	const done = await site.click(applied(draftFields(), first));
	assert.equal(m.calls.length, paid);
	assert.deepEqual(done, { toast: { type: "info", message: enrich.TOASTS.nothingToAdd } });
	assert.equal(site.storage.aiEntries.rows.size, 0);
	assert.deepEqual(site.storage.aiLinks.value<import("./glossary-linker.js").LinkMemo>("posts:E1")!.planned?.qids, ["Q1", "Q95"], "links already in the draft stay planned");
});

test("the toasts for what stops a click before any work", async () => {
	reset();
	model();
	const draftless = fakeSite();
	const raw = await routes.aiRoutes({})["ai/editor-enrich"].handler({ ...(draftless.ctx as object), input: {} } as never);
	assert.deepEqual(raw, { toast: { type: "error", message: enrich.TOASTS.noDraft } });

	const off = fakeSite({ features: { ai: true, "ai.entities": true, "ai.descriptions": true } });
	assert.deepEqual(await off.click(), { toast: { type: "info", message: enrich.TOASTS.off } });

	const keyless = fakeSite({ settings: { aiApiKey: "" } });
	assert.deepEqual(await keyless.click(), { toast: { type: "error", message: enrich.TOASTS.noKey } });

	const workersAi = fakeSite({ settings: { aiProvider: "workers-ai" } });
	assert.deepEqual(await workersAi.click(), { toast: { type: "error", message: enrich.TOASTS.noKey } }, "Workers AI without its binding");

	const uncovered = fakeSite({ settings: { aiCollections: "pages" } });
	assert.deepEqual(await uncovered.click(), { toast: { type: "info", message: enrich.TOASTS.notCovered } });

	const gone = fakeSite();
	(gone.ctx as { content: { get: unknown } }).content.get = async () => null;
	assert.deepEqual(await gone.click(), { toast: { type: "error", message: enrich.TOASTS.unreadable } });

	const busy = fakeSite();
	busy.kv.set("state:ai:editor:posts:E1", { value: { until: Date.now() + 60_000, token: "another click" }, revision: "1" });
	assert.deepEqual(await busy.click(), { toast: { type: "info", message: enrich.TOASTS.running } });

	const empty = fakeSite();
	assert.deepEqual(await empty.click({ title: "", content: [], excerpt: "", featured_image: null }), { toast: { type: "info", message: enrich.TOASTS.nothingThere } });

	const skipped = fakeSite({ skip: ["post"], features: { ai: true, "ai.entities": true, "ai.glossaryLinks": true } });
	assert.deepEqual(await skipped.click(), { toast: { type: "info", message: "Nothing to add: this entry is on the glossary.io links skip list." } });
});

test("the daily limit: no model call, and what could still be done is in the patch", async () => {
	reset();
	const m = model();
	const site = fakeSite({ settings: { aiMaxCallsPerDay: 1 } });
	site.kv.set(`state:ai:calls:${new Date().toISOString().slice(0, 10)}`, { value: 1, revision: "1" });
	const answer = await site.click();
	assert.equal(m.calls.length, 0);
	assert.equal(answer.toast.type, "error");
	assert.equal(answer.toast.message, `${enrich.TOASTS.limit} Wrote alt text for 2 and captions for 1 of 4 images. Review the changes, then save.`);
	const content = valueOf(answer, "content") as unknown[];
	assert.equal(linksOf(content).length, 0);
	assert.equal(node(content, 3, "images", 0).alt, "Stored alt for three.");
	assert.equal((valueOf(answer, "featured_image") as Record<string, unknown>).alt, "Library alt for the featured image.");
	assert.equal(site.storage.aiDrafts.value<{ partial?: true }>("posts:E1")?.partial, true);
});

test("Wikidata asking to slow down keeps what the click paid for: the next click doesn't pay for it again", async () => {
	reset();
	// Names this file's other tests haven't looked up (Wikidata searches are cached per isolate).
	const m = model({ mentions: [{ ...ENTITIES[0], name: "Fastmail Inc." }, { ...ENTITIES[1], name: "Google LLC" }] });
	const site = fakeSite({ features: { ai: true, "ai.entities": true, "ai.glossaryLinks": true } });
	site.wd.busy = true;
	const first = await site.click();
	assert.equal(first.toast.type, "info");
	assert.equal(first.toast.message, "Wikidata asked to slow down. Try again in 2 minutes.");
	assert.equal(first.patch, undefined);
	assert.equal(textCalls(m), 1, "the extraction was paid for");
	const staged = site.storage.aiDrafts.value<import("./store.js").DraftRecord>("posts:E1")!;
	assert.equal(staged.partial, true);
	assert.equal(staged.cache?.mentions?.length, 2);
	assert.ok((site.kv.get("state:ai:wikidataBusyUntil")?.value as number) > Date.now(), "every entry job waits too");
	// Still busy: the button waits too, without a call.
	assert.match((await site.click()).toast.message, /^Wikidata asked to slow down/);
	assert.equal(textCalls(m), 1);
	site.kv.delete("state:ai:wikidataBusyUntil");
	const second = await site.click();
	assert.equal(textCalls(m), 1, "the extraction came from the stage cache");
	assert.match(second.toast.message, /^Added 2 glossary\.io links/);
	assert.equal(site.storage.aiDrafts.value<{ partial?: true }>("posts:E1")?.partial, undefined);
});

test("a model error: a toast, the image text that worked, nothing staged as complete", async () => {
	reset();
	model({ fail: (req) => (req.system.startsWith("You extract") ? new Error("Anthropic returned HTTP 529: Overloaded") : null) });
	const site = fakeSite();
	const answer = await site.click();
	assert.equal(answer.toast.type, "error");
	assert.match(answer.toast.message, /^The AI service didn't answer: Anthropic returned HTTP 529: Overloaded\. Nothing was charged twice; click again to retry\. Wrote alt text for 3 and captions for 4 of 4 images\. Review the changes, then save\.$/);
	assert.equal(site.storage.aiDrafts.value<{ partial?: true }>("posts:E1")?.partial, true);
	assert.equal(site.storage.aiEntries.rows.size, 0);
	assert.equal(site.storage.aiLinks.rows.size, 0, "no links planned");
});

test("no glossary.io index yet: no links, the images still get their text", async () => {
	reset();
	model();
	const site = fakeSite({ index: false });
	(site.ctx as { http: { fetch: unknown } }).http.fetch = async (url: string) => (url.includes("glossary.io") ? new Response("", { status: 503 }) : wikidata(site.wd)(url));
	const answer = await site.click();
	assert.equal(answer.toast.type, "info");
	assert.ok(answer.toast.message.startsWith(enrich.TOASTS.noIndex));
	assert.equal(linksOf(valueOf(answer, "content")).length, 0);
	assert.match(String(node(valueOf(answer, "content"), 1).alt), /^Model alt \d\.$/);
	assert.equal(site.storage.aiLinks.rows.size, 0);
	assert.equal(site.storage.aiDrafts.value<{ partial?: true }>("posts:E1")?.partial, undefined, "the analysis itself is complete");
});

test("no entities: no links to add, and the image text", async () => {
	reset();
	model({ mentions: [] });
	const site = fakeSite();
	const answer = await site.click();
	assert.equal(answer.toast.type, "info");
	assert.equal(answer.toast.message, `${enrich.TOASTS.noEntities} Wrote alt text for 3 and captions for 4 of 4 images. Review the changes, then save.`);
});

test("images: at most 8 described per click, the rest on the next; dismissed and SVG images are left alone", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: { ai: true, "ai.imageText": true } });
	for (let i = 0; i < 10; i++) site.library.set(`N${i}`, { id: `N${i}`, filename: `n${i}.png`, mimeType: "image/png", url: `/_emdash/api/media/file/n${i}.png`, alt: "", caption: "" });
	site.storage.aiMedia.rows.set("M1", { data: { mediaId: "M1", filename: "one.png", url: "", suggestion: { alt: "Dismissed.", caption: "Dismissed.", title: "" }, status: "dismissed", written: [], error: "", updated: "" }, revision: 0 });
	const content = [para("b1", "Pictures."), img("d", "M1"), img("svg", "SVG"), ...Array.from({ length: 10 }, (_, i) => img(`n${i}`, `N${i}`))];
	const first = await site.click({ title: "Pictures", content, excerpt: "", featured_image: null });
	assert.equal(visionCalls(m), 8);
	assert.equal(first.toast.type, "success");
	assert.equal(first.toast.message, "Wrote image text for 8 of 12 images. Click AI Enrich again for the rest. Review the changes, then save.");
	const patched = valueOf(first, "content") as unknown[];
	assert.equal(node(patched, 1).alt, "", "a dismissed suggestion isn't used, and the image isn't described again");
	assert.equal(node(patched, 2).alt, "", "SVGs get no image text");
	const second = await site.click({ title: "Pictures", content: patched, excerpt: "", featured_image: null });
	assert.equal(visionCalls(m), 10, "the last two");
	assert.equal(second.toast.message, "Wrote alt text for 2 and captions for 2 of 4 images. Review the changes, then save.");
});

test("over EmDash's 64 KB for a field: captions go first, then alt text, then the field; other fields still go", async () => {
	reset();
	model({ mentions: [] });
	const site = fakeSite({ features: { ai: true, "ai.imageText": true } });
	// @ts-ignore -- as above.
	const { jsonBytes, withImageText } = (await import("./editor-images.ts")) as typeof import("./editor-images.js");
	const base = (pad: number) => [para("b1", "x".repeat(pad)), img("i1", "M1")];
	// Room for the alt text the model writes, not for the caption too.
	let pad = 65_536 - jsonBytes(withImageText(base(0), [{ path: [1], alt: "Model alt 1." }])) - 5;
	const answer = await site.click({ title: "Big", content: base(pad), excerpt: "", featured_image: FEATURED() });
	assert.equal(answer.toast.type, "info");
	assert.equal(answer.toast.message, `${enrich.TOASTS.tooBig} Wrote alt text for 2 and captions for 1 of 2 images. Review the changes, then save.`);
	const value = valueOf(answer, "content");
	assert.ok(jsonBytes(value) <= 65_536);
	assert.match(String(node(value, 1).alt), /^Model alt \d\.$/);
	assert.equal(node(value, 1).caption, undefined);
	assert.ok(valueOf(answer, "featured_image"));

	// A field already too big for anything: no patch for it.
	pad = 70_000;
	const big = await site.click({ title: "Big", content: base(pad), excerpt: "", featured_image: FEATURED() });
	assert.equal(valueOf(big, "content"), undefined);
	assert.deepEqual(big.patch?.operations.map((o) => o.field), ["featured_image"]);
	assert.ok(big.toast.message.startsWith(enrich.TOASTS.tooBig));
});

test("EmDash accepts the answer: its action response check and its patch check for each field", async () => {
	reset();
	model();
	const site = fakeSite();
	const answer = await site.click();
	const { validateContentEditorActionResponse } = await import("@emdash-cms/blocks/server");
	const check = validateContentEditorActionResponse(answer, { pluginPagePaths: [], allowedImageHosts: [] });
	assert.deepEqual([...check.errors], []);
	assert.equal(check.valid, true);
	const validateEditorDraftPatch = await emdashDistFunction("validateEditorDraftPatch");
	const collection = { slug: "posts", fields: [{ slug: "content", type: "portableText", required: false }, { slug: "featured_image", type: "image", required: false }] };
	const result = validateEditorDraftPatch({ patch: answer.patch, collection, allowedFields: new Set(["content", "featured_image"]) }) as { code?: string };
	assert.equal(result.code, undefined);
});

test("only the fields the button may patch, and only ones the draft sent", async () => {
	reset();
	model();
	const site = fakeSite();
	const answer = await site.click(undefined, { fields: ["content"] });
	assert.deepEqual(answer.patch!.operations.map((o) => o.field), ["content"]);
	const unsent = await site.click({ title: "Email I like", featured_image: FEATURED() }, { fields: ["content", "featured_image"] });
	assert.deepEqual(unsent.patch?.operations.map((o) => o.field), ["featured_image"], "content wasn't in the draft: patching it would overwrite unsaved edits");
});

test("a published entry with a pending draft: the fields the draft didn't send come from that draft revision, so the publish matches", async () => {
	reset();
	model();
	const site = fakeSite();
	Object.assign(site.item, { status: "published", liveRevisionId: "R1", draftRevisionId: "R5", data: { title: "Live title", content: [para("b0", "Live text.")], excerpt: "Live excerpt.", featured_image: null } });
	const revision = { title: "Draft title", content: [para("b0", "Draft text.")], excerpt: "Draft excerpt.", featured_image: null, _slug: "post" };
	(site.ctx as { content: { getRevision: unknown } }).content.getRevision = async (_c: string, _id: string, rev: string) => (rev === "R5" ? { data: structuredClone(revision) } : null);
	const answer = await site.click({ content: CONTENT() }, { fields: ["content"] });
	assert.match(answer.toast.message, /^Added 2 glossary\.io links/);
	await site.publish({ ...revision, ...applied({ content: CONTENT() }, answer) }, { liveRevisionId: "R5", draftRevisionId: "R5" });
	assert.equal(site.storage.aiQueue.rows.size, 0, "promoted: the title and excerpt came from the draft revision");
	assert.equal(site.storage.aiEntries.value<{ title: string }>("posts:E1")?.title, "Draft title");
});

// ── The publish ──────────────────────────────────────────────────

test("publishing the patched draft promotes the staged analysis: no new job, no model call, the planned links settled", async () => {
	reset();
	const m = model();
	const site = fakeSite();
	const answer = await site.click();
	const paid = m.calls.length;
	const before = Date.now();
	await site.publish(applied(draftFields(), answer));
	assert.equal(m.calls.length, paid);
	assert.equal(site.storage.aiQueue.rows.size, 0, "nothing queued");
	assert.equal(site.storage.aiDrafts.rows.size, 0, "the staged analysis is the entry's now");
	const record = site.storage.aiEntries.value<import("./store.js").EntryRecord>("posts:E1")!;
	assert.equal(record.status, "ok");
	assert.deepEqual(record.entities.map((e) => e.qid), ["Q1", "Q95"]);
	const memo = site.storage.aiLinks.value<import("./glossary-linker.js").LinkMemo>("posts:E1")!;
	assert.equal(memo.planned, undefined);
	assert.deepEqual(memo.linked, ["Q1", "Q95"]);
	assert.equal(memo.textHash, record.textHash);
	assert.ok(memo.retryAt! >= before + linker.LINK_CHECK_MS && memo.tries === 0, "checked once by the retry pass, a few minutes later");
	// The analysis matches what an analysis of the published text would record.
	// @ts-ignore -- as above.
	const worker = (await import("./worker.ts")) as typeof import("./worker.js");
	const t = await worker.entryText(site.ctx, "posts", applied(draftFields(), answer), await store.readSettings(site.ctx, {}), { ai: true, "ai.entities": true, "ai.glossaryLinks": true, "ai.imageText": true });
	assert.equal(record.textHash, t!.textHash);
	assert.equal(record.hash, t!.hash);
});

test("publishing without the patch (cancelled) promotes too, and the links are made by the retry pass; a hand-removed planned link stays out", async () => {
	reset();
	model();
	const site = fakeSite();
	await site.click();
	await site.publish(draftFields());
	assert.equal(site.storage.aiQueue.rows.size, 0, "the text before the patch is one of the staged hashes");
	const memo = site.storage.aiLinks.value<import("./glossary-linker.js").LinkMemo>("posts:E1")!;
	assert.deepEqual(memo.linked, [], "not applied: nothing counts as linked");
	assert.equal(typeof memo.retryAt, "number");

	// Applied, then the Google link taken out by hand before publishing.
	reset();
	const other = fakeSite();
	const answer = await other.click();
	const content = structuredClone(valueOf(answer, "content")) as Array<{ markDefs: Array<{ _key: string; href: string }>; children: Span[] }>;
	const google = content[0].markDefs.find((d) => d.href.includes("google"))!;
	content[0].markDefs = content[0].markDefs.filter((d) => d !== google);
	for (const c of content[0].children) c.marks = c.marks.filter((k) => k !== google._key);
	await other.publish({ ...applied(draftFields(), answer), content });
	assert.deepEqual(other.storage.aiLinks.value<import("./glossary-linker.js").LinkMemo>("posts:E1")!.linked, ["Q1", "Q95"], "Google stays unlinked");
	assert.equal(other.storage.aiQueue.rows.size, 0);
});

test("publishing text that changed after the click queues an analysis as before; the planned links only go", async () => {
	reset();
	model();
	const site = fakeSite();
	const answer = await site.click();
	const changed = applied(draftFields(), answer);
	(changed.content as unknown[]).push(para("b9", "A new paragraph."));
	await site.publish(changed);
	assert.equal(site.storage.aiQueue.rows.size, 1, "a normal save's job");
	assert.equal(site.storage.aiEntries.rows.size, 0);
	const memo = site.storage.aiLinks.value<import("./glossary-linker.js").LinkMemo>("posts:E1")!;
	assert.equal(memo.planned, undefined);
	assert.deepEqual(memo.linked, ["Q1", "Q95"], "applied");
	assert.equal(memo.textHash, undefined, "so that analysis still links");
	assert.equal(memo.retryAt, undefined);
	assert.equal(linker.shouldLink(memo, null, "any new text hash"), true);
});

test("Meta descriptions: the click writes one when the entry has none; the publish puts it with the analysis", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: { ai: true, "ai.entities": true, "ai.glossaryLinks": true, "ai.descriptions": true } });
	const answer = await site.click();
	assert.equal(textCalls(m), 2, "extraction and description, at once");
	assert.equal(site.storage.aiDrafts.value<{ description: string }>("posts:E1")?.description, "A summary of the post.");
	assert.equal(answer.patch?.operations.some((o) => o.field === "seo"), false, "the SEO panel isn't a field");
	await site.publish(applied(draftFields(), answer));
	const record = site.storage.aiEntries.value<import("./store.js").EntryRecord>("posts:E1")!;
	assert.equal(record.description, "A summary of the post.");
	assert.equal(record.descriptionStatus, "suggested");
	assert.equal(site.storage.aiQueue.rows.size, 0);
});

test("a staged analysis without descriptions isn't promoted once Meta descriptions is on; deleting the entry forgets it; old ones are pruned", async () => {
	reset();
	model();
	const site = fakeSite();
	const answer = await site.click();
	site.settings.set("features", { ai: true, "ai.entities": true, "ai.glossaryLinks": true, "ai.imageText": true, "ai.descriptions": true });
	await site.publish(applied(draftFields(), answer));
	assert.equal(site.storage.aiQueue.rows.size, 1, "analyzed as usual");
	assert.equal(site.storage.aiEntries.rows.size, 0);

	await (pack.aiPack({}).hooks!["content:afterDelete"] as unknown as (event: unknown, ctx: unknown) => Promise<void>)({ id: "E1", collection: "posts" }, site.ctx);
	assert.equal(site.storage.aiDrafts.rows.size, 0);

	site.storage.aiDrafts.rows.set("posts:OLD", { data: { updated: new Date(Date.now() - 31 * 86_400_000).toISOString() }, revision: 0 });
	site.storage.aiDrafts.rows.set("posts:NEW", { data: { updated: new Date().toISOString() }, revision: 0 });
	await store.pruneDrafts(site.ctx);
	assert.deepEqual([...site.storage.aiDrafts.rows.keys()], ["posts:NEW"]);
});

test("the editor's AI panel sees the staged analysis (ai/entry)", async () => {
	reset();
	model();
	const site = fakeSite();
	await site.click();
	const read = (await routes.aiRoutes({})["ai/entry"].handler({ ...(site.ctx as object), input: { collection: "posts", id: "E1" } } as never)) as { record: unknown; staged: { entities: unknown[] } | null };
	assert.equal(read.record, null);
	assert.equal(read.staged?.entities.length, 2);
});

// ── Helpers that need EmDash's dist ──────────────────────────────

/** A function EmDash's dist exports from a hashed chunk, found by name (as test/emdash-contract.test.mjs does). */
async function emdashDistFunction(name: string): Promise<(input: unknown) => unknown> {
	const here = dirname(fileURLToPath(import.meta.url));
	const dist = join(here, "../../node_modules/emdash/dist");
	for (const file of readdirSync(dist).filter((f) => f.endsWith(".mjs"))) {
		const src = readFileSync(join(dist, file), "utf8");
		if (!src.includes(`function ${name}(`)) continue;
		const exported = src.match(/export \{([^}]*)\};?\s*(?:\/\/# sourceMappingURL=.*)?$/)?.[1] ?? "";
		const entry = exported.split(",").map((s) => s.trim().split(/\s+as\s+/)).find(([local]) => local === name);
		if (entry) return (await import(pathToFileURL(join(dist, file)).href))[entry[1] ?? entry[0]];
	}
	throw new Error(`no ${name} in EmDash's dist`);
}

void ({} as Site);

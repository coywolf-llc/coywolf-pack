/**
 * Unit tests for AI Enrich, the button in the entry editor's AI suggestions
 * panel (src/ai/editor-enrich.ts), and the publish that follows it
 * (src/ai/pack.ts): the draft the panel sends (checked by type, host keys
 * apart, never written), the toasts, one patch with links, image text and an
 * empty meta description, the review and the rounds, nothing paid for twice,
 * the analysis staged (never in aiEntries) and promoted by the publish, and
 * the planned links settled then.
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
// @ts-ignore -- as above.
const worker = (await import("./worker.ts")) as typeof import("./worker.js");

enrich.enrichIo.wait = async () => {};
/** The entry lock's renewals, run by hand: a click here ends long before a real one would renew. */
const beats: Array<() => void> = [];
enrich.enrichIo.every = (_ms, beat) => {
	beats.push(beat);
	return () => void beats.splice(beats.indexOf(beat), 1);
};

type Answer = import("./editor-enrich.js").EnrichAnswer;
type ChatRequest = { system: string; user: string; image?: unknown; maxTokens: number; timeoutMs?: number };

// ── The model, Wikidata and glossary.io ──────────────────────────

const ENTITIES = [
	{ surface: "Fastmail", name: "Fastmail", type: "Organization", description: "An email service.", primary: true },
	{ surface: "Google", name: "Google", type: "Organization", description: "A technology company.", primary: false },
];
const QIDS: Record<string, string> = { Fastmail: "Q1", Google: "Q95", "Fastmail Inc.": "Q1", "Google LLC": "Q95" };

/** While an entry's queued job runs (the scheduled path: its calls have the providers' own timeouts). */
let automatic = false;

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
		if (!automatic) assert.equal(req.timeoutMs, 40_000, "every call the button makes has its timeout");
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

/** The draft revision every test click sends (editorDraft.get()'s): answers echo it. */
const REV = "draft-1:0";
/** The schema types of the fake collection's fields and of the editor's host keys (the snapshot's fieldDefinitions). */
const DRAFT_TYPES: Record<string, string> = { title: "string", content: "portableText", excerpt: "text", featured_image: "image", featured: "boolean", subtitle: "string", slug: "slug", "seo.title": "string", "seo.description": "text" };
/** The keys of the editor's draft that aren't collection fields. */
const HOST_KEYS = new Set(["slug", "seo.title", "seo.description"]);

function fakeSite(opts: { features?: Record<string, boolean>; settings?: Record<string, unknown>; index?: boolean; status?: string; skip?: string[]; extraFields?: Array<{ slug: string; type: string }> } = {}) {
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
	const revisions = new Map<string, Record<string, unknown>>();
	let revisionSeq = 0;
	/** The content writes made through the plugin's own content API (the pack's edits). */
	const writes: string[] = [];
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
			list: async (prefix = "") => [...kv].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: structuredClone(v.value) })),
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
								...(opts.extraFields ?? []).map((f, i) => ({ ...f, sortOrder: 4 + i, translatable: false })),
							],
						}
					: null,
			listCollections: async () => [{ slug: "posts", routable: true, hidden: false }],
		},
		storage,
		http: { fetch: wikidata(wd) },
		content: {
			// By id, or by slug as EmDash's own lookups allow.
			get: async (c: string, id: string) => structuredClone(items.get(`${c}:${id}`) ?? [...items.values()].find((i) => c === "posts" && i.slug === id) ?? null),
			getRevision: async (_c: string, _id: string, rev: string) => (revisions.has(rev) ? { data: structuredClone(revisions.get(rev)) } : null),
			// EmDash's plugin content writes, for a collection with revisions: an update makes a draft revision one version on
			// (an SEO-only one writes the SEO panel), and a publish makes it live and runs the content hooks.
			update: async (c: string, id: string, patch: Record<string, unknown>) => {
				const cur = items.get(`${c}:${id}`)!;
				writes.push(`update ${Object.keys(patch).join(",")}`);
				if (Object.keys(patch).every((k) => k === "seo")) {
					items.set(`${c}:${id}`, { ...cur, seo: { ...cur.seo, ...(patch.seo as { description: string }) }, version: cur.version + 1 });
					return structuredClone(items.get(`${c}:${id}`));
				}
				const rev = `D${++revisionSeq}`;
				revisions.set(rev, { ...cur.data, ...patch });
				items.set(`${c}:${id}`, { ...cur, version: cur.version + 1, draftRevisionId: rev, updatedAt: new Date().toISOString() });
				return structuredClone(items.get(`${c}:${id}`));
			},
			getVersioned: async (c: string, id: string) => {
				const cur = items.get(`${c}:${id}`);
				return cur ? { item: structuredClone(cur), _rev: `rev-${cur.version}` } : null;
			},
			publish: async (c: string, id: string, o: { _rev: string }) => {
				const cur = items.get(`${c}:${id}`)!;
				if (o._rev !== `rev-${cur.version}`) throw Object.assign(new Error("Content has been modified"), { code: "CONFLICT" });
				writes.push("publish");
				const live: Item = { ...cur, data: revisions.get(cur.draftRevisionId!) ?? cur.data, liveRevisionId: cur.draftRevisionId, draftRevisionId: null, version: cur.version + 1, updatedAt: new Date().toISOString() };
				items.set(`${c}:${id}`, live);
				const published = { item: structuredClone(live), _rev: `rev-${live.version}` };
				await (pack.aiPack(options).hooks!["content:afterPublish"] as unknown as (event: unknown, ctx: unknown) => Promise<void>)({ content: structuredClone(live), collection: c }, ctx);
				return published;
			},
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
	const send = (input: unknown) => routes.aiRoutes(options)["ai/editor-enrich"].handler({ ...ctx, input } as never) as Promise<Answer>;
	return {
		ctx: ctx as never,
		options,
		settings,
		kv,
		storage,
		library,
		item,
		items,
		writes,
		log,
		wd,
		/** The entry as it is now. */
		entry: () => items.get("posts:E1")!,
		hook: (name: "content:afterPublish" | "content:afterSave", content: unknown) => (pack.aiPack(options).hooks![name] as unknown as (event: unknown, ctx: unknown) => Promise<void>)({ content: structuredClone(content), collection: "posts" }, ctx),
		calls: () => store.callsToday(ctx as never),
		/**
		 * A click: the body the panel sends, with editorDraft.get()'s snapshot of `fields` and the host keys as the
		 * editor holds them (the slug, no SEO title, the SEO description saved now), `host` changing those (undefined
		 * leaves a key out).
		 */
		click: (fields: Record<string, unknown> = draftFields(), host: Record<string, unknown> = {}, entryId = "E1", round = 1) => {
			const now = items.get("posts:E1");
			const snapshot: Record<string, unknown> = { ...fields, slug: now?.slug ?? null, "seo.title": null, "seo.description": now?.seo?.description ?? null };
			for (const [key, value] of Object.entries(host)) {
				if (value === undefined) delete snapshot[key];
				else snapshot[key] = value;
			}
			const fieldDefinitions = Object.keys(snapshot).map((slug) => ({ slug, type: DRAFT_TYPES[slug] ?? "json", label: slug, required: false, translatable: true }));
			return send({ collection: "posts", entryId, draft: { revision: REV, fields: snapshot, fieldDefinitions }, round });
		},
		/** Any request body, as the route gets it. */
		send: (input: unknown) => send(input),
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
/** The patched draft's collection fields, as the editor holds them once the person applies the patch (the SEO panel holds seo.description). */
const applied = (fields: Record<string, unknown>, answer: Answer) => ({ ...fields, ...Object.fromEntries((answer.patch?.operations ?? []).filter((o) => !HOST_KEYS.has(o.field)).map((o) => [o.field, o.value])) });
function draftFields(): Record<string, unknown> {
	return { title: "Email I like", content: CONTENT(), excerpt: "", featured_image: FEATURED() };
}
/** An answer of a toast alone, for the test clicks' draft revision. */
const told = (type: "success" | "error" | "info", message: string, more: Record<string, unknown> = {}) => ({ toast: { type, message }, revision: REV, ...more });
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

	// The answer for the panel: its draft's revision, nothing more to do, and a review of exactly what the patch adds.
	assert.equal(answer.revision, REV);
	assert.equal(answer.more, undefined);
	assert.deepEqual(answer.progress, { imagesDone: 4, imagesTotal: 4 });
	const review = answer.review!;
	assert.deepEqual(review.links.map((l) => [l.name, l.url, l.field]).sort(), [["Fastmail", "https://glossary.io/fastmail/", "content"], ["Google", "https://glossary.io/google/", "content"]]);
	assert.deepEqual(review.links.map((l) => l.slug).sort(), ["fastmail", "google"]);
	assert.equal(review.possessives, 0, "a new link takes its possessive in (\"Google's\"): nothing to move");
	assert.deepEqual([review.leftAlone, review.remaining, review.description], [0, 0, undefined]);
	assert.deepEqual(
		review.images.map((i) => [i.field, i.mediaId, i.filename, Boolean(i.alt), Boolean(i.caption)]),
		[["featured_image", "M4", "four.png", true, true], ["content", "M1", "one.png", true, true], ["content", "M2", "two.png", false, true], ["content", "M3", "three.png", true, true]],
		"only what's added: M2's alt text is a person's",
	);
	assert.equal(review.images[0].alt, "Library alt for the featured image.");
	assert.equal(review.images[3].caption, "Stored caption for three.");
	// Every value has the shape EmDash's editor takes for its field (content-editor-draft.ts FIELD_TYPES).
	assertDraftShapes(answer);
	// Nothing from the draft is written to the entry: the route only answers.
	assert.deepEqual(site.writes, []);
});

/** Each operation's value has the shape EmDash 1.6's editorDraft.patch() takes for its field's type. */
function assertDraftShapes(answer: Answer) {
	for (const o of answer.patch?.operations ?? []) {
		assert.equal(o.op, "set");
		const type = DRAFT_TYPES[o.field];
		if (type === "portableText") assert.ok(Array.isArray(o.value) && o.value.every((b) => b && typeof b === "object" && typeof (b as { _type?: unknown })._type === "string"), o.field);
		else if (type === "image") assert.ok(o.value && typeof o.value === "object" && !Array.isArray(o.value), o.field);
		else if (o.field === "seo.description") assert.ok(typeof o.value === "string" && o.value.length <= 500, o.field);
		else assert.fail(`no operation should set ${o.field}`);
	}
}

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
	assert.deepEqual(done, told("info", enrich.TOASTS.nothingToAdd));
	assert.equal(site.storage.aiEntries.rows.size, 0);
	assert.deepEqual(site.storage.aiLinks.value<import("./glossary-linker.js").LinkMemo>("posts:E1")!.planned?.qids, ["Q1", "Q95"], "links already in the draft stay planned");
});

test("the toasts for what stops a click before any work", async () => {
	reset();
	model();
	const draftless = fakeSite();
	const raw = await routes.aiRoutes({})["ai/editor-enrich"].handler({ ...(draftless.ctx as object), input: {} } as never);
	assert.deepEqual(raw, { toast: { type: "error", message: enrich.TOASTS.noDraft } });
	for (const input of [null, "text", { collection: "posts", entryId: "E1" }, { collection: "posts", entryId: "", draft: { fields: {} } }, { collection: 1, entryId: "E1", draft: { fields: {} } }, { collection: "posts", entryId: "E1", draft: { fields: [] } }]) {
		assert.deepEqual(await draftless.send(input), { toast: { type: "error", message: enrich.TOASTS.noDraft } }, JSON.stringify(input));
	}

	const off = fakeSite({ features: { ai: true, "ai.entities": true, "ai.descriptions": true } });
	assert.deepEqual(await off.click(), told("info", enrich.TOASTS.off));

	const keyless = fakeSite({ settings: { aiApiKey: "" } });
	assert.deepEqual(await keyless.click(), told("error", enrich.TOASTS.noKey));

	const workersAi = fakeSite({ settings: { aiProvider: "workers-ai" } });
	assert.deepEqual(await workersAi.click(), told("error", enrich.TOASTS.noKey), "Workers AI without its binding");

	const uncovered = fakeSite({ settings: { aiCollections: "pages" } });
	assert.deepEqual(await uncovered.click(), told("info", enrich.TOASTS.notCovered));

	const gone = fakeSite();
	(gone.ctx as { content: { get: unknown } }).content.get = async () => null;
	assert.deepEqual(await gone.click(), told("error", enrich.TOASTS.unreadable));

	const busy = fakeSite();
	busy.kv.set("state:ai:editor:posts:E1", { value: { until: Date.now() + 60_000, token: "another click" }, revision: "1" });
	assert.deepEqual(await busy.click(), told("info", enrich.TOASTS.running, { running: true }), "the panel waits and asks again");

	const empty = fakeSite();
	assert.deepEqual(await empty.click({ title: "", content: [], excerpt: "", featured_image: null }), told("info", enrich.TOASTS.nothingThere));

	const skipped = fakeSite({ skip: ["post"], features: { ai: true, "ai.entities": true, "ai.glossaryLinks": true } });
	assert.deepEqual(await skipped.click(), told("info", "Nothing to add: this entry is on the glossary.io links skip list."));
});

test("a body over 2 MiB is refused before anything is read; a 103 KB field is patched whole (no size limits on a panel's patch)", async () => {
	reset();
	const m = model({ mentions: [] });
	const site = fakeSite({ features: { ai: true, "ai.imageText": true } });
	const huge = await site.click({ ...draftFields(), excerpt: "x".repeat(enrich.MAX_BODY_BYTES) });
	assert.deepEqual(huge, { toast: { type: "error", message: enrich.TOASTS.tooLarge } });
	assert.equal(m.calls.length, 0);

	// @ts-ignore -- as above.
	const { jsonBytes } = (await import("./editor-images.ts")) as typeof import("./editor-images.js");
	const content = [para("b1", "x".repeat(103_000)), img("i1", "M1")];
	const answer = await site.click({ title: "Big", content, excerpt: "", featured_image: FEATURED() });
	assert.equal(answer.toast.type, "success");
	assert.deepEqual(answer.patch?.operations.map((o) => o.field), ["content", "featured_image"]);
	const value = valueOf(answer, "content");
	assert.ok(jsonBytes(value) > 103_000);
	assert.match(String(node(value, 1).alt), /^Model alt \d\.$/);
	assert.match(String(node(value, 1).caption), /^Model caption \d\.$/);
	assert.equal((node(value, 0).children as Span[])[0].text.length, 103_000, "the text whole");
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
	assert.equal(answer.more, undefined, "the limit needs a person: no automatic round");
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
	assert.equal(first.more, undefined, "a busy Wikidata needs a wait: no automatic round");
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
	assert.match(answer.toast.message, /^The AI service didn't answer: Anthropic returned HTTP 529: Overloaded\. Click again to retry: what was already paid for is kept\. Wrote alt text for 3 and captions for 4 of 4 images\. Review the changes, then save\.$/);
	assert.equal(site.storage.aiDrafts.value<{ partial?: true }>("posts:E1")?.partial, true);
	assert.equal(site.storage.aiEntries.rows.size, 0);
	assert.equal(site.storage.aiLinks.rows.size, 0, "no links planned");
	assert.equal(answer.more, undefined, "a model error needs a person: no automatic round");
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
	assert.equal(first.more, true, "only the per-request cap stopped it: the panel asks again");
	assert.deepEqual(first.progress, { imagesDone: 8, imagesTotal: 10 });
	assert.deepEqual([first.review?.remaining, first.review?.leftAlone], [2, 2], "two still to do; the dismissed one and the SVG are left as they are");
	const patched = valueOf(first, "content") as unknown[];
	assert.equal(node(patched, 1).alt, "", "a dismissed suggestion isn't used, and the image isn't described again");
	assert.equal(node(patched, 2).alt, "", "SVGs get no image text");
	const second = await site.click({ title: "Pictures", content: patched, excerpt: "", featured_image: null });
	assert.equal(visionCalls(m), 10, "the last two");
	assert.equal(second.toast.message, "Wrote alt text for 2 and captions for 2 of 4 images. Review the changes, then save.");
	assert.equal(second.more, undefined);
});

test("the patch sets only rich text and image fields the draft sent, with a value of their type; anything else in the draft counts as absent", async () => {
	reset();
	model();
	const site = fakeSite();
	const unsent = await site.click({ title: "Email I like", featured_image: FEATURED() });
	assert.deepEqual(unsent.patch?.operations.map((o) => o.field), ["featured_image"], "content wasn't in the draft: patching it would overwrite unsaved edits");

	// Rich text that isn't an array of blocks, an image that isn't an object, a field the collection doesn't have: the
	// saved values are used for the analysis, and none of them is patched.
	const odd = await site.click({ title: "Email I like", content: "I use Fastmail.", excerpt: 5, featured_image: ["M4"], nonsense: CONTENT() });
	assert.equal(valueOf(odd, "content"), undefined);
	assert.equal(valueOf(odd, "featured_image"), undefined);
	assert.equal(valueOf(odd, "nonsense"), undefined);
	const staged = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	assert.ok(staged.textHashes.includes((await textOf(site, { ...site.item.data, title: "Email I like" })).textHash), "the saved text, under the draft's title");
	const blocks = await site.click({ title: "Email I like", content: [{ _key: "no type" }], excerpt: "", featured_image: null });
	assert.equal(valueOf(blocks, "content"), undefined, "a block without a string _type");
	assert.deepEqual(site.writes, []);
});

test("the host keys (slug, SEO title, SEO description) never reach the entry's data or its text hash, and only an empty description is ever patched", async () => {
	reset();
	model();
	const site = fakeSite({ features: LINKS_ONLY });
	const answer = await site.click(draftFields(), { slug: "another-slug", "seo.title": "An SEO title", "seo.description": "A description typed, not saved yet." });
	assert.deepEqual(answer.patch?.operations.map((o) => o.field), ["content"]);
	const staged = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	assert.ok(staged.textHashes.includes((await textOf(site, draftFields())).textHash));
	assert.deepEqual(site.writes, []);
	assert.equal(site.entry().slug, "post");
	assert.equal(site.entry().seo?.description, null);
	// A key with a dot that isn't one of EmDash's host keys: left out.
	const dotted = await site.click({ ...draftFields(), "seo.image": { id: "M1" } });
	assert.equal(valueOf(dotted, "seo.image"), undefined);
});

test("a published entry with a pending draft: the fields the draft didn't send come from that draft revision, so the publish matches", async () => {
	reset();
	model();
	const site = fakeSite();
	Object.assign(site.item, { status: "published", liveRevisionId: "R1", draftRevisionId: "R5", data: { title: "Live title", content: [para("b0", "Live text.")], excerpt: "Live excerpt.", featured_image: null } });
	const revision = { title: "Draft title", content: [para("b0", "Draft text.")], excerpt: "Draft excerpt.", featured_image: null, _slug: "post" };
	(site.ctx as { content: { getRevision: unknown } }).content.getRevision = async (_c: string, _id: string, rev: string) => (rev === "R5" ? { data: structuredClone(revision) } : null);
	const answer = await site.click({ content: CONTENT() });
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

test("Meta descriptions: the click fills an empty one (the review lists it); the publish marks it applied, suggested or dismissed by what's live", async () => {
	reset();
	const m = model();
	const DESCRIBED = { ai: true, "ai.entities": true, "ai.glossaryLinks": true, "ai.descriptions": true };
	const site = fakeSite({ features: DESCRIBED });
	const answer = await site.click();
	assert.equal(textCalls(m), 2, "extraction and description, at once");
	assert.equal(site.storage.aiDrafts.value<{ description: string }>("posts:E1")?.description, "A summary of the post.");
	assert.deepEqual(answer.patch?.operations.at(-1), { op: "set", field: "seo.description", value: "A summary of the post." }, "last, after the fields");
	assert.equal(answer.review?.description, "A summary of the post.");
	assert.match(answer.toast.message, /Wrote a meta description\./);
	assertDraftShapes(answer);
	// Applied: EmDash's SEO panel saves it at once, then the publish.
	await site.publish(applied(draftFields(), answer), { seo: { description: "A summary of the post." } });
	let record = site.storage.aiEntries.value<EntryRecord>("posts:E1")!;
	assert.deepEqual([record.description, record.descriptionStatus], ["A summary of the post.", "applied"]);
	assert.equal(site.storage.aiQueue.rows.size, 0);

	// The box off: nothing in the SEO panel, so the publish keeps it as a suggestion.
	reset();
	const off = fakeSite({ features: DESCRIBED });
	const kept = await off.click();
	await off.publish(applied(draftFields(), kept));
	record = off.storage.aiEntries.value<EntryRecord>("posts:E1")!;
	assert.deepEqual([record.description, record.descriptionStatus], ["A summary of the post.", "suggested"]);

	// A person wrote another before publishing: theirs stays, and the click's is dismissed.
	reset();
	const own = fakeSite({ features: DESCRIBED });
	const theirs = await own.click();
	await own.publish(applied(draftFields(), theirs), { seo: { description: "My own words." } });
	record = own.storage.aiEntries.value<EntryRecord>("posts:E1")!;
	assert.deepEqual([record.description, record.descriptionStatus], ["A summary of the post.", "dismissed"]);
	assert.equal(own.entry().seo?.description, "My own words.");
	assert.deepEqual(own.writes, [], "nothing written over the person's");
});

test("the description is filled only into an empty one the editor holds (its unsaved text counts, not the saved one), in a collection with SEO, with Meta descriptions on", async () => {
	reset();
	const m = model();
	const DESCRIBED = { ...LINKS_ONLY, "ai.descriptions": true };
	const fills = (answer: Answer) => answer.patch?.operations.some((o) => o.field === "seo.description") ?? false;

	// Typed in the SEO panel, not saved yet: no description call, no operation.
	const typed = fakeSite({ features: DESCRIBED });
	assert.equal(fills(await typed.click(draftFields(), { "seo.description": "Typed, not saved." })), false);
	assert.equal(textCalls(m), 1, "the extraction alone");

	// Saved, then cleared in the editor: the editor's empty one counts.
	const cleared = fakeSite({ features: DESCRIBED });
	cleared.item.seo = { description: "Saved before." };
	assert.equal(fills(await cleared.click(draftFields(), { "seo.description": null })), true);

	// The editor takes no SEO text (the draft doesn't list it): never an operation the editor would refuse.
	const noSeo = fakeSite({ features: DESCRIBED });
	assert.equal(fills(await noSeo.click(draftFields(), { "seo.description": undefined, "seo.title": undefined })), false);

	// Meta descriptions off: none.
	const off = fakeSite({ features: LINKS_ONLY });
	assert.equal(fills(await off.click()), false);

	// A live analysis whose description was dismissed, or applied and since removed: never proposed again.
	for (const status of ["dismissed", "applied", "suggested"] as const) {
		const site = fakeSite({ status: "published", features: DESCRIBED });
		Object.assign(site.item, { liveRevisionId: "R1", draftRevisionId: null });
		const t = await textOf(site, draftFields());
		const live: EntryRecord = { collection: "posts", entryId: "E1", title: t.title, hash: t.hash, textHash: t.textHash, status: "ok", error: "", entities: [], description: "The live one.", descriptionStatus: status, updated: "" };
		site.storage.aiEntries.rows.set("posts:E1", { data: live, revision: 0 });
		assert.equal(valueOf(await site.click(), "seo.description"), status === "suggested" ? "The live one." : undefined, status);
	}
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
	type Read = { record: unknown; staged: { entities: unknown[] } | null; enrich: { available: boolean; links: boolean; images: boolean; describe: boolean; provider: string } };
	const entryOf = (s: Site, collection = "posts") => routes.aiRoutes({})["ai/entry"].handler({ ...(s.ctx as object), input: { collection, id: "E1" } } as never) as Promise<Read>;
	const read = await entryOf(site);
	assert.equal(read.record, null);
	assert.equal(read.staged?.entities.length, 2);
	// The panel's AI Enrich button: shown when a click could do something, saying what it adds and where the content goes.
	assert.deepEqual(read.enrich, { available: true, links: true, images: true, describe: false, provider: "Anthropic" });
	assert.deepEqual((await entryOf(fakeSite({ features: { ai: true, "ai.imageText": true, "ai.descriptions": true } }))).enrich, { available: true, links: false, images: true, describe: false, provider: "Anthropic" });
	assert.deepEqual((await entryOf(fakeSite({ features: { ...LINKS_ONLY, "ai.descriptions": true } }))).enrich, { available: true, links: true, images: false, describe: true, provider: "Anthropic" });
	assert.equal((await entryOf(fakeSite({ features: { ai: true, "ai.entities": true, "ai.descriptions": true } }))).enrich.available, false, "neither glossary.io links nor Image text");
	assert.equal((await entryOf(fakeSite({ settings: { aiCollections: "pages" } }))).enrich.available, false, "a collection AI Enrichment doesn't cover");
	assert.equal((await entryOf(fakeSite({ settings: { aiApiKey: "" } }))).enrich.available, true, "no API key: a click says so");
});

// ── Paid work, locks and cancelled clicks ────────────────────────

type DraftRecord = import("./store.js").DraftRecord;
type EntryRecord = import("./store.js").EntryRecord;
type LinkMemo = import("./glossary-linker.js").LinkMemo;
type QueueJob = import("./logic.js").QueueJob;
type Chat = (req: ChatRequest) => Promise<unknown>;
const chat = globalThis as { __aiChat?: Chat };

/** Until `done` holds (the work in flight got that far). */
async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 5000 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(done(), "never got there");
}

/** The content without its links to `host` (taken out by hand). */
function withoutLink(content: unknown, host: string): unknown[] {
	const out = structuredClone(content) as Array<{ markDefs?: Array<{ _key: string; href: string }>; children?: Span[] }>;
	for (const b of out) {
		const gone = (b.markDefs ?? []).filter((d) => d.href.includes(host)).map((d) => d._key);
		if (!gone.length) continue;
		b.markDefs = b.markDefs!.filter((d) => !gone.includes(d._key));
		for (const c of b.children ?? []) c.marks = c.marks.filter((k) => !gone.includes(k));
	}
	return out;
}

const featuresOf = (site: Site) => site.settings.get("features") as Record<string, boolean>;
const settingsOf = (site: Site) => store.readSettings(site.ctx, site.options);
const textOf = async (site: Site, data: Record<string, unknown>, features = featuresOf(site)) => (await worker.entryText(site.ctx, "posts", data, await settingsOf(site), features))!;
const jobOf = (site: Site) => [...site.storage.aiQueue.rows.values()][0]?.data as QueueJob | undefined;
/** The entry's queued job, run as the scheduled run runs it. */
async function runJob(site: Site) {
	automatic = true;
	try {
		return await worker.analyzeEntry(site.ctx, site.options, await settingsOf(site), featuresOf(site), jobOf(site)!, { used: 0, max: worker.SUBREQUEST_BUDGET });
	} finally {
		automatic = false;
	}
}
const LOCK = "state:ai:editor:posts:E1";
const LINKS_ONLY = { ai: true, "ai.entities": true, "ai.glossaryLinks": true };
/** Forget the pack's own publishes marked in this isolate (a test's linkEntry), so the next test's publishes are a person's. */
const forgetOwn = () => linker.markOwnPublish("posts:E1", null, Date.now() - 3_600_000);

test("the entry's own id keys everything, whatever the request called it (a direct call with its slug)", async () => {
	reset();
	model();
	const site = fakeSite();
	site.kv.set(LOCK, { value: { until: Date.now() + 60_000, token: "another click" }, revision: "1" });
	assert.deepEqual(await site.click(undefined, undefined, "post"), told("info", enrich.TOASTS.running, { running: true }), "the same lock as a click by id");
	site.kv.delete(LOCK);
	const answer = await site.click(undefined, undefined, "post");
	assert.match(answer.toast.message, /^Added 2 glossary\.io links/);
	assert.deepEqual([...site.storage.aiDrafts.rows.keys()], ["posts:E1"]);
	assert.deepEqual([...site.storage.aiLinks.rows.keys()], ["posts:E1"]);
	assert.equal(site.storage.aiDrafts.value<DraftRecord>("posts:E1")!.entryId, "E1");
	assert.equal(site.storage.aiLinks.value<LinkMemo>("posts:E1")!.entryId, "E1");
});

test("a click cancelled halfway (the browser left): what it paid for is saved as it's paid, and its short lock lapses, so the next click pays for none of it", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: LINKS_ONLY });
	// Wikidata's type check never answers the first click: nothing after it runs, its `finally` included.
	const http = (site.ctx as { http: { fetch: (url: string) => Promise<Response> } }).http;
	const real = http.fetch;
	let asked = false;
	let release!: () => void;
	const hung = new Promise<void>((resolve) => (release = resolve));
	http.fetch = async (url: string) => {
		if (url.includes("query.wikidata.org") && !asked) {
			asked = true;
			await hung;
		}
		return real(url);
	};
	const first = site.click();
	await until(() => asked);
	assert.equal(textCalls(m), 1);
	const saved = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	assert.equal(saved.partial, true, "saved before the click ends");
	assert.equal(saved.cache?.mentions?.length, 2);
	const lock = site.kv.get(LOCK)!.value as { until: number; token: string };
	assert.ok(lock.until <= Date.now() + enrich.LOCK_MS, "a short lock, renewed only while the click runs");
	// The request is gone: nothing renews the lock, and it lapses.
	site.kv.set(LOCK, { value: { ...lock, until: Date.now() - 1 }, revision: "lapsed" });
	const second = await site.click();
	assert.equal(textCalls(m), 1, "the extraction came from what the first click saved");
	assert.match(second.toast.message, /^Added 2 glossary\.io links/);
	assert.equal(site.kv.has(LOCK), false);
	release();
	await first;
	assert.equal(site.kv.has(LOCK), false);
});

test("the entry's lock is renewed while a click runs, never once another click has it, and the renewals stop when it ends", async () => {
	reset();
	model();
	const answer = chat.__aiChat!;
	let waiting = false;
	let release!: () => void;
	const hung = new Promise<void>((resolve) => (release = resolve));
	chat.__aiChat = async (req) => {
		waiting = true;
		await hung;
		return answer(req);
	};
	const site = fakeSite({ features: LINKS_ONLY });
	const click = site.click();
	await until(() => waiting && beats.length === 1);
	const held = site.kv.get(LOCK)!.value as { until: number; token: string };
	// Close to lapsing: a renewal puts it LOCK_MS ahead again.
	site.kv.set(LOCK, { value: { ...held, until: Date.now() + 1 }, revision: "close" });
	beats[0]();
	await until(() => (site.kv.get(LOCK)!.value as { until: number }).until > Date.now() + enrich.LOCK_MS / 2);
	// Its lock lapsed anyway and another click took it: this one never renews or releases that.
	const other = { until: Date.now() + 1_000, token: "another click" };
	site.kv.set(LOCK, { value: other, revision: "other" });
	beats[0]();
	release();
	await click;
	assert.deepEqual(site.kv.get(LOCK)?.value, other);
	assert.equal(beats.length, 0, "the renewals stop");
});

test("a failure outside one image's work (the image records can't be read): the links still go, and the toast says what went wrong", async () => {
	reset();
	model();
	const site = fakeSite();
	site.storage.aiMedia.getMany = async () => {
		throw new Error("D1 is down");
	};
	const answer = await site.click();
	assert.equal(answer.toast.type, "error");
	assert.match(answer.toast.message, /^The images couldn't be worked on: D1 is down\. Click again to retry: what was already paid for is kept\. Added 2 glossary\.io links \(.+\)\. Review the changes, then save\.$/);
	assert.equal(linksOf(valueOf(answer, "content")).length, 2);
	assert.equal(site.storage.aiDrafts.value<DraftRecord>("posts:E1")?.partial, undefined, "the analysis is staged");
	assert.deepEqual(site.storage.aiLinks.value<LinkMemo>("posts:E1")?.planned?.slugs, ["fastmail", "google"]);
});

test("staging fails at the end: the click still answers, and what it saved on the way means the next click pays for nothing", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: LINKS_ONLY });
	const put = site.storage.aiDrafts.put;
	site.storage.aiDrafts.put = async (id: string, data: unknown) => {
		if (!(data as DraftRecord).partial) throw new Error("D1 is down");
		return put(id, data);
	};
	const first = await site.click();
	assert.match(first.toast.message, /^Added 2 glossary\.io links/);
	assert.ok(site.log.some((line) => line.startsWith("warn AI Enrich: couldn't stage the analysis")));
	const saved = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	assert.equal(saved.partial, true);
	assert.deepEqual(saved.cache?.entities?.map((e) => e.qid), ["Q1", "Q95"], "the entities, saved as soon as they were found");
	site.storage.aiDrafts.put = put;
	const paid = m.calls.length;
	const second = await site.click();
	assert.equal(m.calls.length, paid);
	assert.equal(second.toast.message, first.toast.message);
	assert.equal(site.storage.aiDrafts.value<DraftRecord>("posts:E1")?.partial, undefined);
});

test("past the click's deadline: no new stage starts, what's paid is staged, and the publish hands it to the entry's job", async () => {
	reset();
	const m = model();
	const answer = chat.__aiChat!;
	const realNow = Date.now;
	let skew = 0;
	Date.now = () => realNow() + skew;
	chat.__aiChat = async (req) => {
		const out = await answer(req);
		// The extraction took the request's time: no stage starts 25 seconds in.
		if (req.system.startsWith("You extract")) skew = enrich.START_BY_MS + 1;
		return out;
	};
	const site = fakeSite({ features: LINKS_ONLY });
	let first: Answer;
	try {
		first = await site.click();
	} finally {
		Date.now = realNow;
	}
	assert.deepEqual(first, told("info", enrich.TOASTS.outOfTime, { more: true }), "only time stopped it: the panel asks again");
	assert.equal(site.wd.searches, 0, "Wikidata wasn't asked");
	const staged = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	assert.equal(staged.partial, true);
	assert.equal(staged.cache?.mentions?.length, 2);
	await site.publish(draftFields());
	assert.equal(site.storage.aiDrafts.rows.size, 0);
	const job = jobOf(site)!;
	assert.equal(job.cache?.mentions?.length, 2);
	assert.equal(job.cache?.hash, (await textOf(site, draftFields())).hash);
	const paid = textCalls(m);
	assert.equal(await runJob(site), "done");
	assert.equal(textCalls(m), paid, "the extraction isn't paid for again");
	assert.deepEqual(site.storage.aiEntries.value<EntryRecord>("posts:E1")!.entities.map((e) => e.qid), ["Q1", "Q95"]);
	forgetOwn();
});

test("no stage starts 25 seconds into a request: just before, the click goes on", async () => {
	reset();
	model();
	const answer = chat.__aiChat!;
	const realNow = Date.now;
	let skew = 0;
	Date.now = () => realNow() + skew;
	chat.__aiChat = async (req) => {
		const out = await answer(req);
		if (req.system.startsWith("You extract")) skew = enrich.START_BY_MS - 1_000;
		return out;
	};
	const site = fakeSite({ features: LINKS_ONLY });
	let done: Answer;
	try {
		done = await site.click();
	} finally {
		Date.now = realNow;
	}
	assert.match(done.toast.message, /^Added 2 glossary\.io links/, "the type check and the links ran");
	assert.equal(site.storage.aiDrafts.value<DraftRecord>("posts:E1")?.partial, undefined);
	assert.equal(done.more, undefined);
	assert.equal(enrich.START_BY_MS, 25_000);
	assert.equal(enrich.LOCK_MAX_MS, 110_000);
});

test("must pass: after Apply and the editor's autosave, the saved draft's text hash is one the click staged (nulls, 0 and 1 as the form holds them), so the publish pays for nothing", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: { ai: true, "ai.entities": true, "ai.glossaryLinks": true, "ai.imageText": true, "ai.descriptions": true }, extraFields: [{ slug: "featured", type: "boolean" }, { slug: "subtitle", type: "string" }] });
	// Saved as EmDash stores it (a boolean as 1, no subtitle), and the form as the editor holds it: the boolean still 1,
	// the missing subtitle null, the excerpt cleared to null, the text and images changed and not saved yet.
	site.item.data = { title: "Email I like", content: [para("b0", "Saved text.")], excerpt: "Saved excerpt.", featured_image: null, featured: 1, subtitle: null };
	const form: Record<string, unknown> = { title: "Email I like", content: CONTENT(), excerpt: null, featured_image: FEATURED(), featured: 1, subtitle: null };
	const answer = await site.click(form);
	assert.ok(answer.patch && answer.review);
	const staged = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	const paid = m.calls.length;

	// Apply: the form takes the fields (the editor marks it dirty), the SEO panel saves the description itself, and the
	// autosave writes the form's values to the draft revision.
	const content = site.ctx as unknown as { content: { update(c: string, id: string, patch: Record<string, unknown>): Promise<unknown>; getRevision(c: string, id: string, rev: string): Promise<{ data: Record<string, unknown> } | null> } };
	await content.content.update("posts", "E1", { seo: { description: valueOf(answer, "seo.description") } });
	await content.content.update("posts", "E1", applied(form, answer));
	const saved = (await content.content.getRevision("posts", "E1", site.entry().draftRevisionId!))!.data;
	assert.ok(staged.textHashes.includes((await textOf(site, saved)).textHash), "the saved draft hashes as one the click staged");
	assert.equal(saved.excerpt, null);
	assert.equal(saved.featured, 1);

	// The publish of that draft (with the SEO text EmDash saved): the click's analysis is the entry's, nothing queued, no model call.
	await site.publish(saved, { seo: site.entry().seo });
	assert.equal(m.calls.length, paid);
	assert.deepEqual([...site.storage.aiQueue.rows.values()].map((r) => r.data), []);
	assert.equal(site.storage.aiDrafts.rows.size, 0);
	const record = site.storage.aiEntries.value<EntryRecord>("posts:E1")!;
	assert.deepEqual([record.textHash, record.descriptionStatus], [(await textOf(site, saved)).textHash, "applied"]);
	assert.deepEqual(site.storage.aiLinks.value<LinkMemo>("posts:E1")!.linked, ["Q1", "Q95"], "the applied links count as linked");
	forgetOwn();
});

test("images: their files are read one at a time (large ones together could exhaust the Worker's memory), while the model calls overlap", async () => {
	reset();
	model();
	const answer = chat.__aiChat!;
	let calling = 0;
	let mostCalling = 0;
	chat.__aiChat = async (req) => {
		if (!req.image) return answer(req);
		mostCalling = Math.max(mostCalling, ++calling);
		await new Promise((resolve) => setTimeout(resolve, 20));
		calling--;
		return answer(req);
	};
	const site = fakeSite({ features: { ai: true, "ai.imageText": true } });
	let reading = 0;
	let mostReading = 0;
	const media = (site.ctx as { media: { readBytes: (id: string) => Promise<unknown> } }).media;
	const read = media.readBytes;
	media.readBytes = async (id: string) => {
		mostReading = Math.max(mostReading, ++reading);
		await new Promise((resolve) => setTimeout(resolve, 5));
		reading--;
		return read(id);
	};
	const done = await site.click();
	assert.match(done.toast.message, /^Wrote alt text for 3 and captions for 4 of 4 images/);
	assert.equal(mostReading, 1);
	assert.ok(mostCalling > 1, "the calls themselves still run three at a time");
});

// ── Second clicks, live analyses and planned links ───────────────

test("a second click after a link was taken out by hand doesn't propose it again, and the publish keeps it out", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: LINKS_ONLY });
	const fields = draftFields();
	const first = await site.click(fields);
	const edited = { ...applied(fields, first), content: withoutLink(valueOf(first, "content"), "google") };
	const second = await site.click(edited);
	assert.equal(textCalls(m), 1);
	assert.deepEqual(second, told("info", enrich.TOASTS.nothingToAdd));
	assert.deepEqual(site.storage.aiLinks.value<LinkMemo>("posts:E1")!.planned?.slugs, ["fastmail", "google"], "the first proposal's links still tell it was applied");
	await site.publish(edited);
	assert.equal(site.storage.aiQueue.rows.size, 0, "promoted");
	assert.deepEqual(site.storage.aiLinks.value<LinkMemo>("posts:E1")!.linked, ["Q1", "Q95"], "Google counts as handled");

	// Not applied (the dialog was cancelled): a second click proposes everything again.
	reset();
	const other = fakeSite({ features: LINKS_ONLY });
	await other.click(fields);
	assert.equal(linksOf(valueOf(await other.click(fields), "content")).length, 2);
});

test("planned links older than PLANNED_MS count for nothing: not as a second click's exclusions, not at the publish", async () => {
	reset();
	model();
	const age = (site: Site) => {
		const memo = site.storage.aiLinks.value<LinkMemo>("posts:E1")!;
		site.storage.aiLinks.rows.set("posts:E1", { data: { ...memo, planned: { ...memo.planned!, at: Date.now() - linker.PLANNED_MS - 1 } }, revision: 500 });
	};
	const site = fakeSite({ features: LINKS_ONLY });
	const first = await site.click();
	const edited = { ...applied(draftFields(), first), content: withoutLink(valueOf(first, "content"), "google") };
	age(site);
	assert.deepEqual(linksOf(valueOf(await site.click(edited), "content")).map(([, href]) => href), ["https://glossary.io/fastmail/", "https://glossary.io/google/"]);

	reset();
	const other = fakeSite({ features: LINKS_ONLY });
	const answer = await other.click();
	age(other);
	await other.publish({ ...applied(draftFields(), answer), content: withoutLink(valueOf(answer, "content"), "google") });
	const memo = other.storage.aiLinks.value<LinkMemo>("posts:E1")!;
	assert.equal(memo.planned, undefined);
	assert.deepEqual(memo.linked, [], "nothing counts as handled");
	assert.equal(typeof memo.retryAt, "number", "the retry pass links what's missing");
});

test("a published entry: its live analysis is reused only when it's of this text under today's settings; aiEntries is never written; a memo the click makes counts as nothing remembered", async () => {
	reset();
	const m = model();
	const entity = { name: "Fastmail", type: "Organization" as const, description: "An email service.", qid: "Q1", wikipedia: "", website: "", primary: true };
	const published = async (features: Record<string, boolean>, liveFeatures = features) => {
		const site = fakeSite({ status: "published", features });
		Object.assign(site.item, { liveRevisionId: "R1", draftRevisionId: null });
		const t = await textOf(site, draftFields(), liveFeatures);
		const live: EntryRecord = { collection: "posts", entryId: "E1", title: t.title, hash: t.hash, textHash: t.textHash, status: "ok", error: "", entities: liveFeatures["ai.entities"] ? [entity] : [], description: "", descriptionStatus: "none", updated: "2026-11-01T00:00:00.000Z" };
		site.storage.aiEntries.rows.set("posts:E1", { data: live, revision: 0 });
		return { site, live };
	};

	// Of this text, under today's settings: no model call for the text. The captions it adds change the text, so it's staged for that.
	const { site, live } = await published({ ai: true, "ai.entities": true, "ai.glossaryLinks": true, "ai.imageText": true });
	const answer = await site.click();
	assert.equal(textCalls(m), 0);
	assert.deepEqual(linksOf(valueOf(answer, "content")), [["Fastmail", "https://glossary.io/fastmail/"]]);
	assert.deepEqual(site.storage.aiEntries.value("posts:E1"), live, "untouched");
	const staged = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	assert.deepEqual(staged.entities, [entity]);
	assert.equal(staged.textHashes.length, 2);
	const memo = site.storage.aiLinks.value<LinkMemo>("posts:E1")!;
	assert.equal(memo.pendingNew, true);
	assert.equal(linker.shouldLink(memo, live, "another text hash"), false, "a later analysis of the live entry (a settings-only one too) doesn't link it");
	assert.equal(linker.shouldLink(memo, null, "another text hash"), true, "a first analysis still links");

	// Nothing to stage (no captions to add): an earlier click's analysis of another text goes.
	const plain = await published(LINKS_ONLY);
	plain.site.storage.aiDrafts.rows.set("posts:E1", { data: { textHashes: ["another text"], partial: true }, revision: 0 });
	await plain.site.click();
	assert.equal(textCalls(m), 0);
	assert.equal(plain.site.storage.aiDrafts.rows.size, 0);

	// Made while Entities was off: same text, none of what it finds. The click pays for it, and the publish makes it the entry's.
	const old = await published(LINKS_ONLY, { ...LINKS_ONLY, "ai.entities": false });
	const fresh = await old.site.click();
	assert.equal(textCalls(m), 1);
	assert.equal(linksOf(valueOf(fresh, "content")).length, 2);
	await old.site.publish(applied(draftFields(), fresh), { liveRevisionId: "R2" });
	const record = old.site.storage.aiEntries.value<EntryRecord>("posts:E1")!;
	assert.deepEqual(record.entities.map((e) => e.qid), ["Q1", "Q95"]);
	assert.equal(record.hash, (await textOf(old.site, draftFields())).hash, "so a bulk run doesn't analyze it again");
	assert.equal(old.site.storage.aiQueue.rows.size, 0);
});

test("the toast tells links switched to glossary.io from links added", async () => {
	reset();
	model();
	const site = fakeSite({ features: LINKS_ONLY });
	// Wikidata knows Fastmail's official website: a link to its home page is an identity link, switched.
	const http = (site.ctx as { http: { fetch: (url: string) => Promise<Response> } }).http;
	const real = http.fetch;
	http.fetch = async (url: string) => {
		const res = await real(url);
		if (!url.includes("query.wikidata.org")) return res;
		const body = (await res.json()) as { results: { bindings: Array<Record<string, { value: string }>> } };
		for (const row of body.results.bindings) if (row.item.value.endsWith("/Q1")) row.website = { value: "https://www.fastmail.com/" };
		return Response.json(body);
	};
	const content = [
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [{ _key: "w", _type: "link", href: "https://www.fastmail.com/" }],
			children: [
				{ _type: "span", _key: "s1", text: "I use ", marks: [] },
				{ _type: "span", _key: "s2", text: "Fastmail", marks: ["w"] },
				{ _type: "span", _key: "s3", text: " for email, and Google's search too.", marks: [] },
			],
		},
	];
	const answer = await site.click({ title: "Email I like", content, excerpt: "", featured_image: null });
	assert.match(answer.toast.message, /^Added 1 glossary\.io link and switched 1 link to glossary\.io \((Fastmail, Google|Google, Fastmail)\)\. Review the changes, then save\.$/);
});

test("the review counts possessives moved inside a glossary.io link the text already had", async () => {
	reset();
	model();
	const site = fakeSite({ features: LINKS_ONLY });
	const content = [
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [{ _key: "g", _type: "link", href: "https://glossary.io/google/" }],
			children: [
				{ _type: "span", _key: "s1", text: "I use Fastmail, and ", marks: [] },
				{ _type: "span", _key: "s2", text: "Google", marks: ["g"] },
				{ _type: "span", _key: "s3", text: "'s search too.", marks: [] },
			],
		},
	];
	const answer = await site.click({ title: "Email I like", content, excerpt: "", featured_image: null });
	assert.equal(answer.review?.possessives, 1);
	assert.deepEqual(answer.review?.links.map((l) => l.name), ["Fastmail"]);
	assert.deepEqual(linksOf(valueOf(answer, "content")), [["Fastmail", "https://glossary.io/fastmail/"], ["Google's", "https://glossary.io/google/"]]);
	assert.match(answer.toast.message, /Put 1 possessive inside glossary\.io links\./);
});

test("only an image whose suggestion was dismissed misses text: nothing to add, and the toast says why", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: { ai: true, "ai.imageText": true } });
	site.storage.aiMedia.rows.set("M1", { data: { mediaId: "M1", filename: "one.png", url: "", suggestion: { alt: "Dismissed.", caption: "Dismissed.", title: "" }, status: "dismissed", written: [], error: "", updated: "" }, revision: 0 });
	const answer = await site.click({ title: "Pictures", content: [para("b1", "Pictures."), img("d", "M1")], excerpt: "", featured_image: null });
	assert.equal(visionCalls(m), 0);
	assert.deepEqual(answer, told("info", enrich.leftAlone(1)));
});

test("a long field (185 paragraphs, over the 2,000 values an editor action could answer) is patched whole, with its image text", async () => {
	reset();
	model();
	const site = fakeSite({ features: { ai: true, "ai.imageText": true } });
	const content = [...Array.from({ length: 185 }, (_, i) => para(`p${i}`, "x")), img("i1", "M1")];
	const answer = await site.click({ title: "Long", content, excerpt: "", featured_image: FEATURED() });
	assert.deepEqual(answer.patch?.operations.map((o) => o.field), ["content", "featured_image"]);
	assert.match(String(node(valueOf(answer, "content"), 185).alt), /^Model alt \d\.$/);
	assert.equal((valueOf(answer, "content") as unknown[]).length, 186);
	assert.equal(answer.toast.type, "success");
});

// ── The publish, its job, and the retry pass ─────────────────────

test("a description that failed: the publish queues the entry with the entities the click paid for, and its job pays only for the description", async () => {
	reset();
	const m = model({ fail: (req) => (req.system.startsWith("You write the meta description") ? new Error("Anthropic returned HTTP 529: Overloaded") : null) });
	const site = fakeSite({ features: { ...LINKS_ONLY, "ai.descriptions": true } });
	const answer = await site.click();
	assert.equal(answer.toast.type, "error");
	assert.match(answer.toast.message, /^The AI service didn't answer: Anthropic returned HTTP 529: Overloaded\. Click again to retry: what was already paid for is kept\. Added 2 glossary\.io links/);
	const staged = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	assert.equal(staged.described, false);
	assert.equal(staged.partial, undefined);
	const published = applied(draftFields(), answer);
	await site.publish(published);
	assert.equal(site.storage.aiEntries.rows.size, 0);
	assert.equal(site.storage.aiDrafts.rows.size, 0, "handed to the job");
	assert.deepEqual(jobOf(site)!.cache?.entities?.map((e) => e.qid), ["Q1", "Q95"]);
	assert.equal(jobOf(site)!.cache?.hash, (await textOf(site, published)).hash, "keyed to the published text");
	// The same publish's hook again: the job keeps them.
	await site.hook("content:afterPublish", site.entry());
	assert.equal(jobOf(site)!.cache?.entities?.length, 2);
	m.fail = undefined;
	const paid = textCalls(m);
	assert.equal(await runJob(site), "done");
	assert.equal(textCalls(m), paid + 1);
	assert.ok(m.calls.at(-1)!.system.startsWith("You write the meta description"), "the description, and nothing else");
	const record = site.storage.aiEntries.value<EntryRecord>("posts:E1")!;
	assert.deepEqual(record.entities.map((e) => e.qid), ["Q1", "Q95"]);
	assert.equal(record.description, "A summary of the post.");
	forgetOwn();
});

test("the same for a staged analysis made before Meta descriptions was switched on: its job pays only for the description", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: LINKS_ONLY });
	const answer = await site.click();
	site.settings.set("features", { ...LINKS_ONLY, "ai.descriptions": true });
	await site.publish(applied(draftFields(), answer));
	assert.equal(jobOf(site)!.cache?.entities?.length, 2);
	assert.equal(jobOf(site)!.cache?.description, undefined);
	const paid = textCalls(m);
	await runJob(site);
	assert.equal(textCalls(m), paid + 1);
	forgetOwn();
});

test("Fill empty descriptions automatically: the publish writes nothing to the entry; the scheduled run applies the click's description without a model call", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: { ...LINKS_ONLY, "ai.descriptions": true }, settings: { aiDescriptionsMode: "apply" } });
	const answer = await site.click();
	const paid = m.calls.length;
	await site.publish(applied(draftFields(), answer));
	assert.deepEqual(site.writes, [], "no write seconds after the publish, while the editor may still be open");
	assert.equal(site.storage.aiEntries.rows.size, 0);
	assert.ok(jobOf(site)!.due > Date.now(), "past the debounce");
	assert.equal(jobOf(site)!.cache?.description, "A summary of the post.");
	assert.equal(await runJob(site), "done");
	assert.equal(m.calls.length, paid, "no model call");
	assert.deepEqual(site.writes, ["update seo"]);
	assert.equal(site.entry().seo?.description, "A summary of the post.");
	assert.equal(site.storage.aiEntries.value<EntryRecord>("posts:E1")!.descriptionStatus, "applied");
	forgetOwn();
});

test("published while a click was still running: the publish found nothing staged, and its job uses what the click paid for", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: LINKS_ONLY });
	await site.publish(draftFields());
	assert.equal(jobOf(site)!.cache, undefined);
	await site.click(draftFields());
	const paid = m.calls.length;
	assert.equal(await runJob(site), "done");
	assert.equal(m.calls.length, paid, "no model call");
	assert.deepEqual(site.storage.aiEntries.value<EntryRecord>("posts:E1")!.entities.map((e) => e.qid), ["Q1", "Q95"]);
	forgetOwn();
});

test("the publish settles the planned links with compareAndSet: a memo write that lands meanwhile (a site's re-check asking for a retry) is kept", async () => {
	reset();
	model();
	const site = fakeSite();
	const answer = await site.click();
	const changed = applied(draftFields(), answer);
	(changed.content as unknown[]).push(para("b9", "A new paragraph."));
	const cas = site.storage.aiLinks.compareAndSet;
	let raced = false;
	site.storage.aiLinks.compareAndSet = async (id: string, expected: string | null, data: unknown) => {
		if (!raced) {
			raced = true;
			await site.storage.aiLinks.put(id, { ...site.storage.aiLinks.value<LinkMemo>(id)!, retryAt: 12_345, tries: 0 });
		}
		return cas(id, expected, data);
	};
	await site.publish(changed);
	assert.ok(raced);
	const memo = site.storage.aiLinks.value<LinkMemo>("posts:E1")!;
	assert.equal(memo.planned, undefined);
	assert.deepEqual(memo.linked, ["Q1", "Q95"]);
	assert.equal(memo.retryAt, 12_345, "the re-check's ask is kept");
});

test("the pack's own publishes (a link edit, a removal) settle nothing a person's click planned or staged", async () => {
	reset();
	model();
	const site = fakeSite();
	const answer = await site.click();
	const memo = structuredClone(site.storage.aiLinks.value<LinkMemo>("posts:E1"));
	linker.markOwnPublish("posts:E1", "R2");
	try {
		await site.publish(applied(draftFields(), answer));
		assert.deepEqual(site.storage.aiLinks.value<LinkMemo>("posts:E1"), memo, "the planned links wait for the person's publish");
		assert.equal(site.storage.aiDrafts.rows.size, 1, "so does the staged analysis");
		assert.equal(linker.isOwnPublish("posts:E1", "R3"), false, "another revision's publish is a person's");
		assert.equal(linker.isOwnPublish("posts:E1", "R2", Date.now() + 61_000), false, "and so is one after a minute");
	} finally {
		forgetOwn();
	}
});

test("after a promoted publish the retry pass checks the links once, with no model call; without the patch it links (and only once)", async () => {
	reset();
	const m = model();
	const due = (site: Site) => {
		const memo = site.storage.aiLinks.value<LinkMemo>("posts:E1")!;
		site.storage.aiLinks.rows.set("posts:E1", { data: { ...memo, retryAt: Date.now() - 1 }, revision: 900 });
	};
	const site = fakeSite();
	const answer = await site.click();
	await site.publish(applied(draftFields(), answer));
	const paid = m.calls.length;
	const updatedAt = site.entry().updatedAt;
	due(site);
	assert.equal(await linker.retryDue(site.ctx, site.options, 3), 1);
	assert.equal(m.calls.length, paid);
	assert.deepEqual(site.writes, [], "the links are all there: no edit, no publish");
	assert.equal(site.entry().updatedAt, updatedAt);
	assert.equal(site.storage.aiLinks.value<LinkMemo>("posts:E1")!.retryAt, undefined);

	// Published without the patch: the retry pass makes the links, the possessive inside, and its own publish settles nothing.
	reset();
	const other = fakeSite();
	await other.click();
	await other.publish(draftFields());
	due(other);
	await linker.retryDue(other.ctx, other.options, 3);
	assert.deepEqual(other.writes, ["update content", "publish"]);
	assert.deepEqual(linksOf(other.entry().data.content), [["Fastmail", "https://glossary.io/fastmail/"], ["Google's", "https://glossary.io/google/"]]);
	const memo = other.storage.aiLinks.value<LinkMemo>("posts:E1")!;
	assert.deepEqual(memo.linked, ["Q1", "Q95"]);
	assert.equal(memo.retryAt, undefined);
	assert.equal(await linker.retryDue(other.ctx, other.options, 3), 0, "nothing more to do");
	assert.equal(m.calls.length, paid * 2);
	forgetOwn();
});

// ── The store ────────────────────────────────────────────────────

test("takeCall: callers at once (a click's five, a scheduled run's, another entry's click) all get their call, and the cap still holds", async () => {
	const site = fakeSite();
	const kv = (site.ctx as { kv: { compareAndSet: (k: string, rev: string | null, value: unknown) => Promise<unknown> } }).kv;
	const cas = kv.compareAndSet;
	// Every write waits a turn after its read, so each round they all read the same count and all but one lose.
	kv.compareAndSet = async (k: string, rev: string | null, value: unknown) => {
		await new Promise((resolve) => setImmediate(resolve));
		return cas(k, rev, value);
	};
	assert.deepEqual(await Promise.all(Array.from({ length: 11 }, () => store.takeCall(site.ctx, 100))), Array(11).fill(true));
	assert.equal(await site.calls(), 11);
	const capped = await Promise.all(Array.from({ length: 3 }, () => store.takeCall(site.ctx, 12)));
	assert.deepEqual(capped.sort(), [false, false, true]);
	assert.equal(await site.calls(), 12);
});

test("locks a cancelled click never released are deleted an hour past their time; others stay", async () => {
	const site = fakeSite();
	site.kv.set("state:ai:editor:posts:OLD", { value: { until: Date.now() - 2 * 3_600_000, token: "a" }, revision: "1" });
	site.kv.set("state:ai:editor:posts:RECENT", { value: { until: Date.now() - 60_000, token: "b" }, revision: "2" });
	site.kv.set("state:ai:editor:posts:HELD", { value: { until: Date.now() + 10_000, token: "c" }, revision: "3" });
	site.kv.set("state:ai:lock", { value: { until: 0, token: "d" }, revision: "4" });
	await store.pruneEditorLocks(site.ctx);
	assert.deepEqual([...site.kv.keys()].sort(), ["state:ai:editor:posts:HELD", "state:ai:editor:posts:RECENT", "state:ai:lock"]);
});

// ── The last review round ────────────────────────────────────────

const ENT = { name: "Fastmail", type: "Organization" as const, description: "An email service.", qid: "Q1", wikipedia: "", website: "", primary: true };
/** A published entry whose analysis is of `data` under today's settings. */
async function analyzed(site: Site, data: Record<string, unknown>): Promise<EntryRecord> {
	Object.assign(site.item, { status: "published", liveRevisionId: "R1", draftRevisionId: null, data });
	const t = await textOf(site, data);
	const record: EntryRecord = { collection: "posts", entryId: "E1", title: t.title, hash: t.hash, textHash: t.textHash, status: "ok", error: "", entities: [ENT], description: "", descriptionStatus: "none", updated: "2026-11-01T00:00:00.000Z" };
	site.storage.aiEntries.rows.set("posts:E1", { data: record, revision: 0 });
	return record;
}

test("a publish after a running click's first checkpoint: the job takes what the click finished later, pays for nothing, and the staged row goes", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: { ...LINKS_ONLY, "ai.descriptions": true } });
	// The description call is still out when the entry is published.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const inner = chat.__aiChat!;
	chat.__aiChat = async (req) => {
		if (req.system.startsWith("You write the meta description")) await held;
		return inner(req);
	};
	const click = site.click(draftFields());
	await until(() => Boolean(site.storage.aiDrafts.value<DraftRecord>("posts:E1")?.cache?.entities));
	await site.publish(draftFields());
	assert.deepEqual(Object.keys(jobOf(site)!.cache ?? {}).sort(), ["entities", "hash", "mentions"], "the job has what was paid by then");
	assert.equal(site.storage.aiDrafts.rows.size, 0);
	release();
	await click;
	const staged = site.storage.aiDrafts.value<DraftRecord>("posts:E1")!;
	assert.deepEqual([staged.partial, staged.described, staged.description], [undefined, true, "A summary of the post."], "the click staged its complete analysis after the publish");
	const paid = m.calls.length;
	assert.equal(await runJob(site), "done");
	assert.equal(m.calls.length, paid, "the description isn't paid for twice");
	const record = site.storage.aiEntries.value<EntryRecord>("posts:E1")!;
	assert.equal(record.description, "A summary of the post.");
	assert.deepEqual(record.entities.map((e) => e.qid), ["Q1", "Q95"]);
	assert.equal(site.storage.aiDrafts.rows.size, 0, "nothing left waiting for a publish");
	forgetOwn();
});

test("a job leaves a staged analysis that still waits for its patch's publish; an analysis of exactly the published text deletes one that waits for nothing", async () => {
	reset();
	const m = model();
	// Published before the click: the job takes the click's analysis, and the row stays for the text with its captions.
	const site = fakeSite();
	await site.publish(draftFields());
	const answer = await site.click(draftFields());
	assert.equal(site.storage.aiDrafts.value<DraftRecord>("posts:E1")!.textHashes.length, 2);
	const paid = m.calls.length;
	assert.equal(await runJob(site), "done");
	site.storage.aiQueue.rows.clear();
	assert.equal(site.storage.aiDrafts.rows.size, 1, "the patch isn't published yet");
	await site.publish(applied(draftFields(), answer));
	assert.equal(m.calls.length, paid);
	assert.equal(site.storage.aiQueue.rows.size, 0, "promoted");
	assert.equal(site.storage.aiDrafts.rows.size, 0);
	forgetOwn();

	// An exact publish: a row of that text alone goes; one that also waits for another text stays.
	const exact = fakeSite({ features: LINKS_ONLY });
	const record = await analyzed(exact, draftFields());
	const row = { collection: "posts", entryId: "E1", title: record.title, hash: record.hash, textHashes: [record.textHash!], entities: [ENT], description: "", described: true, updated: new Date().toISOString() };
	exact.storage.aiDrafts.rows.set("posts:E1", { data: { ...row, hash: "the patch's", textHashes: [record.textHash, "the patch's text"] }, revision: 0 });
	await exact.hook("content:afterSave", exact.entry());
	assert.equal(exact.storage.aiDrafts.rows.size, 1, "still waits for its patch");
	exact.storage.aiDrafts.rows.set("posts:E1", { data: { ...row, partial: true, textHashes: [record.textHash, "the patch's text"] }, revision: 0 });
	await exact.hook("content:afterSave", exact.entry());
	assert.equal(exact.storage.aiDrafts.rows.size, 1, "a partial one's hash is the text before its patch");
	exact.storage.aiDrafts.rows.set("posts:E1", { data: row, revision: 0 });
	await exact.hook("content:afterSave", exact.entry());
	assert.equal(exact.storage.aiDrafts.rows.size, 0);
	assert.equal(exact.storage.aiQueue.rows.size, 0);
});

test("a possessives-only run keeps a memo that holds only a click's planned links, and deletes it once they're out of date", async () => {
	reset();
	model();
	const site = fakeSite({ status: "published", features: LINKS_ONLY });
	await analyzed(site, site.item.data);
	await site.click(draftFields());
	const memo = structuredClone(site.storage.aiLinks.value<LinkMemo>("posts:E1")!);
	assert.deepEqual([memo.pendingNew, memo.planned?.qids], [true, ["Q1", "Q95"]]);
	await linker.linkEntry(site.ctx, site.options, "posts", "E1", { only: "possessive" });
	assert.deepEqual(site.storage.aiLinks.value<LinkMemo>("posts:E1"), memo, "the publish still has them to settle");
	site.storage.aiLinks.rows.set("posts:E1", { data: { ...memo, planned: { ...memo.planned!, at: Date.now() - linker.PLANNED_MS - 1 } }, revision: 0 });
	await linker.linkEntry(site.ctx, site.options, "posts", "E1", { only: "possessive" });
	assert.equal(site.storage.aiLinks.rows.size, 0, "as good as no memo");
	forgetOwn();
});

test("a forced job (Analyze again) never takes a staged analysis: the publish's cache isn't merged in, and its run pays for a fresh one", async () => {
	reset();
	const m = model({ fail: (req) => (req.system.startsWith("You write the meta description") ? new Error("boom") : null) });
	const site = fakeSite({ features: { ...LINKS_ONLY, "ai.descriptions": true } });
	const answer = await site.click(draftFields());
	await store.enqueue(site.ctx, { kind: "entry", collection: "posts", entryId: "E1", due: Date.now(), force: true });
	await site.publish(applied(draftFields(), answer));
	assert.deepEqual([jobOf(site)!.force, jobOf(site)!.cache], [true, undefined]);
	m.fail = undefined;
	const before = m.calls.length;
	assert.equal(await runJob(site), "done");
	assert.deepEqual(m.calls.slice(before).map((c) => c.system.slice(0, 11)).sort(), ["You extract", "You write t"]);

	// One whose staged analysis is still there when it runs (published while the click ran) doesn't use that either.
	reset();
	const other = fakeSite({ features: LINKS_ONLY });
	await other.publish(draftFields());
	await other.click(draftFields());
	await store.enqueue(other.ctx, { kind: "entry", collection: "posts", entryId: "E1", due: Date.now(), force: true });
	const calls = textCalls(m);
	assert.equal(await runJob(other), "done");
	assert.equal(textCalls(m), calls + 1, "the extraction is paid for again");
	forgetOwn();
});

test("an analysis staged under another provider or model is never reused: not by the publish, a second click or the job", async () => {
	reset();
	const m = model();
	const site = fakeSite({ features: LINKS_ONLY });
	const answer = await site.click(draftFields());
	assert.equal(site.storage.aiDrafts.value<DraftRecord>("posts:E1")!.model, "p:anthropic|m:t");
	site.settings.set("aiModel", "another-model");
	// The publish: analyzed as usual, under today's model.
	await site.publish(applied(draftFields(), answer));
	assert.equal(site.storage.aiEntries.rows.size, 0, "not promoted under today's hash");
	assert.equal(site.storage.aiDrafts.rows.size, 0);
	assert.equal(jobOf(site)!.cache, undefined);
	let paid = textCalls(m);
	assert.equal(await runJob(site), "done");
	assert.equal(textCalls(m), paid + 1);
	forgetOwn();

	// A second click pays for its own, and that one is promoted.
	reset();
	const again = fakeSite({ features: LINKS_ONLY });
	await again.click(draftFields());
	again.settings.set("aiModel", "another-model");
	paid = textCalls(m);
	const second = await again.click(draftFields());
	assert.equal(textCalls(m), paid + 1);
	assert.equal(again.storage.aiDrafts.value<DraftRecord>("posts:E1")!.model, "p:anthropic|m:another-model");
	await again.publish(applied(draftFields(), second));
	assert.equal(again.storage.aiQueue.rows.size, 0, "promoted");

	// Published while the click ran, the model changed before the job did: the job pays.
	reset();
	const late = fakeSite({ features: LINKS_ONLY });
	await late.publish(draftFields());
	await late.click(draftFields());
	late.settings.set("aiModel", "another-model");
	paid = textCalls(m);
	assert.equal(await runJob(late), "done");
	assert.equal(textCalls(m), paid + 1);
	forgetOwn();
});

test("a save of another text drops the outputs its queued job had, so the scheduled run counts its calls in full; the same text keeps them", async () => {
	reset();
	model({ fail: (req) => (req.system.startsWith("You write the meta description") ? new Error("boom") : null) });
	const site = fakeSite({ features: { ...LINKS_ONLY, "ai.descriptions": true } });
	const answer = await site.click(draftFields());
	const published = applied(draftFields(), answer);
	await site.publish(published);
	assert.equal(jobOf(site)!.cache?.entities?.length, 2);
	await site.publish(published);
	assert.equal(jobOf(site)!.cache?.entities?.length, 2, "the same text again");
	await site.publish({ ...published, content: [...(published.content as unknown[]), para("b9", "A new paragraph.")] });
	assert.equal(jobOf(site)!.cache, undefined, "they were of another text");
	forgetOwn();
});

test("the staged analysis is deleted only once the job has what it paid for: a failed enqueue loses nothing", async () => {
	reset();
	const m = model({ fail: (req) => (req.system.startsWith("You write the meta description") ? new Error("boom") : null) });
	const site = fakeSite({ features: { ...LINKS_ONLY, "ai.descriptions": true } });
	const answer = await site.click(draftFields());
	const put = site.storage.aiQueue.put;
	site.storage.aiQueue.put = async () => {
		throw new Error("D1 is busy");
	};
	await assert.rejects(site.publish(applied(draftFields(), answer)), /D1 is busy/);
	assert.equal(site.storage.aiDrafts.rows.size, 1, "still there for the next publish");
	site.storage.aiQueue.put = put;
	await site.publish(applied(draftFields(), answer));
	assert.equal(site.storage.aiDrafts.rows.size, 0);
	assert.equal(jobOf(site)!.cache?.entities?.length, 2);
	m.fail = undefined;
	forgetOwn();
});

test("a stale lock is deleted only as it was read: a click that takes it meanwhile keeps its lock", async () => {
	const site = fakeSite();
	const key = "state:ai:editor:posts:OLD";
	site.kv.set(key, { value: { until: Date.now() - 2 * 3_600_000, token: "a" }, revision: "1" });
	const kv = (site.ctx as { kv: { compareAndDelete: (k: string, rev: string) => Promise<unknown> } }).kv;
	const real = kv.compareAndDelete;
	const taken = { until: Date.now() + 20_000, token: "a new click" };
	kv.compareAndDelete = async (k: string, rev: string) => {
		site.kv.set(k, { value: taken, revision: "2" });
		return real(k, rev);
	};
	await store.pruneEditorLocks(site.ctx);
	assert.deepEqual(site.kv.get(key)?.value, taken);
	// Taken between the list and the read: left alone too.
	kv.compareAndDelete = real;
	site.kv.set(key, { value: { until: Date.now() - 2 * 3_600_000, token: "a" }, revision: "3" });
	const list = (site.ctx as { kv: { list: (prefix: string) => Promise<unknown> } }).kv.list;
	(site.ctx as { kv: { list: unknown } }).kv.list = async (prefix: string) => {
		const rows = await list(prefix);
		site.kv.set(key, { value: taken, revision: "4" });
		return rows;
	};
	await store.pruneEditorLocks(site.ctx);
	assert.deepEqual(site.kv.get(key)?.value, taken);
});

test("past the lock's longest time its timer is cleared, and a run still going writes no state once another click has the entry", async () => {
	reset();
	model();
	const site = fakeSite({ features: LINKS_ONLY });
	// Wikidata's type check hangs: the extraction is paid and saved, the rest waits.
	const http = (site.ctx as { http: { fetch: (url: string) => Promise<Response> } }).http;
	const real = http.fetch;
	let asked = false;
	let release!: () => void;
	const hung = new Promise<void>((resolve) => (release = resolve));
	http.fetch = async (url: string) => {
		if (url.includes("query.wikidata.org") && !asked) {
			asked = true;
			await hung;
		}
		return real(url);
	};
	const click = site.click();
	await until(() => asked && beats.length === 1);
	const realNow = Date.now;
	Date.now = () => realNow() + 151_000;
	try {
		beats[0]();
	} finally {
		Date.now = realNow;
	}
	assert.equal(beats.length, 0, "no timer left idling");
	// Its lock lapsed and another click has the entry.
	const other = { until: Date.now() + 20_000, token: "another click" };
	site.kv.set(LOCK, { value: other, revision: "other" });
	release();
	const answer = await click;
	assert.match(answer.toast.message, /^Added 2 glossary\.io links/, "the person still gets the answer");
	assert.equal(site.storage.aiDrafts.value<DraftRecord>("posts:E1")!.partial, true, "only what it saved as it paid: no complete analysis staged over the other click's");
	assert.equal(site.storage.aiLinks.rows.size, 0, "and no planned links");
	assert.ok(site.log.some((line) => line.includes("another click took over")));
	assert.deepEqual(site.kv.get(LOCK)?.value, other);
});

test("planned links that are out of date go at a promoted publish too, when nothing else in the memo changes", async () => {
	reset();
	model();
	const site = fakeSite({ features: LINKS_ONLY });
	const answer = await site.click(draftFields());
	const t = await textOf(site, applied(draftFields(), answer));
	const planned = site.storage.aiLinks.value<LinkMemo>("posts:E1")!.planned!;
	const memo = { collection: "posts", entryId: "E1", linked: ["Q1"], textHash: t.textHash, planned: { ...planned, at: Date.now() - linker.PLANNED_MS - 1 }, updated: "2026-11-01T00:00:00.000Z" };
	site.storage.aiLinks.rows.set("posts:E1", { data: memo, revision: 0 });
	await site.publish(applied(draftFields(), answer));
	assert.equal(site.storage.aiEntries.rows.size, 1, "promoted");
	const { planned: _p, updated: _u, ...rest } = memo;
	const { updated: _now, ...stored } = site.storage.aiLinks.value<LinkMemo>("posts:E1")!;
	assert.deepEqual(stored, rest, "only the planned links went");
});

test("writing a meta description is the pack's own save: it settles nothing a click staged or planned for an unsaved draft", async () => {
	reset();
	model();
	const site = fakeSite({ status: "published", features: LINKS_ONLY });
	Object.assign(site.item, { liveRevisionId: "R1", draftRevisionId: null });
	await site.click(draftFields());
	const staged = structuredClone(site.storage.aiDrafts.value<DraftRecord>("posts:E1"));
	const memo = structuredClone(site.storage.aiLinks.value<LinkMemo>("posts:E1"));
	assert.ok(staged && memo?.planned);
	// EmDash runs the save hooks for the SEO-only update too.
	const content = (site.ctx as { content: { update: (c: string, id: string, patch: Record<string, unknown>) => Promise<unknown> } }).content;
	const update = content.update;
	content.update = async (c, id, patch) => {
		const out = await update(c, id, patch);
		await site.hook("content:afterSave", site.entry());
		return out;
	};
	try {
		assert.equal(await worker.applyDescription(site.ctx, "posts", "E1", "A description.", false), true);
		assert.deepEqual(site.storage.aiDrafts.value<DraftRecord>("posts:E1"), staged, "the analysis of the unsaved draft waits for its publish");
		assert.deepEqual(site.storage.aiLinks.value<LinkMemo>("posts:E1"), memo, "and so do its planned links");
		assert.equal(linker.isOwnPublish("posts:E1", "R2"), false, "a person's publish (another revision) is still theirs");
	} finally {
		forgetOwn();
	}
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

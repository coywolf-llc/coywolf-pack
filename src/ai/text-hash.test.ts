/**
 * Unit tests for Pack 0.51.0's "re-analyze only when the text changed": a save
 * queues an entry only when its title or text changed since its analysis
 * (src/ai/pack.ts onContent), a save's job whose text is unchanged is skipped
 * without a model call (src/ai/worker.ts analyzeEntry), bulk runs keep
 * applying new settings, and analyses made before 0.51.0 get their text hash
 * from ai/text-hashes or the scheduled run (fillTextHashes).
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/text-hash.test.ts
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as F from "../core/features.ts";

const featuresLib = F as typeof import("../core/features.js");

// The model providers can't run under Node (see test/ai.test.mjs): the same stand-in as src/ai/glossary-possessive.test.ts,
// whose chat() throws. A test that expects a full analysis sees that error, and the day's call counter shows the model call.
const PROVIDERS_STAND_IN = `data:text/javascript,${encodeURIComponent(
	'export const PROVIDERS = [{ id: "workers-ai", label: "Workers AI", textModel: "t", visionModel: "v" }, { id: "anthropic", label: "Anthropic", textModel: "t", visionModel: "v" }]; export const PROVIDER_HOSTS = []; export async function chat() { throw new Error("no model calls in tests"); } export async function listModels() { return []; }',
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
const worker = (await import("./worker.ts")) as typeof import("./worker.js");
// @ts-ignore -- as above.
const routes = (await import("./routes.ts")) as typeof import("./routes.js");
// @ts-ignore -- as above.
const store = (await import("./store.ts")) as typeof import("./store.js");

type Job = import("./logic.js").QueueJob;
type EntryRecord = import("./store.js").EntryRecord;

// ── A fake site ──────────────────────────────────────────────────

/** Entities off and an SEO description already there: an analysis makes no model call, so it can finish here. */
const NO_CALLS = { ai: true, "ai.descriptions": true };
/** Entities on: a full analysis starts with a model call (the stand-in's error). */
const WITH_CALLS = { ai: true, "ai.entities": true };
const OLD = "2026-11-01T00:00:00.000Z";
const ANALYZED = "2026-11-02T00:00:00.000Z";

type Row = { data: unknown; revision: number; created: number };
type Where = Record<string, unknown>;

const compare = (a: unknown, b: unknown) => ((a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0);
const matches = (data: Record<string, unknown>, where: Where = {}) =>
	Object.entries(where).every(([field, cond]) => {
		const v = data[field];
		if (cond && typeof cond === "object") {
			const c = cond as { lt?: unknown; lte?: unknown; gt?: unknown; gte?: unknown };
			return (c.lt === undefined || compare(v, c.lt) < 0) && (c.lte === undefined || compare(v, c.lte) <= 0) && (c.gt === undefined || compare(v, c.gt) > 0) && (c.gte === undefined || compare(v, c.gte) >= 0);
		}
		return v === cond;
	});

/** An in-memory plugin storage collection; writes are logged as "<name>.put <id>". */
function collection(name: string, log: string[]) {
	const rows = new Map<string, Row>();
	let seq = 0;
	const write = (id: string, data: unknown) => {
		log.push(`${name}.put ${id}`);
		rows.set(id, { data: structuredClone(data), revision: ++seq, created: rows.get(id)?.created ?? seq });
	};
	return {
		rows,
		get: async (id: string) => structuredClone(rows.get(id)?.data ?? null),
		getMany: async (ids: string[]) => new Map(ids.filter((id) => rows.has(id)).map((id) => [id, structuredClone(rows.get(id)!.data)])),
		put: async (id: string, data: unknown) => write(id, data),
		delete: async (id: string) => rows.delete(id),
		deleteMany: async (ids: string[]) => ids.filter((id) => rows.delete(id)).length,
		getVersioned: async (id: string) => (rows.has(id) ? { value: structuredClone(rows.get(id)!.data), revision: String(rows.get(id)!.revision) } : null),
		compareAndSet: async (id: string, expected: string | null, data: unknown) => {
			const current = rows.get(id);
			if ((current ? String(current.revision) : null) !== expected) return { applied: false };
			write(id, data);
			return { applied: true, revision: String(seq) };
		},
		count: async (where?: Where) => [...rows.values()].filter((r) => matches(r.data as Record<string, unknown>, where)).length,
		query: async (opts: { where?: Where; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string } = {}) => {
			log.push(`${name}.query`);
			const items = [...rows].filter(([, r]) => matches(r.data as Record<string, unknown>, opts.where));
			const order = Object.entries(opts.orderBy ?? {})[0];
			if (order) items.sort(([, a], [, b]) => compare((a.data as Where)[order[0]], (b.data as Where)[order[0]]) * (order[1] === "desc" ? -1 : 1));
			else items.sort(([, a], [, b]) => a.created - b.created);
			const limit = opts.limit ?? 50;
			const start = opts.cursor ? items.findIndex(([id]) => id === opts.cursor) + 1 : 0;
			const page = items.slice(start, start + limit);
			const hasMore = start + limit < items.length;
			return { items: page.map(([id, r]) => ({ id, data: structuredClone(r.data) })), hasMore, cursor: hasMore ? page[page.length - 1][0] : undefined };
		},
	};
}

const block = (text: string, link?: string) => {
	if (!link) return { _type: "block", _key: "b1", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s1", text, marks: [] }] };
	// The same text with its first word linked: a link-only edit.
	const [first, ...rest] = text.split(" ");
	return {
		_type: "block",
		_key: "b1",
		style: "normal",
		markDefs: [{ _type: "link", _key: "m1", href: link }],
		children: [
			{ _type: "span", _key: "s1", text: first, marks: ["m1"] },
			{ _type: "span", _key: "s2", text: ` ${rest.join(" ")}`, marks: [] },
		],
	};
};

interface Item {
	id: string;
	type: string;
	slug: string;
	status: string;
	data: Record<string, unknown>;
	seo: { description: string };
	updatedAt: string;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
}

const item = (id: string, more: Partial<Item> & { text?: string; title?: string } = {}): Item => {
	const { text, title, ...rest } = more;
	return {
		id,
		type: "articles",
		slug: id.toLowerCase(),
		status: "published",
		data: { title: title ?? `Title ${id}`, body: [block(text ?? `The text of ${id} about Google and more.`)] },
		seo: { description: "A description a person wrote." },
		updatedAt: OLD,
		liveRevisionId: "R1",
		draftRevisionId: null,
		...rest,
	};
};

function fakeSite(opts: { features?: Record<string, boolean>; model?: string } = {}) {
	const log: string[] = [];
	const settings = new Map<string, unknown>([
		["features", opts.features ?? NO_CALLS],
		["aiProvider", "anthropic"],
		["aiModel", opts.model ?? "model-1"],
		["aiCollections", "articles"],
	]);
	const kv = new Map<string, { value: unknown; revision: string }>();
	let kvRevision = 0;
	const content = new Map<string, Item>();
	const storage = {
		aiQueue: collection("aiQueue", log),
		aiEntries: collection("aiEntries", log),
		aiMedia: collection("aiMedia", log),
		aiUsage: collection("aiUsage", log),
		aiGlossary: collection("aiGlossary", log),
		aiLinks: collection("aiLinks", log),
	};
	const logged = (level: string) => (message: string, data?: unknown) => void log.push(`log.${level} ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
	const ctx = {
		site: { url: "https://example.com", locale: "en" },
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
				slug === "articles"
					? { slug: "articles", hasSeo: true, fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "body", type: "portableText", sortOrder: 1 }] }
					: null,
			listCollections: async () => [{ slug: "articles", routable: true, hidden: false }],
		},
		storage,
		http: { fetch: async () => new Response("{}", { status: 500 }) },
		content: {
			get: async (c: string, id: string) => {
				log.push(`content.get ${id}`);
				return structuredClone(content.get(`${c}:${id}`) ?? null);
			},
			list: async (c: string, o: { limit?: number; cursor?: string } = {}) => {
				const all = [...content.values()].filter((i) => `${i.type}` === c && i.status === "published");
				const start = o.cursor ? all.findIndex((i) => i.id === o.cursor) + 1 : 0;
				const page = all.slice(start, start + (o.limit ?? 50));
				const hasMore = start + page.length < all.length;
				return { items: structuredClone(page), hasMore, cursor: hasMore ? page[page.length - 1].id : undefined };
			},
		},
	};
	const site = {
		ctx: ctx as never,
		log,
		settings,
		kv,
		content,
		storage,
		/** Add a published entry (and nothing else). */
		add: (i: Item) => (content.set(`articles:${i.id}`, i), i),
		/** Plugin KV, as the module writes it. */
		kvSet: (k: string, value: unknown) => ctx.kv.set(k, value),
		kvValue: <T>(k: string) => kv.get(k)?.value as T | undefined,
		record: (id: string) => storage.aiEntries.rows.get(`articles:${id}`)?.data as EntryRecord | undefined,
		job: (id: string) => storage.aiQueue.rows.get(`entry:articles:${id}`)?.data as Job | undefined,
		settingsNow: () => store.readSettings(ctx as never, {}),
		featuresNow: () => featuresLib.ctxFeatures(ctx as never),
		/** The entry's text and hashes under the site's settings now. */
		textOf: async (i: Item) => (await worker.entryText(ctx as never, "articles", i.data, await site.settingsNow(), await site.featuresNow()))!,
		calls: () => store.callsToday(ctx as never),
		writes: (name: string) => log.filter((l) => l.startsWith(`${name}.put`)),
	};
	return site;
}

type Site = ReturnType<typeof fakeSite>;

const jobFor = (id: string, more: Partial<Job> = {}): Job => ({ kind: "entry", collection: "articles", entryId: id, due: 0, attempts: 0, enqueuedAt: 0, ...more });
const analyze = async (site: Site, job: Job, budget = { used: 0, max: 40 }) => worker.analyzeEntry(site.ctx, {}, await site.settingsNow(), await site.featuresNow(), job, budget);
const save = (site: Site, i: Item, hook: "content:afterSave" | "content:afterPublish" | "content:afterRestore" = "content:afterSave") =>
	(pack.aiPack({}).hooks![hook] as unknown as (event: unknown, ctx: unknown) => Promise<void>)({ content: structuredClone(i), collection: "articles" }, site.ctx);
/** An analysis as 0.50.0 stored it: no text hash. */
const legacy = (record: EntryRecord): EntryRecord => {
	const { textHash: _t, ...rest } = record;
	return rest;
};

/** An entry analyzed under model-1 (an analysis that makes no model call), then the model changed to model-2. */
async function analyzedThenModelChanged(id = "A") {
	const site = fakeSite();
	const entry = site.add(item(id));
	assert.equal(await analyze(site, jobFor(id)), "done");
	const analyzed = site.record(id)!;
	site.settings.set("aiModel", "model-2");
	return { site, entry, analyzed };
}

// ── The analysis records its text hash ───────────────────────────

test("an analysis records the text hash (title and text alone) next to the hash (with the settings)", async () => {
	const site = fakeSite();
	const entry = site.add(item("A"));
	assert.equal(await analyze(site, jobFor("A")), "done");
	const t = await site.textOf(entry);
	const record = site.record("A")!;
	assert.equal(record.hash, t.hash);
	assert.equal(record.textHash, t.textHash);
	assert.notEqual(record.hash, record.textHash);
	assert.equal(await site.calls(), 0, "no model call in this setup");
	// New settings change the hash, never the text hash.
	site.settings.set("aiModel", "model-2");
	const after = await site.textOf(entry);
	assert.notEqual(after.hash, t.hash);
	assert.equal(after.textHash, t.textHash);
});

// ── Saves ────────────────────────────────────────────────────────

test("a save after only the settings changed (another model, a link, a part switched on) queues nothing", async () => {
	const { site, entry } = await analyzedThenModelChanged();
	// A link-only edit, saved and published: the text is the same.
	const linked = { ...entry, data: { ...entry.data, body: [block("The text of A about Google and more.", "https://glossary.io/google/")] } };
	assert.equal((await site.textOf(linked)).textHash, (await site.textOf(entry)).textHash, "a link doesn't change the text");
	for (const hook of ["content:afterSave", "content:afterPublish", "content:afterRestore"] as const) await save(site, linked, hook);
	assert.equal(site.job("A"), undefined, "no job: before 0.51.0 every one of these queued a paid re-analysis");
	// Another part switched on changes the settings hash too: still no job.
	site.settings.set("features", { ...NO_CALLS, "ai.entities": true });
	await save(site, linked);
	assert.equal(site.job("A"), undefined);
	assert.deepEqual(site.writes("aiQueue"), []);
});

test("a save that changes the title or the text queues the entry, marked as a save's job", async () => {
	const { site, entry } = await analyzedThenModelChanged();
	const before = Date.now();
	await save(site, { ...entry, data: { ...entry.data, body: [block("Different words now.")] } });
	const job = site.job("A")!;
	assert.equal(job.source, "save");
	assert.equal(job.force, undefined);
	assert.ok(job.due >= before + 2 * 60_000, "after the debounce (2 minutes by default)");

	const titled = await analyzedThenModelChanged("B");
	await save(titled.site, { ...titled.entry, data: { ...titled.entry.data, title: "A new title" } });
	assert.equal(titled.site.job("B")?.source, "save");
});

test("an analysis without a text hash (made before 0.51.0) queues as before: only its hash decides", async () => {
	const { site, entry, analyzed } = await analyzedThenModelChanged();
	await site.storage.aiEntries.put("articles:A", legacy(analyzed));
	await save(site, entry);
	assert.equal(site.job("A")?.source, "save", "the settings changed, so the hash differs: queued as in 0.50.0");

	// Same settings as the analysis: its hash matches, nothing is queued (as before).
	const same = fakeSite();
	const e = same.add(item("A"));
	assert.equal(await analyze(same, jobFor("A")), "done");
	await same.storage.aiEntries.put("articles:A", legacy(same.record("A")!));
	await save(same, e);
	assert.equal(same.job("A"), undefined);

	// A failed analysis always queues, whatever its text hash says.
	await same.storage.aiEntries.put("articles:A", { ...same.record("A")!, status: "error", hash: "", textHash: (await same.textOf(e)).textHash });
	await save(same, e);
	assert.equal(same.job("A")?.source, "save");
	void entry;
});

// ── Jobs ─────────────────────────────────────────────────────────

test("a job skipped because the hash still matches records the text hash of an analysis made before 0.51.0, and nothing else", async () => {
	const site = fakeSite();
	const entry = site.add(item("A"));
	assert.equal(await analyze(site, jobFor("A")), "done");
	const old = legacy(site.record("A")!);
	await site.storage.aiEntries.put("articles:A", old);
	const before = site.writes("aiEntries").length;
	assert.equal(await analyze(site, jobFor("A")), "skipped");
	assert.deepEqual(site.record("A"), { ...old, textHash: (await site.textOf(entry)).textHash }, "the same hash means the same title and text: only the text hash is added, not the date");
	assert.equal(site.writes("aiEntries").length, before + 1);
	assert.equal(await site.calls(), 0);
	// With a text hash there's nothing to write.
	assert.equal(await analyze(site, jobFor("A", { source: "save" })), "skipped");
	assert.equal(site.writes("aiEntries").length, before + 1);
	// A save's job skipped for its text hash alone (other settings) has one already: nothing is written either.
	site.settings.set("aiModel", "model-2");
	assert.equal(await analyze(site, jobFor("A", { source: "save" })), "skipped");
	assert.equal(site.writes("aiEntries").length, before + 1);
});

test("a save's job whose text is unchanged is skipped without a model call; any other job keeps 0.50.0's check", async () => {
	const site = fakeSite({ features: WITH_CALLS });
	const entry = site.add(item("A"));
	const t = await site.textOf(entry);
	// Analyzed under other settings (its hash differs), same title and text.
	const record: EntryRecord = { collection: "articles", entryId: "A", title: t.title, hash: "hash-under-other-settings", textHash: t.textHash, status: "ok", error: "", entities: [], description: "", descriptionStatus: "none", updated: ANALYZED };
	await site.storage.aiEntries.put("articles:A", record);
	const budget = { used: 0, max: 40 };
	assert.equal(await analyze(site, jobFor("A", { source: "save" }), budget), "skipped");
	assert.equal(await site.calls(), 0, "no model call");
	assert.equal(budget.used, 0);
	assert.deepEqual(site.record("A"), record, "the analysis stays as it was");

	// A bulk run's job (Run bulk, then with Re-analyze unchanged entries) and Analyze again: analyzed (the model is called).
	for (const [job, calls] of [
		[jobFor("A"), 1],
		[jobFor("A", { force: false }), 2],
		[jobFor("A", { force: true }), 3],
		[jobFor("A", { source: "save", force: true }), 4],
	] as const) {
		await assert.rejects(analyze(site, job), /no model calls in tests/, JSON.stringify(job));
		assert.equal(await site.calls(), calls);
	}
	// A save's job for changed text, or for an analysis without a text hash, or after a failed one: analyzed.
	const changed = { ...entry, data: { ...entry.data, body: [block("Different words now.")] } };
	site.content.set("articles:A", changed);
	await assert.rejects(analyze(site, jobFor("A", { source: "save" })), /no model calls in tests/);
	site.content.set("articles:A", entry);
	await site.storage.aiEntries.put("articles:A", legacy(record));
	await assert.rejects(analyze(site, jobFor("A", { source: "save" })), /no model calls in tests/);
	await site.storage.aiEntries.put("articles:A", { ...record, status: "error" });
	await assert.rejects(analyze(site, jobFor("A", { source: "save" })), /no model calls in tests/);
	assert.equal(await site.calls(), 7);
	// The hash matching still skips every job that isn't forced.
	await site.storage.aiEntries.put("articles:A", { ...record, hash: t.hash, textHash: "other" });
	assert.equal(await analyze(site, jobFor("A")), "skipped");
	assert.equal(await analyze(site, jobFor("A", { source: "save" })), "skipped");
	assert.equal(await site.calls(), 7);
});

test("a bulk run's job still applies new settings to an unchanged entry; a save's job doesn't", async () => {
	const { site, analyzed } = await analyzedThenModelChanged();
	assert.equal(await analyze(site, jobFor("A", { source: "save" })), "skipped");
	assert.deepEqual(site.record("A"), analyzed);
	assert.equal(await analyze(site, jobFor("A", { force: false })), "done", "Run bulk");
	const now = site.record("A")!;
	assert.notEqual(now.hash, analyzed.hash, "analyzed under model-2");
	assert.equal(now.textHash, analyzed.textHash);
	assert.equal(await analyze(site, jobFor("A", { force: false })), "skipped", "and then it's up to date");
	assert.equal(await analyze(site, jobFor("A", { force: true })), "done", "Re-analyze unchanged entries");
});

test("a job queued by a save whose text was changed back before it ran is skipped", async () => {
	const { site, entry } = await analyzedThenModelChanged();
	await save(site, { ...entry, data: { ...entry.data, body: [block("Different words now.")] } });
	assert.equal(site.job("A")?.source, "save");
	await save(site, entry); // Changed back: nothing new is queued, the job stays.
	assert.equal(site.job("A")?.source, "save");
	const r = await worker.tick(site.ctx, {}, { budgetMs: 60_000 });
	assert.deepEqual([r.processed, r.skipped, r.failed], [0, 0, 0], "not due yet (debounce)");
	await site.storage.aiQueue.put("entry:articles:A", { ...site.job("A")!, due: 0 });
	const ran = await worker.tick(site.ctx, {}, { budgetMs: 60_000 });
	assert.deepEqual([ran.processed, ran.skipped, ran.failed], [0, 1, 0]);
	assert.equal(site.job("A"), undefined);
});

test("bulk scans are unchanged: Run bulk queues entries analyzed with other settings, Re-analyze queues every one; their jobs aren't saves'", async () => {
	const { site } = await analyzedThenModelChanged("A");
	site.add(item("B"));
	// B analyzed under model-2 (current settings): unchanged.
	assert.equal(await analyze(site, jobFor("B")), "done");
	await site.kvSet("state:ai:bulk:entries", { kind: "entries", force: false, collections: ["articles"], queued: 0, skipped: 0, started: OLD });
	await worker.advanceBulk(site.ctx, await site.settingsNow(), await site.featuresNow(), "entries");
	const state = site.kvValue<{ queued: number; skipped: number; finished?: string }>("state:ai:bulk:entries")!;
	assert.deepEqual([state.queued, state.skipped, Boolean(state.finished)], [1, 1, true]);
	assert.equal(site.job("A")!.force, false);
	assert.equal(site.job("A")!.source, undefined);
	assert.equal(site.job("B"), undefined);

	await site.storage.aiQueue.delete("entry:articles:A");
	await site.kvSet("state:ai:bulk:entries", { kind: "entries", force: true, collections: ["articles"], queued: 0, skipped: 0, started: OLD });
	await worker.advanceBulk(site.ctx, await site.settingsNow(), await site.featuresNow(), "entries");
	assert.equal(site.kvValue<{ queued: number }>("state:ai:bulk:entries")!.queued, 2);
	for (const id of ["A", "B"]) assert.deepEqual([site.job(id)!.force, site.job(id)!.source], [true, undefined]);
});

test("a save merged into a bulk run's job (or the reverse) keeps the bulk run's check; two saves stay a save's job", async () => {
	const { site, entry } = await analyzedThenModelChanged();
	const changed = { ...entry, data: { ...entry.data, body: [block("Different words now.")] } };
	// A bulk run's job, then a save: the merged job still applies the new settings.
	await store.enqueue(site.ctx, { kind: "entry", collection: "articles", entryId: "A", due: 0, force: false });
	await save(site, changed);
	assert.equal(site.job("A")!.source, undefined);
	assert.equal(site.job("A")!.force, false);
	// A save, then a bulk run.
	await site.storage.aiQueue.delete("entry:articles:A");
	await save(site, changed);
	await store.enqueue(site.ctx, { kind: "entry", collection: "articles", entryId: "A", due: 0, force: false });
	assert.equal(site.job("A")!.source, undefined);
	// Two saves.
	await site.storage.aiQueue.delete("entry:articles:A");
	await save(site, changed);
	await save(site, { ...changed, data: { ...changed.data, title: "Another title" } });
	assert.equal(site.job("A")!.source, "save");
	// Analyze again (forced) on a save's job: forced.
	await store.enqueue(site.ctx, { kind: "entry", collection: "articles", entryId: "A", due: 0, force: true });
	assert.deepEqual([site.job("A")!.source, site.job("A")!.force], [undefined, true]);
});

// ── ai/text-hashes ───────────────────────────────────────────────

const textHashes = (site: Site, input: Record<string, unknown>) =>
	(routes.aiRoutes({})["ai/text-hashes"].handler as (ctx: unknown) => Promise<import("./worker.js").TextHashFill>)({ ...(site.ctx as object), input });

/** Entries analyzed before 0.51.0 (no text hash), one per case, in this order. */
async function legacySite() {
	const site = fakeSite();
	const recent = new Date(Date.now() - 30_000).toISOString();
	const cases: Array<[string, Partial<Item>]> = [
		["A", {}],
		["Queued", {}],
		["Draft", { draftRevisionId: "R2" }],
		["Gone", {}],
		["Unpublished", {}],
		["Set", {}],
		["Failed", {}],
		["Retitled", {}],
		["Recent", {}],
		["Z", {}],
	];
	for (const [id, more] of cases) {
		const entry = site.add(item(id, more));
		assert.equal(await analyze(site, jobFor(id)), "done");
		if (id !== "Set") await site.storage.aiEntries.put(`articles:${id}`, legacy(site.record(id)!));
		if (id === "Failed") await site.storage.aiEntries.put(`articles:${id}`, { ...site.record(id)!, status: "error", hash: "" });
		void entry;
	}
	site.content.delete("articles:Gone");
	site.content.set("articles:Unpublished", { ...site.content.get("articles:Unpublished")!, status: "draft" });
	site.content.set("articles:Retitled", item("Retitled", { title: "A title the analysis never saw" }));
	site.content.set("articles:Recent", item("Recent", { updatedAt: recent }));
	await store.enqueue(site.ctx, { kind: "entry", collection: "articles", entryId: "Queued", due: Date.now() + 60_000, source: "save" });
	site.log.length = 0;
	return site;
}

const SKIPPED = [
	{ key: "articles:Queued", reason: "queued" },
	{ key: "articles:Draft", reason: "draft" },
	{ key: "articles:Gone", reason: "missing" },
	{ key: "articles:Unpublished", reason: "unpublished" },
	{ key: "articles:Retitled", reason: "title changed" },
	{ key: "articles:Recent", reason: "recently saved" },
];

test("ai/text-hashes: a dry run lists what it would fill and why the others are left, and writes nothing", async () => {
	const site = await legacySite();
	const before = structuredClone([...site.storage.aiEntries.rows]);
	const out = await textHashes(site, { dryRun: true });
	assert.deepEqual(out, {
		dryRun: true,
		filled: ["articles:A", "articles:Z"],
		skipped: SKIPPED,
		counts: { checked: 9, filled: 2, alreadySet: 1, skipped: 6 },
		cursor: undefined,
		hasMore: false,
	});
	assert.deepEqual([...site.storage.aiEntries.rows], before);
	assert.deepEqual(site.writes("aiEntries"), []);
	assert.ok(!site.log.some((l) => l.startsWith("content.get articles:Set") || l.startsWith("content.get Set")), "an analysis with a text hash costs no entry read");
});

test("ai/text-hashes fills only the eligible analyses, from the entry's current text, and changes nothing else (not the date)", async () => {
	const site = await legacySite();
	const before = new Map([...site.storage.aiEntries.rows].map(([id, r]) => [id, structuredClone(r.data) as EntryRecord]));
	const out = await textHashes(site, {});
	assert.equal(out.dryRun, false);
	assert.deepEqual(out.filled, ["articles:A", "articles:Z"]);
	assert.deepEqual(out.skipped, SKIPPED);
	assert.deepEqual(out.counts, { checked: 9, filled: 2, alreadySet: 1, skipped: 6 });
	for (const [key, was] of before) {
		const now = site.storage.aiEntries.rows.get(key)!.data as EntryRecord;
		if (out.filled.includes(key)) {
			const id = key.slice("articles:".length);
			assert.deepEqual(now, { ...was, textHash: (await site.textOf(site.content.get(key)!)).textHash }, key);
			assert.equal(now.updated, was.updated);
			void id;
		} else assert.deepEqual(now, was, key);
	}
	assert.deepEqual(site.writes("aiEntries"), ["aiEntries.put articles:A", "aiEntries.put articles:Z"]);
	assert.ok(site.log.some((l) => l.startsWith("log.info AI: text hashes recorded")));
	// Done: a save with the same text queues nothing now, though the analysis is under other settings.
	site.settings.set("aiModel", "model-2");
	await save(site, site.content.get("articles:A")!);
	assert.equal(site.job("A"), undefined);
	// A second run has nothing left to fill.
	const again = await textHashes(site, {});
	assert.deepEqual(again.filled, []);
	assert.deepEqual(again.counts, { checked: 9, filled: 0, alreadySet: 3, skipped: 6 });
});

test("ai/text-hashes with keys: each key's outcome, including ones that aren't analyses", async () => {
	const site = await legacySite();
	const out = await textHashes(site, { keys: ["articles:A", "articles:Failed", "articles:Set", "nokey", "articles:Never", "articles:Gone"] });
	assert.deepEqual(out.filled, ["articles:A"]);
	assert.deepEqual(out.skipped, [
		{ key: "articles:Failed", reason: "analysis failed" },
		{ key: "nokey", reason: "bad key" },
		{ key: "articles:Never", reason: "not analyzed" },
		{ key: "articles:Gone", reason: "missing" },
	]);
	assert.deepEqual(out.counts, { checked: 6, filled: 1, alreadySet: 1, skipped: 4 });
	assert.equal(out.hasMore, false);
	// An error reading an entry is reported, and the rest go on.
	(site.ctx as { content: { get: unknown } }).content.get = async (_c: string, id: string) => {
		if (id === "Z") throw new Error("database is down");
		return structuredClone(site.content.get(`articles:${id}`) ?? null);
	};
	const failed = await textHashes(site, { keys: ["articles:Z", "articles:Draft"] });
	assert.deepEqual(failed.skipped, [
		{ key: "articles:Z", reason: "error", error: "database is down" },
		{ key: "articles:Draft", reason: "draft" },
	]);
});

test("ai/text-hashes answers 409 while the scheduled run works (a dry run still answers); the input is bounded", async () => {
	const site = await legacySite();
	await site.kvSet("state:ai:lock", { until: Date.now() + 60_000, token: "the scheduled run" });
	await assert.rejects(textHashes(site, {}), (error: unknown) => (error as { status?: number }).status === 409 && /scheduled AI run is working/.test(String((error as Error).message)));
	assert.deepEqual(site.writes("aiEntries"), []);
	assert.deepEqual((await textHashes(site, { dryRun: true })).filled, ["articles:A", "articles:Z"]);
	// The route holds the same lock while it writes, so the scheduled run waits for it.
	site.kv.delete("state:ai:lock");
	await textHashes(site, {});
	assert.equal(site.kv.has("state:ai:lock"), false, "released afterwards");
	await assert.rejects(textHashes(site, { limit: 51 }));
	await assert.rejects(textHashes(site, { limit: 0 }));
	await assert.rejects(textHashes(site, { keys: Array.from({ length: 51 }, (_, i) => `articles:${i}`) }));
	await assert.rejects(textHashes(site, { keys: [] }));
});

test("ai/text-hashes pages through the analyses with limit and cursor", async () => {
	const site = fakeSite();
	for (const id of ["P1", "P2", "P3", "P4", "P5"]) {
		site.add(item(id));
		assert.equal(await analyze(site, jobFor(id)), "done");
		await site.storage.aiEntries.put(`articles:${id}`, legacy(site.record(id)!));
	}
	const pages: string[][] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 5; i++) {
		const out = await textHashes(site, { limit: 2, ...(cursor ? { cursor } : {}) });
		pages.push(out.filled);
		cursor = out.cursor;
		assert.equal(out.hasMore, i < 2);
		if (!out.hasMore) break;
	}
	assert.deepEqual(pages, [["articles:P1", "articles:P2"], ["articles:P3", "articles:P4"], ["articles:P5"]]);
	for (const id of ["P1", "P2", "P3", "P4", "P5"]) assert.equal(site.record(id)!.textHash, (await site.textOf(site.content.get(`articles:${id}`)!)).textHash);
});

test("ai/text-hashes is read-only for the page cache (a POST to it doesn't clear the site's cache)", async () => {
	// @ts-ignore -- as above.
	const { isReadOnlyRoute } = (await import("../core/routes.ts")) as typeof import("../core/routes.js");
	assert.equal(isReadOnlyRoute(routes.aiRoutes({})["ai/text-hashes"]), true);
});

// ── The scheduled run's share ────────────────────────────────────

async function manyLegacy(n: number) {
	const site = fakeSite();
	const ids = Array.from({ length: n }, (_, i) => `E${String(i).padStart(2, "0")}`);
	for (const id of ids) {
		site.add(item(id));
		assert.equal(await analyze(site, jobFor(id)), "done");
		await site.storage.aiEntries.put(`articles:${id}`, legacy(site.record(id)!));
	}
	site.log.length = 0;
	return { site, ids, filled: () => ids.filter((id) => site.record(id)!.textHash) };
}

test("the scheduled run fills at most TEXT_HASH_FILL_PER_TICK per run and never more than its budget has left; each entry read counts 1", async () => {
	assert.equal(worker.TEXT_HASH_FILL_PER_TICK, 10);
	const { site, filled } = await manyLegacy(16);
	const far = Date.now() + 60_000;

	// 3 left in the budget: 3 analyses, and the budget is used up.
	const tight = { used: 37, max: 40 };
	await worker.fillTextHashesTick(site.ctx, {}, tight, far);
	assert.equal(filled().length, 3);
	assert.equal(tight.used, 40);
	assert.equal(site.log.filter((l) => l.startsWith("content.get")).length, 3);

	// Nothing left: no entry is read, nothing changes.
	site.log.length = 0;
	await worker.fillTextHashesTick(site.ctx, {}, { used: 40, max: 40 }, far);
	await worker.fillTextHashesTick(site.ctx, {}, { used: 0, max: 40 }, Date.now() - 1);
	assert.deepEqual(site.log.filter((l) => l.startsWith("content.get") || l.startsWith("aiEntries.put")), []);
	assert.equal(filled().length, 3);

	// A whole budget: 10, then the last 3, and the pass is done.
	const roomy = { used: 0, max: 40 };
	await worker.fillTextHashesTick(site.ctx, {}, roomy, far);
	assert.equal(filled().length, 13);
	assert.equal(roomy.used, 10);
	assert.equal((site.kv.get(store.TEXT_HASHES_KEY)!.value as { done?: string }).done, undefined);
	await worker.fillTextHashesTick(site.ctx, {}, { used: 0, max: 40 }, far);
	assert.equal(filled().length, 16);
	const state = site.kv.get(store.TEXT_HASHES_KEY)!.value as { done?: string; filled: number; skipped: number; cursor?: string };
	assert.ok(state.done);
	assert.deepEqual([state.filled, state.skipped, state.cursor], [16, 0, undefined]);
	assert.ok(site.log.some((l) => l.startsWith("log.info AI: text hashes recorded for analyses made before 0.51.0")));

	// Done for good: later runs read nothing.
	site.log.length = 0;
	await worker.fillTextHashesTick(site.ctx, {}, { used: 0, max: 40 }, far);
	assert.deepEqual(site.log, []);
});

test("fillTextHashes stops when the budget is used up; nothing starts after the deadline", async () => {
	const { site, filled } = await manyLegacy(4);
	await store.enqueue(site.ctx, { kind: "entry", collection: "articles", entryId: "E00", due: Date.now() + 600_000, source: "save" });
	const budget = { used: 38, max: 40 };
	const partial = await worker.fillTextHashes(site.ctx, {}, { limit: 4, budget });
	assert.equal(partial.complete, false);
	assert.deepEqual([partial.counts.checked, partial.filled, partial.skipped.map((s) => s.reason), budget.used], [2, ["articles:E01"], ["queued"], 40]);
	const late = await worker.fillTextHashes(site.ctx, {}, { limit: 4, deadline: Date.now() - 1 });
	assert.deepEqual([late.complete, late.counts.checked], [false, 0]);
	assert.deepEqual(filled(), ["E01"]);
});

test("a page the scheduled run couldn't finish (its time ran out) is looked at again next time; its skips count once", async () => {
	const { site, filled } = await manyLegacy(4);
	site.content.set("articles:E00", { ...site.content.get("articles:E00")!, draftRevisionId: "R2" });
	// Each entry read takes a second of a fake clock.
	const realNow = Date.now;
	let now = realNow();
	const get = (site.ctx as { content: { get: (c: string, id: string) => Promise<unknown> } }).content.get;
	(site.ctx as { content: { get: unknown } }).content.get = async (c: string, id: string) => {
		now += 1000;
		return get(c, id);
	};
	Date.now = () => now;
	try {
		// Time for two reads: E00 (a draft, skipped) and E01 (filled); E02 doesn't start.
		await worker.fillTextHashesTick(site.ctx, {}, { used: 0, max: 40 }, now + 1500);
		assert.deepEqual(filled(), ["E01"]);
		let state = site.kvValue<{ cursor?: string; done?: string; filled: number; skipped: number }>(store.TEXT_HASHES_KEY)!;
		assert.deepEqual([state.cursor, state.done, state.filled, state.skipped], [undefined, undefined, 1, 0], "the page isn't done: no cursor, no skips counted yet");
		// The next run looks at the page again from its start.
		await worker.fillTextHashesTick(site.ctx, {}, { used: 0, max: 40 }, now + 60_000);
		state = site.kvValue<typeof state>(store.TEXT_HASHES_KEY)!;
		assert.ok(state.done);
		assert.deepEqual(filled(), ["E01", "E02", "E03"]);
		assert.deepEqual([state.filled, state.skipped], [3, 1], "E00's skip, once");
	} finally {
		Date.now = realNow;
	}
});

test("the scheduled run fills after the queue work, only while entries are analyzed, and ai/status shows the pass", async () => {
	const { site, filled } = await manyLegacy(12);
	const first = await worker.tick(site.ctx, {}, { budgetMs: 60_000 });
	assert.deepEqual([first.processed, first.skipped, first.failed], [0, 0, 0]);
	assert.equal(filled().length, 10);
	await worker.tick(site.ctx, {}, { budgetMs: 60_000 });
	assert.equal(filled().length, 12);
	const status = await (routes.aiRoutes({})["ai/status"].handler as (ctx: unknown) => Promise<{ textHashes: { done?: string; filled: number } | null }>)(site.ctx);
	assert.ok(status.textHashes?.done);
	assert.equal(status.textHashes?.filled, 12);

	// Entities and descriptions off: the run doesn't fill (saves don't queue then either).
	const off = await manyLegacy(2);
	off.site.settings.set("features", { ai: true, "ai.imageText": true });
	await worker.tick(off.site.ctx, {}, { budgetMs: 60_000 });
	assert.deepEqual(off.filled(), []);
	assert.equal(off.site.kv.has(store.TEXT_HASHES_KEY), false);
	const none = await (routes.aiRoutes({})["ai/status"].handler as (ctx: unknown) => Promise<{ textHashes: unknown }>)(off.site.ctx);
	assert.equal(none.textHashes, null);
});

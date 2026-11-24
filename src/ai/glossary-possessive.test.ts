/**
 * Unit tests for Pack 0.51.0's possessives in glossary.io links: a new link
 * includes the possessive after the name (planGlossaryLinks), an existing
 * glossary.io link gets the possessive after it moved inside it
 * (linkPossessives), and every linkEntry run does both, the ai/glossary-links
 * route too (dry run included), which can also run the fixes alone
 * (only: "possessive").
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/glossary-possessive.test.ts
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as GL from "./glossary-links.ts";
// @ts-ignore -- as above.
import * as LK from "./glossary-linker.ts";
// @ts-ignore -- as above.
import * as G from "./glossary.ts";
// @ts-ignore -- as above.
import * as F from "../core/features.ts";

const links = GL as typeof import("./glossary-links.js");
const linker = LK as typeof import("./glossary-linker.js");
const glossary = G as typeof import("./glossary.js");
const features = F as typeof import("../core/features.js");

features.registerFeatures([
	{ id: "ai", label: "AI Enrichment", description: "", default: false },
	{ id: "ai.glossary", label: "glossary.io definitions", description: "", default: true },
	{ id: "ai.glossaryLinks", label: "glossary.io links", description: "", default: false },
]);

// The model providers can't run under Node (see test/ai.test.mjs). The ai/glossary-links route never calls them, so
// for loading the route they're replaced with a stand-in that only has what the modules read when they load.
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
const routes = (await import("./routes.ts")) as typeof import("./routes.js");

// ── Helpers ──────────────────────────────────────────────────────

type Part = string | { t: string; href: string; marks?: string[] } | { t: string; marks: string[] };
let keyN = 0;
/** A block from text parts; a part with `href` is a link. */
function block(parts: Part[], extra: Record<string, unknown> = {}) {
	const markDefs: Array<{ _type: string; _key: string; href: string }> = [];
	const children = parts.map((p) => {
		const part = typeof p === "string" ? { t: p } : p;
		const marks = [...(("marks" in part && part.marks) || [])];
		if ("href" in part) {
			const k = `m${++keyN}`;
			markDefs.push({ _type: "link", _key: k, href: part.href });
			marks.push(k);
		}
		return { _type: "span", _key: `s${++keyN}`, text: part.t, marks };
	});
	return { _type: "block", _key: `b${++keyN}`, style: "normal", children, markDefs, ...extra };
}

type Child = { _type: string; _key: string; text: string; marks: string[] };
type TestBlock = { _key: string; children: Child[]; markDefs: Array<{ _type: string; _key: string; href: string }> };

/** The links in a body's top-level blocks: [text, href] per link run. */
function linksOf(content: unknown): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const b of content as Array<{ children?: Array<{ text: string; marks?: string[] }>; markDefs?: Array<{ _key: string; href: string }> }>) {
		if (!b.children) continue;
		const defs = new Map((b.markDefs ?? []).map((d) => [d._key, d.href]));
		let cur: [string, string] | null = null;
		for (const c of b.children) {
			const href = (c.marks ?? []).map((m) => defs.get(m)).find(Boolean);
			if (href && cur && cur[1] === href) cur[0] += c.text;
			else if (href) out.push((cur = [c.text, href]));
			else cur = null;
		}
	}
	return out;
}

/** Each top-level block's text, exactly. */
const texts = (content: unknown) => (content as Array<{ children?: Array<{ text?: string }> }>).map((b) => (b.children ?? []).map((c) => c.text ?? "").join(""));
/** A block's children as [text, marks]. */
const spans = (b: unknown) => (b as TestBlock).children.map((c) => [c.text, c.marks]);
const keysUnique = (b: unknown) => {
	const keys = [...(b as TestBlock).children.map((c) => c._key), ...(b as TestBlock).markDefs.map((d) => d._key)];
	return new Set(keys).size === keys.length;
};

const gl = (slug: string) => `https://glossary.io/${slug}/`;
const TERMS: Record<string, { slug: string; names: string[] }> = {
	Q95: { slug: "google", names: ["Google"] },
	Q2: { slug: "anthropic", names: ["Anthropic"] },
	Q26: { slug: "threads", names: ["Threads"] },
	Q312: { slug: "apple", names: ["Apple"] },
	Q911595: { slug: "stumbleupon", names: ["StumbleUpon"] },
};
const lookup = (qid: string) => TERMS[qid] ?? null;
const ent = (qid: string, name: string, more: Record<string, unknown> = {}) => ({ qid, name, type: "Thing", description: "", wikipedia: "", website: "", primary: false, ...more });
const GOOGLE = ent("Q95", "Google", { type: "Organization" });
const THREADS = ent("Q26", "Threads");
const OPTS = { siteHosts: ["coywolf.*"], shortHosts: ["coywolf.io"], newKey: () => `k${++keyN}` };

function plan(content: unknown[], entities: ReturnType<typeof ent>[]) {
	const result = links.planGlossaryLinks(content, entities, lookup, OPTS);
	assert.deepEqual(texts(result.content), texts(content), "the text never changes");
	for (const b of result.content) assert.ok(keysUnique(b), "keys stay unique");
	return result;
}

/** The anchor the rules link for one entity in one sentence. */
const anchorIn = (sentence: string, entity = GOOGLE) => {
	const r = plan([block([sentence])], [entity]);
	assert.equal(r.changes.length, 1, sentence);
	assert.deepEqual(linksOf(r.content), [[r.changes[0].anchor, r.changes[0].href]], sentence);
	return r.changes[0].anchor;
};

// ── New links: the planner ───────────────────────────────────────

test("a new link includes the possessive: 's and ’s, before a space, punctuation or the end; a bare ’ or ' after a name ending in s", () => {
	assert.equal(anchorIn("I read Google's new guide."), "Google's");
	assert.equal(anchorIn("I read Anthropic’s report.", ent("Q2", "Anthropic")), "Anthropic’s");
	assert.equal(anchorIn("The best one is Google's."), "Google's", "before a period");
	assert.equal(anchorIn("The best one is Google’s"), "Google’s", "at the end of the block");
	assert.equal(anchorIn("We trust Google’s, mostly."), "Google’s", "before a comma");
	assert.equal(anchorIn("Meta grew Threads’ audience.", THREADS), "Threads’");
	assert.equal(anchorIn("Meta grew Threads' audience.", THREADS), "Threads'");
	assert.equal(anchorIn("Meta grew Threads'.", THREADS), "Threads'", "a bare apostrophe before punctuation");
	assert.equal(anchorIn("After the ‘big’ launch, Threads’ audience grew.", THREADS), "Threads’", "a quotation closed before the name doesn't count");
	const r = plan([block(["I read Google's guide."])], [GOOGLE]);
	assert.match(r.changes[0].context, /I read \[\[Google's\]\] guide/);
	// Two in one span, each with its possessive.
	const two = plan([block(["I like Google’s—and Apple’s—apps."])], [GOOGLE, ent("Q312", "Apple")]);
	assert.deepEqual(linksOf(two.content), [
		["Google’s", gl("google")],
		["Apple’s", gl("apple")],
	]);
});

test("not a possessive: a plural, a contraction elsewhere, a letter after ’s, a closing quotation mark, a space, a bare apostrophe after no s", () => {
	assert.equal(anchorIn("Apples are fruit, and I like Apples.", ent("Q312", "Apple")), "Apples");
	assert.equal(anchorIn("We asked Google and it's fine."), "Google");
	assert.equal(anchorIn("We asked Google’sfoo about it."), "Google");
	assert.equal(anchorIn("She called it ‘Threads’ at first.", THREADS), "Threads");
	assert.equal(anchorIn("He said 'I like Threads' and left.", THREADS), "Threads");
	assert.equal(anchorIn("We asked Google 's support."), "Google");
	assert.equal(anchorIn("We asked Google' too."), "Google");
});

test("a switched link keeps the author's text in the plan (the linker moves the possessive in afterwards)", () => {
	const wiki = "https://en.wikipedia.org/wiki/StumbleUpon";
	const r = plan([block(["I miss ", { t: "StumbleUpon", href: wiki }, "'s randomness."])], [ent("Q911595", "StumbleUpon", { wikipedia: wiki })]);
	assert.equal(r.changes[0].action, "switch");
	assert.equal(r.changes[0].anchor, "StumbleUpon");
	assert.deepEqual(linksOf(r.content), [["StumbleUpon", gl("stumbleupon")]]);
});

test("a new link's possessive in the next span: joined to the link span with the same marks, its own span with other marks; never from another link or a split", () => {
	const same = plan([block(["I like Google", "'s app."])], [GOOGLE]);
	assert.equal(same.changes[0].anchor, "Google's");
	const sb = same.content[0] as TestBlock;
	assert.deepEqual(spans(sb).map(([text]) => text), ["I like ", "Google's", " app."]);
	assert.deepEqual(linksOf(same.content), [["Google's", gl("google")]]);

	const bold = block(["I like Google", { t: "’s", marks: ["strong"] }, " app."]);
	const r = plan([bold], [GOOGLE]);
	assert.equal(r.changes[0].anchor, "Google’s");
	const rb = r.content[0] as TestBlock;
	const key = rb.markDefs.find((d) => d.href === gl("google"))!._key;
	assert.deepEqual(spans(rb), [
		["I like ", []],
		["Google", [key]],
		["’s", ["strong", key]],
		[" app.", []],
	]);
	assert.equal(rb.children[2]._key, bold.children[1]._key, "the possessive's span keeps its key");

	const other = plan([block(["I like Google", { t: "'s", href: "https://example.com/" }, " app."])], [GOOGLE]);
	assert.equal(other.changes[0].anchor, "Google");
	assert.deepEqual(linksOf(other.content), [
		["Google", gl("google")],
		["'s", "https://example.com/"],
	]);
	const split = plan([block(["I like Google", "’", "s app."])], [GOOGLE]);
	assert.equal(split.changes[0].anchor, "Google", "a possessive split over two spans stays out");
});

// ── Existing links: linkPossessives ──────────────────────────────

test("linkPossessives: the possessive after a glossary.io link moves inside it; the text is byte-identical; nothing to do returns the input", () => {
	const body = [block(["Read ", { t: "Google", href: gl("google") }, "'s new guide."])];
	const before = JSON.stringify(body);
	const out = links.linkPossessives(body);
	assert.deepEqual(texts(out.content), texts(body));
	assert.deepEqual(spans((out.content as unknown[])[0]), [
		["Read ", []],
		["Google's", [body[0].markDefs[0]._key]],
		[" new guide.", []],
	]);
	assert.deepEqual(out.fixes, [{ href: gl("google"), slug: "google", anchor: "Google's", moved: "'s", block: body[0]._key, context: "Read [[Google's]] new guide." }]);
	assert.equal(JSON.stringify(body), before, "the input isn't changed");
	assert.ok(keysUnique((out.content as unknown[])[0]));
	const again = links.linkPossessives(out.content);
	assert.equal(again.content, out.content, "idempotent: the same value back");
	assert.deepEqual(again.fixes, []);
	assert.equal(links.linkPossessives(null).fixes.length, 0);
});

test("linkPossessives: several links in a block, both apostrophes, a bare one after s, punctuation or the end; already inside, a quote, a space (before or in the link) or it's: no change", () => {
	const body = [
		block([{ t: "Anthropic", href: gl("anthropic") }, "’s model, ", { t: "Threads", href: gl("threads") }, "’ growth and ", { t: "Google", href: gl("google") }, "'s."]),
		block(["Ends with ", { t: "Google", href: gl("google") }, "’s"]),
		block(["Already ", { t: "Apple’s", href: gl("apple") }, " store, ‘", { t: "Threads", href: gl("threads") }, "’ quoted, ", { t: "Google", href: gl("google") }, " 's spaced, ", { t: "Google", href: gl("google") }, " it's fine, ", { t: "Google ", href: gl("google") }, "'s after a space in the link."]),
	];
	const out = links.linkPossessives(body);
	assert.deepEqual(texts(out.content), texts(body));
	assert.deepEqual(linksOf(out.content), [
		["Anthropic’s", gl("anthropic")],
		["Threads’", gl("threads")],
		["Google's", gl("google")],
		["Google’s", gl("google")],
		["Apple’s", gl("apple")],
		["Threads", gl("threads")],
		["Google", gl("google")],
		["Google", gl("google")],
		["Google ", gl("google")],
	]);
	assert.deepEqual(out.fixes.map((f) => [f.anchor, f.moved]), [
		["Anthropic’s", "’s"],
		["Threads’", "’"],
		["Google's", "'s"],
		["Google’s", "’s"],
	]);
	const first = (out.content as TestBlock[])[0];
	assert.deepEqual(first.children.map((c) => c.text), ["Anthropic’s", " model, ", "Threads’", " growth and ", "Google's", "."]);
	assert.deepEqual((out.content as TestBlock[])[1].children.map((c) => c.text), ["Ends with ", "Google’s"], "an empty span left over goes");
	assert.deepEqual((out.content as unknown[])[2], body[2], "nothing to fix there");
});

test("linkPossessives: other marks (bold) get a span of their own; the same marks join the link span; an empty leftover span goes", () => {
	// The link is bold, the possessive isn't: a span of its own, with the link.
	const plainAfter = block([{ t: "Google", href: gl("google"), marks: ["strong"] }, "'s guide."]);
	const k = plainAfter.markDefs[0]._key;
	const a = links.linkPossessives([plainAfter], undefined, () => "n1").content as TestBlock[];
	assert.deepEqual(spans(a[0]), [
		["Google", ["strong", k]],
		["'s", [k]],
		[" guide.", []],
	]);
	assert.equal(a[0].children[1]._key, "n1", "a new key for the new span");
	assert.equal(a[0].children[2]._key, plainAfter.children[1]._key, "the rest keeps its key");
	// Both bold: the possessive joins the link span.
	const bothBold = block([{ t: "Google", href: gl("google"), marks: ["strong"] }, { t: "’s guide", marks: ["strong"] }, "."]);
	const kb = bothBold.markDefs[0]._key;
	assert.deepEqual(spans((links.linkPossessives([bothBold]).content as TestBlock[])[0]), [
		["Google’s", ["strong", kb]],
		[" guide", ["strong"]],
		[".", []],
	]);
	// Only the possessive is bold, and nothing is left of its span: it becomes the link's own span, with its key.
	const boldOnly = block([{ t: "Google", href: gl("google") }, { t: "’s", marks: ["em"] }, " guide."]);
	const ko = boldOnly.markDefs[0]._key;
	const c = (links.linkPossessives([boldOnly]).content as TestBlock[])[0];
	assert.deepEqual(spans(c), [
		["Google", [ko]],
		["’s", ["em", ko]],
		[" guide.", []],
	]);
	assert.equal(c.children[1]._key, boldOnly.children[1]._key);
	for (const b of [a[0], c]) assert.ok(keysUnique(b));
});

test("linkPossessives: any glossary.io link (hand-made forms, not a term's page, nested blocks, headings); other links never", () => {
	const body = [
		block([{ t: "SEO", href: "http://www.glossary.io/seo?ref=coywolf" }, "’s basics and ", { t: "the glossary", href: "https://glossary.io/" }, "'s home."]),
		block([{ t: "Google", href: gl("google") }, "'s plans"], { style: "h2" }),
		{ _type: "columns", _key: "cols", columns: [{ _key: "c1", content: [block(["See ", { t: "Google", href: gl("google") }, "'s docs."])] }] },
		block([{ t: "Fastmail", href: "https://www.fastmail.com/" }, "'s plans, ", { t: "Google", href: "https://glossary.example/google/" }, "'s too."]),
		block([{ t: "Google", href: gl("google") }, { t: "'s", href: "https://example.com/" }, " linked elsewhere."]),
		{ _type: "block", _key: "inl", style: "normal", markDefs: [{ _type: "link", _key: "g", href: gl("google") }], children: [{ _type: "span", _key: "a", text: "Google", marks: ["g"] }, { _type: "icon", _key: "i" }, { _type: "span", _key: "b", text: "'s icon", marks: [] }] },
	];
	const out = links.linkPossessives(body);
	assert.deepEqual(out.fixes.map((f) => [f.anchor, f.slug, f.block]), [
		["SEO’s", "seo", body[0]._key],
		["the glossary's", null, body[0]._key],
		["Google's", "google", (body[1] as { _key: string })._key],
		["Google's", "google", (body[2] as { columns: Array<{ content: Array<{ _key: string }> }> }).columns[0].content[0]._key],
	]);
	const blocks = out.content as unknown[];
	assert.deepEqual(blocks.slice(3), body.slice(3), "other sites' links, a span in another link, and an inline object in between: untouched");
	assert.equal(links.bodyText(out.content), links.bodyText(body));
	const nested = (blocks[2] as { columns: Array<{ content: unknown[] }> }).columns[0].content;
	assert.deepEqual(linksOf(nested), [["Google's", gl("google")]]);
});

// ── The entry edit ───────────────────────────────────────────────

const T_OLD = "2026-10-04T23:01:54.489Z";
const INDEX: Record<string, [string, string, string[]]> = {
	Q911595: ["stumbleupon", "A defunct discovery service.", ["StumbleUpon"]],
	Q95: ["google", "A technology company.", ["Google"]],
	Q180711: ["seo", "Search engine optimization.", ["SEO", "search engine optimization"]],
};
const WIKI = "https://en.wikipedia.org/wiki/StumbleUpon";
const ENTITIES = [ent("Q911595", "StumbleUpon", { wikipedia: WIKI }), GOOGLE];

/** A Pack-made link, a hand-made one (SEO isn't one of the entry's entities), and another site's link, each followed by a possessive. */
const POSSESSIVE_BODY = () => [
	block(["Read ", { t: "Google", href: gl("google") }, "'s guide on ", { t: "SEO", href: "http://www.glossary.io/seo?ref=coywolf" }, "’s basics."]),
	block([{ t: "Fastmail", href: "https://www.fastmail.com/" }, "'s plans are fine."]),
];

interface SiteOptions {
	body?: unknown[];
	draft?: string | null;
	version?: number;
	draftBody?: unknown[];
	draftTitle?: string;
	/** null: the entry has no analysis. */
	record?: null;
	memo?: Record<string, unknown>;
	updatedAt?: string;
	features?: Record<string, boolean>;
}

/** A site with one published post (posts:E1), recording content calls and memo writes. */
function fakeSite(opts: SiteOptions = {}) {
	const body = opts.body ?? POSSESSIVE_BODY();
	type Item = { id: string; slug: string; status: string; data: Record<string, unknown>; version: number; updatedAt: string; draftRevisionId: string | null; liveRevisionId: string | null };
	let item: Item = { id: "E1", slug: "joy", status: "published", data: { title: "Joy", content: body }, version: opts.version ?? 3, updatedAt: opts.updatedAt ?? T_OLD, draftRevisionId: opts.draft ?? null, liveRevisionId: "R1" };
	const calls: string[] = [];
	const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
	const logged = (level: string) => (message: string, data?: Record<string, unknown>) => {
		calls.push(`log.${level} ${message}`);
		logs.push({ level, message, data });
	};
	let stamp = 0;
	const tick = () => `2026-11-24T12:00:0${++stamp}.000Z`;
	const record = { collection: "posts", entryId: "E1", title: "Joy", hash: "h", status: "ok", error: "", entities: ENTITIES, description: "", descriptionStatus: "none", updated: "2026-11-23T00:00:00.000Z" };
	const entries = new Map<string, unknown>(opts.record === null ? [] : [["posts:E1", record]]);
	const memos = new Map<string, Record<string, unknown>>();
	if (opts.memo) memos.set("posts:E1", { collection: "posts", entryId: "E1", linked: [], updated: "", ...opts.memo });
	const kv = new Map<string, { value: unknown; revision: string }>();
	let revision = 0;
	const ctx = {
		site: { url: "https://coywolf.com" },
		settings: { get: async (key: string) => (key === "features" ? (opts.features ?? null) : null) },
		kv: {
			get: async (k: string) => kv.get(k)?.value ?? null,
			getVersioned: async (k: string) => kv.get(k) ?? null,
			compareAndSet: async (k: string, rev: string | null, value: unknown) => {
				if ((kv.get(k)?.revision ?? null) !== rev) return { applied: false };
				kv.set(k, { value, revision: String(++revision) });
				return { applied: true };
			},
			compareAndDelete: async (k: string, rev: string) => {
				if (kv.get(k)?.revision === rev) kv.delete(k);
				return true;
			},
		},
		log: { info: logged("info"), warn: logged("warn"), error: logged("error") },
		schema: { getCollection: async () => ({ slug: "posts", supports: ["revisions", "drafts"], fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "content", type: "portableText", sortOrder: 1 }] }) },
		storage: {
			aiEntries: { get: async (k: string) => entries.get(k) ?? null, put: async (k: string, v: unknown) => void entries.set(k, v), query: async () => ({ items: [...entries].map(([id, data]) => ({ id, data })), hasMore: false }) },
			aiQueue: { get: async () => null },
			aiLinks: {
				get: async (k: string) => structuredClone(memos.get(k) ?? null),
				put: async (k: string, v: Record<string, unknown>) => {
					calls.push("memo");
					memos.set(k, structuredClone(v));
				},
				delete: async (k: string) => {
					calls.push("memo delete");
					return memos.delete(k);
				},
				query: async () => ({ items: [...memos].filter(([, v]) => typeof v.retryAt === "number" && (v.retryAt as number) <= Date.now()).map(([id, data]) => ({ id, data: structuredClone(data) })), hasMore: false }),
			},
			aiGlossary: { get: async (id: string) => (id === "index" ? { fetchedAt: Date.now(), format: 2, terms: INDEX } : null), put: async () => {} },
		},
		http: { fetch: async () => new Response("{}", { status: 500 }) },
		content: {
			get: async () => {
				calls.push("get");
				return structuredClone(item);
			},
			getRevision: async (_c: string, _id: string, rev: string) => {
				calls.push(`getRevision ${rev}`);
				return { data: { title: opts.draftTitle ?? "Joy", content: opts.draftBody ?? body } };
			},
			update: async (_c: string, _id: string, patch: Record<string, unknown>) => {
				calls.push("update");
				item = { ...item, data: { ...item.data, ...patch }, version: item.version + 1, updatedAt: tick(), draftRevisionId: "R2" };
				const { version: _v, draftRevisionId: _d, liveRevisionId: _l, ...saved } = structuredClone(item);
				return saved;
			},
			getVersioned: async () => ({ item: structuredClone(item), _rev: `rev-${item.version}` }),
			publish: async (_c: string, _id: string, o: { _rev: string }) => {
				calls.push(`publish ${o._rev}`);
				item = { ...item, draftRevisionId: null, liveRevisionId: item.draftRevisionId, version: item.version + 1, updatedAt: tick() };
				return { item: structuredClone(item), _rev: `rev-${item.version}` };
			},
		},
	};
	return { ctx: ctx as never, calls, logs, memos, item: () => item };
}

/** A recording stand-in for keepDates' database and page purges. */
function keepDatesSpy() {
	const statements: Array<{ sql: string; args: unknown[] }> = [];
	const purges: unknown[] = [];
	const io = linker.keepDatesIo;
	const saved = { database: io.database, purge: io.purge, later: io.later };
	const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ run: async () => (statements.push({ sql, args }), { meta: { changes: 1 } }) }) }) };
	io.database = async () => db as unknown as D1Database;
	io.purge = (async (_ctx: unknown, entries: unknown) => void purges.push(entries)) as typeof io.purge;
	io.later = () => undefined;
	return { statements, purges, restore: () => Object.assign(io, saved) };
}

const writes = (site: ReturnType<typeof fakeSite>) => site.calls.filter((c) => c === "update" || c.startsWith("publish"));

test("an entry whose only change is a possessive: fixed and published once, status linked, no term counted as linked", async () => {
	glossary.resetGlossaryForTests();
	const body = POSSESSIVE_BODY();
	const site = fakeSite({ body, memo: { linked: ["Q95"] } });
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1", { textHash: "th" });
	assert.equal(out.status, "linked");
	assert.deepEqual(out.changes, [
		{ action: "possessive", qid: "Q95", entity: "Google", slug: "google", href: gl("google"), anchor: "Google's", block: body[0]._key, why: "'s", context: "Read [[Google's]] guide on SEO’s basics." },
		{ action: "possessive", qid: "Q180711", entity: "SEO", slug: "seo", href: "http://www.glossary.io/seo?ref=coywolf", anchor: "SEO’s", block: body[0]._key, why: "’s", context: "Read Google's guide on [[SEO’s]] basics." },
	]);
	assert.deepEqual(writes(site), ["update", "publish rev-4"]);
	const content = site.item().data.content;
	assert.deepEqual(linksOf(content), [
		["Google's", gl("google")],
		["SEO’s", "http://www.glossary.io/seo?ref=coywolf"],
		["Fastmail", "https://www.fastmail.com/"],
	]);
	assert.deepEqual(texts(content), texts(POSSESSIVE_BODY()), "the text is unchanged");
	const memo = site.memos.get("posts:E1")!;
	assert.deepEqual(memo.linked, ["Q95"], "a possessive fix links no term (Q180711 isn't remembered)");
	assert.equal(memo.textHash, "th");
	for (const k of ["pending", "draft", "pendingQids", "pendingSlugs", "pendingPossessive", "retryAt"]) assert.equal(memo[k], undefined, k);
	assert.ok(site.calls.includes("memo"));

	// Done: nothing more to do.
	const again = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(again.status, "unchanged");
	assert.deepEqual(writes(site), ["update", "publish rev-4"]);
});

test("a switch and a new link in the same run: the new link has its possessive, the switched one gets it moved in, one publish", async () => {
	glossary.resetGlossaryForTests();
	const body = [block(["I miss ", { t: "StumbleUpon", href: WIKI }, "'s randomness. Google’s search is fine."])];
	const site = fakeSite({ body });
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(out.status, "linked");
	assert.deepEqual((out.changes as Array<{ action: string; anchor: string; qid: string }>).map((c) => [c.action, c.anchor, c.qid]), [
		["switch", "StumbleUpon", "Q911595"],
		["add", "Google’s", "Q95"],
		["possessive", "StumbleUpon's", "Q911595"],
	]);
	assert.deepEqual(linksOf(site.item().data.content), [
		["StumbleUpon's", gl("stumbleupon")],
		["Google’s", gl("google")],
	]);
	assert.deepEqual(texts(site.item().data.content), texts(body));
	assert.deepEqual(writes(site), ["update", "publish rev-4"]);
	assert.deepEqual(site.memos.get("posts:E1")!.linked, ["Q911595", "Q95"]);
});

test("possessive fixes wait like links: someone's draft, a recent save", async () => {
	for (const [more, status] of [
		[{ draft: "R9" }, "draft"],
		[{ updatedAt: new Date(Date.now() - 30_000).toISOString() }, "busy"],
	] as const) {
		glossary.resetGlossaryForTests();
		const site = fakeSite(more);
		const out = await linker.linkEntry(site.ctx, {}, "posts", "E1");
		assert.equal(out.status, status);
		assert.deepEqual(writes(site), [], status);
		assert.equal(typeof site.memos.get("posts:E1")!.retryAt, "number", `${status} is tried again`);
	}
});

test("an unpublished possessive edit of its own is finished (its draft has them moved, the live entry doesn't); an editor's draft never", async () => {
	const marker = { pending: 3, pendingQids: [], pendingSlugs: [], pendingPossessive: 2, linked: ["Q95"] };
	// The edit's draft is the live body with its possessives moved (same blocks and keys, as the edit wrote it).
	const body = POSSESSIVE_BODY();
	const fixed = links.linkPossessives(body).content as unknown[];
	glossary.resetGlossaryForTests();
	const own = fakeSite({ body, draft: "R7", version: 4, memo: marker, draftBody: fixed });
	const out = await linker.linkEntry(own.ctx, {}, "posts", "E1");
	assert.equal(out.status, "linked");
	assert.equal(out.reason, "published the draft an earlier run saved");
	assert.deepEqual(writes(own), ["publish rev-4"]);
	assert.deepEqual(own.memos.get("posts:E1")!.linked, ["Q95"], "nothing new is counted as linked");
	assert.equal(own.memos.get("posts:E1")!.pendingPossessive, undefined);

	for (const [more, why] of [
		[{ draftBody: body }, "the possessives are still outside"],
		[{ draftBody: fixed, draftTitle: "Joy, retitled" }, "another field changed"],
		[{ draftBody: [block(["Read Google's guide."])] }, "other text"],
	] as Array<[SiteOptions, string]>) {
		glossary.resetGlossaryForTests();
		const site = fakeSite({ body, draft: "R7", version: 4, memo: marker, ...more });
		assert.equal((await linker.linkEntry(site.ctx, {}, "posts", "E1")).status, "draft", why);
		assert.deepEqual(writes(site), [], why);
		assert.equal(site.memos.get("posts:E1")!.pending, undefined, `${why}: the stale marker is dropped`);
	}
});

/** An editor's draft is left alone: nothing published, the stale marker dropped, tried again later. */
async function assertForeignDraft(options: SiteOptions, why: string) {
	glossary.resetGlossaryForTests();
	const site = fakeSite({ draft: "R7", version: 4, ...options });
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(out.status, "draft", why);
	assert.deepEqual(writes(site), [], `${why}: nothing published`);
	const memo = site.memos.get("posts:E1")!;
	for (const k of ["pending", "pendingPossessive", "pendingSlugs"]) assert.equal(memo[k], undefined, `${why}: the stale marker is dropped (${k})`);
	assert.equal(typeof memo.retryAt, "number", `${why}: tried again like any draft`);
}

test("a possessive-only marker: an editor's draft with the same text is never published as the Pack's (links removed or re-pointed, another link or an image changed, formatting)", async () => {
	const marker = { pending: 3, pendingQids: [], pendingSlugs: [], pendingPossessive: 2, linked: ["Q95"] };
	const body = POSSESSIVE_BODY();
	const SEO = "http://www.glossary.io/seo?ref=coywolf";
	const fixed = links.linkPossessives(body).content as Array<Record<string, unknown>>;
	const edit = (change: (copy: Array<{ children: Child[]; markDefs: Array<{ href: string }> }>) => void) => {
		const copy = structuredClone(fixed) as never as Array<{ children: Child[]; markDefs: Array<{ href: string }> }>;
		change(copy);
		return copy as unknown[];
	};
	const cases: Array<[unknown[], string]> = [
		// The glossary links removed, another link's address changed, and an image added: the text is the same, and no possessive is left to move.
		[[block(["Read Google's guide on SEO’s basics."]), block([{ t: "Fastmail", href: "https://example.net/elsewhere" }, "'s plans are fine."]), { _type: "image", _key: "img1", asset: { _ref: "x" } }], "links removed, a link changed, an image added"],
		// A link re-pointed, with the 's typed inside it.
		[[block(["Read ", { t: "Google's", href: gl("apple") }, " guide on ", { t: "SEO’s", href: SEO }, " basics."]), body[1]], "a link re-pointed with the possessive inside"],
		[edit((c) => void (c[1].markDefs[0].href = "https://example.net/elsewhere")), "the fixes, and another site's link changed"],
		[edit((c) => void c.push({ _type: "image", _key: "img1" } as never)), "the fixes, and an image added"],
		[edit((c) => void c[0].children[0].marks.push("strong")), "the fixes, and formatting changed"],
		[edit((c) => void (c[0].markDefs[0].href = gl("apple"))), "the fixes, and a glossary.io link re-pointed"],
		[[{ ...fixed[0], style: "h2" }, fixed[1]], "the fixes, and a paragraph made a heading"],
	];
	for (const [draftBody, why] of cases) {
		assert.equal(links.bodyText(draftBody), links.bodyText(body), `${why}: the text is the same`);
		await assertForeignDraft({ body, memo: marker, draftBody }, why);
	}
	// A marker for another number of fixes than the live entry has to make isn't this edit's either.
	await assertForeignDraft({ body, memo: { ...marker, pendingPossessive: 1 }, draftBody: fixed }, "another number of fixes");

	// Its own draft is still finished: also when the fix gave a split-off span a new key.
	const bold = [block(["Read ", { t: "Google", href: gl("google"), marks: ["strong"] }, "'s guide."])];
	const own = links.linkPossessives(bold, undefined, () => "random-key").content as unknown[];
	glossary.resetGlossaryForTests();
	const site = fakeSite({ body: bold, draft: "R7", version: 4, memo: { ...marker, pendingPossessive: 1 }, draftBody: own });
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(out.status, "linked");
	assert.equal(out.reason, "published the draft an earlier run saved");
	assert.deepEqual(writes(site), ["publish rev-4"]);
});

test("a marker with links and possessives: only a draft with the live entry's glossary terms plus the edit's, nothing left to move, and nothing else changed is published", async () => {
	const body = [block(["I miss ", { t: "StumbleUpon", href: WIKI }, "'s randomness. Google’s search and ", { t: "Fastmail", href: "https://www.fastmail.com/" }, " are fine."])];
	// What the edit writes: one real run on the same body.
	glossary.resetGlossaryForTests();
	const first = fakeSite({ body });
	assert.equal((await linker.linkEntry(first.ctx, {}, "posts", "E1")).status, "linked");
	const made = first.item().data.content as Array<{ children: Child[]; markDefs: Array<{ _type: string; _key: string; href: string }> }>;
	assert.deepEqual(linksOf(made), [
		["StumbleUpon's", gl("stumbleupon")],
		["Google’s", gl("google")],
		["Fastmail", "https://www.fastmail.com/"],
	]);
	const marker = { pending: 3, pendingQids: ["Q911595", "Q95"], pendingSlugs: ["stumbleupon", "google"], pendingPossessive: 1, linked: [] };

	glossary.resetGlossaryForTests();
	const own = fakeSite({ body, draft: "R7", version: 4, memo: marker, draftBody: made });
	const out = await linker.linkEntry(own.ctx, {}, "posts", "E1");
	assert.equal(out.status, "linked");
	assert.deepEqual(writes(own), ["publish rev-4"]);
	assert.deepEqual(own.memos.get("posts:E1")!.linked, ["Q911595", "Q95"]);

	const edit = (change: (copy: typeof made) => void) => {
		const copy = structuredClone(made);
		change(copy);
		return copy as unknown[];
	};
	for (const [draftBody, why] of [
		[edit((c) => void (c[0].markDefs.find((d) => d.href.includes("fastmail"))!.href = "https://example.net/elsewhere")), "another site's link changed"],
		[edit((c) => void c.push({ _type: "image", _key: "img1" } as never)), "an image added"],
		[edit((c) => void c[0].children[0].marks.push("em")), "formatting changed"],
		[edit((c) => void (c[0].markDefs.find((d) => d.href.includes("fastmail"))!.href = gl("apple"))), "another glossary.io term linked"],
		[edit((c) => void (c[0].markDefs.find((d) => d.href === gl("google"))!.href = "https://www.google.com/")), "one of the edit's links re-pointed"],
		[edit((c) => void ((c[0] as Record<string, unknown>).style = "blockquote")), "the paragraph made a quote"],
	] as Array<[unknown[], string]>) {
		assert.equal(links.bodyText(draftBody), links.bodyText(body), `${why}: the text is the same`);
		await assertForeignDraft({ body, memo: marker, draftBody }, why);
	}
	await assertForeignDraft({ body, memo: marker, draftBody: made, draftTitle: "Joy, retitled" }, "another field changed");
});

// ── What counts as a possessive ──────────────────────────────────

/** The links after linkPossessives, for one paragraph with glossary.io links. */
const fixedLinks = (parts: Part[]) => {
	const body = [block(parts)];
	const out = links.linkPossessives(body);
	assert.deepEqual(texts(out.content), texts(body), "the text never changes");
	assert.equal(links.linkPossessives(out.content).content, out.content, "idempotent");
	return linksOf(out.content).map(([text]) => text);
};
const GL_GOOGLE = { t: "Google", href: gl("google") };
const T = { t: "Threads", href: gl("threads") };
const USERS = { t: "users", href: gl("user") };

test("not a possessive: 's before a digit or a hyphen, 'S after a name that isn't in capitals", () => {
	assert.deepEqual(fixedLinks(["The ", GL_GOOGLE, "'s5 model."]), ["Google"]);
	assert.deepEqual(fixedLinks(["The ", GL_GOOGLE, "’s2 model."]), ["Google"]);
	assert.deepEqual(fixedLinks(["In ", { t: "Den Bosch", href: gl("den-bosch") }, "'s-Hertogenbosch."]), ["Den Bosch"]);
	assert.deepEqual(fixedLinks(["In ", GL_GOOGLE, "’s‑eye view."]), ["Google"], "a non-breaking hyphen");
	assert.deepEqual(fixedLinks(["All ", USERS, "'5 and ", T, "’-like."]), ["users", "Threads"], "a bare apostrophe before a digit or a hyphen");
	assert.deepEqual(fixedLinks(["Read ", GL_GOOGLE, "'S guide and ", GL_GOOGLE, "’S guide."]), ["Google", "Google"]);
	// A dash isn't a hyphen, and a name in capitals takes 'S.
	assert.deepEqual(fixedLinks(["I like ", GL_GOOGLE, "’s—mostly. And ", GL_GOOGLE, "'s–like."]), ["Google’s", "Google's"]);
	assert.deepEqual(fixedLinks(["READ ", { t: "GOOGLE", href: gl("google") }, "'S GUIDE AND ", { t: "IBM", href: gl("ibm") }, "’S."]), ["GOOGLE'S", "IBM’S"]);
	assert.deepEqual(fixedLinks(["Read ", { t: "IBM", href: gl("ibm") }, "'s guide."]), ["IBM's"]);
	// New links follow the same rule.
	assert.equal(anchorIn("We read Google's-eye views."), "Google");
	assert.equal(anchorIn("We bought Google's5 phones."), "Google");
	assert.equal(anchorIn("We read Google'S guide."), "Google");
});

test("the letter apostrophe ʼ (U+02BC) is a possessive's apostrophe like ’", () => {
	assert.deepEqual(fixedLinks(["Read ", GL_GOOGLE, "ʼs guide and ", T, "ʼ growth."]), ["Googleʼs", "Threadsʼ"]);
	assert.deepEqual(fixedLinks(["Read ", { t: "Googleʼs", href: gl("google") }, "'s guide."]), ["Googleʼs"], "already inside: nothing more");
	assert.deepEqual(fixedLinks(["Read ", GL_GOOGLE, "ʼsfoo."]), ["Google"]);
	// (The rules don't link a plain "Googleʼs": ʼ is a letter to Unicode, so the name isn't a whole word there.)
	assert.equal(plan([block(["We read Googleʼs guide."])], [GOOGLE]).changes.length, 0);
});

test("a bare apostrophe after a name ending in s isn't taken inside an open quotation of any kind, or right after =, / or a quotation mark", () => {
	// An opening mark earlier in the paragraph that nothing closed: the apostrophe may be its closing mark.
	assert.deepEqual(fixedLinks(["She said “we use ", T, "’ and left."]), ["Threads"]);
	assert.deepEqual(fixedLinks(['He wrote "all ', USERS, "' and stopped."]), ["users"]);
	assert.deepEqual(fixedLinks(["He wrote 'all ", USERS, "' and stopped."]), ["users"]);
	assert.deepEqual(fixedLinks(["He wrote ‘all ", USERS, "’ and stopped."]), ["users"]);
	assert.deepEqual(fixedLinks(["She said “we use ", "the app ", T, "’ and left."]), ["Threads"], "opened in an earlier span");
	// Code-like text and a mark right before the name.
	assert.deepEqual(fixedLinks(["Set name=", USERS, "' in the file."]), ["users"]);
	assert.deepEqual(fixedLinks(["Open /", USERS, "' in the app."]), ["users"]);
	assert.deepEqual(fixedLinks(["Open admin/", USERS, "’ in the app."]), ["users"]);
	assert.deepEqual(fixedLinks(["It said ”", T, "’ twice."]), ["Threads"]);
	assert.deepEqual(fixedLinks(["It said `", USERS, "' twice."]), ["users"]);
	// 's is still taken in all of those places.
	assert.deepEqual(fixedLinks(["She said “we use ", GL_GOOGLE, "’s tools” and left."]), ["Google’s"]);
	assert.deepEqual(fixedLinks(['He wrote "all of ', GL_GOOGLE, "'s tools\" and stopped."]), ["Google's"]);
	// New links follow the same rule.
	assert.equal(anchorIn("She said “we use Threads’ and left.", THREADS), "Threads");
});

test("still a possessive: users', iOS', after a closed quotation or a contraction, after '90s", () => {
	assert.deepEqual(fixedLinks(["All ", USERS, "' data and ", { t: "iOS", href: gl("ios") }, "' features."]), ["users'", "iOS'"]);
	assert.deepEqual(fixedLinks(["He said “hi” and saw ", T, "’ growth."]), ["Threads’"]);
	assert.deepEqual(fixedLinks(['He said "hi" and saw ', T, "' growth."]), ["Threads'"]);
	assert.deepEqual(fixedLinks(["After the ‘big’ launch, ", T, "’ audience grew."]), ["Threads’"]);
	assert.deepEqual(fixedLinks(["We don’t doubt ", T, "’ growth, and it’s ", USERS, "’ choice."]), ["Threads’", "users’"]);
	assert.deepEqual(fixedLinks(["“It’s fine,” she said of ", T, "’ growth."]), ["Threads’"]);
	assert.deepEqual(fixedLinks(["In the '90s, ", GL_GOOGLE, "'s rise began."]), ["Google's"]);
	assert.deepEqual(fixedLinks(["Read ", GL_GOOGLE, "’s日本 and ", GL_GOOGLE, "’sé."]), ["Google", "Google"], "a letter of any script after s");
	assert.deepEqual(fixedLinks(["Read ", { t: "Google ", href: gl("google") }, "'s guide."]), ["Google "]);
});

// ── Code, and content the fix can't read ─────────────────────────

test("a possessive in code is left alone: after an existing glossary.io link, and after a new link", () => {
	const body = [block(["Run ", GL_GOOGLE, { t: "'s", marks: ["code"] }, " tool, or ", GL_GOOGLE, { t: "’s tool", marks: ["code", "strong"] }, "."])];
	const out = links.linkPossessives(body);
	assert.equal(out.content, body, "nothing to fix");
	assert.deepEqual(out.fixes, []);
	// Other formatting still moves in.
	assert.deepEqual(fixedLinks(["Run ", GL_GOOGLE, { t: "'s", marks: ["strong"] }, " tool."]), ["Google's"]);
	const added = plan([block(["I like Google", { t: "'s", marks: ["code"] }, " app."])], [GOOGLE]);
	assert.equal(added.changes[0].anchor, "Google");
	assert.deepEqual(linksOf(added.content), [["Google", gl("google")]]);
});

/** A nested block whose second span's marks aren't a list. */
const MALFORMED = () => ({
	_type: "columns",
	_key: "cols",
	columns: [{ _key: "c1", content: [{ _type: "block", _key: "nb", style: "normal", markDefs: [{ _type: "link", _key: "g", href: gl("google") }], children: [{ _type: "span", _key: "a", text: "Google", marks: ["g"] }, { _type: "span", _key: "b", text: "'s docs", marks: "strong" }] }] }],
});

test("a nested block with a span whose marks aren't a list doesn't fail the entry: it's left as it is, and the term links go ahead", async () => {
	const malformed = MALFORMED();
	const fixed = links.linkPossessives([block(["See ", GL_GOOGLE, "'s guide."]), malformed]);
	assert.deepEqual(fixed.fixes.map((f) => f.anchor), ["Google's"], "the well-formed block is fixed");
	assert.deepEqual((fixed.content as unknown[])[1], malformed, "the malformed one is untouched");
	assert.deepEqual(links.linkPossessives([malformed]).fixes, []);

	glossary.resetGlossaryForTests();
	const body = [block(["I miss StumbleUpon a lot."]), malformed];
	const site = fakeSite({ body });
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(out.status, "linked");
	assert.deepEqual((out.changes as Array<{ action: string; anchor: string }>).map((c) => [c.action, c.anchor]), [["add", "StumbleUpon"]]);
	assert.deepEqual(writes(site), ["update", "publish rev-4"]);
	assert.deepEqual((site.item().data.content as unknown[])[1], malformed);
});

test("a possessive fix that throws is logged and skipped: the term links are still made and published", async () => {
	const saved = linker.possessivesIo.fix;
	linker.possessivesIo.fix = () => {
		throw new TypeError("can't read this");
	};
	try {
		glossary.resetGlossaryForTests();
		const site = fakeSite({ body: [block(["I miss StumbleUpon a lot. Read ", GL_GOOGLE, "'s guide."])] });
		const out = await linker.linkEntry(site.ctx, {}, "posts", "E1");
		assert.equal(out.status, "linked");
		assert.deepEqual((out.changes as Array<{ action: string; anchor: string }>).map((c) => [c.action, c.anchor]), [["add", "StumbleUpon"]]);
		assert.deepEqual(writes(site), ["update", "publish rev-4"]);
		const warning = site.logs.find((l) => l.level === "warn");
		assert.match(warning!.message, /couldn't check a field's possessives/);
		assert.deepEqual({ entry: warning!.data!.entry, field: warning!.data!.field }, { entry: "posts:E1", field: "content" });
		assert.deepEqual(linksOf(site.item().data.content), [
			["StumbleUpon", gl("stumbleupon")],
			["Google", gl("google")],
		]);
	} finally {
		linker.possessivesIo.fix = saved;
	}
});

// ── Logs ─────────────────────────────────────────────────────────

test("logs count term links and possessive fixes separately", async () => {
	assert.deepEqual(linker.changeCounts([]), { links: 0 });
	assert.deepEqual(linker.changeCounts([{ action: "add" }, { action: "switch" }, { action: "possessive" }, { action: "possessive" }, { action: "possessive" }] as never), { links: 2, possessives: 3 });
	assert.deepEqual(linker.changeCounts([{ slug: "x", qid: "Q1", removed: 2 }]), { links: 1 });

	// A retry that links a term and fixes a possessive.
	glossary.resetGlossaryForTests();
	const site = fakeSite({ body: [block(["I miss StumbleUpon a lot. Read ", GL_GOOGLE, "'s guide and ", { t: "SEO", href: gl("seo") }, "’s basics."])], memo: { retryAt: Date.now() - 1000, tries: 1 } });
	assert.equal(await linker.retryDue(site.ctx, {}, 3), 1);
	const line = site.logs.find((l) => l.message === "glossary.io links (retry)")!;
	assert.deepEqual(line.data, { entry: "posts:E1", links: 1, possessives: 2 });
	// The scheduled analysis logs the same two counts (src/ai/worker.ts can't be loaded here: checked in its source).
	const worker = (await import("node:fs")).readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
	assert.match(worker, /ctx\.log\.info\("glossary\.io links", \{ entry: key, status: linked\.status, \.\.\.changeCounts\(linked\.changes\),/);
	assert.doesNotMatch(worker, /links: linked\.changes\.length/);
});

// ── The ai/glossary-links route ──────────────────────────────────

const ON = { ai: true, "ai.entities": true, "ai.glossaryLinks": true };
const route = (options: Record<string, unknown>) => routes.aiRoutes(options)["ai/glossary-links"];
const call = (site: ReturnType<typeof fakeSite>, options: Record<string, unknown>, input: Record<string, unknown>) =>
	(route(options).handler as (ctx: unknown) => Promise<{ results: Array<{ status: string; changes: Array<Record<string, unknown>>; dateKept?: boolean }> }>)({ ...(site.ctx as object), input });

test("ai/glossary-links: a dry run lists the possessive fixes and writes nothing; a real run publishes them once, with keepDates", async () => {
	glossary.resetGlossaryForTests();
	const dry = fakeSite({ memo: { linked: ["Q95"] } });
	const planned = await call(dry, {}, { keys: ["posts:E1"], dryRun: true });
	assert.equal(planned.results[0].status, "planned");
	assert.deepEqual(planned.results[0].changes.map((c) => [c.action, c.anchor, c.slug, c.qid]), [
		["possessive", "Google's", "google", "Q95"],
		["possessive", "SEO’s", "seo", "Q180711"],
	]);
	assert.deepEqual(writes(dry), []);
	assert.ok(!dry.calls.includes("memo"), "a dry run remembers nothing");
	assert.deepEqual(linksOf(dry.item().data.content).map(([text]) => text), ["Google", "SEO", "Fastmail"]);

	glossary.resetGlossaryForTests();
	const spy = keepDatesSpy();
	try {
		const site = fakeSite({ memo: { linked: ["Q95"] }, features: ON });
		const done = await call(site, { glossaryLinks: { keepDates: true } }, { keys: ["posts:E1"] });
		assert.equal(done.results[0].status, "linked");
		assert.equal(done.results[0].dateKept, true);
		assert.deepEqual(done.results[0].changes.map((c) => c.action), ["possessive", "possessive"]);
		assert.deepEqual(writes(site), ["update", "publish rev-4"], "one publish");
		assert.equal(spy.statements.length, 1);
		assert.deepEqual(spy.statements[0].args, [T_OLD, "E1", site.item().updatedAt, 5, "R2"], "the date is put back on the row the publish left");
		assert.equal(spy.purges.length, 1);
		assert.deepEqual(linksOf(site.item().data.content).map(([text]) => text), ["Google's", "SEO’s", "Fastmail"]);
		assert.deepEqual(site.memos.get("posts:E1")!.linked, ["Q95"]);
	} finally {
		spy.restore();
	}
});

// ── Possessives only ─────────────────────────────────────────────

/** A plain mention the rules would link, a link they'd switch, and an existing glossary.io link with a possessive after it. */
const MIXED_BODY = () => [block(["I miss ", { t: "StumbleUpon", href: WIKI }, " a lot. Google is fine. Read ", { t: "SEO", href: gl("seo") }, "’s basics."])];

test("ai/glossary-links with only: \"possessive\": the dry run and the real run fix possessives and nothing else; nothing is linked, switched or remembered", async () => {
	// A normal run would link here: that's what the option leaves out.
	glossary.resetGlossaryForTests();
	const normal = await call(fakeSite({ body: MIXED_BODY() }), {}, { keys: ["posts:E1"], dryRun: true });
	assert.deepEqual(normal.results[0].changes.map((c) => [c.action, c.anchor]), [
		["switch", "StumbleUpon"],
		["add", "Google"],
		["possessive", "SEO’s"],
	]);

	glossary.resetGlossaryForTests();
	const dry = fakeSite({ body: MIXED_BODY() });
	const planned = await call(dry, {}, { keys: ["posts:E1"], dryRun: true, only: "possessive" });
	assert.equal(planned.results[0].status, "planned");
	assert.deepEqual(planned.results[0].changes.map((c) => [c.action, c.anchor, c.qid]), [["possessive", "SEO’s", "Q180711"]]);
	assert.deepEqual(writes(dry), []);
	assert.ok(!dry.calls.some((c) => c.startsWith("memo")), "a dry run remembers nothing");

	// The real run, for an entry the links remembered things about: all of it stays as it was.
	glossary.resetGlossaryForTests();
	const spy = keepDatesSpy();
	try {
		const retryAt = Date.now() + 60_000;
		const before = { linked: ["Q1"], textHash: "seen", retryAt, tries: 2 };
		const body = MIXED_BODY();
		const site = fakeSite({ body, memo: before, features: ON });
		const done = await call(site, { glossaryLinks: { keepDates: true } }, { keys: ["posts:E1"], only: "possessive", exclude: { "posts:E1": ["Q95"] } });
		assert.equal(done.results[0].status, "linked");
		assert.equal(done.results[0].dateKept, true, "keepDates applies");
		assert.deepEqual(done.results[0].changes.map((c) => [c.action, c.anchor]), [["possessive", "SEO’s"]]);
		assert.deepEqual(writes(site), ["update", "publish rev-4"], "one publish, through the same path");
		assert.deepEqual(linksOf(site.item().data.content), [
			["StumbleUpon", WIKI],
			["SEO’s", gl("seo")],
		]);
		assert.deepEqual(texts(site.item().data.content), texts(body));
		const { updated: _u, ...memo } = site.memos.get("posts:E1")!;
		assert.deepEqual(memo, { collection: "posts", entryId: "E1", ...before }, "linked, the text hash and the waiting retry are untouched; exclude is ignored");
	} finally {
		spy.restore();
	}

	// An entry with nothing remembered ends with nothing remembered (a memo without a text hash would make its next analysis link).
	glossary.resetGlossaryForTests();
	const blank = fakeSite({ body: MIXED_BODY(), features: ON });
	const fixed = await call(blank, {}, { keys: ["posts:E1"], only: "possessive" });
	assert.equal(fixed.results[0].status, "linked");
	assert.deepEqual(writes(blank), ["update", "publish rev-4"]);
	assert.equal(blank.memos.has("posts:E1"), false);
	// Done: a second run finds nothing, and still leaves nothing.
	const again = await call(blank, {}, { keys: ["posts:E1"], only: "possessive" });
	assert.equal(again.results[0].status, "unchanged");
	assert.deepEqual(writes(blank), ["update", "publish rev-4"]);
	assert.equal(blank.memos.has("posts:E1"), false);

	// An entry that was never analyzed is fixed too (nothing is planned from an analysis).
	glossary.resetGlossaryForTests();
	const unanalyzed = fakeSite({ body: MIXED_BODY(), features: ON, record: null });
	const u = await call(unanalyzed, {}, { keys: ["posts:E1"], only: "possessive" });
	assert.equal(u.results[0].status, "linked");
	assert.deepEqual(linksOf(unanalyzed.item().data.content).map(([text]) => text), ["StumbleUpon", "SEO’s"]);
	glossary.resetGlossaryForTests();
	assert.equal((await call(fakeSite({ body: MIXED_BODY(), features: ON, record: null }), {}, { keys: ["posts:E1"] })).results[0].status, "skipped", "a normal run still needs the analysis");

	// The option takes only that one value, and the part has to be on for a real run.
	await assert.rejects(call(fakeSite({ features: ON }), {}, { keys: ["posts:E1"], only: "links" }));
	await assert.rejects(call(fakeSite(), {}, { keys: ["posts:E1"], only: "possessive" }), /Turn on glossary\.io links first/);
});

test("a possessives-only run that has to wait or fails schedules no retry (a retry would link); its own unpublished edit is finished by the next run", async () => {
	for (const [more, status] of [
		[{ draft: "R9" }, "draft"],
		[{ updatedAt: new Date(Date.now() - 30_000).toISOString() }, "busy"],
	] as const) {
		glossary.resetGlossaryForTests();
		const site = fakeSite({ body: MIXED_BODY(), features: ON, ...more });
		const out = await call(site, {}, { keys: ["posts:E1"], only: "possessive" });
		assert.equal(out.results[0].status, status);
		assert.deepEqual(writes(site), [], status);
		assert.equal(site.memos.has("posts:E1"), false, `${status}: nothing remembered, so nothing is retried`);
		assert.equal(await linker.retryDue(site.ctx, {}, 3), 0);
	}
	// An error: reported, and no retry is written either (a normal run writes one).
	for (const [input, retried] of [
		[{ keys: ["posts:E1"], only: "possessive" }, false],
		[{ keys: ["posts:E1"] }, true],
	] as const) {
		glossary.resetGlossaryForTests();
		const site = fakeSite({ body: MIXED_BODY(), features: ON });
		(site.ctx as { content: { get: unknown } }).content.get = async () => {
			throw new Error("database is down");
		};
		const out = await call(site, {}, input);
		assert.equal(out.results[0].status, "error");
		assert.equal(typeof site.memos.get("posts:E1")?.retryAt === "number", retried);
	}

	// Its publish never happened (the marker and the draft are there): the next possessives-only run publishes that draft, and leaves nothing remembered.
	const body = MIXED_BODY();
	const draftBody = links.linkPossessives(body).content as unknown[];
	glossary.resetGlossaryForTests();
	const site = fakeSite({ body, features: ON, draft: "R7", version: 4, draftBody, memo: { pending: 3, pendingQids: [], pendingSlugs: [], pendingPossessive: 1, pendingNew: true } });
	const out = await call(site, {}, { keys: ["posts:E1"], only: "possessive" });
	assert.equal(out.results[0].status, "linked");
	assert.deepEqual(writes(site), ["publish rev-4"]);
	assert.equal(site.memos.has("posts:E1"), false);
});

test("linkEntry with only: \"possessive\" never calls the rules for links, whatever glossary.io's index has", async () => {
	// Every entity has a definition and an unlinked mention: a normal run would add both links.
	glossary.resetGlossaryForTests();
	const body = [block(["StumbleUpon and Google are named here. Read ", { t: "SEO", href: gl("seo") }, "'s basics."])];
	const site = fakeSite({ body, memo: { linked: [], textHash: "seen" } });
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1", { only: "possessive", textHash: "other", exclude: ["Q95"] });
	assert.equal(out.status, "linked");
	assert.deepEqual((out.changes as Array<{ action: string }>).map((c) => c.action), ["possessive"]);
	assert.deepEqual(linksOf(site.item().data.content), [["SEO's", gl("seo")]]);
	const memo = site.memos.get("posts:E1")!;
	assert.deepEqual(memo.linked, []);
	assert.equal(memo.textHash, "seen");
	assert.equal(memo.retryAt, undefined);
});

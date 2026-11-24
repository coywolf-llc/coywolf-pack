/**
 * Unit tests for Pack 0.51.0's possessives in glossary.io links: a new link
 * includes the possessive after the name (planGlossaryLinks), an existing
 * glossary.io link gets the possessive after it moved inside it
 * (linkPossessives), and every linkEntry run does both, the ai/glossary-links
 * route too (dry run included).
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
	let stamp = 0;
	const tick = () => `2026-11-24T12:00:0${++stamp}.000Z`;
	const record = { collection: "posts", entryId: "E1", title: "Joy", hash: "h", status: "ok", error: "", entities: ENTITIES, description: "", descriptionStatus: "none", updated: "2026-11-23T00:00:00.000Z" };
	const entries = new Map<string, unknown>([["posts:E1", record]]);
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
		log: { info: (m: string) => void calls.push(`log.info ${m}`), warn: (m: string) => void calls.push(`log.warn ${m}`), error: (m: string) => void calls.push(`log.error ${m}`) },
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
	return { ctx: ctx as never, calls, memos, item: () => item };
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
	const fixed = links.linkPossessives(POSSESSIVE_BODY()).content as unknown[];
	glossary.resetGlossaryForTests();
	const own = fakeSite({ draft: "R7", version: 4, memo: marker, draftBody: fixed });
	const out = await linker.linkEntry(own.ctx, {}, "posts", "E1");
	assert.equal(out.status, "linked");
	assert.equal(out.reason, "published the draft an earlier run saved");
	assert.deepEqual(writes(own), ["publish rev-4"]);
	assert.deepEqual(own.memos.get("posts:E1")!.linked, ["Q95"], "nothing new is counted as linked");
	assert.equal(own.memos.get("posts:E1")!.pendingPossessive, undefined);

	for (const [more, why] of [
		[{ draftBody: POSSESSIVE_BODY() }, "the possessives are still outside"],
		[{ draftBody: fixed, draftTitle: "Joy, retitled" }, "another field changed"],
		[{ draftBody: [block(["Read Google's guide."])] }, "other text"],
	] as Array<[SiteOptions, string]>) {
		glossary.resetGlossaryForTests();
		const site = fakeSite({ draft: "R7", version: 4, memo: marker, ...more });
		assert.equal((await linker.linkEntry(site.ctx, {}, "posts", "E1")).status, "draft", why);
		assert.deepEqual(writes(site), [], why);
		assert.equal(site.memos.get("posts:E1")!.pending, undefined, `${why}: the stale marker is dropped`);
	}
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

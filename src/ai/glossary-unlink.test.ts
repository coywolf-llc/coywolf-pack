/**
 * Unit tests for Pack 0.50.0's glossary.io links additions: removing links to
 * deleted terms (removeGlossaryLinks, unlinkEntry), keepDates in the linker,
 * and proof that with both off linkEntry does exactly what 0.49.0 did (its
 * source is kept in test/fixtures/glossary-linker-0.49.0.ts).
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/glossary-unlink.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as GL from "./glossary-links.ts";
// @ts-ignore -- as above.
import * as LK from "./glossary-linker.ts";
// @ts-ignore -- as above.
import * as G from "./glossary.ts";
// @ts-ignore -- as above.
import * as F from "../core/features.ts";
// @ts-ignore -- as above (outside src, so tsc never sees it).
import * as OLD from "../../test/fixtures/glossary-linker-0.49.0.ts";

const links = GL as typeof import("./glossary-links.js");
const linker = LK as typeof import("./glossary-linker.js");
const glossary = G as typeof import("./glossary.js");
const features = F as typeof import("../core/features.js");
const old049 = OLD as Pick<typeof import("./glossary-linker.js"), "linkEntry" | "retryDue">;

features.registerFeatures([
	{ id: "ai", label: "AI Enrichment", description: "", default: false },
	{ id: "ai.glossary", label: "glossary.io definitions", description: "", default: true },
	{ id: "ai.glossaryLinks", label: "glossary.io links", description: "", default: false },
]);

// ── Helpers ──────────────────────────────────────────────────────

type Part = string | { t: string; href: string; marks?: string[] } | { t: string; marks: string[] };
let keyN = 0;
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

/** The links in a body (top-level blocks): [text, href] per link run. */
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

const ent = (qid: string, name: string, more: Record<string, unknown> = {}) => ({ qid, name, type: "Thing", description: "", wikipedia: "", website: "", primary: false, ...more });

// ── removeGlossaryLinks ──────────────────────────────────────────

test("removeGlossaryLinks: one link goes, its text stays, and the spans around it become one", () => {
	const body = [block(["I miss ", { t: "StumbleUpon", href: "https://glossary.io/stumbleupon/" }, ". Google agrees."])];
	const out = links.removeGlossaryLinks(body, ["stumbleupon"]);
	assert.equal(out.removed, 1);
	assert.deepEqual(out.bySlug, { stumbleupon: 1 });
	assert.equal(links.bodyText(out.content), links.bodyText(body));
	const b = (out.content as typeof body)[0];
	assert.deepEqual(b.markDefs, []);
	assert.deepEqual(
		b.children.map((c) => [c.text, c.marks]),
		[["I miss StumbleUpon. Google agrees.", []]],
	);
	assert.equal(b.children[0]._key, body[0].children[0]._key, "the first span's key is kept");
	assert.equal(linksOf(body).length, 1, "the input isn't changed");
});

test("removeGlossaryLinks: two links to the same term, other marks kept, hand-made forms, nested blocks", () => {
	const body = [
		block(["Read about ", { t: "SEO", href: "https://glossary.io/seo/", marks: ["strong"] }, " and more ", { t: "search engine optimization", href: "http://www.glossary.io/seo?ref=coywolf" }, "."]),
		block(["See ", { t: "SEO", href: "https://glossary.io/seo#definition" }, " here."], { listItem: "bullet", level: 1 }),
		{ _type: "columns", columns: [{ _key: "c1", content: [block(["Also ", { t: "SEO", href: "https://glossary.io/seo/" }, "."])] }] },
	];
	const out = links.removeGlossaryLinks(body, ["seo"]);
	assert.equal(out.removed, 4);
	assert.deepEqual(out.bySlug, { seo: 4 });
	assert.equal(links.glossarySlugsIn(out.content).size, 0);
	const [first, item] = out.content as Array<ReturnType<typeof block>>;
	assert.deepEqual(
		first.children.map((c) => [c.text, c.marks]),
		[
			["Read about ", []],
			["SEO", ["strong"]],
			[" and more search engine optimization.", []],
		],
		"bold stays bold; spans merge only where the marks now match",
	);
	assert.equal((item as { listItem?: string }).listItem, "bullet");
	assert.deepEqual(
		item.children.map((c) => c.text),
		["See SEO here."],
	);
	assert.equal(links.bodyText(out.content), links.bodyText(body));
});

test("removeGlossaryLinks: other terms, longer slugs and other sites stay; nothing to remove returns the input; idempotent", () => {
	const body = [
		block([
			{ t: "SEO audit", href: "https://glossary.io/seo-audit/" },
			" and ",
			{ t: "SEO", href: "https://example.com/seo/" },
			" and ",
			{ t: "Google", href: "https://glossary.io/google/" },
			" and ",
			{ t: "SEO", href: "https://glossary.io/seo/" },
		]),
	];
	const out = links.removeGlossaryLinks(body, ["seo"]);
	assert.equal(out.removed, 1);
	assert.deepEqual(linksOf(out.content), [
		["SEO audit", "https://glossary.io/seo-audit/"],
		["SEO", "https://example.com/seo/"],
		["Google", "https://glossary.io/google/"],
	]);
	const again = links.removeGlossaryLinks(out.content, ["seo"]);
	assert.equal(again.removed, 0);
	assert.equal(again.content, out.content, "nothing to remove: the same value back");
	assert.equal(links.removeGlossaryLinks(body, []).content, body);
	assert.equal(links.removeGlossaryLinks(null, ["seo"]).removed, 0);
});

// ── The entry edit ───────────────────────────────────────────────

const T_OLD = "2026-10-04T23:01:54.489Z";
const STUMBLE = "https://glossary.io/stumbleupon/";

interface SiteOptions {
	body?: unknown[];
	draft?: string | null;
	version?: number;
	bumpBeforeWrite?: boolean;
	bumpDuringUpdate?: boolean;
	publishConflict?: boolean;
	publishThrows?: boolean;
	updateThrows?: boolean;
	draftBody?: unknown[];
	slug?: string;
	updatedAt?: string;
	memo?: Record<string, unknown>;
	siteUrl?: string;
	revisions?: boolean;
	/** The index's terms (default: StumbleUpon and Google). */
	terms?: Record<string, [string, string, string[]]>;
	/** aiGlossary/gone. */
	gone?: Record<string, unknown> | null;
	entities?: ReturnType<typeof ent>[];
}

const TERMS: Record<string, [string, string, string[]]> = {
	Q911595: ["stumbleupon", "A defunct discovery service.", ["StumbleUpon"]],
	Q95: ["google", "A technology company.", ["Google"]],
};

/** A site with one published post (posts:E1), recording every content call, storage write and fetch. */
function fakeSite(opts: SiteOptions = {}) {
	const body = opts.body ?? [block(["I miss ", { t: "StumbleUpon", href: "https://en.wikipedia.org/wiki/StumbleUpon" }, ". Google agrees."])];
	const revisions = opts.revisions ?? true;
	type Item = { id: string; slug: string; status: string; data: Record<string, unknown>; version: number; updatedAt: string; draftRevisionId: string | null; liveRevisionId: string | null };
	let item: Item = {
		id: "E1",
		slug: opts.slug ?? "joy",
		status: "published",
		data: { title: "Joy", content: body },
		version: opts.version ?? 3,
		updatedAt: opts.updatedAt ?? T_OLD,
		draftRevisionId: opts.draft ?? null,
		liveRevisionId: revisions ? "R1" : null,
	};
	const calls: string[] = [];
	const fetches: string[] = [];
	let reads = 0;
	let stamp = 0;
	const tick = () => `2026-11-24T12:00:0${++stamp}.000Z`;
	const record = { collection: "posts", entryId: "E1", title: "Joy", hash: "h", status: "ok", error: "", entities: opts.entities ?? [ent("Q911595", "StumbleUpon", { wikipedia: "https://en.wikipedia.org/wiki/StumbleUpon" }), ent("Q95", "Google")], description: "", descriptionStatus: "none", updated: "2026-11-23T00:00:00.000Z" };
	const entries = new Map<string, unknown>([["posts:E1", record]]);
	const memos = new Map<string, Record<string, unknown>>();
	if (opts.memo) memos.set("posts:E1", { collection: "posts", entryId: "E1", linked: [], updated: "", ...opts.memo });
	let terms = opts.terms ?? TERMS;
	const ctx = {
		site: { url: opts.siteUrl ?? "https://coywolf.com" },
		settings: { get: async () => null },
		log: { info() {}, warn() {}, error: (message: string) => void calls.push(`log.error ${message}`) },
		schema: {
			getCollection: async () => ({ slug: "posts", supports: revisions ? ["revisions", "drafts"] : ["drafts"], fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "content", type: "portableText", sortOrder: 1 }] }),
		},
		storage: {
			aiEntries: { get: async (k: string) => entries.get(k) ?? null, put: async (k: string, v: unknown) => void entries.set(k, v) },
			aiLinks: {
				get: async (k: string) => structuredClone(memos.get(k) ?? null),
				put: async (k: string, v: Record<string, unknown>) => {
					calls.push(`memo ${JSON.stringify({ ...v, updated: "" })}`);
					memos.set(k, structuredClone(v));
				},
				query: async () => ({ items: [...memos].filter(([, v]) => typeof v.retryAt === "number" && (v.retryAt as number) <= Date.now()).map(([id, data]) => ({ id, data: structuredClone(data) })), hasMore: false }),
			},
			aiGlossary: {
				get: async (id: string) => (id === "index" ? { fetchedAt: Date.now(), format: 2, terms } : id === "gone" ? structuredClone(opts.gone ?? null) : null),
				put: async () => {},
			},
		},
		http: {
			fetch: async (url: string) => {
				fetches.push(url);
				return new Response("{}", { status: 500 });
			},
		},
		content: {
			get: async () => {
				reads++;
				calls.push("get");
				if (opts.bumpBeforeWrite && reads === 2) item = { ...item, version: item.version + 1 };
				return structuredClone(item);
			},
			getRevision: async (_c: string, _id: string, rev: string) => {
				calls.push(`getRevision ${rev}`);
				return { data: { title: "Joy", content: opts.draftBody ?? body } };
			},
			update: async (_c: string, _id: string, patch: Record<string, unknown>) => {
				calls.push(`update ${JSON.stringify(patch)}`);
				if (opts.updateThrows) throw new Error("D1 is busy");
				// Someone's autosave lands right before this write: two versions, the last one theirs.
				item = { ...item, data: { ...item.data, ...patch }, version: item.version + (opts.bumpDuringUpdate ? 2 : 1), updatedAt: tick(), draftRevisionId: revisions ? "R2" : null };
			},
			getVersioned: async () => {
				calls.push("getVersioned");
				return { item: structuredClone(item), _rev: `rev-${item.version}` };
			},
			publish: async (_c: string, _id: string, o: { _rev: string }) => {
				calls.push(`publish ${o._rev}`);
				if (opts.publishConflict) throw Object.assign(new Error("Content has been modified"), { code: "CONFLICT" });
				if (opts.publishThrows) throw new Error("timeout");
				item = { ...item, draftRevisionId: null, liveRevisionId: item.draftRevisionId, version: item.version + 1, updatedAt: tick() };
			},
		},
	};
	return {
		ctx: ctx as never,
		calls,
		fetches,
		memos,
		item: () => item,
		setTerms: (next: Record<string, [string, string, string[]]>) => void (terms = next),
		/** Make the entry look saved long ago again (the fake's writes stamp "now"). */
		age: () => void (item = { ...item, updatedAt: T_OLD }),
	};
}

/** A recording stand-in for keepDates' database and purge. */
function keepDatesSpy(changes = 1, opts: { throws?: boolean } = {}) {
	const statements: Array<{ sql: string; args: unknown[] }> = [];
	const purges: unknown[] = [];
	let databaseCalls = 0;
	const db = {
		prepare(sql: string) {
			if (opts.throws) throw new Error("D1 is down");
			return { bind: (...args: unknown[]) => ({ run: async () => (statements.push({ sql, args }), { meta: { changes } }) }) };
		},
	};
	const io = linker.keepDatesIo;
	const saved = { database: io.database, purge: io.purge };
	io.database = async () => {
		databaseCalls++;
		return db as unknown as D1Database;
	};
	io.purge = (async (_ctx: unknown, entries: unknown, options: unknown) => void purges.push({ entries, options })) as typeof io.purge;
	return {
		statements,
		purges,
		databaseCalls: () => databaseCalls,
		restore: () => Object.assign(io, saved),
	};
}

const KEEP = { glossaryLinks: { keepDates: true } };

// ── With both settings off: exactly 0.49.0 ──────────────────────

/** The same scenarios the 0.49.0 tests run, each on a fresh site for the old and the new linkEntry. */
const SCENARIOS: Array<{ name: string; site: SiteOptions; options?: Record<string, unknown>; link?: Record<string, unknown>; retry?: boolean }> = [
	{ name: "links and publishes", site: {}, link: { textHash: "th" } },
	{ name: "draft", site: { draft: "R9" } },
	{ name: "busy", site: { updatedAt: new Date(Date.now() - 30_000).toISOString() } },
	{ name: "conflict", site: { bumpBeforeWrite: true } },
	{ name: "skip list", site: { slug: "privacy-policy" }, options: { glossaryLinks: { skip: ["privacy-policy"] } } },
	{ name: "no host", site: { siteUrl: "" } },
	{ name: "removed by hand", site: { memo: { linked: ["Q911595", "Q95"] } } },
	{ name: "dry run", site: {}, link: { dryRun: true, exclude: ["Q95"] } },
	{ name: "staged", site: { publishConflict: true } },
	{ name: "collided", site: { bumpDuringUpdate: true } },
	{
		name: "own draft finished",
		site: { draft: "R7", version: 4, memo: { pending: 3, pendingQids: ["Q911595"], pendingSlugs: ["stumbleupon"], linked: [] }, draftBody: [block(["I miss ", { t: "StumbleUpon", href: STUMBLE }, ". Google agrees."])] },
	},
	{ name: "editor's draft", site: { draft: "R7", version: 4, memo: { pending: 3, pendingQids: ["Q911595"], pendingSlugs: ["stumbleupon"], linked: [] } } },
	{ name: "draft by id", site: { draft: "R7", version: 9, memo: { pending: 3, draft: "R7", pendingQids: ["Q911595"], pendingSlugs: ["stumbleupon"], linked: [] } } },
	{ name: "stale marker", site: { memo: { pending: 1, draft: "R0", pendingQids: ["Q95"], pendingSlugs: ["google"], linked: [] } } },
	{ name: "exclusions while waiting", site: { draft: "R9" }, link: { exclude: ["Q95"] } },
	{ name: "no revisions", site: { revisions: false } },
	{ name: "glossary.io itself", site: { siteUrl: "https://glossary.io" } },
	{ name: "retry pass", site: { memo: { linked: [], retryAt: Date.now() - 1000, tries: 1 } }, retry: true },
	{ name: "keepDates false", site: {}, options: { glossaryLinks: { keepDates: false } } },
];

test("with keepDates and gone-term removal off, linkEntry and retryDue do byte-for-byte what 0.49.0 did: no D1 call, no extra read or fetch", async () => {
	const spy = keepDatesSpy();
	// New span and markDef keys are random, and retry times read the clock: the same for both runs.
	const clock = Date.now;
	const fixed = clock();
	Date.now = () => fixed;
	const random = crypto.getRandomValues.bind(crypto);
	let seed = 0;
	crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T) => {
		if (array instanceof Uint8Array) for (let i = 0; i < array.length; i++) array[i] = (++seed * 37) % 256;
		return array;
	}) as typeof crypto.getRandomValues;
	try {
		for (const s of SCENARIOS) {
			const run = async (impl: typeof old049) => {
				glossary.resetGlossaryForTests();
				keyN = 1000;
				seed = 0;
				const site = fakeSite(s.site);
				const result = s.retry ? await impl.retryDue(site.ctx, s.options ?? {}, 3) : await impl.linkEntry(site.ctx, s.options ?? {}, "posts", "E1", s.link ?? {});
				const memos = Object.fromEntries([...site.memos].map(([k, v]) => [k, { ...v, updated: "" }]));
				return { result, calls: site.calls, fetches: site.fetches, memos, item: site.item() };
			};
			const before = await run(old049);
			const now = await run(linker);
			assert.deepEqual(now, before, s.name);
		}
		assert.equal(spy.databaseCalls(), 0, "no D1 call");
		assert.deepEqual(spy.purges, [], "no purge");
	} finally {
		Date.now = clock;
		crypto.getRandomValues = random;
		spy.restore();
	}
});

// ── keepDates ────────────────────────────────────────────────────

test("keepDates: after its own publish, the date is put back on exactly the row the publish left, and the page is cleared", async () => {
	glossary.resetGlossaryForTests();
	const spy = keepDatesSpy();
	try {
		const site = fakeSite();
		const out = await linker.linkEntry(site.ctx, KEEP, "posts", "E1");
		assert.equal(out.status, "linked");
		assert.equal(out.dateKept, true);
		assert.equal(spy.statements.length, 1);
		const { sql, args } = spy.statements[0];
		assert.match(sql, /^UPDATE "ec_posts" SET updated_at = \?1 WHERE id = \?2 AND deleted_at IS NULL AND status = 'published' AND updated_at = \?3 AND version = \?4 AND live_revision_id = \?5 AND draft_revision_id IS NULL$/);
		// The date read right before the write; the row as the publish left it (two versions on: the draft, then the publish).
		assert.deepEqual(args, [T_OLD, "E1", site.item().updatedAt, 5, "R2"]);
		assert.deepEqual(spy.purges, [{ entries: [{ collection: "posts", id: "E1", slug: "joy" }], options: { label: "glossary.io links", tags: true } }]);
		const memo = site.memos.get("posts:E1")!;
		assert.equal(memo.keepUpdatedAt, undefined, "cleared with the marker");
		assert.ok(site.calls.some((c) => c.startsWith("memo ") && c.includes(`"keepUpdatedAt":"${T_OLD}"`)), "saved with the marker, before the write");
	} finally {
		spy.restore();
	}
});

test("keepDates: staged and collided edits keep the new date; a refused restore or a failing D1 still reports linked", async () => {
	for (const [site, status] of [
		[{ publishConflict: true }, "staged"],
		[{ bumpDuringUpdate: true }, "collided"],
	] as const) {
		glossary.resetGlossaryForTests();
		const spy = keepDatesSpy();
		try {
			const out = await linker.linkEntry(fakeSite(site).ctx, KEEP, "posts", "E1");
			assert.equal(out.status, status);
			assert.equal(out.dateKept, undefined);
			assert.equal(spy.databaseCalls(), 0, status);
		} finally {
			spy.restore();
		}
	}
	for (const [spyOpts, changes] of [
		[{}, 0],
		[{ throws: true }, 1],
	] as const) {
		glossary.resetGlossaryForTests();
		const spy = keepDatesSpy(changes, spyOpts);
		try {
			const site = fakeSite();
			const out = await linker.linkEntry(site.ctx, KEEP, "posts", "E1");
			assert.equal(out.status, "linked");
			assert.equal(out.dateKept, false);
			assert.deepEqual(spy.purges, [], "nothing restored, nothing to clear");
			assert.deepEqual(site.memos.get("posts:E1")!.linked, ["Q911595", "Q95"]);
			assert.equal(site.memos.get("posts:E1")!.retryAt, undefined, "not retried");
		} finally {
			spy.restore();
		}
	}
});

test("keepDates: finishing an earlier run's draft restores the date saved with its marker; a collection without revisions too", async () => {
	glossary.resetGlossaryForTests();
	let spy = keepDatesSpy();
	try {
		const linkedBody = [block(["I miss ", { t: "StumbleUpon", href: STUMBLE }, ". Google agrees."])];
		const site = fakeSite({ draft: "R7", version: 4, updatedAt: "2026-11-01T00:00:00.000Z", memo: { pending: 3, draft: "R7", pendingQids: ["Q911595"], pendingSlugs: ["stumbleupon"], keepUpdatedAt: "2026-10-31T09:00:00.000Z", linked: [] }, draftBody: linkedBody });
		const out = await linker.linkEntry(site.ctx, KEEP, "posts", "E1");
		assert.equal(out.status, "linked");
		assert.equal(out.reason, "published the draft an earlier run saved");
		assert.equal(out.dateKept, true);
		assert.deepEqual(spy.statements[0].args, ["2026-10-31T09:00:00.000Z", "E1", site.item().updatedAt, 5, "R7"]);
	} finally {
		spy.restore();
	}
	glossary.resetGlossaryForTests();
	spy = keepDatesSpy();
	try {
		const site = fakeSite({ revisions: false });
		const out = await linker.linkEntry(site.ctx, KEEP, "posts", "E1");
		assert.equal(out.status, "linked");
		assert.equal(out.dateKept, true);
		assert.doesNotMatch(spy.statements[0].sql, /live_revision_id/);
		assert.deepEqual(spy.statements[0].args, [T_OLD, "E1", site.item().updatedAt, 4]);
	} finally {
		spy.restore();
	}
});

test("keepDates without the DB binding: logged once, the edit is still published", async () => {
	glossary.resetGlossaryForTests();
	const io = linker.keepDatesIo;
	const saved = io.database;
	io.database = async () => null;
	try {
		const first = fakeSite();
		assert.equal((await linker.linkEntry(first.ctx, KEEP, "posts", "E1")).dateKept, false);
		glossary.resetGlossaryForTests();
		const second = fakeSite();
		assert.equal((await linker.linkEntry(second.ctx, KEEP, "posts", "E1")).status, "linked");
		assert.equal([...first.calls, ...second.calls].filter((c) => c.includes("keepDates needs")).length, 1);
	} finally {
		io.database = saved;
	}
});

// ── Removing links to deleted terms ──────────────────────────────

const LINKED_BODY = () => [block(["I miss ", { t: "StumbleUpon", href: STUMBLE }, ". Google agrees."]), block(["More on ", { t: "Google", href: "https://glossary.io/google/" }, "."])];
const GONE = { last: null, suspects: {}, gone: { stumbleupon: { qid: "Q911595", since: 0 } }, updated: "" };
const WITHOUT_STUMBLE: Record<string, [string, string, string[]]> = { Q95: TERMS.Q95 };
const UNLINK_MEMO = { linked: ["Q911595", "Q95"], unlink: [{ slug: "stumbleupon", qid: "Q911595" }], retryAt: Date.now() - 1000, tries: 0 };

function goneSite(more: SiteOptions = {}) {
	return fakeSite({ body: LINKED_BODY(), terms: WITHOUT_STUMBLE, gone: GONE, memo: UNLINK_MEMO, ...more });
}

test("unlinkEntry takes the link out, keeps the text, publishes only its own draft, and forgets the QID", async () => {
	glossary.resetGlossaryForTests();
	const site = goneSite();
	const out = await linker.unlinkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(out.status, "unlinked");
	assert.deepEqual(out.changes, [{ slug: "stumbleupon", qid: "Q911595", removed: 1 }]);
	assert.deepEqual(
		site.calls.filter((c) => c.startsWith("publish")),
		["publish rev-4"],
	);
	const content = site.item().data.content;
	assert.deepEqual(linksOf(content), [["Google", "https://glossary.io/google/"]]);
	assert.equal(links.bodyText(content), links.bodyText(LINKED_BODY()));
	const memo = site.memos.get("posts:E1")!;
	assert.deepEqual(memo.linked, ["Q95"]);
	assert.equal(memo.unlink, undefined);
	assert.equal(memo.retryAt, undefined);
	assert.equal(memo.pendingUnlink, undefined);
	assert.equal(out.dateKept, undefined, "keepDates off");

	// The term comes back: a later linkEntry links it again.
	glossary.resetGlossaryForTests();
	site.setTerms(TERMS);
	site.age();
	const again = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(again.status, "linked");
	assert.deepEqual(linksOf(site.item().data.content), [
		["StumbleUpon", STUMBLE],
		["Google", "https://glossary.io/google/"],
	]);
});

test("unlinkEntry waits like linking: someone's draft, a recent save, a save before the write, a publish conflict, a collision", async () => {
	for (const [more, status] of [
		[{ draft: "R9" }, "draft"],
		[{ updatedAt: new Date(Date.now() - 30_000).toISOString() }, "busy"],
		[{ bumpBeforeWrite: true }, "conflict"],
		[{ publishConflict: true }, "staged"],
		[{ bumpDuringUpdate: true }, "collided"],
	] as const) {
		glossary.resetGlossaryForTests();
		const site = goneSite(more);
		const out = await linker.unlinkEntry(site.ctx, {}, "posts", "E1");
		assert.equal(out.status, status);
		const memo = site.memos.get("posts:E1")!;
		assert.deepEqual(memo.linked, ["Q911595", "Q95"], `${status}: the QID is remembered until the removal is live`);
		assert.deepEqual(memo.unlink, UNLINK_MEMO.unlink, `${status}: still to do`);
		if (status === "collided") {
			assert.deepEqual(site.calls.filter((c) => c.startsWith("publish")), [], "nothing published over someone's save");
			assert.ok(site.calls.some((c) => c.includes("log.error") && c.includes("deleted term")));
		} else if (status !== "staged") assert.ok(!site.calls.some((c) => c.startsWith("update")), status);
		if (status !== "collided") assert.equal(typeof memo.retryAt, "number", `${status} is tried again`);
	}
});

test("unlinkEntry: an unpublished removal of its own is finished (by draft id, or by version, text and links), an editor's draft never", async () => {
	const removedBody = [block(["I miss StumbleUpon. Google agrees."]), block(["More on ", { t: "Google", href: "https://glossary.io/google/" }, "."])];
	const marker = { ...UNLINK_MEMO, pending: 3, pendingUnlink: ["stumbleupon"] };
	for (const [memo, why] of [
		[{ ...marker, draft: "R7" }, "by draft id"],
		[marker, "by version, text and links"],
	] as const) {
		glossary.resetGlossaryForTests();
		const site = goneSite({ draft: "R7", version: 4, memo, draftBody: removedBody });
		const out = await linker.unlinkEntry(site.ctx, {}, "posts", "E1");
		assert.equal(out.status, "unlinked", why);
		assert.equal(out.reason, "published the draft an earlier run saved");
		assert.deepEqual(site.calls.filter((c) => c.startsWith("publish")), ["publish rev-4"], why);
		const after = site.memos.get("posts:E1")!;
		assert.deepEqual(after.linked, ["Q95"], why);
		assert.equal(after.unlink, undefined, why);
	}
	// linkEntry finishes it too (it's this part's own edit either way).
	glossary.resetGlossaryForTests();
	const viaLink = goneSite({ draft: "R7", version: 4, memo: { ...marker, draft: "R7" }, draftBody: removedBody });
	assert.equal((await linker.linkEntry(viaLink.ctx, {}, "posts", "E1")).status, "unlinked");
	assert.deepEqual(viaLink.memos.get("posts:E1")!.linked, ["Q95"]);

	// An editor's draft at that version: other text, still the link, or another field changed.
	for (const [draftBody, why] of [
		[[block(["I miss StumbleUpon a lot. Google agrees."]), removedBody[1]], "other text"],
		[LINKED_BODY(), "still linked"],
	] as const) {
		glossary.resetGlossaryForTests();
		const site = goneSite({ draft: "R7", version: 4, memo: marker, draftBody: draftBody as unknown[] });
		assert.equal((await linker.unlinkEntry(site.ctx, {}, "posts", "E1")).status, "draft", why);
		assert.deepEqual(site.calls.filter((c) => c.startsWith("publish")), [], why);
	}
	glossary.resetGlossaryForTests();
	const retitled = goneSite({ draft: "R7", version: 4, memo: marker, draftBody: removedBody });
	(retitled.ctx as { content: { getRevision: unknown } }).content.getRevision = async () => ({ data: { title: "Joy, retitled", content: removedBody } });
	assert.equal((await linker.unlinkEntry(retitled.ctx, {}, "posts", "E1")).status, "draft", "another field changed");

	// Its draft went live but the result was never recorded: recorded now.
	glossary.resetGlossaryForTests();
	const recorded = goneSite({ body: removedBody, memo: { ...marker, draft: "R1" } });
	const out = await linker.unlinkEntry(recorded.ctx, {}, "posts", "E1");
	assert.equal(out.status, "unchanged");
	assert.deepEqual(recorded.memos.get("posts:E1")!.linked, ["Q95"]);
});

test("unlinkEntry checks again right before the write: a term back in the index, or no longer confirmed gone, is left alone", async () => {
	for (const [more, why] of [
		[{ terms: TERMS }, "back in the index"],
		[{ gone: { ...GONE, gone: {} } }, "dismissed"],
		[{ gone: { ...GONE, gone: { stumbleupon: { qid: "Q1", since: 0 } } } }, "another QID"],
	] as const) {
		glossary.resetGlossaryForTests();
		const site = goneSite(more);
		const out = await linker.unlinkEntry(site.ctx, {}, "posts", "E1");
		assert.equal(out.status, "unchanged", why);
		assert.ok(!site.calls.some((c) => c.startsWith("update")), why);
		const memo = site.memos.get("posts:E1")!;
		assert.equal(memo.unlink, undefined, why);
		assert.deepEqual(memo.linked, ["Q911595", "Q95"], why);
	}
});

test("unlinkEntry: a link already removed by hand settles without a write and keeps the QID; skipped entries drop the work", async () => {
	glossary.resetGlossaryForTests();
	const byHand = goneSite({ body: [block(["I miss StumbleUpon. Google agrees."])] });
	const out = await linker.unlinkEntry(byHand.ctx, {}, "posts", "E1");
	assert.equal(out.status, "unchanged");
	assert.equal(out.reason, "no such links");
	assert.ok(!byHand.calls.some((c) => c.startsWith("update")));
	assert.deepEqual(byHand.memos.get("posts:E1")!.linked, ["Q911595", "Q95"], "a link removed by hand stays removed");
	assert.equal(byHand.memos.get("posts:E1")!.unlink, undefined);

	glossary.resetGlossaryForTests();
	const skipped = goneSite({ slug: "links" });
	assert.equal((await linker.unlinkEntry(skipped.ctx, { glossaryLinks: { skip: ["links"] } }, "posts", "E1")).status, "skipped");
	assert.ok(!skipped.calls.some((c) => c.startsWith("update")));
	assert.equal(skipped.memos.get("posts:E1")!.unlink, undefined);
});

test("unlinkEntry with keepDates puts the date back too; retryDue runs removals only when asked to", async () => {
	glossary.resetGlossaryForTests();
	const spy = keepDatesSpy();
	try {
		const site = goneSite();
		const out = await linker.unlinkEntry(site.ctx, KEEP, "posts", "E1");
		assert.equal(out.status, "unlinked");
		assert.equal(out.dateKept, true);
		assert.deepEqual(spy.statements[0].args, [T_OLD, "E1", site.item().updatedAt, 5, "R2"]);
	} finally {
		spy.restore();
	}

	glossary.resetGlossaryForTests();
	const off = goneSite();
	assert.equal(await linker.retryDue(off.ctx, {}, 3), 1);
	assert.deepEqual(linksOf(off.item().data.content).map(([, href]) => href), [STUMBLE, "https://glossary.io/google/"], "without unlink: only linking");
	assert.deepEqual(off.memos.get("posts:E1")!.unlink, UNLINK_MEMO.unlink, "the work waits");

	glossary.resetGlossaryForTests();
	const on = goneSite();
	assert.equal(await linker.retryDue(on.ctx, {}, 3, { unlink: true }), 1);
	assert.deepEqual(linksOf(on.item().data.content), [["Google", "https://glossary.io/google/"]]);
});

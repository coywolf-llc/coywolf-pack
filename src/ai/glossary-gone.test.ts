/**
 * Unit tests for Remove links to deleted glossary.io terms
 * (src/ai/glossary-gone.ts): fake storage, a fake glossary.io, a fake clock,
 * and the posts table in an in-memory SQLite.
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/glossary-gone.test.ts
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as GG from "./glossary-gone.ts";
// @ts-ignore -- as above.
import * as F from "../core/features.ts";

const gone = GG as typeof import("./glossary-gone.js");
const features = F as typeof import("../core/features.js");

const H = 60 * 60_000;
const T0 = Date.UTC(2026, 10, 1);

type Terms = Record<string, [string, string, string[]] | [string, string]>;

/** n ordinary terms (Q1000…), plus the named ones. */
function terms(n: number, more: Terms = {}): Terms {
	const out: Terms = {};
	for (let i = 0; i < n; i++) out[`Q${1000 + i}`] = [`term-${i}`, `Definition ${i}.`];
	return { ...out, ...more };
}
const SEO: Terms = { Q180711: ["seo", "Search engine optimization.", ["SEO"]] };
const without = (all: Terms, ...qids: string[]) => Object.fromEntries(Object.entries(all).filter(([q]) => !qids.includes(q))) as Terms;

const block = (text: string, href?: string) => ({
	_type: "block",
	_key: "b1",
	style: "normal",
	children: href ? [{ _type: "span", _key: "s1", text: "See ", marks: [] }, { _type: "span", _key: "s2", text, marks: ["l1"] }] : [{ _type: "span", _key: "s1", text, marks: [] }],
	markDefs: href ? [{ _type: "link", _key: "l1", href }] : [],
});

/** A site whose stored index copy, glossary.io answers and posts the test sets. */
function site(start: Terms) {
	let index = { fetchedAt: T0, format: 2, terms: start };
	const docs = new Map<string, unknown>();
	const memos = new Map<string, Record<string, unknown>>();
	const fetched: string[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	/** The slug each D1 query looked for, and a slug whose query fails. */
	const queries: string[] = [];
	let failing: string | null = null;
	let answer: (slug: string) => number | "timeout" = () => 404;
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, status TEXT, deleted_at TEXT, title TEXT, content TEXT)`);
	const db = {
		prepare: (sql: string) => ({
			bind: (...args: unknown[]) => ({
				all: async () => {
					const slug = String(args[0]).slice("glossary.io/".length, -1);
					queries.push(slug);
					if (slug === failing) throw new Error("D1 is busy");
					return { results: sqlite.prepare(sql).all(...(args as string[])) };
				},
			}),
		}),
	} as unknown as D1Database;
	const ctx = {
		site: { url: "https://coywolf.com" },
		log: { info() {}, warn: (message: string) => void warnings.push(message), error: (message: string) => void errors.push(message) },
		storage: {
			aiGlossary: {
				get: async (id: string) => structuredClone(id === "index" ? index : (docs.get(id) ?? null)),
				put: async (id: string, value: unknown) => void docs.set(id, structuredClone(value)),
			},
			aiLinks: {
				get: async (k: string) => structuredClone(memos.get(k) ?? null),
				put: async (k: string, v: Record<string, unknown>) => void memos.set(k, structuredClone(v)),
			},
		},
		schema: {
			getCollection: async (slug: string) =>
				slug === "posts" ? { slug, supports: ["revisions"], fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "content", type: "portableText", sortOrder: 1 }] } : null,
		},
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				fetched.push(url);
				assert.equal(init?.redirect, "manual");
				const status = answer(/\/api\/terms\/([^/]+)\.json$/.exec(url)![1]);
				if (status === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
				return new Response(status >= 300 && status < 400 ? null : "{}", { status, headers: status >= 300 && status < 400 ? { Location: "/api/terms/other.json" } : {} });
			},
		},
	};
	return {
		ctx: ctx as never,
		db,
		fetched,
		errors,
		warnings,
		queries,
		failOn: (slug: string | null) => void (failing = slug),
		memos,
		state: () => docs.get("gone") as import("./glossary-gone.js").GoneState,
		setState: (s: unknown) => void docs.set("gone", structuredClone(s)),
		copy: (t: Terms, fetchedAt: number) => void (index = { fetchedAt, format: 2, terms: t }),
		answer: (fn: (slug: string) => number | "timeout") => void (answer = fn),
		/** The post's link is gone (removed by the retry pass, or by hand). */
		unlinked: (id: string) => void sqlite.prepare("UPDATE ec_posts SET content = ? WHERE id = ?").run(JSON.stringify([block("See SEO")]), id),
		post: (id: string, href: string, more: { slug?: string; status?: string } = {}) =>
			void sqlite.prepare("INSERT INTO ec_posts (id, slug, status, deleted_at, title, content) VALUES (?, ?, ?, NULL, ?, ?)").run(id, more.slug ?? id, more.status ?? "published", id, JSON.stringify([block("SEO", href)])),
		run: (now: number, opts: { budget?: { used: number; max: number }; options?: Record<string, unknown>; deadline?: number } = {}) =>
			gone.checkGoneTerms(ctx as never, opts.options ?? {}, opts.budget ?? { used: 0, max: 40 }, { collections: ["posts"], now, db, deadline: opts.deadline }),
	};
}

/** A site that has seen the full index once (the first run). */
async function started(start: Terms) {
	const s = site(start);
	await s.run(T0);
	return s;
}

test("the switch: registered off, needs glossary.io links; removals run only with both on", () => {
	assert.equal(gone.REMOVE_GONE_FEATURE.id, "ai.glossaryLinksRemoveGone");
	assert.equal(gone.REMOVE_GONE_FEATURE.default, false);
	assert.deepEqual(gone.REMOVE_GONE_FEATURE.requires, ["ai.glossaryLinks"]);
	features.registerFeatures([
		{ id: "ai", label: "AI", description: "", default: false },
		{ id: "ai.glossaryLinks", label: "glossary.io links", description: "", default: false },
		gone.REMOVE_GONE_FEATURE,
	]);
	assert.equal(gone.removeGoneOn(features.resolveFeatures({ ai: true, "ai.glossaryLinks": true })), false, "off by default");
	assert.equal(gone.removeGoneOn(features.resolveFeatures({ ai: true, "ai.glossaryLinksRemoveGone": true })), false, "needs glossary.io links");
	assert.equal(gone.removeGoneOn(features.resolveFeatures({ ai: false, "ai.glossaryLinks": true, "ai.glossaryLinksRemoveGone": true })), false, "a part of AI Enrichment");
	assert.equal(gone.removeGoneOn(features.resolveFeatures({ ai: true, "ai.glossaryLinks": true, "ai.glossaryLinksRemoveGone": true })), true);
});

test("the first run only records the index: nothing is checked, and terms missing before it are never removed", async () => {
	const s = site(terms(100));
	const run = await s.run(T0);
	assert.equal(run.paused, true);
	assert.equal(s.state().last!.fetchedAt, T0);
	assert.equal(Object.keys(s.state().last!.slugs).length, 100);
	assert.deepEqual(s.state().suspects, {});
	assert.deepEqual(s.fetched, []);
	// Nothing stored, or no good copy: nothing at all.
	const empty = site(terms(0));
	assert.equal((await empty.run(T0)).paused, true);
	assert.equal(empty.state(), undefined);
});

test("a copy that lost too many terms is refused: held, `last` kept, no suspects, logged once; a later copy with them back lets go", async () => {
	const all = terms(100);
	const s = await started(all);
	s.copy(without(all, "Q1000", "Q1001", "Q1002", "Q1003", "Q1004", "Q1005"), T0 + 24 * H);
	const run = await s.run(T0 + 24 * H);
	assert.equal(run.paused, true);
	assert.equal(s.state().held!.why, "index-shrank");
	assert.deepEqual(s.state().held!.slugs, ["term-0", "term-1", "term-2", "term-3", "term-4", "term-5"]);
	assert.equal(s.state().last!.fetchedAt, T0, "the old copy stays the reference");
	assert.deepEqual(s.state().suspects, {});
	assert.deepEqual(s.fetched, []);
	await s.run(T0 + 25 * H);
	assert.equal(s.errors.filter((e) => e.includes("lost 6 terms")).length, 1, "logged once per copy");
	// A later copy has them back.
	s.copy(all, T0 + 48 * H);
	assert.equal((await s.run(T0 + 48 * H)).paused, false);
	assert.equal(s.state().held, undefined);
	assert.deepEqual(s.state().suspects, {});
	assert.equal(s.state().last!.fetchedAt, T0 + 48 * H);
	// Five missing at once is within the limit for 100 terms; 1% of a larger index counts.
	assert.equal(gone.shrinkLimit(100), 5);
	assert.equal(gone.shrinkLimit(1000), 10);
});

test("a renamed term (same QID, another slug) is never a suspect; its links stay", async () => {
	const all = terms(20, SEO);
	const s = await started(all);
	s.copy({ ...without(all, "Q180711"), Q180711: ["search-engine-optimization", "Search engine optimization."] }, T0 + 24 * H);
	await s.run(T0 + 24 * H);
	assert.deepEqual(s.state().suspects, {});
	assert.deepEqual(s.fetched, []);
});

test("confirming a deleted term: two 404s 20 hours apart AND two index copies 20 hours apart; then its entries are queued", async () => {
	const all = terms(20, SEO);
	const s = await started(all);
	s.post("E1", "https://glossary.io/seo/");
	s.post("E2", "http://www.glossary.io/seo?ref=x");
	s.post("E3", "https://glossary.io/seo-audit/");
	s.post("E4", "https://glossary.io/seo/", { status: "draft" });
	const t1 = T0 + 24 * H;
	s.copy(without(all, "Q180711"), t1);
	await s.run(t1);
	const suspect = s.state().suspects.seo;
	assert.deepEqual({ ...suspect, triedAt: undefined }, { qid: "Q180711", since: t1, firstCopyAt: t1, checks: [t1], triedAt: undefined });
	assert.deepEqual(s.fetched, ["https://glossary.io/api/terms/seo.json"]);
	assert.deepEqual(s.state().gone, {}, "404 once: not gone");

	// 19 hours later it isn't asked again yet.
	await s.run(t1 + 19 * H);
	assert.equal(s.fetched.length, 1);
	assert.equal(gone.isConfirmed({ ...suspect, checks: [t1, t1 + 19 * H] }, t1 + 48 * H), false, "two 404s 19 hours apart");

	// 21 hours later: a second 404, but the index copy is still the same one.
	await s.run(t1 + 21 * H);
	assert.equal(s.fetched.length, 2);
	assert.deepEqual(s.state().suspects.seo.checks, [t1, t1 + 21 * H]);
	assert.deepEqual(s.state().gone, {}, "the same index copy: not gone");
	assert.equal(s.memos.size, 0);

	// The next day's copy still doesn't have it: gone, and the posts that link to it (published, this exact slug) are queued.
	s.copy(without(all, "Q180711"), t1 + 24 * H);
	const run = await s.run(t1 + 24 * H);
	assert.deepEqual(run.confirmed, ["seo"]);
	assert.equal(s.fetched.length, 2, "no third check");
	assert.equal(run.queued, 2);
	assert.deepEqual(s.state().gone.seo, { qid: "Q180711", since: t1 + 24 * H, approved: true, scannedAt: t1 + 24 * H, entries: 2 });
	assert.deepEqual([...s.memos.keys()].sort(), ["posts:E1", "posts:E2"]);
	assert.deepEqual(s.memos.get("posts:E1"), { collection: "posts", entryId: "E1", linked: [], unlink: [{ slug: "seo", qid: "Q180711" }], retryAt: t1 + 24 * H, unlinkAt: t1 + 24 * H, tries: 0, updated: new Date(t1 + 24 * H).toISOString() });

	// Looked for again 6 hours later: already waiting (not queued twice); once no entry links to it, it's done.
	await s.run(t1 + 26 * H);
	assert.equal(s.state().gone.seo.scannedAt, t1 + 24 * H, "not before 6 hours");
	assert.equal((await s.run(t1 + 30 * H)).queued, 0);
	assert.ok(s.state().gone.seo, "still linked");
	// A memo whose turn was used up gets the work again.
	s.memos.set("posts:E2", { ...s.memos.get("posts:E2")!, retryAt: undefined });
	assert.equal((await s.run(t1 + 36 * H)).queued, 1);
	s.unlinked("E1");
	s.unlinked("E2");
	await s.run(t1 + 42 * H);
	assert.deepEqual(s.state().gone, {}, "no entry links to it any more: done");
});

test("checks that count for nothing: 5xx, 403, 429 and timeouts record no answer and wait an hour; 2xx and 3xx mean alive", async () => {
	const all = terms(20, SEO);
	for (const status of [500, 503, 403, 429, "timeout"] as const) {
		const s = await started(all);
		s.answer(() => status);
		s.copy(without(all, "Q180711"), T0 + 24 * H);
		await s.run(T0 + 24 * H);
		assert.deepEqual(s.state().suspects.seo.checks, [], String(status));
		assert.equal(s.state().suspects.seo.triedAt, T0 + 24 * H);
		await s.run(T0 + 24 * H + 30 * 60_000);
		assert.equal(s.fetched.length, 1, `${status}: not asked again within the hour`);
		s.answer(() => 404);
		await s.run(T0 + 25 * H);
		assert.deepEqual(s.state().suspects.seo.checks, [T0 + 25 * H], `${status}: then a 404 counts`);
	}
	for (const status of [200, 301, 302, 308] as const) {
		const s = await started(all);
		s.answer(() => status);
		s.copy(without(all, "Q180711"), T0 + 24 * H);
		await s.run(T0 + 24 * H);
		assert.equal(s.state().suspects.seo, undefined, `${status}: alive`);
		assert.deepEqual(s.state().gone, {});
	}
	// 410 counts as gone, like 404.
	const s = await started(all);
	s.answer(() => 410);
	s.copy(without(all, "Q180711"), T0 + 24 * H);
	await s.run(T0 + 24 * H);
	assert.deepEqual(s.state().suspects.seo.checks, [T0 + 24 * H]);
});

test("a QID back in the index is dropped at every stage: suspect, confirmed, kept", async () => {
	const all = terms(20, SEO);
	const s = await started(all);
	s.copy(without(all, "Q180711"), T0 + 24 * H);
	await s.run(T0 + 24 * H);
	assert.ok(s.state().suspects.seo);
	s.copy(all, T0 + 48 * H);
	await s.run(T0 + 48 * H);
	assert.deepEqual(s.state().suspects, {});

	const back = gone.observeCopy(
		{ last: { fetchedAt: 1, slugs: {} }, suspects: {}, gone: { seo: { qid: "Q180711", since: 0, approved: true } }, keep: { old: "Q1000" }, updated: "" },
		{ fetchedAt: 2, terms: all },
		3,
	).state;
	assert.deepEqual(back.gone, {});
	assert.deepEqual(back.keep, {});
});

test("at most 5 checks a run, within the run's subrequest budget", async () => {
	const all = terms(100);
	const five = ["Q1000", "Q1001", "Q1002", "Q1003", "Q1004"];
	const s = await started(all);
	s.answer(() => 500);
	s.copy(without(all, ...five), T0 + 24 * H);
	await s.run(T0 + 24 * H);
	assert.equal(s.fetched.length, 5);
	// Two hours later: those five are due again, and three more are missing: eight due, five asked.
	s.answer(() => 404);
	s.copy(without(all, ...five, "Q1005", "Q1006", "Q1007"), T0 + 26 * H);
	await s.run(T0 + 26 * H);
	assert.equal(s.fetched.length, 10);
	await s.run(T0 + 26 * H + 2 * 60_000);
	assert.equal(s.fetched.length, 13, "the other three on the next run");

	const b = await started(all);
	b.copy(without(all, ...five), T0 + 24 * H);
	const budget = { used: 38, max: 40 };
	await b.run(T0 + 24 * H, { budget });
	assert.equal(b.fetched.length, 2, "two left in the budget");
	assert.equal(budget.used, 40);
});

/** A state with these terms confirmed gone, compared against the current copy. */
function confirmedState(all: Terms, slugs: Record<string, string>, at: number) {
	const last = Object.fromEntries(Object.entries(all).map(([qid, t]) => [t[0], qid]));
	return { last: { fetchedAt: at, slugs: last }, suspects: {}, gone: Object.fromEntries(Object.entries(slugs).map(([slug, qid]) => [slug, { qid, since: at }])), updated: "" };
}

test("caps: more than 5 terms at once, or more than 20 entries, hold for a person; approve lets them go, dismiss keeps the links", async () => {
	const all = terms(40);
	// Six confirmed at once.
	const six = Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`term-${i}`, `Q${1000 + i}`]));
	const many = site(all);
	many.setState(confirmedState(without(all, ...Object.values(six)), six, T0));
	many.copy(without(all, ...Object.values(six)), T0);
	for (const slug of Object.keys(six)) many.post(`E-${slug}`, `https://glossary.io/${slug}/`);
	await many.run(T0 + H);
	assert.equal(many.state().held!.why, "many-terms");
	assert.deepEqual(many.state().held!.slugs, Object.keys(six).sort());
	assert.equal(many.memos.size, 0, "nothing queued");
	assert.equal(many.errors.length, 1);
	await many.run(T0 + 2 * H);
	assert.equal(many.errors.length, 1, "logged once");

	// The page shows the list; a stale list is refused.
	const stale = await gone.decideGone(many.ctx, "approve", ["term-0"]);
	assert.equal(stale.ok, false);
	const approved = await gone.decideGone(many.ctx, "approve", Object.keys(six));
	assert.equal(approved.ok, true);
	assert.equal(many.state().held, undefined);
	// Five terms' entries are looked for per run; the sixth on the next one. The approval stays, so nothing holds again.
	assert.equal((await many.run(T0 + 3 * H)).queued, 5);
	assert.equal(many.state().held, undefined);
	assert.equal((await many.run(T0 + 3 * H + 5 * 60_000)).queued, 1);
	assert.equal(many.memos.size, 6);
	assert.equal(many.state().held, undefined);
	assert.equal((await many.run(T0 + 3 * H + 10 * 60_000)).queued, 0);
	assert.equal(many.state().held, undefined, "still linked, still approved: not held again");
	assert.equal(many.errors.length, 1, "no second prompt");

	// More than 20 entries for one term.
	const busy = site(all);
	busy.setState(confirmedState(without(all, "Q1000"), { "term-0": "Q1000" }, T0));
	busy.copy(without(all, "Q1000"), T0);
	for (let i = 0; i < 21; i++) busy.post(`E${i}`, "https://glossary.io/term-0/");
	await busy.run(T0 + H);
	assert.equal(busy.state().held!.why, "many-entries");
	assert.equal(busy.state().held!.entries, 21);
	assert.equal(busy.memos.size, 0);
	assert.equal(busy.state().gone["term-0"].entries, 21);
	assert.equal(gone.goneSummary(busy.state()).confirmed[0].entries, 21);
	// Not looked for again every run while it waits.
	await busy.run(T0 + 2 * H);
	assert.equal(busy.state().gone["term-0"].scannedAt, T0 + H);
	const kept = await gone.decideGone(busy.ctx, "dismiss", ["term-0"]);
	assert.equal(kept.ok, true);
	assert.deepEqual(busy.state().gone, {});
	assert.deepEqual(busy.state().keep, { "term-0": "Q1000" });
	assert.equal(busy.state().held, undefined);
	assert.equal((await busy.run(T0 + 8 * H)).queued, 0);
	assert.equal(busy.memos.size, 0, "kept links are never queued");
});

test("a refused copy: approve makes the missing terms ordinary suspects (still two 404s a day apart); dismiss keeps their links", async () => {
	const all = terms(100);
	const lostQids = ["Q1000", "Q1001", "Q1002", "Q1003", "Q1004", "Q1005"];
	const lost = ["term-0", "term-1", "term-2", "term-3", "term-4", "term-5"];
	for (const action of ["approve", "dismiss"] as const) {
		const s = await started(all);
		s.copy(without(all, ...lostQids), T0 + 24 * H);
		await s.run(T0 + 24 * H);
		assert.equal(s.state().held!.why, "index-shrank");
		const decided = await gone.decideGone(s.ctx, action, lost, T0 + 25 * H);
		assert.equal(decided.ok, true, action);
		assert.equal(s.state().held, undefined);
		assert.equal(s.state().last!.fetchedAt, T0 + 24 * H, "the copy is accepted");
		if (action === "approve") {
			assert.deepEqual(Object.keys(s.state().suspects).sort(), lost);
			assert.deepEqual(s.state().gone, {});
			await s.run(T0 + 25 * H);
			assert.equal(s.fetched.length, 5, "checked like any suspect");
		} else {
			assert.deepEqual(s.state().suspects, {});
			assert.deepEqual(Object.keys(s.state().keep ?? {}).sort(), lost);
		}
	}
	// A list that no longer matches the copy is refused.
	const s = await started(all);
	s.copy(without(all, ...lostQids), T0 + 24 * H);
	await s.run(T0 + 24 * H);
	s.copy(without(all, ...lostQids, "Q1006"), T0 + 48 * H);
	assert.equal((await gone.decideGone(s.ctx, "approve", lost)).ok, false);
});

test("dismiss without a hold keeps a suspect's or a confirmed term's links; nothing to decide is refused", async () => {
	const all = terms(20, SEO);
	const s = await started(all);
	assert.equal((await gone.decideGone(s.ctx, "approve", ["seo"])).ok, false);
	s.copy(without(all, "Q180711"), T0 + 24 * H);
	await s.run(T0 + 24 * H);
	const kept = await gone.decideGone(s.ctx, "dismiss", ["seo"]);
	assert.equal(kept.ok, true);
	assert.deepEqual(kept.summary.kept, ["seo"]);
	assert.deepEqual(s.state().suspects, {});
	assert.equal((await gone.decideGone(s.ctx, "dismiss", ["seo"])).ok, false);
});

test("entries on the skip list, unpublished entries and look-alike slugs are never queued; glossary.io itself does nothing", async () => {
	const all = terms(20, SEO);
	const s = site(all);
	s.setState(confirmedState(without(all, "Q180711"), { seo: "Q180711" }, T0));
	s.copy(without(all, "Q180711"), T0);
	s.post("E1", "https://glossary.io/seo/");
	s.post("E2", "https://glossary.io/seo/", { slug: "links" });
	s.post("E3", "https://glossary.io/seo/", { status: "draft" });
	s.post("E4", "https://glossary.io/seo-audit/");
	const run = await s.run(T0 + H, { options: { glossaryLinks: { skip: ["posts:links"] } } });
	assert.equal(run.queued, 1);
	assert.deepEqual([...s.memos.keys()], ["posts:E1"]);

	const own = site(all);
	(own.ctx as { site: { url: string } }).site.url = "https://glossary.io";
	assert.equal((await own.run(T0)).paused, true);
	assert.equal(own.state(), undefined);
});

test("the summary the AI Enrichment page shows", async () => {
	assert.deepEqual(gone.goneSummary(null), { checking: 0, suspects: [], confirmed: [], held: null, kept: [], indexCopyAt: null });
	const all = terms(20, SEO);
	const s = await started(all);
	s.copy(without(all, "Q180711"), T0 + 24 * H);
	await s.run(T0 + 24 * H);
	const summary = gone.goneSummary(s.state());
	assert.equal(summary.checking, 1);
	assert.deepEqual(summary.suspects, [{ slug: "seo", qid: "Q180711", since: new Date(T0 + 24 * H).toISOString(), goneAnswers: 1 }]);
	assert.equal(summary.indexCopyAt, new Date(T0 + 24 * H).toISOString());
});

// ── Review fixes (0.50.0) ────────────────────────────────────────

test("an approval lasts until the term is done: no second hold while its links come out, on later runs or at the 6-hour look", async () => {
	const all = terms(40);
	// Many terms: approved once, then never held again.
	const six = Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`term-${i}`, `Q${1000 + i}`]));
	const many = site(all);
	many.setState(confirmedState(without(all, ...Object.values(six)), six, T0));
	many.copy(without(all, ...Object.values(six)), T0);
	for (const slug of Object.keys(six)) many.post(`E-${slug}`, `https://glossary.io/${slug}/`);
	await many.run(T0 + H);
	assert.equal(many.state().held!.why, "many-terms");
	assert.equal((await gone.decideGone(many.ctx, "approve", Object.keys(six))).ok, true);
	for (const at of [T0 + 2 * H, T0 + 2 * H + 5 * 60_000, T0 + 3 * H, T0 + 9 * H, T0 + 16 * H]) {
		await many.run(at);
		assert.equal(many.state().held, undefined, `no hold at +${(at - T0) / H} h`);
	}
	assert.equal(many.errors.length, 1, "one prompt, ever");
	assert.equal(many.memos.size, 6);
	assert.equal(Object.keys(many.state().gone).length, 6, "still linked: still listed, still approved");
	assert.ok(Object.values(many.state().gone).every((g) => g.approved === true));

	// Many entries: approved once; 6 hours later more than 20 still link to it, and it isn't held again.
	const busy = site(all);
	busy.setState(confirmedState(without(all, "Q1000"), { "term-0": "Q1000" }, T0));
	busy.copy(without(all, "Q1000"), T0);
	for (let i = 0; i < 60; i++) busy.post(`E${i}`, "https://glossary.io/term-0/");
	await busy.run(T0 + H);
	assert.equal(busy.state().held!.why, "many-entries");
	assert.equal(busy.state().held!.entries, 60);
	assert.equal((await gone.decideGone(busy.ctx, "approve", ["term-0"])).ok, true);
	assert.equal((await busy.run(T0 + 2 * H)).queued, 60, "looked for right away, not 6 hours after the hold's look");
	assert.equal(busy.state().held, undefined);
	for (let i = 0; i < 30; i++) busy.unlinked(`E${i}`);
	await busy.run(T0 + 9 * H);
	assert.equal(busy.state().held, undefined, "30 still linked 6 hours later: no second hold");
	assert.equal(busy.state().gone["term-0"].entries, 30);
	assert.equal(busy.errors.length, 1);

	// Terms already past the caps don't count toward them: 3 yesterday and 3 today is no hold.
	const spread = site(all);
	const first = { "term-0": "Q1000", "term-1": "Q1001", "term-2": "Q1002" };
	const second = { "term-3": "Q1003", "term-4": "Q1004", "term-5": "Q1005" };
	const gapped = without(all, ...Object.values(first), ...Object.values(second));
	spread.setState(confirmedState(gapped, first, T0));
	spread.copy(gapped, T0);
	for (const slug of [...Object.keys(first), ...Object.keys(second)]) for (let i = 0; i < 6; i++) spread.post(`E-${slug}-${i}`, `https://glossary.io/${slug}/`);
	assert.equal((await spread.run(T0 + H)).queued, 18);
	const state = spread.state();
	for (const [slug, qid] of Object.entries(second)) state.gone[slug] = { qid, since: T0 + 24 * H };
	spread.setState(state);
	assert.equal((await spread.run(T0 + 24 * H)).queued, 18, "the new three, under both caps on their own");
	assert.equal(spread.state().held, undefined);
	assert.equal(spread.errors.length, 0);
	// A new batch that is over a cap holds by itself, while the approved terms carry on.
	const more = spread.state();
	for (let i = 10; i < 16; i++) more.gone[`term-${i}`] = { qid: `Q${1000 + i}`, since: T0 + 48 * H };
	spread.setState(more);
	await spread.run(T0 + 48 * H);
	assert.deepEqual(spread.state().held!.slugs, ["term-10", "term-11", "term-12", "term-13", "term-14", "term-15"], "only the new ones wait");
});

test("looking for entries is bounded: 5 terms a run, the rest carried over, queries counted in the budget, none after the deadline", async () => {
	const all = terms(400);
	const lost = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`term-${i}`, `Q${1000 + i}`]));
	const left = without(all, ...Object.values(lost));
	const approvedState = () => {
		const state = confirmedState(left, lost, T0) as { gone: Record<string, { approved?: true }> };
		for (const g of Object.values(state.gone)) g.approved = true;
		return state;
	};
	const s = site(all);
	s.setState(approvedState());
	s.copy(left, T0);
	for (let i = 0; i < 12; i++) s.post(`E${i}`, `https://glossary.io/term-${i}/`);
	assert.equal(gone.MAX_SCANS, 5);
	const budget = { used: 0, max: 40 };
	// In slug order: term-0, term-1, term-10, term-100, term-101 (the first three have a post).
	assert.equal((await s.run(T0 + H, { budget })).queued, 3);
	assert.deepEqual(s.queries, ["term-0", "term-1", "term-10", "term-100", "term-101"], "5 terms, one query each (one Portable Text field)");
	assert.equal(s.state().gone["term-100"], undefined, "no entry links to it: done");
	assert.equal(budget.used, 5, "each query counts against the run's budget");
	const firstFive = [...s.queries];
	await s.run(T0 + H + 5 * 60_000);
	assert.equal(s.queries.length, 10);
	assert.equal(new Set(s.queries).size, 10, "the next run carries on with other terms");
	assert.ok(firstFive.slice(0, 3).every((slug) => s.state().gone[slug].scannedAt === T0 + H), "what was looked for is recorded");

	// Two queries left in the budget: two terms. Past the deadline: none.
	const tight = { used: 38, max: 40 };
	await s.run(T0 + H + 10 * 60_000, { budget: tight });
	assert.equal(s.queries.length, 12);
	assert.equal(tight.used, 40);
	await s.run(T0 + H + 15 * 60_000, { deadline: Date.now() - 1 });
	assert.equal(s.queries.length, 12, "out of time: nothing is looked for");

	// A query that fails: what the run found before it is queued and recorded, and isn't looked for again on the next run.
	const f = site(all);
	f.setState(approvedState());
	f.copy(left, T0);
	for (let i = 0; i < 12; i++) f.post(`E${i}`, `https://glossary.io/term-${i}/`);
	f.failOn("term-10");
	await f.run(T0 + H);
	// Sorted by slug: term-0, term-1, term-10 (fails), …
	assert.deepEqual(f.queries, ["term-0", "term-1", "term-10"]);
	assert.deepEqual([...f.memos.keys()].sort(), ["posts:E0", "posts:E1"], "the two found before the failure are queued");
	assert.equal(f.state().gone["term-0"].scannedAt, T0 + H);
	assert.equal(f.warnings.length, 1);
	f.failOn(null);
	await f.run(T0 + H + 5 * 60_000);
	assert.deepEqual(f.queries.slice(3), ["term-100", "term-101", "term-102", "term-103", "term-104"], "the next run moves on: nothing repeated, the failed term at the back of the line");
});

test("a slug another term has now is alive: suspects and confirmed terms with that slug are dropped, whatever the QID", async () => {
	const all = terms(20, SEO);
	const s = await started(all);
	s.copy(without(all, "Q180711"), T0 + 24 * H);
	await s.run(T0 + 24 * H);
	assert.ok(s.state().suspects.seo);
	// glossary.io gives /seo/ to another term (another QID).
	const reused: Terms = { ...without(all, "Q180711"), Q999: ["seo", "Search engine optimisation, again."] };
	s.copy(reused, T0 + 48 * H);
	await s.run(T0 + 48 * H);
	assert.deepEqual(s.state().suspects, {}, "the address works again");
	assert.equal(s.fetched.length, 1, "not asked about again");

	const state = { last: { fetchedAt: 1, slugs: { seo: "Q180711", old: "Q1" } }, suspects: { other: { qid: "Q5", since: 0, firstCopyAt: 0, checks: [] } }, gone: { seo: { qid: "Q180711", since: 0, approved: true as const } }, keep: { kept: "Q7" }, updated: "" };
	const next = gone.observeCopy(state, { fetchedAt: 2, terms: { Q999: ["seo", "x"], Q998: ["other", "x"], Q997: ["kept", "x"], Q996: ["old", "x"] } }, 3, "approve").state;
	assert.deepEqual(next.gone, {}, "confirmed, approved: dropped with its approval");
	assert.deepEqual(next.suspects, {}, "a suspect's slug under another QID, and a lost term whose slug is reused, aren't suspects");
	assert.deepEqual(next.keep, {});
});

test("a suspect that never gets a clear answer is asked less and less often (an hour, doubling to a day) and dropped after two weeks", async () => {
	const all = terms(20, SEO);
	const s = await started(all);
	s.answer(() => 503);
	const t1 = T0 + 24 * H;
	s.copy(without(all, "Q180711"), t1);
	await s.run(t1);
	const asked: number[] = [0];
	// A run every 30 minutes for 15 days.
	for (let at = t1 + H / 2; at <= t1 + 15 * 24 * H && s.state().suspects.seo; at += H / 2) {
		const before = s.fetched.length;
		await s.run(at);
		if (s.fetched.length > before) asked.push((at - t1) / H);
	}
	assert.deepEqual(asked.slice(0, 8), [0, 1, 3, 7, 15, 31, 55, 79], "after 1, 2, 4, 8, 16 hours, then every 24");
	assert.ok(asked.length <= 20, `${asked.length} checks in two weeks, not one an hour`);
	assert.equal(s.state().suspects.seo, undefined, "given up");
	assert.deepEqual(s.state().gone, {}, "never removed");
	assert.equal(s.warnings.filter((w) => w.includes("no clear answer")).length, 1, "logged");
	// A clear answer resets the wait.
	assert.equal(gone.checkDue({ qid: "Q1", since: 0, firstCopyAt: 0, checks: [], triedAt: 0, unknowns: 4 }, 7 * H), false);
	assert.equal(gone.checkDue({ qid: "Q1", since: 0, firstCopyAt: 0, checks: [], triedAt: 0, unknowns: 4 }, 8 * H), true);
	assert.equal(gone.checkDue({ qid: "Q1", since: 0, firstCopyAt: 0, checks: [], triedAt: 0, unknowns: 99 }, 24 * H), true);
});

test("after more than two days without a run (the part was off), it starts over from the current index: terms lost meanwhile are never removed", async () => {
	const all = terms(20, SEO);
	const s = await started(all);
	await s.run(T0 + 24 * H);
	// Off for five days; glossary.io deleted a term meanwhile.
	s.copy(without(all, "Q180711"), T0 + 6 * 24 * H);
	const run = await s.run(T0 + 6 * 24 * H);
	assert.equal(run.paused, true, "like a first run");
	assert.deepEqual(s.state().suspects, {}, "not a suspect");
	assert.equal(s.state().last!.fetchedAt, T0 + 6 * 24 * H);
	assert.equal(s.state().last!.slugs.seo, undefined);
	await s.run(T0 + 6 * 24 * H + H);
	assert.deepEqual(s.state().suspects, {});
	assert.deepEqual(s.fetched, []);
	// A quiet day or two is not a restart: a term lost then is checked as usual.
	const on = await started(all);
	await on.run(T0 + 24 * H);
	on.copy(without(all, "Q180711"), T0 + 60 * H);
	await on.run(T0 + 60 * H);
	assert.ok(on.state().suspects.seo);
});

test("queued entries: the turn is marked as the removal's own; a try to link that was already waiting is remembered", async () => {
	const all = terms(20, SEO);
	const s = site(all);
	s.setState(confirmedState(without(all, "Q180711"), { seo: "Q180711" }, T0));
	s.copy(without(all, "Q180711"), T0);
	s.post("E1", "https://glossary.io/seo/");
	s.post("E2", "https://glossary.io/seo/");
	// E2: the site asked for it to be linked again (as coywolf.com's json_set writes it: epoch ms, a number, tries 0).
	s.memos.set("posts:E2", { collection: "posts", entryId: "E2", linked: ["Q5"], retryAt: T0 + 30 * 60_000, tries: 0, updated: "" });
	const now = T0 + H;
	assert.equal((await s.run(now)).queued, 2);
	assert.deepEqual(s.memos.get("posts:E1"), { collection: "posts", entryId: "E1", linked: [], unlink: [{ slug: "seo", qid: "Q180711" }], retryAt: now, unlinkAt: now, tries: 0, updated: new Date(now).toISOString() });
	assert.deepEqual(s.memos.get("posts:E2"), { collection: "posts", entryId: "E2", linked: ["Q5"], unlink: [{ slug: "seo", qid: "Q180711" }], retryAt: now, unlinkAt: now, relink: true, tries: 0, updated: new Date(now).toISOString() });
});

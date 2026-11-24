/**
 * Remove links to deleted glossary.io terms (AI Enrichment part
 * "ai.glossaryLinksRemoveGone", off by default; needs "ai.glossaryLinks").
 *
 * It only checks whether definitions exist: it compares the site's stored
 * copies of glossary.io's public index (src/ai/glossary.ts) and asks for a
 * term's public JSON (https://glossary.io/api/terms/<slug>.json) to read its
 * status code. It sends nothing to glossary.io and asks it for nothing else;
 * what it changes is the site's own entries.
 *
 * A term counts as gone only when all of these hold:
 * 1. Only good index copies count: the stored copy is only ever written after
 *    a 200 answer that parsed as version 1 and had terms.
 * 2. Shrink guard: a newer copy that lost more than max(5, 1%) of the terms
 *    (by QID) is refused. Nothing changes, the part holds with the list and
 *    logs an error once per copy; a later copy that has them back lets go by
 *    itself, or a person decides on the AI Enrichment page.
 * 3. A renamed term (its QID under another slug) is alive: its links stay
 *    (glossary.io redirects the old address).
 * 4. Each term missing from the index (a suspect) is checked, at most 5 a
 *    run: 404 or 410 records a "gone" answer; 2xx or 3xx means it's alive (the
 *    suspect is dropped); anything else (5xx, 403, 429, a timeout) counts for
 *    nothing, and the term is asked again an hour later. A QID back in the
 *    index drops it at every stage, right before the edit included.
 * 5. Confirmed gone: two "gone" answers at least 20 hours apart, and the QID
 *    missing from two accepted copies at least 20 hours apart.
 *
 * Then the entries that link to it (published, in the collections AI
 * Enrichment works on, found in D1 and confirmed by parsing their links, so
 * hand-made links count too) get it in their aiLinks memo's `unlink` list, and
 * the glossary links retry pass takes the links out (unlinkEntry in
 * src/ai/glossary-linker.ts). More than 5 terms confirmed at once, or more
 * than 20 entries that would change, waits for a person instead. A term's
 * entries are looked for again every 6 hours until none links to it.
 *
 * State: one document, aiGlossary/gone. The first run only records the
 * current index, so terms already missing then are never removed.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { databaseFor } from "../core/database.js";
import { type FeatureMap, isOn } from "../core/features.js";
import { VERSION } from "../version.js";
import { GLOSSARY_COLLECTION, GLOSSARY_ORIGIN, type GlossaryTerms, isGlossarySite, storedGlossary } from "./glossary.js";
import { glossarySlugsIn } from "./glossary-links.js";
import type { LinkMemo } from "./glossary-linker.js";
import type { AiOptions } from "./store.js";

/** The switch (registered with the other AI Enrichment parts in src/ai/pack.ts). */
export const REMOVE_GONE_FEATURE = {
	id: "ai.glossaryLinksRemoveGone",
	label: "Remove links to deleted glossary.io terms",
	description:
		"When a glossary.io term is gone for good (checked twice, a day apart), take its links out of entries and keep the text. Holds and warns when several terms disappear at once.",
	default: false,
	requires: ["ai.glossaryLinks"],
};

/** Whether the scheduled run checks for deleted terms (both switches on). */
export const removeGoneOn = (features: FeatureMap): boolean => isOn(features, "ai.glossaryLinks") && isOn(features, REMOVE_GONE_FEATURE.id);

export const GONE_DOC = "gone";
/** More terms confirmed and waiting at once than this holds for a person. */
export const MAX_GONE_TERMS = 5;
/** More entries that would change than this holds for a person. */
export const MAX_GONE_ENTRIES = 20;
/** Term checks per scheduled run. */
export const MAX_CHECKS = 5;
/** Two "gone" answers, and two index copies without the term, at least this far apart. */
export const CONFIRM_MS = 20 * 60 * 60_000;
/** After a check that counted for nothing (an error, a timeout, a 429), this long before that term is asked again. */
export const RETRY_CHECK_MS = 60 * 60_000;
/** How often a confirmed term's entries are looked for again (links still there are queued again; none left: done). */
export const RESCAN_MS = 6 * 60 * 60_000;
const CHECK_TIMEOUT_MS = 10_000;

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** Collection and field slugs, before they go into SQL. */
const IDENT = /^[a-z][a-z0-9_]*$/;

export interface GoneSuspect {
	qid: string;
	/** When it went missing from the index (epoch ms). */
	since: number;
	/** The first accepted index copy without it (its fetchedAt). */
	firstCopyAt: number;
	/** Times of "gone" answers: the first and the latest. */
	checks: number[];
	/** The last check, whatever it answered. */
	triedAt?: number;
}

export interface GoneTerm {
	qid: string;
	/** When it was confirmed gone (epoch ms). */
	since: number;
	/** When its entries were last looked for, and how many link to it. */
	scannedAt?: number;
	entries?: number;
}

export interface GoneHold {
	why: "index-shrank" | "many-terms" | "many-entries";
	slugs: string[];
	entries?: number;
	since: string;
	/** index-shrank: the refused copy's fetchedAt. */
	copyAt?: number;
}

export interface GoneState {
	/** The last index copy accepted: when it was fetched and its slug → QID map. */
	last: { fetchedAt: number; slugs: Record<string, string> } | null;
	/** Terms missing from the index, being checked. */
	suspects: Record<string, GoneSuspect>;
	/** Confirmed gone, links not yet all removed. Dropped when no entry links to it any more, or when its QID returns. */
	gone: Record<string, GoneTerm>;
	/** Waiting for a person: why, and which slugs. */
	held?: GoneHold;
	/** Links a person chose to keep (slug → QID): never removed until the term is back in the index. */
	keep?: Record<string, string>;
	/** Slugs a person let past the caps: their links are queued on the next run. */
	approved?: string[];
	updated: string;
}

export interface IndexCopy {
	fetchedAt: number;
	terms: GlossaryTerms;
}

const goneDocs = (ctx: Pick<PluginContext, "storage">) => (ctx.storage as Record<string, StorageCollection>)[GLOSSARY_COLLECTION] as StorageCollection<GoneState>;
const linkMemos = (ctx: Pick<PluginContext, "storage">) => (ctx.storage as Record<string, StorageCollection>).aiLinks as StorageCollection<LinkMemo>;
const iso = (ms: number) => new Date(ms).toISOString();

/** The stored state, or null before the first run. */
export async function readGoneState(ctx: Pick<PluginContext, "storage">): Promise<GoneState | null> {
	const state = await goneDocs(ctx)?.get(GONE_DOC);
	return state && typeof state === "object" && state.suspects && state.gone ? state : null;
}

/** An index copy's slug → QID map. */
export function slugMap(terms: GlossaryTerms): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [qid, term] of Object.entries(terms)) out[term[0]] = qid;
	return out;
}

/** Most terms (by QID) a newer copy may lose at once before it's refused. */
export const shrinkLimit = (count: number) => Math.max(5, count / 100);

/**
 * A newer index copy: refused when it lost too many terms (the hold says
 * which; `last` stays), else accepted: terms it lost become suspects (or, for
 * a person's "keep" on a refused copy, kept), terms that are back leave every
 * list, and it becomes `last`. A person's "approve" or "keep" accepts a copy
 * the shrink guard refused. Pure: returns a new state.
 */
export function observeCopy(state: GoneState, copy: IndexCopy, now: number, decision?: "approve" | "keep"): { state: GoneState; lost: string[]; refused: boolean; newHold?: boolean } {
	const last = state.last;
	if (!last) return { state: { ...state, last: { fetchedAt: copy.fetchedAt, slugs: slugMap(copy.terms) } }, lost: [], refused: false };
	if (copy.fetchedAt <= last.fetchedAt) return { state, lost: [], refused: false };
	const qids = new Set(Object.keys(copy.terms));
	const lost = Object.entries(last.slugs)
		.filter(([, qid]) => !qids.has(qid))
		.map(([slug]) => slug)
		.sort();
	if (!decision && lost.length > shrinkLimit(Object.keys(last.slugs).length)) {
		if (state.held?.why === "index-shrank" && state.held.copyAt === copy.fetchedAt) return { state, lost, refused: true };
		return { state: { ...state, held: { why: "index-shrank", slugs: lost, since: iso(now), copyAt: copy.fetchedAt } }, lost, refused: true, newHold: true };
	}
	const next = structuredClone(state);
	if (next.held?.why === "index-shrank") delete next.held;
	for (const slug of lost) {
		const qid = last.slugs[slug];
		if (next.suspects[slug] || next.gone[slug] || next.keep?.[slug]) continue;
		if (decision === "keep") (next.keep ??= {})[slug] = qid;
		else next.suspects[slug] = { qid, since: now, firstCopyAt: copy.fetchedAt, checks: [] };
	}
	// Back in the index (under any slug): nothing to remove.
	for (const [slug, s] of Object.entries(next.suspects)) if (qids.has(s.qid)) delete next.suspects[slug];
	for (const [slug, g] of Object.entries(next.gone)) if (qids.has(g.qid)) delete next.gone[slug];
	for (const [slug, qid] of Object.entries(next.keep ?? {})) if (qids.has(qid)) delete next.keep![slug];
	if (next.approved) next.approved = next.approved.filter((s) => next.gone[s]);
	next.last = { fetchedAt: copy.fetchedAt, slugs: slugMap(copy.terms) };
	return { state: next, lost, refused: false };
}

/** Two "gone" answers at least CONFIRM_MS apart. */
const checksDone = (s: GoneSuspect) => s.checks.length >= 2 && s.checks[s.checks.length - 1] - s.checks[0] >= CONFIRM_MS;

/** Whether a suspect is asked about now: never asked, or a day after its first "gone" answer, and not in the hour after a check. */
export function checkDue(s: GoneSuspect, now: number): boolean {
	if (checksDone(s)) return false;
	if (s.triedAt !== undefined && now - s.triedAt < RETRY_CHECK_MS) return false;
	return s.checks.length === 0 || now - s.checks[0] >= CONFIRM_MS;
}

/** Confirmed gone: two "gone" answers 20 hours apart, and missing from two accepted copies 20 hours apart (`lastCopyAt`: the newest accepted copy). */
export const isConfirmed = (s: GoneSuspect, lastCopyAt: number) => checksDone(s) && lastCopyAt - s.firstCopyAt >= CONFIRM_MS;

export type CheckAnswer = "gone" | "alive" | "unknown";

/** Whether glossary.io still has a term: its public JSON's status code (the body isn't read). Never throws. */
export async function checkTerm(fetcher: (url: string, init?: RequestInit) => Promise<Response>, slug: string): Promise<CheckAnswer> {
	if (!SLUG.test(slug)) return "unknown";
	try {
		const response = await fetcher(`${GLOSSARY_ORIGIN}/api/terms/${slug}.json`, {
			redirect: "manual",
			headers: { Accept: "application/json", "User-Agent": `CoywolfPack/${VERSION} (+https://github.com/coywolf-llc/coywolf-pack)` },
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
		await response.body?.cancel().catch(() => undefined);
		if (response.status === 404 || response.status === 410) return "gone";
		if ((response.status >= 200 && response.status < 400) || response.type === "opaqueredirect") return "alive";
		return "unknown";
	} catch {
		return "unknown";
	}
}

export interface GoneRun {
	/** True when removals must wait (no good index copy, the first run, or a refused copy): the retry pass then only links. */
	paused: boolean;
	checked: number;
	confirmed: string[];
	queued: number;
}

/** Hold for a person; logged as an error when the hold is new or its list changed. */
function hold(ctx: PluginContext, state: GoneState, next: Omit<GoneHold, "since">, now: number): void {
	const same = state.held?.why === next.why && state.held.slugs.join() === next.slugs.join() && state.held.entries === next.entries;
	if (same) return;
	state.held = { ...next, since: iso(now) };
	ctx.log.error(
		next.why === "many-terms"
			? `glossary.io links: ${next.slugs.length} glossary.io terms were deleted at once; their links stay until a person decides (AI Enrichment page).`
			: `glossary.io links: links to deleted glossary.io terms are in ${next.entries} entries; they stay until a person decides (AI Enrichment page).`,
		{ slugs: next.slugs, entries: next.entries },
	);
}

let warnedNoDatabase = false;

/**
 * One scheduled run's work (inside the AI lock, before the glossary links
 * retry pass): look at the newest index copy, check up to MAX_CHECKS
 * suspects, confirm, and queue the entries of confirmed terms. Each term
 * check counts 1 against the run's subrequest budget. `deadline` (epoch ms):
 * no check starts when it couldn't finish before it.
 */
export async function checkGoneTerms(
	ctx: PluginContext,
	options: AiOptions,
	budget: { used: number; max: number },
	opts: { collections: string[]; deadline?: number; now?: number; db?: D1Database | null },
): Promise<GoneRun> {
	const now = opts.now ?? Date.now();
	const run: GoneRun = { paused: true, checked: 0, confirmed: [], queued: 0 };
	if (isGlossarySite(ctx.site?.url)) return run;
	const copy = await storedGlossary(ctx);
	if (!copy) return run;
	const docs = goneDocs(ctx);
	const stored = await readGoneState(ctx);
	if (!stored?.last) {
		// First run: only the current index is recorded, so terms already missing are never removed.
		await docs.put(GONE_DOC, { ...(stored ?? { suspects: {}, gone: {} }), last: { fetchedAt: copy.fetchedAt, slugs: slugMap(copy.terms) }, updated: iso(now) });
		return run;
	}
	const before = JSON.stringify(stored);
	const seen = observeCopy(stored, copy, now);
	const state = seen.state === stored ? structuredClone(stored) : seen.state;
	if (seen.newHold) {
		ctx.log.error(`glossary.io links: glossary.io's index lost ${seen.lost.length} terms at once; no link is removed until it has them back or a person decides (AI Enrichment page).`, {
			slugs: seen.lost.slice(0, 50),
		});
	}
	if (state.held?.why === "index-shrank") {
		await save();
		return run;
	}
	run.paused = false;

	// Ask glossary.io about the suspects (oldest first).
	const fetcher = ctx.http ? ctx.http.fetch.bind(ctx.http) : fetch;
	const qids = new Set(Object.keys(copy.terms));
	for (const [slug, s] of Object.entries(state.suspects).sort(([, a], [, b]) => a.since - b.since)) {
		if (qids.has(s.qid)) {
			delete state.suspects[slug];
			continue;
		}
		if (!checkDue(s, now)) continue;
		if (run.checked >= MAX_CHECKS || budget.used >= budget.max || (opts.deadline !== undefined && Date.now() + CHECK_TIMEOUT_MS > opts.deadline)) break;
		budget.used++;
		run.checked++;
		const answer = await checkTerm(fetcher, slug);
		s.triedAt = now;
		if (answer === "alive") {
			delete state.suspects[slug];
			ctx.log.info("glossary.io links: a term missing from glossary.io's index still answers; its links stay", { slug });
		} else if (answer === "gone") s.checks = s.checks.length ? [s.checks[0], now] : [now];
	}
	for (const [slug, s] of Object.entries(state.suspects)) {
		if (!isConfirmed(s, state.last!.fetchedAt)) continue;
		state.gone[slug] = { qid: s.qid, since: now };
		delete state.suspects[slug];
		run.confirmed.push(slug);
		ctx.log.info("glossary.io links: a glossary.io term is gone for good", { slug, qid: s.qid });
	}
	try {
		run.queued = await queueRemovals(ctx, options, state, { collections: opts.collections, now, db: opts.db });
	} catch (error) {
		// The checks above are still kept; the entries are looked for again on the next run.
		ctx.log.warn("glossary.io links: couldn't look for entries that link to deleted terms", { error: String(error) });
	}
	await save();
	return run;

	async function save() {
		if (JSON.stringify(state) === before) return;
		state.updated = iso(now);
		await docs.put(GONE_DOC, state);
	}
}

/**
 * Queue the entries that link to confirmed terms (in place on `state`): their
 * memo's `unlink` gets the term and `retryAt` now. A term no entry links to
 * any more is done. Caps hold for a person, unless the person approved these
 * slugs. Returns how many entries were queued.
 */
async function queueRemovals(ctx: PluginContext, options: AiOptions, state: GoneState, opts: { collections: string[]; now: number; db?: D1Database | null }): Promise<number> {
	const { now } = opts;
	const slugs = Object.keys(state.gone).sort();
	if (state.held && state.held.why !== "index-shrank" && !state.held.slugs.some((s) => state.gone[s])) delete state.held;
	if (!slugs.length) {
		delete state.approved;
		return 0;
	}
	const approved = (state.approved ?? []).filter((s) => state.gone[s]);
	let due: string[];
	if (approved.length) due = approved;
	else {
		if (slugs.length > MAX_GONE_TERMS) {
			hold(ctx, state, { why: "many-terms", slugs }, now);
			return 0;
		}
		if (state.held?.why === "many-terms") delete state.held;
		due = slugs.filter((s) => state.gone[s].scannedAt === undefined || now - state.gone[s].scannedAt! >= RESCAN_MS);
	}
	if (!due.length) return 0;
	const db = opts.db !== undefined ? opts.db : await databaseFor();
	if (!db) {
		if (!warnedNoDatabase) ctx.log.error("glossary.io links: removing links to deleted terms needs the site's D1 binding (DB).");
		warnedNoDatabase = true;
		return 0;
	}
	const skip = new Set((options.glossaryLinks?.skip ?? []).map((s) => s.trim()).filter(Boolean));
	const found = await findEntries(ctx, db, opts.collections, due, skip);
	const entries = new Set([...found.values()].flat());
	for (const slug of due) state.gone[slug] = { ...state.gone[slug], scannedAt: now, entries: found.get(slug)?.length ?? 0 };
	if (!approved.length && entries.size > MAX_GONE_ENTRIES) {
		hold(ctx, state, { why: "many-entries", slugs: due, entries: entries.size }, now);
		return 0;
	}
	if (state.held && state.held.why !== "index-shrank") delete state.held;
	delete state.approved;

	const byEntry = new Map<string, Array<{ slug: string; qid: string }>>();
	for (const [slug, keys] of found) for (const key of keys) byEntry.set(key, [...(byEntry.get(key) ?? []), { slug, qid: state.gone[slug].qid }]);
	const memos = linkMemos(ctx);
	let queued = 0;
	for (const [key, list] of byEntry) {
		const colon = key.indexOf(":");
		const memo: LinkMemo = (await memos.get(key)) ?? { collection: key.slice(0, colon), entryId: key.slice(colon + 1), linked: [], updated: "" };
		const unlink = new Map((memo.unlink ?? []).map((u) => [u.slug, u]));
		const had = unlink.size;
		for (const u of list) unlink.set(u.slug, u);
		// Already waiting its turn with these terms.
		if (unlink.size === had && memo.retryAt !== undefined) continue;
		await memos.put(key, { ...memo, unlink: [...unlink.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1)), retryAt: now, tries: 0, updated: iso(now) });
		queued++;
	}
	for (const slug of due) {
		if (found.get(slug)?.length) continue;
		delete state.gone[slug];
		ctx.log.info("glossary.io links: no entry links to a deleted term any more", { slug });
	}
	if (queued) ctx.log.info("glossary.io links: entries queued to remove links to deleted terms", { entries: queued, slugs: due });
	return queued;
}

/**
 * Published entries (in the collections AI Enrichment works on) whose Portable
 * Text links to these slugs, by slug: found in D1 (the published columns,
 * so links made by hand count too), then confirmed by parsing the links (so
 * /seo never matches /seo-audit). Entries on the glossaryLinks skip list are
 * left out.
 */
async function findEntries(ctx: PluginContext, db: D1Database, collections: string[], slugs: string[], skip: ReadonlySet<string>): Promise<Map<string, string[]>> {
	const found = new Map<string, Set<string>>();
	for (const collection of collections) {
		if (!IDENT.test(collection)) continue;
		const info = await ctx.schema?.getCollection(collection);
		const fields = (info?.fields ?? []).filter((f) => f.type === "portableText" && IDENT.test(f.slug)).map((f) => f.slug);
		for (const field of fields) {
			for (const slug of slugs) {
				if (!SLUG.test(slug)) continue;
				const base = `glossary.io/${slug}`;
				const { results } = await db
					.prepare(
						`SELECT id, slug, "${field}" AS body FROM "ec_${collection}" WHERE deleted_at IS NULL AND status = 'published' AND (instr(lower("${field}"), ?1) > 0 OR instr(lower("${field}"), ?2) > 0 OR instr(lower("${field}"), ?3) > 0 OR instr(lower("${field}"), ?4) > 0) LIMIT 200`,
					)
					.bind(`${base}/`, `${base}"`, `${base}?`, `${base}#`)
					.all<{ id: string; slug: string | null; body: string | null }>();
				for (const row of results ?? []) {
					if (row.slug && (skip.has(row.slug) || skip.has(`${collection}:${row.slug}`))) continue;
					let value: unknown;
					try {
						value = JSON.parse(row.body ?? "");
					} catch {
						continue;
					}
					if (!glossarySlugsIn(value).has(slug)) continue;
					if (!found.has(slug)) found.set(slug, new Set());
					found.get(slug)!.add(`${collection}:${row.id}`);
				}
			}
		}
	}
	return new Map([...found].map(([slug, keys]) => [slug, [...keys].sort()]));
}

// ── Status and a person's decisions (the AI Enrichment page) ─────

export interface GoneSummary {
	/** Terms missing from the index, being checked. */
	checking: number;
	suspects: Array<{ slug: string; qid: string; since: string; goneAnswers: number }>;
	/** Confirmed gone, links being removed. */
	confirmed: Array<{ slug: string; qid: string; entries: number | null }>;
	held: GoneHold | null;
	/** Links a person chose to keep. */
	kept: string[];
	/** The index copy last accepted. */
	indexCopyAt: string | null;
}

export function goneSummary(state: GoneState | null): GoneSummary {
	return {
		checking: Object.keys(state?.suspects ?? {}).length,
		suspects: Object.entries(state?.suspects ?? {})
			.map(([slug, s]) => ({ slug, qid: s.qid, since: iso(s.since), goneAnswers: s.checks.length }))
			.sort((a, b) => (a.slug < b.slug ? -1 : 1)),
		confirmed: Object.entries(state?.gone ?? {})
			.map(([slug, g]) => ({ slug, qid: g.qid, entries: g.entries ?? null }))
			.sort((a, b) => (a.slug < b.slug ? -1 : 1)),
		held: state?.held ?? null,
		kept: Object.keys(state?.keep ?? {}).sort(),
		indexCopyAt: state?.last ? iso(state.last.fetchedAt) : null,
	};
}

/**
 * A person's decision on the slugs the AI Enrichment page showed. For a hold,
 * `slugs` must be its whole list (a list that changed since is refused):
 * "approve" lets a many-terms or many-entries hold go ahead, and for a refused
 * index copy accepts it and makes those terms ordinary suspects (they still
 * need two "gone" answers a day apart); "dismiss" keeps their links (never
 * removed until the terms are back in the index). Without a hold, "dismiss"
 * keeps the links of suspects or confirmed terms. Run inside the AI lock.
 */
export async function decideGone(ctx: PluginContext, action: "approve" | "dismiss", slugs: string[], now = Date.now()): Promise<{ ok: boolean; message: string; summary: GoneSummary }> {
	const state = await readGoneState(ctx);
	const fail = (message: string) => ({ ok: false, message, summary: goneSummary(state) });
	if (!state) return fail("Nothing is being checked yet.");
	const asked = [...new Set(slugs)].sort();
	const held = state.held;
	const whole = held !== undefined && held.slugs.length === asked.length && [...held.slugs].sort().every((s, i) => s === asked[i]);
	let next: GoneState;
	let message: string;
	if (held && whole) {
		if (held.why === "index-shrank") {
			const copy = await storedGlossary(ctx);
			if (!copy) return fail("The site has no copy of glossary.io's index right now. Try again later.");
			if (observeCopy(state, copy, now).lost.join() !== asked.join()) return fail("glossary.io's index changed since this list was shown. Reload the page and check the list again.");
			next = observeCopy(state, copy, now, action === "approve" ? "approve" : "keep").state;
			message =
				action === "approve"
					? `Accepted glossary.io's index. The ${asked.length} missing terms are checked one by one, and their links come out only if each is confirmed gone.`
					: `Kept the links to ${asked.length} terms. They're never removed unless a term comes back and is deleted again.`;
		} else {
			next = structuredClone(state);
			delete next.held;
			if (action === "approve") {
				next.approved = asked.filter((s) => next.gone[s]);
				message = `Links to ${next.approved.length} deleted terms are removed over the next scheduled runs.`;
			} else {
				for (const s of asked) {
					if (!next.gone[s]) continue;
					(next.keep ??= {})[s] = next.gone[s].qid;
					delete next.gone[s];
				}
				message = `Kept the links to ${asked.length} terms.`;
			}
		}
	} else if (action === "dismiss") {
		next = structuredClone(state);
		let kept = 0;
		for (const s of asked) {
			const qid = next.suspects[s]?.qid ?? next.gone[s]?.qid;
			if (!qid) continue;
			(next.keep ??= {})[s] = qid;
			delete next.suspects[s];
			delete next.gone[s];
			kept++;
		}
		if (!kept) return fail(held ? "The list changed since it was shown. Reload the page and check it again." : "Those terms aren't being checked.");
		if (next.held && next.held.why !== "index-shrank") {
			next.held.slugs = next.held.slugs.filter((s) => !asked.includes(s));
			if (!next.held.slugs.length) delete next.held;
		}
		message = `Kept the links to ${kept} terms.`;
	} else return fail(held ? "The list changed since it was shown. Reload the page and check it again." : "Nothing is waiting for approval.");
	next.updated = iso(now);
	await goneDocs(ctx).put(GONE_DOC, next);
	return { ok: true, message, summary: goneSummary(next) };
}

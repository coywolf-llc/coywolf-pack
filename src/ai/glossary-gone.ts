/**
 * Remove links to deleted glossary.io terms (AI Enrichment part
 * "ai.glossaryLinksRemoveGone", off by default; needs "ai.glossaryLinks").
 *
 * It only checks whether definitions exist: it compares the site's stored
 * copies of glossary.io's public index (src/ai/glossary.ts) and asks for a
 * term's public JSON (https://glossary.io/api/terms/<slug>.json) to read its
 * status code. It sends nothing to glossary.io and asks it for nothing else;
 * what it changes is the site's own entries. It never links anything.
 *
 * A term counts as gone only when all of these hold:
 * 1. Only good index copies count: the stored copy is only ever written after
 *    a 200 answer that parsed as version 1 and had terms.
 * 2. Shrink guard: a newer copy that lost more than 5 terms (by QID), or more
 *    than 1% of them when that's larger, is refused. Nothing changes, the part
 *    holds with the list and logs an error once per copy; a later copy that
 *    has them back lets go by itself, or a person decides on the AI Enrichment
 *    page.
 * 3. A renamed term (its QID under another slug) is alive: its links stay
 *    (glossary.io redirects the old address). So is a slug another term has
 *    now (another QID): the links lead to a definition again.
 * 4. Each term missing from the index (a suspect) is checked, at most 5 a
 *    run: 404 or 410 records a "gone" answer; 2xx or 3xx means it's alive (the
 *    suspect is dropped); anything else (5xx, 403, 429, a timeout) counts for
 *    nothing, and the term is asked again an hour later, then 2, 4… up to a
 *    day; after two weeks of nothing else it's dropped (logged; its links
 *    stay). A QID or slug back in the index drops it at every stage, right
 *    before the edit included.
 * 5. Confirmed gone: two "gone" answers at least 20 hours apart, and the QID
 *    missing from two accepted copies at least 20 hours apart.
 *
 * Then the entries that link to it (published, in the collections AI
 * Enrichment works on, found in D1 and confirmed by parsing their links, so
 * hand-made links count too) get it in their aiLinks memo's `unlink` list, and
 * the glossary links retry pass takes the links out (unlinkEntry in
 * src/ai/glossary-linker.ts). More than 5 terms confirmed and not yet past the
 * caps, or more than 20 entries of theirs that would change, waits for a
 * person instead; a term that's past the caps (under them, or approved) stays
 * past them until it's done. At most 5 terms' entries are looked for per run,
 * and a term's entries are looked for again every 6 hours until none links to
 * it.
 *
 * State: one document, aiGlossary/gone. The first run only records the
 * current index, so terms already missing then are never removed. The same
 * goes for a run after more than two days without one (the part was off): it
 * starts over from the current index.
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
/** Confirmed terms whose entries are looked for per scheduled run (one D1 query per Portable Text field each). */
export const MAX_SCANS = 5;
/** Two "gone" answers, and two index copies without the term, at least this far apart. */
export const CONFIRM_MS = 20 * 60 * 60_000;
/** After a check that counted for nothing (an error, a timeout, a 429), this long before that term is asked again; doubled after each further one, up to RETRY_CHECK_MAX_MS. */
export const RETRY_CHECK_MS = 60 * 60_000;
export const RETRY_CHECK_MAX_MS = 24 * 60 * 60_000;
/** A suspect with nothing but unclear answers for this long is dropped (its links stay). */
export const GIVE_UP_MS = 14 * 24 * 60 * 60_000;
/** How often a confirmed term's entries are looked for again (links still there are queued again; none left: done). */
export const RESCAN_MS = 6 * 60 * 60_000;
/** `ranAt` is written this often; a run that finds it older than RESTART_MS starts over from the current index. */
const HEARTBEAT_MS = 24 * 60 * 60_000;
export const RESTART_MS = 48 * 60 * 60_000;
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
	/** Unclear answers (an error, 403, 429, a timeout) in a row since the last clear one, and when the first of them came. */
	unknowns?: number;
	unknownSince?: number;
}

export interface GoneTerm {
	qid: string;
	/** When it was confirmed gone (epoch ms). */
	since: number;
	/**
	 * Past the caps: it was under them, or a person approved it. It stays so until
	 * the term leaves the list (no entry links to it any more, its QID or slug is
	 * back, or a person keeps its links), so it's never held again meanwhile.
	 */
	approved?: true;
	/** When its entries were last looked for, and how many link to it. While approved: when they were last queued. */
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
	/** Confirmed gone, links not yet all removed. Dropped when no entry links to it any more, or when its QID or slug returns. */
	gone: Record<string, GoneTerm>;
	/** Waiting for a person: why, and which slugs. */
	held?: GoneHold;
	/** Links a person chose to keep (slug → QID): never removed until the term is back in the index. */
	keep?: Record<string, string>;
	/** When a scheduled run last worked on this (epoch ms; written about once a day). */
	ranAt?: number;
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
 * list, and it becomes `last`. "Back" is by QID (under any slug) or by slug
 * (under any QID: glossary.io gave the address to another term, so the links
 * work again). A person's "approve" or "keep" accepts a copy the shrink guard
 * refused. Pure: returns a new state.
 */
export function observeCopy(state: GoneState, copy: IndexCopy, now: number, decision?: "approve" | "keep"): { state: GoneState; lost: string[]; refused: boolean; newHold?: boolean } {
	const last = state.last;
	if (!last) return { state: { ...state, last: { fetchedAt: copy.fetchedAt, slugs: slugMap(copy.terms) } }, lost: [], refused: false };
	if (copy.fetchedAt <= last.fetchedAt) return { state, lost: [], refused: false };
	const qids = new Set(Object.keys(copy.terms));
	const slugs = slugMap(copy.terms);
	const back = (slug: string, qid: string) => qids.has(qid) || Object.hasOwn(slugs, slug);
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
		// A slug another term has now still leads to a definition: nothing to remove.
		if (Object.hasOwn(slugs, slug) || next.suspects[slug] || next.gone[slug] || next.keep?.[slug]) continue;
		if (decision === "keep") (next.keep ??= {})[slug] = qid;
		else next.suspects[slug] = { qid, since: now, firstCopyAt: copy.fetchedAt, checks: [] };
	}
	// Back in the index (the QID under any slug, or the slug under any QID): nothing to remove.
	for (const [slug, s] of Object.entries(next.suspects)) if (back(slug, s.qid)) delete next.suspects[slug];
	for (const [slug, g] of Object.entries(next.gone)) if (back(slug, g.qid)) delete next.gone[slug];
	for (const [slug, qid] of Object.entries(next.keep ?? {})) if (back(slug, qid)) delete next.keep![slug];
	next.last = { fetchedAt: copy.fetchedAt, slugs };
	return { state: next, lost, refused: false };
}

/** Two "gone" answers at least CONFIRM_MS apart. */
const checksDone = (s: GoneSuspect) => s.checks.length >= 2 && s.checks[s.checks.length - 1] - s.checks[0] >= CONFIRM_MS;

/** How long after a check a suspect isn't asked about again: an hour, doubled after each further unclear answer, up to a day. */
const retryWait = (s: GoneSuspect) => Math.min(RETRY_CHECK_MS * 2 ** Math.max(0, (s.unknowns ?? 0) - 1), RETRY_CHECK_MAX_MS);

/** Whether a suspect is asked about now: never asked, or a day after its first "gone" answer, and not right after a check (retryWait). */
export function checkDue(s: GoneSuspect, now: number): boolean {
	if (checksDone(s)) return false;
	if (s.triedAt !== undefined && now - s.triedAt < retryWait(s)) return false;
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
 * check and each D1 query for entries counts 1 against the run's subrequest
 * budget. `deadline` (epoch ms): no check starts when it couldn't finish
 * before it, and no look for entries starts after it.
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
		await docs.put(GONE_DOC, { ...(stored ?? { suspects: {}, gone: {} }), last: { fetchedAt: copy.fetchedAt, slugs: slugMap(copy.terms) }, ranAt: now, updated: iso(now) });
		return run;
	}
	if (stored.ranAt !== undefined && now - stored.ranAt > RESTART_MS) {
		// It hasn't run for more than two days (the part was off): it starts over from the current index, as on a first
		// run, so terms that went missing meanwhile are never removed. What it was already checking carries on.
		const restart = observeCopy({ ...stored, last: { fetchedAt: copy.fetchedAt - 1, slugs: slugMap(copy.terms) } }, copy, now).state;
		await docs.put(GONE_DOC, { ...restart, ranAt: now, updated: iso(now) });
		ctx.log.info("glossary.io links: checking for deleted terms starts over from the current glossary.io index (it hadn't run for more than two days)");
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
	const slugsNow = slugMap(copy.terms);
	for (const [slug, s] of Object.entries(state.suspects).sort(([, a], [, b]) => a.since - b.since)) {
		if (Object.hasOwn(copy.terms, s.qid) || Object.hasOwn(slugsNow, slug)) {
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
		} else if (answer === "gone") {
			s.checks = s.checks.length ? [s.checks[0], now] : [now];
			delete s.unknowns;
			delete s.unknownSince;
		} else {
			// No clear answer: asked again after an hour, then 2, 4… up to a day; given up after two weeks of them.
			s.unknowns = (s.unknowns ?? 0) + 1;
			s.unknownSince ??= now;
			if (now - s.unknownSince >= GIVE_UP_MS) {
				delete state.suspects[slug];
				ctx.log.warn("glossary.io links: glossary.io gave no clear answer about a term missing from its index for two weeks; it's no longer checked, and its links stay", { slug, qid: s.qid });
			}
		}
	}
	for (const [slug, s] of Object.entries(state.suspects)) {
		if (!isConfirmed(s, state.last!.fetchedAt)) continue;
		state.gone[slug] = { qid: s.qid, since: now };
		delete state.suspects[slug];
		run.confirmed.push(slug);
		ctx.log.info("glossary.io links: a glossary.io term is gone for good", { slug, qid: s.qid });
	}
	try {
		run.queued = await queueRemovals(ctx, options, state, budget, { collections: opts.collections, now, deadline: opts.deadline, db: opts.db });
	} catch (error) {
		// The checks above and what was already queued are kept; the entries are looked for again on a later run.
		ctx.log.warn("glossary.io links: couldn't look for entries that link to deleted terms", { error: String(error) });
	}
	await save();
	return run;

	async function save() {
		// `ranAt` is written about once a day, so a long gap (the part was off) can be told from a quiet day.
		const beat = state.ranAt === undefined || now - state.ranAt >= HEARTBEAT_MS;
		if (!beat && JSON.stringify(state) === before) return;
		if (beat) state.ranAt = now;
		state.updated = iso(now);
		await docs.put(GONE_DOC, state);
	}
}

/**
 * Queue the entries that link to confirmed terms (in place on `state`): their
 * memo's `unlink` gets the term, and `retryAt` and `unlinkAt` now. A term no
 * entry links to any more is done.
 *
 * Caps: the terms not yet past them (never approved) hold for a person when
 * there are more than MAX_GONE_TERMS of them, or when their entries together
 * are more than MAX_GONE_ENTRIES. A term past the caps (under them, or approved
 * by a person) stays past them until it leaves the list, so it's never held
 * again while its links are coming out.
 *
 * Bounded: at most MAX_SCANS terms are looked for per run (the rest on later
 * runs), each query counts 1 against the run's budget, and nothing starts
 * after `deadline`. What a run got done stays done when a later step fails.
 * Returns how many entries were queued.
 */
async function queueRemovals(
	ctx: PluginContext,
	options: AiOptions,
	state: GoneState,
	budget: { used: number; max: number },
	opts: { collections: string[]; now: number; deadline?: number; db?: D1Database | null },
): Promise<number> {
	const { now } = opts;
	const waits = (slug: string) => Boolean(state.gone[slug]) && !state.gone[slug].approved;
	// A hold whose terms are all done, kept or approved is over.
	if (state.held && state.held.why !== "index-shrank" && !state.held.slugs.some(waits)) delete state.held;
	if (!Object.keys(state.gone).length) return 0;

	const pending = Object.keys(state.gone).filter(waits).sort();
	const manyTerms = pending.length > MAX_GONE_TERMS;
	if (manyTerms) hold(ctx, state, { why: "many-terms", slugs: pending }, now);
	else if (state.held?.why === "many-terms") delete state.held;

	const stale = (slug: string) => state.gone[slug].scannedAt === undefined || now - state.gone[slug].scannedAt! >= RESCAN_MS;
	const skip = new Set((options.glossaryLinks?.skip ?? []).map((s) => s.trim()).filter(Boolean));
	const outOfTime = () => opts.deadline !== undefined && Date.now() >= opts.deadline;
	let db: D1Database | null | undefined;
	let fields: Array<[string, string]> | undefined;
	let scans = 0;
	/** The entries that link to a term, or null when this run can't look (its limits, or no database). */
	const scan = async (slug: string): Promise<string[] | null> => {
		if (scans >= MAX_SCANS || outOfTime()) return null;
		if (db === undefined) {
			db = opts.db !== undefined ? opts.db : await databaseFor();
			if (!db && !warnedNoDatabase) ctx.log.error("glossary.io links: removing links to deleted terms needs the site's D1 binding (DB).");
			if (!db) warnedNoDatabase = true;
		}
		if (!db) return null;
		fields ??= await textFields(ctx, opts.collections);
		if (budget.used + fields.length > budget.max) return null;
		scans++;
		return findEntries(db, fields, slug, skip, budget);
	};

	// The terms not yet past the caps: all of them are looked for before any is queued.
	const seen = new Map<string, string[]>();
	if (!manyTerms && pending.length) {
		let complete = true;
		for (const slug of pending) {
			if (!stale(slug)) continue;
			const keys = await scan(slug);
			if (!keys) {
				complete = false;
				break;
			}
			seen.set(slug, keys);
			state.gone[slug] = { ...state.gone[slug], scannedAt: now, entries: keys.length };
		}
		if (complete) {
			// Entries counted once when every term was looked for in this run; else each term's own count.
			const total = pending.every((s) => seen.has(s)) ? new Set(pending.flatMap((s) => seen.get(s)!)).size : pending.reduce((n, s) => n + (state.gone[s].entries ?? 0), 0);
			if (total > MAX_GONE_ENTRIES) hold(ctx, state, { why: "many-entries", slugs: pending, entries: total }, now);
			else {
				if (state.held?.why === "many-entries") delete state.held;
				for (const slug of pending) {
					const { scannedAt: _s, ...term } = state.gone[slug];
					state.gone[slug] = { ...term, approved: true };
				}
			}
		}
	}

	// The terms past the caps: the ones just looked for, then never looked for, then the longest since.
	const found = new Map<string, string[]>();
	for (const [slug, keys] of seen) if (state.gone[slug].approved) found.set(slug, keys);
	const order = (slug: string) => state.gone[slug].scannedAt ?? 0;
	const due = Object.keys(state.gone)
		.filter((s) => state.gone[s].approved && !found.has(s) && stale(s))
		.sort((a, b) => order(a) - order(b) || state.gone[a].since - state.gone[b].since || (a < b ? -1 : 1));
	let failed = false;
	let failure: unknown;
	for (const slug of due) {
		let keys: string[] | null;
		try {
			keys = await scan(slug);
		} catch (error) {
			// What this run found so far is still queued below; this term goes to the back of the line.
			state.gone[slug] = { ...state.gone[slug], scannedAt: now };
			failed = true;
			failure = error;
			break;
		}
		if (!keys) break;
		found.set(slug, keys);
	}

	const byEntry = new Map<string, Array<{ slug: string; qid: string }>>();
	for (const [slug, keys] of found) for (const key of keys) byEntry.set(key, [...(byEntry.get(key) ?? []), { slug, qid: state.gone[slug].qid }]);
	const memos = linkMemos(ctx);
	let queued = 0;
	let cut = false;
	for (const [key, list] of byEntry) {
		if (outOfTime()) {
			cut = true;
			break;
		}
		const colon = key.indexOf(":");
		// An entry with nothing remembered (a link a person made, say) gets a memo that counts as nothing remembered (pendingNew): once the
		// removal is done, a plain memo without a text hash would read as a text change, and the entry's next analysis would link it.
		const memo: LinkMemo = (await memos.get(key)) ?? { collection: key.slice(0, colon), entryId: key.slice(colon + 1), linked: [], pendingNew: true, updated: "" };
		const unlink = new Map((memo.unlink ?? []).map((u) => [u.slug, u]));
		const had = unlink.size;
		for (const u of list) unlink.set(u.slug, u);
		// Already waiting its turn with these terms.
		if (unlink.size === had && memo.retryAt !== undefined) continue;
		// A try that was already waiting (a site's request to link the entry again, or a link that had to wait) isn't
		// used up by the removal: `relink` has the links checked once the removal is done. `unlinkAt` marks this turn as the removal's own.
		const asked = memo.relink === true || (memo.retryAt !== undefined && memo.retryAt !== memo.unlinkAt);
		await memos.put(key, { ...memo, unlink: [...unlink.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1)), retryAt: now, unlinkAt: now, tries: 0, ...(asked ? { relink: true as const } : {}), updated: iso(now) });
		queued++;
	}
	// Out of time before every entry was queued: these terms are looked for again on the next run.
	if (!cut) {
		for (const [slug, keys] of found) {
			if (keys.length) {
				state.gone[slug] = { ...state.gone[slug], scannedAt: now, entries: keys.length };
				continue;
			}
			delete state.gone[slug];
			ctx.log.info("glossary.io links: no entry links to a deleted term any more", { slug });
		}
	}
	if (queued) ctx.log.info("glossary.io links: entries queued to remove links to deleted terms", { entries: queued, slugs: [...found.keys()] });
	if (failed) throw failure;
	return queued;
}

/** The Portable Text fields ([collection, field]) of the collections AI Enrichment works on. */
async function textFields(ctx: PluginContext, collections: string[]): Promise<Array<[string, string]>> {
	const out: Array<[string, string]> = [];
	for (const collection of collections) {
		if (!IDENT.test(collection)) continue;
		const info = await ctx.schema?.getCollection(collection);
		for (const f of info?.fields ?? []) if (f.type === "portableText" && IDENT.test(f.slug)) out.push([collection, f.slug]);
	}
	return out;
}

/**
 * Published entries (in the collections AI Enrichment works on) whose Portable
 * Text links to this slug ("<collection>:<id>", sorted): found in D1 (the
 * published columns, so links made by hand count too), then confirmed by
 * parsing the links (so /seo never matches /seo-audit). Entries on the
 * glossaryLinks skip list are left out. One query per field, each counted
 * against the run's budget.
 */
async function findEntries(db: D1Database, fields: Array<[string, string]>, slug: string, skip: ReadonlySet<string>, budget: { used: number }): Promise<string[]> {
	const found = new Set<string>();
	if (!SLUG.test(slug)) return [];
	const base = `glossary.io/${slug}`;
	for (const [collection, field] of fields) {
		budget.used++;
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
			if (glossarySlugsIn(value).has(slug)) found.add(`${collection}:${row.id}`);
		}
	}
	return [...found].sort();
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
				let count = 0;
				for (const s of asked) {
					if (!next.gone[s]) continue;
					// Approved until the term leaves the list; its entries are looked for on the next runs.
					const { scannedAt: _s, ...term } = next.gone[s];
					next.gone[s] = { ...term, approved: true };
					count++;
				}
				message = `Links to ${count} deleted terms are removed over the next scheduled runs.`;
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

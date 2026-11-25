/**
 * glossary.io links (AI Enrichment part "ai.glossaryLinks", off by default).
 *
 * After an entry's entities are analyzed (a first analysis, or one after its
 * text changed), each entity that has a glossary.io definition gets one link
 * to it in the entry's body, and the change is published. The rules are in
 * src/ai/glossary-links.ts: an existing identity link to the entity (its home
 * page, Wikipedia article, profile…) is switched, or its first plain mention
 * is linked; internal and affiliate links never change.
 *
 * What it remembers, per entry, in its own storage collection (aiLinks, so a
 * failed analysis, a trash and restore, or a description change never erases
 * it): the QIDs it handled (never linked again, so a link removed by hand
 * stays removed), the text hash it last saw (settings changes that re-analyze
 * unchanged text never link), a marker for an edit in progress, links to take
 * out (terms deleted from glossary.io), and when to try again.
 *
 * Safety (publishOwnEdit, shared by linking and unlinking):
 * - Only published entries with no pending draft, and none saved in the last
 *   two minutes (someone may be editing it). Those are tried again later.
 * - The entry is read again right before the write and left alone if anyone
 *   saved it in between. Only the draft this edit created is published; if a
 *   save lands in between anyway, nothing is published, the entry is reported
 *   ("collided") and logged as an error for a person to check (its earlier
 *   revision has the other save).
 * - An edit whose publish didn't happen (an error, a timeout) leaves a marker,
 *   and the next run publishes that draft instead of leaving it pending
 *   forever. It's recognized by its draft id, or by its version together with
 *   its text (unchanged) and links (all of the edit's, or for a removal none
 *   of the removed ones); never by version alone.
 *
 * keepDates (coywolfPlugin({ ai: { glossaryLinks: { keepDates: true } } }),
 * since 0.50.0): right after this part publishes its own edit, the entry's
 * updated date is put back (src/ai/keep-date.ts) and its cached page cleared.
 *
 * Links to deleted terms (part "ai.glossaryLinksRemoveGone", since 0.50.0):
 * src/ai/glossary-gone.ts decides which terms are gone for good and queues the
 * entries that link to them; unlinkEntry takes those links out and keeps their
 * text, and forgets the term's QID so it can be linked again if it comes back.
 * A removal never links anything by itself: the Pack links an entry after an
 * analysis of new text, on a retry of that, or when a site asks (retryAt).
 *
 * Possessives (since 0.51.0): every linkEntry run also moves the possessive
 * right after any glossary.io link in the entry inside it ("[Google]'s" becomes
 * "[Google's]"; src/ai/glossary-links.ts linkPossessives), with the same safety.
 * Such a fix isn't a link to a term (memo.linked is unchanged by it); an entry
 * whose only changes are fixes like that ends "linked" too. A possessives-only
 * run (LinkOptions.only) makes only those fixes: it never links or switches,
 * remembers nothing as linked, and schedules no retry.
 *
 * "Link existing entries" (POST ai/glossary-links) runs the same code on
 * entries analyzed before the part was turned on, with a dry run.
 *
 * The editor's AI Enrich button (since 0.52.0; src/ai/editor-enrich.ts) plans
 * links by the same rules (planEntryLinks) into the editor's unsaved draft,
 * for a person to review. What it proposed waits in memo.planned, never as
 * linked, until the entry's publish settles it (settlePlanned).
 */
import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import { isConflict } from "../core/conflict.js";
import { databaseFor } from "../core/database.js";
import { ctxFeatures } from "../core/features.js";
import { purgeEntryPages } from "../pageCache/entries.js";
import { afterResponse } from "../shared.js";
import { glossaryFor, isGlossarySite, storedGlossary } from "./glossary.js";
import { readGoneState, removeGoneOn } from "./glossary-gone.js";
import {
	type GlossaryTarget,
	type LinkChange,
	type LinkEntity,
	type PossessiveChange,
	type PossessiveFix,
	type TermLinkChange,
	bodyText,
	glossarySlug,
	glossarySlugsIn,
	linkHrefsIn,
	linkPossessives,
	linkedGlossarySlugs,
	planGlossaryLinks,
	removeGlossaryLinks,
	withoutLinks,
} from "./glossary-links.js";
import { type PublishedRow, restoreUpdatedAt } from "./keep-date.js";
// Types only (store.ts loads the providers, which the tests can't run): the collection lookups are repeated here.
import type { AiOptions, EntryRecord } from "./store.js";

export type LinkStatus =
	/** Linked and published (or, for a collection without revisions, saved); also when the only changes were possessives moved inside glossary.io links. */
	| "linked"
	/** Links to deleted glossary.io terms taken out and published. */
	| "unlinked"
	/** Nothing to link (or a dry run found nothing). */
	| "unchanged"
	/** A dry run: these links would be made. */
	| "planned"
	/** Unpublished changes of someone else's, or saved in the last two minutes: tried again later. */
	| "draft"
	| "busy"
	/** Saved by someone between the read and the write: tried again later. */
	| "conflict"
	/** The edit is in a draft but couldn't be published because someone saved meanwhile: tried again later. */
	| "staged"
	/** A save landed between this edit's read and its write: nothing published; check the entry's revisions. */
	| "collided"
	/** Not linked at all (not published, not analyzed, on the skip list, or on glossary.io). */
	| "skipped"
	/** The site has no copy of glossary.io's index yet (it's fetched on the next page render): tried again later. */
	| "no-index";

/** A deleted term's links taken out of one entry. */
export interface UnlinkChange {
	slug: string;
	qid: string;
	/** Links removed (one term can be linked more than once, by hand). */
	removed: number;
}

export interface LinkOutcome {
	key: string;
	slug: string | null;
	status: LinkStatus;
	changes: Array<LinkChange | UnlinkChange>;
	reason?: string;
	/** keepDates: whether the entry's updated date was put back after this edit's publish (only when keepDates is on and something was published). */
	dateKept?: boolean;
}

/** What glossary links remember about one entry (storage collection aiLinks, id "<collection>:<id>"). */
export interface LinkMemo {
	collection: string;
	entryId: string;
	/** QIDs handled in this entry (linked, found linked, or excluded): never linked again. */
	linked: string[];
	/** The entry's text hash when it was last linked or checked (EntryText.textHash). */
	textHash?: string;
	/** An edit in progress: the version it was based on (its draft is version + 1). Cleared once published. */
	pending?: number;
	/** That edit's draft revision, once known. */
	draft?: string;
	/** That edit's QIDs and glossary slugs, so its draft can be recognized (and remembered) if its publish never happened. */
	pendingQids?: string[];
	pendingSlugs?: string[];
	/** That edit's possessives moved inside glossary.io links (how many), so its draft can be recognized too. */
	pendingPossessive?: number;
	/**
	 * Nothing was remembered about this entry when this memo was made, by a possessives-only run's edit or by a
	 * removal's queue, and no text has been recorded with it since: until an analysis or a normal run records the
	 * text (and takes this off), the memo counts as nothing remembered (onlyMarker), so its missing text hash never
	 * reads as a text change. It outlives the edit's marker (settled keeps it): a possessives-only run deletes such
	 * a memo once nothing else is in it.
	 */
	pendingNew?: true;
	/** A removal in progress: the glossary slugs it takes out (instead of pendingQids and pendingSlugs). */
	pendingUnlink?: string[];
	/** keepDates: the entry's updated date before the edit in progress, put back once it's published. */
	keepUpdatedAt?: string;
	/** Links to take out: terms deleted from glossary.io (src/ai/glossary-gone.ts). */
	unlink?: Array<{ slug: string; qid: string }>;
	/** The `retryAt` the removal's queue (or a removal that has to wait) wrote: a turn that's the removal's own, not a request to link. */
	unlinkAt?: number;
	/** A try to link was waiting when the removal was queued: once the links are out, the entry's links are checked (LINK_CHECK_MS). */
	relink?: true;
	/** When to try again (epoch ms), and the tries so far. A site asks for an entry to be linked again by setting retryAt (and tries: 0). */
	retryAt?: number;
	tries?: number;
	/**
	 * Links the editor's AI Enrich button proposed (src/ai/editor-enrich.ts), until the entry's next publish by a
	 * person settles them (settlePlanned). Never counted as linked before that: the proposal may not be applied.
	 * `qids`: the entities it linked or found linked; `slugs`: the links it added; `at`: when. Ignored after
	 * PLANNED_MS (livePlanned), and dropped when this part publishes its own links (a later publish would find
	 * those and take the proposal for applied).
	 */
	planned?: { qids: string[]; slugs: string[]; at: number };
	updated: string;
}

export interface LinkOptions {
	/** Plan only: nothing is written. */
	dryRun?: boolean;
	/** QIDs never to link in this entry (remembered with the ones linked). */
	exclude?: string[];
	/** The entry's analysis, when the caller just wrote it. */
	record?: EntryRecord;
	/** The entry's current text hash, to remember (omit when the analysis isn't of the current text). */
	textHash?: string;
	/**
	 * A person's run whose `textHash` is withheld because a re-analysis is queued: a memo that counts as nothing
	 * remembered (`pendingNew`) becomes an ordinary one anyway, so that analysis still links. Without this or a
	 * `textHash` (a retry), such a memo keeps counting as nothing remembered.
	 */
	forgetNew?: true;
	/**
	 * "possessive": only move possessives inside the entry's glossary.io links.
	 * Nothing is linked or switched, `exclude` and `textHash` are ignored, what's
	 * remembered as linked stays as it is, and no retry is scheduled (one already
	 * waiting stays): an entry that has to wait (draft, busy, conflict, staged)
	 * is fixed by running it again. The entry has to be analyzed (an "ok"
	 * analysis), like for a normal run: publishing an entry without one queues
	 * its first analysis, and a first analysis links.
	 */
	only?: "possessive";
}

/** For the logs: how many of an outcome's changes are links to terms (`links`: made, switched or removed) and, when there are any, how many are possessives moved inside a link (`possessives`). */
export function changeCounts(changes: ReadonlyArray<LinkChange | UnlinkChange>): { links: number; possessives?: number } {
	const possessives = changes.filter((c) => "action" in c && c.action === "possessive").length;
	return { links: changes.length - possessives, ...(possessives ? { possessives } : {}) };
}

/** The possessive fix linkEntry runs (tests replace it). */
export const possessivesIo = { fix: (content: unknown) => linkPossessives(content) };

/** Saved this recently: someone may still be editing. */
export const BUSY_MS = 2 * 60_000;
/** Tries after a draft, conflict, staged edit, missing index or error: 30 min, 1 h, 2 h… then it waits for the next text change. */
export const MAX_TRIES = 6;
const RETRY_BASE_MS = 30 * 60_000;
/**
 * After links to deleted terms are taken out (or turn out to be gone already), an entry that also had a try to
 * link waiting (linkAsked) is checked for new links this long after: just past the busy window its own publish
 * opened. The retry pass is also how a site asks for an entry to be linked again (by setting retryAt), and a
 * removal mustn't use that ask up. Without such a try, a removal is never followed by linking.
 */
export const LINK_CHECK_MS = BUSY_MS + 60_000;

/**
 * Whether a try to link this entry is waiting, besides any removal: its `retryAt` isn't the one the removal's
 * queue wrote (`unlinkAt`), so a site set it or a link had to wait, or such a try was waiting when the removal
 * was queued (`relink`).
 */
export const linkAsked = (memo: Pick<LinkMemo, "retryAt" | "unlinkAt" | "relink">): boolean => memo.relink === true || (memo.retryAt !== undefined && memo.retryAt !== memo.unlinkAt);

/** The memo after a link pass that isn't tried again: a waiting try to link (`relink`, `unlinkAt`) has been served. Unchanged when there's none. */
function linkServed(memo: LinkMemo): LinkMemo {
	if (memo.retryAt !== undefined || (memo.relink === undefined && memo.unlinkAt === undefined)) return memo;
	const { relink: _l, unlinkAt: _a, ...rest } = memo;
	return rest;
}

const entryKey = (collection: string, id: string) => `${collection}:${id}`;
const store = <T>(ctx: Pick<PluginContext, "storage">, name: string) => (ctx.storage as Record<string, StorageCollection>)[name] as StorageCollection<T>;
export const linkMemos = (ctx: Pick<PluginContext, "storage">) => store<LinkMemo>(ctx, "aiLinks");

/** How long after keepDates put a date back the entry's cached pages are cleared a second time. */
export const REPURGE_MS = 20_000;

/** The database, page purge and "a little later" keepDates uses (tests replace them). */
export const keepDatesIo = {
	database: (): Promise<D1Database | null> => databaseFor(),
	purge: purgeEntryPages,
	/** Run once more after REPURGE_MS, kept alive past the response (or the scheduled run). Never throws. */
	later: (run: () => Promise<void>): void => afterResponse(new Promise<void>((resolve) => setTimeout(resolve, REPURGE_MS)).then(run).catch(() => undefined)),
};

/** The hosts and entries the rules need, from coywolfPlugin({ ai: { glossaryLinks } }) and the site's own URL. */
export function linkConfig(options: AiOptions, siteUrl?: string | null): { siteHosts: string[]; shortHosts: string[]; skip: Set<string> } {
	const cfg = options.glossaryLinks ?? {};
	let host = "";
	try {
		host = siteUrl ? new URL(siteUrl).hostname : "";
	} catch {
		/* no site URL */
	}
	return {
		siteHosts: [...(host ? [host] : []), ...(cfg.ownHosts ?? [])],
		shortHosts: [...(cfg.shortHosts ?? [])],
		skip: new Set((cfg.skip ?? []).map((s) => s.trim()).filter(Boolean)),
	};
}

/**
 * Whether a finished analysis should link: when the text changed since the
 * links last looked at it, or (nothing remembered yet) when the entry was never
 * analyzed successfully before. An entry analyzed before the part was turned
 * on has nothing remembered: its next analysis only records its text (a text
 * change and a settings re-analysis look the same), so it's linked by Link
 * existing entries or by the text change after that. A memo made for an entry
 * with nothing remembered by a possessives-only run's edit (there when that
 * edit failed or its Worker died) or by a removal's queue (pendingNew) is
 * nothing remembered too: it has no text hash, and must never read as a text
 * change.
 */
export function shouldLink(memo: Pick<LinkMemo, "textHash" | "pendingNew"> | null | undefined, previous: { status: string; title: string; entities?: readonly unknown[] } | null | undefined, textHash: string): boolean {
	if (memo && !onlyMarker(memo)) return memo.textHash !== textHash;
	return !previous || (previous.status !== "ok" && !previous.title && !previous.entities?.length);
}

/** Whether a memo was made for an entry with nothing remembered (by a possessives-only run's edit, or a removal's queue) and no text was ever recorded with it: nothing remembered still. */
export const onlyMarker = (memo: Pick<LinkMemo, "textHash" | "pendingNew">): boolean => memo.pendingNew === true && memo.textHash === undefined;

/** The memo as a normal run or an analysis records it: what it remembers from now on is the entry's own, not a possessives-only run's to forget. */
export function withoutPendingNew(memo: LinkMemo): LinkMemo {
	const { pendingNew: _n, ...rest } = memo;
	return rest;
}

/** How long AI Enrich's planned links wait for the entry's publish: as long as its staged analysis is kept (pruneDrafts in src/ai/store.ts). */
export const PLANNED_MS = 30 * 86_400_000;

/** A memo's planned links while they still count (PLANNED_MS); null otherwise. */
export function livePlanned(memo: Pick<LinkMemo, "planned"> | null | undefined, now = Date.now()): NonNullable<LinkMemo["planned"]> | null {
	const planned = memo?.planned;
	return planned && now - planned.at < PLANNED_MS ? planned : null;
}

/** The memo without AI Enrich's planned links. */
export function withoutPlanned(memo: LinkMemo): LinkMemo {
	const { planned: _p, ...rest } = memo;
	return rest;
}

/**
 * Whether AI Enrich's proposal was applied to this text: it has any of the links the proposal added, or the proposal
 * added none. So a planned link that's missing was taken out by hand, and stays out.
 */
export const plannedApplied = (planned: NonNullable<LinkMemo["planned"]>, slugs: ReadonlySet<string>): boolean => !planned.slugs.length || planned.slugs.some((slug) => slugs.has(slug));

/**
 * This part's own publishes (a link edit, a removal, a possessive fix), by entry, for a little while: EmDash runs
 * the content hooks for them too (in this isolate, after the write), and those must not take one for a person's
 * publish (src/ai/pack.ts: nothing AI Enrich staged or planned is settled by it). `rev`: the draft revision the
 * publish makes live; null when the collection has no revisions.
 */
const OWN_PUBLISH_MS = 60_000;
const ownPublishes = new Map<string, { rev: string | null; until: number }>();

export function markOwnPublish(key: string, rev: string | null, now = Date.now()): void {
	for (const [k, v] of ownPublishes) if (v.until <= now) ownPublishes.delete(k);
	ownPublishes.set(key, { rev, until: now + OWN_PUBLISH_MS });
}

/** Whether the publish a content hook reports (the entry's live revision now) is this part's own. */
export function isOwnPublish(key: string, liveRevisionId: unknown, now = Date.now()): boolean {
	const own = ownPublishes.get(key);
	if (!own || own.until <= now) return false;
	return own.rev === null || own.rev === liveRevisionId;
}

/**
 * The memo after a person's publish of an entry AI Enrich planned links for (memo.planned). When the proposal was
 * applied (plannedApplied), its QIDs count as handled, so a planned link taken out by hand before the publish stays
 * out. Otherwise only `planned` goes. `check` (the entry's analysis is of the published text): the text hash is
 * recorded and the links are checked once by the retry pass (LINK_CHECK_MS), which links only what's missing,
 * without a model call.
 */
export function settlePlanned(memo: LinkMemo, publishedSlugs: ReadonlySet<string>, check: { textHash: string; now: number } | null): LinkMemo {
	const { planned, ...rest } = memo;
	if (!planned) return memo;
	const applied = plannedApplied(planned, publishedSlugs);
	const linked = applied ? [...new Set([...rest.linked, ...planned.qids])].sort() : rest.linked;
	if (!check) return { ...rest, linked };
	return { ...withoutPendingNew({ ...rest, linked }), textHash: check.textHash, retryAt: check.now + LINK_CHECK_MS, tries: 0 };
}

const versionOf = (item: { version?: number; updatedAt?: string; draftRevisionId?: string | null }) =>
	`${item.version ?? ""}|${item.updatedAt ?? ""}|${item.draftRevisionId ?? ""}`;

const pendingDraft = (item: { draftRevisionId?: string | null; liveRevisionId?: string | null }) =>
	Boolean(item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId);

const RETRYABLE: ReadonlySet<LinkStatus> = new Set(["draft", "busy", "conflict", "staged", "no-index"]);

/** The memo after an outcome: retryable ones are scheduled (with backoff), others clear the schedule. */
export function withRetry(memo: LinkMemo, status: LinkStatus | "error", now = Date.now()): LinkMemo {
	const { retryAt: _r, tries: _t, ...rest } = memo;
	if (status !== "error" && !RETRYABLE.has(status)) return rest;
	const tries = (memo.tries ?? 0) + 1;
	if (tries > MAX_TRIES) return rest;
	return { ...rest, tries, retryAt: now + RETRY_BASE_MS * 2 ** (tries - 1) };
}

/**
 * The memo after a retry pass's turn threw: tried again later, like any error. With links still to take out, the
 * next turn stays the removal's own (`unlinkAt` follows the new `retryAt`), as it does when a removal has to wait:
 * otherwise the new `retryAt` would read as a request to link (linkAsked) that nobody made, and the entry would be
 * linked once the removal went through, or at once while removals are off or paused. A try to link that really
 * was waiting is remembered (`relink`).
 */
export function afterError(memo: LinkMemo, now = Date.now()): LinkMemo {
	const next = withRetry(memo, "error", now);
	if (!memo.unlink?.length) return next;
	const asked = linkAsked(memo);
	const { unlinkAt: _a, relink: _l, ...rest } = next;
	return { ...rest, ...(rest.retryAt === undefined ? {} : { unlinkAt: rest.retryAt }), ...(asked ? { relink: true as const } : {}) };
}

/**
 * The memo without an edit in progress. `pendingNew` stays: a memo without a text hash that lost it would make the
 * entry's next analysis link (shouldLink). Only recording the text, a person's run (forgetNew) or a normal run's own edit while it runs takes it off (withoutPendingNew).
 */
const settled = (memo: LinkMemo): LinkMemo => {
	const { pending: _p, draft: _d, pendingQids: _q, pendingSlugs: _s, pendingPossessive: _o, pendingUnlink: _u, keepUpdatedAt: _k, ...rest } = memo;
	return rest as LinkMemo;
};

/** A new entry's memo, for a run that must leave nothing remembered about it (a possessives-only run, a removal). */
export const unseenMemo = (collection: string, entryId: string): LinkMemo => ({ collection, entryId, linked: [], pendingNew: true, updated: "" });

/** Only the fields of an edit in progress (what `settled` takes off). */
function markerOf(memo: LinkMemo): Partial<LinkMemo> {
	const { pending, draft, pendingQids, pendingSlugs, pendingPossessive, pendingUnlink, keepUpdatedAt } = memo;
	return Object.fromEntries(Object.entries({ pending, draft, pendingQids, pendingSlugs, pendingPossessive, pendingUnlink, keepUpdatedAt }).filter(([, v]) => v !== undefined)) as Partial<LinkMemo>;
}

/**
 * What a possessives-only run may store: the memo as it's stored right now (read again, so a run that outlived its
 * lock can't put back an older text hash, list of linked terms or retry), with only the fields of the edit in
 * progress from the run's own copy. With nothing stored, a memo that counts as nothing remembered (unseenMemo).
 */
const onlyMerge = (stored: LinkMemo | null, mine: LinkMemo): LinkMemo => ({ ...settled(stored ?? unseenMemo(mine.collection, mine.entryId)), ...markerOf(mine) });

/** Whether two memos are the same, their `updated` time aside. */
const sameMemo = (a: LinkMemo, b: LinkMemo): boolean => stable({ ...a, updated: "" }) === stable({ ...b, updated: "" });

/** Whether a memo holds nothing at all: made for an entry with nothing remembered, and no text, edit in progress, handled term, removal or retry in it. As good as no memo. */
const emptyMemo = (memo: LinkMemo): boolean =>
	onlyMarker(memo) && !Object.keys(markerOf(memo)).length && !memo.linked.length && !memo.unlink?.length && memo.retryAt === undefined && memo.unlinkAt === undefined && memo.relink === undefined;

/** The memo once its edit in progress is live: what a link edit linked is remembered; a removal's terms are forgotten and leave `unlink`. */
function finished(memo: LinkMemo): LinkMemo {
	if (!memo.pendingUnlink?.length) return { ...settled(memo), linked: [...new Set([...memo.linked, ...(memo.pendingQids ?? [])])].sort() };
	const slugs = new Set(memo.pendingUnlink);
	const qids = new Set((memo.unlink ?? []).filter((u) => slugs.has(u.slug)).map((u) => u.qid));
	return withUnlink({ ...settled(memo), linked: memo.linked.filter((q) => !qids.has(q)) }, (memo.unlink ?? []).filter((u) => !slugs.has(u.slug)));
}

/**
 * A marker whose draft isn't pending: dropped. A removal whose draft is the
 * live revision was published (its result never recorded), so it's recorded
 * now; a link edit's links are found in the text anyway.
 */
const staleMarker = (memo: LinkMemo, item: { liveRevisionId?: string | null }): LinkMemo =>
	memo.pendingUnlink?.length && memo.draft && memo.draft === item.liveRevisionId ? finished(memo) : settled(memo);

/** The memo with these links still to take out (none: no `unlink` at all). */
function withUnlink(memo: LinkMemo, unlink: Array<{ slug: string; qid: string }>): LinkMemo {
	const { unlink: _u, ...rest } = memo;
	return unlink.length ? { ...rest, unlink } : rest;
}

/** One entry's memo while an edit runs: `save` stores it (except in a dry run) and keeps `memo` current. */
interface MemoState {
	memo: LinkMemo;
	save(next: LinkMemo): Promise<void>;
}

/**
 * `markersOnly` (a possessives-only run): a save writes only the edit in progress over what's stored at that moment
 * (onlyMerge), and nothing when that changes nothing.
 */
function memoState(memos: StorageCollection<LinkMemo>, key: string, initial: LinkMemo, dryRun: boolean, markersOnly = false): MemoState {
	const state: MemoState = {
		memo: initial,
		async save(next) {
			const updated = new Date().toISOString();
			if (!markersOnly || dryRun) {
				state.memo = { ...next, updated };
				if (!dryRun) await memos.put(key, state.memo);
				return;
			}
			const stored = await memos.get(key);
			const merged = onlyMerge(stored, next);
			if (stored && sameMemo(stored, merged)) {
				state.memo = stored;
				return;
			}
			state.memo = { ...merged, updated };
			await memos.put(key, state.memo);
		},
	};
	return state;
}

type Item = NonNullable<Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>>;

/** The reason given when a run publishes the draft of an earlier run's edit. */
const FINISHED = "published the draft an earlier run saved";

const keepDatesOn = (options: AiOptions) => options.glossaryLinks?.keepDates === true;
let warnedNoDatabase = false;

/**
 * keepDates: after this part's own write, put the entry's updated date back,
 * then clear its cached pages (now, and once more a little later: a page
 * rendered in between may have been cached with the new date). `row` is the
 * row that write left, as EmDash returned it (never read again, so a save
 * that lands after the write can't be mistaken for it): src/ai/keep-date.ts
 * changes only that exact row. Never throws: the edit is published either way.
 */
async function keepDate(ctx: PluginContext, entry: { collection: string; id: string; slug: string | null }, original: string | undefined, row: PublishedRow | null): Promise<boolean> {
	try {
		if (!original || !row || row.updatedAt === original) return false;
		const db = await keepDatesIo.database();
		if (!db) {
			if (!warnedNoDatabase) ctx.log.error("glossary.io links: keepDates needs the site's D1 binding (DB); updated dates move until it's there.");
			warnedNoDatabase = true;
			return false;
		}
		const kept = await restoreUpdatedAt(db, entry.collection, entry.id, original, row);
		if (kept) {
			const purge = () => keepDatesIo.purge(ctx, [{ collection: entry.collection, id: entry.id, slug: entry.slug }], { label: "glossary.io links", tags: true });
			await purge();
			keepDatesIo.later(purge);
		}
		return kept;
	} catch (error) {
		ctx.log.warn("glossary.io links: couldn't keep the updated date", { entry: entryKey(entry.collection, entry.id), error: String(error) });
		return false;
	}
}

/**
 * The row a publish of this part's own draft left, from what EmDash's publish
 * returned ({ item, _rev }, the row as its transaction wrote it): published,
 * that draft live, no draft pending, exactly one version after the draft.
 * Null when it's anything else, so the date is left alone.
 */
function publishedRow(published: unknown, draftVersion: number | undefined, draft: string | null | undefined): PublishedRow | null {
	const item = (published as { item?: Partial<Item> } | null | undefined)?.item;
	if (!item || !draft || item.status !== "published" || pendingDraft(item)) return null;
	if (item.liveRevisionId !== draft || typeof item.updatedAt !== "string" || !Number.isInteger(item.version) || item.version !== (draftVersion ?? Number.NaN) + 1) return null;
	return { updatedAt: item.updatedAt, version: item.version!, liveRevisionId: draft };
}

/**
 * Whether these removals still stand, from the site's stored index copy (not
 * this isolate's memory of it) and the deleted-term record: confirmed gone
 * under that QID, and neither the QID nor the slug in the index (a slug another
 * term has now leads to a definition again). Null when the site has no index
 * copy. `held`: removals are paused (a refused index copy waits for a person).
 */
async function goneCheck(ctx: PluginContext): Promise<{ held: boolean; stands(u: { slug: string; qid: string }): boolean } | null> {
	const copy = await storedGlossary(ctx);
	if (!copy) return null;
	const state = await readGoneState(ctx);
	const slugs = new Set(Object.values(copy.terms).map((term) => term[0]));
	const confirmed = state?.gone ?? {};
	return {
		held: state?.held?.why === "index-shrank",
		stands: (u) => confirmed[u.slug]?.qid === u.qid && !Object.hasOwn(copy.terms, u.qid) && !slugs.has(u.slug),
	};
}

/**
 * Whether an unpublished removal draft of this part's own may still go live:
 * "yes" when the part is on and every term it took out is still confirmed
 * gone (goneCheck); "no" when the part is off or a term isn't; "wait" when it
 * can't be told now (no index copy, or removals are paused).
 */
async function removalStands(ctx: PluginContext, memo: LinkMemo): Promise<"yes" | "no" | "wait"> {
	if (!removeGoneOn(await ctxFeatures(ctx))) return "no";
	const check = await goneCheck(ctx);
	if (!check || check.held) return "wait";
	const queued = new Map((memo.unlink ?? []).map((u) => [u.slug, u]));
	return (memo.pendingUnlink ?? []).every((slug) => queued.has(slug) && check.stands(queued.get(slug)!)) ? "yes" : "no";
}

/**
 * Before an edit: the entry's pending draft, or a save in the last two
 * minutes, means wait (null: go ahead). A pending draft that is this part's
 * own unpublished edit (a link edit or a removal) is published instead, and
 * what it did is recorded. A removal's draft is published only while the
 * removal still stands (removalStands); when it doesn't, its marker is dropped
 * and the draft is left for a person, never published and never changed.
 */
async function waitOrFinish(
	ctx: PluginContext,
	options: AiOptions,
	st: MemoState,
	at: { collection: string; id: string; item: Item; fields: string[]; now: number; dryRun?: boolean },
): Promise<{ status: LinkStatus; reason?: string; dateKept?: boolean } | null> {
	const { collection, id, item } = at;
	const content = ctx.content!;
	if (pendingDraft(item)) {
		// This part's own edit whose publish didn't happen goes live now; anyone else's draft is left alone.
		if (!at.dryRun && (await ownDraft(ctx, collection, item, st.memo, at.fields))) {
			const removal = Boolean(st.memo.pendingUnlink?.length);
			const stands = removal ? await removalStands(ctx, st.memo) : "yes";
			// Can't be told now: the marker stays, and it's looked at again on a later try.
			if (stands === "wait") return { status: "draft" };
			if (stands === "no") {
				ctx.log.warn("glossary.io links: an unpublished removal of links to a glossary.io term is no longer wanted (the part is off, or the term is back); its draft is left for a person to publish or discard", {
					entry: entryKey(collection, id),
					slug: item.slug,
					slugs: st.memo.pendingUnlink,
				});
				st.memo = settled(st.memo);
				return { status: "draft" };
			}
			const versioned = await content.getVersioned!(collection, id);
			if (versioned && versioned.item.draftRevisionId === item.draftRevisionId) {
				let published: unknown;
				markOwnPublish(entryKey(collection, id), item.draftRevisionId ?? null);
				try {
					published = await content.publish!(collection, id, { _rev: versioned._rev });
				} catch (error) {
					if (!isConflict(error)) throw error;
					return { status: "conflict" };
				}
				const original = st.memo.keepUpdatedAt;
				st.memo = finished(st.memo);
				const dateKept = keepDatesOn(options) ? await keepDate(ctx, { collection, id, slug: item.slug }, original, publishedRow(published, versioned.item.version, item.draftRevisionId)) : undefined;
				return { status: removal ? "unlinked" : "linked", reason: FINISHED, dateKept };
			}
		}
		// A marker that doesn't match this draft is stale: the draft is someone else's.
		if (st.memo.pending !== undefined || st.memo.draft) st.memo = staleMarker(st.memo, item);
		return { status: "draft" };
	}
	// No pending draft: any marker left from an earlier edit is stale (its draft was published or discarded).
	if (st.memo.pending !== undefined || st.memo.draft) st.memo = staleMarker(st.memo, item);
	const savedAt = Date.parse(item.updatedAt);
	if (Number.isFinite(savedAt) && at.now - savedAt < BUSY_MS) return { status: "busy" };
	return null;
}

/**
 * Write and publish this part's own edit of an entry (after waitOrFinish said
 * go ahead): read it again, save the marker, update, and publish only the
 * draft exactly one version after the one read. With keepDates, the entry's
 * updated date is put back afterwards. "done": published (or, without
 * revisions, saved); st.memo is settled, and the caller records what changed.
 */
async function publishOwnEdit(
	ctx: PluginContext,
	options: AiOptions,
	st: MemoState,
	edit: { collection: string; id: string; item: Item; info: CollectionSchemaInfo; patch: Record<string, unknown>; marker: Partial<LinkMemo>; collided: string; ordinary?: boolean; restoreNew?: boolean },
): Promise<{ status: "done" | "conflict" | "collided" | "staged"; dateKept?: boolean }> {
	const { collection, id, item } = edit;
	const content = ctx.content!;
	const keep = keepDatesOn(options);
	const entry = { collection, id, slug: item.slug };
	// A normal run's edit (`ordinary`) is never a memo that counts as nothing remembered: with `pendingNew`, its marker (left when the
	// publish fails or the Worker dies) would read as nothing remembered, and the next analysis wouldn't finish its draft.
	if (edit.ordinary) st.memo = withoutPendingNew(st.memo);
	// Re-read right before writing: if anyone saved in between, leave the entry alone.
	const fresh = await content.get(collection, id);
	if (!fresh || versionOf(fresh) !== versionOf(item)) return { status: "conflict" };
	// The marker goes in first, so an edit whose publish never happens is recognized (and published) next time.
	await st.save({ ...st.memo, pending: fresh.version ?? 0, ...edit.marker, ...(keep ? { keepUpdatedAt: fresh.updatedAt } : {}) });
	// Without revisions the update is the publish (its save hook sees a published entry).
	if (!edit.info.supports.includes("revisions")) markOwnPublish(entryKey(collection, id), null);
	let updated: unknown;
	try {
		updated = await content.update!(collection, id, edit.patch);
	} catch (error) {
		// Nothing was written: drop the marker so it can't be mistaken for a later draft. A memo that counted as nothing remembered when
		// the run started, in a run that records no text (`restoreNew`: a retry), counts as nothing remembered again: `ordinary` took the
		// flag off for the marker, and a memo left without the flag and without a text hash would make the entry's next analysis link.
		const after = await content.get(collection, id).catch(() => null);
		if (after && versionOf(after) === versionOf(fresh)) {
			st.memo = settled(edit.restoreNew ? { ...st.memo, pendingNew: true } : st.memo);
			await st.save(st.memo);
		}
		throw error;
	}
	if (!edit.info.supports.includes("revisions")) {
		st.memo = settled(st.memo);
		if (!keep) return { status: "done" };
		// Without revisions the update is the whole edit: the row it left has the date the update returned, one version on.
		const savedAt = (updated as { updatedAt?: unknown } | null | undefined)?.updatedAt;
		const row = typeof savedAt === "string" && Number.isInteger(fresh.version) ? { updatedAt: savedAt, version: fresh.version! + 1, liveRevisionId: null } : null;
		return { status: "done", dateKept: await keepDate(ctx, entry, fresh.updatedAt, row) };
	}
	const versioned = await content.getVersioned!(collection, id);
	// Publish only the draft this edit created: exactly one version after the one read.
	if (!versioned || versioned.item.version !== (fresh.version ?? 0) + 1 || !versioned.item.draftRevisionId) {
		st.memo = settled(st.memo);
		ctx.log.error(edit.collided, { entry: entryKey(collection, id), slug: item.slug });
		return { status: "collided" };
	}
	const draft = versioned.item.draftRevisionId;
	await st.save({ ...st.memo, draft });
	let published: unknown;
	markOwnPublish(entryKey(collection, id), draft);
	try {
		published = await content.publish!(collection, id, { _rev: versioned._rev });
	} catch (error) {
		if (!isConflict(error)) throw error;
		// Someone saved it in between (an open editor autosaves): their draft may not have the edit, so it's tried again.
		st.memo = settled(st.memo);
		return { status: "staged" };
	}
	st.memo = settled(st.memo);
	return { status: "done", ...(keep ? { dateKept: await keepDate(ctx, entry, fresh.updatedAt, publishedRow(published, versioned.item.version, draft)) } : {}) };
}

/** An outcome, with dateKept only when keepDates said something. */
const outcomeOf = (key: string, slug: string | null, status: LinkStatus, changes: Array<LinkChange | UnlinkChange>, reason?: string, dateKept?: boolean): LinkOutcome =>
	dateKept === undefined ? { key, slug, status, changes, reason } : { key, slug, status, changes, reason, dateKept };

/**
 * The changes for possessives moved inside glossary.io links, with each link's
 * term when it's known: from the entry's entities (their name), or else from
 * the site's stored index copy (the term's glossary.io name). Null otherwise.
 */
async function possessiveChanges(ctx: PluginContext, fixes: PossessiveFix[], entities: readonly LinkEntity[], lookup: (qid: string) => GlossaryTarget | null): Promise<PossessiveChange[]> {
	const bySlug = new Map<string, { qid: string; entity: string | null }>();
	for (const e of entities) {
		const t = lookup(e.qid);
		if (t && !bySlug.has(t.slug)) bySlug.set(t.slug, { qid: e.qid, entity: e.name });
	}
	if (fixes.some((f) => f.slug && !bySlug.has(f.slug))) {
		const copy = await storedGlossary(ctx).catch(() => null);
		for (const [qid, term] of Object.entries(copy?.terms ?? {})) if (!bySlug.has(term[0])) bySlug.set(term[0], { qid, entity: term[2]?.[0] ?? null });
	}
	return fixes.map((f) => {
		const known = f.slug ? bySlug.get(f.slug) : undefined;
		return { action: "possessive", qid: known?.qid ?? null, entity: known?.entity ?? null, slug: f.slug, href: f.href, anchor: f.anchor, block: f.block, why: f.moved, context: f.context };
	});
}

/** What planEntryLinks would change: each field's new value, the term links made or switched, the possessives moved, and the QIDs handled. */
export interface EntryLinkPlan {
	patch: Record<string, unknown>;
	terms: TermLinkChange[];
	/** The field each of `terms` is in. */
	termFields: string[];
	fixes: PossessiveFix[];
	/** The field each of `fixes` is in. */
	fixFields: string[];
	/** QIDs never to link again in this entry: `exclude`, and the entities already linked to their term. */
	handled: Set<string>;
}

/**
 * The links one entry gets, by the rules (pure): one link per entity across its Portable Text `fields` (in order),
 * none for a QID in `exclude` or one already linked to its term, none for an entity an affiliate link in any field
 * names, then the possessives right after glossary.io links moved inside them. `only`: possessives alone. A field
 * whose possessive fix fails keeps its possessives (`onFixError`). Used by linkEntry and the editor's AI Enrich button.
 */
export function planEntryLinks(
	data: Record<string, unknown>,
	fields: string[],
	entities: readonly LinkEntity[],
	lookup: (qid: string) => GlossaryTarget | null,
	config: { siteHosts: string[]; shortHosts: string[] },
	exclude: readonly string[],
	opts: { only?: boolean; onFixError?: (field: string, error: unknown) => void } = {},
): EntryLinkPlan {
	const list = entities as LinkEntity[];
	const handled = new Set<string>();
	const patch: Record<string, unknown> = {};
	const terms: TermLinkChange[] = [];
	const termFields: string[] = [];
	// A possessives-only run plans no links at all.
	if (!opts.only) {
		// One link per entity across all the entry's Portable Text fields.
		for (const qid of exclude) handled.add(qid);
		const linkedSlugs = new Set(fields.flatMap((f) => [...linkedGlossarySlugs(data[f])]));
		for (const e of list) {
			const t = lookup(e.qid);
			if (t && linkedSlugs.has(t.slug)) handled.add(e.qid);
		}
		const ruledOut = new Set(handled);
		// An affiliate link in any field rules its entity out in all of them.
		for (const field of fields) {
			const pre = planGlossaryLinks(data[field], list, lookup, { siteHosts: config.siteHosts, shortHosts: config.shortHosts });
			for (const s of pre.skipped) if (s.why === "affiliate") ruledOut.add(s.qid);
		}
		for (const field of fields) {
			const plan = planGlossaryLinks(data[field], list, lookup, { siteHosts: config.siteHosts, shortHosts: config.shortHosts, exclude: ruledOut });
			for (const c of plan.changes) ruledOut.add(c.qid);
			if (plan.changes.length) {
				patch[field] = plan.content;
				terms.push(...plan.changes);
				termFields.push(...plan.changes.map(() => field));
			}
		}
	}
	// Possessives right after glossary.io links (this part's, switched ones, a person's) go inside them: "[Google]'s" → "[Google's]".
	// A field whose fix fails (content the fix can't read) keeps its possessives where they are; the term links still go ahead.
	const fixes: PossessiveFix[] = [];
	const fixFields: string[] = [];
	for (const field of fields) {
		try {
			const fixed = possessivesIo.fix(field in patch ? patch[field] : data[field]);
			if (!fixed.fixes.length) continue;
			patch[field] = fixed.content;
			fixes.push(...fixed.fixes);
			fixFields.push(...fixed.fixes.map(() => field));
		} catch (error) {
			opts.onFixError?.(field, error);
		}
	}
	return { patch, terms, termFields, fixes, fixFields, handled };
}

/** Link one analyzed entry's entities to glossary.io (see the file comment). Throws only on unexpected errors. */
export async function linkEntry(ctx: PluginContext, options: AiOptions, collection: string, id: string, opts: LinkOptions = {}): Promise<LinkOutcome> {
	const key = entryKey(collection, id);
	const memos = linkMemos(ctx);
	const now = Date.now();
	const only = opts.only === "possessive";
	const existing = await memos.get(key);
	// A possessives-only run for an entry with nothing remembered starts from a memo that counts as nothing remembered (pendingNew), and its
	// saves write only its edit in progress (memoState's markersOnly): a memo without a text hash would make the next analysis link.
	const st = memoState(memos, key, existing ?? (only ? unseenMemo(collection, id) : { collection, entryId: id, linked: [], updated: "" }), Boolean(opts.dryRun), only);
	/** The memo counted as nothing remembered when this run started (a possessives-only run's marker, a removal's). */
	const unseen = st.memo.pendingNew === true;
	/**
	 * The end of a possessives-only run: only its edit in progress is written (or taken off), over what's stored now, and only when that
	 * changes something; the text hash, the linked terms and the retry schedule are never touched (a retry would link). A memo with
	 * nothing in it (emptyMemo: the entry had nothing remembered, and no edit is left pending) is deleted. When the delete fails, what's
	 * left still counts as nothing remembered (pendingNew), and the next possessives-only run deletes it.
	 */
	const endOnly = async (): Promise<void> => {
		const stored = await memos.get(key);
		// Nothing stored: nothing to write, unless an edit of this run's is still pending.
		if (!stored && st.memo.pending === undefined) return;
		const merged = onlyMerge(stored, st.memo);
		if (emptyMemo(merged)) {
			await memos.delete(key).catch((error: unknown) => ctx.log.warn("glossary.io links: couldn't delete an empty memo; it's deleted by the next possessives-only run", { entry: key, error: String(error) }));
		} else if (!stored || !sameMemo(stored, merged)) await memos.put(key, { ...merged, updated: new Date().toISOString() });
	};
	const out = async (status: LinkStatus, slug: string | null, changes: LinkChange[] = [], reason?: string, dateKept?: boolean): Promise<LinkOutcome> => {
		if (opts.dryRun) return outcomeOf(key, slug, status, changes, reason, dateKept);
		if (!only) {
			// A memo that counted as nothing remembered becomes an ordinary one only when the text is recorded with it, or a person's run says so
			// (forgetNew). Otherwise (a retry, which has no text hash) it keeps counting as nothing remembered, also after an edit of this run's
			// (publishOwnEdit took the flag off while it ran): a memo without a text hash and without the flag would make the next analysis link.
			const ordinary = Boolean(opts.textHash) || opts.forgetNew === true || !unseen;
			const flagged = ordinary ? withoutPendingNew(st.memo) : { ...st.memo, pendingNew: true as const };
			// Links this run published make AI Enrich's older proposal moot: its links would be found at the next publish
			// and read as applied by a person. One that's out of date goes too.
			const base = status === "linked" || !livePlanned(flagged, now) ? withoutPlanned(flagged) : flagged;
			await st.save(linkServed(withRetry({ ...base, ...(opts.textHash ? { textHash: opts.textHash } : {}) }, status, now)));
		}
		else await endOnly();
		return outcomeOf(key, slug, status, changes, reason, dateKept);
	};
	// Exclusions count from the start, so a run that has to wait (a draft, a recent save) can't link them later.
	if (opts.exclude?.length && !opts.dryRun && !only) st.memo = { ...st.memo, linked: [...new Set([...st.memo.linked, ...opts.exclude])].sort() };

	const content = ctx.content;
	if (!content?.get || !content.update || !content.getVersioned || !content.publish) throw new Error("Content write access is unavailable.");
	if (isGlossarySite(ctx.site?.url)) return out("skipped", null, [], "glossary.io itself");
	const config = linkConfig(options, ctx.site?.url);
	if (!config.siteHosts.length) return out("skipped", null, [], "the site's own URL isn't known");

	const record = opts.record ?? (await store<EntryRecord>(ctx, "aiEntries").get(key));
	// A possessives-only run needs the analysis too, though it plans nothing from it: its publish fires the save hooks, which queue an
	// entry without an "ok" analysis for its first one, and a first analysis links.
	if (!record || record.status !== "ok") return out("skipped", null, [], "not analyzed");
	const entities = record.entities;
	const info = await ctx.schema?.getCollection(collection);
	const fields = (info?.fields ?? []).filter((f) => f.type === "portableText").sort((a, b) => a.sortOrder - b.sortOrder);
	if (!info || !fields.length) return out("skipped", null, [], "no Portable Text field");

	const item = await content.get(collection, id);
	if (!item || item.status !== "published") return out("skipped", item?.slug ?? null, [], "not published");
	if (item.slug && (config.skip.has(item.slug) || config.skip.has(`${collection}:${item.slug}`))) return out("skipped", item.slug, [], "on the skip list");

	// A possessives-only run finishes or drops only a possessives-only edit's marker. A removal's marker, or a link edit's (its draft has
	// adds or switches), is left exactly as it is, with nothing published and nothing remembered or forgotten: settling a removal here
	// would leave its retry behind as a request to link, and publishing a link edit's draft links. The normal paths handle those.
	if (only && (st.memo.pendingUnlink?.length || st.memo.pendingSlugs?.length || st.memo.pendingQids?.length)) {
		return outcomeOf(key, item.slug, "draft", [], st.memo.pendingUnlink?.length ? "a removal of links is unfinished; it's left for the removal's own run" : "an edit with new links is unfinished; it's left for a normal run");
	}

	const waiting = await waitOrFinish(ctx, options, st, { collection, id, item, fields: fields.map((f) => f.slug), now, dryRun: opts.dryRun });
	if (waiting) return out(waiting.status, item.slug, [], waiting.reason, waiting.dateKept);

	// A possessives-only run uses the index only to name the terms of the links it fixes: it does without one.
	const index = only ? await glossaryFor(ctx, ctx.site?.url, { anySwitch: true }).catch(() => null) : await glossaryFor(ctx, ctx.site?.url, { anySwitch: true });
	if (!index && !only) return out("no-index", item.slug);
	const lookup = (qid: string): GlossaryTarget | null => {
		const term = index ? index(qid) : null;
		const slug = term ? glossarySlug(term.url) : null;
		return term && slug ? { slug, names: term.names ?? [] } : null;
	};

	const { patch, terms, fixes, handled } = planEntryLinks(
		item.data,
		fields.map((f) => f.slug),
		entities,
		lookup,
		config,
		[...st.memo.linked, ...(opts.exclude ?? [])],
		{
			only,
			onFixError: (field, error) => ctx.log.warn("glossary.io links: couldn't check a field's possessives; they stay as they are", { entry: key, slug: item.slug, field, error: String(error) }),
		},
	);
	const changes: LinkChange[] = [...terms, ...(fixes.length ? await possessiveChanges(ctx, fixes, entities, lookup) : [])];
	if (opts.dryRun) return out(changes.length ? "planned" : "unchanged", item.slug, changes);
	if (!only) st.memo = { ...st.memo, linked: [...handled].sort() };
	if (!changes.length) return out("unchanged", item.slug);

	// A possessive fix links no term: only the rules' links are remembered.
	const linked = [...new Set([...handled, ...terms.map((c) => c.qid)])].sort();
	const edit = await publishOwnEdit(ctx, options, st, {
		collection,
		id,
		item,
		info,
		patch,
		marker: { pendingQids: terms.map((c) => c.qid), pendingSlugs: [...new Set(terms.map((c) => c.slug))], ...(fixes.length ? { pendingPossessive: fixes.length } : {}) },
		collided: "glossary.io links: a save landed while the links were written; nothing was published. Check the entry's revisions.",
		ordinary: !only,
		// As in `out`: without a text hash or a person's word, a memo that started as nothing remembered stays that way.
		restoreNew: !only && unseen && !opts.textHash && opts.forgetNew !== true,
	}).catch(async (error: unknown) => {
		// A possessives-only run that failed with no edit left pending leaves nothing remembered, as before it ran. (With an edit still
		// pending, the marker stays so the next possessives-only run finishes it.) Whatever is left when this fails too (a memo that
		// couldn't be deleted) still has pendingNew, so shouldLink and the analysis treat it as nothing remembered.
		if (only) await endOnly().catch(() => undefined);
		throw error;
	});
	if (edit.status === "conflict") return out("conflict", item.slug);
	// Links that may not have stuck aren't remembered.
	if (edit.status === "collided" || edit.status === "staged") return out(edit.status, item.slug, changes);
	if (!only) st.memo = { ...st.memo, linked };
	return out("linked", item.slug, changes, undefined, edit.dateKept);
}

/**
 * Take the links to deleted glossary.io terms (memo.unlink, queued by
 * src/ai/glossary-gone.ts) out of one entry and keep their text, with the same
 * safety as linking. Checked again right before the write: a term whose QID or
 * slug is back in the index, or that's no longer confirmed gone, is left
 * alone. Once the edit is live, each removed term's QID leaves `linked`, so
 * the term can be linked again if it comes back. An entry where the link is
 * already gone (a person removed it) is settled without a write, and keeps
 * the QID, as for any link removed by hand.
 *
 * It never links by itself. Only when a try to link the entry was waiting
 * besides the removal (linkAsked: a site's request to link it again, or a link
 * that had to wait) are the entry's links checked on a later retry pass
 * (LINK_CHECK_MS), so the removal doesn't use that try up. Throws only on
 * unexpected errors.
 */
export async function unlinkEntry(ctx: PluginContext, options: AiOptions, collection: string, id: string): Promise<LinkOutcome> {
	const key = entryKey(collection, id);
	const memos = linkMemos(ctx);
	const now = Date.now();
	// Without a memo (deleted since the pass read it) there's nothing to remove: what's written counts as nothing remembered.
	const st = memoState(memos, key, (await memos.get(key)) ?? unseenMemo(collection, id), false);
	const asked = linkAsked(st.memo);
	const out = async (status: LinkStatus, slug: string | null, changes: UnlinkChange[] = [], reason?: string, dateKept?: boolean): Promise<LinkOutcome> => {
		const { unlinkAt: _a, relink: _l, ...next } = withRetry(st.memo, status, now);
		let memo: LinkMemo = next;
		if (!next.unlink?.length) {
			// Removals done. The links are checked on a pass after this one only when a try to link was waiting too.
			if (asked && (status === "unlinked" || status === "unchanged")) memo = { ...next, retryAt: now + LINK_CHECK_MS, tries: 0 };
		} else {
			// Its own earlier edit went live first: the removal is tried again on a later run.
			if (reason === FINISHED) memo = { ...next, retryAt: now + RETRY_BASE_MS, tries: 0 };
			// The next turn is the removal's own again; a try to link that was waiting is remembered.
			memo = { ...memo, ...(memo.retryAt === undefined ? {} : { unlinkAt: memo.retryAt }), ...(asked ? { relink: true as const } : {}) };
		}
		await st.save(memo);
		return outcomeOf(key, slug, status, changes, reason, dateKept);
	};
	/** Done with these links (all of them when no slugs are given): they leave `unlink`. */
	const drop = (slugs?: Iterable<string>) => {
		const gone = slugs ? new Set(slugs) : null;
		st.memo = withUnlink(st.memo, gone ? (st.memo.unlink ?? []).filter((u) => !gone.has(u.slug)) : []);
	};

	if (!st.memo.unlink?.length) return out("unchanged", null, [], "nothing to remove");
	const content = ctx.content;
	if (!content?.get || !content.update || !content.getVersioned || !content.publish) throw new Error("Content write access is unavailable.");
	if (isGlossarySite(ctx.site?.url)) {
		drop();
		return out("skipped", null, [], "glossary.io itself");
	}
	const info = await ctx.schema?.getCollection(collection);
	const fields = (info?.fields ?? []).filter((f) => f.type === "portableText").sort((a, b) => a.sortOrder - b.sortOrder);
	if (!info || !fields.length) {
		drop();
		return out("skipped", null, [], "no Portable Text field");
	}
	const item = await content.get(collection, id);
	if (!item || item.status !== "published") {
		drop();
		return out("skipped", item?.slug ?? null, [], "not published");
	}
	const config = linkConfig(options, ctx.site?.url);
	if (item.slug && (config.skip.has(item.slug) || config.skip.has(`${collection}:${item.slug}`))) {
		drop();
		return out("skipped", item.slug, [], "on the skip list");
	}

	const waiting = await waitOrFinish(ctx, options, st, { collection, id, item, fields: fields.map((f) => f.slug), now });
	if (waiting) return out(waiting.status, item.slug, [], waiting.reason, waiting.dateKept);

	// Checked again right before the write: still confirmed gone, and neither its QID nor its slug in the site's index copy.
	const check = await goneCheck(ctx);
	if (!check) return out("no-index", item.slug);
	const targets = (st.memo.unlink ?? []).filter(check.stands);
	if (!targets.length) {
		drop();
		return out("unchanged", item.slug, [], "the terms are back, or no longer confirmed gone");
	}
	const slugs = targets.map((u) => u.slug);
	const patch: Record<string, unknown> = {};
	const counts: Record<string, number> = {};
	for (const field of fields) {
		const removed = removeGlossaryLinks(item.data[field.slug], slugs);
		if (!removed.removed) continue;
		patch[field.slug] = removed.content;
		for (const [slug, n] of Object.entries(removed.bySlug)) counts[slug] = (counts[slug] ?? 0) + n;
	}
	const changes: UnlinkChange[] = targets.filter((u) => counts[u.slug]).map((u) => ({ slug: u.slug, qid: u.qid, removed: counts[u.slug] }));
	if (!changes.length) {
		drop();
		return out("unchanged", item.slug, [], "no such links");
	}

	const edit = await publishOwnEdit(ctx, options, st, {
		collection,
		id,
		item,
		info,
		patch,
		marker: { pendingUnlink: changes.map((c) => c.slug) },
		collided: "glossary.io links: a save landed while links to a deleted term were removed; nothing was published. Check the entry's revisions.",
	});
	if (edit.status === "conflict") return out("conflict", item.slug);
	if (edit.status === "collided" || edit.status === "staged") return out(edit.status, item.slug, changes);
	const removedQids = new Set(changes.map((c) => c.qid));
	drop();
	st.memo = { ...st.memo, linked: st.memo.linked.filter((q) => !removedQids.has(q)) };
	return out("unlinked", item.slug, changes, undefined, edit.dateKept);
}

/**
 * Whether the entry's pending draft is this part's own unpublished edit: its
 * recorded draft id, or (when the publish never happened before the id was
 * known) a draft exactly one version after the marker whose text is the live
 * text and which has every glossary link the edit made. Version alone isn't
 * enough: an editor's draft can have that version too. A removal's draft has
 * the live text, none of the removed links (which the live entry still has),
 * and its other fields (those both have) as they are live. An edit that moved
 * possessives inside glossary.io links (ownPossessiveDraft) is recognized by
 * what such an edit can do, not only by its text: an editor's draft that
 * removed or re-pointed a link, or changed anything else, is never taken for it.
 */
async function ownDraft(ctx: PluginContext, collection: string, item: { id: string; version?: number; data: Record<string, unknown>; draftRevisionId?: string | null }, memo: LinkMemo, fields: string[]): Promise<boolean> {
	if (memo.draft && memo.draft === item.draftRevisionId) return true;
	const removal = memo.pendingUnlink?.length ? memo.pendingUnlink : null;
	const possessive = (memo.pendingPossessive ?? 0) > 0;
	if (memo.pending === undefined || item.version !== memo.pending + 1 || (!memo.pendingSlugs?.length && !removal && !possessive) || !item.draftRevisionId || !ctx.content?.getRevision) return false;
	const draft = await ctx.content.getRevision(collection, item.id, item.draftRevisionId).catch(() => null);
	const data = (draft as { data?: Record<string, unknown> } | null)?.data;
	if (!data) return false;
	const sameText = fields.every((f) => !(f in data) || bodyText(data[f]) === bodyText(item.data[f]));
	const others = Object.keys(data).filter((k) => !k.startsWith("_") && !fields.includes(k) && k in item.data);
	const othersSame = () => others.every((k) => stable(data[k]) === stable(item.data[k]));
	if (!removal) {
		const slugs = new Set(fields.flatMap((f) => [...linkedGlossarySlugs(data[f])]));
		const linksThere = sameText && (memo.pendingSlugs ?? []).every((s) => slugs.has(s));
		if (!possessive) return linksThere;
		try {
			return linksThere && othersSame() && ownPossessiveDraft(data, item.data, memo, fields);
		} catch {
			// Content the fix can't read: not this part's draft.
			return false;
		}
	}
	const inDraft = new Set(fields.flatMap((f) => [...glossarySlugsIn(data[f])]));
	const live = new Set(fields.flatMap((f) => [...glossarySlugsIn(item.data[f])]));
	return sameText && removal.every((s) => !inDraft.has(s)) && removal.some((s) => live.has(s)) && othersSame();
}

/**
 * Whether a draft's Portable Text fields are what this part's edit with
 * possessive fixes (memo.pendingPossessive) made of the live entry's.
 * Only fixes (no pendingSlugs): each field is exactly the live field with its
 * possessives moved (linkPossessives), span keys aside (a span the fix splits
 * off gets a new one), so a field without any is as it is live; and the live
 * entry has as many to move as the edit moved.
 * With links too (pendingSlugs): the draft has none left to move; its
 * glossary.io terms are the live ones plus the edit's; it has no link to
 * anywhere else that the live entry doesn't have; and apart from links
 * (withoutLinks) every field is as it is live: same blocks, text, formatting,
 * images.
 */
function ownPossessiveDraft(data: Record<string, unknown>, live: Record<string, unknown>, memo: LinkMemo, fields: string[]): boolean {
	const inDraft = (f: string) => (f in data ? data[f] : live[f]);
	if (!memo.pendingSlugs?.length) {
		let moved = 0;
		for (const f of fields) {
			const fixed = linkPossessives(live[f]);
			moved += fixed.fixes.length;
			if (stable(withoutSpanKeys(inDraft(f))) !== stable(withoutSpanKeys(fixed.content))) return false;
		}
		return moved === memo.pendingPossessive;
	}
	if (fields.some((f) => linkPossessives(inDraft(f)).fixes.length)) return false;
	const slugsOf = (value: (f: string) => unknown) => new Set(fields.flatMap((f) => [...glossarySlugsIn(value(f))]));
	const draftSlugs = slugsOf(inDraft);
	const wanted = new Set([...slugsOf((f) => live[f]), ...memo.pendingSlugs]);
	if (draftSlugs.size !== wanted.size || [...wanted].some((s) => !draftSlugs.has(s))) return false;
	const elsewhere = (value: unknown) => linkHrefsIn(value).filter((href) => !glossarySlug(href));
	return fields.every((f) => {
		const liveHrefs = new Set(elsewhere(live[f]));
		return elsewhere(inDraft(f)).every((href) => liveHrefs.has(href)) && stable(withoutLinks(inDraft(f))) === stable(withoutLinks(live[f]));
	});
}

/** A copy of a value without its spans' keys. */
function withoutSpanKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutSpanKeys);
	if (!value || typeof value !== "object") return value;
	const node = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(node)
			.filter(([k]) => !(k === "_key" && node._type === "span"))
			.map(([k, v]) => [k, withoutSpanKeys(v)]),
	);
}

/** JSON with object keys sorted, to compare two copies of a field. */
function stable(value: unknown): string {
	return JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v)) ?? "";
}

/**
 * Entries due for another try (draft, busy, conflict, staged, no index, error): linked again without a model call.
 * With `unlink` (Remove links to deleted terms on, and not paused), an entry with links to take out has them taken out instead.
 * Without it, a turn that was only for a removal is given up without linking (nobody asked for links; the term's
 * entries are looked for again later).
 */
export async function retryDue(ctx: PluginContext, options: AiOptions, limit: number, opts: { unlink?: boolean } = {}): Promise<number> {
	const memos = linkMemos(ctx);
	const due = await memos.query({ where: { retryAt: { lte: Date.now() } }, orderBy: { retryAt: "asc" }, limit });
	for (const { id, data } of due.items) {
		try {
			if (opts.unlink && data.unlink?.length) {
				const outcome = await unlinkEntry(ctx, options, data.collection, data.entryId);
				if (outcome.status === "unlinked") ctx.log.info("glossary.io links removed", { entry: id, slugs: outcome.changes.map((c) => c.slug), ...(outcome.dateKept === undefined ? {} : { dateKept: outcome.dateKept }) });
				continue;
			}
			if (data.unlink?.length && !linkAsked(data)) {
				const { retryAt: _r, tries: _t, unlinkAt: _a, ...rest } = data;
				await memos.put(id, rest);
				continue;
			}
			const outcome = await linkEntry(ctx, options, data.collection, data.entryId);
			if (outcome.status === "linked") ctx.log.info("glossary.io links (retry)", { entry: id, ...changeCounts(outcome.changes), ...(outcome.dateKept === undefined ? {} : { dateKept: outcome.dateKept }) });
		} catch (error) {
			ctx.log.warn("glossary.io links (retry) failed", { entry: id, error: String(error) });
			const memo = await memos.get(id);
			if (memo) await memos.put(id, afterError(memo));
		}
	}
	return due.items.length;
}

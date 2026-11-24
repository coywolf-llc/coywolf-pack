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
 * "Link existing entries" (POST ai/glossary-links) runs the same code on
 * entries analyzed before the part was turned on, with a dry run.
 */
import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import { isConflict } from "../core/conflict.js";
import { databaseFor } from "../core/database.js";
import { ctxFeatures } from "../core/features.js";
import { purgeEntryPages } from "../pageCache/entries.js";
import { afterResponse } from "../shared.js";
import { glossaryFor, isGlossarySite, storedGlossary } from "./glossary.js";
import { readGoneState, removeGoneOn } from "./glossary-gone.js";
import { type GlossaryTarget, type LinkChange, bodyText, glossarySlug, glossarySlugsIn, linkedGlossarySlugs, planGlossaryLinks, removeGlossaryLinks } from "./glossary-links.js";
import { type PublishedRow, restoreUpdatedAt } from "./keep-date.js";
// Types only (store.ts loads the providers, which the tests can't run): the collection lookups are repeated here.
import type { AiOptions, EntryRecord } from "./store.js";

export type LinkStatus =
	/** Linked and published (or, for a collection without revisions, saved). */
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
}

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
 * existing entries or by the text change after that.
 */
export function shouldLink(memo: Pick<LinkMemo, "textHash"> | null | undefined, previous: { status: string; title: string; entities?: readonly unknown[] } | null | undefined, textHash: string): boolean {
	if (memo) return memo.textHash !== textHash;
	return !previous || (previous.status !== "ok" && !previous.title && !previous.entities?.length);
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

/** The memo without an edit in progress. */
const settled = (memo: LinkMemo): LinkMemo => {
	const { pending: _p, draft: _d, pendingQids: _q, pendingSlugs: _s, pendingUnlink: _u, keepUpdatedAt: _k, ...rest } = memo;
	return rest as LinkMemo;
};

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

function memoState(memos: StorageCollection<LinkMemo>, key: string, initial: LinkMemo, dryRun: boolean): MemoState {
	const state: MemoState = {
		memo: initial,
		async save(next) {
			state.memo = { ...next, updated: new Date().toISOString() };
			if (!dryRun) await memos.put(key, state.memo);
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
	edit: { collection: string; id: string; item: Item; info: CollectionSchemaInfo; patch: Record<string, unknown>; marker: Partial<LinkMemo>; collided: string },
): Promise<{ status: "done" | "conflict" | "collided" | "staged"; dateKept?: boolean }> {
	const { collection, id, item } = edit;
	const content = ctx.content!;
	const keep = keepDatesOn(options);
	const entry = { collection, id, slug: item.slug };
	// Re-read right before writing: if anyone saved in between, leave the entry alone.
	const fresh = await content.get(collection, id);
	if (!fresh || versionOf(fresh) !== versionOf(item)) return { status: "conflict" };
	// The marker goes in first, so an edit whose publish never happens is recognized (and published) next time.
	await st.save({ ...st.memo, pending: fresh.version ?? 0, ...edit.marker, ...(keep ? { keepUpdatedAt: fresh.updatedAt } : {}) });
	let updated: unknown;
	try {
		updated = await content.update!(collection, id, edit.patch);
	} catch (error) {
		// Nothing was written: drop the marker so it can't be mistaken for a later draft.
		const after = await content.get(collection, id).catch(() => null);
		if (after && versionOf(after) === versionOf(fresh)) await st.save(settled(st.memo));
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

/** Link one analyzed entry's entities to glossary.io (see the file comment). Throws only on unexpected errors. */
export async function linkEntry(ctx: PluginContext, options: AiOptions, collection: string, id: string, opts: LinkOptions = {}): Promise<LinkOutcome> {
	const key = entryKey(collection, id);
	const memos = linkMemos(ctx);
	const now = Date.now();
	const st = memoState(memos, key, (await memos.get(key)) ?? { collection, entryId: id, linked: [], updated: "" }, Boolean(opts.dryRun));
	const out = async (status: LinkStatus, slug: string | null, changes: LinkChange[] = [], reason?: string, dateKept?: boolean): Promise<LinkOutcome> => {
		if (!opts.dryRun) await st.save(linkServed(withRetry({ ...st.memo, ...(opts.textHash ? { textHash: opts.textHash } : {}) }, status, now)));
		return outcomeOf(key, slug, status, changes, reason, dateKept);
	};
	// Exclusions count from the start, so a run that has to wait (a draft, a recent save) can't link them later.
	if (opts.exclude?.length && !opts.dryRun) st.memo = { ...st.memo, linked: [...new Set([...st.memo.linked, ...opts.exclude])].sort() };

	const content = ctx.content;
	if (!content?.get || !content.update || !content.getVersioned || !content.publish) throw new Error("Content write access is unavailable.");
	if (isGlossarySite(ctx.site?.url)) return out("skipped", null, [], "glossary.io itself");
	const config = linkConfig(options, ctx.site?.url);
	if (!config.siteHosts.length) return out("skipped", null, [], "the site's own URL isn't known");

	const record = opts.record ?? (await store<EntryRecord>(ctx, "aiEntries").get(key));
	if (!record || record.status !== "ok") return out("skipped", null, [], "not analyzed");
	const info = await ctx.schema?.getCollection(collection);
	const fields = (info?.fields ?? []).filter((f) => f.type === "portableText").sort((a, b) => a.sortOrder - b.sortOrder);
	if (!info || !fields.length) return out("skipped", null, [], "no Portable Text field");

	const item = await content.get(collection, id);
	if (!item || item.status !== "published") return out("skipped", item?.slug ?? null, [], "not published");
	if (item.slug && (config.skip.has(item.slug) || config.skip.has(`${collection}:${item.slug}`))) return out("skipped", item.slug, [], "on the skip list");

	const waiting = await waitOrFinish(ctx, options, st, { collection, id, item, fields: fields.map((f) => f.slug), now, dryRun: opts.dryRun });
	if (waiting) return out(waiting.status, item.slug, [], waiting.reason, waiting.dateKept);

	const index = await glossaryFor(ctx, ctx.site?.url, { anySwitch: true });
	if (!index) return out("no-index", item.slug);
	const lookup = (qid: string): GlossaryTarget | null => {
		const term = index(qid);
		const slug = term ? glossarySlug(term.url) : null;
		return term && slug ? { slug, names: term.names ?? [] } : null;
	};

	// One link per entity across all the entry's Portable Text fields.
	const handled = new Set([...st.memo.linked, ...(opts.exclude ?? [])]);
	const linkedSlugs = new Set(fields.flatMap((f) => [...linkedGlossarySlugs(item.data[f.slug])]));
	for (const e of record.entities) {
		const t = lookup(e.qid);
		if (t && linkedSlugs.has(t.slug)) handled.add(e.qid);
	}
	const exclude = new Set(handled);
	// An affiliate link in any field rules its entity out in all of them.
	for (const field of fields) {
		const pre = planGlossaryLinks(item.data[field.slug], record.entities, lookup, { siteHosts: config.siteHosts, shortHosts: config.shortHosts });
		for (const s of pre.skipped) if (s.why === "affiliate") exclude.add(s.qid);
	}
	const patch: Record<string, unknown> = {};
	const changes: LinkChange[] = [];
	for (const field of fields) {
		const plan = planGlossaryLinks(item.data[field.slug], record.entities, lookup, { siteHosts: config.siteHosts, shortHosts: config.shortHosts, exclude });
		for (const c of plan.changes) exclude.add(c.qid);
		if (plan.changes.length) {
			patch[field.slug] = plan.content;
			changes.push(...plan.changes);
		}
	}
	if (opts.dryRun) return out(changes.length ? "planned" : "unchanged", item.slug, changes);
	st.memo = { ...st.memo, linked: [...handled].sort() };
	if (!changes.length) return out("unchanged", item.slug);

	const linked = [...new Set([...handled, ...changes.map((c) => c.qid)])].sort();
	const edit = await publishOwnEdit(ctx, options, st, {
		collection,
		id,
		item,
		info,
		patch,
		marker: { pendingQids: changes.map((c) => c.qid), pendingSlugs: [...new Set(changes.map((c) => c.slug))] },
		collided: "glossary.io links: a save landed while the links were written; nothing was published. Check the entry's revisions.",
	});
	if (edit.status === "conflict") return out("conflict", item.slug);
	// Links that may not have stuck aren't remembered.
	if (edit.status === "collided" || edit.status === "staged") return out(edit.status, item.slug, changes);
	st.memo = { ...st.memo, linked };
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
	const st = memoState(memos, key, (await memos.get(key)) ?? { collection, entryId: id, linked: [], updated: "" }, false);
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
 * and its other fields (those both have) as they are live.
 */
async function ownDraft(ctx: PluginContext, collection: string, item: { id: string; version?: number; data: Record<string, unknown>; draftRevisionId?: string | null }, memo: LinkMemo, fields: string[]): Promise<boolean> {
	if (memo.draft && memo.draft === item.draftRevisionId) return true;
	const removal = memo.pendingUnlink?.length ? memo.pendingUnlink : null;
	if (memo.pending === undefined || item.version !== memo.pending + 1 || (!memo.pendingSlugs?.length && !removal) || !item.draftRevisionId || !ctx.content?.getRevision) return false;
	const draft = await ctx.content.getRevision(collection, item.id, item.draftRevisionId).catch(() => null);
	const data = (draft as { data?: Record<string, unknown> } | null)?.data;
	if (!data) return false;
	const sameText = fields.every((f) => !(f in data) || bodyText(data[f]) === bodyText(item.data[f]));
	if (!removal) {
		const slugs = new Set(fields.flatMap((f) => [...linkedGlossarySlugs(data[f])]));
		return sameText && memo.pendingSlugs!.every((s) => slugs.has(s));
	}
	const inDraft = new Set(fields.flatMap((f) => [...glossarySlugsIn(data[f])]));
	const live = new Set(fields.flatMap((f) => [...glossarySlugsIn(item.data[f])]));
	const others = Object.keys(data).filter((k) => !k.startsWith("_") && !fields.includes(k) && k in item.data);
	return sameText && removal.every((s) => !inDraft.has(s)) && removal.some((s) => live.has(s)) && others.every((k) => stable(data[k]) === stable(item.data[k]));
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
			if (outcome.status === "linked") ctx.log.info("glossary.io links (retry)", { entry: id, links: outcome.changes.length, ...(outcome.dateKept === undefined ? {} : { dateKept: outcome.dateKept }) });
		} catch (error) {
			ctx.log.warn("glossary.io links (retry) failed", { entry: id, error: String(error) });
			const memo = await memos.get(id);
			if (memo) await memos.put(id, afterError(memo));
		}
	}
	return due.items.length;
}

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
 * unchanged text never link), a marker for an edit in progress, and when to
 * try again.
 *
 * Safety:
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
 *   its text (unchanged) and links (all of the edit's); never by version alone.
 *
 * "Link existing entries" (POST ai/glossary-links) runs the same code on
 * entries analyzed before the part was turned on, with a dry run.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { isConflict } from "../core/conflict.js";
import { glossaryFor, isGlossarySite } from "./glossary.js";
import { type GlossaryTarget, type LinkChange, bodyText, glossarySlug, linkedGlossarySlugs, planGlossaryLinks } from "./glossary-links.js";
// Types only (store.ts loads the providers, which the tests can't run): the collection lookups are repeated here.
import type { AiOptions, EntryRecord } from "./store.js";

export type LinkStatus =
	/** Linked and published (or, for a collection without revisions, saved). */
	| "linked"
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

export interface LinkOutcome {
	key: string;
	slug: string | null;
	status: LinkStatus;
	changes: LinkChange[];
	reason?: string;
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
	/** When to try again (epoch ms), and the tries so far. */
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

const entryKey = (collection: string, id: string) => `${collection}:${id}`;
const store = <T>(ctx: Pick<PluginContext, "storage">, name: string) => (ctx.storage as Record<string, StorageCollection>)[name] as StorageCollection<T>;
export const linkMemos = (ctx: Pick<PluginContext, "storage">) => store<LinkMemo>(ctx, "aiLinks");

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

/** The memo without an edit in progress. */
const settled = (memo: LinkMemo): LinkMemo => {
	const { pending: _p, draft: _d, pendingQids: _q, pendingSlugs: _s, ...rest } = memo;
	return rest as LinkMemo;
};

/** Link one analyzed entry's entities to glossary.io (see the file comment). Throws only on unexpected errors. */
export async function linkEntry(ctx: PluginContext, options: AiOptions, collection: string, id: string, opts: LinkOptions = {}): Promise<LinkOutcome> {
	const key = entryKey(collection, id);
	const memos = linkMemos(ctx);
	const now = Date.now();
	let memo: LinkMemo = (await memos.get(key)) ?? { collection, entryId: id, linked: [], updated: "" };
	const save = async (next: LinkMemo) => {
		memo = { ...next, updated: new Date().toISOString() };
		if (!opts.dryRun) await memos.put(key, memo);
	};
	const out = async (status: LinkStatus, slug: string | null, changes: LinkChange[] = [], reason?: string): Promise<LinkOutcome> => {
		if (!opts.dryRun) await save(withRetry({ ...memo, ...(opts.textHash ? { textHash: opts.textHash } : {}) }, status, now));
		return { key, slug, status, changes, reason };
	};
	// Exclusions count from the start, so a run that has to wait (a draft, a recent save) can't link them later.
	if (opts.exclude?.length && !opts.dryRun) memo = { ...memo, linked: [...new Set([...memo.linked, ...opts.exclude])].sort() };

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

	if (pendingDraft(item)) {
		// This part's own edit whose publish didn't happen goes live now; anyone else's draft is left alone.
		if (!opts.dryRun && (await ownDraft(ctx, collection, item, memo, fields.map((f) => f.slug)))) {
			const versioned = await content.getVersioned(collection, id);
			if (versioned && versioned.item.draftRevisionId === item.draftRevisionId) {
				try {
					await content.publish(collection, id, { _rev: versioned._rev });
				} catch (error) {
					if (!isConflict(error)) throw error;
					return out("conflict", item.slug);
				}
				memo = { ...settled(memo), linked: [...new Set([...memo.linked, ...(memo.pendingQids ?? [])])].sort() };
				return out("linked", item.slug, [], "published the draft an earlier run saved");
			}
		}
		// A marker that doesn't match this draft is stale: the draft is someone else's.
		if (memo.pending !== undefined || memo.draft) memo = settled(memo);
		return out("draft", item.slug);
	}
	// No pending draft: any marker left from an earlier edit is stale (its draft was published or discarded).
	if (memo.pending !== undefined || memo.draft) memo = settled(memo);
	const savedAt = Date.parse(item.updatedAt);
	if (Number.isFinite(savedAt) && now - savedAt < BUSY_MS) return out("busy", item.slug);

	const index = await glossaryFor(ctx, ctx.site?.url, { anySwitch: true });
	if (!index) return out("no-index", item.slug);
	const lookup = (qid: string): GlossaryTarget | null => {
		const term = index(qid);
		const slug = term ? glossarySlug(term.url) : null;
		return term && slug ? { slug, names: term.names ?? [] } : null;
	};

	// One link per entity across all the entry's Portable Text fields.
	const handled = new Set([...memo.linked, ...(opts.exclude ?? [])]);
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
	memo = { ...memo, linked: [...handled].sort() };
	if (!changes.length) return out("unchanged", item.slug);

	// Re-read right before writing: if anyone saved in between, leave the entry alone.
	const fresh = await content.get(collection, id);
	if (!fresh || versionOf(fresh) !== versionOf(item)) return out("conflict", item.slug);
	const linked = [...new Set([...handled, ...changes.map((c) => c.qid)])].sort();
	// The marker goes in first, so an edit whose publish never happens is recognized (and published) next time.
	await save({ ...memo, pending: fresh.version ?? 0, pendingQids: changes.map((c) => c.qid), pendingSlugs: [...new Set(changes.map((c) => c.slug))] });
	try {
		await content.update(collection, id, patch);
	} catch (error) {
		// Nothing was written: drop the marker so it can't be mistaken for a later draft.
		const after = await content.get(collection, id).catch(() => null);
		if (after && versionOf(after) === versionOf(fresh)) await save(settled(memo));
		throw error;
	}
	if (!info.supports.includes("revisions")) {
		memo = { ...settled(memo), linked };
		return out("linked", item.slug, changes);
	}
	const versioned = await content.getVersioned(collection, id);
	// Publish only the draft this edit created: exactly one version after the one read.
	if (!versioned || versioned.item.version !== (fresh.version ?? 0) + 1 || !versioned.item.draftRevisionId) {
		memo = settled(memo);
		ctx.log.error("glossary.io links: a save landed while the links were written; nothing was published. Check the entry's revisions.", { entry: key, slug: item.slug });
		return out("collided", item.slug, changes);
	}
	await save({ ...memo, draft: versioned.item.draftRevisionId });
	try {
		await content.publish(collection, id, { _rev: versioned._rev });
	} catch (error) {
		if (!isConflict(error)) throw error;
		// Someone saved it in between (an open editor autosaves): their draft may not have the links, so they're tried again.
		memo = settled(memo);
		return out("staged", item.slug, changes);
	}
	memo = { ...settled(memo), linked };
	return out("linked", item.slug, changes);
}

/**
 * Whether the entry's pending draft is this part's own unpublished edit: its
 * recorded draft id, or (when the publish never happened before the id was
 * known) a draft exactly one version after the marker whose text is the live
 * text and which has every glossary link the edit made. Version alone isn't
 * enough: an editor's draft can have that version too.
 */
async function ownDraft(ctx: PluginContext, collection: string, item: { id: string; version?: number; data: Record<string, unknown>; draftRevisionId?: string | null }, memo: LinkMemo, fields: string[]): Promise<boolean> {
	if (memo.draft && memo.draft === item.draftRevisionId) return true;
	if (memo.pending === undefined || item.version !== memo.pending + 1 || !memo.pendingSlugs?.length || !item.draftRevisionId || !ctx.content?.getRevision) return false;
	const draft = await ctx.content.getRevision(collection, item.id, item.draftRevisionId).catch(() => null);
	const data = (draft as { data?: Record<string, unknown> } | null)?.data;
	if (!data) return false;
	const sameText = fields.every((f) => !(f in data) || bodyText(data[f]) === bodyText(item.data[f]));
	const slugs = new Set(fields.flatMap((f) => [...linkedGlossarySlugs(data[f])]));
	return sameText && memo.pendingSlugs.every((s) => slugs.has(s));
}

/** Entries due for another try (draft, busy, conflict, staged, no index, error): linked again without a model call. */
export async function retryDue(ctx: PluginContext, options: AiOptions, limit: number): Promise<number> {
	const memos = linkMemos(ctx);
	const due = await memos.query({ where: { retryAt: { lte: Date.now() } }, orderBy: { retryAt: "asc" }, limit });
	for (const { id, data } of due.items) {
		try {
			const outcome = await linkEntry(ctx, options, data.collection, data.entryId);
			if (outcome.status === "linked") ctx.log.info("glossary.io links (retry)", { entry: id, links: outcome.changes.length });
		} catch (error) {
			ctx.log.warn("glossary.io links (retry) failed", { entry: id, error: String(error) });
			const memo = await memos.get(id);
			if (memo) await memos.put(id, withRetry(memo, "error"));
		}
	}
	return due.items.length;
}

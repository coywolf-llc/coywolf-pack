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
 * Safety:
 * - Only published entries with no pending draft. A draft someone is working on
 *   is left alone; the entry is linked when its next text change is analyzed.
 * - The entry is read again right before the write, and left alone if anyone
 *   saved it in between. Only the draft this edit created is published; if
 *   someone saves meanwhile, the edit stays in the draft (status "staged").
 * - Each entity is linked once per entry: its QID is remembered on the entry's
 *   analysis (glossaryLinked), so a link removed by hand isn't added again.
 * - Settings changes that re-analyze unchanged text never link (textHash).
 *
 * "Link existing entries" (POST ai/glossary-links) runs the same code on
 * entries analyzed before the part was turned on, with a dry run.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { isConflict } from "../core/conflict.js";
import { glossaryFor, isGlossarySite } from "./glossary.js";
import { type GlossaryTarget, type LinkChange, glossarySlug, linkedGlossarySlugs, planGlossaryLinks } from "./glossary-links.js";
// Types only (store.ts loads the providers, which the tests can't run): col() and entryKey() are repeated here.
import type { AiOptions, EntryRecord } from "./store.js";

const entryKey = (collection: string, id: string) => `${collection}:${id}`;
const entries = (ctx: Pick<PluginContext, "storage">) => (ctx.storage as Record<string, StorageCollection>).aiEntries as StorageCollection<EntryRecord>;

export type LinkStatus =
	/** Linked and published (or, for a collection without revisions, saved). */
	| "linked"
	/** Saved, but someone saved the entry meanwhile, so the edit waits in its draft. */
	| "staged"
	/** Nothing to link (or a dry run found nothing). */
	| "unchanged"
	/** A dry run: these links would be made. */
	| "planned"
	/** Has unpublished changes of someone else's: left alone. */
	| "draft"
	/** Changed while being read: left alone. */
	| "conflict"
	/** Not linked at all (not published, not analyzed, on the skip list, or on glossary.io). */
	| "skipped"
	/** The site has no copy of glossary.io's index yet (it's fetched on the next page render). */
	| "no-index";

export interface LinkOutcome {
	key: string;
	slug: string | null;
	status: LinkStatus;
	changes: LinkChange[];
	reason?: string;
}

export interface LinkOptions {
	/** Plan only: nothing is written. */
	dryRun?: boolean;
	/** QIDs never to link in this entry (remembered with the ones linked). */
	exclude?: string[];
	/** The entry's analysis, when the caller just wrote it. */
	record?: EntryRecord;
	/** The entry's text hash, stored with the result (see EntryRecord.textHash). */
	hashText?: (data: Record<string, unknown>) => Promise<string | undefined>;
}

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

const versionOf = (item: { version?: number; updatedAt?: string; draftRevisionId?: string | null }) =>
	`${item.version ?? ""}|${item.updatedAt ?? ""}|${item.draftRevisionId ?? ""}`;

const pendingDraft = (item: { draftRevisionId?: string | null; liveRevisionId?: string | null }) =>
	Boolean(item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId);

/** Link one analyzed entry's entities to glossary.io (see the file comment). Throws only on unexpected errors. */
export async function linkEntry(ctx: PluginContext, options: AiOptions, collection: string, id: string, opts: LinkOptions = {}): Promise<LinkOutcome> {
	const key = entryKey(collection, id);
	const out = (status: LinkStatus, slug: string | null, changes: LinkChange[] = [], reason?: string): LinkOutcome => ({ key, slug, status, changes, reason });
	const content = ctx.content;
	if (!content?.get || !content.update || !content.getVersioned || !content.publish) throw new Error("Content write access is unavailable.");
	if (isGlossarySite(ctx.site?.url)) return out("skipped", null, [], "glossary.io itself");

	const records = entries(ctx);
	const record = opts.record ?? (await records.get(key));
	if (!record || record.status !== "ok") return out("skipped", null, [], "not analyzed");
	const info = await ctx.schema?.getCollection(collection);
	const fields = (info?.fields ?? []).filter((f) => f.type === "portableText").sort((a, b) => a.sortOrder - b.sortOrder);
	if (!info || !fields.length) return out("skipped", null, [], "no Portable Text field");

	const item = await content.get(collection, id);
	if (!item || item.status !== "published") return out("skipped", item?.slug ?? null, [], "not published");
	const config = linkConfig(options, ctx.site?.url);
	if (item.slug && (config.skip.has(item.slug) || config.skip.has(`${collection}:${item.slug}`))) return out("skipped", item.slug, [], "on the skip list");
	if (pendingDraft(item)) {
		// Our own edit whose publish failed last time goes live now; anyone else's draft is left alone.
		if (!opts.dryRun && record.glossaryDraft && record.glossaryDraft === item.draftRevisionId) {
			const versioned = await content.getVersioned(collection, id);
			if (versioned?.item.draftRevisionId === record.glossaryDraft) {
				await content.publish(collection, id, { _rev: versioned._rev });
				await records.put(key, { ...record, glossaryDraft: undefined });
				return out("linked", item.slug, [], "published the draft an earlier run saved");
			}
		}
		return out("draft", item.slug);
	}

	const index = await glossaryFor(ctx, ctx.site?.url, { anySwitch: true });
	if (!index) return out("no-index", item.slug);
	const lookup = (qid: string): GlossaryTarget | null => {
		const term = index(qid);
		const slug = term ? glossarySlug(term.url) : null;
		return term && slug ? { slug, names: term.names ?? [] } : null;
	};

	// One link per entity across all the entry's Portable Text fields.
	const handled = new Set([...(record.glossaryLinked ?? []), ...(opts.exclude ?? [])]);
	const linkedSlugs = new Set(fields.flatMap((f) => [...linkedGlossarySlugs(item.data[f.slug])]));
	for (const e of record.entities) {
		const t = lookup(e.qid);
		if (t && linkedSlugs.has(t.slug)) handled.add(e.qid);
	}
	const exclude = new Set(handled);
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

	const textHash = opts.hashText ? await opts.hashText(item.data) : record.textHash;
	/** Store what's been handled. Entities whose new links may not have stuck (a save in between) aren't counted, so a later run tries them again. */
	const remember = async (withChanges: boolean, extra: Partial<EntryRecord> = {}) => {
		const linked = new Set([...handled, ...(withChanges ? changes.map((c) => c.qid) : [])]);
		const { glossaryDraft: _old, ...rest } = record;
		await records.put(key, { ...rest, glossaryLinked: [...linked].sort(), ...(textHash ? { textHash } : {}), ...extra });
	};
	if (!changes.length) {
		await remember(false);
		return out("unchanged", item.slug);
	}

	// Re-read right before writing: if anyone saved in between, leave the entry alone.
	const fresh = await content.get(collection, id);
	if (!fresh || versionOf(fresh) !== versionOf(item)) return out("conflict", item.slug);
	await content.update(collection, id, patch);
	if (!info.supports.includes("revisions")) {
		await remember(true);
		return out("linked", item.slug, changes);
	}
	const versioned = await content.getVersioned(collection, id);
	// Publish only the draft this edit created: exactly one version after the one read.
	if (!versioned || versioned.item.version !== (fresh.version ?? 0) + 1 || !versioned.item.draftRevisionId) {
		await remember(false);
		return out("staged", item.slug, changes);
	}
	// Remembered first, so a publish that fails is finished by the next run (the pending draft is ours).
	await remember(true, { glossaryDraft: versioned.item.draftRevisionId });
	try {
		await content.publish(collection, id, { _rev: versioned._rev });
	} catch (error) {
		if (!isConflict(error)) throw error;
		// Someone saved it in between (an open editor autosaves): their draft may not have the links.
		await remember(false);
		return out("staged", item.slug, changes);
	}
	await remember(true);
	return out("linked", item.slug, changes);
}

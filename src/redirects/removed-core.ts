/**
 * "Removed content" decisions (feature "redirects.trashPrompt"): the pure
 * parts, unit tested in Node. When a published entry is deleted or
 * unpublished, its former URL is recorded so an editor can redirect it,
 * mark it 410 Gone, or dismiss it.
 */
import { type CollectionInfo, interpolateUrlPattern } from "../core/content-url.js";
import { sourceKey } from "./paths.js";

export type RemovalReason = "deleted" | "unpublished";

export interface PendingDecision {
	/** Storage id: "<collection>:<entry id>". */
	id: string;
	collection: string;
	entryId: string;
	/** Former public path (the site's `urls` override, or the collection's URL pattern). */
	url: string;
	title: string;
	reason: RemovalReason;
	locale: string | null;
	/** ISO time of the removal. */
	at: string;
}

/** The entry fields a decision needs, from a D1 row or a hook's content record. */
export interface EntrySnapshot {
	id: string;
	slug: string | null;
	status: string | null;
	publishedAt: string | null;
	locale: string | null;
	title: string | null;
}

export const pendingId = (collection: string, entryId: string) => `${collection}:${entryId}`;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Read a snapshot from an ec_* row (snake_case columns, title in the collection's title field). */
export function snapshotFromRow(row: Record<string, unknown>, titleField: string | null): EntrySnapshot {
	return {
		id: String(row.id),
		slug: str(row.slug),
		status: str(row.status),
		publishedAt: str(row.published_at),
		locale: str(row.locale),
		title: str(titleField ? row[titleField] : null) ?? str(row.title),
	};
}

/** Read a snapshot from a content hook's record (EmDash ContentItem: camelCase, fields under data). */
export function snapshotFromContent(content: Record<string, unknown>, titleField: string | null): EntrySnapshot {
	const data = (content.data ?? {}) as Record<string, unknown>;
	return {
		id: String(content.id),
		slug: str(content.slug),
		status: str(content.status),
		publishedAt: str(content.publishedAt),
		locale: str(content.locale),
		title: str(titleField ? data[titleField] : null) ?? str(data.title) ?? str(content.title),
	};
}

/**
 * Build the decision for a removed entry, or null when there's nothing to
 * decide: the entry never had a public URL (no slug, never published), or,
 * for deletes, it wasn't live when it was deleted.
 */
export function buildPending(
	collection: string,
	entry: EntrySnapshot,
	/** The former path when already resolved (core/content-url.ts entryUrl), else the collection's URL pattern. */
	info: { url?: string | null; urlPattern?: CollectionInfo["urlPattern"] } | undefined,
	reason: RemovalReason,
	now: Date = new Date(),
): PendingDecision | null {
	if (!entry.slug) return null;
	if (reason === "deleted" && entry.status !== "published") return null;
	if (reason === "unpublished" && !entry.publishedAt) return null;
	const url =
		info?.url ||
		interpolateUrlPattern({
			pattern: info?.urlPattern ?? null,
			collection,
			slug: entry.slug,
			id: entry.id,
			date: entry.publishedAt,
		});
	return {
		id: pendingId(collection, entry.id),
		collection,
		entryId: entry.id,
		url,
		title: entry.title ?? entry.slug,
		reason,
		locale: entry.locale,
		at: now.toISOString(),
	};
}

/**
 * A redirect or 410 rule created from a removal decision, remembered so that
 * restoring or republishing the entry can take the rule away again.
 */
export interface AppliedRule {
	/** Same id as the decision: "<collection>:<entry id>". */
	id: string;
	collection: string;
	entryId: string;
	/** The former path the rule was created for. */
	url: string;
	ruleId: string;
	action: "redirect" | "gone";
	/** ISO time the rule was created. */
	at: string;
}

/** Paths compared the way rules are stored: without a trailing slash, in one percent-encoding (src/redirects/paths.ts). */
const samePath = (a: string, b: string) => sourceKey(a) === sourceKey(b);

/** Whether the rule is still the one a removal decision made: same source, our "Removed:" note. Edited, replaced, or deleted since: false. */
export function appliedStillOurs(applied: Pick<AppliedRule, "url">, rule: { source: string; note: string | null } | null): boolean {
	return rule !== null && samePath(rule.source, applied.url) && (rule.note?.startsWith("Removed:") ?? false);
}

/**
 * Whether restoring or republishing an entry should delete the rule its
 * removal created: only while the rule is still the one we made
 * (appliedStillOurs), and, on publish, only when the entry is back at the
 * same URL (a new slug means the old URL still needs the rule).
 */
export function shouldDropApplied(
	applied: Pick<AppliedRule, "url">,
	rule: { source: string; note: string | null } | null,
	currentUrl: string | null,
	reason: "restore" | "publish",
): boolean {
	if (!appliedStillOurs(applied, rule)) return false;
	if (reason === "publish") return currentUrl !== null && samePath(currentUrl, applied.url);
	return true;
}

/** Group pending decisions' entry ids by collection, for one "is it live?" query per collection. */
export function idsByCollection(items: Array<Pick<PendingDecision, "collection" | "entryId">>): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const item of items) {
		const ids = out.get(item.collection) ?? [];
		if (!ids.includes(item.entryId)) ids.push(item.entryId);
		out.set(item.collection, ids);
	}
	return out;
}

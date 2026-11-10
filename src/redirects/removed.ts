/**
 * "Removed content" (feature "redirects.trashPrompt"): when a published entry
 * is deleted or unpublished, record its former URL as a pending decision in
 * plugin storage. The Redirects admin page lists them with Redirect to…,
 * Return 410 Gone, and Dismiss; the admin also prompts right after a trash or
 * unpublish (src/admin/trash-prompt.tsx). Republishing or restoring the entry
 * clears it and undoes a rule its decision created.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { COLLECTION_SLUG, entryUrl, readCollections } from "../core/content-url.js";
import { requireFeature } from "../core/features.js";
import { REDIRECTS_TAG, purgePageCache } from "../pageCache/lib.js";
import { parseInput, workerEnv } from "../shared.js";
import { noteRedirectsChanged } from "./middleware.js";
import {
	type AppliedRule,
	type EntrySnapshot,
	type PendingDecision,
	type RemovalReason,
	appliedStillOurs,
	buildPending,
	idsByCollection,
	pendingId,
	snapshotFromContent,
	shouldDropApplied,
	snapshotFromRow,
} from "./removed-core.js";
import { RedirectValidationError, deleteRule, findExactRuleAny, getRule, saveRule } from "./rules.js";

export const TRASH_PROMPT_FEATURE = "redirects.trashPrompt";
const STORE = "redirects_removed";
/** Rules created from decisions, so restoring or republishing the entry can undo them. */
const APPLIED = "redirects_applied";

export const removedStorage = { [STORE]: { indexes: ["at"] }, [APPLIED]: { indexes: ["at"] } };

interface Options {
	database?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: plugin storage collections are untyped here.
const store = (ctx: PluginContext) => (ctx.storage as Record<string, any>)[STORE] as {
	get(id: string): Promise<PendingDecision | null>;
	put(id: string, data: PendingDecision): Promise<void>;
	delete(id: string): Promise<boolean>;
	query(o: { orderBy?: Record<string, "asc" | "desc">; limit?: number }): Promise<{ items: Array<{ id: string; data: PendingDecision }> }>;
};

// biome-ignore lint/suspicious/noExplicitAny: plugin storage collections are untyped here.
const applied = (ctx: PluginContext) => (ctx.storage as Record<string, any>)[APPLIED] as {
	get(id: string): Promise<AppliedRule | null>;
	put(id: string, data: AppliedRule): Promise<void>;
	delete(id: string): Promise<boolean>;
};

/** A snapshot plus its former path, resolved while the row and its terms still exist. */
interface Taken {
	entry: EntrySnapshot;
	urlPattern: string | null;
	url: string | null;
}

/** Snapshots taken in content:beforeDelete, while the row still exists (a permanent delete removes it). */
const beforeDelete = new Map<string, Taken>();

export function removedModule(options: Options) {
	async function db(): Promise<D1Database | undefined> {
		try {
			return (await workerEnv())[options.database ?? "DB"] as D1Database | undefined;
		} catch {
			return undefined;
		}
	}

	async function snapshot(collection: string, id: string) {
		const d1 = await db();
		if (!d1 || !COLLECTION_SLUG.test(collection)) return null;
		const info = (await readCollections(d1, [collection])).get(collection);
		const row = await d1.prepare(`SELECT * FROM "ec_${collection}" WHERE id = ?`).bind(id).first<Record<string, unknown>>();
		if (!row) return null;
		const entry = snapshotFromRow(row, info?.titleField ?? null);
		return { entry, urlPattern: info?.urlPattern ?? null, url: await formerUrl(d1, collection, entry) };
	}

	/** The entry's public path via the pack-wide resolver (honors the site's `urls` overrides). */
	async function formerUrl(d1: D1Database, collection: string, entry: EntrySnapshot): Promise<string | null> {
		if (!entry.slug) return null;
		return entryUrl(d1, collection, { id: entry.id, slug: entry.slug, publishedAt: entry.publishedAt, locale: entry.locale }).catch(() => null);
	}

	async function record(ctx: PluginContext, collection: string, reason: RemovalReason, taken: Taken | null) {
		if (!taken) return;
		const pending = buildPending(collection, taken.entry, { url: taken.url, urlPattern: taken.urlPattern }, reason);
		if (!pending) return;
		const existing = await store(ctx).get(pending.id);
		if (existing) return; // Keep the first record (e.g. trashed, then permanently deleted).
		await store(ctx).put(pending.id, pending);
		ctx.log.info("Removed content recorded", { url: pending.url, reason });
	}

	/**
	 * The entry is back (restored, or republished): drop its pending decision,
	 * and delete the rule its decision created while that rule is still ours
	 * and, on publish, the entry is back at the same URL. A rule kept because
	 * the entry came back at another URL stays remembered, so a later publish
	 * back at the old URL still undoes it.
	 */
	async function comeBack(ctx: PluginContext, collection: string, content: Record<string, unknown>, reason: "restore" | "publish") {
		const id = pendingId(collection, String(content.id));
		await store(ctx).delete(id);
		const done = await applied(ctx).get(id);
		if (!done) return;
		const d1 = await db();
		if (!d1) return;
		const rule = await getRule(d1, done.ruleId);
		if (!appliedStillOurs(done, rule)) {
			await applied(ctx).delete(id); // Edited, replaced, or deleted since: no longer ours to undo.
			return;
		}
		let currentUrl: string | null = null;
		if (reason === "publish") {
			const info = (await readCollections(d1, [collection])).get(collection);
			currentUrl = await formerUrl(d1, collection, snapshotFromContent(content, info?.titleField ?? null));
		}
		if (!shouldDropApplied(done, rule, currentUrl, reason)) return;
		await applied(ctx).delete(id);
		await deleteRule(d1, done.ruleId);
		await noteRedirectsChanged(d1);
		await purgePageCache({ tags: [REDIRECTS_TAG] });
		ctx.log.info("Removed content rule undone", { url: done.url, reason });
	}

	/**
	 * Ids of these pending entries that are live after all (published, not in
	 * the trash): a trash that failed after it was recorded, or a decision
	 * recorded for an entry that was brought back without the hooks firing.
	 * One query per collection; a collection that can't be read counts as
	 * not live.
	 */
	async function liveIds(d1: D1Database, items: PendingDecision[]): Promise<Set<string>> {
		const live = new Set<string>();
		for (const [collection, ids] of idsByCollection(items)) {
			if (!COLLECTION_SLUG.test(collection)) continue;
			try {
				const { results } = await d1
					.prepare(`SELECT id FROM "ec_${collection}" WHERE status = 'published' AND deleted_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`)
					.bind(...ids)
					.all<{ id: string }>();
				for (const row of results) live.add(pendingId(collection, String(row.id)));
			} catch {
				// Collection gone or renamed: nothing there is live.
			}
		}
		return live;
	}

	/** Forget pending decisions whose entries are live again; the rest, in order. */
	async function dropLive(ctx: PluginContext, items: PendingDecision[]): Promise<PendingDecision[]> {
		if (!items.length) return items;
		const d1 = await db();
		if (!d1) return items;
		const live = await liveIds(d1, items);
		if (!live.size) return items;
		for (const id of live) await store(ctx).delete(id);
		ctx.log.info("Removed content forgotten: entries are live", { ids: [...live] });
		return items.filter((item) => !live.has(item.id));
	}

	const describeRule = (rule: { type: number; target: string; enabled: boolean }) =>
		`${rule.type === 410 ? "410 Gone" : `${rule.type} → ${rule.target}`}${rule.enabled ? "" : ", disabled"}`;

	const hooks = {
		"content:beforeDelete": async (event: { id: string; collection: string }, ctx: PluginContext) => {
			try {
				const taken = await snapshot(event.collection, event.id);
				if (beforeDelete.size > 500) beforeDelete.clear(); // Deletes that never completed.
				if (taken) beforeDelete.set(pendingId(event.collection, event.id), taken);
				// Record now, before the delete's response, so the admin's prompt finds it at once.
				await record(ctx, event.collection, "deleted", taken);
			} catch {
				// Never block a delete.
			}
			return undefined;
		},

		"content:afterDelete": async (event: { id: string; collection: string; permanent: boolean }, ctx: PluginContext) => {
			const key = pendingId(event.collection, event.id);
			const taken = beforeDelete.get(key) ?? (await snapshot(event.collection, event.id));
			beforeDelete.delete(key);
			await record(ctx, event.collection, "deleted", taken);
		},

		"content:afterUnpublish": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			const d1 = await db();
			const info = d1 ? (await readCollections(d1, [event.collection])).get(event.collection) : undefined;
			const entry = snapshotFromContent(event.content, info?.titleField ?? null);
			await record(ctx, event.collection, "unpublished", {
				entry,
				urlPattern: info?.urlPattern ?? null,
				url: d1 ? await formerUrl(d1, event.collection, entry) : null,
			});
		},

		"content:afterPublish": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			await comeBack(ctx, event.collection, event.content, "publish");
		},

		// Restored entries come back as drafts; restoring says the content is coming back, so drop the decision and its rule.
		"content:afterRestore": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			await comeBack(ctx, event.collection, event.content, "restore");
		},
	};

	const routes = {
		"redirects/removed": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, TRASH_PROMPT_FEATURE);
				const { items } = await store(ctx).query({ orderBy: { at: "desc" }, limit: 100 });
				return {
					items: await dropLive(
						ctx,
						items.map((i) => i.data),
					),
				};
			},
		},

		"redirects/removed/resolve": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, TRASH_PROMPT_FEATURE);
				const input = parseInput(
					z.object({
						id: z.string().max(300),
						action: z.enum(["redirect", "gone", "dismiss"]),
						target: z.string().max(2000).optional(),
						type: z.number().int().optional(),
					}),
					ctx.input,
				);
				const pending = await store(ctx).get(input.id);
				if (!pending) throw PluginRouteError.notFound("That removed entry is no longer pending.");
				let rule = null;
				if (input.action !== "dismiss") {
					const d1 = await db();
					if (!d1) throw PluginRouteError.badRequest("Redirects: missing database binding.");
					if (!(await dropLive(ctx, [pending])).length) {
						throw PluginRouteError.conflict(`“${pending.title}” is live again at ${pending.url}; there is nothing to redirect.`);
					}
					// Never overwrite a rule someone made for this path (and never adopt it: a restore would delete it).
					const existing = await findExactRuleAny(d1, pending.url);
					if (existing) {
						throw PluginRouteError.conflict(
							`A redirect already exists for ${existing.source} (${describeRule(existing)}). Keep it and dismiss this entry under Redirects → Removed content, or change it under Redirects.`,
						);
					}
					try {
						rule = await saveRule(d1, {
							source: pending.url,
							target: input.action === "gone" ? "" : input.target,
							type: input.action === "gone" ? 410 : (input.type ?? 301),
							note: `Removed: ${pending.title}`.slice(0, 500),
						});
					} catch (error) {
						if (error instanceof RedirectValidationError) throw PluginRouteError.badRequest(error.message);
						throw error;
					}
					await noteRedirectsChanged(d1);
					await applied(ctx).put(pending.id, {
						id: pending.id,
						collection: pending.collection,
						entryId: pending.entryId,
						url: pending.url,
						ruleId: rule.id,
						action: input.action,
						at: new Date().toISOString(),
					});
				}
				await store(ctx).delete(pending.id);
				ctx.log.info("Removed content resolved", { url: pending.url, action: input.action });
				return { resolved: pending.id, rule };
			},
		}),
	};

	return { hooks, routes, storage: removedStorage };
}

/**
 * "Slug changes" (feature "redirects.slugChanges"): when a published entry's
 * public URL changes (a new slug, or a new category or parent page), add a 301
 * from the old URL to the new one.
 *
 * EmDash makes its own slug-change redirect from the collection's URL pattern,
 * which can't express category or parent paths (posts here have no pattern, so
 * it writes /posts/<old> → /posts/<new>, which aren't real URLs). This uses the
 * pack's URL resolver (src/core/content-url.ts), the same one the sitemaps and
 * breadcrumbs use, so the rule matches the URL readers and search engines saw.
 *
 * The old URL is remembered per entry in plugin storage: recorded before a save
 * (from the live row) and after every save or publish. Rules are made with a
 * "Slug change:" note; only those are ever edited or deleted.
 */
import type { PluginContext, RedirectAccessWithWrite } from "emdash";

import { COLLECTION_SLUG, entryUrl, hostDefaultLocale, readCollections } from "../core/content-url.js";
import { REDIRECTS_TAG, purgePageCache } from "../pageCache/lib.js";
import { workerEnv } from "../shared.js";
import { noteRedirectsChanged } from "./middleware.js";
import { type EntrySnapshot, snapshotFromContent, snapshotFromRow } from "./removed-core.js";
import { deleteRule, ensureTable, normalizePath, saveRule } from "./rules.js";
import { type PlanRule, SLUG_NOTE_PREFIX, planSlugChange } from "./slug-core.js";

export const SLUG_CHANGES_FEATURE = "redirects.slugChanges";
const STORE = "redirects_urls";

export const slugStorage = { [STORE]: { indexes: ["at"] } };

interface KnownUrl {
	url: string;
	at: string;
}

// any: plugin storage collections are untyped here.
const urls = (ctx: PluginContext) => (ctx.storage as Record<string, any>)[STORE] as {
	get(id: string): Promise<KnownUrl | null>;
	put(id: string, data: KnownUrl): Promise<void>;
};

const key = (collection: string, id: string) => `${collection}:${id}`;
const live = (entry: EntrySnapshot) => entry.status === "published" && Boolean(entry.slug);
/**
 * Only default-locale entries: translations can share a slug with the default-locale
 * entry, and the resolver's database path doesn't add a locale prefix, so a translation's
 * rename would write a rule over the live default-locale page.
 */
const handled = async (entry: EntrySnapshot) => !entry.locale || entry.locale === (await hostDefaultLocale());
/** How long beforeSave may spend recording a URL: EmDash fails the save if a beforeSave hook times out (5 s). */
const BEFORE_SAVE_BUDGET_MS = 1500;

/** The group EmDash files its own slug-change redirects under (RedirectRepository.createAutoRedirect). */
export const EMDASH_AUTO_GROUP = "Auto: slug change";
/** Pages of EmDash's auto rows read per change (100 a page): a site with more matches than this keeps the rest. */
const AUTO_PAGES = 10;

/** The part of EmDash's redirects API (ctx.redirects, capability redirects:write) the slug changes use. */
export type AutoRedirectsApi = Pick<RedirectAccessWithWrite, "list" | "get" | "delete">;

const trimSlash = (path: string) => path.replace(/\/+$/, "");

/**
 * Delete the redirect EmDash made for the same change (its "Auto: slug change" rows),
 * through EmDash's redirects API, so EmDash's write lock, its loop cache and the
 * redirects it publishes to its middleware all see the delete.
 * EmDash builds them from the collection's URL pattern: without one it writes
 * /<collection>/<slug> paths that don't exist, and for a nested page it writes a
 * top-level /<old> that can hijack a real page there. Its middleware runs before
 * the pack's, so its rule would also answer first (without the trailing slash).
 * Only auto rows from the old URL (or URLs whose rules were just pointed at the new one,
 * since EmDash collapses its chains the same way) whose destination ends in the new
 * slug; EmDash's own table and API keep working for everything else.
 * Matching (as the SQL delete before 0.36.0 did): the source, trailing slashes removed, is one
 * of those paths exactly; the destination, trailing slashes removed, ends in "/<new slug>"
 * (ignoring ASCII case). A row changed since it was listed is left alone (its revision no
 * longer matches). Returns how many rows were deleted; 0 without the API.
 */
export async function dropEmDashAuto(ctx: { redirects?: Partial<AutoRedirectsApi> }, collection: string, from: string, newSlug: string | null, earlier: string[] = []): Promise<number> {
	const api = ctx.redirects;
	if (typeof api?.list !== "function" || typeof api.get !== "function" || typeof api.delete !== "function") return 0;
	const oldSlug = normalizePath(from).split("/").pop();
	if (!oldSlug || !newSlug) return 0;
	const slugs = [oldSlug, ...earlier.map((path) => normalizePath(path).split("/").pop() ?? "")].filter(Boolean);
	const sources = new Set([normalizePath(from), ...earlier.map(normalizePath), ...slugs.flatMap((slug) => [`/${collection}/${slug}`, `/${slug}`])]);
	const ending = `/${newSlug}`.toLowerCase();
	const matches = (row: { source: string; destination: string; auto: boolean; groupName: string | null }) =>
		row.auto && row.groupName === EMDASH_AUTO_GROUP && sources.has(trimSlash(row.source)) && trimSlash(row.destination).toLowerCase().endsWith(ending);
	let removed = 0;
	let cursor: string | undefined;
	for (let page = 0; page < AUTO_PAGES; page++) {
		// `search` (source or destination containing the new slug) keeps the pages short.
		const result = await api.list({ auto: true, group: EMDASH_AUTO_GROUP, search: newSlug, limit: 100, ...(cursor ? { cursor } : {}) });
		for (const row of result.items) {
			if (!matches(row)) continue;
			const current = await api.get(row.id);
			if (!current || !matches(current.redirect)) continue;
			try {
				if (await api.delete(row.id, { _rev: current._rev })) removed++;
			} catch {
				// Changed or deleted since it was read: leave it.
			}
		}
		if (!result.hasMore || !result.cursor) break;
		cursor = result.cursor;
	}
	return removed;
}

export function slugChangesModule(options: { database?: string }) {
	async function db(): Promise<D1Database | undefined> {
		try {
			return (await workerEnv())[options.database ?? "DB"] as D1Database | undefined;
		} catch {
			return undefined;
		}
	}

	const urlOf = (d1: D1Database, collection: string, entry: EntrySnapshot) =>
		entry.slug ? entryUrl(d1, collection, { id: entry.id, slug: entry.slug, publishedAt: entry.publishedAt, locale: entry.locale }).catch(() => null) : Promise.resolve(null);

	/** Every exact rule whose source or target is either URL. */
	async function related(d1: D1Database, a: string, b: string): Promise<PlanRule[]> {
		await ensureTable(d1);
		const paths = [normalizePath(a), normalizePath(b)];
		const { results } = await d1
			.prepare("SELECT id, source, target, note FROM coywolf_redirects WHERE is_regex = 0 AND (source IN (?, ?) OR target IN (?, ?, ?, ?))")
			.bind(...paths, ...paths, `${paths[0]}/`, `${paths[1]}/`)
			.all<PlanRule>();
		return results;
	}

	async function moved(ctx: PluginContext, d1: D1Database, collection: string, entry: EntrySnapshot, from: string, to: string) {
		const rules = await related(d1, from, to);
		const plan = planSlugChange(from, to, rules);
		if (plan.kind === "none") return;
		for (const id of plan.deleteIds) await deleteRule(d1, id);
		for (const id of plan.retargetIds) {
			await d1.prepare("UPDATE coywolf_redirects SET target = ?, updated_at = ? WHERE id = ?").bind(to, new Date().toISOString(), id).run();
		}
		if (plan.keptManual) {
			ctx.log.info("Slug change: a redirect for the old URL already exists; left as is", { from, to, rule: plan.keptManual.id });
		} else {
			await saveRule(d1, {
				...(plan.upsert.id ? { id: plan.upsert.id } : {}),
				source: from,
				target: to,
				type: 301,
				note: `${SLUG_NOTE_PREFIX} ${entry.title ?? entry.slug ?? entry.id}`.slice(0, 500),
			});
		}
		// EmDash collapses its own chains too, so its rows from those earlier URLs now point at the new one.
		const retargetedSources = rules.filter((r) => plan.retargetIds.includes(r.id)).map((r) => r.source);
		const replaced = await dropEmDashAuto(ctx, collection, from, entry.slug, retargetedSources).catch((error: unknown) => {
			ctx.log.warn("Slug change: could not remove EmDash's own redirect for the same change", { from, error: String(error) });
			return 0;
		});
		await noteRedirectsChanged(d1);
		await purgePageCache({ tags: [REDIRECTS_TAG] });
		ctx.log.info("Slug change redirect", { collection, from, to, deleted: plan.deleteIds.length, retargeted: plan.retargetIds.length, emdashAutoRemoved: replaced });
	}

	/**
	 * An entry is live at `url`: delete our rules from that URL (left by another entry
	 * that used to be there, or by this one before it moved back). Exact rules are read
	 * before pages render, so one left behind would send readers away from the live page.
	 */
	async function freeUrl(ctx: PluginContext, d1: D1Database, url: string) {
		await ensureTable(d1);
		const { results } = await d1
			.prepare("SELECT id FROM coywolf_redirects WHERE is_regex = 0 AND source = ? AND note LIKE ?")
			.bind(normalizePath(url), `${SLUG_NOTE_PREFIX}%`)
			.all<{ id: string }>();
		if (!results.length) return;
		for (const row of results) await deleteRule(d1, row.id);
		await noteRedirectsChanged(d1);
		await purgePageCache({ tags: [REDIRECTS_TAG] });
		ctx.log.info("Slug change redirect removed: the URL is live again", { url, rules: results.length });
	}

	/** Remember a live entry's URL, from its row as stored now (before a save changes it). */
	async function rememberStored(ctx: PluginContext, collection: string, id: string) {
		if (!COLLECTION_SLUG.test(collection) || (await urls(ctx).get(key(collection, id)))) return;
		const d1 = await db();
		if (!d1) return;
		const info = (await readCollections(d1, [collection])).get(collection);
		const row = await d1.prepare(`SELECT * FROM "ec_${collection}" WHERE id = ? AND deleted_at IS NULL`).bind(id).first<Record<string, unknown>>();
		if (!row) return;
		const entry = snapshotFromRow(row, info?.titleField ?? null);
		if (!live(entry) || !(await handled(entry))) return;
		const url = await urlOf(d1, collection, entry);
		if (url) await urls(ctx).put(key(collection, id), { url, at: new Date().toISOString() });
	}

	/** After a save or publish: compare the live URL with the remembered one, redirect if it moved, remember the new one. */
	async function settle(ctx: PluginContext, collection: string, content: Record<string, unknown>) {
		if (!COLLECTION_SLUG.test(collection) || content.id == null) return;
		const d1 = await db();
		if (!d1) return;
		const info = (await readCollections(d1, [collection])).get(collection);
		const entry = snapshotFromContent(content, info?.titleField ?? null);
		if (!live(entry) || !(await handled(entry))) return;
		const url = await urlOf(d1, collection, entry);
		if (!url) return;
		const id = key(collection, entry.id);
		const known = await urls(ctx).get(id);
		if (known?.url === url) return;
		if (known) await moved(ctx, d1, collection, entry, known.url, url);
		else await freeUrl(ctx, d1, url);
		await urls(ctx).put(id, { url, at: new Date().toISOString() });
	}

	const hooks = {
		"content:beforeSave": async (event: { collection: string; id?: string; isNew: boolean }, ctx: PluginContext) => {
			if (event.isNew || !event.id) return undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<"late">((resolve) => {
				timer = setTimeout(() => resolve("late"), BEFORE_SAVE_BUDGET_MS);
			});
			try {
				const outcome = await Promise.race([rememberStored(ctx, event.collection, event.id).then(() => "done" as const), deadline]);
				if (outcome === "late") ctx.log.warn("Slug changes: recording the current URL took too long; skipped", { collection: event.collection, id: event.id });
			} catch (error) {
				ctx.log.warn("Slug changes: could not record the current URL", { error: String(error) });
			} finally {
				clearTimeout(timer);
			}
			return undefined; // Never changes or blocks the save.
		},
		"content:afterSave": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			await settle(ctx, event.collection, event.content).catch((error: unknown) => ctx.log.warn("Slug changes: could not check the URL", { error: String(error) }));
		},
		"content:afterPublish": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			await settle(ctx, event.collection, event.content).catch((error: unknown) => ctx.log.warn("Slug changes: could not check the URL", { error: String(error) }));
		},
	};

	return { hooks, storage: slugStorage };
}

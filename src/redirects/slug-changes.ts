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
import type { PluginContext } from "emdash";

import { COLLECTION_SLUG, entryUrl, hostDefaultLocale, readCollections } from "../core/content-url.js";
import { REDIRECTS_TAG, purgePageCache } from "../pageCache/lib.js";
import { workerEnv } from "../shared.js";
import { invalidateRedirectCache } from "./middleware.js";
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

// biome-ignore lint/suspicious/noExplicitAny: plugin storage collections are untyped here.
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
		const plan = planSlugChange(from, to, await related(d1, from, to));
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
		invalidateRedirectCache();
		await purgePageCache({ tags: [REDIRECTS_TAG] });
		ctx.log.info("Slug change redirect", { collection, from, to, deleted: plan.deleteIds.length, retargeted: plan.retargetIds.length });
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
		invalidateRedirectCache();
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

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
import { deleteRule, ensureTable, normalizePath, saveRule, sourceKey, storedForms, validate } from "./rules.js";
import { type PlanRule, SLUG_NOTE_PREFIX, isOurs, planSlugChange } from "./slug-core.js";

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
	putMany(items: Array<{ id: string; data: KnownUrl }>): Promise<void>;
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
/**
 * Pages of EmDash's auto rows read per change (100 a page, narrowed by the new slug): every page until
 * the last, up to this many (20,000 rows), which only a site with a runaway number of matching rows
 * reaches; the log then says so and the rest are left.
 */
export const AUTO_PAGES = 200;

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
export async function dropEmDashAuto(
	ctx: { redirects?: Partial<AutoRedirectsApi>; log?: { warn(message: string, data?: unknown): void } },
	collection: string,
	from: string,
	newSlug: string | null,
	earlier: string[] = [],
	maxPages = AUTO_PAGES,
): Promise<number> {
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
	for (let page = 0; ; page++) {
		if (page >= maxPages) {
			ctx.log?.warn("Slug change: stopped looking through EmDash's slug-change redirects after the page limit; the rest are left", { pages: maxPages, newSlug, removed });
			break;
		}
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

/** An entry whose URL changed without a save of its own: a parent page moved, or Child pages was turned on or off. */
export interface UrlMove {
	collection: string;
	entryId: string;
	/** For the rule's note ("Slug change: <title>"). */
	title: string;
	from: string;
	to: string;
}

/** A redirect rule, as the admin names it: its source and where it sends readers. */
export interface RuleRef {
	source: string;
	target: string;
}

/** A move whose 301 isn't written, because a rule someone else made (`rule`) sends its new URL back to the old one. */
export interface MoveLoop extends UrlMove {
	rule: RuleRef;
}

/** A page's new URL that a rule someone else made (`rule`) still sends elsewhere: the page can't be reached there. */
export interface MoveShadow {
	url: string;
	rule: RuleRef;
}

type KnownRule = PlanRule & { enabled?: number | null };

/** Rules followed from the new URL when looking for a way back to the old one. */
const LOOP_HOPS = 5;
/** A rule's target as a path key (how sources are stored), or null when it leaves the site. */
const targetKey = (target: string) => (target.startsWith("/") && !target.startsWith("//") ? sourceKey(target.split(/[?#]/)[0] as string) : null);

/**
 * The rule that would make `from` → `to` a loop: an enabled exact rule at `to` that Slug changes didn't
 * make and that sends readers back to `from`, at once or through other exact rules (up to LOOP_HOPS).
 * coywolf.com has `/coywolf-seo` → `/apps/coywolf-seo/` from its WordPress move: a page that goes back to
 * `/coywolf-seo/` must not get `/apps/coywolf-seo` → `/coywolf-seo/` while that rule exists. (Our own rule
 * at `to` isn't one: planSlugChange deletes it.) `known` are rules already read, every rule at `to` among
 * them (both callers that pass it have read the rules for the move's two URLs): with it, a move with no
 * rule at `to` costs no query. Rules further along a chain are read here. Null when the 301 is safe to write.
 */
export async function loopingRule(d1: D1Database, from: string, to: string, known?: Iterable<KnownRule>): Promise<RuleRef | null> {
	const goal = sourceKey(from);
	const loaded = [...(known ?? [])];
	const at = async (key: string): Promise<KnownRule[]> => {
		const hit = loaded.filter((r) => sourceKey(r.source) === key);
		if (hit.length) return hit;
		const forms = storedForms(key);
		const { results } = await d1
			.prepare(`SELECT id, source, target, note, enabled FROM coywolf_redirects WHERE is_regex = 0 AND source IN (${forms.map(() => "?").join(", ")})`)
			.bind(...forms)
			.all<KnownRule>();
		return results;
	};
	const start = sourceKey(to);
	const atStart = known ? loaded.filter((r) => sourceKey(r.source) === start) : await at(start);
	const first = atStart.find((r) => !isOurs(r) && r.enabled !== 0);
	if (!first) return null;
	const seen = new Set([start]);
	let rule: KnownRule | undefined = first;
	for (let hop = 0; rule && hop < LOOP_HOPS; hop++) {
		const next = targetKey(rule.target);
		if (!next) return null;
		if (next === goal) return { source: first.source, target: first.target };
		if (seen.has(next)) return null;
		seen.add(next);
		rule = (await at(next)).find((r) => r.enabled !== 0);
	}
	return null;
}

/** Moves read for related rules per query (each brings up to ~14 bound values; D1 allows 100). */
const MOVES_PER_READ = 6;
/** Statements per D1 batch when writing the rules. */
const WRITES_PER_BATCH = 50;

/** Every spelling a rule may store for these URLs as a source, and as a target (what related() matches). */
function relatedKeys(urls: string[]): { sources: string[]; targets: string[] } {
	const paths = urls.map(normalizePath);
	return {
		sources: [...new Set([...urls.flatMap((u) => storedForms(u)), ...paths])],
		targets: [...new Set([...paths, ...paths.map((p) => sourceKey(p)), ...paths.map((p) => `${p}/`)])],
	};
}

/**
 * The 301s for entries whose URL changed together (the pages below a page that moved;
 * every nested page when Child pages is turned on or off), planned like a slug change
 * (src/redirects/slug-core.ts: earlier rules retargeted, rules from a URL that's live again
 * removed, someone else's rule for the old URL kept) and written in batches: a cascade of
 * a few hundred pages stays within D1's queries per invocation. Each entry's remembered
 * URL is updated too, so its next save doesn't see a move. EmDash makes no redirects of its
 * own for these (no slug changed), so there are none of its rows to remove.
 *
 * Rules someone else made are never changed. One at a page's new URL either:
 * - sends it back to the old URL (`loops`): our 301 would make a loop, so nothing is written for
 *   that move (its entry's remembered URL is still updated: the page is at its new URL);
 * - sends it elsewhere (`shadowed`): our 301 is written, but the page can't be reached at its new URL.
 * Both name the rule, for the admin to say which one to delete.
 *
 * Returns how many rules were written or kept, with `loops` and `shadowed`.
 */
export async function applyUrlMoves(ctx: PluginContext, d1: D1Database, moves: UrlMove[]): Promise<{ written: number; kept: number; shadowed: MoveShadow[]; loops: MoveLoop[] }> {
	const real = moves.filter((m) => m.from && m.to && sourceKey(m.from) !== sourceKey(m.to));
	if (!real.length) return { written: 0, kept: 0, shadowed: [], loops: [] };
	await ensureTable(d1);
	const rules = new Map<string, KnownRule>();
	for (let i = 0; i < real.length; i += MOVES_PER_READ) {
		const { sources, targets } = relatedKeys(real.slice(i, i + MOVES_PER_READ).flatMap((m) => [m.from, m.to]));
		const { results } = await d1
			.prepare(`SELECT id, source, target, note, enabled FROM coywolf_redirects WHERE is_regex = 0 AND (source IN (${sources.map(() => "?").join(", ")}) OR target IN (${targets.map(() => "?").join(", ")}))`)
			.bind(...sources, ...targets)
			.all<KnownRule>();
		for (const rule of results) rules.set(rule.id, rule);
	}
	const writes: D1PreparedStatement[] = [];
	const now = new Date().toISOString();
	let written = 0;
	let kept = 0;
	const shadowed: MoveShadow[] = [];
	const loops: MoveLoop[] = [];
	for (const move of real) {
		const keys = relatedKeys([move.from, move.to]);
		const related = [...rules.values()].filter((r) => keys.sources.includes(r.source) || keys.targets.includes(r.target));
		const inTheWay = related.find((r) => !isOurs(r) && r.enabled !== 0 && sourceKey(r.source) === sourceKey(move.to));
		if (inTheWay) {
			const loop = await loopingRule(d1, move.from, move.to, rules.values());
			if (loop) {
				loops.push({ ...move, rule: loop });
				continue;
			}
			shadowed.push({ url: move.to, rule: { source: inTheWay.source, target: inTheWay.target } });
		}
		const plan = planSlugChange(move.from, move.to, related);
		if (plan.kind === "none") continue;
		for (const id of plan.deleteIds) {
			writes.push(d1.prepare("DELETE FROM coywolf_redirects WHERE id = ?").bind(id));
			rules.delete(id);
		}
		for (const id of plan.retargetIds) {
			writes.push(d1.prepare("UPDATE coywolf_redirects SET target = ?, updated_at = ? WHERE id = ?").bind(move.to, now, id));
			const rule = rules.get(id);
			if (rule) rule.target = move.to;
		}
		if (plan.keptManual) {
			kept++;
			continue;
		}
		let rule: ReturnType<typeof validate>;
		try {
			rule = validate({ source: move.from, target: move.to, type: 301, note: `${SLUG_NOTE_PREFIX} ${move.title}`.slice(0, 500) });
		} catch (error) {
			ctx.log.warn("Child pages: skipped a redirect that isn't valid", { from: move.from, to: move.to, error: String(error) });
			continue;
		}
		const id = plan.upsert.id ?? crypto.randomUUID();
		if (plan.upsert.id) {
			writes.push(d1.prepare("UPDATE coywolf_redirects SET source = ?, target = ?, type = 301, enabled = 1, note = ?, updated_at = ? WHERE id = ?").bind(rule.source, rule.target, rule.note ?? null, now, id));
		} else {
			writes.push(
				d1
					.prepare("INSERT INTO coywolf_redirects (id, source, target, type, is_regex, enabled, note, created_at, updated_at) VALUES (?, ?, ?, 301, 0, 1, ?, ?, ?) ON CONFLICT(source, is_regex) DO UPDATE SET target = excluded.target, note = excluded.note, updated_at = excluded.updated_at")
					.bind(id, rule.source, rule.target, rule.note ?? null, now, now),
			);
		}
		rules.set(id, { id, source: rule.source, target: rule.target, note: rule.note ?? null });
		written++;
	}
	for (let i = 0; i < writes.length; i += WRITES_PER_BATCH) await d1.batch(writes.slice(i, i + WRITES_PER_BATCH));
	const store = urls(ctx) as ReturnType<typeof urls> | undefined;
	if (typeof store?.putMany === "function") {
		await store
			.putMany(real.map((m) => ({ id: key(m.collection, m.entryId), data: { url: m.to, at: now } })))
			.catch((error: unknown) => ctx.log.warn("Child pages: could not remember the new URLs", { error: String(error) }));
	}
	if (writes.length) {
		await noteRedirectsChanged(d1);
		await purgePageCache({ tags: [REDIRECTS_TAG] });
	}
	if (shadowed.length) ctx.log.warn("Child pages: other redirects send these pages' new URLs elsewhere; remove them on the Redirect Manager page", { urls: shadowed.slice(0, 20) });
	if (loops.length) {
		ctx.log.warn("Child pages: these moves got no redirect, because a redirect someone else made sends the new URL back to the old one; delete it on the Redirect Manager page", {
			moves: loops.slice(0, 20).map((l) => ({ from: l.from, to: l.to, rule: `${l.rule.source} → ${l.rule.target}` })),
		});
	}
	return { written, kept, shadowed, loops };
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
	async function related(d1: D1Database, a: string, b: string): Promise<KnownRule[]> {
		await ensureTable(d1);
		const paths = [normalizePath(a), normalizePath(b)];
		// Sources in every stored spelling (src/redirects/paths.ts storedForms); targets as written, with or without the slash.
		const sources = [...new Set([...storedForms(a), ...storedForms(b), ...paths])];
		const targets = [...new Set([...paths, ...paths.map((p) => sourceKey(p)), ...paths.map((p) => `${p}/`)])];
		const { results } = await d1
			.prepare(
				`SELECT id, source, target, note, enabled FROM coywolf_redirects WHERE is_regex = 0 AND (source IN (${sources.map(() => "?").join(", ")}) OR target IN (${targets.map(() => "?").join(", ")}))`,
			)
			.bind(...sources, ...targets)
			.all<KnownRule>();
		return results;
	}

	async function moved(ctx: PluginContext, d1: D1Database, collection: string, entry: EntrySnapshot, from: string, to: string) {
		const rules = await related(d1, from, to);
		// A rule someone else made sends the new URL back to the old one (a page that returns to a URL that was
		// redirected by hand): ours would make a loop. Left unwritten, and said; Child Pages lists it when the page
		// is one of its collections' (src/childPages/pack.ts), and adds the 301 once that rule is deleted.
		const loop = await loopingRule(d1, from, to, rules);
		if (loop) {
			ctx.log.warn("Slug change: no redirect added, because another redirect sends the new URL back to the old one (a loop). Delete that redirect on the Redirect Manager page", {
				collection,
				from,
				to,
				rule: `${loop.source} → ${loop.target}`,
			});
			return;
		}
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
		const forms = storedForms(url);
		const { results } = await d1
			.prepare(`SELECT id FROM coywolf_redirects WHERE is_regex = 0 AND source IN (${forms.map(() => "?").join(", ")}) AND note LIKE ?`)
			.bind(...forms, `${SLUG_NOTE_PREFIX}%`)
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

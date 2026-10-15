/**
 * The link inventory in plugin storage.
 *
 * - links_urls: one row per distinct href (id = hash of the href as written),
 *   with its check result, schedule and ignore flag.
 * - links_refs: one row per (entry, href) with the entry's title and the
 *   link's anchor text and kinds, so the admin can say where a link is used.
 *   How many entries use a link is counted from these rows, never kept as a
 *   running total, so overlapping saves and scans can't skew it.
 *
 * Entries are indexed from their latest saved version (the pending draft when
 * a collection uses revisions), which is what an editor fixing a link sees.
 *
 * D1 allows 100 bound parameters per statement, so id lists are chunked to
 * CHUNK; and since database calls count toward a Worker's subrequest limit,
 * long-running work is metered with Ops.
 */
import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import { PLUGIN_ID } from "../core/features.js";
import { workerEnv } from "../shared.js";
import { type IgnoreRule, type LinkStatus, isIgnored } from "./classify.js";
import { type FoundLink, type LinkKind, bareHost, extractEntryLinks, isInternal, resolveHref } from "./pt.js";

export const STORAGE = {
	links_urls: {
		indexes: [
			"status",
			"host",
			"internal",
			"ignored",
			"rank",
			"url",
			"checkedAt",
			"resolved",
			["ignored", "status"],
			["ignored", "nextCheckAt"],
		],
	},
	links_refs: {
		indexes: ["urlId", "entryKey", "seenAt"],
	},
};

/** Sort order for "worst first". */
export const STATUS_RANK: Record<LinkStatus, number> = { broken: 0, error: 1, blocked: 2, redirect: 3, unchecked: 4, ok: 5 };

export interface UrlRow {
	url: string;
	/** Absolute URL that gets checked; null when the href can't be resolved. */
	resolved: string | null;
	host: string;
	internal: boolean;
	ignored: boolean;
	status: LinkStatus;
	rank: number;
	code: number | null;
	finalUrl: string | null;
	chain: Array<{ url: string; code: number }>;
	note: string;
	checkedAt: string | null;
	/** "" until first checked, so unchecked links sort first. */
	nextCheckAt: string;
	firstSeen: string;
}

export interface RefRow {
	urlId: string;
	entryKey: string;
	collection: string;
	entryId: string;
	title: string;
	entryStatus: string;
	kinds: LinkKind[];
	anchors: string[];
	count: number;
	/** When the row was last written (the scan no longer rewrites unchanged rows, so nothing reads it). */
	seenAt: string;
}

export const IGNORES_KEY = "links:ignores";
export const SCAN_KEY = "links:scan";
const LEASE_KEY = "links:scan-lease";
const COUNTS_KEY = "links:counts";

/** Field types that can hold links. */
const LINK_FIELD_TYPES = new Set(["portableText", "blocks", "repeater", "url"]);

export function urls(ctx: PluginContext): StorageCollection<UrlRow> {
	return ctx.storage.links_urls as StorageCollection<UrlRow>;
}
export function refs(ctx: PluginContext): StorageCollection<RefRow> {
	return ctx.storage.links_refs as StorageCollection<RefRow>;
}

export async function urlId(href: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(href)));
	return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Metering and chunking ────────────────────────────────────────

/** Counts database statements (and requests) against a limit and a wall-clock deadline. */
export class Ops {
	used = 0;
	readonly limit: number;
	readonly deadline: number;
	constructor(limit = Number.POSITIVE_INFINITY, deadline = Number.POSITIVE_INFINITY) {
		this.limit = limit;
		this.deadline = deadline;
	}
	spend(n = 1): void {
		this.used += n;
	}
	get left(): number {
		return this.limit - this.used;
	}
	/** Whether there's room for `reserve` more operations before the limit and deadline. */
	has(reserve = 1): boolean {
		return this.used + reserve <= this.limit && Date.now() < this.deadline;
	}
}

/** Ids per statement: D1 binds at most 100 parameters, and storage adds its own. */
export const CHUNK = 90;

export function chunked<T>(items: T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export async function getMany<T>(collection: StorageCollection<T>, ids: string[], ops?: Ops): Promise<Map<string, T>> {
	const out = new Map<string, T>();
	for (const part of chunked([...new Set(ids)])) {
		ops?.spend();
		for (const [id, data] of await collection.getMany(part)) out.set(id, data);
	}
	return out;
}

export async function deleteMany<T>(collection: StorageCollection<T>, ids: string[], ops?: Ops): Promise<number> {
	let deleted = 0;
	for (const part of chunked([...new Set(ids)])) {
		ops?.spend();
		deleted += await collection.deleteMany(part);
	}
	return deleted;
}

export async function putMany<T>(collection: StorageCollection<T>, items: Array<{ id: string; data: T }>, ops?: Ops): Promise<void> {
	for (const part of chunked(items)) {
		ops?.spend(part.length); // One statement per row.
		await collection.putMany(part);
	}
}

/** Every row matching `where`, page by page. */
export async function queryAll<T>(
	collection: StorageCollection<T>,
	where?: Record<string, unknown>,
	options: { ops?: Ops; max?: number } = {},
): Promise<Array<{ id: string; data: T }>> {
	const max = options.max ?? 50_000;
	const out: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	do {
		options.ops?.spend();
		// biome-ignore lint/suspicious/noExplicitAny: WhereClause is EmDash's.
		const page = await collection.query({ where: where as any, limit: 100, cursor });
		out.push(...page.items);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && out.length < max);
	return out;
}

/**
 * SQL of refsWhere: one indexed field, compared for equality, with no ORDER BY.
 * Storage queries always sort (by created_at, id), and for that SQLite picks
 * the generic idx_plugin_storage_list index and scans every links_refs row of
 * the site; without the sort it uses the field's own expression index
 * (idx_plugin_coywolf-pack_links_refs_<field>), so a lookup reads only its rows.
 */
export const refsWhereSql = (field: "entryKey" | "urlId") =>
	`SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND json_extract(data, '$.${field}') = ?`;

/** The site's D1 binding, when there is one (none in tests or on other databases). */
async function d1(): Promise<D1Database | undefined> {
	const db = ((await workerEnv().catch(() => ({}))) as Record<string, unknown>).DB as D1Database | undefined;
	return db?.prepare ? db : undefined;
}

/**
 * Reference rows whose `field` equals `value`, in any order, read straight from
 * D1 (one statement, see refsWhereSql). These lookups run once per entry
 * indexed (hundreds per weekly scan), so they must use the index. Without a D1
 * binding (tests, other databases) it falls back to the storage API.
 */
export async function refsWhere(ctx: PluginContext, field: "entryKey" | "urlId", value: string, ops?: Ops): Promise<Array<{ id: string; data: RefRow }>> {
	const db = await d1();
	if (!db) return queryAll(refs(ctx), { [field]: value }, { ops });
	ops?.spend();
	const { results } = await db.prepare(refsWhereSql(field)).bind(PLUGIN_ID, "links_refs", value).all<{ id: string; data: string }>();
	return (results ?? []).map((row) => ({ id: row.id, data: JSON.parse(row.data) as RefRow }));
}

/** Rows whose `field` is any of `values`, chunked so each statement stays under D1's parameter limit. */
export async function queryIn<T>(
	collection: StorageCollection<T>,
	field: string,
	values: string[],
	ops?: Ops,
): Promise<Array<{ id: string; data: T }>> {
	const out: Array<{ id: string; data: T }> = [];
	for (const part of chunked([...new Set(values)])) out.push(...(await queryAll(collection, { [field]: { in: part } }, { ops })));
	return out;
}

export async function getIgnores(ctx: PluginContext): Promise<IgnoreRule[]> {
	return (await ctx.kv.get<IgnoreRule[]>(IGNORES_KEY)) ?? [];
}

/** The site URL from EmDash (astro config `site`, or the Site URL setting). Empty when neither is set. */
export function siteUrl(ctx: PluginContext): string {
	return ctx.site?.url ?? "";
}

// ── Summary counts (cached in KV) ────────────────────────────────

export type Counts = Record<LinkStatus | "all" | "ignored" | "internal" | "external", number>;

export async function getCounts(ctx: PluginContext, maxAgeMs = 10 * 60_000): Promise<Counts> {
	const cached = await ctx.kv.get<{ at: number; counts: Counts }>(COUNTS_KEY);
	if (cached && Date.now() - cached.at < maxAgeMs) return cached.counts;
	const statuses = Object.keys(STATUS_RANK) as LinkStatus[];
	const counts = { all: 0 } as Counts;
	for (const status of statuses) {
		counts[status] = await urls(ctx).count({ ignored: false, status });
		counts.all += counts[status];
	}
	counts.ignored = await urls(ctx).count({ ignored: true });
	counts.internal = await urls(ctx).count({ ignored: false, internal: true });
	counts.external = counts.all - counts.internal;
	await ctx.kv.set(COUNTS_KEY, { at: Date.now(), counts });
	return counts;
}

export async function invalidateCounts(ctx: PluginContext): Promise<void> {
	await ctx.kv.delete(COUNTS_KEY);
}

// ── Schema ───────────────────────────────────────────────────────

export interface CollectionLinkInfo {
	slug: string;
	label: string;
	titleField: string | null;
	revisions: boolean;
	fields: Array<{ slug: string; type: string }>;
}

let schemaCache: { at: number; map: Map<string, CollectionLinkInfo> } | null = null;

/** Collections with link-bearing fields (cached per isolate for a minute). */
export async function linkCollections(ctx: PluginContext): Promise<Map<string, CollectionLinkInfo>> {
	if (schemaCache && Date.now() - schemaCache.at < 60_000) return schemaCache.map;
	const map = new Map<string, CollectionLinkInfo>();
	const collections: CollectionSchemaInfo[] = (await ctx.schema?.listCollections()) ?? [];
	for (const c of collections) {
		const fields = c.fields.filter((f) => LINK_FIELD_TYPES.has(f.type)).map((f) => ({ slug: f.slug, type: f.type }));
		if (!fields.length) continue;
		map.set(c.slug, {
			slug: c.slug,
			label: c.label,
			titleField: c.titleField,
			revisions: c.supports.includes("revisions"),
			fields,
		});
	}
	schemaCache = { at: Date.now(), map };
	return map;
}

// ── Indexing ─────────────────────────────────────────────────────

export const entryKey = (collection: string, id: string) => `${collection}/${id}`;

function entryTitle(info: CollectionLinkInfo, item: { data: Record<string, unknown>; slug?: string | null; id: string }): string {
	const candidates = [info.titleField ? item.data[info.titleField] : undefined, item.data.title, item.data.name, item.slug, item.id];
	const title = candidates.find((v) => typeof v === "string" && v.trim()) as string;
	return title.trim().slice(0, 200);
}

/** The entry's latest saved data: its pending draft when it has one. */
export async function latestData(
	ctx: PluginContext,
	collection: string,
	item: { id: string; data: Record<string, unknown>; draftRevisionId?: string | null },
	ops?: Ops,
): Promise<Record<string, unknown>> {
	if (item.draftRevisionId && ctx.content?.getRevision) {
		try {
			ops?.spend();
			const draft = await ctx.content.getRevision(collection, item.id, item.draftRevisionId);
			if (draft?.data) return { ...item.data, ...draft.data };
		} catch (error) {
			ctx.log.warn("links: could not read draft revision", { collection, id: item.id, error: String(error) });
		}
	}
	return item.data;
}

function group(found: FoundLink[]): Map<string, { kinds: Set<LinkKind>; anchors: Set<string>; count: number }> {
	const map = new Map<string, { kinds: Set<LinkKind>; anchors: Set<string>; count: number }>();
	for (const link of found) {
		const g = map.get(link.href) ?? { kinds: new Set(), anchors: new Set(), count: 0 };
		g.kinds.add(link.kind);
		if (link.anchor && g.anchors.size < 3) g.anchors.add(link.anchor);
		g.count++;
		map.set(link.href, g);
	}
	return map;
}

/** Where an href points, given the site URL. */
export function locate(href: string, base: string, ignores: IgnoreRule[]): Pick<UrlRow, "resolved" | "host" | "internal" | "ignored"> {
	const resolved = resolveHref(href, base);
	return {
		resolved: resolved?.href ?? null,
		host: resolved ? bareHost(resolved.hostname) : "",
		internal: isInternal(href, base),
		ignored: resolved ? isIgnored(ignores, resolved.href) : false,
	};
}

function newUrlRow(href: string, base: string, ignores: IgnoreRule[], now: string): UrlRow {
	return {
		url: href,
		...locate(href, base, ignores),
		status: "unchecked",
		rank: STATUS_RANK.unchecked,
		code: null,
		finalUrl: null,
		chain: [],
		note: "",
		checkedAt: null,
		nextCheckAt: "",
		firstSeen: now,
	};
}

/** Delete URL rows no entry uses any more. */
async function dropOrphans(ctx: PluginContext, ids: string[], ops?: Ops): Promise<void> {
	const orphans: string[] = [];
	for (const id of new Set(ids)) {
		ops?.spend();
		if ((await refs(ctx).count({ urlId: id })) === 0) orphans.push(id);
	}
	if (orphans.length) await deleteMany(urls(ctx), orphans, ops);
}

const sameRef = (a: RefRow, b: RefRow) =>
	a.title === b.title &&
	a.entryStatus === b.entryStatus &&
	a.count === b.count &&
	a.kinds.join() === b.kinds.join() &&
	a.anchors.join("\u0000") === b.anchors.join("\u0000");

/**
 * Replace an entry's link references with the links in `data`. Returns the
 * number of distinct links, or -1 when the site URL is unknown (nothing is
 * indexed then, since internal links couldn't be told apart).
 * Only new and changed references are written, so re-indexing an unchanged
 * entry (as every scan does) reads its rows and writes nothing.
 */
export async function indexEntry(
	ctx: PluginContext,
	collection: string,
	item: { id: string; slug?: string | null; status?: string; data: Record<string, unknown> },
	options: { ignores?: IgnoreRule[]; ops?: Ops } = {},
): Promise<number> {
	const base = siteUrl(ctx);
	if (!base) {
		ctx.log.warn("links: the site URL isn't set (Settings → General or astro.config `site`), so links can't be indexed yet.");
		return -1;
	}
	const ops = options.ops;
	const info = (await linkCollections(ctx)).get(collection);
	if (!info) return removeEntry(ctx, collection, item.id, ops).then(() => 0);
	const key = entryKey(collection, item.id);
	const grouped = group(extractEntryLinks(item.data, info.fields));
	const now = new Date().toISOString();
	const title = entryTitle(info, item);

	const next = new Map<string, RefRow>();
	const hrefById = new Map<string, string>();
	for (const [href, g] of grouped) {
		const id = await urlId(href);
		hrefById.set(id, href);
		next.set(id, {
			urlId: id,
			entryKey: key,
			collection,
			entryId: item.id,
			title,
			entryStatus: item.status ?? "",
			kinds: [...g.kinds].sort(),
			anchors: [...g.anchors],
			count: g.count,
			seenAt: now,
		});
	}

	const existing = new Map((await refsWhere(ctx, "entryKey", key, ops)).map((r) => [r.data.urlId, r.data]));
	const removed = [...existing.keys()].filter((id) => !next.has(id));
	const added = [...next.keys()].filter((id) => !existing.has(id));
	const changed = [...next].filter(([id, row]) => {
		const old = existing.get(id);
		return !old || !sameRef(old, row);
	});

	if (removed.length) await deleteMany(refs(ctx), removed.map((id) => `${key}|${id}`), ops);
	if (changed.length) await putMany(refs(ctx), changed.map(([id, row]) => ({ id: `${key}|${id}`, data: row })), ops);

	if (added.length) {
		const have = await getMany(urls(ctx), added, ops);
		const missing = added.filter((id) => !have.has(id));
		if (missing.length) {
			const ignores = options.ignores ?? (await getIgnores(ctx));
			await putMany(
				urls(ctx),
				missing.map((id) => ({ id, data: newUrlRow(hrefById.get(id) as string, base, ignores, now) })),
				ops,
			);
		}
	}
	if (removed.length) await dropOrphans(ctx, removed, ops);
	return next.size;
}

export async function removeEntry(ctx: PluginContext, collection: string, id: string, ops?: Ops): Promise<void> {
	const key = entryKey(collection, id);
	const existing = await refsWhere(ctx, "entryKey", key, ops);
	if (!existing.length) return;
	await deleteMany(
		refs(ctx),
		existing.map((r) => r.id),
		ops,
	);
	await dropOrphans(
		ctx,
		existing.map((r) => r.data.urlId),
		ops,
	);
}

/** Fill in where links point for rows saved without a usable site URL. */
export async function fixUnresolved(ctx: PluginContext, ops?: Ops): Promise<number> {
	const base = siteUrl(ctx);
	if (!base) return 0;
	ops?.spend();
	const page = await urls(ctx).query({ where: { resolved: null }, limit: 100 });
	const ignores = await getIgnores(ctx);
	const updates = page.items
		.map(({ id, data }) => ({ id, data: { ...data, ...locate(data.url, base, ignores) } }))
		.filter((u) => u.data.resolved !== null);
	if (updates.length) await putMany(urls(ctx), updates, ops);
	return updates.length;
}

// ── Full scan ────────────────────────────────────────────────────

export interface ScanState {
	status: "idle" | "running";
	phase: "index" | "cleanup";
	startedAt: string | null;
	finishedAt: string | null;
	collections: string[];
	index: number;
	cursor: string | null;
	/** Entries of the current page already indexed. */
	offset: number;
	processed: number;
	error?: string;
}

export const IDLE_SCAN: ScanState = {
	status: "idle",
	phase: "index",
	startedAt: null,
	finishedAt: null,
	collections: [],
	index: 0,
	cursor: null,
	offset: 0,
	processed: 0,
};

export async function getScan(ctx: PluginContext): Promise<ScanState | null> {
	const state = await ctx.kv.get<ScanState>(SCAN_KEY);
	return state ? { ...IDLE_SCAN, ...state } : null;
}

export async function startScan(ctx: PluginContext): Promise<ScanState> {
	const state: ScanState = {
		...IDLE_SCAN,
		status: "running",
		startedAt: new Date().toISOString(),
		collections: [...(await linkCollections(ctx)).keys()],
	};
	await ctx.kv.set(SCAN_KEY, state);
	return state;
}

/** One scan at a time across cron and admin requests: a lease with an owner and an expiry, taken with compare-and-set. */
async function acquireLease(ctx: PluginContext, owner: string, ttlMs: number): Promise<boolean> {
	const current = await ctx.kv.getVersioned<{ owner: string; expires: number }>(LEASE_KEY);
	if (current?.value && current.value.owner !== owner && current.value.expires > Date.now()) return false;
	const result = await ctx.kv.compareAndSet(LEASE_KEY, current?.revision ?? null, { owner, expires: Date.now() + ttlMs });
	return result.applied;
}

async function releaseLease(ctx: PluginContext, owner: string): Promise<void> {
	const current = await ctx.kv.getVersioned<{ owner: string; expires: number }>(LEASE_KEY);
	if (current?.value?.owner === owner) await ctx.kv.compareAndDelete(LEASE_KEY, current.revision);
}

/** Collection slugs as EmDash allows them (its tables are `ec_<slug>`). */
const COLLECTION_SLUG = /^[a-z][a-z0-9_]*$/;

/**
 * Entries (keys) that have references but that a scan wouldn't visit now:
 * deleted or trashed, or in a collection that has no link fields any more.
 * With D1 this is one statement over the entryKey index plus one per 90
 * entries of each collection; without it, the storage API and content.get.
 */
export async function staleEntries(ctx: PluginContext, ops?: Ops): Promise<string[]> {
	const db = await d1();
	let keys: string[];
	if (db) {
		ops?.spend();
		const { results } = await db.prepare(referencedEntriesSql).bind(PLUGIN_ID, "links_refs").all<{ k: string | null }>();
		keys = (results ?? []).map((r) => r.k).filter((k): k is string => typeof k === "string");
	} else {
		keys = [...new Set((await queryAll(refs(ctx), undefined, { ops })).map((r) => r.data.entryKey))];
	}
	const collections = await linkCollections(ctx);
	const byCollection = new Map<string, string[]>();
	const stale: string[] = [];
	for (const key of keys) {
		const slash = key.indexOf("/");
		const collection = key.slice(0, slash);
		if (slash < 1 || !collections.has(collection) || !COLLECTION_SLUG.test(collection)) stale.push(key);
		else byCollection.set(collection, [...(byCollection.get(collection) ?? []), key.slice(slash + 1)]);
	}
	for (const [collection, ids] of byCollection) {
		try {
			const live = new Set<string>();
			for (const part of chunked(ids)) {
				ops?.spend(db ? 1 : part.length);
				if (db) {
					const sql = `SELECT id FROM "ec_${collection}" WHERE deleted_at IS NULL AND id IN (${part.map(() => "?").join(", ")})`;
					const { results } = await db
						.prepare(sql)
						.bind(...part)
						.all<{ id: string }>();
					for (const row of results ?? []) live.add(row.id);
				} else {
					for (const id of part) if (await ctx.content?.get(collection, id)) live.add(id);
				}
			}
			for (const id of ids) if (!live.has(id)) stale.push(entryKey(collection, id));
		} catch (error) {
			// Keep references when entries can't be looked up: a later scan tries again.
			ctx.log.warn("links: could not check entries for cleanup", { collection, error: String(error) });
		}
	}
	return stale;
}

/** Each entry with references, once, read from the entryKey expression index (no ORDER BY, see refsWhereSql). */
export const referencedEntriesSql = `SELECT DISTINCT json_extract(data, '$.entryKey') AS k FROM _plugin_storage WHERE plugin_id = ? AND collection = ?`;

/** Statements an entry may take; a step stops before starting one it can't afford. */
const ENTRY_RESERVE = 25;
const PAGE = 10;

/**
 * Index entries within `ops` (statements and deadline), writing only references
 * that are new or changed, then drop references of entries the scan can't visit
 * (staleEntries). Returns the state, plus `busy` when another scan step
 * holds the lease.
 */
export async function scanStep(ctx: PluginContext, ops: Ops): Promise<ScanState & { busy?: boolean }> {
	const owner = crypto.randomUUID();
	const leaseMs = Math.max(30_000, ops.deadline - Date.now() + 30_000);
	if (!(await acquireLease(ctx, owner, Number.isFinite(leaseMs) ? leaseMs : 120_000))) {
		return { ...((await getScan(ctx)) ?? IDLE_SCAN), busy: true };
	}
	try {
		const state = (await getScan(ctx)) ?? { ...IDLE_SCAN };
		if (state.status !== "running" || !ctx.content) return state;
		if (!siteUrl(ctx)) {
			state.error = "The site URL isn't set (Settings → General, or `site` in astro.config), so internal links can't be recognized.";
			await ctx.kv.set(SCAN_KEY, state);
			return state;
		}
		delete state.error;
		const ignores = await getIgnores(ctx);
		ops.spend(4);

		while (state.phase === "index" && state.index < state.collections.length && ops.has(ENTRY_RESERVE)) {
			const collection = state.collections[state.index];
			let page: Awaited<ReturnType<NonNullable<PluginContext["content"]>["list"]>>;
			try {
				ops.spend(2);
				page = await ctx.content.list(collection, { limit: PAGE, cursor: state.cursor ?? undefined });
			} catch (error) {
				// Skip a collection that can't be listed (e.g. removed mid-scan) instead of retrying it forever.
				ctx.log.warn("links: could not list collection", { collection, error: String(error) });
				Object.assign(state, { index: state.index + 1, cursor: null, offset: 0 });
				continue;
			}
			let i = state.offset;
			for (; i < page.items.length && ops.has(ENTRY_RESERVE); i++) {
				const item = page.items[i];
				const data = await latestData(ctx, collection, item, ops);
				await indexEntry(ctx, collection, { ...item, data }, { ignores, ops });
				state.processed++;
			}
			if (i < page.items.length) {
				state.offset = i; // Out of budget mid-page: resume here.
				break;
			}
			state.offset = 0;
			if (page.hasMore && page.cursor) state.cursor = page.cursor;
			else Object.assign(state, { index: state.index + 1, cursor: null });
		}
		if (state.phase === "index" && state.index >= state.collections.length) state.phase = "cleanup";

		// Entries the scan visited dropped their removed links as they were indexed. What's left is
		// references from entries it couldn't visit: deleted or trashed, or in a collection without
		// link fields now. Recomputed each step (a few statements), so cleanup resumes without state.
		if (state.phase === "cleanup" && ops.has(ENTRY_RESERVE)) {
			const stale = await staleEntries(ctx, ops);
			let i = 0;
			for (; i < stale.length && ops.has(ENTRY_RESERVE); i++) {
				const slash = stale[i].indexOf("/");
				await removeEntry(ctx, stale[i].slice(0, slash), stale[i].slice(slash + 1), ops);
			}
			if (i === stale.length) {
				Object.assign(state, { status: "idle", phase: "index", finishedAt: new Date().toISOString(), cursor: null, offset: 0 });
				ctx.log.info("links: scan finished", { entries: state.processed, removed: stale.length });
			}
		}
		await ctx.kv.set(SCAN_KEY, state);
		await invalidateCounts(ctx);
		return state;
	} catch (error) {
		const state = (await getScan(ctx)) ?? { ...IDLE_SCAN };
		state.error = String(error).slice(0, 300);
		await ctx.kv.set(SCAN_KEY, state);
		throw error;
	} finally {
		await releaseLease(ctx, owner);
	}
}

// ── Ignore flags ─────────────────────────────────────────────────

/** Recompute every URL's ignore flag after the rules change. */
export async function reapplyIgnores(ctx: PluginContext, rules: IgnoreRule[]): Promise<number> {
	const rows = await queryAll(urls(ctx));
	const updates: Array<{ id: string; data: UrlRow }> = [];
	for (const row of rows) {
		const ignored = row.data.resolved ? isIgnored(rules, row.data.resolved) : false;
		if (ignored !== row.data.ignored) updates.push({ id: row.id, data: { ...row.data, ignored } });
	}
	await putMany(urls(ctx), updates);
	await invalidateCounts(ctx);
	return updates.length;
}

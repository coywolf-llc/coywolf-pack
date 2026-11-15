/**
 * Child Pages module: "add a page and choose a parent". Pages pick their
 * parent in EmDash's own editor, with a native reference field ("Parent page",
 * `parent_page`, pages → pages) that the Child Pages admin page adds through
 * EmDash's schema API; plugins can't add fields themselves. With the feature
 * on:
 *
 * - URLs nest: the pack's resolver (src/core/content-url.ts) puts the parents'
 *   slugs in front (`/apps/coywolf-pack/`), for the sitemaps, breadcrumbs,
 *   schema, search, feeds and redirects alike; themes use loadPageTree and
 *   resolvePagePath (src/childPages/theme.ts).
 * - Moves redirect: Slug changes (Redirect Manager) adds the 301 for the page
 *   that moved; this module adds one for each published page below it (at most
 *   MAX_MOVES a change), and for pages whose parent stops counting (trashed,
 *   deleted, unpublished: they become top level) or counts again.
 * - Loops are refused at publish (content:beforePublish reads the parent waiting
 *   in the draft), and any that get in another way resolve as top level.
 * - Turning the feature off redirects nested URLs back to the flat ones; turning
 *   it on again reverses that (featuresChanged).
 */
import type { PluginContext } from "emdash";
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { COLLECTION_SLUG, type ChildPagesState, type StoredParents, comparablePath, configureStoredParents, configuredPageParents, createEntryUrlResolver, patternUsesPagePath, urlOverride } from "../core/content-url.js";
import { type FeatureMap, ctxFeatures, isOn, registerFeatures, rememberSiteSetting } from "../core/features.js";
import type { FeatureDef, FeatureNotice, PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { MAX_PURGE_OPERATIONS } from "../core/generation.js";
import { type PurgeScope, purgePageCache } from "../pageCache/lib.js";
import { ensureTable, sourceKey, storedForms } from "../redirects/rules.js";
import { SLUG_NOTE_PREFIX } from "../redirects/slug-core.js";
import { type MoveLoop, type MoveShadow, type RuleRef, SLUG_CHANGES_FEATURE, type UrlMove, applyUrlMoves, loopingRule } from "../redirects/slug-changes.js";
import { parseInput } from "../shared.js";
import { CHILD_PAGES_FEATURE, type CollectionMeta, type CollectionTree, VERSION_SETTING, childPagesProvider, collectionTree, databaseFor, invalidatePageTrees, readChildPagesState, readMeta, readTree } from "./read.js";
import { DIGIT_SLUG, PARENT_FIELD, type PageNode, type PageTreeData, ancestorsOf, childrenOf, loopWith, storedParentsOf, warningsFor } from "./tree.js";

export const FEATURES: FeatureDef[] = [
	{
		id: CHILD_PAGES_FEATURE,
		label: "Child Pages",
		description:
			"Choose a parent page in the page editor, and pages get nested URLs (/apps/coywolf-pack/), breadcrumbs with their parents' titles, and 301s when a page moves. Needs Redirect Manager and its Slug changes part on, for those 301s.",
		default: false,
		requires: ["redirects", SLUG_CHANGES_FEATURE],
	},
];
registerFeatures(FEATURES);

/** Most redirects written for one change (a page that moved, a parent that went away, the switch); the rest wait for the next change or Re-check. */
export const MAX_MOVES = 200;
/** Changes kept for the Child Pages page (newest first). */
export const MAX_CHANGES = 10;
/** URLs kept in one list of a status (the counts are always whole). */
const LISTED = 50;

/**
 * The URLs last seen per collection: `paths` is entry id → URL for published default-locale entries whose
 * URL differs from their URL with no parent page, plus the old URL of every move that got no redirect yet
 * (over MAX_MOVES, or a loop with a rule someone else made), so the next settle makes it. `slugs` is the slug
 * of each entry in `paths` or with a page under it: a save that changes one of those moves pages (afterSave).
 */
const snapshotKey = (collection: string) => `state:childPages:paths:${collection}`;
/** The recent changes and what's still open, for the Child Pages page. */
const STATUS_KEY = "state:childPages:status";

interface Snapshot {
	paths: Record<string, string>;
	slugs?: Record<string, string>;
	at: string;
	/** Left by turning the switch off: only the moves that got no redirect (their old, nested URLs). */
	off?: boolean;
}

/** A page that moved. */
export interface MoveRef {
	entryId: string;
	title: string;
	from: string;
	to: string;
}

/** A move with no redirect, because `rule` (someone else's) sends its new URL back to its old one. */
export interface LoopRef extends MoveRef {
	rule: RuleRef;
}

export interface ChangeStatus {
	at: string;
	collection: string;
	reason: string;
	/** Pages whose URL changed (besides the one that was edited). */
	moved: number;
	/** Redirects added or updated. */
	written: number;
	/** Over MAX_MOVES: no redirect yet (the next change, or Re-check, adds up to MAX_MOVES more). */
	skipped: number;
	/** Their old URLs (the first LISTED). */
	skippedUrls?: string[];
	/** Not written: each would loop with a rule someone else made. */
	loops?: LoopRef[];
	/** New URLs that another redirect (one Slug changes didn't make) still sends elsewhere: the page there can't be reached. */
	shadowed?: MoveShadow[];
	/** Redirect Manager or Slug changes off: no redirects were made. */
	redirectsOff: boolean;
	/** There were no earlier URLs to compare with (no snapshot): pages this change moved got no redirect. */
	noSnapshot?: boolean;
	/** The change couldn't be worked out (a read or write failed): its redirects are made by the next change, or Re-check. */
	failed?: string;
}

/** What's unresolved for a collection after its latest settle (worked out again by each one). */
export interface OpenIssues {
	at: string;
	reason: string;
	/** Moves over MAX_MOVES that still have no redirect (the first LISTED; `waitingCount` is all of them). */
	waiting: MoveRef[];
	waitingCount: number;
	loops: LoopRef[];
	shadowed: MoveShadow[];
}

export interface StoredStatus {
	changes: ChangeStatus[];
	open: Record<string, OpenIssues>;
}

const NO_PARENTS: StoredParents = { parentOf: new Map(), idOf: new Map() };

/** A version for the URL fingerprint: time-ordered, unique enough. */
const newVersion = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;

async function bumpVersion(ctx: PluginContext): Promise<void> {
	const version = newVersion();
	await ctx.settings.set(VERSION_SETTING, version);
	rememberSiteSetting(VERSION_SETTING, version);
}

/**
 * Entries whose moves Child pages redirects: published, in the default locale (or with none). A translation
 * can share its slug with the default-locale entry, and the URLs the pack builds have no locale prefix, so a
 * translation's move would write a rule over the live default-locale page (as Slug changes' handled()).
 */
const tracked = (tree: PageTreeData, node: PageNode) => node.published && Boolean(node.slug) && (!node.locale || node.locale === tree.defaultLocale);

/** The URLs of a collection's published entries with no parent pages (the `pageParents` option still applies), with Child pages on. */
async function baseUrls(db: D1Database, state: ChildPagesState, collection: string, tree: PageTreeData): Promise<Map<string, string | null>> {
	const resolver = createEntryUrlResolver(db, { childPages: { collections: state.collections, parents: () => NO_PARENTS } });
	return resolver.urls(collection, publishedEntries(tree));
}

const publishedEntries = (tree: PageTreeData) =>
	[...tree.nodes.values()].filter((n) => n.published && n.slug).map((n) => ({ id: n.id, slug: n.slug, publishedAt: n.publishedAt, locale: n.locale }));

/**
 * The snapshot of nested URLs: tracked entries whose URL differs from their URL with no parent page.
 * `keep` are the old URLs of moves that got no redirect: they stay until one is made.
 */
function snapshotOf(current: CollectionTree, base: Map<string, string | null>, keep: ReadonlyMap<string, string> = new Map()): Snapshot {
	const paths: Record<string, string> = {};
	const slugs: Record<string, string> = {};
	const { tree } = current;
	for (const node of tree.nodes.values()) {
		if (!tracked(tree, node)) continue;
		const url = current.urls.get(node.id);
		const kept = keep.get(node.id);
		if (kept) paths[node.id] = kept;
		else if (url && url !== base.get(node.id)) paths[node.id] = url;
		if (node.id in paths) slugs[node.id] = node.slug as string;
		const parent = node.effectiveParentId ? tree.nodes.get(node.effectiveParentId) : undefined;
		if (parent?.slug) slugs[parent.id] = parent.slug;
	}
	return { paths, slugs, at: new Date().toISOString() };
}

const titleOf = (node: PageNode | undefined) => node?.title?.trim() || node?.slug || node?.id || "";

/** Redirect Manager and Slug changes, the parts the 301s need. */
const redirectsOn = (features: FeatureMap) => isOn(features, "redirects") && isOn(features, SLUG_CHANGES_FEATURE);

// ── Status ───────────────────────────────────────────────────────

export async function readStatus(ctx: PluginContext): Promise<StoredStatus> {
	const stored = await ctx.kv.get<Partial<StoredStatus>>(STATUS_KEY).catch(() => null);
	return { changes: Array.isArray(stored?.changes) ? stored.changes : [], open: stored?.open && typeof stored.open === "object" ? stored.open : {} };
}

/**
 * Keep a change (newest first, MAX_CHANGES of them, every collection's together) and the collection's open
 * issues (worked out from the stored ones by `open`; null: none left). Another collection's issues, and
 * earlier changes, stay. One read, and a write only when something changes. Never fails the settle.
 */
async function recordChange(ctx: PluginContext, collection: string, change: ChangeStatus | null, open: (earlier: OpenIssues | undefined) => Promise<OpenIssues | null>): Promise<void> {
	try {
		const status = await readStatus(ctx);
		const earlier = status.open[collection];
		const now = await open(earlier);
		if (!change && !now && !earlier) return;
		if (change) status.changes = [change, ...status.changes].slice(0, MAX_CHANGES);
		if (now) status.open[collection] = now;
		else delete status.open[collection];
		await ctx.kv.set(STATUS_KEY, status);
	} catch (error) {
		ctx.log.warn("Child pages: could not keep the change for the Child Pages page", { error: String(error) });
	}
}

const sameShadow = (a: MoveShadow, b: MoveShadow) => sourceKey(a.url) === sourceKey(b.url);

/** The shadowed URLs that a rule someone else made still answers (those fixed since drop out). */
async function stillShadowed(db: D1Database, shadowed: MoveShadow[]): Promise<MoveShadow[]> {
	if (!shadowed.length) return [];
	const out: MoveShadow[] = [];
	for (let i = 0; i < shadowed.length; i += 20) {
		const chunk = shadowed.slice(i, i + 20);
		const forms = [...new Set(chunk.flatMap((s) => storedForms(s.url)))];
		const { results } = await db
			.prepare(`SELECT source, target, note, enabled FROM coywolf_redirects WHERE is_regex = 0 AND source IN (${forms.map(() => "?").join(", ")})`)
			.bind(...forms)
			.all<{ source: string; target: string; note: string | null; enabled: number | null }>();
		for (const s of chunk) {
			const rule = results.find((r) => r.enabled !== 0 && !(r.note ?? "").startsWith(SLUG_NOTE_PREFIX) && sourceKey(r.source) === sourceKey(s.url));
			if (rule) out.push({ url: s.url, rule: { source: rule.source, target: rule.target } });
		}
	}
	return out;
}

// ── Cached pages ─────────────────────────────────────────────────

/** Purge calls for one change's moved pages; more paths than these hold clears every page in one call instead (the purge API is rate-limited). */
const MAX_PURGE_CALLS = 2;

/**
 * What to purge for pages that moved: the cached HTML at each old URL (served before the Worker runs, so the
 * 301 would wait for it to expire) and at each new one (a cached 404, or the page that was there), as
 * Redirect Manager's save clears its new sources. By path prefix, which covers the trailing-slash form and
 * query strings, and every page below: a path under another one in the list is left out. At most
 * MAX_PURGE_OPERATIONS a call; more than MAX_PURGE_CALLS calls' worth (or the home page) clears everything.
 */
export function movedPagesPurges(moves: ReadonlyArray<Pick<UrlMove, "from" | "to">>): PurgeScope[] {
	const paths = new Set<string>();
	for (const move of moves) {
		for (const url of [move.from, move.to]) {
			if (!url) continue;
			const path = sourceKey(url.split(/[?#]/)[0] as string);
			if (path === "/" || !path.startsWith("/")) return [{ purgeEverything: true }];
			paths.add(path);
		}
	}
	const prefixes = [...paths].filter((path) => ![...paths].some((other) => other !== path && path.startsWith(`${other}/`))).sort();
	if (!prefixes.length) return [];
	if (prefixes.length > MAX_PURGE_OPERATIONS * MAX_PURGE_CALLS) return [{ purgeEverything: true }];
	const out: PurgeScope[] = [];
	for (let i = 0; i < prefixes.length; i += MAX_PURGE_OPERATIONS) out.push({ pathPrefixes: prefixes.slice(i, i + MAX_PURGE_OPERATIONS) });
	return out;
}

// ── Moves ────────────────────────────────────────────────────────

interface Applied {
	change: ChangeStatus;
	/** Moves with no redirect yet, by entry id: over the cap, or a loop. */
	unapplied: Map<string, MoveRef>;
	waiting: MoveRef[];
	loops: LoopRef[];
	shadowed: MoveShadow[];
}

const ref = (move: UrlMove): MoveRef => ({ entryId: move.entryId, title: move.title, from: move.from, to: move.to });
/** Oldest URL first, by code unit (the same order on every run, whatever the isolate's locale). */
const byFrom = (a: UrlMove, b: UrlMove) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);

/**
 * Redirect the pages that moved (the first MAX_MOVES, in a fixed order), purge their cached pages, and
 * say what happened. `purge: false` when the caller's request clears every page anyway (a save of the switches).
 */
async function applyMoves(ctx: PluginContext, db: D1Database, features: FeatureMap, collection: string, moves: UrlMove[], reason: string, options: { purge?: boolean } = {}): Promise<Applied> {
	const ordered = [...moves].sort(byFrom);
	const now = ordered.slice(0, MAX_MOVES);
	const later = ordered.slice(MAX_MOVES);
	const off = !redirectsOn(features);
	const result = off || !now.length ? { written: 0, shadowed: [] as MoveShadow[], loops: [] as MoveLoop[] } : await applyUrlMoves(ctx, db, now);
	// With the redirects off nothing waits: the snapshot moves on, as it always has.
	const waiting = off ? [] : later.map(ref);
	const loops: LoopRef[] = result.loops.map((l) => ({ ...ref(l), rule: l.rule }));
	const unapplied = new Map<string, MoveRef>([...waiting, ...loops].map((m) => [m.entryId, m]));
	if (ordered.length && options.purge !== false) {
		for (const scope of movedPagesPurges(ordered)) await purgePageCache(scope);
	}
	if (later.length && !off) ctx.log.warn("Child pages: too many pages moved at once; the rest get their redirects with the next change, or Re-check redirects on the Child Pages page", { collection, moved: moves.length, max: MAX_MOVES });
	const change: ChangeStatus = {
		at: new Date().toISOString(),
		collection,
		reason,
		moved: moves.length,
		written: result.written,
		skipped: waiting.length,
		redirectsOff: off,
		...(waiting.length ? { skippedUrls: waiting.slice(0, LISTED).map((m) => m.from) } : {}),
		...(loops.length ? { loops: loops.slice(0, LISTED) } : {}),
		...(result.shadowed.length ? { shadowed: result.shadowed.slice(0, LISTED) } : {}),
	};
	if (moves.length) ctx.log.info("Child pages: URLs changed", { ...change });
	return { change, unapplied, waiting, loops, shadowed: result.shadowed };
}

/** The collection's open issues after a settle: what still waits, loops, and the shadowed URLs (these and earlier ones) that are still shadowed. */
const openAfter = (db: D1Database, applied: Applied, exceptLoop: LoopRef | null) => async (earlier: OpenIssues | undefined): Promise<OpenIssues | null> => {
	const candidates = [...applied.shadowed, ...(earlier?.shadowed ?? []).filter((e) => !applied.shadowed.some((s) => sameShadow(s, e)))];
	const shadowed = applied.change.redirectsOff ? [] : await stillShadowed(db, candidates).catch(() => candidates);
	const loops = exceptLoop ? [exceptLoop, ...applied.loops] : applied.loops;
	if (!applied.waiting.length && !loops.length && !shadowed.length) return null;
	return { at: applied.change.at, reason: applied.change.reason, waiting: applied.waiting.slice(0, LISTED), waitingCount: applied.waiting.length, loops: loops.slice(0, LISTED), shadowed: shadowed.slice(0, LISTED) };
};

/**
 * After a change to a collection's published pages: compare every page's URL with the
 * snapshot, add 301s for those that moved (not `except`, the entry that changed: Slug
 * changes and Removed content handle it), and keep the new snapshot.
 *
 * - A move that got no redirect (over MAX_MOVES, or a loop with a rule someone else made, `except`'s
 *   included) keeps its old URL in the snapshot, so the next settle makes it.
 * - Without a snapshot (the first change since the field was added, one that was deleted, or one whose
 *   write failed) there is nothing to compare with: one is recorded from the current tree, and when other
 *   pages already have parents the change says so (`noSnapshot`), since pages it moved got no redirect.
 * - A snapshot that can't be read rejects: the settle is left to the next change (the snapshot is unchanged).
 */
export async function settleCollection(ctx: PluginContext, db: D1Database, features: FeatureMap, collection: string, except: string | null, reason: string): Promise<void> {
	invalidatePageTrees();
	const meta = (await readMeta(db)).find((m) => m.collection === collection);
	if (!meta?.field) return;
	const current = await collectionTree(db, collection, { on: true });
	if (!current) return;
	const { tree } = current;
	const state = await readChildPagesState(db);
	const base = await baseUrls(db, state, collection, tree);
	const before = await ctx.kv.get<Snapshot>(snapshotKey(collection));
	const moves: UrlMove[] = [];
	const keep = new Map<string, string>();
	let exceptLoop: LoopRef | null = null;
	let noSnapshot = false;
	if (before?.paths && !before.off) {
		for (const node of tree.nodes.values()) {
			if (!tracked(tree, node)) continue;
			const now = current.urls.get(node.id);
			const was = before.paths[node.id] ?? base.get(node.id);
			if (!now || !was || comparablePath(now) === comparablePath(was)) continue;
			const move: UrlMove = { collection, entryId: node.id, title: titleOf(node), from: was, to: now };
			if (node.id !== except) {
				moves.push(move);
				continue;
			}
			// The entry that changed is Slug changes' to redirect. It won't when that would loop with a rule someone
			// else made (src/redirects/slug-changes.ts loopingRule): listed here, and made once that rule is gone.
			const rule = redirectsOn(features) ? await ensureTable(db).then(() => loopingRule(db, was, now)) : null;
			if (rule) {
				exceptLoop = { ...ref(move), rule };
				keep.set(node.id, was);
			}
		}
	} else {
		// (Re-check has no entry that changed: starting from the current URLs is what it's for.)
		noSnapshot = except !== null && [...tree.nodes.values()].some((n) => n.id !== except && n.hasParent && tracked(tree, n));
		if (noSnapshot) ctx.log.warn("Child pages: no earlier URLs to compare with, so pages this change moved got no redirect; tracking starts again from the current URLs", { collection, reason });
	}
	const applied = await applyMoves(ctx, db, features, collection, moves, reason);
	for (const [id, move] of applied.unapplied) keep.set(id, move.from);
	await ctx.kv.set(snapshotKey(collection), snapshotOf(current, base, keep));
	const change: ChangeStatus = { ...applied.change, ...(noSnapshot ? { noSnapshot: true } : {}), ...(exceptLoop ? { loops: [exceptLoop, ...(applied.change.loops ?? [])].slice(0, LISTED) } : {}) };
	// Only changes that did or left something are kept: an ordinary publish that moved nothing doesn't push them out.
	const notable = change.moved > 0 || noSnapshot || Boolean(change.loops?.length);
	await recordChange(ctx, collection, notable ? change : null, openAfter(db, applied, exceptLoop));
}

/**
 * The switch was turned on or off: redirect every published page whose URL changes
 * (nested → flat when off, flat → nested when on), and start the snapshot afresh. Moves
 * that got no redirect stay in it (when off: only those), for Re-check to make.
 */
export async function settleSwitch(ctx: PluginContext, db: D1Database, features: FeatureMap, on: boolean): Promise<void> {
	invalidatePageTrees();
	const nesting = (await readMeta(db)).filter((m) => m.field);
	for (const meta of nesting) {
		const [withParents, without] = await Promise.all([collectionTree(db, meta.collection, { on: true }), collectionTree(db, meta.collection, { on: false })]);
		if (!withParents || !without) continue;
		const { tree } = withParents;
		const moves: UrlMove[] = [];
		for (const node of tree.nodes.values()) {
			if (!tracked(tree, node)) continue;
			const nested = withParents.urls.get(node.id);
			const flat = without.urls.get(node.id);
			if (!nested || !flat || comparablePath(nested) === comparablePath(flat)) continue;
			moves.push({ collection: meta.collection, entryId: node.id, title: titleOf(node), from: on ? flat : nested, to: on ? nested : flat });
		}
		// The save of the switches clears every cached page itself (and again once every isolate has them).
		const applied = await applyMoves(ctx, db, features, meta.collection, moves, on ? "Child Pages turned on" : "Child Pages turned off", { purge: false });
		const keep = new Map([...applied.unapplied].map(([id, move]) => [id, move.from]));
		if (on) {
			const base = await baseUrls(db, await readChildPagesState(db), meta.collection, tree);
			await ctx.kv.set(snapshotKey(meta.collection), snapshotOf(withParents, base, keep));
		} else if (keep.size) await ctx.kv.set(snapshotKey(meta.collection), { paths: Object.fromEntries(keep), at: new Date().toISOString(), off: true } satisfies Snapshot);
		else await ctx.kv.delete(snapshotKey(meta.collection)).catch(() => false);
		await recordChange(ctx, meta.collection, applied.change, openAfter(db, applied, null));
	}
	await bumpVersion(ctx);
}

/**
 * Re-check a collection's redirects (the Child Pages page, and the Features page while the switch is off):
 * with the switch on, a settle with no entry left out, which makes the redirects that still wait and starts
 * tracking from the current URLs when there was no snapshot; with it off, the redirects left over from
 * turning it off (nested → flat).
 */
export async function recheckCollection(ctx: PluginContext, db: D1Database, features: FeatureMap, collection: string): Promise<void> {
	const reason = "Redirects re-checked";
	if (isOn(features, CHILD_PAGES_FEATURE)) return settleCollection(ctx, db, features, collection, null, reason);
	invalidatePageTrees();
	const left = await ctx.kv.get<Snapshot>(snapshotKey(collection));
	if (!left?.off) return;
	const without = await collectionTree(db, collection, { on: false });
	if (!without) return;
	const moves: UrlMove[] = [];
	for (const [id, from] of Object.entries(left.paths)) {
		const node = without.tree.nodes.get(id);
		const to = without.urls.get(id);
		if (node && tracked(without.tree, node) && to && comparablePath(to) !== comparablePath(from)) moves.push({ collection, entryId: id, title: titleOf(node), from, to });
	}
	const applied = await applyMoves(ctx, db, features, collection, moves, reason);
	const keep = new Map([...applied.unapplied].map(([id, move]) => [id, move.from]));
	if (keep.size) await ctx.kv.set(snapshotKey(collection), { paths: Object.fromEntries(keep), at: new Date().toISOString(), off: true } satisfies Snapshot);
	else await ctx.kv.delete(snapshotKey(collection)).catch(() => false);
	await recordChange(ctx, collection, applied.change, openAfter(db, applied, null));
}

/** How a rule reads in a message: its source and target. */
export const ruleText = (rule: RuleRef) => `${rule.source} → ${rule.target}`;

/**
 * What turning the switch off left without a redirect, for the Features page: loops (with the rule to
 * delete) and moves over MAX_MOVES, with Re-check redirects to make them. Null when nothing is left.
 */
export function offNotice(status: StoredStatus): FeatureNotice | null {
	const open = Object.values(status.open);
	const loops = open.flatMap((o) => o.loops);
	const waiting = open.reduce((n, o) => n + o.waitingCount, 0);
	if (!loops.length && !waiting) return null;
	const items = loops.map((l) => `Delete the redirect ${ruleText(l.rule)} on the Redirect Manager page: it sends ${l.to} back to ${l.from}, so a redirect from ${l.from} would loop, and “${l.title}” can't be reached at ${l.to}.`);
	if (waiting) items.push(`${waiting.toLocaleString("en-US")} more ${waiting === 1 ? "page is" : "pages are"} over the limit of ${MAX_MOVES} redirects a change.`);
	return {
		text: `Turning Child Pages off left ${(loops.length + waiting).toLocaleString("en-US")} nested ${loops.length + waiting === 1 ? "URL" : "URLs"} without a redirect to the page's new URL. ${loops.length ? "Delete the redirects listed, then click" : "Click"} Re-check redirects to add ${waiting > MAX_MOVES ? `the next ${MAX_MOVES}` : "them"}.`,
		items,
		action: { label: "Re-check redirects", route: "childPages/recheck" },
	};
}

/** A settle that failed: said on the Child Pages page (its redirects are made by the next change, or Re-check). */
async function recordFailure(ctx: PluginContext, collection: string, reason: string, error: unknown): Promise<void> {
	const change: ChangeStatus = { at: new Date().toISOString(), collection, reason, moved: 0, written: 0, skipped: 0, redirectsOff: false, failed: String((error as { message?: unknown } | null)?.message ?? error).slice(0, 300) };
	await recordChange(ctx, collection, change, async (earlier) => earlier ?? null);
}

/** The parent waiting in an entry's draft revision (`_references.parent_page`): a translation group, null for none, undefined when nothing is waiting. */
export async function stagedParent(db: D1Database, draftRevisionId: string | null | undefined): Promise<string | null | undefined> {
	if (!draftRevisionId) return undefined;
	const row = await db.prepare("SELECT data FROM revisions WHERE id = ?").bind(draftRevisionId).first<{ data: string | null }>();
	if (!row?.data) return undefined;
	try {
		const staged = (JSON.parse(row.data) as { _references?: Record<string, unknown> })._references?.[PARENT_FIELD];
		if (!Array.isArray(staged)) return undefined;
		return typeof staged[0] === "string" ? staged[0] : null;
	} catch {
		return undefined;
	}
}

/** Refuse to publish a parent page that makes a loop (the page under itself). */
async function loopGuard(event: { content: Record<string, unknown>; collection: string }, _ctx: PluginContext): Promise<{ cancel: true; reason: string } | undefined> {
	const { content, collection } = event;
	if (!COLLECTION_SLUG.test(collection)) return undefined;
	const draft = typeof content.draftRevisionId === "string" ? content.draftRevisionId : null;
	if (!draft) return undefined;
	const db = await databaseFor();
	if (!db) return undefined;
	invalidatePageTrees();
	const meta = (await readMeta(db)).find((m) => m.collection === collection);
	if (!meta?.field) return undefined;
	const parentGroup = await stagedParent(db, draft);
	if (!parentGroup) return undefined;
	const group = typeof content.translationGroup === "string" && content.translationGroup ? content.translationGroup : String(content.id);
	const chain = loopWith(await readTree(db, meta, true), group, parentGroup);
	if (!chain) return undefined;
	const title = typeof (content.data as Record<string, unknown> | undefined)?.title === "string" ? String((content.data as Record<string, unknown>).title) : "This page";
	return {
		cancel: true,
		reason:
			chain.length === 1
				? `“${title}” can't be its own parent page. Choose another parent page, or none.`
				: `That parent page would put “${title}” under itself (${[...chain].reverse().join(" › ")} › ${title}). Choose another parent page, or none.`,
	};
}

// ── Routes ───────────────────────────────────────────────────────

const collectionInput = z.object({ collection: z.string().regex(COLLECTION_SLUG) });
const entryInput = collectionInput.extend({ id: z.string().min(1).max(100) });
const idsInput = collectionInput.extend({ ids: z.array(z.string().min(1).max(100)).max(200) });

interface Summary {
	id: string;
	title: string;
	slug: string | null;
	url: string | null;
	status: string;
}

const summaryOf = (ct: CollectionTree, node: PageNode | undefined): Summary | null => (node ? { id: node.id, title: titleOf(node), slug: node.slug, url: ct.urls.get(node.id) ?? null, status: node.status } : null);

/** The collection's tree and meta, from the database (feature switch as it is), or a not-found error. */
async function routeTree(collection: string): Promise<{ db: D1Database; ct: CollectionTree }> {
	const db = await databaseFor();
	const { PluginRouteError } = await import("emdash");
	if (!db) throw new PluginRouteError("NO_DATABASE", "The site's D1 database (DB) isn't available.", 500);
	const ct = await collectionTree(db, collection);
	if (!ct) throw PluginRouteError.notFound(`No collection "${collection}".`);
	return { db, ct };
}

/**
 * A collection's nesting: by a `urls` pattern with {pagepath} ("configured"), by its field
 * while the feature is on ("field"), not at all, or "override" when its `urls` pattern has
 * no {pagepath} (that pattern wins, so the field can't nest it).
 */
function nestsBy(meta: CollectionMeta, on: boolean): "configured" | "field" | "override" | null {
	const override = urlOverride(meta.collection);
	if (override) return patternUsesPagePath(override) ? "configured" : "override";
	return on && meta.field ? "field" : null;
}

export type ImportAction = "set" | "done" | "skip" | "keep";

export interface ImportRow {
	slug: string;
	parentSlug: string;
	action: ImportAction;
	/** Why it's skipped or kept (noPage, parentNotPage, otherParent, pendingChanges, loop) or a note for "set" (parentUnpublished). */
	reason?: string;
	entryId?: string;
	title?: string;
	parentId?: string;
	parentTitle?: string;
	/** The page's URL now, and with the parent set. */
	url?: string | null;
	urlAfter?: string | null;
}

/** The dry run of "Import parents from configuration": what the `pageParents` option would set in the field. */
export async function importPlan(db: D1Database, ct: CollectionTree): Promise<ImportRow[]> {
	const { tree } = ct;
	const bySlug = new Map<string, PageNode>();
	for (const node of [...tree.nodes.values()].sort((a, b) => Number(b.locale === tree.defaultLocale) - Number(a.locale === tree.defaultLocale) || Number(b.published) - Number(a.published))) {
		if (node.slug && !bySlug.has(node.slug)) bySlug.set(node.slug, node);
	}
	const rows: ImportRow[] = [];
	const planned = new Map<string, string>(); // entry id → parent slug, for the URLs after
	const plannedLinks = new Map<string, string>(); // group → parent group, so a loop across rows is caught
	for (const [slug, parentSlug] of configuredPageParents()) {
		const node = bySlug.get(slug);
		const parent = bySlug.get(parentSlug);
		const row: ImportRow = { slug, parentSlug, action: "set" };
		if (!node) {
			rows.push({ ...row, action: "skip", reason: "noPage" });
			continue;
		}
		Object.assign(row, { entryId: node.id, title: titleOf(node), url: ct.urls.get(node.id) ?? null });
		if (!parent) {
			rows.push({ ...row, action: "keep", reason: "parentNotPage" });
			continue;
		}
		Object.assign(row, { parentId: parent.id, parentTitle: titleOf(parent) });
		if (node.hasParent) {
			rows.push({ ...row, action: node.parentId === parent.id ? "done" : "skip", ...(node.parentId === parent.id ? {} : { reason: "otherParent" }) });
			continue;
		}
		if (node.pendingChanges) {
			rows.push({ ...row, action: "skip", reason: "pendingChanges" });
			continue;
		}
		if (loopWith(tree, node.group, parent.group, plannedLinks)) {
			rows.push({ ...row, action: "skip", reason: "loop" });
			continue;
		}
		if (!parent.published) row.reason = "parentUnpublished";
		planned.set(node.id, parent.published ? parentSlug : "");
		plannedLinks.set(node.group, parent.group);
		rows.push(row);
	}
	// The URLs once the parents are set, with Child pages on (the live parents plus the planned ones).
	const state = await readChildPagesState(db);
	const live = state.parents(ct.meta.collection) ?? storedParentsOf(tree);
	const parentOf = new Map(live.parentOf);
	for (const [id, parentSlug] of planned) parentOf.set(id, parentSlug || null);
	const after = await createEntryUrlResolver(db, {
		childPages: { collections: new Set([...state.collections, ct.meta.collection]), parents: (c) => (c === ct.meta.collection ? { parentOf, idOf: live.idOf } : state.parents(c)) },
	}).urls(ct.meta.collection, publishedEntries(tree));
	for (const row of rows) if (row.entryId && row.action === "set") row.urlAfter = after.get(row.entryId) ?? row.url ?? null;
	return rows;
}

/** The recent changes and each collection's open issues, as the Child Pages page lists them. */
async function statusFor(ctx: PluginContext, meta: CollectionMeta[]): Promise<{ changes: Array<ChangeStatus & { label: string }>; open: Array<OpenIssues & { collection: string; label: string }> }> {
	const status = await readStatus(ctx);
	const label = (collection: string) => meta.find((m) => m.collection === collection)?.label ?? collection;
	return {
		changes: status.changes.map((c) => ({ ...c, label: label(c.collection) })),
		open: Object.entries(status.open).map(([collection, open]) => ({ ...open, collection, label: label(collection) })),
	};
}

function childPagesRoutes() {
	return {
		/** The Child Pages page: the switches it needs, each collection and its field. */
		"childPages/status": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "none" },
				handler: async (ctx) => {
					const features = await ctxFeatures(ctx);
					const on = isOn(features, CHILD_PAGES_FEATURE);
					const db = await databaseFor();
					const meta = db ? await readMeta(db) : [];
					return {
						enabled: on,
						redirects: isOn(features, "redirects"),
						slugChanges: isOn(features, SLUG_CHANGES_FEATURE),
						pageParents: configuredPageParents().size,
						collections: meta
							.filter((m) => m.routable)
							.map((m) => ({ collection: m.collection, label: m.label, field: m.field !== null, conflict: m.conflict, urlPattern: m.urlPattern, nests: nestsBy(m, on) })),
						...(await statusFor(ctx, meta)),
					};
				},
			}),
		),

		/** The tree of a collection, for the Child Pages page. */
		"childPages/tree": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { collection } = parseInput(collectionInput, ctx.input);
					const { ct } = await routeTree(collection);
					const { tree } = ct;
					const shown = [...tree.nodes.values()].filter((n) => n.locale === tree.defaultLocale || !n.locale || tree.groups.get(n.group)?.length === 1);
					// Nested as the URLs are (the Parent page field, or the pageParents option): the page at each URL's parent path.
					const byPath = new Map<string, string>();
					for (const n of shown) {
						const url = ct.urls.get(n.id);
						if (n.published && url) byPath.set(comparablePath(url), n.id);
					}
					return {
						nested: ct.nested,
						field: ct.meta.field !== null,
						pages: shown.map((n) => {
							const path = comparablePath(ct.urls.get(n.id) ?? "");
							const up = path.slice(0, path.lastIndexOf("/"));
							const urlParent = up ? (byPath.get(up) ?? null) : null;
							return {
								...summaryOf(ct, n),
								/** The page this one is under in the URL tree. */
								parentId: urlParent === n.id ? null : urlParent,
								/** The page its Parent page field names (even when it doesn't count). */
								chosenParentId: n.parentId,
								depth: Math.max(0, path.split("/").filter(Boolean).length - 1),
								pendingChanges: n.pendingChanges,
								warnings: warningsFor(tree, n.id),
							};
						}),
					};
				},
			}),
		),

		/** The editor panel: an entry's URL, parent, ancestors and children, and what to watch out for. */
		"childPages/entry": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { collection, id } = parseInput(entryInput, ctx.input);
					const features = await ctxFeatures(ctx);
					const { db, ct } = await routeTree(collection);
					const { tree } = ct;
					const node = tree.nodes.get(id);
					const switches = { enabled: isOn(features, CHILD_PAGES_FEATURE), redirects: isOn(features, "redirects"), slugChanges: isOn(features, SLUG_CHANGES_FEATURE) };
					if (!node || !ct.meta.field) return { ...switches, field: ct.meta.field !== null, found: Boolean(node), nested: ct.nested };
					const waiting = await stagedParent(db, node.draftRevisionId).catch(() => undefined);
					const liveGroup = node.parentId ? tree.nodes.get(node.parentId)?.group : null;
					const pending = waiting !== undefined && waiting !== (liveGroup ?? null);
					const pendingNode = pending && waiting ? (tree.groups.get(waiting) ?? []).find((n) => n.locale === node.locale) ?? tree.groups.get(waiting)?.[0] : undefined;
					return {
						...switches,
						field: true,
						found: true,
						nested: ct.nested,
						url: ct.urls.get(node.id) ?? null,
						published: node.published,
						slug: node.slug,
						digitSlug: Boolean(node.slug && DIGIT_SLUG.test(node.slug)),
						parent: summaryOf(ct, node.parentId ? tree.nodes.get(node.parentId) : undefined),
						pendingParent: pending ? { parent: summaryOf(ct, pendingNode), loop: Boolean(waiting && loopWith(tree, node.group, waiting)) } : null,
						ancestors: ancestorsOf(tree, node.id).map((n) => summaryOf(ct, n)),
						children: childrenOf(tree, node.id).map((n) => ({ ...summaryOf(ct, n), nested: n.effectiveParentId === node.id })),
						warnings: warningsFor(tree, node.id),
					};
				},
			}),
		),

		/** The Parent column of a content list page: each listed entry's parent page. */
		"childPages/parents": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { collection, ids } = parseInput(idsInput, ctx.input);
					const db = await databaseFor();
					const meta = db ? (await readMeta(db)).find((m) => m.collection === collection) : undefined;
					if (!db || !meta?.field) return { entries: {} };
					const tree = await readTree(db, meta, true);
					const entries: Record<string, { id: string; title: string; counts: boolean } | null> = {};
					for (const id of ids) {
						const node = tree.nodes.get(id);
						const parent = node?.parentId ? tree.nodes.get(node.parentId) : undefined;
						entries[id] = parent ? { id: parent.id, title: titleOf(parent), counts: node?.effectiveParentId === parent.id } : null;
					}
					return { entries };
				},
			}),
		),

		/**
		 * Re-check redirects: settle every collection with the field again (recheckCollection). Declared read-only for
		 * the page cache's sake: it saves no settings, and clears the pages that moved itself.
		 */
		"childPages/recheck": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "none" },
				handler: async (ctx) => {
					const { PluginRouteError } = await import("emdash");
					const db = await databaseFor();
					if (!db) throw new PluginRouteError("NO_DATABASE", "The site's D1 database (DB) isn't available.", 500);
					const features = await ctxFeatures(ctx);
					invalidatePageTrees();
					const meta = await readMeta(db);
					const failed: string[] = [];
					for (const m of meta.filter((c) => c.field)) {
						try {
							await recheckCollection(ctx, db, features, m.collection);
						} catch (error) {
							ctx.log.error("Child pages: Re-check redirects failed", { collection: m.collection, error: String(error) });
							await recordFailure(ctx, m.collection, "Redirects re-checked", error);
							failed.push(m.label);
						}
					}
					if (failed.length) throw new PluginRouteError("RECHECK_FAILED", `Couldn't re-check ${failed.join(", ")}. Try again in a moment.`, 500);
					return statusFor(ctx, meta);
				},
			}),
		),

		/** The dry run of "Import parents from configuration" (the Child Pages page applies it through EmDash's content API). */
		"childPages/import/plan": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { collection } = parseInput(collectionInput, ctx.input);
					const { db, ct } = await routeTree(collection);
					if (!ct.meta.field) return { field: false, rows: [] };
					return { field: true, rows: await importPlan(db, ct) };
				},
			}),
		),
	};
}

// ── The module ───────────────────────────────────────────────────

/** Settle after a change to a page, when the feature is on and the collection has the field. */
async function changed(ctx: PluginContext, collection: string, id: string | null, reason: string): Promise<void> {
	if (!COLLECTION_SLUG.test(collection)) return;
	const db = await databaseFor();
	if (!db) return;
	invalidatePageTrees();
	const meta = (await readMeta(db)).find((m) => m.collection === collection);
	if (!meta?.field) return;
	await bumpVersion(ctx);
	try {
		await settleCollection(ctx, db, await ctxFeatures(ctx), collection, id, reason);
	} catch (error) {
		// The snapshot is as it was, so the next change (or Re-check redirects) works these moves out again.
		ctx.log.error("Child pages: could not work out the redirects for this change; the next change, or Re-check redirects on the Child Pages page, makes them", { collection, reason, error: String(error) });
		await recordFailure(ctx, collection, reason, error);
	}
}

const contentId = (content: Record<string, unknown> | undefined) => (content && typeof content.id === "string" ? content.id : null);

export function childPagesPack(): PackModule {
	// The resolver follows stored parents while the feature is on (src/core/content-url.ts).
	configureStoredParents(childPagesProvider());
	return {
		id: CHILD_PAGES_FEATURE,
		label: "Child Pages",
		features: FEATURES,
		adminPages: [{ path: "/child-pages", label: "Child Pages", icon: "tree-structure" }],
		routes: childPagesRoutes(),
		hooks: {
			"content:beforePublish": loopGuard,
			"content:afterPublish": (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => changed(ctx, event.collection, contentId(event.content), "A page was published"),
			"content:afterUnpublish": (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => changed(ctx, event.collection, contentId(event.content), "A page was unpublished"),
			"content:afterDelete": (event: { id: string; collection: string; permanent: boolean }, ctx: PluginContext) =>
				changed(ctx, event.collection, event.id, event.permanent ? "A page was deleted" : "A page was moved to the trash"),
			"content:afterRestore": (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => changed(ctx, event.collection, contentId(event.content), "A page was restored"),
			// Collections without drafts save their links at once: a published entry's save can move pages too.
			// (With revisions, a save of a published entry waits in a draft revision: nothing changes until it's published.)
			"content:afterSave": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
				if (event.content?.status !== "published" || event.content.draftRevisionId) return;
				await changed(ctx, event.collection, contentId(event.content), "A page was saved");
			},
		},
		// Runs for every save of the switches: only this module's switch matters.
		featuresChanged: async (ctx, before, after) => {
			const was = isOn(before, CHILD_PAGES_FEATURE);
			const now = isOn(after, CHILD_PAGES_FEATURE);
			if (was === now) return;
			const db = await databaseFor();
			if (!db) {
				ctx.log.error("Child pages: the site's D1 database (DB) isn't available, so the switch made no redirects");
				return;
			}
			await settleSwitch(ctx, db, after, now);
		},
		// While the switch is off the Child Pages page is out of the sidebar: what turning it off left undone shows on the Features page.
		featureNotice: async (ctx, features) => (isOn(features, CHILD_PAGES_FEATURE) ? null : offNotice(await readStatus(ctx))),
		// content:read for the content hooks; hooks.content-policy:register (beforePublish) is added from the hooks (src/core/compose.ts).
		capabilities: ["content:read"],
	};
}

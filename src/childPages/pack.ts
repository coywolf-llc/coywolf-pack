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
import type { FeatureDef, PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { SLUG_CHANGES_FEATURE, type UrlMove, applyUrlMoves } from "../redirects/slug-changes.js";
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

/** Most redirects written for one change (a page that moved, a parent that went away, the switch). */
export const MAX_MOVES = 200;

/** The nested URLs last seen per collection (entry id → URL, only those that differ from the URL with no parent page). */
const snapshotKey = (collection: string) => `state:childPages:paths:${collection}`;
/** The last change's redirects, for the Child Pages page. */
const STATUS_KEY = "state:childPages:lastChange";

interface Snapshot {
	paths: Record<string, string>;
	at: string;
}

export interface ChangeStatus {
	at: string;
	collection: string;
	reason: string;
	/** Pages whose URL changed (besides the one that was edited). */
	moved: number;
	/** Redirects added or updated. */
	written: number;
	/** Over MAX_MOVES: left without a redirect. */
	skipped: number;
	/** Redirect Manager or Slug changes off: no redirects were made. */
	redirectsOff: boolean;
	/** New URLs that another redirect (one Slug changes didn't make) still sends elsewhere: the page there can't be reached. */
	shadowed?: string[];
}

const NO_PARENTS: StoredParents = { parentOf: new Map(), idOf: new Map() };

/** A version for the URL fingerprint: time-ordered, unique enough. */
const newVersion = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;

async function bumpVersion(ctx: PluginContext): Promise<void> {
	const version = newVersion();
	await ctx.settings.set(VERSION_SETTING, version);
	rememberSiteSetting(VERSION_SETTING, version);
}

/** The URLs of a collection's published entries with no parent pages (the `pageParents` option still applies), with Child pages on. */
async function baseUrls(db: D1Database, state: ChildPagesState, collection: string, tree: PageTreeData): Promise<Map<string, string | null>> {
	const resolver = createEntryUrlResolver(db, { childPages: { collections: state.collections, parents: () => NO_PARENTS } });
	return resolver.urls(collection, publishedEntries(tree));
}

const publishedEntries = (tree: PageTreeData) =>
	[...tree.nodes.values()].filter((n) => n.published && n.slug).map((n) => ({ id: n.id, slug: n.slug, publishedAt: n.publishedAt, locale: n.locale }));

/** The snapshot of nested URLs: published entries whose URL differs from their URL with no parent page. */
function snapshotOf(current: CollectionTree, base: Map<string, string | null>): Snapshot {
	const paths: Record<string, string> = {};
	for (const node of current.tree.nodes.values()) {
		const url = current.urls.get(node.id);
		if (node.published && url && url !== base.get(node.id)) paths[node.id] = url;
	}
	return { paths, at: new Date().toISOString() };
}

const titleOf = (node: PageNode | undefined) => node?.title?.trim() || node?.slug || node?.id || "";

/** Redirect Manager and Slug changes, the parts the 301s need. */
const redirectsOn = (features: FeatureMap) => isOn(features, "redirects") && isOn(features, SLUG_CHANGES_FEATURE);

async function applyMoves(ctx: PluginContext, db: D1Database, features: FeatureMap, collection: string, moves: UrlMove[], reason: string): Promise<void> {
	if (!moves.length) return;
	const kept = moves.slice(0, MAX_MOVES);
	const off = !redirectsOn(features);
	const result = off ? { written: 0, shadowed: [] as string[] } : await applyUrlMoves(ctx, db, kept);
	if (moves.length > MAX_MOVES) ctx.log.warn("Child pages: too many pages moved at once; the rest got no redirect", { collection, moved: moves.length, max: MAX_MOVES });
	const status: ChangeStatus = {
		at: new Date().toISOString(),
		collection,
		reason,
		moved: moves.length,
		written: result.written,
		skipped: Math.max(0, moves.length - MAX_MOVES),
		redirectsOff: off,
		...(result.shadowed.length ? { shadowed: result.shadowed.slice(0, 50) } : {}),
	};
	await ctx.kv.set(STATUS_KEY, status).catch(() => undefined);
	ctx.log.info("Child pages: URLs changed", { ...status });
}

/**
 * After a change to a collection's published pages: compare every page's URL with the
 * snapshot, add 301s for those that moved (not `except`, the entry that changed: Slug
 * changes and Removed content handle it), and keep the new snapshot. Without a snapshot
 * (the first change since the field was added) it only records one.
 */
export async function settleCollection(ctx: PluginContext, db: D1Database, features: FeatureMap, collection: string, except: string | null, reason: string): Promise<void> {
	invalidatePageTrees();
	const meta = (await readMeta(db)).find((m) => m.collection === collection);
	if (!meta?.field) return;
	const current = await collectionTree(db, collection, { on: true });
	if (!current) return;
	const state = await readChildPagesState(db);
	const base = await baseUrls(db, state, collection, current.tree);
	const before = await ctx.kv.get<Snapshot>(snapshotKey(collection)).catch(() => null);
	const moves: UrlMove[] = [];
	if (before?.paths) {
		for (const node of current.tree.nodes.values()) {
			if (!node.published || node.id === except) continue;
			const now = current.urls.get(node.id);
			const was = before.paths[node.id] ?? base.get(node.id);
			if (now && was && comparablePath(now) !== comparablePath(was)) moves.push({ collection, entryId: node.id, title: titleOf(node), from: was, to: now });
		}
	}
	await applyMoves(ctx, db, features, collection, moves, reason);
	await ctx.kv.set(snapshotKey(collection), snapshotOf(current, base));
}

/**
 * The switch was turned on or off: redirect every published page whose URL changes
 * (nested → flat when off, flat → nested when on), and start the snapshot afresh.
 */
export async function settleSwitch(ctx: PluginContext, db: D1Database, features: FeatureMap, on: boolean): Promise<void> {
	invalidatePageTrees();
	const nesting = (await readMeta(db)).filter((m) => m.field);
	for (const meta of nesting) {
		const [withParents, without] = await Promise.all([collectionTree(db, meta.collection, { on: true }), collectionTree(db, meta.collection, { on: false })]);
		if (!withParents || !without) continue;
		const moves: UrlMove[] = [];
		for (const node of withParents.tree.nodes.values()) {
			if (!node.published) continue;
			const nested = withParents.urls.get(node.id);
			const flat = without.urls.get(node.id);
			if (!nested || !flat || comparablePath(nested) === comparablePath(flat)) continue;
			moves.push({ collection: meta.collection, entryId: node.id, title: titleOf(node), from: on ? flat : nested, to: on ? nested : flat });
		}
		await applyMoves(ctx, db, features, meta.collection, moves, on ? "Child Pages turned on" : "Child Pages turned off");
		if (on) {
			const base = await baseUrls(db, await readChildPagesState(db), meta.collection, withParents.tree);
			await ctx.kv.set(snapshotKey(meta.collection), snapshotOf(withParents, base));
		} else await ctx.kv.delete(snapshotKey(meta.collection)).catch(() => false);
	}
	await bumpVersion(ctx);
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
						lastChange: await ctx.kv.get<ChangeStatus>(STATUS_KEY).catch(() => null),
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
	await settleCollection(ctx, db, await ctxFeatures(ctx), collection, id, reason);
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
			if (db) await settleSwitch(ctx, db, after, now);
		},
		// content:read for the content hooks; hooks.content-policy:register (beforePublish) is added from the hooks (src/core/compose.ts).
		capabilities: ["content:read"],
	};
}

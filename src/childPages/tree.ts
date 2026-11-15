/**
 * Child pages: the parent tree of a collection, built from its rows and the
 * links of its "Parent page" field (EmDash reference field `parent_page`,
 * pages → pages). Pure: no I/O and no imports of the rest of the pack, so
 * Node's test runner loads it directly (src/childPages/read.ts reads the rows).
 *
 * What counts for URLs:
 * - a page nests under its parent page only while that parent is published
 *   (a trashed, deleted, unpublished or scheduled parent makes it top level);
 * - pages in a loop (a page that is its own ancestor, a page that is its own
 *   parent included) are top level: every link inside the loop is dropped,
 *   while pages below the loop keep theirs;
 * - a translation's parent is the parent page in its own locale, else in the
 *   default locale.
 */

/** The field Child pages adds to a collection ("Parent page"). */
export const PARENT_FIELD = "parent_page";
/** The field's label in the editor. */
export const PARENT_FIELD_LABEL = "Parent page";
/** Pages this deep or deeper get a warning (the resolver itself follows 32 levels). */
export const DEPTH_WARNING = 8;
/** All digits: a slug that a paginated archive's /page/N/ tail, or a theme's page-number rule, can mistake for a page number. */
export const DIGIT_SLUG = /^\d+$/;

/** A row of the collection's table (`ec_<collection>`), as read for the tree. */
export interface PageRow {
	id: string;
	slug: string | null;
	locale: string | null;
	translation_group: string | null;
	status: string | null;
	title: string | null;
	published_at?: string | null;
	draft_revision_id?: string | null;
	live_revision_id?: string | null;
}

/** One link of the parent field: the entry's translation group and its parent's. */
export interface ParentLink {
	entry: string;
	parent: string;
}

export interface PageNode {
	id: string;
	slug: string | null;
	locale: string | null;
	group: string;
	title: string | null;
	status: string;
	published: boolean;
	publishedAt: string | null;
	/** Edits saved but not published (a draft revision that isn't the live one). */
	pendingChanges: boolean;
	/** The draft revision, when there is one (a parent page chosen but not published waits in it). */
	draftRevisionId: string | null;
	/** The field has a value (its live, published selection). */
	hasParent: boolean;
	/** The parent entry the field names, in this entry's locale or the default one (null: none, or it's gone). */
	parentId: string | null;
	/** The parent that counts for URLs: published and not in a loop. */
	effectiveParentId: string | null;
	/** In a loop of parent links (its own ancestor). */
	loop: boolean;
}

export interface PageTreeData {
	collection: string;
	/** Every entry that isn't in the trash, by id. */
	nodes: Map<string, PageNode>;
	/** Translation group → its entries. */
	groups: Map<string, PageNode[]>;
	defaultLocale: string;
}

/** The entry of `group` for `locale`: that locale, else the default locale, else the first. */
function inLocale(entries: PageNode[] | undefined, locale: string | null, defaultLocale: string): PageNode | null {
	if (!entries?.length) return null;
	return entries.find((e) => e.locale === locale) ?? entries.find((e) => e.locale === defaultLocale) ?? entries[0] ?? null;
}

/** Build the tree from the collection's rows (none in the trash) and the field's links. */
export function buildPageTree(collection: string, rows: PageRow[], links: ParentLink[], defaultLocale = "en"): PageTreeData {
	const nodes = new Map<string, PageNode>();
	const groups = new Map<string, PageNode[]>();
	for (const row of rows) {
		const status = row.status ?? "draft";
		const group = row.translation_group ?? row.id;
		const node: PageNode = {
			id: row.id,
			slug: row.slug,
			locale: row.locale,
			group,
			title: row.title,
			status,
			published: status === "published",
			publishedAt: row.published_at ?? null,
			pendingChanges: Boolean(row.draft_revision_id && row.draft_revision_id !== row.live_revision_id),
			draftRevisionId: row.draft_revision_id ?? null,
			hasParent: false,
			parentId: null,
			effectiveParentId: null,
			loop: false,
		};
		nodes.set(node.id, node);
		const list = groups.get(group);
		if (list) list.push(node);
		else groups.set(group, [node]);
	}
	// A single-value field: one link per entry (the first wins should a site have more).
	const parentGroupOf = new Map<string, string>();
	for (const link of links) if (!parentGroupOf.has(link.entry)) parentGroupOf.set(link.entry, link.parent);
	for (const node of nodes.values()) {
		const parentGroup = parentGroupOf.get(node.group);
		if (parentGroup === undefined) continue;
		node.hasParent = true;
		node.parentId = parentGroup === node.group ? node.id : (inLocale(groups.get(parentGroup), node.locale, defaultLocale)?.id ?? null);
	}
	markLoops(nodes);
	for (const node of nodes.values()) {
		const parent = node.parentId ? nodes.get(node.parentId) : undefined;
		node.effectiveParentId = parent && parent.published && !node.loop ? parent.id : null;
	}
	return { collection, nodes, groups, defaultLocale };
}

/** Mark every entry on a cycle of parent links (a self-parent included). */
function markLoops(nodes: Map<string, PageNode>): void {
	const state = new Map<string, 1 | 2>(); // 1: on the current walk, 2: done
	for (const start of nodes.values()) {
		if (state.has(start.id)) continue;
		const walk: PageNode[] = [];
		let node: PageNode | undefined = start;
		while (node && !state.has(node.id)) {
			state.set(node.id, 1);
			walk.push(node);
			node = node.parentId ? nodes.get(node.parentId) : undefined;
		}
		// Back on this walk: everything from there on is the loop.
		if (node && state.get(node.id) === 1) {
			for (let i = walk.indexOf(node); i < walk.length; i++) (walk[i] as PageNode).loop = true;
		}
		for (const done of walk) state.set(done.id, 2);
	}
}

/**
 * The parent slugs the URL resolver follows (src/core/content-url.ts StoredParents). Every
 * entry is listed with its parent, drafts too: an unpublished page's URL is where it was (or
 * will be), which Removed content and the editor panel ask for. Chains continue through
 * published entries only (idOf), as only published parents count.
 */
export function storedParentsOf(tree: PageTreeData): { parentOf: Map<string, string | null>; idOf: Map<string, string> } {
	const parentOf = new Map<string, string | null>();
	const idOf = new Map<string, string>();
	// Default locale first, so its entries win a slug shared across locales.
	const ordered = [...tree.nodes.values()].sort((a, b) => Number(b.locale === tree.defaultLocale) - Number(a.locale === tree.defaultLocale));
	for (const node of ordered) {
		if (!node.slug) continue;
		if (node.published && !idOf.has(node.slug)) idOf.set(node.slug, node.id);
		if (!node.hasParent) continue;
		const parent = node.effectiveParentId ? tree.nodes.get(node.effectiveParentId) : undefined;
		parentOf.set(node.id, parent?.slug ?? null);
	}
	return { parentOf, idOf };
}

/** The entry's ancestors that count for URLs, root first (not the entry itself). Stops at 32. */
export function ancestorsOf(tree: PageTreeData, id: string): PageNode[] {
	const out: PageNode[] = [];
	const seen = new Set([id]);
	let up = tree.nodes.get(id)?.effectiveParentId ?? null;
	while (up && !seen.has(up) && out.length < 32) {
		const node = tree.nodes.get(up);
		if (!node) break;
		out.unshift(node);
		seen.add(up);
		up = node.effectiveParentId;
	}
	return out;
}

/** Entries whose field names this entry (or its translation group), sorted by title. `effective`: only those nested under it for URLs. */
export function childrenOf(tree: PageTreeData, id: string, options: { effective?: boolean } = {}): PageNode[] {
	const node = tree.nodes.get(id);
	if (!node) return [];
	const groupIds = new Set((tree.groups.get(node.group) ?? []).map((n) => n.id));
	const out = [...tree.nodes.values()].filter((n) => n.id !== id && (options.effective ? n.effectiveParentId === id : n.parentId !== null && groupIds.has(n.parentId) && n.locale === node.locale));
	return out.sort((a, b) => (a.title ?? a.slug ?? "").localeCompare(b.title ?? b.slug ?? ""));
}

/** Every entry below this one for URLs (children, their children…), parents before children. */
export function descendantsOf(tree: PageTreeData, id: string): PageNode[] {
	const out: PageNode[] = [];
	const seen = new Set([id]);
	const queue = [id];
	while (queue.length) {
		const current = queue.shift() as string;
		for (const node of tree.nodes.values()) {
			if (node.effectiveParentId !== current || seen.has(node.id)) continue;
			seen.add(node.id);
			out.push(node);
			queue.push(node.id);
		}
	}
	return out;
}

export type PageWarning = "loop" | "parentUnpublished" | "parentMissing" | "deep" | "digitSlug";

/** What the admin flags for an entry: a loop, a parent that doesn't count, a deep page, an all-digit slug. */
export function warningsFor(tree: PageTreeData, id: string): PageWarning[] {
	const node = tree.nodes.get(id);
	if (!node) return [];
	const out: PageWarning[] = [];
	if (node.loop) out.push("loop");
	else if (node.hasParent && !node.parentId) out.push("parentMissing");
	else if (node.parentId && !node.effectiveParentId) out.push("parentUnpublished");
	if (ancestorsOf(tree, id).length + 1 >= DEPTH_WARNING) out.push("deep");
	if (node.slug && DIGIT_SLUG.test(node.slug)) out.push("digitSlug");
	return out;
}

/**
 * Whether choosing `parentGroup` for the entry of `group` makes a loop with the
 * other entries' current parents (and `planned` ones, group → parent group, which
 * win): the parent is the entry itself, or the entry is one of the parent's
 * ancestors. Returns the chain from the parent up to the entry (titles or slugs),
 * or null when there's no loop.
 */
export function loopWith(tree: PageTreeData, group: string, parentGroup: string, planned?: ReadonlyMap<string, string>): string[] | null {
	const name = (g: string) => {
		const node = tree.groups.get(g)?.[0];
		return node?.title || node?.slug || g;
	};
	if (parentGroup === group) return [name(group)];
	const chain = [name(parentGroup)];
	const seen = new Set([parentGroup]);
	let current = parentGroup;
	for (let i = 0; i < 64; i++) {
		const entry = inLocale(tree.groups.get(current), null, tree.defaultLocale);
		const up = planned?.get(current) ?? (entry?.parentId ? tree.nodes.get(entry.parentId)?.group : undefined);
		if (!up) return null;
		chain.push(name(up));
		if (up === group) return chain;
		if (seen.has(up)) return null; // A loop the entry isn't part of.
		seen.add(up);
		current = up;
	}
	return null;
}

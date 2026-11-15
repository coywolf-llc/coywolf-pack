/**
 * Child pages for themes (`@coywolf/emdash/astro`): the page tree of a
 * collection with every page's URL, the path → page lookup for a catch-all
 * route (with the flat → nested redirect), and nested URLs for EmDash's menus.
 *
 * URLs come from the pack's resolver (src/core/content-url.ts), so the theme,
 * the sitemaps, breadcrumbs, search and redirects agree. With Child pages off,
 * the tree still lists the pages, nested only by the `pageParents` option.
 *
 * ```astro
 * ---
 * import { isPreviewRequest, loadPageTree, resolvePagePath } from "@coywolf/emdash/astro";
 * const tree = await loadPageTree();
 * const match = resolvePagePath(tree, segments, { search: Astro.url.search, preview: isPreviewRequest() });
 * if (match && "redirect" in match) return Astro.redirect(match.redirect, 301);
 * const page = match?.page;
 * ---
 * ```
 *
 * The tree is one D1 round trip per request (src/childPages/read.ts readCollection), shared by
 * the route, the page template, the menus, breadcrumbs and the schema graph.
 */
import { comparablePath, interpolateUrlPattern } from "../core/content-url.js";
import { noteReadFailure } from "../core/read-failures.js";
import { requestMemo, requestStore } from "../core/request-memo.js";
import { workerEnv } from "../shared.js";
import { collectionTree, type CollectionTree } from "./read.js";
import { type PageNode } from "./tree.js";

export interface PageTreeItem {
	/** The entry id (EmDash's ULID). */
	id: string;
	slug: string;
	title: string;
	/** Root-relative URL, e.g. "/apps/coywolf-pack/". */
	url: string;
	locale: string | null;
	status: string;
	published: boolean;
	/** The published page at the URL's parent path (its parent page, or a `pageParents` parent that's a page), if any. */
	parentId: string | null;
}

/** One step of a page's trail: a page (with its id and title), or a path segment from the `pageParents` option that isn't a page. */
export interface PageTrailItem {
	slug: string;
	url: string;
	id: string | null;
	title: string | null;
}

export interface PageTree {
	collection: string;
	/** Stored parents apply: Child pages is on and the collection has its Parent page field. */
	nested: boolean;
	/** Published pages, by title. */
	pages: PageTreeItem[];
	/**
	 * The page with this slug, or null: a published page first (the default locale's before a translation's),
	 * else one that isn't published. Check `published` before showing it or its URL to visitors;
	 * resolvePagePath does.
	 */
	get(slug: string): PageTreeItem | null;
	byId(id: string): PageTreeItem | null;
	/** The page's URL, or null when there's no such page. */
	path(slug: string): string | null;
	/** The page's ancestors, root first (not the page itself). */
	trail(slug: string): PageTrailItem[];
	/** Published pages directly under this one, by title. */
	children(slug: string): PageTreeItem[];
	/**
	 * Cache tags for a page's response: the entry ids of the pages above it in its URL, and of the
	 * parent pages it has chosen all the way up, including ones that don't count right now
	 * (unpublished, scheduled): changing any of them (a new slug, a parent of its own, publishing
	 * it) clears this page, so a page cached at the top level while its parent was unpublished
	 * doesn't outlive the parent's publish. Add the page's own tags (getEmDashEntry's cacheHint) as usual.
	 */
	cacheTags(slug: string): string[];
	/**
	 * A flat page URL as EmDash builds it (menus, View links) → the page's nested URL, query and
	 * hash kept. Root-relative URLs, and absolute ones on `origin` (the site's URL) when given;
	 * other URLs come back unchanged.
	 */
	nest(url: string, origin?: string): string;
}

const BASE = "https://x.invalid";

/** The tree as themes use it (pure: from a collection tree read by read.ts). */
export function pageTreeFrom(source: CollectionTree): PageTree {
	const { tree, urls, meta } = source;
	const item = (node: PageNode): PageTreeItem | null => {
		const url = urls.get(node.id);
		if (!node.slug || !url) return null;
		// parentId is filled in below, from the URL: the page at its parent path (stored parents or the pageParents option alike).
		return { id: node.id, slug: node.slug, title: node.title?.trim() || node.slug, url, locale: node.locale, status: node.status, published: node.published, parentId: null };
	};
	const all = [...tree.nodes.values()]
		// Published before unpublished, then the default locale first: get(slug) takes the first.
		.sort((a, b) => Number(b.published) - Number(a.published) || Number(b.locale === tree.defaultLocale) - Number(a.locale === tree.defaultLocale))
		.map(item)
		.filter((i): i is PageTreeItem => i !== null);
	const bySlug = new Map<string, PageTreeItem>();
	const byId = new Map<string, PageTreeItem>();
	const byPath = new Map<string, PageTreeItem>();
	const byFlat = new Map<string, PageTreeItem>();
	for (const i of all) {
		byId.set(i.id, i);
		if (!bySlug.has(i.slug)) bySlug.set(i.slug, i);
		if (!i.published) continue;
		const path = comparablePath(i.url);
		if (!byPath.has(path)) byPath.set(path, i);
		const flat = comparablePath(interpolateUrlPattern({ pattern: meta.urlPattern, collection: meta.collection, slug: i.slug, id: i.id }));
		if (flat !== path && !byFlat.has(flat)) byFlat.set(flat, i);
	}
	for (const i of all) {
		const path = comparablePath(i.url);
		const up = path.slice(0, path.lastIndexOf("/"));
		const parent = up ? byPath.get(up) : undefined;
		i.parentId = parent && parent.id !== i.id ? parent.id : null;
	}
	const pages = all.filter((i) => i.published).sort((a, b) => a.title.localeCompare(b.title));

	const trail = (slug: string): PageTrailItem[] => {
		const page = bySlug.get(slug);
		if (!page) return [];
		const segments = comparablePath(page.url).split("/").filter(Boolean);
		const slash = page.url.endsWith("/");
		const out: PageTrailItem[] = [];
		for (let n = 1; n < segments.length; n++) {
			const path = `/${segments.slice(0, n).join("/")}`;
			const ancestor = byPath.get(path);
			out.push({ slug: segments[n - 1] as string, url: ancestor?.url ?? `${path}${slash ? "/" : ""}`, id: ancestor?.id ?? null, title: ancestor?.title ?? null });
		}
		return out;
	};

	return {
		collection: meta.collection,
		nested: source.nested,
		pages,
		get: (slug) => bySlug.get(slug) ?? null,
		byId: (id) => byId.get(id) ?? null,
		path: (slug) => bySlug.get(slug)?.url ?? null,
		trail,
		children: (slug) => {
			const page = bySlug.get(slug);
			return page ? pages.filter((p) => p.parentId === page.id) : [];
		},
		cacheTags: (slug) => {
			const ids = new Set(trail(slug).flatMap((t) => (t.id ? [t.id] : [])));
			// The chosen parents, whether or not they count for the URL now (a loop stops where it comes back around).
			const seen = new Set<string>();
			let up = tree.nodes.get(bySlug.get(slug)?.id ?? "")?.parentId ?? null;
			while (up && !seen.has(up) && seen.size < 32) {
				seen.add(up);
				ids.add(up);
				up = tree.nodes.get(up)?.parentId ?? null;
			}
			ids.delete(bySlug.get(slug)?.id ?? "");
			return [...ids];
		},
		nest: (url, origin) => nestUrl(url, byFlat, origin),
	};
}

/** Rewrite a root-relative URL (or an absolute one on `origin`) whose path is a page's flat URL. */
function nestUrl(url: string, byFlat: Map<string, PageTreeItem>, origin?: string): string {
	if (!url || !byFlat.size) return url;
	const rootRelative = url.startsWith("/") && !url.startsWith("//");
	let parsed: URL;
	try {
		parsed = new URL(url, BASE);
	} catch {
		return url;
	}
	const sameSite = !rootRelative && Boolean(origin) && parsed.origin === new URL(origin as string).origin;
	if (!rootRelative && !sameSite) return url; // Another site, "#top", "page" and the like.
	const page = byFlat.get(comparablePath(parsed.pathname));
	if (!page) return url;
	const nested = `${page.url}${parsed.search}${parsed.hash}`;
	return sameSite ? `${parsed.origin}${nested}` : nested;
}

/** The tree each collection had the last time this isolate read it, for a render whose read fails. */
const lastTrees = new Map<string, PageTree>();

/**
 * The page tree of a collection ("pages" unless named), read once per request.
 * `db` is the D1 binding or its name (default "DB"). When D1 can't be read, the tree this
 * isolate read last is used (the failure is noted, so the page isn't edge-cached, and logged);
 * an isolate with none yet throws, so a theme's error handling (a 503 that isn't cached) applies.
 */
export async function loadPageTree(db?: D1Database | string, options: { collection?: string } = {}): Promise<PageTree> {
	const collection = options.collection ?? "pages";
	const d1 = typeof db === "object" && db ? db : ((await workerEnv())[db ?? "DB"] as D1Database | undefined);
	if (!d1) throw new Error(`coywolf-pack: no D1 binding "${typeof db === "string" ? db : "DB"}" for loadPageTree`);
	return requestMemo(`childPages:pageTree:${collection}`, async () => {
		let source: CollectionTree | null;
		try {
			source = await collectionTree(d1, collection, { lenient: true });
		} catch (error) {
			const last = lastTrees.get(collection);
			if (!last) throw error;
			noteReadFailure("child pages: page tree");
			console.error("coywolf-pack: Child Pages: could not read the page tree; using the last one read for this render", error);
			return last;
		}
		if (!source) throw new Error(`coywolf-pack: loadPageTree: no collection "${collection}"`);
		const tree = pageTreeFrom(source);
		lastTrees.set(collection, tree);
		return tree;
	});
}

/** `redirect` comes with the page it leads to, for the redirect's cache tags (the page's id and tree.cacheTags). */
export type PagePathMatch = { page: PageTreeItem; path: string } | { redirect: string; page: PageTreeItem };

/**
 * True when EmDash accepted this request's `_preview` token (its middleware verifies the signature and puts
 * the previewed entry in the request context). For resolvePagePath's `preview` option. Not the same as the
 * URL having a `_preview` parameter, which anyone can add.
 */
export function isPreviewRequest(): boolean {
	return Boolean((requestStore() as { preview?: unknown } | undefined)?.preview);
}

/**
 * The page a catch-all route's path names (decoded segments, or the path):
 * `{ page }` when the path is the page's URL, `{ redirect }` (the page's URL, with
 * `options.search` kept, for previews and tracking parameters) when it's the flat
 * one-segment form of a nested page (`/coywolf-pack/` → `/apps/coywolf-pack/`),
 * and null otherwise (another page's path, a post, or nothing: let the route go on).
 * Check category archives first: they win over pages. Tell the two answers apart with
 * `"redirect" in match`: both carry the page.
 *
 * Only published pages, unless `options.preview` is true: a draft or scheduled page answers
 * null at both its nested and its flat path, so neither a `{ page }` nor a redirect tells a
 * visitor that it exists or where it will be. Pass `preview: isPreviewRequest()` on a route
 * that serves EmDash's previews; getEmDashEntry still decides whether the draft is shown.
 */
export function resolvePagePath(tree: PageTree, segments: readonly string[] | string, options: { search?: string; preview?: boolean } = {}): PagePathMatch | null {
	const parts = typeof segments === "string" ? comparablePath(segments).split("/").filter(Boolean) : segments.filter(Boolean);
	const slug = parts[parts.length - 1];
	if (!slug) return null;
	const page = tree.get(slug);
	if (!page || (!page.published && options.preview !== true)) return null;
	const requested = `/${parts.join("/")}`;
	if (comparablePath(page.url) === requested) return { page, path: page.url };
	if (parts.length === 1) return { redirect: `${encodePath(page.url)}${options.search ?? ""}`, page };
	return null;
}

/** A path with each segment percent-encoded once (slugs may be non-ASCII). */
function encodePath(path: string): string {
	return path
		.split("/")
		.map((segment) => {
			try {
				return encodeURIComponent(decodeURIComponent(segment));
			} catch {
				return encodeURIComponent(segment);
			}
		})
		.join("/");
}

interface MenuItemLike {
	url: string;
	children?: MenuItemLike[];
}

/**
 * EmDash's menus with nested page URLs: EmDash builds a menu item's URL for a page
 * from the collection's URL pattern, without its parents (`/coywolf-pack/`). Takes a
 * menu (`getMenu()`), its items, or null, and returns a copy with those URLs nested.
 * Pass `origin` (the site's URL) to nest absolute URLs on the site too.
 */
export function nestMenuUrls<T extends { items: MenuItemLike[] } | MenuItemLike[] | null | undefined>(menu: T, tree: PageTree, options: { origin?: string } = {}): T {
	if (!menu) return menu;
	const nestItems = (items: MenuItemLike[]): MenuItemLike[] =>
		items.map((item) => ({ ...item, url: tree.nest(item.url, options.origin), ...(Array.isArray(item.children) ? { children: nestItems(item.children) } : {}) }));
	if (Array.isArray(menu)) return nestItems(menu) as T;
	return { ...menu, items: nestItems((menu as { items: MenuItemLike[] }).items ?? []) } as T;
}

/**
 * Archive page URLs. Page 3 of an archive is `/3/` under its base with Short
 * page URLs on (`/news/web-development/3/`, `/tag/coyotes/3/`, `/3/` for the
 * home page), and `/page/3/` under it with the switch off, as WordPress has
 * it. Page 1 is the base itself. A page number is 1 to 99999 written without
 * a leading zero, so `/03/` and `/100000/` aren't page numbers.
 *
 * The theme's routes parse the page number (parsePagePath, through
 * archivePage in ./pack.ts): only the theme knows which paths are archives.
 * The pack's middleware only turns `/page/N/` into `/N/` (legacyPageRedirect)
 * while Short page URLs is on; the `bases` option tells it which prefixes
 * have archives whose own name could be "page". No imports, so `node --test` can load it.
 */

/** A page number in a URL: 1–99999, no leading zero. */
export const PAGE_NUMBER = /^[1-9]\d{0,4}$/;

/** The highest page number a URL can name (PAGE_NUMBER), so the highest a nav links to (lastPage). */
export const MAX_PAGE = 99_999;

/** How a URL named its page: `/N/` ("short") or `/page/N/` ("folder"). */
export type PageForm = "short" | "folder";

export interface PagePath {
	/** The archive's own path segments (the URL's, without the page part). */
	segments: string[];
	/** The page number; 1 when the URL names none. */
	page: number;
	/** How the URL named the page, or null when it didn't. */
	form: PageForm | null;
}

export interface PagePathOptions {
	/**
	 * Segments the archive's base always has, so a route's own first segments
	 * are never read as a page number. 0 for a catch-all route whose home page
	 * pages (`/2/`); 1 for `/tag/[...path]` (`/tag/2024/` is the tag "2024",
	 * `/tag/2024/2/` its page 2); 2 for `/search/{terms}/` in a catch-all route.
	 */
	minBase?: number;
}

/**
 * The page a route's path segments name: `[…, "page", "3"]` (folder form)
 * or `[…, "3"]` (short form), keeping at least `minBase` segments for the
 * archive. Anything else is page 1 of the whole path. Either form is read
 * whatever the Short page URLs switch says; archivePage redirects the one
 * that isn't in use.
 */
export function parsePagePath(segments: readonly string[], options: PagePathOptions = {}): PagePath {
	const minBase = Math.max(0, Math.floor(options.minBase ?? 0));
	const n = segments.length;
	if (n >= 2 && segments[n - 2] === "page" && PAGE_NUMBER.test(segments[n - 1]) && n - 2 >= minBase) {
		return { segments: segments.slice(0, -2), page: Number(segments[n - 1]), form: "folder" };
	}
	if (n >= 1 && PAGE_NUMBER.test(segments[n - 1]) && n - 1 >= minBase) {
		return { segments: segments.slice(0, -1), page: Number(segments[n - 1]), form: "short" };
	}
	return { segments: [...segments], page: 1, form: null };
}

/** A query string kept on page links: `"?s=coyote"`, `"s=coyote"`, URLSearchParams or a record. */
export type PageQuery = string | URLSearchParams | Record<string, string> | null | undefined;

/** `"?…"`, or "" for no query. */
export function queryString(query: PageQuery): string {
	if (!query) return "";
	const text = typeof query === "string" ? query.replace(/^\?/, "") : new URLSearchParams(query).toString();
	return text ? `?${text}` : "";
}

export interface PageHrefOptions {
	/** Page URLs are `/N/` (Short page URLs on) rather than `/page/N/`. archivePage returns it as `short`. */
	short: boolean;
	/** A query string kept on the link (search terms, for example). */
	query?: PageQuery;
	/** End page URLs in a slash. Default: as the base does (the home page's "/" counts as one). */
	slash?: boolean;
}

/**
 * The URL of page `page` of the archive at `base` (a site path such as "/",
 * "/news/web-development/" or "/tag/coyotes/"): the base itself for page 1,
 * then `{base}N/` or `{base}page/N/`, with the query string after it.
 *
 *   pageHref("/news/", 2, { short: true })                     → "/news/2/"
 *   pageHref("/", 3, { short: false, query: "?s=coyote" })     → "/page/3/?s=coyote"
 */
export function pageHref(base: string, page: number, options: PageHrefOptions): string {
	const root = `/${String(base ?? "").replace(/^\/+/, "")}`;
	const query = queryString(options.query);
	const n = Math.floor(page);
	if (!(n > 1)) return `${root}${query}`;
	const slash = options.slash ?? root.endsWith("/");
	return `${root.replace(/\/+$/, "")}${options.short ? "" : "/page"}/${n}${slash ? "/" : ""}${query}`;
}

/** A site path with repeated slashes collapsed, so a built Location can never start with "//" (another host). */
const collapse = (path: string) => path.replace(/\/{2,}/g, "/");

/** `base` (no trailing slash, "" for the home page) and its page `n` as a path, with or without the trailing slash. */
function joinPage(base: string, n: number, folder: boolean, slash: boolean): string {
	if (n <= 1) return base ? `${base}${slash ? "/" : ""}` : "/";
	return `${base}${folder ? "/page" : ""}/${n}${slash ? "/" : ""}`;
}

/** A prefix route as the middleware knows it: its path segments, and how many segments after them always belong to the archive. */
export interface PageBase {
	prefix: string[];
	minBase: number;
}

/**
 * The `bases` option (`{ "/tag/": 1, "/search/": 1 }`) as a list, longest
 * prefix first. A prefix with no segments ("/") or a count that isn't a whole
 * number above 0 says nothing, and is left out.
 */
export function pageBases(bases: Record<string, number> | null | undefined): PageBase[] {
	return Object.entries(bases ?? {})
		.map(([prefix, minBase]) => ({ prefix: prefix.split("/").filter(Boolean), minBase: Math.floor(Number(minBase)) || 0 }))
		.filter((base) => base.prefix.length > 0 && base.minBase > 0)
		.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * The 301 the pack's middleware answers for an old `/page/N/` URL while Short
 * page URLs is on, in one hop: `/page/1/` goes to the base, and `/page/3`
 * straight to `/3/` (no stop at `/page/3/`). Site-relative (the edge cache
 * is shared by every hostname the Worker answers), with the query string
 * kept. `slash`: the site's trailing-slash policy isn't "never". Null when
 * the path doesn't end in a page.
 *
 * Any path ending in `/page/N` counts, since the middleware doesn't know the
 * theme's routes, except under a prefix in `bases` (pageBases) where "page"
 * is one of the segments the archive always has: with `{ "/tag/": 1 }`,
 * `/tag/page/2/` is the tag "page" (its page 2, in the short form), as the
 * theme's parsePagePath with `minBase: 1` reads it, so it's left alone, while
 * `/tag/page/page/2/` goes to `/tag/page/2/`.
 */
export function legacyPageRedirect(pathname: string, search: string, options: { slash: boolean; bases?: readonly PageBase[] }): string | null {
	const match = /^(.*?)\/page\/([^/]+)\/?$/.exec(pathname);
	if (!match || !PAGE_NUMBER.test(match[2])) return null;
	const base = collapse(match[1]).replace(/\/+$/, "");
	const segments = base.split("/").filter(Boolean);
	// The longest listed prefix the path is under (pageBases sorts them).
	const route = options.bases?.find((b) => b.prefix.every((segment, i) => segments[i] === segment));
	if (route && segments.length - route.prefix.length < route.minBase) return null;
	return `${joinPage(base, Number(match[2]), false, options.slash)}${search}`;
}

/**
 * Where a route should send an archive request it parsed (parsePagePath)
 * instead of rendering it, or null to render it: page 1 named in either form
 * goes to the base; `/page/N/` goes to `/N/` while Short page URLs is on
 * (the middleware normally answers that first); `/N/` goes to `/page/N/`
 * while it's off, so links made while it was on keep working. Built from the
 * request's own path (the route's prefix and encoding kept) and query.
 */
export function archiveRedirect(pathname: string, search: string, parsed: PagePath, options: { short: boolean; slash: boolean }): string | null {
	if (!parsed.form) return null;
	const moves = parsed.page === 1 || (parsed.form === "folder") === options.short;
	if (!moves) return null;
	const parts = collapse(pathname).replace(/\/+$/, "").split("/");
	const base = parts.slice(0, parts.length - (parsed.form === "folder" ? 2 : 1)).join("/");
	return `${joinPage(base, parsed.page, !options.short, options.slash)}${search}`;
}

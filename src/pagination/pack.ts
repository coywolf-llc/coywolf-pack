/**
 * Pagination module: numbered page links for archives, from the theme's
 * routes. The pack ships the parts (exported from "@coywolf/emdash/astro"):
 * the Pagination component (src/astro/pagination/Pagination.astro),
 * archivePage (below) to read the page number from a route's path,
 * countEntries (./count.ts) for the last page, and pageHref (./urls.ts) for
 * canonicals. Off by default; see docs/pagination.md.
 *
 * Two switches, each on its own (neither needs the other):
 * - `pagination`: numbered links (first, nearby pages, last). Off, the
 *   component shows Previous and Next only and countEntries reads nothing.
 * - `shortPageUrls`: page 3 is `/3/`, not `/page/3/`. This module's
 *   middleware then answers an old `/page/N/` URL with a 301 to `/N/`. Off,
 *   links are `/page/N/`, the middleware does nothing, and archivePage sends
 *   `/N/` to `/page/N/`. It's a module of its own on the Features page
 *   (shortPageUrlsPack), not a part of Pagination: a part is off whenever its
 *   module is (resolveFeatures), and hiding the page numbers must not change
 *   every archive URL and canonical.
 * Neither direction runs while the other's switch says otherwise, so the two
 * never redirect in a loop, and both 301s tell browsers not to keep them
 * (`Cache-Control: no-cache`), so a browser doesn't replay one after the
 * switch changes. For a few minutes after a switch is saved, other Worker
 * isolates still have the old switches (FEATURES_TTL_MS); the Features save
 * clears every cached page, and again once every isolate has the new
 * switches (the settling purge), so a stale answer doesn't stay at the edge.
 */
import { siteTrailingPolicy } from "../core/content-url.js";
import { isOn, registerFeatures, siteFeatureState } from "../core/features.js";
import type { FeatureDef, PackMiddleware, PackModule } from "../core/module.js";
import { REDIRECTS_TAG, keepAtEdge } from "../pageCache/lib.js";
import { type PageBase, type PagePath, type PagePathOptions, archiveRedirect, legacyPageRedirect, pageBases, parsePagePath } from "./urls.js";

export const PAGINATION_FEATURE = "pagination";
export const SHORT_URLS_FEATURE = "shortPageUrls";

const NUMBERED: FeatureDef = {
	id: PAGINATION_FEATURE,
	label: "Pagination",
	description:
		"Numbered page links for archives (first, nearby pages and last), on one line at every width, from the Pagination component in the theme's routes. Off, the component shows only Previous and Next. Page URLs stay as they are either way: Short page URLs is a switch of its own.",
	default: false,
};
const SHORT_URLS: FeatureDef = {
	id: SHORT_URLS_FEATURE,
	label: "Short page URLs",
	description:
		"Page 3 of an archive is /3/ (/news/3/) instead of /page/3/, and old /page/3/ links redirect to it. Works with Pagination on or off. Delete any redirect rules for /page/ URLs first: they answer before this one.",
	default: false,
};

export const FEATURES: FeatureDef[] = [NUMBERED, SHORT_URLS];
registerFeatures(FEATURES);

/** Build-time options (`pagination` in the pack's options). */
export interface PaginationOptions {
	/**
	 * The theme's archive routes under a prefix, for the `/page/N/` redirect:
	 * each prefix with how many segments after it always belong to the archive
	 * (the route's `minBase`, counted after the prefix).
	 *
	 *   bases: { "/tag/": 1, "/author/": 1, "/search/": 1 }
	 *
	 * `/tag/page/2/` is then left for the theme (page 2 of the tag "page"), and
	 * `/tag/coyotes/page/2/` still goes to `/tag/coyotes/2/`. Without it, every
	 * path that ends in `/page/N/` redirects.
	 */
	bases?: Record<string, number>;
}

/** The prefix routes the middleware knows (options.bases), longest prefix first. */
let bases: PageBase[] = [];

export function paginationPack(options: PaginationOptions = {}): PackModule {
	// Module-level, like the content URL config, so the middleware sees it.
	bases = pageBases(options.bases);
	return {
		id: "pagination",
		label: "Pagination",
		features: [NUMBERED],
		// No settings of its own: the theme passes everything to the component.
		adminPages: [],
	};
}

/** Short page URLs: its own module, so its switch doesn't depend on Pagination's. */
export function shortPageUrlsPack(): PackModule {
	return { id: "shortPageUrls", label: "Short page URLs", features: [SHORT_URLS], adminPages: [] };
}

/** How long the edge cache keeps a `/page/N/` redirect: until a Features or redirect save clears it, or 30 days. */
export const PAGE_REDIRECT_EDGE_MAX_AGE = 30 * 86400;

const SKIP = /^\/_emdash(\/|$)/;

/**
 * A page URL's 301. Browsers get `no-cache`: one that kept `/page/3/` →
 * `/3/` (or the theme's `/3/` → `/page/3/`) would loop with the other
 * direction once the switch changes. The Location is site-relative.
 */
const pageRedirect = (location: string) => new Response(null, { status: 301, headers: { Location: location, "Cache-Control": "no-cache" } });

/**
 * While Short page URLs is on: a GET or HEAD for `/…/page/N/` gets a 301 to
 * `/…/N/` (`/page/1/` to the base), with its query string, in one hop
 * (legacyPageRedirect). Any path that ends in `/page/N/` outside `/_emdash/`,
 * except under a prefix listed in the `bases` option where `page` is the
 * archive's own name (`/tag/page/2/`). Runs after the Redirect Manager's
 * middleware, so a stored rule for the same URL wins. Kept at the edge with
 * the redirects' tag (a redirect save clears it) and the settings generation
 * (a Features save does); browsers get `no-cache` (pageRedirect).
 */
export const paginationMiddleware: PackMiddleware = {
	module: "pagination",
	feature: SHORT_URLS_FEATURE,
	ownsCache: true,
	handle: async (context) => {
		const method = context.request.method;
		if (method !== "GET" && method !== "HEAD") return undefined;
		const { pathname, search } = context.url;
		if (SKIP.test(pathname) || !pathname.includes("/page/")) return undefined;
		const location = legacyPageRedirect(pathname, search, { slash: (await siteTrailingPolicy()) !== "never", bases });
		// Site-relative, and never anywhere else (legacyPageRedirect already collapses a leading "//").
		if (!location || new URL(location, context.url).origin !== context.url.origin) return undefined;
		keepAtEdge(context, PAGE_REDIRECT_EDGE_MAX_AGE, [REDIRECTS_TAG]);
		return pageRedirect(location);
	},
};

/** What archivePage answers. */
export interface ArchivePage extends PagePath {
	/**
	 * Answer the request with this instead of rendering it: a 301 to
	 * `redirect` that browsers don't keep (`Cache-Control: no-cache`). Set
	 * whenever `redirect` is.
	 */
	response?: Response;
	/** Where `response` goes: page 1 named in the URL, or the page form that isn't in use. Site-relative. */
	redirect?: string;
	/** Page URLs are `/N/` (Short page URLs is on). Pass it to pageHref. */
	short: boolean;
}

export interface ArchivePageOptions extends PagePathOptions {
	/** The site database, for the switches: a D1 binding name (default "DB") or the binding itself. */
	database?: string | D1Database;
}

/**
 * The archive page a route renders, from its path segments (decoded, or
 * Astro.params' catch-all string) and the request URL (Astro.url, for the
 * redirect's path and query):
 *
 *   const paged = await archivePage(segments, Astro.url, { minBase: 0 });
 *   if (paged.response) return paged.response;
 *   // paged.segments: the archive's base; paged.page: its page number; paged.short: the URL form.
 *
 * `/1/` and `/page/1/` redirect to the base; `/page/N/` to `/N/` while Short
 * page URLs is on (the middleware usually answers it first), and `/N/` to
 * `/page/N/` while it's off. Return `response` rather than
 * `Astro.redirect(paged.redirect, 301)`: a 301 without `Cache-Control:
 * no-cache` stays in the browser, and loops with the other direction once the
 * switch changes.
 *
 * When the switch can't be read (D1 unreachable for a moment), neither form
 * redirects to the other: the page renders as it was asked for, with `short`
 * following the URL, and the failed read keeps it out of the edge cache
 * (src/core/read-failures.ts). Only page 1 named in the URL still goes to the
 * base, which is right whatever the switch says.
 *
 * A numeric last segment is read as a page number (`form: "short"`): when
 * that page of the archive is empty, the route can look the whole path up as
 * an entry instead (see docs/pagination.md).
 */
export async function archivePage(segments: readonly string[] | string | undefined, url: URL | `/${string}`, options: ArchivePageOptions = {}): Promise<ArchivePage> {
	// The redirect is built from the request's path: a query string alone (Astro.url.search) would send every page to "/".
	if (typeof url === "string" && !url.startsWith("/")) throw new TypeError("archivePage needs the request URL (Astro.url) or its path, not only its query string");
	const list = typeof segments === "string" || segments === undefined ? String(segments ?? "").split("/").filter(Boolean) : segments;
	const parsed = parsePagePath(list, options);
	// A failed read is noted by siteFeatureState, so the page rendered here isn't edge-cached.
	const { features, ok } = await siteFeatureState(options.database ?? "DB");
	const short = ok ? isOn(features, SHORT_URLS_FEATURE) : parsed.form === "short";
	if (!parsed.form) return { ...parsed, short };
	const request = typeof url === "string" ? new URL(url, "http://site.invalid") : url;
	const redirect = ok || parsed.page === 1 ? archiveRedirect(request.pathname, request.search, parsed, { short, slash: (await siteTrailingPolicy()) !== "never" }) : null;
	return redirect ? { ...parsed, short, redirect, response: pageRedirect(redirect) } : { ...parsed, short };
}

/**
 * Pagination module: numbered page links for archives, from the theme's
 * routes. The pack ships the parts (exported from "@coywolf/emdash/astro"):
 * the Pagination component (src/astro/pagination/Pagination.astro),
 * archivePage (below) to read the page number from a route's path,
 * countEntries (./count.ts) for the last page, and pageHref (./urls.ts) for
 * canonicals. Off by default; see docs/pagination.md.
 *
 * Two switches:
 * - `pagination`: numbered links (first, nearby pages, last). Off, the
 *   component shows Previous and Next only and countEntries reads nothing.
 * - `pagination.shortUrls`: page 3 is `/3/`, not `/page/3/`. This module's
 *   middleware then answers an old `/page/N/` URL with a 301 to `/N/`. Off,
 *   links are `/page/N/`, the middleware does nothing, and archivePage sends
 *   `/N/` to `/page/N/`.
 * Neither direction runs while the other's switch says otherwise, so the two
 * never redirect in a loop. For a few minutes after a switch is saved, other
 * Worker isolates still have the old switches (FEATURES_TTL_MS); the Features
 * save clears every cached page, and again once every isolate has the new
 * switches (the settling purge), so a stale answer doesn't stay at the edge.
 */
import { siteTrailingPolicy } from "../core/content-url.js";
import { isOn, registerFeatures, siteFeatures } from "../core/features.js";
import type { FeatureDef, PackMiddleware, PackModule } from "../core/module.js";
import { REDIRECTS_TAG, keepAtEdge } from "../pageCache/lib.js";
import { type PagePath, type PagePathOptions, archiveRedirect, legacyPageRedirect, parsePagePath } from "./urls.js";

export const PAGINATION_FEATURE = "pagination";
export const SHORT_URLS_FEATURE = "pagination.shortUrls";

export const FEATURES: FeatureDef[] = [
	{
		id: PAGINATION_FEATURE,
		label: "Pagination",
		description:
			"Numbered page links for archives (first, nearby pages and last), on one line at every width, from the Pagination component in the theme's routes. Off, the component shows only Previous and Next.",
		default: false,
	},
	{
		id: SHORT_URLS_FEATURE,
		label: "Short page URLs",
		description:
			"Page 3 of an archive is /3/ (/news/3/) instead of /page/3/, and old /page/3/ links redirect to it. Delete any redirect rules for /page/ URLs first: they answer before this one.",
		default: false,
	},
];
registerFeatures(FEATURES);

export function paginationPack(): PackModule {
	return {
		id: "pagination",
		label: "Pagination",
		features: FEATURES,
		// No settings of its own: the theme passes everything to the component.
		adminPages: [],
	};
}

/** How long the edge cache keeps a `/page/N/` redirect: until a Features or redirect save clears it, or 30 days. */
export const PAGE_REDIRECT_EDGE_MAX_AGE = 30 * 86400;

const SKIP = /^\/_emdash(\/|$)/;

/**
 * While Short page URLs is on: a GET or HEAD for `/…/page/N/` gets a 301 to
 * `/…/N/` (`/page/1/` to the base), with its query string, in one hop
 * (legacyPageRedirect). Runs after the Redirect Manager's middleware, so a
 * stored rule for the same URL wins. Kept at the edge with the redirects' tag
 * (a redirect save clears it) and the settings generation (a Features save
 * does); browsers get `no-cache`, since a browser that kept a 301 could loop
 * once the switch is turned off again.
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
		const location = legacyPageRedirect(pathname, search, { slash: (await siteTrailingPolicy()) !== "never" });
		// Site-relative, and never anywhere else (legacyPageRedirect already collapses a leading "//").
		if (!location || new URL(location, context.url).origin !== context.url.origin) return undefined;
		keepAtEdge(context, PAGE_REDIRECT_EDGE_MAX_AGE, [REDIRECTS_TAG]);
		return new Response(null, { status: 301, headers: { Location: location, "Cache-Control": "no-cache" } });
	},
};

/** What archivePage answers. */
export interface ArchivePage extends PagePath {
	/** Send the request here (301) instead of rendering it: page 1 named in the URL, or the page form that isn't in use. */
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
 *   if (paged.redirect) return Astro.redirect(paged.redirect, 301);
 *   // paged.segments: the archive's base; paged.page: its page number; paged.short: the URL form.
 *
 * `/1/` and `/page/1/` redirect to the base; `/page/N/` to `/N/` while Short
 * page URLs is on (the middleware usually answers it first), and `/N/` to
 * `/page/N/` while it's off. A numeric last segment is read as a page number
 * (`form: "short"`): when that page of the archive is empty, the route can
 * look the whole path up as an entry instead (see docs/pagination.md).
 */
export async function archivePage(segments: readonly string[] | string | undefined, url: URL | `/${string}`, options: ArchivePageOptions = {}): Promise<ArchivePage> {
	// The redirect is built from the request's path: a query string alone (Astro.url.search) would send every page to "/".
	if (typeof url === "string" && !url.startsWith("/")) throw new TypeError("archivePage needs the request URL (Astro.url) or its path, not only its query string");
	const list = typeof segments === "string" || segments === undefined ? String(segments ?? "").split("/").filter(Boolean) : segments;
	const parsed = parsePagePath(list, options);
	const short = isOn(await siteFeatures(options.database ?? "DB"), SHORT_URLS_FEATURE);
	if (!parsed.form) return { ...parsed, short };
	const request = typeof url === "string" ? new URL(url, "http://site.invalid") : url;
	const redirect = archiveRedirect(request.pathname, request.search, parsed, { short, slash: (await siteTrailingPolicy()) !== "never" });
	return redirect ? { ...parsed, short, redirect } : { ...parsed, short };
}

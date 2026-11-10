/**
 * Tracking parameters (utm_source, fbclid, gclid…) and Workers Cache.
 *
 * Workers Cache keys a page by its path and query string, so
 * `/?utm_source=newsletter` is its own cache entry: a campaign or social
 * visitor gets a freshly built page (about 250 ms on coywolf.com, measured)
 * instead of the cached one (60–90 ms). Click IDs (fbclid, gclid) are unique
 * per click, so those visitors always do.
 *
 * Why not a zone URL Rewrite Rule (Transform Rule)? Cloudflare's Workers
 * Cache docs list "Rulesets that modify request or response before cache"
 * among the zone features that don't apply to Workers Caching, and say to
 * shape the cache key in the Worker (developers.cloudflare.com/workers/cache/
 * limitations/, cache-keys/, checked November 2026). So the pack can't offer
 * a zone rule as a setup button; the site wraps its Worker instead
 * (stripTrackingParams in src/worker.ts), which uses what's here.
 *
 * Only the server's view changes. Analytics that run in the browser (Fathom,
 * Google Analytics) read the address bar, which still has the parameters.
 *
 * Kept free of imports so tests can load it directly.
 */

/** Parameters removed by default: ad and email click IDs, and `ref` (Product Hunt, newsletters). */
export const TRACKING_PARAMS: readonly string[] = [
	"fbclid",
	"gclid",
	"gclsrc",
	"gbraid",
	"wbraid",
	"dclid",
	"msclkid",
	"twclid",
	"ttclid",
	"li_fat_id",
	"igshid",
	"yclid",
	"srsltid",
	"mc_cid",
	"mc_eid",
	"_hsenc",
	"_hsmi",
	"mkt_tok",
	"_ga",
	"_gl",
	"ref",
];

/** Parameters removed by prefix (every utm_… parameter). */
export const TRACKING_PREFIXES: readonly string[] = ["utm_"];

export interface TrackingOptions {
	/** Exact parameter names to remove (default TRACKING_PARAMS). Pass your own list to keep one, e.g. `TRACKING_PARAMS.filter((p) => p !== "ref")`. */
	params?: readonly string[];
	/** Name prefixes to remove (default TRACKING_PREFIXES). */
	prefixes?: readonly string[];
}

/** Paths that are never touched: EmDash's admin and API, and Astro's assets and image endpoint. */
const UNTOUCHED = /^\/(_emdash|_astro|_image)(\/|$)/;

/** A query parameter's name, decoded (a `+` is a space in a query); null when it can't be decoded. */
function paramName(pair: string): string | null {
	const raw = pair.split("=", 1)[0] ?? "";
	try {
		return decodeURIComponent(raw.replaceAll("+", " ")).toLowerCase();
	} catch {
		return null;
	}
}

/**
 * The query string without tracking parameters, the other parameters left
 * exactly as they were (order and encoding), and the removed pairs as sent.
 * `search` includes or omits its leading "?".
 */
export function stripTrackingQuery(search: string, options: TrackingOptions = {}): { search: string; removed: string[] } {
	const query = search.startsWith("?") ? search.slice(1) : search;
	if (!query) return { search: "", removed: [] };
	const names = new Set((options.params ?? TRACKING_PARAMS).map((p) => p.toLowerCase()));
	const prefixes = (options.prefixes ?? TRACKING_PREFIXES).map((p) => p.toLowerCase());
	const kept: string[] = [];
	const removed: string[] = [];
	for (const pair of query.split("&")) {
		if (!pair) continue;
		const name = paramName(pair);
		if (name !== null && (names.has(name) || prefixes.some((p) => p && name.startsWith(p)))) removed.push(pair);
		else kept.push(pair);
	}
	return { search: kept.length ? `?${kept.join("&")}` : "", removed };
}

/**
 * The URL a request is served from the cache with: `url` without its
 * tracking parameters, or null when there's nothing to remove (or the request
 * isn't a page read: only GET and HEAD, never EmDash's admin and API).
 */
export function trackingFreeUrl(url: URL, method: string, options: TrackingOptions = {}): { url: URL; removed: string[] } | null {
	if ((method !== "GET" && method !== "HEAD") || !url.search || UNTOUCHED.test(url.pathname)) return null;
	const { search, removed } = stripTrackingQuery(url.search, options);
	if (!removed.length) return null;
	const clean = new URL(url.href);
	clean.search = search;
	return { url: clean, removed };
}

/**
 * A redirect's Location with the removed parameters added back, so a visitor
 * sent on from a campaign link (a slash-less URL, a moved page) still lands
 * with them in the address bar, where analytics read them. Only for a
 * same-origin target: a redirect to another site never gets this site's
 * tracking parameters. Unchanged otherwise.
 */
export function withTrackingParams(location: string, requestUrl: URL, removed: string[]): string {
	if (!removed.length) return location;
	let target: URL;
	try {
		target = new URL(location, requestUrl);
	} catch {
		return location;
	}
	if (target.origin !== requestUrl.origin) return location;
	const query = target.search ? `${target.search}&${removed.join("&")}` : `?${removed.join("&")}`;
	const relative = !/^[a-z][a-z0-9+.-]*:/i.test(location) && !location.startsWith("//");
	return relative ? `${target.pathname}${query}${target.hash}` : `${target.origin}${target.pathname}${query}${target.hash}`;
}

/**
 * Cache-Control for the answer to a request whose tracking parameters were
 * removed: kept out of Workers Cache under the tracking URL (`private`), so
 * a later purge of the clean page can't leave a stale copy behind under a
 * key nobody clears. What browsers may do is otherwise unchanged.
 */
export function privateCacheControl(value: string | null): string {
	const directives = (value ?? "")
		.split(",")
		.map((d) => d.trim())
		.filter((d) => d && !/^(public|private|s-maxage=.*)$/i.test(d));
	return ["private", ...directives].join(", ");
}

/** Response header on answers whose tracking parameters were removed (to check the setup with curl). */
export const TRACKING_HEADER = "Coywolf-Tracking-Params";

const MARKER = Symbol.for("coywolf-pack.trackingParams");

/** Recorded by stripTrackingParams when the site's Worker is wrapped (read by the Cloudflare Checkup page). */
export function markTrackingWrapper(info: { params: number; prefixes: number }): void {
	(globalThis as Record<symbol, unknown>)[MARKER] = info;
}

/** Whether this Worker strips tracking parameters (its src/worker.ts uses stripTrackingParams). */
export function trackingWrapperInstalled(): { params: number; prefixes: number } | null {
	const value = (globalThis as Record<symbol, unknown>)[MARKER];
	return value && typeof value === "object" ? (value as { params: number; prefixes: number }) : null;
}

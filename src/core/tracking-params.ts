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
	/** Exact parameter names to remove (default TRACKING_PARAMS). */
	params?: readonly string[];
	/** Name prefixes to remove (default TRACKING_PREFIXES). */
	prefixes?: readonly string[];
	/**
	 * Parameters to leave alone even though they're in the list, for a site whose server code reads one,
	 * e.g. `keep: ["ref"]` (`ref` is removed by default: referral links such as Product Hunt's add it).
	 */
	keep?: readonly string[];
	/**
	 * Other hostnames a redirect may send a visitor to with the parameters added back (besides the request's
	 * own host and its `www.` twin), such as a second domain the Worker redirects to.
	 */
	hosts?: readonly string[];
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
	const keep = new Set((options.keep ?? []).map((p) => p.toLowerCase()));
	const kept: string[] = [];
	const removed: string[] = [];
	for (const pair of query.split("&")) {
		if (!pair) continue;
		const name = paramName(pair);
		if (name !== null && !keep.has(name) && (names.has(name) || prefixes.some((p) => p && name.startsWith(p)))) removed.push(pair);
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

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * Whether a redirect from `from` to `to` stays on the site: the same origin,
 * the same host with or without `www.` (a Worker that answers both and sends
 * one to the other), or one of the site's `hosts`. Over http(s) only.
 */
function sameSite(from: URL, to: URL, hosts: readonly string[]): boolean {
	if (to.origin === from.origin) return true;
	if (to.protocol !== "https:" && to.protocol !== "http:") return false;
	if (to.port !== from.port) return false;
	return bareHost(to.hostname) === bareHost(from.hostname) || hosts.some((h) => h.toLowerCase() === to.hostname.toLowerCase());
}

/**
 * A redirect's Location with the removed parameters added back, so a visitor
 * sent on from a campaign link (a slash-less URL, a moved page, www to the
 * bare domain) still lands with them in the address bar, where analytics read
 * them. Only for a target on the site (see sameSite): a redirect to another
 * site never gets this site's tracking parameters. Unchanged otherwise.
 *
 * A relative Location stays relative, except when its path starts with `//`
 * or `/\` once resolved ("/.//evil.com/" → "//evil.com/"): a browser would
 * read that as another host, so it's given as an absolute URL instead.
 */
export function withTrackingParams(location: string, requestUrl: URL, removed: string[], hosts: readonly string[] = []): string {
	if (!removed.length) return location;
	let target: URL;
	try {
		target = new URL(location, requestUrl);
	} catch {
		return location;
	}
	if (!sameSite(requestUrl, target, hosts)) return location;
	const query = target.search ? `${target.search}&${removed.join("&")}` : `?${removed.join("&")}`;
	const relative =
		target.origin === requestUrl.origin && !/^[a-z][a-z0-9+.-]*:/i.test(location) && !/^[/\\]{2}/.test(location) && !/^\/[/\\]/.test(target.pathname);
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

/**
 * What the wrapper last saw, in plugin KV (the options row TRACKING_STATE_OPTION), for the
 * Cloudflare Checkup: whether the Worker could call itself, and the cache status of that call
 * (a HIT shows the clean page came from the same cache a plain visit uses). Written at most a
 * couple of times per isolate (src/worker.ts).
 */
export const TRACKING_STATE_KEY = "state:cloudflare:tracking";
export const TRACKING_STATE_OPTION = `plugin:coywolf-pack:${TRACKING_STATE_KEY}`;

export interface TrackingState {
	at: string;
	/** False: no ctx.exports.default and no SELF binding, so requests are served as they come. */
	loopback: boolean;
	/** The loopback's HTTP status. */
	status?: number;
	/** The loopback's cf-cache-status (HIT, MISS…), or null when it had none. */
	cache?: string | null;
}

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

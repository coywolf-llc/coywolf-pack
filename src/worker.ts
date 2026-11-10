/**
 * Helpers for the site's Worker entry (src/worker.ts), from
 * "@coywolf/emdash/worker". Kept small and free of EmDash imports: the
 * Worker entry loads it before anything else.
 *
 * stripTrackingParams: pages linked with utm_…, fbclid, gclid and similar
 * parameters are served from Workers Cache as if the parameters weren't
 * there, instead of being built again for every campaign or click ID.
 *
 * ```ts
 * // src/worker.ts
 * import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
 * import { stripTrackingParams } from "@coywolf/emdash/worker";
 *
 * export { PluginBridge };
 * export default stripTrackingParams({ ...handler, scheduled: createScheduledHandler() } satisfies ExportedHandler);
 * ```
 *
 * How it works: Workers Cache runs in front of the Worker and keys a page by
 * its path and query string, so a request with tracking parameters misses
 * the cache and reaches the Worker. There, and only there, the wrapper asks
 * its own Worker again for the same URL without them, through the cache
 * (ctx.exports.default, or the SELF service binding): that's usually a cache
 * hit, so nothing is rendered and no database is read. Requests without
 * tracking parameters (nearly all of them) never run the wrapper at all:
 * they're answered from the cache as before, so the wrapper costs nothing
 * for them.
 *
 * - The page is the clean URL's page (the same cache entry a plain visit
 *   uses), and its answer isn't stored again under the tracking URL
 *   (`Cache-Control: private`), so purges keep working as they do now.
 * - A same-origin redirect (a slash-less URL, a moved page) gets the removed
 *   parameters added back to its Location, so the visitor still lands with
 *   them in the address bar.
 * - Fathom, Google Analytics and other analytics that run in the browser read
 *   the address bar, which still has the parameters: nothing changes for them.
 *   Only server code would stop seeing them.
 * - Each such request is billed twice (the request, and the call through the
 *   cache), with almost no CPU time.
 *
 * Cloudflare's docs say zone rules that change the request before the cache
 * (URL Rewrite Rules) don't apply to Workers Cache, which is why this is code
 * in the Worker and not a setting (src/core/tracking-params.ts).
 */
import {
	TRACKING_HEADER,
	TRACKING_PARAMS,
	TRACKING_PREFIXES,
	type TrackingOptions,
	markTrackingWrapper,
	privateCacheControl,
	trackingFreeUrl,
	withTrackingParams,
} from "./core/tracking-params.js";

export { TRACKING_PARAMS, TRACKING_PREFIXES };
export type { TrackingOptions };

interface Fetcher {
	fetch(request: Request): Promise<Response>;
}

export interface StripTrackingOptions extends TrackingOptions {
	/**
	 * How the Worker calls itself through its own cache. Default: ctx.exports.default (a compatibility date of
	 * 2025-11-17 or later, or the enable_ctx_exports flag), else the SELF service binding. Without either, requests
	 * are served as they come.
	 */
	loopback?: (env: unknown, ctx: unknown) => Fetcher | undefined;
}

const isFetcher = (value: unknown): value is Fetcher => typeof (value as Fetcher | undefined)?.fetch === "function";

function defaultLoopback(env: unknown, ctx: unknown): Fetcher | undefined {
	const own = (ctx as { exports?: Record<string, unknown> } | undefined)?.exports?.default;
	if (isFetcher(own)) return own;
	const self = (env as Record<string, unknown> | undefined)?.SELF;
	return isFetcher(self) ? self : undefined;
}

/** The loopback's answer, made fit to return for the request with tracking parameters. */
function forVisitor(response: Response, requestUrl: URL, removed: string[]): Response {
	const out = new Response(response.body, response);
	const location = out.headers.get("Location");
	if (location && out.status >= 300 && out.status < 400) out.headers.set("Location", withTrackingParams(location, requestUrl, removed));
	// Not stored under the tracking URL: the clean URL's entry is the one EmDash and the pack purge.
	out.headers.set("Cache-Control", privateCacheControl(out.headers.get("Cache-Control")));
	out.headers.delete("CDN-Cache-Control");
	out.headers.delete("Cloudflare-CDN-Cache-Control");
	out.headers.delete("Cache-Tag");
	out.headers.set(TRACKING_HEADER, "removed");
	return out;
}

type FetchHandler = (request: Request, env: never, ctx: never) => Response | Promise<Response>;

/**
 * The site's Worker handler, with requests that carry tracking parameters
 * served from the cache entry of the same URL without them. Everything else
 * (other methods, EmDash's admin and API, URLs without tracking parameters)
 * goes to the handler unchanged.
 */
export function stripTrackingParams<H extends object>(handler: H & { fetch?: unknown }, options: StripTrackingOptions = {}): H {
	const inner = handler.fetch as FetchHandler | undefined;
	if (typeof inner !== "function") throw new TypeError("stripTrackingParams: the Worker handler has no fetch()");
	const loopback = options.loopback ?? defaultLoopback;
	markTrackingWrapper({ params: (options.params ?? TRACKING_PARAMS).length, prefixes: (options.prefixes ?? TRACKING_PREFIXES).length });
	return {
		...handler,
		async fetch(request: Request, env: never, ctx: never): Promise<Response> {
			const url = new URL(request.url);
			const clean = trackingFreeUrl(url, request.method, options);
			const self = clean ? loopback(env, ctx) : undefined;
			if (!clean || !self) return inner.call(handler, request, env, ctx);
			let response: Response;
			try {
				response = await self.fetch(new Request(clean.url.href, request));
			} catch (error) {
				console.error("coywolf-pack: calling the Worker without its tracking parameters failed; serving the request as it came", error);
				return inner.call(handler, request, env, ctx);
			}
			return forVisitor(response, url, clean.removed);
		},
	} as H;
}

/**
 * Helpers for the site's Worker entry (src/worker.ts), from
 * "@coywolf/emdash/worker". Kept small and free of EmDash imports: the
 * Worker entry loads it before anything else.
 *
 * stripTrackingParams: pages linked with utm_…, fbclid, gclid and similar
 * parameters are served from Workers Cache as if the parameters weren't
 * there, instead of being built again for every campaign or click ID. Wrap
 * the site's whole default export, its own fetch wrapper included (every
 * Coywolf site has emdashUncachedByDefault, which keeps the admin's login
 * redirect out of the cache: keep it):
 *
 * ```ts
 * // src/worker.ts (coywolf.com)
 * import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
 * import { stripTrackingParams } from "@coywolf/emdash/worker";
 *
 * export { PluginBridge };
 *
 * function emdashUncachedByDefault(request: Request, response: Response): Response {
 * 	// …unchanged…
 * }
 *
 * export default stripTrackingParams({
 * 	...handler,
 * 	async fetch(request, env, ctx) {
 * 		return emdashUncachedByDefault(request, await handler.fetch!(request, env, ctx));
 * 	},
 * 	scheduled: createScheduledHandler(),
 * } satisfies ExportedHandler);
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
 * - A redirect that stays on the site (a slash-less URL, a moved page, www to
 *   the bare domain) gets the removed parameters added back to its Location,
 *   so the visitor still lands with them in the address bar.
 * - Fathom, Google Analytics and other analytics that run in the browser read
 *   the address bar, which still has the parameters: nothing changes for them.
 *   Only server code would stop seeing them.
 * - Each such request is billed twice (the request, and the call through the
 *   cache), with almost no CPU time.
 * - If the call through the cache fails or answers with a server error, the
 *   request is served as it came.
 * - What the call did (whether there's one, and its cache status) is recorded
 *   in plugin KV a couple of times per isolate at most, for the Cloudflare
 *   Checkup page.
 *
 * Cloudflare's docs say zone rules that change the request before the cache
 * (URL Rewrite Rules) don't apply to Workers Cache, which is why this is code
 * in the Worker and not a setting (src/core/tracking-params.ts).
 */
import {
	TRACKING_HEADER,
	TRACKING_PARAMS,
	TRACKING_PREFIXES,
	TRACKING_STATE_OPTION,
	type TrackingOptions,
	type TrackingState,
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
	/** D1 binding where what the wrapper saw is recorded for the Cloudflare Checkup (default "DB"). */
	database?: string;
}

const isFetcher = (value: unknown): value is Fetcher => typeof (value as Fetcher | undefined)?.fetch === "function";

function defaultLoopback(env: unknown, ctx: unknown): Fetcher | undefined {
	const own = (ctx as { exports?: Record<string, unknown> } | undefined)?.exports?.default;
	if (isFetcher(own)) return own;
	const self = (env as Record<string, unknown> | undefined)?.SELF;
	return isFetcher(self) ? self : undefined;
}

/** The loopback's answer, made fit to return for the request with tracking parameters. */
function forVisitor(response: Response, requestUrl: URL, removed: string[], hosts: readonly string[]): Response {
	const out = new Response(response.body, response);
	const location = out.headers.get("Location");
	if (location && out.status >= 300 && out.status < 400) out.headers.set("Location", withTrackingParams(location, requestUrl, removed, hosts));
	// Not stored under the tracking URL: the clean URL's entry is the one EmDash and the pack purge.
	out.headers.set("Cache-Control", privateCacheControl(out.headers.get("Cache-Control")));
	out.headers.delete("CDN-Cache-Control");
	out.headers.delete("Cloudflare-CDN-Cache-Control");
	out.headers.delete("Cache-Tag");
	out.headers.set(TRACKING_HEADER, "removed");
	return out;
}

interface D1Like {
	prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

/**
 * Records what the wrapper saw in plugin KV (TRACKING_STATE_OPTION), at most a
 * few times per isolate: the first tracked request, and once more when it
 * first sees a cache HIT or learns there's no loopback. Best effort, after the
 * response (waitUntil); a write that fails is tried again on a later request.
 */
function stateRecorder(database: string) {
	let written: "answered" | "hit" | "no-loopback" | null = null;
	return (env: unknown, ctx: unknown, state: Omit<TrackingState, "at">) => {
		const kind = !state.loopback ? "no-loopback" : String(state.cache).toUpperCase() === "HIT" ? "hit" : "answered";
		// Once a HIT is recorded, a later MISS (a page not cached yet) says nothing new.
		if (written === kind || (written === "hit" && kind === "answered")) return;
		const previous = written;
		written = kind;
		const db = (env as Record<string, unknown> | undefined)?.[database] as D1Like | undefined;
		if (typeof db?.prepare !== "function") return;
		const value = JSON.stringify({ at: new Date().toISOString(), ...state } satisfies TrackingState);
		const write = (async () => {
			try {
				await db
					.prepare("INSERT INTO options (name, value, revision) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, revision = excluded.revision")
					.bind(TRACKING_STATE_OPTION, value, crypto.randomUUID())
					.run();
			} catch {
				// Databases from before EmDash's revision column.
				await db.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").bind(TRACKING_STATE_OPTION, value).run();
			}
		})().catch(() => {
			if (written === kind) written = previous;
		});
		const waitUntil = (ctx as { waitUntil?: (p: Promise<unknown>) => void } | undefined)?.waitUntil;
		if (typeof waitUntil === "function") waitUntil.call(ctx, write);
	};
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
	const record = stateRecorder(options.database ?? "DB");
	markTrackingWrapper({ params: (options.params ?? TRACKING_PARAMS).length, prefixes: (options.prefixes ?? TRACKING_PREFIXES).length });
	return {
		...handler,
		async fetch(request: Request, env: never, ctx: never): Promise<Response> {
			const url = new URL(request.url);
			const clean = trackingFreeUrl(url, request.method, options);
			if (!clean) return inner.call(handler, request, env, ctx);
			const self = loopback(env, ctx);
			if (!self) {
				record(env, ctx, { loopback: false });
				return inner.call(handler, request, env, ctx);
			}
			let response: Response;
			try {
				response = await self.fetch(new Request(clean.url.href, request));
			} catch (error) {
				console.error("coywolf-pack: calling the Worker without its tracking parameters failed; serving the request as it came", error);
				return inner.call(handler, request, env, ctx);
			}
			if (response.status >= 500) {
				// A server error from the call through the cache: let the handler try the request itself.
				await response.body?.cancel().catch(() => undefined);
				return inner.call(handler, request, env, ctx);
			}
			record(env, ctx, { loopback: true, status: response.status, cache: response.headers.get("cf-cache-status") });
			return forVisitor(response, url, clean.removed, options.hosts ?? []);
		},
	} as H;
}

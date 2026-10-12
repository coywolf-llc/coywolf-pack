/**
 * Page cache: keeps Cloudflare's Workers Cache (the edge HTML cache in front of
 * the Worker, turned on by Astro's cacheCloudflare() provider) in step with the
 * site. EmDash already purges the pages it tagged when content, menus or site
 * settings change. This covers what EmDash can't know about: a new deploy (theme
 * or code changes) and Coywolf Pack settings, which change page output (schema,
 * blocks, reviews, videos…).
 *
 * Purging runs inside the Worker with cache.purge() from cloudflare:workers, so
 * it needs no API token. Outside Workers Cache it does nothing.
 */

/** Option row holding the Worker version whose pages are in the cache. */
export const VERSION_OPTION = "plugin:coywolf-pack:pageCache:version";

/**
 * Pack routes anyone can call (search, discovery files, video player actions).
 * Everything else under the pack's API is an admin action, so a successful POST
 * there purges the cache. The Stream webhook isn't listed: it changes video
 * details that pages show.
 */
const PUBLIC_ROUTE = /^\/_emdash\/api\/plugins\/coywolf-pack\/(search\/|discovery\/public\/|videos\/(like|play|caption|embed|sitemap)(\/|$))/;
const PACK_API = "/_emdash/api/plugins/coywolf-pack/";

/** True when a request is a pack admin write whose success should purge the cache. */
export function purgesAfter(method: string, pathname: string): boolean {
	return method === "POST" && pathname.startsWith(PACK_API) && !PUBLIC_ROUTE.test(pathname);
}

export type PurgeScope = { purgeEverything: true } | { pathPrefixes: string[] } | { tags: string[] };

/** Cache tag on every redirect the pack serves from the edge cache (src/redirects/middleware.ts). */
export const REDIRECTS_TAG = "coywolf-redirects";

/**
 * What a successful pack admin write has to clear. Most settings change page
 * output, so everything goes. These don't touch cached pages:
 * - redirect edits clear only the cached redirects (their tag), and so does
 *   rewinding the database (it may bring other rules back);
 * - other backup actions, redirect lookups, the link report, and the Performance
 *   page's own media rule and warming controls clear nothing;
 * - robots.txt rules change only /robots.txt.
 * null: nothing to clear.
 */
export function purgeScope(pathname: string): PurgeScope | null {
	const route = pathname.slice(PACK_API.length);
	if (/^redirects\/(?!(list|test|removed)$)|^backups\/(rewind|undo)$/.test(route)) return { tags: [REDIRECTS_TAG] };
	if (/^(redirects|backups|links)\//.test(route) || /^cache\/(media|warm|purge)(\/|$)/.test(route)) return null;
	// Stored image sizes: new uploads and crops are picked up after a short stopgap lifetime; a backfill run clears the cache itself once when it is done.
	if (/^images\/variants\/(settings|run|bulk|estimate)$/.test(route)) return null;
	// Videos admin reads (library, details, status, storage, settings, captions list) change nothing.
	if (/^videos\/(list|status|detail|options|storage|test|settings|captions\/list)$/.test(route)) return null;
	if (/^robots\//.test(route)) return { pathPrefixes: ["/robots.txt"] };
	return { purgeEverything: true };
}

/** Release an RPC result's stubs (Symbol.dispose, where the runtime has it). Anything else is left alone. */
export function disposeRpcResult(result: unknown): void {
	if (typeof Symbol.dispose !== "symbol" || !result || typeof result !== "object") return;
	try {
		(result as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
	} catch {
		// Already released.
	}
}

/** Purge cached pages (all of them unless a scope says otherwise). False when there's no Workers Cache or the purge was refused. */
export async function purgePageCache(scope: PurgeScope = { purgeEverything: true }): Promise<boolean> {
	try {
		const workers = (await import("cloudflare:workers")) as unknown as {
			cache?: { purge(options: PurgeScope): Promise<{ success?: boolean; errors?: Array<{ message: string }> } | undefined> };
		};
		if (!workers.cache?.purge) return false;
		const result = await workers.cache.purge(scope);
		try {
			// The purge API rate-limits (Free-tier limits for Workers Cache) and says so in the result.
			if (result && result.success === false) {
				console.error("coywolf-pack: page cache purge refused", result.errors);
				return false;
			}
			return true;
		} finally {
			// The result is an RPC result: dispose of it, or the runtime warns that it wasn't.
			disposeRpcResult(result);
		}
	} catch (error) {
		console.error("coywolf-pack: page cache purge failed", error);
		return false;
	}
}

/** The deployed Worker version (CF_VERSION_METADATA binding), if bound. */
export function versionId(env: Record<string, unknown>): string | undefined {
	const metadata = env.CF_VERSION_METADATA as { id?: unknown } | undefined;
	return typeof metadata?.id === "string" && metadata.id ? metadata.id : undefined;
}

/**
 * Purge once per deploy: the first isolate of a new version that sees a request
 * compares its version with the stored one, purges, and records it. Other
 * isolates of the same version find it recorded. Racing isolates may both purge,
 * which is harmless.
 */
export async function purgeIfNewVersion(db: D1Database, id: string, known?: string | null): Promise<boolean> {
	// `known`: the row as read with the feature switches (undefined when not read; then it's read here).
	const value = known !== undefined ? known : ((await db.prepare("SELECT value FROM options WHERE name = ?").bind(VERSION_OPTION).first<{ value: string }>())?.value ?? null);
	if (value && JSON.parse(value) === id) return false;
	if (!(await purgePageCache())) return false;
	await db
		.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
		.bind(VERSION_OPTION, JSON.stringify(id))
		.run();
	return true;
}

/** Astro's per-request cache controls (route caching), as far as the pack uses them. */
interface RouteCache {
	enabled?: boolean;
	options?: { maxAge?: number };
	set(options: { maxAge?: number; swr?: number } | false): void;
}

/**
 * Apply the Page cache lifetimes to a request whose route the site made
 * cacheable (a routeRules entry gave it a maxAge). Other routes are left alone,
 * so this never turns caching on for anything the site didn't.
 */
export function applyPageLifetime(cache: RouteCache | undefined, maxAgeDays: number, refreshDays: number): boolean {
	if (!cache?.enabled || cache.options?.maxAge === undefined) return false;
	cache.set({ maxAge: Math.round(maxAgeDays * 86400), swr: Math.round(refreshDays * 86400) });
	return true;
}

/** Lifetime of a page rendered with a stopgap (a Stream poster while its media-host copy is made). */
export const STOPGAP_LIFETIME = { maxAge: 300, swr: 60 } as const;

/** What settlePage asks about a response once it's rendered. */
export interface SettleChecks {
	/** A read the render relied on failed (src/core/read-failures.ts): the response isn't edge-cached at all. */
	failed(): boolean;
	/** The render used temporary media (src/images/pending.ts): the page is cached for minutes, not days. */
	stopgap?(): boolean;
	/** For the cache warmer's own visits: the header that tells it the page wasn't cached (see below). */
	markHeader?: string;
	/** Names the request in the log line when a page isn't cached after a failed read (e.g. "GET /about/"). */
	label?: string;
	/** What failed (for the same log line). */
	reason?(): string | undefined;
}

/**
 * The last word on a GET or HEAD response's edge caching, given once it's
 * rendered:
 * - `failed()`: the pack fell back to "off" or "absent" for something it
 *   couldn't read, so the response isn't the site's real page. Not cached.
 * - `stopgap()`: the page showed temporary media. Cached for minutes (STOPGAP_LIFETIME).
 *
 * Astro streams pages: components deeper in the page render after `next()`
 * returns, and they can read settings (a failure noticed only then), mark a
 * stopgap, or call cache.set(), which turns caching back on after a
 * set(false). The cache headers are applied once the middleware chain has
 * returned (Astro's handleCache). So a page about to be cached (HTML, a 200,
 * a lifetime from the route rules) is read in full first, then asked, then its
 * caching set, last. Any other response isn't read: one rendered after a
 * failed read is left out of the cache at once (headers aren't applied until
 * the chain returns, so nothing it renders later can undo that).
 *
 * `markHeader` is for the cache warmer's own visits: a stopgap page (or one
 * rendered after a failed read) isn't cached at all, and the response carries
 * `markHeader: 1` so the warmer visits it again later (see
 * src/pageCache/warm.ts). Not caching it keeps the header out of the cache
 * (visitors never see it) and makes sure the warmer's next visit renders the
 * page instead of getting this copy back.
 */
export async function settlePage(cache: RouteCache | undefined, response: Response, checks: SettleChecks): Promise<Response> {
	// No route caching (dev, or a site without a cache provider). Astro's real cache stays `enabled` after set(false).
	if (!cache?.enabled) return response;
	const maxAge = cache.options?.maxAge;
	if (maxAge === undefined || maxAge <= 0 || response.status !== 200 || !response.body || !(response.headers.get("content-type") ?? "").startsWith("text/html")) {
		if (checks.failed()) cache.set(false);
		return response;
	}
	const body = await response.arrayBuffer();
	const headers = new Headers(response.headers);
	if (checks.failed()) {
		console.error(`coywolf-pack: ${checks.label ?? "a page"} not edge-cached: a read failed while it rendered (last failure: ${checks.reason?.() ?? "unknown"})`);
		cache.set(false);
		if (checks.markHeader) headers.set(checks.markHeader, "1");
	} else if (checks.stopgap?.() && cache.options?.maxAge !== undefined) {
		// (A component may have turned caching off while rendering, which clears maxAge: that's left alone.)
		if (checks.markHeader) {
			cache.set(false);
			headers.set(checks.markHeader, "1");
		} else cache.set({ maxAge: Math.min(maxAge, STOPGAP_LIFETIME.maxAge), swr: STOPGAP_LIFETIME.swr });
	}
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Notice when the request clears cached pages by tag (EmDash does on content,
 * menu, taxonomy, widget and site settings writes, and skips it for saves that
 * don't change live content, such as draft autosaves): wraps this request's
 * cache.invalidate. Astro gives the middleware and the route the same cache
 * object. Returns a function telling whether it was called (and succeeded).
 */
export function watchInvalidation(cache: { invalidate?: (...args: unknown[]) => Promise<unknown> } | undefined): () => boolean {
	let invalidated = false;
	const original = cache?.invalidate;
	if (!cache || typeof original !== "function") return () => false;
	cache.invalidate = async (...args: unknown[]) => {
		const result = await original.apply(cache, args);
		invalidated = true;
		return result;
	};
	return () => invalidated;
}

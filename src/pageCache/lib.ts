/**
 * Page cache: keeps Cloudflare's Workers Cache (the edge HTML cache in front of
 * the Worker, turned on by Astro's cacheCloudflare() provider) in step with the
 * site. EmDash already purges the pages it tagged when content, menus or site
 * settings change. This covers what EmDash can't know about: Coywolf Pack
 * settings, which change page output (schema, blocks, reviews, videos…), and a
 * new deploy on sites that share the cache across Worker versions (by default
 * Workers Cache keeps each version's pages apart; see noteNewVersion).
 *
 * Purging runs inside the Worker with cache.purge() from cloudflare:workers, so
 * it needs no API token. Outside Workers Cache it does nothing.
 */

/** Option row holding the Worker version whose pages are in the cache. */
export const VERSION_OPTION = "plugin:coywolf-pack:pageCache:version";

/**
 * Pack routes anyone can call (search, discovery files, video player actions)
 * and the signed Stream webhook. Everything else under the pack's API is an
 * admin action, so a successful POST there purges the cache.
 *
 * The webhook isn't an admin save: Stream calls it whenever a video's state
 * changes (several calls within seconds while videos process), and counting
 * each call as one purged every cached page, recorded a new settings
 * generation (a settling purge 5 minutes later, every isolate's caches
 * dropped) and restarted warming: on November 9, 2026 ten calls in an hour
 * made twelve full re-warms. It clears only the pages that embed that video
 * itself (src/videos/module.ts), and changes no settings.
 */
const PUBLIC_ROUTE = /^\/_emdash\/api\/plugins\/coywolf-pack\/(search\/|discovery\/public\/|videos\/((like|play|caption|embed|sitemap)(\/|$)|webhook$))/;
const PACK_API = "/_emdash/api/plugins/coywolf-pack/";
/**
 * Admin writes that change no settings: no purge here and no new settings
 * generation (so no settling purge, no isolate dropping its caches, no
 * re-warm).
 * - updates/…: the update check.
 * - Upload progress. videos/upload and videos/upload-chunk start and feed a
 *   new Stream video, which is on no page until an entry embeds it (and that
 *   entry's save clears its own pages). The large-file steps
 *   files/upload-start, -part, -complete and -abort make a new file the
 *   file picker lists only once it's finished (files/options), so no page
 *   can show it before then. Each 5–6 MiB piece used to count as a settings
 *   save: a 500 MB video was about 100 full purges, most of them refused by
 *   the purge rate limit (along with purges that mattered).
 * - Changes to one video (videos/update, videos/delete, videos/captions/…):
 *   their routes clear only the pages that embed the video themselves, as the
 *   Stream webhook does (src/videos/module.ts clearVideoPages). Video details
 *   are read from D1 on every render, so no isolate holds an old copy and
 *   nothing needs a settling purge.
 */
const NO_SETTINGS_CHANGE =
	/^\/_emdash\/api\/plugins\/coywolf-pack\/(updates\/|videos\/(upload|upload-chunk|update|delete|captions\/(upload|generate|delete|refresh))$|files\/upload-(start|part|complete|abort)$)/;

/**
 * Routes declared read-only where they're defined (readOnlyRoute in
 * src/core/routes.ts: previews, pickers' lists, connection tests…), by name.
 * createPlugin() registers them before the pack's first request (src/core/ready.ts). A successful POST to
 * one clears nothing and records no settings change, like the updates routes.
 */
const readOnlyRoutes = new Set<string>();

export function registerReadOnlyRoutes(names: Iterable<string>): void {
	for (const name of names) readOnlyRoutes.add(name);
}

/** True when a POST to this pack route is a read (declared with readOnlyRoute), not an admin save. */
export function isReadOnlyRoutePath(pathname: string): boolean {
	return pathname.startsWith(PACK_API) && readOnlyRoutes.has(pathname.slice(PACK_API.length));
}

/** True when a request is a pack admin write whose success should purge the cache. */
export function purgesAfter(method: string, pathname: string): boolean {
	return method === "POST" && pathname.startsWith(PACK_API) && !PUBLIC_ROUTE.test(pathname) && !NO_SETTINGS_CHANGE.test(pathname) && !isReadOnlyRoutePath(pathname);
}

/** What one cache.purge() call clears: everything, or any mix of path prefixes and cache tags (Workers Cache takes both in one call). */
export type PurgeScope = { purgeEverything: true } | { pathPrefixes: string[] } | { tags: string[] } | { pathPrefixes: string[]; tags: string[] };

/** Cache tag on every redirect the pack serves from the edge cache (src/redirects/middleware.ts). */
export const REDIRECTS_TAG = "coywolf-redirects";
/** robots.txt in the edge cache (cleared with everything else after the pack's admin saves and settings changes). */
export const ROBOTS_TAG = "coywolf-robots";

interface EdgeRouteCache {
	enabled?: boolean;
	set(options: { maxAge?: number; swr?: number; tags?: string[] } | false): void;
}

/**
 * Keep a response the pack serves itself in the edge cache (Workers Cache) for
 * `maxAge` seconds, replacing any lifetime the site's route rules or Plugins →
 * Performance gave the request. For middleware marked `ownsCache`. Does
 * nothing without Astro route caching.
 */
export function keepAtEdge(context: unknown, maxAge: number, tags: string[] = []): void {
	const cache = (context as { cache?: EdgeRouteCache }).cache;
	if (!cache?.enabled) return;
	cache.set(false);
	cache.set({ maxAge, swr: 0, tags });
}

/** Keep a response out of the edge cache (for an `ownsCache` middleware's other answers). */
export function keepOffEdge(context: unknown): void {
	(context as { cache?: EdgeRouteCache }).cache?.set(false);
}

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
	if (/^(redirects|backups|links|updates)\//.test(route) || /^cache\/(media|warm|purge)(\/|$)/.test(route)) return null;
	// Stored image sizes: new uploads and crops are picked up after a short stopgap lifetime; a backfill run clears the cache itself once when it is done.
	if (/^images\/variants\/(settings|run|bulk|estimate)$/.test(route)) return null;
	// (Un)subscribing the Stream webhook changes no page (its secret is on no page). The videos admin reads
	// (status, library, details, storage, captions list…) are declared read-only where they're defined (readOnlyRoute)
	// and never get here; uploads and changes to one video aren't settings saves at all (NO_SETTINGS_CHANGE).
	if (/^videos\/(status|settings|webhook\/(subscribe|unsubscribe))$/.test(route)) return null;
	if (/^robots\//.test(route)) return { pathPrefixes: ["/robots.txt"] };
	return { purgeEverything: true };
}

/** Most sources one redirect save clears by path; more than this clears everything instead. */
const MAX_REDIRECT_PATHS = 30;

/** True for the redirect writes whose request body redirectPagesScope reads (read it before the route consumes it). */
export function isRedirectSave(pathname: string): boolean {
	return /^redirects\/(save|import)$/.test(pathname.slice(PACK_API.length));
}

/**
 * The pages a redirect save or import also has to clear: the cached page at
 * each new source. Cached pages are served before the Worker runs, so the
 * redirect would otherwise wait for them to expire (purgeScope only clears the
 * cached redirects). An exact source clears by path prefix, which covers its
 * trailing-slash form and query strings; a pattern can cover any page, so it
 * clears everything. null: nothing to clear (disabled rules, an unreadable body).
 */
export function redirectPagesScope(body: unknown): PurgeScope | null {
	if (!body || typeof body !== "object") return null;
	const input = body as { rules?: unknown };
	const rules = (Array.isArray(input.rules) ? input.rules : [body]) as Array<{ source?: unknown; isRegex?: unknown; enabled?: unknown }>;
	const paths = new Set<string>();
	for (const rule of rules) {
		if (!rule || typeof rule !== "object" || rule.enabled === false || typeof rule.source !== "string") continue;
		if (rule.isRegex === true) return { purgeEverything: true };
		const path = rule.source.trim().split("?")[0].replace(/\/+$/, "") || "/";
		if (!path.startsWith("/")) continue;
		if (path === "/") return { purgeEverything: true };
		paths.add(path);
	}
	if (!paths.size) return null;
	return paths.size > MAX_REDIRECT_PATHS ? { purgeEverything: true } : { pathPrefixes: [...paths] };
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
	return (await purgeOutcome(scope)) === "purged";
}

/**
 * Purge, telling a refused or failed purge (worth trying again later) from a
 * site without Workers Cache (nothing to purge, ever): "unavailable" outside
 * Workers or without the cache.
 */
export async function purgeOutcome(scope: PurgeScope = { purgeEverything: true }): Promise<"purged" | "refused" | "unavailable"> {
	let workers: { cache?: { purge(options: PurgeScope): Promise<{ success?: boolean; errors?: Array<{ message: string }> } | undefined> } };
	try {
		workers = (await import("cloudflare:workers")) as unknown as typeof workers;
	} catch {
		return "unavailable"; // Not on Workers.
	}
	if (!workers.cache?.purge) return "unavailable";
	try {
		const result = await workers.cache.purge(scope);
		try {
			// The purge API rate-limits (Free-tier limits for Workers Cache) and says so in the result.
			if (result && result.success === false) {
				console.error("coywolf-pack: page cache purge refused", result.errors);
				return "refused";
			}
			return "purged";
		} finally {
			// The result is an RPC result: dispose of it, or the runtime warns that it wasn't.
			disposeRpcResult(result);
		}
	} catch (error) {
		console.error("coywolf-pack: page cache purge failed", error);
		return "refused";
	}
}

/** The deployed Worker version (CF_VERSION_METADATA binding), if bound. */
export function versionId(env: Record<string, unknown>): string | undefined {
	const metadata = env.CF_VERSION_METADATA as { id?: unknown } | undefined;
	return typeof metadata?.id === "string" && metadata.id ? metadata.id : undefined;
}

/** Versions remembered in the VERSION_OPTION row, newest last (enough to recognize a rollback). */
export const VERSION_HISTORY = 10;
/** A rollback (or a gradual deployment switching between two live versions) clears the cache at most this often. */
export const ROLLBACK_PURGE_EVERY_MS = 10 * 60_000;

/** The VERSION_OPTION row: the version that last handled a request, the ones before it, and when a rollback last purged. */
export interface VersionRow {
	current: string | null;
	seen: string[];
	rollbackPurgedAt?: number;
}

/** A VERSION_OPTION row (a plain version id before 0.35.19; empty when missing or unreadable). */
export function parseVersionRow(raw: string | null | undefined): VersionRow {
	if (!raw) return { current: null, seen: [] };
	try {
		const value = JSON.parse(raw) as unknown;
		if (typeof value === "string") return { current: value, seen: [value] };
		const row = value as Partial<VersionRow> | null;
		if (row && typeof row.current === "string") {
			const seen = Array.isArray(row.seen) ? row.seen.filter((v): v is string => typeof v === "string").slice(-VERSION_HISTORY) : [row.current];
			return { current: row.current, seen, ...(typeof row.rollbackPurgedAt === "number" ? { rollbackPurgedAt: row.rollbackPurgedAt } : {}) };
		}
	} catch {
		// Unreadable: like no row.
	}
	return { current: null, seen: [] };
}

/**
 * Replace the row only if it still holds `before` (null: only if there's no
 * row). True when this call wrote it: the statement RETURNs the row it wrote,
 * so this doesn't depend on how D1 counts a no-op upsert's changes.
 */
async function swapOption(db: D1Database, name: string, before: string | null, after: string): Promise<boolean> {
	const statement =
		before === null
			? db.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO NOTHING RETURNING value").bind(name, after)
			: db.prepare("UPDATE options SET value = ? WHERE name = ? AND value = ? RETURNING value").bind(after, name, before);
	return (await statement.first<{ value: string }>()) !== null;
}

/**
 * Notice a deploy: the first isolate of a Worker version that sees a request
 * compares its version with the stored one and records it. The write is a
 * compare-and-set, so when isolates race only one of them wins (the caller
 * starts warming once, not once per isolate). True when the caller should
 * start cache warming.
 *
 * A new version purges nothing by default. Workers Cache keeps each version's
 * pages apart (the version is part of the cache key:
 * https://developers.cloudflare.com/workers/cache/cache-keys/), so a deploy
 * already starts from a cold cache, and a purge would only spend one of the
 * account's purge requests (Free-tier limits: 5 a minute, shared by every site
 * and by EmDash's own content purges) on pages nobody can reach anymore.
 * `purge`: clear every cached page first, for sites that share Workers Cache
 * across versions (`cache.cross_version_cache`, and the pack's
 * `pageCache: { crossVersionCache: true }` option).
 *
 * A version seen before (in the last VERSION_HISTORY) is a rollback: its own
 * cache partition may still hold the pages it served before, which don't
 * have the edits made while the newer version was live (Cloudflare doesn't
 * say whether purges reach other versions' partitions), so it clears every
 * page, as before 0.35.19. A gradual deployment sends requests to two live
 * versions, so each isolate of either sees "the other" version stored: those
 * flips clear the cache at most once every ROLLBACK_PURGE_EVERY_MS and start
 * warming only when they clear it.
 *
 * A refused purge (the account's purge rate limit) is handed to `settleLater`
 * (the pending settling purge, src/core/generation.ts) and the version is
 * recorded anyway: this isolate checks once (pageCacheMiddleware), so without
 * that nothing would try again until another isolate of this version came
 * along. The settling purge clears everything later and restarts warming.
 */
export async function noteNewVersion(
	db: D1Database,
	id: string,
	known: string | null | undefined,
	options: { purge: boolean; now?: number; settleLater?: (scope: PurgeScope) => Promise<void> },
): Promise<boolean> {
	// `known`: the row as read with the feature switches (undefined when not read; then it's read here).
	const raw = known !== undefined ? known : ((await db.prepare("SELECT value FROM options WHERE name = ?").bind(VERSION_OPTION).first<{ value: string }>())?.value ?? null);
	const stored = parseVersionRow(raw);
	if (stored.current === id) return false;
	const now = options.now ?? Date.now();
	const returning = stored.seen.includes(id);
	const purgeNow = returning ? stored.rollbackPurgedAt === undefined || now - stored.rollbackPurgedAt >= ROLLBACK_PURGE_EVERY_MS : options.purge;
	const outcome = purgeNow ? await purgeOutcome() : "unavailable";
	if (outcome === "refused") {
		if (!options.settleLater) return false; // Not recorded: the next isolate tries again.
		await options.settleLater({ purgeEverything: true });
	}
	const next: VersionRow = {
		current: id,
		seen: [...stored.seen.filter((v) => v !== id), id].slice(-VERSION_HISTORY),
		...(returning && purgeNow ? { rollbackPurgedAt: now } : stored.rollbackPurgedAt !== undefined ? { rollbackPurgedAt: stored.rollbackPurgedAt } : {}),
	};
	// Another isolate (of this version or the other one) recorded first: it handles warming.
	if (!(await swapOption(db, VERSION_OPTION, raw, JSON.stringify(next)))) return false;
	if (outcome === "refused") return false; // The settling purge restarts warming once it has cleared.
	return !returning || purgeNow;
}

/** Astro's per-request cache controls (route caching), as far as the pack uses them. */
interface RouteCache {
	enabled?: boolean;
	options?: { maxAge?: number; tags?: string[] };
	set(options: { maxAge?: number; swr?: number; tags?: string[] } | false): void;
}

/**
 * Tag a response that's going to the edge cache with the settings generation
 * it was rendered with (src/core/generation.ts currentGenerationTag), so a
 * settings save can later clear just the pages rendered with old settings.
 * Called by the pack middleware once the response is final. Never turns
 * caching on: a response without a lifetime, or turned off, is left alone
 * (Astro's set() would re-enable it).
 */
export function tagGeneration(cache: RouteCache | undefined, tag: string): void {
	const maxAge = cache?.enabled ? cache.options?.maxAge : undefined;
	if (maxAge === undefined || maxAge <= 0) return;
	cache!.set({ tags: [tag] });
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
	// A page going to the edge cache doesn't keep this render's Server-Timing: every later visitor would get it
	// (a cold start's timings, served for days). Only what's set by the time the pack's middleware returns; EmDash's
	// own middleware runs outside the pack's and adds its timings after (see docs/performance.md).
	if (cache.options?.maxAge !== undefined) headers.delete("Server-Timing");
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

/**
 * Serves Coywolf redirects (through the pack middleware in src/middleware.ts).
 * Each request reads its exact rule, if any, from D1: one row through the
 * (source, is_regex) index. Pattern rules (few) are kept in memory per
 * Worker isolate, compiled in source order, and read again after a redirect
 * edit (in this isolate at once; in others when they see the new settings
 * generation, see src/core/generation.ts), or after `cacheSeconds`. Reading
 * never writes: the table is created by the first admin write. Hits are
 * counted after the response is sent.
 *
 * With Astro's cacheCloudflare() provider, GET and HEAD redirects are kept in
 * the edge cache (Workers Cache) for 30 days, tagged REDIRECTS_TAG; any
 * redirect edit purges that tag (src/pageCache/lib.ts purgeScope). Repeats
 * served from the cache don't reach the Worker, so they aren't counted as hits.
 */
import type { MiddlewareHandler } from "astro";

import { isCurrent, settingsEpoch } from "../core/features.js";
import { noteReadFailure } from "../core/read-failures.js";
import { REDIRECTS_TAG } from "../pageCache/lib.js";
import { type CompiledRules, compile, findExactRule, loadPatternRules, match, recordHit } from "./rules.js";

export interface CoywolfRedirectsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** Longest time to keep pattern rules per isolate, in seconds. Default 600 (edits reload them sooner). */
	cacheSeconds?: number;
}

type Patterns = CompiledRules["patterns"];

let cache: { patterns: Patterns; at: number; epoch: number } | null = null;
/** A load in progress: concurrent requests of a cold isolate share it. */
let loading: Promise<Patterns> | null = null;

/** Drop the in-memory pattern rules so the next request reloads them (called after admin edits). */
export function invalidateRedirectCache(): void {
	cache = null;
	loading = null;
}

function patterns(db: D1Database, ttl: number): Promise<Patterns> {
	if (cache && isCurrent(cache, ttl)) return Promise.resolve(cache.patterns);
	if (!loading) {
		const epoch = settingsEpoch();
		const load = loadPatternRules(db)
			.then((list) => {
				const compiled = compile(list).patterns;
				if (loading === load && epoch === settingsEpoch()) cache = { patterns: compiled, at: Date.now(), epoch };
				return compiled;
			})
			.finally(() => {
				if (loading === load) loading = null;
			});
		loading = load;
	}
	return loading;
}

/** The rules that can match a request (its exact rule and the patterns), read once per request URL. */
const lookups = new WeakMap<URL, Promise<CompiledRules>>();

function rulesFor(url: URL, db: D1Database, ttl: number): Promise<CompiledRules> {
	let found = lookups.get(url);
	if (!found) {
		// Issued in the same tick, so both reads go to D1 in one batch.
		found = Promise.all([findExactRule(db, url.pathname), patterns(db, ttl)]).then(([exact, list]) => ({
			exact: new Map(exact ? [[exact.source, exact]] : []),
			patterns: list,
		}));
		lookups.set(url, found);
	}
	return found;
}

const SKIP = /^\/(_emdash|_astro|_image)\//;
const ttlOf = (options: CoywolfRedirectsOptions) => (options.cacheSeconds ?? 600) * 1000;

/**
 * Start this request's lookup without waiting: the pack middleware calls it
 * before reading the feature switches, so when those aren't cached all the
 * reads go to D1 in one batch. Errors surface (logged) in serveRedirect.
 */
export function prefetchRedirects(url: URL, env: Record<string, unknown>, options: CoywolfRedirectsOptions = {}): void {
	const db = env[options.database ?? "DB"] as D1Database | undefined;
	if (!db || SKIP.test(url.pathname)) return;
	rulesFor(url, db, ttlOf(options)).catch(() => undefined);
}

/**
 * Answer a request from the redirect rules, or return undefined to pass it on.
 * `edge`: the response will be kept in the edge cache (see serveCachedRedirect).
 */
export async function serveRedirect(
	url: URL,
	env: Record<string, unknown>,
	waitUntil: (p: Promise<unknown>) => void,
	options: CoywolfRedirectsOptions = {},
	edge = false,
): Promise<Response | undefined> {
	const { pathname, search } = url;
	if (SKIP.test(pathname)) return undefined;
	const db = env[options.database ?? "DB"] as D1Database | undefined;
	if (!db) return undefined;

	let compiled: CompiledRules;
	try {
		compiled = await rulesFor(url, db, ttlOf(options));
	} catch (error) {
		console.error("coywolf redirects: could not load rules", error);
		// The page this URL renders instead of its redirect mustn't be edge-cached.
		noteReadFailure("redirect rules");
		return undefined;
	}

	const found = match(compiled, pathname, search);
	if (!found) return undefined;

	waitUntil(recordHit(db, found.rule.id).catch(() => undefined));

	// Browsers may keep a redirect for an hour. Unless it goes in the edge cache
	// (whose lifetime Astro sets in Cloudflare-CDN-Cache-Control), "private" keeps
	// Workers Cache from storing it untagged, where an edit couldn't clear it.
	const caching = { "Cache-Control": edge ? "max-age=3600" : "private, max-age=3600" };
	if (found.rule.type === 410) return new Response("Gone", { status: 410, headers: caching });
	let location = found.location;
	if (location.startsWith("/")) {
		// match() already collapses leading slashes from capture groups; this is a
		// second check that a site-relative destination never resolves off-site.
		const resolved = new URL(location, url);
		if (resolved.origin !== url.origin) return undefined;
		// The edge cache is shared by every hostname the Worker answers (it's keyed by
		// path and query), so a cached redirect stays on whichever host was asked.
		location = edge ? resolved.pathname + resolved.search + resolved.hash : resolved.href;
	}
	return new Response(null, { status: found.rule.type, headers: { Location: location, ...caching } });
}

/** Astro's per-request cache controls (route caching), as far as redirects use them. */
interface RouteCache {
	enabled?: boolean;
	set(options: { maxAge?: number; tags?: string[] } | false): void;
}

/** How long the edge cache keeps a redirect: until an edit purges it, or 30 days. */
export const REDIRECT_EDGE_MAX_AGE = 30 * 86400;

/**
 * The pack middleware's redirect handler: serveRedirect, and for GET and HEAD
 * with Astro route caching on, the edge lifetime and tag (replacing any the
 * site's route rules gave the request). Astro sends them as
 * Cloudflare-CDN-Cache-Control and Cache-Tag, which Cloudflare strips before
 * the response reaches the browser.
 */
export async function serveCachedRedirect(
	context: Parameters<MiddlewareHandler>[0],
	env: Record<string, unknown>,
	waitUntil: (p: Promise<unknown>) => void,
): Promise<Response | undefined> {
	const cache = (context as unknown as { cache?: RouteCache }).cache;
	const method = context.request.method;
	const edge = Boolean(cache?.enabled) && (method === "GET" || method === "HEAD");
	const response = await serveRedirect(context.url, env, waitUntil, {}, edge);
	if (response && edge) {
		cache!.set(false);
		cache!.set({ maxAge: REDIRECT_EDGE_MAX_AGE, tags: [REDIRECTS_TAG] });
	}
	return response;
}

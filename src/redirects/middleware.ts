/**
 * Serves Coywolf redirects (through the pack middleware in src/middleware.ts).
 * Each Worker isolate keeps the rules' index in memory: the pattern rules
 * (few), compiled in source order, and the set of exact sources (up to
 * MAX_EXACT_IN_MEMORY). A request whose path is no exact source (almost every
 * request) reads nothing from D1 for its redirect; one whose path is reads its
 * rule (one row through the (source, is_regex) index), so an exact rule that
 * was changed or deleted in another isolate is never served from memory. On
 * a site with more exact rules than that, every request reads its own, as
 * before. The index is read again after a redirect change: in this isolate at
 * once, in others when they see the new settings generation (pack admin
 * saves, src/core/generation.ts) or the new redirects version (changes made
 * by content hooks, such as slug changes, noteRedirectsChanged), both read
 * with the feature switches, or after `cacheSeconds`. Reading never writes:
 * the table is created by the first admin write. Hits are counted after the
 * response is sent, batched per isolate (one D1 write a second at most).
 *
 * With Astro's cacheCloudflare() provider, GET and HEAD redirects are kept in
 * the edge cache (Workers Cache) for 30 days, tagged REDIRECTS_TAG; any
 * redirect edit purges that tag (src/pageCache/lib.ts purgeScope). Repeats
 * served from the cache don't reach the Worker, so they aren't counted as hits.
 */
import type { MiddlewareHandler } from "astro";

import { isCurrent, registerSiteOption, rememberSiteOption, settingsEpoch, siteOption } from "../core/features.js";
import { noteReadFailure } from "../core/read-failures.js";
import { sharedRead, sharedSlot } from "../core/single-flight.js";
import { createBatchedCounter } from "../files/counts.js";
import { REDIRECTS_TAG } from "../pageCache/lib.js";
import { afterResponse } from "../shared.js";
import { type CompiledRules, compile, findExactRule, hitStatement, loadExactSources, loadPatternRules, match, normalizePath } from "./rules.js";

export interface CoywolfRedirectsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** Longest time to keep pattern rules per isolate, in seconds. Default 600 (edits reload them sooner). */
	cacheSeconds?: number;
}

type Patterns = CompiledRules["patterns"];

/** Most exact sources kept in memory per isolate; a site with more looks each request's up in D1. */
export const MAX_EXACT_IN_MEMORY = 5000;

/**
 * Option row that changes whenever redirects change outside the pack's admin saves (which record a settings
 * generation): slug changes and removed-content rules made by content hooks. Read with the feature switches,
 * so every isolate notices within FEATURES_TTL_MS without a query of its own.
 */
export const REDIRECTS_VERSION_OPTION = "plugin:coywolf-pack:redirects:version";
registerSiteOption(REDIRECTS_VERSION_OPTION);

interface RuleIndex {
	patterns: Patterns;
	/** The enabled exact rules' sources; null when there are more than MAX_EXACT_IN_MEMORY (look each one up). */
	exact: Set<string> | null;
}

let cache: { index: RuleIndex; at: number; epoch: number; version: string | null | undefined } | null = null;
/**
 * A load in progress: concurrent requests of a cold isolate share it, for a
 * bounded time, and it's anchored with waitUntil (src/core/single-flight.ts).
 * prefetchRedirects starts it from requests that may answer before the
 * redirect handler runs (robots.txt, /media/, downloads) and never wait for it.
 */
const loading = sharedSlot<RuleIndex>();
/** Bumped by invalidateRedirectCache, so a load that started before an edit isn't cached. */
let edits = 0;

/** Drop the in-memory rules so the next request reloads them (called after admin edits). */
export function invalidateRedirectCache(): void {
	cache = null;
	loading.flight = null;
	edits++;
}

/**
 * After changing redirects outside a pack admin save (content hooks): drop this isolate's rules and give the
 * redirects a new version, so other isolates reload theirs on their next read of the switches. Pack admin
 * saves don't need it (their settings generation does the same), but it does no harm.
 */
export async function noteRedirectsChanged(db: D1Database): Promise<void> {
	invalidateRedirectCache();
	const version = JSON.stringify(crypto.randomUUID());
	try {
		await db
			.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
			.bind(REDIRECTS_VERSION_OPTION, version)
			.run();
		rememberSiteOption(REDIRECTS_VERSION_OPTION, version);
	} catch (error) {
		// The change itself is saved; other isolates then see it when their index expires (cacheSeconds).
		console.error("coywolf-pack: could not record the redirects version", error);
	}
}

/** The index this isolate holds, if it's still current (no edit, no new generation or redirects version, not expired). */
function currentIndex(ttl: number): RuleIndex | null {
	if (!cache || !isCurrent(cache, ttl)) return null;
	// Undefined: the switches' read has expired; the epoch and the lifetime still apply.
	const version = siteOption(REDIRECTS_VERSION_OPTION);
	if (version !== undefined && version !== cache.version) return null;
	return cache.index;
}

function ruleIndex(db: D1Database, ttl: number): Promise<RuleIndex> {
	const held = currentIndex(ttl);
	if (held) return Promise.resolve(held);
	return sharedRead(
		loading,
		() => {
			const epoch = settingsEpoch();
			const seen = edits;
			const version = siteOption(REDIRECTS_VERSION_OPTION);
			// Both in the same tick: one D1 batch (with the switches, on a cold isolate).
			return Promise.all([loadPatternRules(db), loadExactSources(db, MAX_EXACT_IN_MEMORY)]).then(([list, sources]) => {
				const index: RuleIndex = { patterns: compile(list).patterns, exact: sources.length > MAX_EXACT_IN_MEMORY ? null : new Set(sources) };
				if (seen === edits && epoch === settingsEpoch()) cache = { index, at: Date.now(), epoch, version };
				return index;
			});
		},
		{ anchor: afterResponse, label: "the redirect rules" },
	);
}

/** The rules that can match a request (its exact rule and the patterns), read once per request URL. */
const lookups = new WeakMap<URL, Promise<CompiledRules>>();
/** Request URLs whose exact rule wasn't read, because this isolate's index has no such source (see serveLateRedirect). */
const skippedExact = new WeakSet<URL>();

const exactMap = (exact: Awaited<ReturnType<typeof findExactRule>>): CompiledRules["exact"] => new Map(exact ? [[exact.source, exact]] : []);

function rulesFor(url: URL, db: D1Database, ttl: number): Promise<CompiledRules> {
	let found = lookups.get(url);
	if (!found) {
		const held = currentIndex(ttl);
		if (held) {
			// Most requests: no exact rule for this path, so no D1 read at all.
			const known = held.exact === null || held.exact.has(normalizePath(url.pathname));
			if (!known) skippedExact.add(url);
			const lookup = known ? findExactRule(db, url.pathname) : Promise.resolve(null);
			found = lookup.then((exact) => ({ exact: exactMap(exact), patterns: held.patterns }));
		} else {
			// A cold isolate (or after an edit): the request's own lookup goes in the same D1 batch as the index.
			found = Promise.all([findExactRule(db, url.pathname), ruleIndex(db, ttl)]).then(([exact, index]) => ({ exact: exactMap(exact), patterns: index.patterns }));
		}
		lookups.set(url, found);
	}
	return found;
}

/** Hits, batched per isolate: a flood of uncached requests (a query string skips the edge cache) can't write once each. */
const hits = createBatchedCounter((db, id, n, now) => hitStatement(db, id, n, now), { label: "redirect hits" });

/** For tests: write counted hits after `ms` (default a second). */
export function setRedirectHitDelay(ms: number): void {
	hits.setDelay(ms);
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
	countHit = true,
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

	return redirectFor(url, db, compiled, waitUntil, edge, countHit);
}

/**
 * A browser fetching the page ahead of a click (Speculation Rules, link prefetch): `Sec-Purpose: prefetch`
 * (or `prefetch;prerender`), or the older `Purpose: prefetch`. Not a visit, so it isn't a redirect hit.
 */
export function isSpeculative(request: Request): boolean {
	return /\bprefetch\b/i.test(request.headers.get("Sec-Purpose") ?? "") || /\bprefetch\b/i.test(request.headers.get("Purpose") ?? "");
}

/**
 * The answer to a prefetch of a redirect source: declined (503, never stored), as Cloudflare's Speed Brain
 * declines prefetches it won't serve. A browser drops a prefetch that doesn't end in a 2xx, so the click
 * itself then reaches the site and counts as the hit, once. Serving the redirect to the prefetch instead
 * would count a hover that may never become a click, and a click on it would then reuse the prefetched
 * redirect without reaching the site at all.
 */
const declinedPrefetch = () => new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });

/** The response for the rule that matches `url`, if any (its hit counted; a prefetch, `countHit` false, is declined). */
function redirectFor(url: URL, db: D1Database, compiled: CompiledRules, waitUntil: (p: Promise<unknown>) => void, edge: boolean, countHit = true): Response | undefined {
	const found = match(compiled, url.pathname, url.search);
	if (!found) return undefined;
	if (!countHit) return declinedPrefetch();

	hits.count(db as unknown as Parameters<typeof hits.count>[0], found.rule.id, waitUntil);

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
	const speculative = isSpeculative(context.request);
	const response = await serveRedirect(context.url, env, waitUntil, {}, edge && !speculative, !speculative);
	if (response && speculative) cache?.set(false);
	else if (response && edge) keepRedirectAtEdge(cache!);
	return response;
}

function keepRedirectAtEdge(cache: RouteCache): void {
	cache.set(false);
	cache.set({ maxAge: REDIRECT_EDGE_MAX_AGE, tags: [REDIRECTS_TAG] });
}

/**
 * For a request that rendered a 404 after its exact-rule lookup was skipped
 * (this isolate's index had no such source): read the rule after all. A rule
 * another isolate just added (a slug change, a new redirect) then works at
 * once instead of within FEATURES_TTL_MS, at no cost for pages that render.
 * A rule found this way also drops this isolate's index, which is out of date.
 */
export async function serveLateRedirect(
	context: Parameters<MiddlewareHandler>[0],
	env: Record<string, unknown>,
	waitUntil: (p: Promise<unknown>) => void,
): Promise<Response | undefined> {
	if (!skippedExact.has(context.url)) return undefined;
	const db = env.DB as D1Database | undefined;
	if (!db) return undefined;
	const rule = await findExactRule(db, context.url.pathname).catch(() => null);
	if (!rule) return undefined;
	invalidateRedirectCache();
	const cache = (context as unknown as { cache?: RouteCache }).cache;
	const method = context.request.method;
	const edge = Boolean(cache?.enabled) && (method === "GET" || method === "HEAD");
	const speculative = isSpeculative(context.request);
	const response = redirectFor(context.url, db, { exact: exactMap(rule), patterns: [] }, waitUntil, edge && !speculative, !speculative);
	if (response && speculative) cache?.set(false);
	else if (response && edge) keepRedirectAtEdge(cache!);
	return response;
}

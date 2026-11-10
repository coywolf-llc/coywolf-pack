/**
 * Live results and the title index, served by the pack middleware (feature
 * "search.live") ahead of EmDash's plugin route dispatch.
 *
 * With Workers Cache in front of the Worker (Astro route caching on), each
 * answer goes to the edge cache, where repeats are served without running the
 * Worker: tagged SEARCH_TAG and with every searchable collection's slug, which
 * EmDash clears whenever content in that collection changes. Live answers are
 * kept for LIVE_EDGE_TTL (they're per query, so many are asked once); a title
 * index for the current content version for a day. Only successful answers are
 * kept: bad input (400), the rate limit's 429 and failures never are.
 *
 * Without Workers Cache, every answer is stored in caches.default (per
 * Cloudflare location) and in a small per-isolate memory cache instead, keyed
 * by the normalized query, limit, collections, locale and the search content
 * version. Publishing changes the version, so new keys miss and old answers
 * simply expire. (With Workers Cache those layers are skipped: an isolate that
 * hasn't seen a new version yet would put its old copy back at the edge right
 * after EmDash cleared it.) Cache hits skip the rate limit and the database
 * entirely; misses count against search.rateLimit when it's on.
 *
 * The plugin routes (search/live, search/index) stay as the fallback for
 * sites without the middleware; they run the same engine.
 */
import { contentUrlFingerprint } from "../core/content-url.js";
import { isOn, registerSiteSetting, rememberSiteSetting, siteFeatures, siteSetting } from "../core/features.js";
import type { PackMiddleware } from "../core/module.js";
import { liveAnswerCount, noteSearch } from "../insights/search.js";
import { keepAtEdge, keepOffEdge } from "../pageCache/lib.js";
import { type QueryStats, countingD1, liveSearchD1, loadSearchMeta } from "./engine.js";
import { Lru, effectiveVersion, fingerprint, indexCacheKey, liveCacheKey, newContentVersion, normalizeCollections, normalizeLiveQuery, normalizeLocale } from "./live-cache.js";
import { LIVE_ASSET, LIVE_ASSET_HASH, type LiveClientConfig, liveScript, liveScriptConfig } from "./live-client.js";
import { rateLimitResponse } from "./ratelimit.js";
import { TITLE_INDEX_MAX, buildTitleIndex } from "./title-index.js";

export const LIVE_ENDPOINT = "/_emdash/api/plugins/coywolf-pack/search/live";
export const INDEX_ENDPOINT = "/_emdash/api/plugins/coywolf-pack/search/index";

/** Plugin setting holding the search content version. */
export const VERSION_SETTING = "searchVersion";
registerSiteSetting(VERSION_SETTING);

/** Seconds a live answer is kept at the edge (a publish in a searchable collection clears it sooner). */
export const LIVE_EDGE_TTL = 300;
/** Cache tag on every live answer and title index in the edge cache (with the searchable collections' slugs). */
export const SEARCH_TAG = "coywolf-search";
/** Most collection tags on one answer. */
const MAX_COLLECTION_TAGS = 50;
/** Seconds browsers keep a live answer. */
export const LIVE_BROWSER_TTL = 60;
/** Seconds a title index is kept at the edge. */
const INDEX_EDGE_TTL = 86_400;

interface LiveServeConfig {
	database: string;
	limit: number;
	indexMax: number;
}

let config: LiveServeConfig = { database: "DB", limit: 8, indexMax: TITLE_INDEX_MAX };

/** Set from coywolfPlugin({ search }) when the Worker starts (same pattern as the rate limit options). */
export function configureSearchLive(options: Partial<LiveServeConfig>): void {
	config = { ...config, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
}

export function liveServeConfig(): LiveServeConfig {
	return config;
}

/** The current search content version (from the per-isolate settings cache; no query on most requests). */
export async function searchVersion(database = config.database): Promise<string> {
	return effectiveVersion(await siteSetting<string>(VERSION_SETTING, database), contentUrlFingerprint());
}

/** Give published content a new version (content hooks, search settings changes). */
export async function bumpSearchVersion(ctx: { settings: { set(key: string, value: unknown): Promise<void> } }): Promise<string> {
	const version = newContentVersion();
	await ctx.settings.set(VERSION_SETTING, version);
	rememberSiteSetting(VERSION_SETTING, version);
	return version;
}

let liveMemory = new Lru<string>(500);
let indexMemory = new Lru<string>(4);

/** Empty this isolate's memory caches (tests; the edge cache is untouched). */
export function resetLiveMemory(): void {
	liveMemory = new Lru<string>(500);
	indexMemory = new Lru<string>(4);
}

const JSON_TYPE = "application/json; charset=utf-8";

function edgeCache(): Cache | undefined {
	return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
}

function timing(state: string, started: number, stats?: QueryStats): string {
	const parts = [`cw-search;desc="${state}";dur=${Date.now() - started}`];
	if (stats) parts.push(`cw-d1;desc="${stats.statements} statements, ${stats.roundTrips} round trips"`);
	return parts.join(", ");
}

/** A fresh response with mutable headers (cached responses' headers are immutable, and later middleware may set some). */
function jsonResponse(body: string | null, status: number, headers: Record<string, string>): Response {
	return new Response(body, { status, headers: new Headers({ "Content-Type": JSON_TYPE, "X-Content-Type-Options": "nosniff", ...headers }) });
}

function badRequest(message: string): Response {
	return jsonResponse(JSON.stringify({ success: false, error: { code: "VALIDATION_ERROR", message } }), 400, { "Cache-Control": "no-store" });
}

/** Text of a cached answer: this isolate's memory, then the edge cache. */
async function cachedBody(memory: Lru<string>, key: string): Promise<{ body: string; where: string } | null> {
	const inMemory = memory.get(key);
	if (inMemory !== undefined) return { body: inMemory, where: "hit-memory" };
	const cache = edgeCache();
	const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
	if (!hit) return null;
	const body = await hit.text();
	memory.set(key, body);
	return { body, where: "hit-edge" };
}

function store(memory: Lru<string>, key: string, body: string, edgeTtl: number, waitUntil: (p: Promise<unknown>) => void): void {
	memory.set(key, body);
	const cache = edgeCache();
	if (cache) waitUntil(cache.put(key, new Response(body, { headers: { "Content-Type": JSON_TYPE, "Cache-Control": `public, max-age=${edgeTtl}` } })).catch(() => undefined));
}

type Context = Parameters<PackMiddleware["handle"]>[0];

/** True when Astro route caching (Workers Cache) is on for this request: answers go to the edge cache. */
function edgeCaching(context: Context): boolean {
	return Boolean((context as unknown as { cache?: { enabled?: boolean } }).cache?.enabled);
}

/** Edge cache tags for an answer: SEARCH_TAG and the searchable collections (EmDash clears a collection's tag when its content changes). */
async function searchTags(db: D1Database, version: string): Promise<string[]> {
	const meta = await loadSearchMeta(db, config.database, version).catch(() => null);
	const slugs = meta ? [...meta.collections.values()].filter((c) => c.searchEnabled).map((c) => c.slug) : [];
	return [SEARCH_TAG, ...slugs.slice(0, MAX_COLLECTION_TAGS)];
}

async function rateLimited(context: Context, env: Record<string, unknown>): Promise<Response | undefined> {
	return isOn(await siteFeatures(config.database), "search.rateLimit") ? rateLimitResponse(context, env) : undefined;
}

async function serveLive(context: Context, env: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void, db: D1Database): Promise<Response> {
	const started = Date.now();
	const params = context.url.searchParams;
	const version = await searchVersion();

	// Warm-up (first focus of a search field): wake this isolate and load the search metadata, nothing else.
	if (params.get("warm") === "1") {
		const stats: QueryStats = { statements: 0, roundTrips: 0 };
		await loadSearchMeta(countingD1(db, stats), config.database, version).catch(() => undefined);
		return new Response(null, { status: 204, headers: new Headers({ "Cache-Control": "no-store", "Server-Timing": timing("warm", started, stats) }) });
	}

	const query = normalizeLiveQuery(params.get("q") ?? "");
	if (!query) return badRequest("Enter a search.");
	if (query.length > 200) return badRequest("That search is too long.");
	const rawLimit = params.get("limit");
	const limit = rawLimit === null || rawLimit === "" ? config.limit : Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 20) return badRequest("Limit must be a whole number from 1 to 20.");
	const rawCollections = params.get("collections");
	if (rawCollections && rawCollections.length > 500) return badRequest("Too many collections.");
	const collections = normalizeCollections(rawCollections);
	const locale = normalizeLocale(params.get("locale"));

	const key = liveCacheKey(context.url.origin, { version, query, limit, collections, locale });
	const browser = { "Cache-Control": `public, max-age=${LIVE_BROWSER_TTL}` };
	const edge = edgeCaching(context);
	const hit = edge ? null : await cachedBody(liveMemory, key);
	if (hit) {
		// Search insights (when on) count the searches the site answers, from this isolate's or the location's cache too.
		noteSearch(db, query, () => liveAnswerCount(hit.body), "live", waitUntil);
		return jsonResponse(hit.body, 200, { ...browser, "Server-Timing": timing(hit.where, started), "X-Coywolf-Cache": "HIT" });
	}

	const limited = await rateLimited(context, env);
	if (limited) return limited;

	const stats: QueryStats = { statements: 0, roundTrips: 0 };
	const data = await liveSearchD1(countingD1(db, stats), query, { collections, locale, limit, database: config.database, version });
	noteSearch(db, query, data.items.length, "live", waitUntil);
	const body = JSON.stringify({ success: true, data });
	if (edge) {
		keepAtEdge(context, LIVE_EDGE_TTL, await searchTags(db, version));
		// No Server-Timing or cache state: the edge would hand this render's timings to every later visitor.
		return jsonResponse(body, 200, browser);
	}
	store(liveMemory, key, body, LIVE_EDGE_TTL, waitUntil);
	return jsonResponse(body, 200, { ...browser, "Server-Timing": timing("miss", started, stats), "X-Coywolf-Cache": "MISS" });
}

async function serveIndex(context: Context, env: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void, db: D1Database): Promise<Response> {
	const started = Date.now();
	const params = context.url.searchParams;
	const version = await searchVersion();
	const rawCollections = params.get("collections");
	if (rawCollections && rawCollections.length > 500) return badRequest("Too many collections.");
	const collections = normalizeCollections(rawCollections);
	const locale = normalizeLocale(params.get("locale"));
	const key = indexCacheKey(context.url.origin, { version, collections, locale });

	// Pages carry the version in the index URL: a matching one never changes, so browsers keep it.
	// A stale page (an old version) still gets the current index, just not for long.
	const headers = {
		"Cache-Control": params.get("v") === version ? "public, max-age=31536000, immutable" : "public, max-age=300",
		ETag: `"${fingerprint(key)}"`,
	};
	if (context.request.headers.get("If-None-Match") === headers.ETag) return new Response(null, { status: 304, headers: new Headers(headers) });

	const edge = edgeCaching(context);
	const hit = edge ? null : await cachedBody(indexMemory, key);
	if (hit) return jsonResponse(hit.body, 200, { ...headers, "Server-Timing": timing(hit.where, started), "X-Coywolf-Cache": "HIT" });

	const limited = await rateLimited(context, env);
	if (limited) return limited;

	const stats: QueryStats = { statements: 0, roundTrips: 0 };
	const counted = countingD1(db, stats);
	const meta = await loadSearchMeta(counted, config.database, version);
	const index = await buildTitleIndex(counted, meta, { collections, locale, version, max: config.indexMax });
	const body = JSON.stringify(index);
	if (edge) {
		// An index for the current version until content changes (its collections' tags) or a day; one asked for by an old page, briefly.
		keepAtEdge(context, params.get("v") === version ? INDEX_EDGE_TTL : 300, await searchTags(db, version));
		return jsonResponse(body, 200, headers);
	}
	store(indexMemory, key, body, INDEX_EDGE_TTL, waitUntil);
	return jsonResponse(body, 200, { ...headers, "Server-Timing": timing("miss", started, stats), "X-Coywolf-Cache": "MISS" });
}

/**
 * The live results client as a file. Only the pack middleware serves it: EmDash's
 * raw plugin routes can't answer with a JavaScript content type or set
 * Cache-Control, so sites without the middleware get the script inline instead
 * (liveScriptFragment).
 */
export const ASSET_ENDPOINT = "/_emdash/api/plugins/coywolf-pack/search/live-client";

/**
 * Per isolate: the pack middleware has run here. It runs before every page
 * render on a site that installed it, so by the time a page asks for its
 * fragments this is set when (and only when) the middleware will answer
 * ASSET_ENDPOINT. A site without it (or a dev setup with a second copy of the
 * pack) never sets it and keeps the inline script.
 */
let middlewareActive = false;

/** Called by the pack middleware on each request it handles (false: tests). */
export function notePackMiddleware(active = true): void {
	middlewareActive = active;
}

/** Whether pages can load the client file, i.e. the pack middleware serves it (see notePackMiddleware). */
export function packMiddlewareActive(): boolean {
	return middlewareActive;
}

/**
 * The page fragment for live results: the versioned client file when the pack
 * middleware serves it, else the same client inline (as before the file existed).
 */
export function liveScriptFragment(config: LiveClientConfig, external = middlewareActive) {
	return external
		? {
				kind: "external-script" as const,
				placement: "body:end" as const,
				key: "search-live",
				src: liveAssetUrl(),
				defer: true,
				attributes: { "data-cw-live": liveScriptConfig(config) },
			}
		: { kind: "inline-script" as const, placement: "body:end" as const, key: "search-live", code: liveScript(config) };
}

/** Where pages load the client from: versioned, so it can be cached for a year. */
export function liveAssetUrl(): string {
	return `${ASSET_ENDPOINT}?v=${LIVE_ASSET_HASH}`;
}

/**
 * Status, headers and body for the client file. Immutable for a year when the
 * request names the current version; a few minutes otherwise (an old page's
 * URL still gets today's client, but nothing pins it).
 */
export function liveAssetParts(version: string | null): { status: number; headers: Record<string, string>; body: string } {
	return {
		status: 200,
		headers: {
			"Content-Type": "text/javascript; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": version === LIVE_ASSET_HASH ? "public, max-age=31536000, immutable" : "public, max-age=300",
		},
		body: LIVE_ASSET,
	};
}

export const searchLiveMiddleware: PackMiddleware = {
	module: "search",
	feature: "search.live",
	// The client file goes to the edge cache (a year when the URL names this version), and so do successful live
	// answers and title indexes (see the file comment); anything else is kept out.
	ownsCache: true,
	handle: async (context, env, waitUntil) => {
		const path = context.url.pathname.length > 1 ? context.url.pathname.replace(/\/+$/, "") : context.url.pathname;
		if (path === ASSET_ENDPOINT && (context.request.method === "GET" || context.request.method === "HEAD")) {
			const version = context.url.searchParams.get("v");
			const asset = liveAssetParts(version);
			keepAtEdge(context, version === LIVE_ASSET_HASH ? 31536000 : 300);
			return new Response(context.request.method === "HEAD" ? null : asset.body, { status: asset.status, headers: asset.headers });
		}
		if (path !== LIVE_ENDPOINT && path !== INDEX_ENDPOINT) return undefined;
		keepOffEdge(context);
		if (context.request.method !== "GET") return undefined;
		const db = env[config.database] as D1Database | undefined;
		if (!db) return undefined;
		return path === LIVE_ENDPOINT ? serveLive(context, env, waitUntil, db) : serveIndex(context, env, waitUntil, db);
	},
};

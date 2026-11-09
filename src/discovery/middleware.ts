/**
 * Site URLs for the Discovery module, served through the pack middleware:
 *
 * - `/news-sitemap.xml`                Google News sitemap (also `/coywolf-news-sitemap.xml`, Coywolf SEO's name)
 * - `/feed/`, `<term archive>/feed/`  RSS feeds
 * - `/llms.txt`                        llms.txt
 * - `<entry-url>/index.html.md`        Markdown source of an entry
 *
 * The work happens in the module's public plugin routes (so it runs in the
 * plugin context, with EmDash's URL resolution and the plugin's KV cache);
 * this file dispatches to them through EmDash's public route handler and
 * keeps results briefly in isolate memory.
 *
 * There is deliberately no `Accept: text/markdown` negotiation on entry
 * URLs: Cloudflare's cache key ignores Accept, so a single such request
 * could put Markdown into the cached HTML page.
 */
import type { MiddlewareHandler } from "astro";

import { PLUGIN_ID } from "../core/features.js";
import { noteReadFailure, routeFailed } from "../core/read-failures.js";
import type { PackMiddleware } from "../core/module.js";
import { FEED_EDGE_MAX_AGE, parseFeedPath } from "./feed.js";
import { pagePathFromMarkdownPath } from "./markdown.js";
import { MemoryCache } from "./memory-cache.js";
import { FEATURE } from "./module.js";

type Context = Parameters<MiddlewareHandler>[0];

interface PublicRouteResult {
	success: boolean;
	data?: unknown;
	/** HTTP status of the route's answer (500 for an error the route didn't expect; unset when the plugin isn't enabled). */
	status?: number;
	error?: { code?: string };
}
type PublicRouteHandler = (pluginId: string, method: string, path: string, request: Request) => Promise<PublicRouteResult>;

/** About 2 MB of documents per isolate; bodies over 256 KB and all but 32 misses aren't kept. */
const memory = new MemoryCache({ ttlMs: 60_000, maxBytes: 2 * 1024 * 1024, maxEntryBytes: 256 * 1024, maxMisses: 32 });

/** Call one of the module's public routes. Null when it isn't available or answers with an error (e.g. 404; a server error isn't kept). */
async function callRoute<T>(context: Context, route: string, query: Record<string, string> = {}, keep: "all" | "misses" = "all"): Promise<T | null> {
	const cacheKey = `${route}?${new URLSearchParams(query)}`;
	const hit = memory.get(cacheKey);
	if (hit !== undefined && (keep === "all" || hit === null)) return hit as T | null;

	const locals = context.locals as { emdash?: { handlePublicPluginApiRoute?: PublicRouteHandler } };
	const dispatch = locals.emdash?.handlePublicPluginApiRoute;
	if (typeof dispatch !== "function") return null;
	const url = new URL(`/_emdash/api/plugins/${PLUGIN_ID}/${route}`, context.url);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	const result = await dispatch(PLUGIN_ID, "GET", route, new Request(url, { method: "GET" }));
	const value = result.success ? ((result.data ?? null) as T | null) : null;
	// A server error (a read that failed) isn't kept as the answer: the next request asks again.
	if (routeFailed(result)) {
		noteReadFailure("discovery route");
		return null;
	}

	if (keep === "all" || value === null) memory.set(cacheKey, value);
	return value;
}

const isRead = (context: Context) => context.request.method === "GET" || context.request.method === "HEAD";

function respond(context: Context, body: string, headers: Record<string, string>): Response {
	return new Response(context.request.method === "HEAD" ? null : body, { status: 200, headers });
}

// ── News sitemap ─────────────────────────────────────────────────

const NEWS_PATHS = new Set(["/news-sitemap.xml", "/coywolf-news-sitemap.xml"]);

export const newsSitemapMiddleware: PackMiddleware = {
	module: "discovery",
	feature: FEATURE.news,
	handle: async (context) => {
		if (!isRead(context) || !NEWS_PATHS.has(context.url.pathname)) return undefined;
		const result = await callRoute<{ body: string }>(context, "discovery/public/news");
		if (!result?.body) return undefined;
		return respond(context, result.body, {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=300",
			// A sitemap never sends a robots noindex header (test/sitemap-headers.test.mjs).
		});
	},
};

// ── RSS feeds ────────────────────────────────────────────────────

interface RouteCache {
	enabled?: boolean;
	set(options: { maxAge?: number; swr?: number; tags?: string[] } | false): void;
}

export const feedMiddleware: PackMiddleware = {
	module: "discovery",
	feature: FEATURE.feed,
	// Feeds are kept in the edge cache (Workers Cache), tagged so a publish, edit or term change clears them.
	ownsCache: true,
	handle: async (context) => {
		if (!isRead(context) || !parseFeedPath(context.url.pathname)) return undefined;
		// No feed at this path (not a term, or the feed's off): the site answers, as it would without the pack.
		// Only misses are kept in memory: a feed goes to the edge cache, and a copy from memory could put the feed
		// from before a publish back there for an hour, right after EmDash cleared it.
		const doc = await callRoute<{ body: string; tags?: string[] }>(context, "discovery/public/feed", { path: context.url.pathname }, "misses");
		if (!doc?.body) return undefined;
		const cache = (context as unknown as { cache?: RouteCache }).cache;
		if (cache?.enabled) {
			// Replace any lifetime the site's route rules or Plugins → Performance gave the request; swr 0 so a reader
			// polling once an hour isn't handed the copy its last poll left.
			cache.set(false);
			cache.set({ maxAge: FEED_EDGE_MAX_AGE, swr: 0, tags: doc.tags ?? [] });
		}
		return respond(context, doc.body, {
			"Content-Type": "application/rss+xml; charset=utf-8",
			"Cache-Control": "public, max-age=900",
			"X-Content-Type-Options": "nosniff",
		});
	},
};

// ── llms.txt and Markdown sources ────────────────────────────────

interface MarkdownDoc {
	body: string;
	tokens: number;
	markdownUrl: string;
}

export const llmsMiddleware: PackMiddleware = {
	module: "discovery",
	feature: FEATURE.llms,
	handle: async (context) => {
		if (!isRead(context)) return undefined;
		const { pathname } = context.url;

		if (pathname === "/llms.txt") {
			const result = await callRoute<{ body: string }>(context, "discovery/public/llms");
			if (!result?.body) return undefined;
			return respond(context, result.body, {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
				"X-Content-Type-Options": "nosniff",
			});
		}

		const pagePath = pagePathFromMarkdownPath(pathname);
		if (pagePath) {
			const doc = await callRoute<MarkdownDoc>(context, "discovery/public/markdown", { path: pagePath });
			if (!doc?.body) return undefined;
			return respond(context, doc.body, {
				"Content-Type": "text/markdown; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
				"X-Markdown-Tokens": String(doc.tokens),
				"X-Content-Type-Options": "nosniff",
			});
		}

		return undefined;
	},
};

export const discoveryMiddleware: PackMiddleware[] = [newsSitemapMiddleware, feedMiddleware, llmsMiddleware];

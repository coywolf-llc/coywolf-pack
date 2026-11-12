/**
 * Discovery module: routes and hooks for the news sitemap, the RSS feed,
 * llms.txt and per-entry Markdown, security.txt, and the Crawler Hints card (Cloudflare's
 * own IndexNow integration, read from the site's zone). Site URLs are
 * answered by the middleware in ./middleware.ts, which calls the public
 * routes here.
 */
import { type PluginContext, PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { siteName } from "../core/site.js";
import { cachedCtxFeatures, ctxFeatures, invalidateFeatures, isOn, readSiteSetting, registerSiteSetting, requireFeature } from "../core/features.js";
import type { TaskDef } from "../core/module.js";
import { parseInput, workerEnv } from "../shared.js";
import { LLMS_CACHE, LLMS_TAG, NEWS_CACHE, NEWS_TAG, type CachedDocument, type DocKind, buildMarkdown, readDoc, rebuildNow, scheduleRebuild } from "./build.js";
import { type CrawlerHintsZone, crawlerHintsDashboardUrl, readCrawlerHints } from "./crawler-hints.js";
import { buildFeed } from "./feed-build.js";
import { FEED_PATH, FEED_TAG } from "./feed.js";
import { purgePageCache } from "../pageCache/lib.js";
import { UNREADABLE_TOKEN_MESSAGE, tokenName } from "../core/cloudflare-token.js";
import { readCloudflareToken } from "../pageCache/usage.js";
import { markdownUrl } from "./markdown.js";
import { SECURITY_TXT_PATH, SECURITY_TXT_TAG, securityTxtProblems } from "./security-txt.js";
import { SETTINGS_KEY, type DiscoverySettings, loadSettings, selected, settingsSchema } from "./settings.js";
import { siteOrigin } from "./urls.js";

export const FEATURE = {
	main: "discovery",
	news: "discovery.newsSitemap",
	llms: "discovery.llms",
	feed: "discovery.feed",
	securityTxt: "discovery.securityTxt",
} as const;

export interface DiscoveryOptions {
	/** D1 binding of the site database (term feeds read EmDash's taxonomy tables). Default "DB". */
	database?: string;
}

// ── Crawler Hints ────────────────────────────────────────────────

/** The site's zone, found once with the token and kept: { host, zone }. */
const ZONE_KEY = "state:discovery:crawlerHintsZone";

/** Whether Crawler Hints is on for the site's zone, read with the Cloudflare API token (Zone → Read). */
async function crawlerHintsStatus(ctx: PluginContext) {
	const host = new URL(siteOrigin(ctx)).host;
	const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
	const read = await readCloudflareToken(ctx, env);
	const { token, unreadable } = read;
	if (!token && unreadable) {
		return {
			enabled: null,
			host,
			zone: null,
			dashboardUrl: crawlerHintsDashboardUrl(null),
			problem: {
				kind: "bad-token" as const,
				message: UNREADABLE_TOKEN_MESSAGE,
			},
			checkedAt: new Date().toISOString(),
		};
	}
	const stored = await ctx.kv.get<{ host: string; zone: CrawlerHintsZone }>(ZONE_KEY).catch(() => null);
	const known = stored?.host === host ? stored.zone : null;
	const doFetch = (ctx.http ? ctx.http.fetch.bind(ctx.http) : fetch) as (url: string, init?: RequestInit) => Promise<Response>;
	let status = await readCrawlerHints(host, { token, tokenName: tokenName(read), fetch: doFetch, knownZone: known });
	// The remembered zone stopped working (the zone was deleted and added again, or moved to another account):
	// forget it and look the zone up again, once.
	if (known && status.enabled === null && status.problem?.kind !== "bad-token") {
		await ctx.kv.delete(ZONE_KEY).catch(() => undefined);
		status = await readCrawlerHints(host, { token, tokenName: tokenName(read), fetch: doFetch, knownZone: null });
	}
	// Keep the zone only when its setting could be read with it (a zone the token can't use is looked up again).
	if (status.zone && status.enabled !== null && !(known && known.id === status.zone.id)) {
		await ctx.kv.set(ZONE_KEY, { host, zone: status.zone }).catch(() => undefined);
	}
	return status;
}

async function onContentChange(ctx: PluginContext) {
	const features = await ctxFeatures(ctx);
	const llms = isOn(features, FEATURE.llms);
	const news = isOn(features, FEATURE.news);
	const kinds: DocKind[] = [...(llms ? (["llms"] as const) : []), ...(news ? (["news"] as const) : [])];
	if (kinds.length) scheduleRebuild(ctx, kinds);
}

// ── Head link to the Markdown source ─────────────────────────────

// Read on every page render: it comes with the feature switches' query (no query of its own).
registerSiteSetting(SETTINGS_KEY);
/** The last stored value and its parsed settings, so a cache hit doesn't parse again. */
let settingsMemo: { raw: unknown; settings: DiscoverySettings } | null = null;
async function memoSettings(ctx: PluginContext): Promise<DiscoverySettings> {
	const read = await readSiteSetting(SETTINGS_KEY).catch(() => null);
	if (!read) return loadSettings(ctx); // D1 unreadable here: through the plugin context.
	if (settingsMemo && settingsMemo.raw === read.value) return settingsMemo.settings;
	const parsed = settingsSchema.safeParse(read.value ?? {});
	settingsMemo = { raw: read.value, settings: parsed.success ? parsed.data : settingsSchema.parse({}) };
	return settingsMemo.settings;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Module ───────────────────────────────────────────────────────

export function discoveryModule(options: DiscoveryOptions) {
	const hooks = {
		// llms.txt and the news sitemap list published entries: rebuild them (in the background) when one changes.
		"content:afterPublish": async (_event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => onContentChange(ctx),
		"content:afterUnpublish": async (_event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => onContentChange(ctx),
		/** Edits that change the live page directly (collections without draft revisions). */
		"content:afterSave": async (event: { content: Record<string, unknown>; collection: string; isNew: boolean }, ctx: PluginContext) => {
			if (event.content.status !== "published" || event.content.draftRevisionId) return;
			await onContentChange(ctx);
		},
		"content:afterDelete": async (_event: { id: string; collection: string; permanent: boolean }, ctx: PluginContext) => onContentChange(ctx),
		/**
		 * Head links (page:metadata links can't carry a type): the RSS feed on every page, so feed
		 * readers and apps find it, and the entry's Markdown source on content pages.
		 */
		"page:fragments": async (event: { page: { kind: string; url: string; canonical: string | null; title: string | null; pageTitle?: string | null; content?: { collection: string }; seo?: { robots?: string | null } } }, ctx: PluginContext) => {
			const { page } = event;
			// The same cached read the hook composer made for this render (no query of its own).
			const features = await cachedCtxFeatures(ctx);
			const out: Array<{ kind: "html"; placement: "head"; key: string; html: string }> = [];
			if (isOn(features, FEATURE.feed)) {
				try {
					const href = new URL(FEED_PATH, page.url).href;
					const name = (await siteName(ctx)) || new URL(page.url).host;
					out.push({ kind: "html", placement: "head", key: "discovery-feed", html: `<link rel="alternate" type="application/rss+xml" href="${escapeAttr(href)}" title="${escapeAttr(`${name} RSS feed`)}">` });
				} catch {
					// No usable page URL: no link.
				}
			}
			if (isOn(features, FEATURE.llms) && page.kind === "content" && page.content && !/noindex/i.test(page.seo?.robots ?? "")) {
				const settings = await memoSettings(ctx);
				if (settings.llms.markdown && selected(settings.llms.collections, page.content.collection)) {
					try {
						const href = markdownUrl(new URL(page.canonical || page.url, page.url).href);
						const title = `${page.pageTitle || page.title || "This page"} — Markdown source`;
						out.push({ kind: "html", placement: "head", key: "discovery-markdown", html: `<link rel="alternate" type="text/markdown" href="${escapeAttr(href)}" title="${escapeAttr(title)}">` });
					} catch {
						// No usable page URL: no link.
					}
				}
			}
			return out;
		},
	};

	const routes = {
		// ── Public (called by the site middleware) ──
		"discovery/public/news": {
			public: true,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, FEATURE.news);
				const doc = await readDoc(ctx, "news");
				return { body: doc.body, tags: [NEWS_TAG, ...(doc.collections ?? [])] };
			},
		},
		"discovery/public/feed": {
			public: true,
			handler: async (ctx: PluginContext & { input: unknown }) => {
				await requireFeature(ctx, FEATURE.feed);
				const { path } = parseInput(z.object({ path: z.string().min(1).max(2000).startsWith("/") }), ctx.input);
				const doc = await buildFeed(ctx, await loadSettings(ctx), path, options.database);
				if (!doc) throw PluginRouteError.notFound("No feed at this path.");
				return doc;
			},
		},
		"discovery/public/llms": {
			public: true,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, FEATURE.llms);
				const doc = await readDoc(ctx, "llms");
				return { body: doc.body, tags: [LLMS_TAG, ...(doc.collections ?? [])] };
			},
		},
		"discovery/public/markdown": {
			public: true,
			handler: async (ctx: PluginContext & { input: unknown }) => {
				await requireFeature(ctx, FEATURE.llms);
				const { path } = parseInput(z.object({ path: z.string().min(1).max(2000).startsWith("/") }), ctx.input);
				const doc = await buildMarkdown(ctx, await loadSettings(ctx), path);
				if (!doc) throw PluginRouteError.notFound("No Markdown source for this path.");
				return doc;
			},
		},

		// ── Admin ──
		"discovery/status": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				const features = await ctxFeatures(ctx);
				const settings = await loadSettings(ctx);
				const collections = ((await ctx.schema?.listCollections()) ?? [])
					.filter((c) => c.routable)
					.map((c) => ({ slug: c.slug, label: c.label, hidden: c.hidden, hasSeo: c.hasSeo }));
				const origin = siteOrigin(ctx);
				const doc = async (k: string) => {
					const d = await ctx.kv.get<CachedDocument>(k);
					return d ? { count: d.count, builtAt: d.builtAt } : null;
				};
				return {
					features: { news: isOn(features, FEATURE.news), llms: isOn(features, FEATURE.llms), feed: isOn(features, FEATURE.feed), securityTxt: isOn(features, FEATURE.securityTxt) },
					settings,
					collections,
					origin,
					urls: {
						news: `${origin}/news-sitemap.xml`,
						llms: `${origin}/llms.txt`,
						feed: `${origin}${FEED_PATH}`,
						securityTxt: `${origin}${SECURITY_TXT_PATH}`,
					},
					cache: { llms: await doc(LLMS_CACHE), news: await doc(NEWS_CACHE) },
				};
			},
		},

		/**
		 * Whether Crawler Hints is on for the site's Cloudflare zone, and the link to its switch. Read with the
		 * Cloudflare API token (Zone → Zone → Read); Cloudflare doesn't let API tokens change it. A GET:
		 * it changes nothing, so it clears no cache. Loaded by the Discovery page after the rest of the page.
		 */
		"discovery/crawler-hints": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, FEATURE.main);
				return crawlerHintsStatus(ctx);
			},
		},

		"discovery/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const settings = parseInput(settingsSchema, ctx.input);
				// One contact per line in the admin: blank lines and spaces aren't kept.
				settings.securityTxt.contacts = settings.securityTxt.contacts.map((c) => c.trim()).filter(Boolean);
				const problems = securityTxtProblems(settings.securityTxt);
				if (problems.length) throw PluginRouteError.badRequest(`security.txt: ${problems.join(" ")}`);
				await ctx.settings.set(SETTINGS_KEY, settings);
				settingsMemo = null;
				// Read with the feature switches: drop that cache too.
				invalidateFeatures();
				// Rebuild in the background; the old copies keep serving until then.
				const features = await ctxFeatures(ctx);
				const kinds: DocKind[] = [...(isOn(features, FEATURE.llms) ? (["llms"] as const) : []), ...(isOn(features, FEATURE.news) ? (["news"] as const) : [])];
				if (kinds.length) scheduleRebuild(ctx, kinds, 0);
				// Feeds and security.txt in the edge cache were built with the old settings.
				await purgePageCache({ tags: [FEED_TAG, SECURITY_TXT_TAG] }).catch((error: unknown) => ctx.log.warn("Discovery: clearing cached feeds failed", { error: String(error) }));
				return { settings };
			},
		}),

		/** Build llms.txt and the news sitemap again now (replacing the stored copies). */
		"discovery/rebuild": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const features = await ctxFeatures(ctx);
				const out: { llms?: number; news?: number } = {};
				if (isOn(features, FEATURE.llms)) out.llms = (await rebuildNow(ctx, "llms")).count;
				if (isOn(features, FEATURE.news)) out.news = (await rebuildNow(ctx, "news")).count;
				return out;
			},
		}),
	};

	const tasks: TaskDef[] = [];

	return { routes, hooks, tasks };
}

/**
 * Discovery module: routes and hooks for IndexNow, the news sitemap,
 * llms.txt and per-entry Markdown. Site URLs are answered by the middleware
 * in ./middleware.ts, which calls the public routes here.
 */
import { type PluginContext, PluginRouteError, after, definePluginRoute } from "emdash";
import { z } from "zod";

import { absoluteUrl, entryUrl } from "../core/content-url.js";
import { siteName } from "../core/site.js";
import { cachedCtxFeatures, ctxFeatures, invalidateFeatures, isOn, readSiteSetting, registerSiteSetting, requireFeature } from "../core/features.js";
import { parseInput } from "../shared.js";
import { LLMS_CACHE, NEWS_CACHE, type CachedDocument, type DocKind, buildMarkdown, readDoc, rebuildNow, scheduleRebuild } from "./build.js";
import { INDEXNOW_ENDPOINTS, IndexNowBatcher, buildPayload, generateKey } from "./indexnow.js";
import { buildFeed } from "./feed-build.js";
import { FEED_PATH, FEED_TAG } from "./feed.js";
import { purgePageCache } from "../pageCache/lib.js";
import { markdownUrl } from "./markdown.js";
import {
	INDEXNOW_KEY_SETTING,
	SETTINGS_KEY,
	type DiscoverySettings,
	ensureIndexNowKey,
	loadSettings,
	readIndexNowKey,
	selected,
	settingsSchema,
} from "./settings.js";
import { siteOrigin } from "./urls.js";

export const FEATURE = {
	main: "discovery",
	indexnow: "discovery.indexnow",
	news: "discovery.newsSitemap",
	llms: "discovery.llms",
	feed: "discovery.feed",
} as const;

export interface DiscoveryOptions {
	/** D1 binding of the site database (term feeds read EmDash's taxonomy tables). Default "DB". */
	database?: string;
}

// ── IndexNow ─────────────────────────────────────────────────────

const LOG_KEY = "state:discovery:indexnowLog";
const LOG_LIMIT = 25;
const urlKey = (collection: string, id: string) => `state:discovery:url:${collection}:${id}`;

export interface PingLogEntry {
	at: string;
	endpoint: string;
	count: number;
	urls: string[];
	status: number;
	ok: boolean;
	error?: string;
	trigger: "content" | "manual";
}

/** Submissions wait this long for more changes, then go out as one request. */
const BATCH_WINDOW_MS = 3000;
const batcher = new IndexNowBatcher({ windowMs: BATCH_WINDOW_MS, defer: (task) => after(task) });

async function submit(ctx: PluginContext, urls: string[], trigger: PingLogEntry["trigger"]): Promise<PingLogEntry | null> {
	const key = await ensureIndexNowKey(ctx);
	const settings = await loadSettings(ctx);
	const payload = buildPayload(siteOrigin(ctx), key, urls);
	if (!payload) return null;
	const endpoint = INDEXNOW_ENDPOINTS[settings.indexnow.endpoint];
	const entry: PingLogEntry = {
		at: new Date().toISOString(),
		endpoint: settings.indexnow.endpoint,
		count: payload.urlList.length,
		urls: payload.urlList.slice(0, 10),
		status: 0,
		ok: false,
		trigger,
	};
	try {
		if (!ctx.http) throw new Error("network:request capability missing");
		const response = await ctx.http.fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(payload),
		});
		entry.status = response.status;
		entry.ok = response.ok;
		if (!response.ok) entry.error = (await response.text().catch(() => "")).slice(0, 300) || response.statusText;
	} catch (error) {
		entry.error = String(error).slice(0, 300);
	}
	if (entry.ok) ctx.log.info("IndexNow submitted", { count: entry.count, status: entry.status });
	else ctx.log.warn("IndexNow submission failed", { count: entry.count, status: entry.status, error: entry.error });
	const log = (await ctx.kv.get<PingLogEntry[]>(LOG_KEY)) ?? [];
	await ctx.kv.set(LOG_KEY, [entry, ...log].slice(0, LOG_LIMIT));
	return entry;
}

type ChangeKind = "publish" | "update" | "unpublish" | "delete";

async function queueIndexNow(ctx: PluginContext, settings: DiscoverySettings, collection: string, id: string, kind: ChangeKind, permanent = false) {
	if (!selected(settings.indexnow.collections, collection)) return;
	const known = await ctx.kv.get<string>(urlKey(collection, id));
	const urls: string[] = [];

	if (kind === "publish" || kind === "update") {
		const item = await ctx.content?.get(collection, id);
		const path = item && !item.seo?.noIndex ? await entryUrl(ctx, collection, item) : null;
		const url = path ? absoluteUrl(path, siteOrigin(ctx)) : null;
		if (url) urls.push(url);
		// A changed slug: tell engines about the old URL too.
		if (known && known !== url) urls.push(known);
		if (url && url !== known) await ctx.kv.set(urlKey(collection, id), url);
		if (!url && known) await ctx.kv.delete(urlKey(collection, id));
	} else {
		// Unpublished or deleted: the entry has no public URL any more, so use the URL remembered at publish.
		if (known) urls.push(known);
		if (known && (kind === "unpublish" || permanent)) await ctx.kv.delete(urlKey(collection, id));
	}
	if (urls.length) batcher.add(urls, (batch) => submit(ctx, batch, "content").then(() => undefined));
}

async function onContentChange(ctx: PluginContext, collection: string, id: string | undefined, kind: ChangeKind, permanent = false) {
	const features = await ctxFeatures(ctx);
	const llms = isOn(features, FEATURE.llms);
	const news = isOn(features, FEATURE.news);
	const kinds: DocKind[] = [...(llms ? (["llms"] as const) : []), ...(news ? (["news"] as const) : [])];
	if (kinds.length) scheduleRebuild(ctx, kinds);
	if (id && isOn(features, FEATURE.indexnow)) await queueIndexNow(ctx, await loadSettings(ctx), collection, id, kind, permanent);
}

const idOf = (content: Record<string, unknown>) => (typeof content.id === "string" ? content.id : undefined);

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
		"content:afterPublish": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) =>
			onContentChange(ctx, event.collection, idOf(event.content), "publish"),
		"content:afterUnpublish": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) =>
			onContentChange(ctx, event.collection, idOf(event.content), "unpublish"),
		/** Edits that change the live page directly (collections without draft revisions). */
		"content:afterSave": async (event: { content: Record<string, unknown>; collection: string; isNew: boolean }, ctx: PluginContext) => {
			if (event.content.status !== "published" || event.content.draftRevisionId) return;
			await onContentChange(ctx, event.collection, idOf(event.content), event.isNew ? "publish" : "update");
		},
		"content:afterDelete": async (event: { id: string; collection: string; permanent: boolean }, ctx: PluginContext) =>
			onContentChange(ctx, event.collection, event.id, "delete", event.permanent),
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
		"discovery/public/key": {
			public: true,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, FEATURE.indexnow);
				return { key: await readIndexNowKey(ctx) };
			},
		},
		"discovery/public/news": {
			public: true,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, FEATURE.news);
				return { body: (await readDoc(ctx, "news")).body };
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
				return { body: (await readDoc(ctx, "llms")).body };
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
				const key = isOn(features, FEATURE.indexnow) ? await ensureIndexNowKey(ctx) : await readIndexNowKey(ctx);
				const collections = ((await ctx.schema?.listCollections()) ?? [])
					.filter((c) => c.routable)
					.map((c) => ({ slug: c.slug, label: c.label, hidden: c.hidden, hasSeo: c.hasSeo }));
				const origin = siteOrigin(ctx);
				const doc = async (k: string) => {
					const d = await ctx.kv.get<CachedDocument>(k);
					return d ? { count: d.count, builtAt: d.builtAt } : null;
				};
				return {
					features: { indexnow: isOn(features, FEATURE.indexnow), news: isOn(features, FEATURE.news), llms: isOn(features, FEATURE.llms), feed: isOn(features, FEATURE.feed) },
					settings,
					collections,
					key,
					urls: {
						keyFile: key ? `${origin}/${key}.txt` : null,
						news: `${origin}/news-sitemap.xml`,
						llms: `${origin}/llms.txt`,
						feed: `${origin}${FEED_PATH}`,
					},
					log: (await ctx.kv.get<PingLogEntry[]>(LOG_KEY)) ?? [],
					cache: { llms: await doc(LLMS_CACHE), news: await doc(NEWS_CACHE) },
				};
			},
		},

		"discovery/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const settings = parseInput(settingsSchema, ctx.input);
				await ctx.settings.set(SETTINGS_KEY, settings);
				settingsMemo = null;
				// Read with the feature switches: drop that cache too.
				invalidateFeatures();
				// Rebuild in the background; the old copies keep serving until then.
				const features = await ctxFeatures(ctx);
				const kinds: DocKind[] = [...(isOn(features, FEATURE.llms) ? (["llms"] as const) : []), ...(isOn(features, FEATURE.news) ? (["news"] as const) : [])];
				if (kinds.length) scheduleRebuild(ctx, kinds, 0);
				// Feeds in the edge cache were built with the old settings.
				await purgePageCache({ tags: [FEED_TAG] }).catch((error: unknown) => ctx.log.warn("Discovery: clearing cached feeds failed", { error: String(error) }));
				return { settings };
			},
		}),

		"discovery/regenerate-key": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const key = generateKey();
				await ctx.settings.set(INDEXNOW_KEY_SETTING, key);
				ctx.log.info("IndexNow key regenerated");
				return { key };
			},
		}),

		/** Submit URLs now (for checking the setup). Defaults to the home page. */
		"discovery/submit": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, FEATURE.indexnow);
				const { urls } = parseInput(z.object({ urls: z.array(z.string().url().max(2000)).max(100).optional() }), ctx.input ?? {});
				await ensureIndexNowKey(ctx);
				const origin = siteOrigin(ctx);
				const list = urls?.length ? urls : [`${origin}/`];
				const foreign = list.filter((u) => new URL(u).host !== new URL(origin).host);
				if (foreign.length) throw PluginRouteError.badRequest(`Only URLs on ${new URL(origin).host} can be submitted.`);
				const entry = await submit(ctx, list, "manual");
				if (!entry) throw PluginRouteError.badRequest("Nothing to submit.");
				return entry;
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

	return { routes, hooks };
}

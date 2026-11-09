/**
 * Discovery module: routes and hooks for IndexNow (and Bing Webmaster API
 * submissions, with a key), the news sitemap, llms.txt and per-entry
 * Markdown. Site URLs are answered by the middleware in ./middleware.ts,
 * which calls the public routes here.
 */
import { type PluginContext, PluginRouteError, PluginSettingEncryptionError, after, definePluginRoute } from "emdash";
import { z } from "zod";

import { absoluteUrl, entryUrl } from "../core/content-url.js";
import { siteInStaging, siteName } from "../core/site.js";
import { cachedCtxFeatures, ctxFeatures, invalidateFeatures, isOn, readSiteSetting, registerSiteSetting, requireFeature } from "../core/features.js";
import type { TaskDef } from "../core/module.js";
import { parseInput } from "../shared.js";
import { LLMS_CACHE, NEWS_CACHE, type CachedDocument, type DocKind, buildMarkdown, readDoc, rebuildNow, scheduleRebuild } from "./build.js";
import { type BingDeps, type BingQuota, type QuotaCheck, BING_DOCS_URL, BING_ENDPOINT, bingSiteUrl, checkQuota, submitToBing } from "./bing.js";
import { type Fetch, type PingLogEntry, IndexNowBatcher, buildPayload, generateKey, sendIndexNow } from "./indexnow.js";
import { buildFeed } from "./feed-build.js";
import { FEED_PATH, FEED_TAG } from "./feed.js";
import { purgePageCache } from "../pageCache/lib.js";
import { markdownUrl } from "./markdown.js";
import {
	BING_KEY_PATTERN,
	BING_KEY_SETTING,
	INDEXNOW_KEY_SETTING,
	SETTINGS_KEY,
	type DiscoverySettings,
	ensureIndexNowKey,
	loadSettings,
	readBingApiKey,
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
/** The Bing Webmaster API quota last read for the site, counted down as batches go out (BingQuota). */
const BING_QUOTA_KEY = "state:discovery:bingQuota";
/** URLs waiting for Bing (over the quota, out of time, Bing unreachable), oldest first (string[]). */
const BING_PENDING_KEY = "state:discovery:bingPending";
/** Sends Bing's queue once a day, so URLs over one day's quota go out the next even when nothing changes. */
export const BING_DRAIN_TASK = "discovery-bing-drain";
/** Compare-and-set tries before the write falls back to last-write-wins. */
const CAS_ATTEMPTS = 3;
const urlKey = (collection: string, id: string) => `state:discovery:url:${collection}:${id}`;

export type { PingLogEntry };

/** Submissions wait this long for more changes, then go out as one request. */
const BATCH_WINDOW_MS = 3000;
/** Node's timers would otherwise keep a test process alive for the window; on Workers unref doesn't exist. */
const sleep = (ms: number) => new Promise<void>((resolve) => void (setTimeout(resolve, ms) as unknown as { unref?: () => void }).unref?.());
/** Exported for tests, which flush it by hand instead of waiting out the window. */
export const submissionBatcher = new IndexNowBatcher({ windowMs: BATCH_WINDOW_MS, defer: (task) => after(task), sleep });

/** The plugin's fetch: EmDash checks each host against allowedHosts (pack.ts). */
const httpFetch = (ctx: PluginContext): Fetch | null => (ctx.http ? (ctx.http.fetch.bind(ctx.http) as Fetch) : null);

type KV = PluginContext["kv"];

/**
 * Store `change(stored value)` under `key`. With EmDash's compare-and-set (KVAccess.getVersioned/compareAndSet),
 * a write that lost a race to another isolate is tried again on the newer value, CAS_ATTEMPTS times; without
 * it (an older EmDash), or after that many lost races, the plain write goes through: last write wins, as before.
 * A null result removes the key.
 */
async function updateKv<T>(kv: KV, key: string, change: (current: T | null) => T | null): Promise<void> {
	if (typeof kv.getVersioned === "function" && typeof kv.compareAndSet === "function" && typeof kv.compareAndDelete === "function") {
		for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
			const current = await kv.getVersioned<T>(key);
			const next = change(current?.value ?? null);
			if (next === null) {
				if (!current || (await kv.compareAndDelete(key, current.revision)).applied) return;
				continue;
			}
			if ((await kv.compareAndSet(key, current?.revision ?? null, next)).applied) return;
		}
	}
	const next = change((await kv.get<T>(key)) ?? null);
	if (next === null) await kv.delete(key);
	else await kv.set(key, next);
}

const asUrlList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((url): url is string => typeof url === "string") : []);

function bingDeps(ctx: PluginContext): BingDeps {
	return {
		fetch: httpFetch(ctx),
		readQuota: async () => (await ctx.kv.get<BingQuota>(BING_QUOTA_KEY)) ?? null,
		updateQuota: (change) => updateKv<BingQuota>(ctx.kv, BING_QUOTA_KEY, change),
		readPending: async () => asUrlList(await ctx.kv.get<unknown>(BING_PENDING_KEY)),
		updatePending: (change) =>
			updateKv<string[]>(ctx.kv, BING_PENDING_KEY, (current) => {
				const next = change(asUrlList(current));
				return next.length ? next : null;
			}),
	};
}

const isEncryptionError = (error: unknown): boolean => error instanceof PluginSettingEncryptionError || (error as { name?: unknown } | null)?.name === "PluginSettingEncryptionError";

/** The saved Bing Webmaster API key, or null (also when it can't be decrypted: logged; IndexNow still goes out). */
async function bingKey(ctx: PluginContext): Promise<string | null> {
	try {
		return await readBingApiKey(ctx);
	} catch (error) {
		ctx.log.warn("Discovery: the Bing Webmaster API key can't be read; save it again", { error: String(error).slice(0, 200) });
		return null;
	}
}

/** For the admin routes: the saved key, or why there's none to use. */
async function requireBingKey(ctx: PluginContext): Promise<string> {
	let apiKey: string | null;
	try {
		apiKey = await readBingApiKey(ctx);
	} catch (error) {
		if (isEncryptionError(error)) throw PluginRouteError.badRequest("The saved Bing Webmaster API key can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed. Save the key again.");
		throw error;
	}
	if (!apiKey) throw PluginRouteError.badRequest("Save a Bing Webmaster API key first.");
	return apiKey;
}

/** Log each entry and keep the newest LOG_LIMIT in Recent submissions. */
async function recordEntries(ctx: PluginContext, entries: PingLogEntry[]): Promise<void> {
	for (const entry of entries) {
		const name = entry.endpoint === BING_ENDPOINT ? "Bing Webmaster API" : "IndexNow";
		const data = { endpoint: entry.endpoint, count: entry.count, status: entry.status, ...(entry.error ? { error: entry.error } : {}) };
		if (entry.ok) ctx.log.info(`${name} submitted`, data);
		else if (entry.queued) ctx.log.info(`${name} submission queued`, data);
		else ctx.log.warn(`${name} submission failed`, data);
	}
	if (!entries.length) return;
	const log = (await ctx.kv.get<PingLogEntry[]>(LOG_KEY)) ?? [];
	await ctx.kv.set(LOG_KEY, [...entries, ...log].slice(0, LOG_LIMIT));
}

/**
 * Send `urls` to IndexNow and, with a Bing Webmaster API key saved, to Bing's
 * URL Submission API, at the same time. Each call has its own deadline and
 * its own log entries, so IndexNow's 429s never hide Bing's result. Returns
 * the new log entries (Bing's first), or none when no URL is on the site.
 */
async function submit(ctx: PluginContext, urls: string[], trigger: PingLogEntry["trigger"]): Promise<PingLogEntry[]> {
	const key = await ensureIndexNowKey(ctx);
	const settings = await loadSettings(ctx);
	const origin = siteOrigin(ctx);
	const payload = buildPayload(origin, key, urls);
	if (!payload) return [];
	const apiKey = await bingKey(ctx);
	const [bing, indexnow] = await Promise.all([
		apiKey ? submitToBing(bingDeps(ctx), bingSiteUrl(origin), apiKey, payload.urlList, trigger) : Promise.resolve([]),
		sendIndexNow(httpFetch(ctx), settings.indexnow.endpoint, payload, trigger),
	]);
	const entries = [...bing, indexnow];
	await recordEntries(ctx, entries);
	return entries;
}

/**
 * The daily task: send what waits in Bing's queue (nothing goes to IndexNow,
 * which had these URLs when they changed). Nothing to do without a key, with
 * an empty queue, or while the site is in staging.
 */
export async function drainBingQueue(ctx: PluginContext): Promise<PingLogEntry[]> {
	if (await siteInStaging()) return [];
	const apiKey = await bingKey(ctx);
	if (!apiKey) return [];
	if (!asUrlList(await ctx.kv.get<unknown>(BING_PENDING_KEY)).length) return [];
	const entries = await submitToBing(bingDeps(ctx), bingSiteUrl(siteOrigin(ctx)), apiKey, [], "queue");
	await recordEntries(ctx, entries);
	return entries;
}

const ENCRYPTION_MESSAGE = "Couldn't store the Bing Webmaster API key. Secret plugin settings need the EMDASH_ENCRYPTION_KEY Worker secret.";

/** The message the Discovery page shows after Save key. */
function saveMessage(check: QuotaCheck): string {
	if (check.ok) return `Key saved. Bing accepts it: ${check.quota.daily} URL submission${check.quota.daily === 1 ? "" : "s"} left today, ${check.quota.monthly} this month.`;
	if (check.permanent) return `Key not saved: ${check.error}`;
	// Status 0 (no answer) or 5xx: Bing itself couldn't tell us anything.
	if (check.status === 0 || check.status >= 500) return `Key saved; Bing couldn't be reached to check it (${check.error}). Check key tries again.`;
	return `Key saved, but Bing didn't accept the check (HTTP ${check.status}): ${check.error}`;
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
	if (urls.length) submissionBatcher.add(urls, (batch) => submit(ctx, batch, "content").then(() => undefined));
}

async function onContentChange(ctx: PluginContext, collection: string, id: string | undefined, kind: ChangeKind, permanent = false) {
	const features = await ctxFeatures(ctx);
	const llms = isOn(features, FEATURE.llms);
	const news = isOn(features, FEATURE.news);
	const kinds: DocKind[] = [...(llms ? (["llms"] as const) : []), ...(news ? (["news"] as const) : [])];
	if (kinds.length) scheduleRebuild(ctx, kinds);
	if (id && isOn(features, FEATURE.indexnow)) {
		// A site in EmDash's staging mode is hidden from search engines: don't tell them about its pages.
		if (await siteInStaging()) {
			ctx.log.info("IndexNow: skipped, the site is in staging", { collection, id, kind });
			return;
		}
		await queueIndexNow(ctx, await loadSettings(ctx), collection, id, kind, permanent);
	}
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
					staging: await siteInStaging(),
					features: { indexnow: isOn(features, FEATURE.indexnow), news: isOn(features, FEATURE.news), llms: isOn(features, FEATURE.llms), feed: isOn(features, FEATURE.feed) },
					settings,
					collections,
					key,
					// Whether a Bing Webmaster API key is saved, never the key itself.
					bing: {
						keySaved: Boolean(await bingKey(ctx)),
						quota: (await ctx.kv.get<BingQuota>(BING_QUOTA_KEY)) ?? null,
						pending: asUrlList(await ctx.kv.get<unknown>(BING_PENDING_KEY)).length,
						docs: BING_DOCS_URL,
					},
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
				if (await siteInStaging()) throw PluginRouteError.badRequest("The site is in staging, hidden from search engines, so nothing is sent to IndexNow. Go live under Settings → General → Site Status first.");
				const { urls } = parseInput(z.object({ urls: z.array(z.string().url().max(2000)).max(100).optional() }), ctx.input ?? {});
				await ensureIndexNowKey(ctx);
				const origin = siteOrigin(ctx);
				const list = urls?.length ? urls : [`${origin}/`];
				const foreign = list.filter((u) => new URL(u).host !== new URL(origin).host);
				if (foreign.length) throw PluginRouteError.badRequest(`Only URLs on ${new URL(origin).host} can be submitted.`);
				const entries = await submit(ctx, list, "manual");
				if (!entries.length) throw PluginRouteError.badRequest("Nothing to submit.");
				// The first entry's fields too, for an admin page loaded before this version.
				return { ...entries[0], entries };
			},
		}),

		/**
		 * Save or remove the Bing Webmaster API key. It's a secret setting (src/core/secrets.ts), so EmDash
		 * stores it encrypted; it's never sent back. Saving checks it right away (the site's quota): a key Bing
		 * rejects for good is removed again (keySaved: false); one Bing couldn't check stays saved.
		 */
		"discovery/bing-key": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, FEATURE.indexnow);
				const input = parseInput(z.object({ key: z.string().trim().max(500).optional(), clear: z.boolean().optional() }), ctx.input ?? {});
				if (input.clear) {
					await ctx.settings.delete(BING_KEY_SETTING);
					await ctx.kv.delete(BING_QUOTA_KEY);
					await ctx.kv.delete(BING_PENDING_KEY);
					ctx.log.info("Discovery: Bing Webmaster API key removed");
					return { keySaved: false, check: null, message: "Key removed. Changed URLs go to IndexNow only." };
				}
				if (!input.key) throw PluginRouteError.badRequest("Enter a Bing Webmaster API key.");
				if (!BING_KEY_PATTERN.test(input.key)) throw PluginRouteError.badRequest("That doesn't look like a Bing Webmaster API key. Copy it again from Bing Webmaster Tools → Settings → API access.");
				try {
					await ctx.settings.set(BING_KEY_SETTING, input.key);
				} catch (error) {
					if (isEncryptionError(error)) throw PluginRouteError.badRequest(ENCRYPTION_MESSAGE);
					throw error;
				}
				// A new key can belong to another account: its quota is read again.
				await ctx.kv.delete(BING_QUOTA_KEY);
				const check = await checkQuota(bingDeps(ctx), bingSiteUrl(siteOrigin(ctx)), input.key);
				if (!check.ok && check.permanent) {
					// Bing's answer is final (InvalidApiKey, a blocked or unknown account): don't keep a key that can't work.
					await ctx.settings.delete(BING_KEY_SETTING);
					ctx.log.warn("Discovery: Bing rejected the Bing Webmaster API key; not saved", { status: check.status, error: check.error });
					return { keySaved: false, check, message: saveMessage(check) };
				}
				ctx.log.info("Discovery: Bing Webmaster API key saved", check.ok ? {} : { check: check.error });
				return { keySaved: true, check, message: saveMessage(check) };
			},
		}),

		/** Check the saved Bing Webmaster API key: the site's URL submission quota, or Bing's error. */
		"discovery/bing-check": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, FEATURE.indexnow);
				const apiKey = await requireBingKey(ctx);
				return checkQuota(bingDeps(ctx), bingSiteUrl(siteOrigin(ctx)), apiKey);
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

	/** Bing's quota resets daily: send what waited, even on a day nothing changes. Runs only with IndexNow on. */
	const tasks: TaskDef[] = [{ name: BING_DRAIN_TASK, schedule: "@daily", feature: FEATURE.indexnow, handler: async (ctx) => void (await drainBingQueue(ctx)) }];

	return { routes, hooks, tasks };
}

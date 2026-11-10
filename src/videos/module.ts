/**
 * Videos module: Cloudflare Stream library, the coywolf-video block's data,
 * VideoObject schema, the embed index, the video sitemap, plays/likes,
 * captions and the Stream webhook.
 */
import { PluginRouteError, definePluginRoute } from "emdash";
import type { PageMetadataContribution, PageMetadataEvent } from "emdash";
import { z } from "zod";

import { absoluteUrl, entryUrl } from "../core/content-url.js";
import { ctxFeatures, invalidateFeatures, isOn, requireCachedFeature, requireFeature, cachedCtxFeatures } from "../core/features.js";
import { DEADLINES, withDeadline } from "../core/single-flight.js";
import { type PurgeScope, purgePageCache } from "../pageCache/lib.js";
import { DEFAULT_RATE_LIMITER, addressKey, bindingAllows, rateLimitBinding } from "../core/rate-limit.js";
import { afterResponse, parseInput, workerEnv } from "../shared.js";
import { ENGAGEMENT_HEADER, ENGAGEMENT_LIMITS, EngagementLimiter, LIKES_BY_PREFIX, hasEngagementHeader, likeAction, likesByKey, staleLikesByKey } from "./engagement.js";
import {
	type SitemapEntry,
	type VideoRef,
	buildVideoObject,
	buildVideoSitemap,
	findVideoBlocks,
	iframeUrl,
	indexSource,
	isImageUrl,
	RecentKeys,
	isUid,
	normalizeCustomerHost,
	parseTags,
	posterUrl,
	sha256Hex,
	MAX_CAPTION_BYTES,
	MAX_WEBHOOK_PAGES,
	VIDEO_SITEMAP_TAG,
	utf8Bytes,
	verifyWebhookSignature,
	videoPagesScope,
	watchUrl,
} from "./lib.js";
import {
	COLLECTIONS,
	type Counts,
	type Ctx,
	type EmbedEntry,
	SETTINGS,
	type VideoMeta,
	videoFacts,
	SITEMAP_KEY,
	adminSettings,
	allEmbeds,
	bump,
	captionStore,
	client,
	countsFor,
	embedKey,
	embedStore,
	invalidateEmbeds,
	invalidateLibrary,
	invalidatePublicConfig,
	invalidateSitemap,
	library,
	metaFor,
	metaStore,
	patchMeta,
	publicConfig,
	refreshCaptions,
	refreshDownload,
	refreshVideo,
	statsStore,
} from "./store.js";
import { FONT_WEIGHTS, normalizeDisplay } from "./render.js";
import { StreamError } from "./stream.js";
import { readOnlyRoute } from "../core/routes.js";

export interface VideosOptions {
	/** Longest upload Stream should accept, in seconds (reserves quota while uploading). Default 3600. */
	maxUploadDurationSeconds?: number;
	/**
	 * Workers Rate Limiting binding (wrangler "ratelimits") that also limits plays and likes per visitor across isolates.
	 * Default COYWOLF_RATE_LIMITER, used when the site has a binding by that name (see docs/performance.md).
	 */
	rateLimiter?: string;
}

export const F = {
	main: "videos",
	schema: "videos.schema",
	sitemap: "videos.sitemap",
	engagement: "videos.engagement",
	captions: "videos.captions",
	webhook: "videos.webhook",
} as const;

export const TASKS = { captions: "videos-captions-refresh", likes: "videos-likes-prune", downloads: "videos-downloads-refresh" } as const;

const hexColor = z
	.string()
	.trim()
	.refine((v) => v === "" || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v), "Colors must be hex, such as #f6821f.");

const align = z.enum(["left", "center", "right"]);
const optionalHex = hexColor.optional();

/** Views & likes and Appearance (stored normalized; see render.ts). */
const displayInput = z.object({
	showName: z.boolean(),
	showDescription: z.boolean(),
	showPlays: z.boolean(),
	showLikes: z.boolean(),
	showLikeCount: z.boolean(),
	showDate: z.boolean(),
	followSiteDefaults: z.boolean(),
	dateStyle: z.enum(["absolute", "relative"]),
	likeIcon: z.enum(["heart", "thumbs", "star"]),
	scheme: z.enum(["auto", "light", "dark", "off"]),
	align,
	metaAlign: align,
	radius: z.number().int("Use whole pixels for the corner radius.").min(0).max(48, "Corner radius is 48 px at most."),
	border: z.boolean(),
	borderWidth: z.number().int("Use whole pixels for the border width.").min(0).max(20, "Border width is 20 px at most."),
	borderColor: optionalHex,
	titleColor: optionalHex,
	titleSize: z.number().min(0.5, "Font sizes are 0.5 to 4 em.").max(4, "Font sizes are 0.5 to 4 em."),
	titleWeight: z.enum(["", ...FONT_WEIGHTS]),
	descWeight: z.enum(["", ...FONT_WEIGHTS]),
	likeColor: optionalHex,
	likeBg: optionalHex,
	likeActiveColor: optionalHex,
	likeActiveBg: optionalHex,
	metaColor: optionalHex,
	metaSize: z.number().min(0.5, "Font sizes are 0.5 to 4 em.").max(4, "Font sizes are 0.5 to 4 em."),
});

const settingsInput = z.object({
	accountId: z
		.string()
		.trim()
		.refine((v) => v === "" || /^[0-9a-f]{32}$/i.test(v), "The account ID should be 32 hexadecimal characters.")
		.optional(),
	/** Write-only: a new token replaces the saved one; empty keeps it. */
	token: z.string().trim().max(500).optional(),
	clearToken: z.boolean().optional(),
	customerSubdomain: z
		.string()
		.trim()
		.max(253)
		.refine((v) => v === "" || normalizeCustomerHost(v) !== null, "Use the customer subdomain, such as customer-abc123.cloudflarestream.com.")
		.optional(),
	accentColor: hexColor.optional(),
	backgroundColor: hexColor.optional(),
	lightEmbed: z.boolean().optional(),
	display: displayInput.partial().optional(),
	defaultTags: z.string().max(2000).optional(),
});

const uidSchema = z.string().regex(/^[0-9a-f]{32}$/, "Not a Stream video ID.");
const langSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a language code such as en or pt-BR.");

/** Turn Stream API failures into readable admin errors. */
async function stream<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof StreamError) throw PluginRouteError.badRequest(`Cloudflare Stream: ${error.message}`);
		throw error;
	}
}

async function requireClient(ctx: Ctx) {
	const api = await client(ctx);
	if (!api) throw PluginRouteError.badRequest("Add your Cloudflare account ID and Stream API token on the Videos page → Settings first.");
	return api;
}

// ── Embed index ──────────────────────────────────────────────────

/**
 * Index one entry. Hook events can carry draft-hydrated data under the live
 * status, so hooks re-read the live row; `isLive` is for rows that already
 * came from the database (reindex).
 */
async function indexEntry(ctx: Ctx, collection: string, content: Record<string, unknown>, fetchMissing = true, isLive = false): Promise<number> {
	const id = typeof content.id === "string" ? content.id : null;
	if (!id) return 0;
	let live: Record<string, unknown> | null = isLive ? content : null;
	if (!isLive && ctx.content) {
		live = ((await ctx.content.get(collection, id)) as unknown as Record<string, unknown> | null) ?? null;
		if (!live) {
			await unindexEntry(ctx, collection, id);
			return 0;
		}
	}
	const item = indexSource(content, live);
	if (!item) return 0;
	const data = item.data as Record<string, unknown>;
	const videos = findVideoBlocks(data);
	const store = embedStore(ctx);
	const key = embedKey(collection, id);
	const prev = await store.get(key);
	if (!videos.length) {
		if (prev) {
			await store.delete(key);
			invalidateEmbeds();
			await invalidateSitemap(ctx);
		}
		return 0;
	}
	const status = typeof item.status === "string" ? item.status : "draft";
	const path =
		status === "published" && typeof item.slug === "string"
			? await entryUrl(ctx, collection, { id, slug: item.slug, publishedAt: typeof item.publishedAt === "string" || item.publishedAt instanceof Date ? item.publishedAt : null, locale: typeof item.locale === "string" ? item.locale : null, status }).catch(() => null)
			: null;
	const url = path && ctx.site.url ? absoluteUrl(path, ctx.site.url) : null;
	const entry: EmbedEntry = {
		collection,
		entryId: id,
		slug: typeof item.slug === "string" ? item.slug : null,
		status,
		title: typeof data.title === "string" ? data.title : typeof data.name === "string" ? data.name : null,
		url,
		publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : null,
		updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
		uids: videos.map((v) => v.uid),
		videos,
	};
	await store.put(key, entry);
	invalidateEmbeds();
	await invalidateSitemap(ctx);
	if (fetchMissing) {
		const known = await metaFor(ctx, entry.uids);
		const api = await client(ctx);
		for (const uid of entry.uids.filter((u) => !known.has(u)).slice(0, 5)) {
			try {
				await refreshVideo(ctx, uid, api);
			} catch (error) {
				ctx.log.warn("Videos: could not read video from Stream", { uid, error: String(error) });
			}
		}
	}
	return videos.length;
}

async function unindexEntry(ctx: Ctx, collection: string, id: string): Promise<void> {
	if (await embedStore(ctx).delete(embedKey(collection, id))) {
		invalidateEmbeds();
		await invalidateSitemap(ctx);
	}
}

/**
 * After a Stream webhook call, or an admin change to one video (details,
 * deletion, captions): clear the cached pages that embed the video
 * (videoPagesScope: by path, the home page by its entry's tag, at most
 * MAX_WEBHOOK_PAGES paths), within DEADLINES.purgeMs. Never fails the caller.
 * These aren't settings saves (src/pageCache/lib.ts NO_SETTINGS_CHANGE): the
 * video's details are read from D1 on every render, so one purge is enough.
 */
async function clearVideoPages(ctx: Ctx, uid: string): Promise<void> {
	try {
		const pages = videoPagesScope(await allEmbeds(ctx), uid);
		if (!pages) return;
		if (pages.skipped) {
			ctx.log.warn("Videos: the video is on more pages than one webhook call clears; the newest were cleared, the rest refresh at their normal lifetime", {
				uid,
				cleared: pages.pathPrefixes.length,
				skipped: pages.skipped,
				max: MAX_WEBHOOK_PAGES,
			});
		}
		// The video sitemap lists the video too: its edge copy goes in the same purge call.
		const tags = [...pages.tags, VIDEO_SITEMAP_TAG];
		const scope: PurgeScope = pages.pathPrefixes.length ? { pathPrefixes: pages.pathPrefixes, tags } : { tags };
		if (await withDeadline(purgePageCache(scope), DEADLINES.purgeMs, "clearing the pages that show a video")) {
			ctx.log.info("Videos: cleared the pages that show the video", { uid, pages: pages.pathPrefixes.length, homePage: pages.tags.length > 0 });
		}
	} catch (error) {
		ctx.log.warn("Videos: couldn't clear the pages that show the video", { uid, error: String(error) });
	}
}

/** uid → entries that embed it. */
function usage(entries: EmbedEntry[]): Map<string, Array<{ title: string | null; url: string | null; collection: string; status: string }>> {
	const map = new Map<string, Array<{ title: string | null; url: string | null; collection: string; status: string }>>();
	for (const e of entries) {
		for (const uid of e.uids) {
			const list = map.get(uid) ?? [];
			list.push({ title: e.title, url: e.url, collection: e.collection, status: e.status });
			map.set(uid, list);
		}
	}
	return map;
}

/**
 * Indexed videos no longer in the Stream library (deleted in Stream's
 * dashboard), with where they're used. Only from a complete library listing:
 * a truncated one would make videos look deleted.
 */
function orphans(libraryUids: Set<string>, complete: boolean, entries: EmbedEntry[]) {
	if (!complete) return [];
	return [...usage(entries)]
		.filter(([uid]) => !libraryUids.has(uid))
		.map(([uid, usedIn]) => ({ uid, usedIn }));
}

interface StorageUsage {
	videos: number;
	minutes: number;
	limit: number;
}
const STORAGE_KEY = "cache:videos:storage";

/** Forget a deleted video's details, counts and caption copies. */
async function removeLocal(ctx: Ctx, uid: string): Promise<void> {
	await Promise.all([metaStore(ctx).delete(uid), statsStore(ctx).delete(uid)]);
	const captions = await captionStore(ctx).query({ where: { uid }, limit: 50 });
	if (captions.items.length) await captionStore(ctx).deleteMany(captions.items.map((c) => c.id));
	await Promise.all([invalidateLibrary(ctx), invalidateSitemap(ctx), ctx.kv.delete(STORAGE_KEY)]);
}

// ── Schema ───────────────────────────────────────────────────────

/**
 * VideoObject nodes (no @context) for the videos embedded in a page's entry.
 * Schema & Social folds these into its @graph; on their own they're emitted
 * by pageMetadata below.
 */
export async function entryVideoObjects(ctx: Ctx, page: PageMetadataEvent["page"], embeds?: EmbedEntry | null): Promise<Record<string, unknown>[]> {
	const contributions = await videoContributions(ctx, page, embeds);
	return (contributions ?? []).flatMap((c) => {
		if (c.kind !== "jsonld" || Array.isArray(c.graph)) return [];
		const { "@context": _omit, ...node } = c.graph;
		return [node];
	});
}

async function pageMetadata(event: PageMetadataEvent, ctx: Ctx): Promise<PageMetadataContribution[] | null> {
	// Schema & Social's graph includes these videos (linked from the Article) when it's on.
	if (isOn(await cachedCtxFeatures(ctx), "schema.graph")) return null;
	return videoContributions(ctx, event.page);
}

/**
 * `embeds`: the entry's embed-index doc when the caller already read it
 * (undefined: read it here). The videos' metadata and counts are shared with
 * the page's Coywolf Video blocks (videoFacts), so each is read once per page.
 */
async function videoContributions(ctx: Ctx, page: PageMetadataEvent["page"], embeds?: EmbedEntry | null): Promise<PageMetadataContribution[] | null> {
	if (!page.content) return null;
	const entry = embeds !== undefined ? embeds : await embedStore(ctx).get(embedKey(page.content.collection, page.content.id));
	// Legacy WordPress markers are rendered (with their own schema) by the theme.
	const refs = (entry?.videos ?? []).filter((v) => !v.legacy);
	if (!refs.length) return null;
	const features = await cachedCtxFeatures(ctx);
	const engagement = isOn(features, F.engagement);
	const uids = refs.map((r) => r.uid);
	const [facts, cfg] = await Promise.all([videoFacts(ctx, uids, () => publishedUids(ctx)), publicConfig(ctx)]);
	const meta = new Map<string, VideoMeta>();
	const counts = new Map<string, Counts>();
	for (const [uid, f] of facts) {
		if (f.meta) meta.set(uid, f.meta);
		if (f.counts) counts.set(uid, f.counts);
	}
	const siteUrl = page.siteUrl || ctx.site.url || new URL(page.url).origin;
	return refs.map((ref) => ({
		kind: "jsonld" as const,
		id: `coywolf-video-${ref.uid}`,
		graph: buildVideoObject({
			ref,
			video: meta.get(ref.uid),
			host: cfg.host,
			siteUrl,
			page: { title: page.pageTitle ?? page.title, description: page.description, publishedTime: page.articleMeta?.publishedTime },
			counts: engagement ? (counts.get(ref.uid) ?? { plays: 0, likes: 0 }) : undefined,
			likesEnabled: engagement,
			captionsEnabled: isOn(features, F.captions),
		}),
	}));
}

// ── Sitemap ──────────────────────────────────────────────────────

const SITEMAP_TTL = 10 * 60_000;
/** Most collection tags on the video sitemap's edge copy. */
const MAX_SITEMAP_COLLECTION_TAGS = 50;

/**
 * The video sitemap and its edge cache tags: VIDEO_SITEMAP_TAG (cleared with
 * the pages of a video that changes, see clearVideoPages) and the collections
 * of the entries it lists (EmDash clears those when their content changes).
 */
async function sitemapXml(ctx: Ctx, origin: string): Promise<{ xml: string; tags: string[] }> {
	const cached = await ctx.kv.get<{ xml: string; at: number; tags?: string[] }>(SITEMAP_KEY);
	if (cached && Date.now() - cached.at < SITEMAP_TTL) return { xml: cached.xml, tags: cached.tags ?? [VIDEO_SITEMAP_TAG] };
	const features = await ctxFeatures(ctx);
	const entries = (await allEmbeds(ctx)).filter((e) => e.status === "published" && e.url);
	const uids = [...new Set(entries.flatMap((e) => e.uids))];
	const [meta, counts, cfg] = await Promise.all([
		metaFor(ctx, uids),
		isOn(features, F.engagement) ? countsFor(ctx, uids) : Promise.resolve(new Map<string, Counts>()),
		publicConfig(ctx),
	]);
	const out: SitemapEntry[] = entries
		.sort((a, b) => (a.url ?? "").localeCompare(b.url ?? ""))
		.map((e) => ({
			loc: new URL(e.url as string, origin).href,
			videos: e.videos.map((ref: VideoRef) => {
				const v = meta.get(ref.uid);
				return {
					thumbnail: posterUrl(cfg.host, ref.uid, ref, v, undefined, origin),
					title: ref.title ?? v?.name ?? e.title ?? "Video",
					description: ref.caption ?? v?.description ?? e.title ?? ref.title ?? v?.name ?? "Video",
					contentLoc: v?.downloadUrl,
					playerLoc: iframeUrl(cfg.host, ref.uid),
					duration: v?.duration,
					viewCount: counts.get(ref.uid)?.plays,
					publicationDate: v?.created ?? e.publishedAt ?? undefined,
				};
			}),
		}));
	const xml = buildVideoSitemap(out.map((e) => ({ ...e, videos: e.videos.map((v) => ({ ...v, description: v.description.replace(/<[^>]*>/g, "") })) })));
	const tags = [VIDEO_SITEMAP_TAG, ...[...new Set(entries.map((e) => e.collection))].slice(0, MAX_SITEMAP_COLLECTION_TAGS)];
	await ctx.kv.set(SITEMAP_KEY, { xml, at: Date.now(), tags });
	return { xml, tags };
}

// ── Plays and likes ──────────────────────────────────────────────

const SALT_KEY = "state:videos:likeSalt";
let saltMemo: { day: string; salt: string } | null = null;

async function dailySalt(ctx: Ctx): Promise<{ day: string; salt: string }> {
	const day = new Date().toISOString().slice(0, 10);
	if (saltMemo?.day === day) return saltMemo;
	let stored = await ctx.kv.get<{ day: string; salt: string }>(SALT_KEY);
	if (stored?.day !== day) {
		const bytes = crypto.getRandomValues(new Uint8Array(24));
		const fresh = { day, salt: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") };
		const prev = await ctx.kv.getVersioned<{ day: string; salt: string }>(SALT_KEY);
		const res = await ctx.kv.compareAndSet(SALT_KEY, prev?.revision ?? null, fresh);
		stored = res.applied ? fresh : ((await ctx.kv.get<{ day: string; salt: string }>(SALT_KEY)) ?? fresh);
	}
	saltMemo = stored;
	return stored;
}

/**
 * A per-day pseudonymous visitor id from the IP address alone (it never leaves
 * this function). Not the user agent: visitors choose it, so each new one was
 * a new visitor and could add another play or like.
 *
 * Null when the request has no address (EmDash reads it from Cloudflare's `cf`
 * object, missing in some setups such as local dev or a proxy in front). Then
 * every visitor would hash to one id, sharing a single like and a single play
 * per half hour, so the routes don't count anything instead (see videos/play
 * and videos/like).
 */
async function visitorHash(ctx: Ctx & { requestMeta: { ip: string | null } }): Promise<{ hash: string; day: string } | null> {
	const ip = ctx.requestMeta.ip?.trim();
	if (!ip) return null;
	const { day, salt } = await dailySalt(ctx);
	// An IPv6 visitor by its /64 (addressKey): one connection gets a whole /64, so full addresses made one visitor any number of them.
	return { hash: await sha256Hex(`${addressKey(ip)}|${salt}`), day };
}

/**
 * Plays and likes per visitor across isolates: the site's Workers Rate Limiting binding (`rateLimiter`, default
 * COYWOLF_RATE_LIMITER), on top of the per-isolate limits. True without a binding.
 */
async function bindingLets(name: string, key: string): Promise<boolean> {
	const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
	return bindingAllows(rateLimitBinding(env, name), key);
}

const limiter = new EngagementLimiter();
/**
 * Video uploads go through the site in pieces (videos/upload → videos/upload-chunk): 5 MiB,
 * Stream's minimum tus chunk (a multiple of 256 KiB) and under EmDash's 8 MiB plugin route
 * body cap.
 */
export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
/** How long a started upload can keep sending pieces. */
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
export const UPLOAD_UID_HEADER = "x-cw-upload-uid";
export const UPLOAD_OFFSET_HEADER = "x-cw-upload-offset";
interface PendingUpload {
	url: string;
	size: number;
	createdAt: number;
}
const uploadKey = (uid: string) => `videos:upload:${uid}`;

const rateLimited = () => new PluginRouteError("RATE_LIMITED", "Too many requests. Try again in a minute.", 429);

/** EmDash's Admin role. */
const ADMIN_ROLE = 50;
/**
 * Admins see a video's MP4 download URL; Contributors, Authors and Editors (who can use the Videos page through
 * media:upload or media:edit_any) don't: it's a direct, shareable link to the file, also for videos that are on
 * no published page yet. A route without a user is an API token, which needs the admin scope.
 */
export const seesDownloadUrls = (ctx: { user?: { role?: number } | null }) => !ctx.user || (ctx.user.role ?? 0) >= ADMIN_ROLE;
/** A video's details without its MP4 download URL (status and progress stay, so the page still shows them). */
export function withoutDownloadUrl<T extends { downloadUrl?: string } | null>(meta: T): T {
	if (!meta || meta.downloadUrl === undefined) return meta;
	const { downloadUrl: _hidden, ...rest } = meta;
	return rest as T;
}
/**
 * Uploads a user below Admin may start per UTC day: Stream bills by stored minutes, so the routes Contributors
 * can reach shouldn't be able to fill the account. Admins aren't limited.
 */
export const NON_ADMIN_UPLOADS_PER_DAY = 10;
const uploadsKey = (userId: string) => `state:videos:uploadsBy:${userId}`;

/** Videos embedded in published entries: the only ones public routes answer for (drafts stay private). */
let publishedMemo: { items: EmbedEntry[]; uids: Set<string> } | null = null;
async function publishedUids(ctx: Ctx): Promise<Set<string>> {
	const items = await allEmbeds(ctx);
	if (publishedMemo?.items !== items) {
		publishedMemo = { items, uids: new Set(items.filter((e) => e.status === "published").flatMap((e) => e.uids)) };
	}
	return publishedMemo.uids;
}

/** Plays already counted by this isolate (visitor+video → time), so reloads don't inflate counts. */
const recentPlays = new RecentKeys(5000, 30 * 60_000);
const seenRecently = (key: string) => recentPlays.seen(key);

// ── Routes ───────────────────────────────────────────────────────

const updateInput = z.object({
	uid: uidSchema,
	name: z.string().max(200).optional(),
	description: z.string().max(5000).optional(),
	posterTime: z.number().min(0).max(86_400).nullable().optional(),
	posterImage: z
		.string()
		.max(2000)
		.refine((v) => v === "" || isImageUrl(v.trim()), "The poster image must be an http(s) URL or a site path starting with /.")
		.nullable()
		.optional(),
	allowedOrigins: z.array(z.string().max(253)).max(50).optional(),
	downloads: z.boolean().optional(),
	/** Comma-separated; kept in Stream's meta.tags like Video Manager. */
	tags: z.string().max(2000).optional(),
	creator: z.string().trim().max(64).optional(),
});

export function videosModule(options: VideosOptions) {
	const maxDuration = Math.min(21_600, Math.max(60, options.maxUploadDurationSeconds ?? 3600));
	const rateLimiter = options.rateLimiter ?? DEFAULT_RATE_LIMITER;

	const routes = {
		// ── Admin ───────────────────────────────────────────────

		// A read (the Videos page asks for it with any method): it clears nothing and records no settings change.
		"videos/status": readOnlyRoute({
			permission: "media:upload" as const,
			handler: async (ctx: Ctx) => {
				await requireFeature(ctx, F.main);
				const [api, features, cfg, webhookSecret] = await Promise.all([client(ctx), ctxFeatures(ctx), publicConfig(ctx), ctx.settings.get<string>(SETTINGS.webhookSecret)]);
				return {
					configured: api !== null,
					host: cfg.host,
					features: Object.fromEntries(Object.entries(F).map(([k, id]) => [k, isOn(features, id)])),
					webhook: { subscribed: Boolean(webhookSecret), url: ctx.url("/_emdash/api/plugins/coywolf-pack/videos/webhook") },
					sitemapUrl: ctx.url("/coywolf-video-sitemap.xml"),
				};
			},
		}),

		/** The Videos page's Settings tab (the token is reported as set or not, never returned). */
		"videos/settings": {
			permission: "plugins:manage" as const,
			handler: async (ctx: Ctx) => {
				await requireFeature(ctx, F.main);
				return adminSettings(ctx);
			},
		},

		"videos/settings/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const input = parseInput(settingsInput, ctx.input);
				// Only the fields sent are written (the setup card sends just the connection).
				if (input.accountId !== undefined) await ctx.settings.set(SETTINGS.accountId, input.accountId);
				if (input.customerSubdomain !== undefined)
					await ctx.settings.set(SETTINGS.host, input.customerSubdomain ? (normalizeCustomerHost(input.customerSubdomain) ?? "") : "");
				if (input.accentColor !== undefined) await ctx.settings.set(SETTINGS.accent, input.accentColor);
				if (input.backgroundColor !== undefined) await ctx.settings.set(SETTINGS.background, input.backgroundColor);
				if (input.lightEmbed !== undefined) await ctx.settings.set(SETTINGS.lightEmbed, input.lightEmbed);
				if (input.display !== undefined) {
					const current = normalizeDisplay(await ctx.settings.get<unknown>(SETTINGS.display));
					await ctx.settings.set(SETTINGS.display, normalizeDisplay({ ...current, ...input.display }));
				}
				if (input.defaultTags !== undefined) await ctx.settings.set(SETTINGS.defaultTags, parseTags(input.defaultTags).join(", "));
				if (input.clearToken) await ctx.settings.delete(SETTINGS.token);
				else if (input.token) await ctx.settings.set(SETTINGS.token, input.token);
				// The player settings are read with the feature switches: drop both caches.
				invalidateFeatures();
				invalidatePublicConfig();
				await invalidateLibrary(ctx);
				ctx.log.info("Videos settings saved", { tokenChanged: Boolean(input.clearToken || input.token) });
				return adminSettings(ctx);
			},
		}),

		"videos/test": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const api = await requireClient(ctx);
				const videos = await stream(() => api.list(1));
				return { ok: true, message: `Connected to Cloudflare Stream${videos.length ? "" : " (the library is empty)"}.` };
			},
		})),

		"videos/list": readOnlyRoute(definePluginRoute({
			permission: "media:upload",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const { refresh } = parseInput(z.object({ refresh: z.boolean().optional() }), ctx.input ?? {});
				if (!(await client(ctx))) return { configured: false, items: [] };
				const items = await stream(() => library(ctx, refresh === true));
				const uids = items.map((v) => v.uid);
				const [features, meta, entries, cfg] = await Promise.all([ctxFeatures(ctx), metaFor(ctx, uids), allEmbeds(ctx), publicConfig(ctx)]);
				const counts = isOn(features, F.engagement) ? await countsFor(ctx, uids) : new Map<string, Counts>();
				const used = usage(entries);
				return {
					configured: true,
					// Stream lists at most 1,000 videos per call (store.ts library()).
					orphans: orphans(new Set(uids), items.length < 1000, entries),
					items: items.map((v) => {
						const m = meta.get(v.uid);
						return {
							...v,
							meta: undefined,
							description: m?.description ?? "",
							thumbnail: posterUrl(cfg.host, v.uid, {}, m ?? {}, 320, ctx.site.url || new URL(ctx.request.url).origin),
							plays: counts.get(v.uid)?.plays ?? 0,
							likes: counts.get(v.uid)?.likes ?? 0,
							usedIn: used.get(v.uid) ?? [],
							captions: m?.captions ?? [],
						};
					}),
				};
			},
		})),

		/** Options for the block's video picker ({ items: [{ id, name }] }, newest first). */
		"videos/options": readOnlyRoute(definePluginRoute({
			permission: "content:edit_own",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				if (!(await client(ctx))) return { items: [] };
				const items = await stream(() => library(ctx));
				const clock = (s: number) => (s > 0 ? ` (${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")})` : "");
				return { items: items.map((v) => ({ id: v.uid, name: `${v.name}${clock(v.duration)}${v.ready ? "" : " · processing"}` })) };
			},
		})),

		"videos/detail": readOnlyRoute(definePluginRoute({
			permission: "media:upload",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const { uid } = parseInput(z.object({ uid: uidSchema }), ctx.input);
				const api = await requireClient(ctx);
				const meta = await stream(() => refreshVideo(ctx, uid, api));
				let download: { status?: string; url?: string; percent?: number } | null = null;
				try {
					const d = (await api.getDownloads(uid))?.default;
					download = d ? { status: d.status, url: d.url, percent: d.percentComplete } : null;
					if (d?.status === "ready" && d.url && meta?.downloadUrl !== d.url) await patchMeta(ctx, uid, { downloadUrl: d.url, downloadStatus: "ready" });
				} catch {
					download = null;
				}
				if (!seesDownloadUrls(ctx)) return { meta: withoutDownloadUrl(meta), download: download && { status: download.status, percent: download.percent } };
				return { meta, download };
			},
		})),

		"videos/update": definePluginRoute({
			permission: "media:edit_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const input = parseInput(updateInput, ctx.input);
				const api = await requireClient(ctx);
				const fields: Record<string, unknown> = {};
				if (input.name !== undefined || input.allowedOrigins !== undefined || input.tags !== undefined || input.creator !== undefined) {
					const current = await stream(() => api.get(input.uid));
					if (input.name !== undefined || input.tags !== undefined) {
						const meta: Record<string, unknown> = { ...(current.meta ?? {}) };
						if (input.name !== undefined) meta.name = input.name.trim() || input.uid;
						if (input.tags !== undefined) {
							const tags = parseTags(input.tags);
							if (tags.length) meta.tags = tags.join(", ");
							else delete meta.tags;
						}
						fields.meta = meta;
					}
					if (input.allowedOrigins !== undefined) fields.allowedOrigins = input.allowedOrigins.map((o) => o.trim()).filter(Boolean);
					if (input.creator !== undefined) fields.creator = input.creator || null;
					await stream(() => api.update(input.uid, fields));
				}
				const patch: Record<string, unknown> = {};
				if (input.description !== undefined) patch.description = input.description.trim();
				if (input.posterTime !== undefined) patch.posterTime = input.posterTime ?? undefined;
				if (input.posterImage !== undefined) patch.posterImage = input.posterImage?.trim() || undefined;
				let download: { status?: string; url?: string } | null = null;
				if (input.downloads === true) {
					const d = (await stream(() => api.createDownload(input.uid)))?.default;
					download = d ? { status: d.status, url: d.url } : null;
					patch.downloadStatus = d?.status;
					patch.downloadUrl = d?.status === "ready" ? d.url : undefined;
				} else if (input.downloads === false) {
					await stream(() => api.deleteDownload(input.uid));
					patch.downloadStatus = undefined;
					patch.downloadUrl = undefined;
				}
				await patchMeta(ctx, input.uid, patch);
				const meta = await stream(() => refreshVideo(ctx, input.uid, api));
				await invalidateLibrary(ctx);
				await invalidateSitemap(ctx);
				// Only the pages that show this video (its name, description, poster or download changed), not every page.
				afterResponse(clearVideoPages(ctx, input.uid));
				ctx.log.info("Video updated", { uid: input.uid });
				if (!seesDownloadUrls(ctx)) return { meta: withoutDownloadUrl(meta), download: download && { status: download.status } };
				return { meta, download };
			},
		}),

		/**
		 * Starts an upload. EmDash's admin Content-Security-Policy (connect-src 'self', since
		 * EmDash 1.3.1) blocks the browser from sending the file to Stream itself, so the
		 * browser sends it here in UPLOAD_CHUNK_BYTES pieces (videos/upload-chunk) and the
		 * Worker forwards each piece to a tus upload created here. The tus URL stays on the
		 * server (KV, by uid): the chunk route only ever forwards to a URL this route made.
		 */
		"videos/upload": definePluginRoute({
			permission: "media:upload",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const input = parseInput(
					z.object({
						name: z.string().min(1).max(200),
						size: z.number().int().positive(),
						tags: z.string().max(2000).optional(),
						type: z.string().max(200).optional(),
					}),
					ctx.input,
				);
				const { name, size } = input;
				// Stream turns any file it's given into a "video" (a still image becomes a one-frame clip).
				if (input.type !== undefined && !input.type.startsWith("video/")) throw new PluginRouteError("BAD_REQUEST", "Choose a video file (MP4, MOV, WebM…), not an image or other file.", 400);
				const api = await requireClient(ctx);
				// Below Admin: a daily number of uploads (counted once Stream has accepted one).
				const limited = ctx.user && (ctx.user.role ?? 0) < ADMIN_ROLE ? ctx.user.id : null;
				const day = new Date().toISOString().slice(0, 10);
				const started = limited ? await ctx.kv.get<{ day: string; count: number }>(uploadsKey(limited)) : null;
				const startedToday = started?.day === day ? started.count : 0;
				if (limited && startedToday >= NON_ADMIN_UPLOADS_PER_DAY) {
					throw new PluginRouteError("RATE_LIMITED", `You can start ${NON_ADMIN_UPLOADS_PER_DAY} video uploads a day. Ask an admin to upload more.`, 429);
				}
				await invalidateLibrary(ctx);
				// The upload dialog starts with the default tags (Settings → Uploads).
				const tags = parseTags(input.tags ?? (await ctx.settings.get<string>(SETTINGS.defaultTags)) ?? "").join(", ");
				const meta: Record<string, string> = tags ? { name, tags } : { name };
				const r = await stream(() => api.tusUpload({ length: size, maxDurationSeconds: maxDuration, name }));
				if (!r.uid) throw new PluginRouteError("INTERNAL_ERROR", "Cloudflare Stream didn't return an id for the upload.", 502);
				const uid = r.uid;
				if (limited) await ctx.kv.set(uploadsKey(limited), { day, count: startedToday + 1 });
				// tus uploads carry only the name; tags go on the waiting video record.
				if (tags) await api.update(uid, { meta }).catch((error: unknown) => ctx.log.warn("Videos: could not tag the upload", { uid, error: String(error) }));
				await ctx.kv.set(uploadKey(uid), { url: r.uploadURL, size, createdAt: Date.now() } satisfies PendingUpload);
				return { method: "proxy", uid, chunkBytes: UPLOAD_CHUNK_BYTES };
			},
		}),

		/** One piece of an upload started by videos/upload, forwarded to its tus URL. */
		"videos/upload-chunk": definePluginRoute({
			permission: "media:upload",
			methods: ["POST"],
			request: { body: "bytes", maxBytes: UPLOAD_CHUNK_BYTES, headers: [UPLOAD_UID_HEADER, UPLOAD_OFFSET_HEADER] },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const uid = ctx.request.headers.get(UPLOAD_UID_HEADER) ?? "";
				const offset = Number(ctx.request.headers.get(UPLOAD_OFFSET_HEADER));
				const bytes = ctx.input as Uint8Array;
				if (!/^[a-f0-9]{32}$/.test(uid)) throw new PluginRouteError("BAD_REQUEST", "Unknown upload.", 400);
				const pending = await ctx.kv.get<PendingUpload>(uploadKey(uid));
				if (!pending || Date.now() - pending.createdAt > UPLOAD_TTL_MS) throw new PluginRouteError("NOT_FOUND", "This upload has expired. Start it again.", 404);
				if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new PluginRouteError("BAD_REQUEST", "Empty upload piece.", 400);
				if (!Number.isInteger(offset) || offset < 0 || offset + bytes.byteLength > pending.size) throw new PluginRouteError("BAD_REQUEST", "Upload piece out of range.", 400);
				const res = await fetch(pending.url, {
					method: "PATCH",
					headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
					body: new Uint8Array(bytes),
				});
				if (!res.ok) {
					ctx.log.warn("Videos: Stream refused an upload piece", { uid, offset, status: res.status });
					throw new PluginRouteError("INTERNAL_ERROR", `Cloudflare Stream refused part of the upload (HTTP ${res.status}).`, 502);
				}
				const next = Number(res.headers.get("Upload-Offset") ?? offset + bytes.byteLength);
				if (next >= pending.size) {
					await ctx.kv.delete(uploadKey(uid));
					await invalidateLibrary(ctx);
				}
				return { offset: next, done: next >= pending.size };
			},
		}),

		/**
		 * Delete a video from Stream and the site's copies of its details, counts and captions.
		 * Refused while content embeds it, unless `force` (the admin confirms first).
		 */
		"videos/delete": definePluginRoute({
			permission: "media:delete_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const { uid, force } = parseInput(z.object({ uid: uidSchema, force: z.boolean().optional() }), ctx.input);
				const used = usage(await allEmbeds(ctx)).get(uid) ?? [];
				if (used.length && !force) {
					throw PluginRouteError.badRequest(`This video is used in ${used.length} ${used.length === 1 ? "entry" : "entries"}. Remove it from them first, or delete it anyway.`);
				}
				const api = await requireClient(ctx);
				await stream(async () => {
					try {
						await api.remove(uid);
					} catch (error) {
						// Already gone from Stream (deleted in its dashboard): still clear the site's copies.
						if (!(error instanceof StreamError && error.status === 404)) throw error;
					}
				});
				await removeLocal(ctx, uid);
				// Pages that still embed it (deleted anyway) lose its schema and player details.
				if (used.length) afterResponse(clearVideoPages(ctx, uid));
				ctx.log.info("Video deleted", { uid, usedIn: used.length });
				return { deleted: true, usedIn: used.length };
			},
		}),

		/** Minutes stored in Stream and the account's limit (cached for five minutes). */
		"videos/storage": readOnlyRoute(definePluginRoute({
			permission: "media:upload",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const cached = await ctx.kv.get<{ usage: StorageUsage; at: number }>(STORAGE_KEY);
				if (cached && Date.now() - cached.at < 5 * 60_000) return cached.usage;
				const api = await requireClient(ctx);
				const r = await stream(() => api.storageUsage());
				const usage: StorageUsage = { videos: r?.videoCount ?? 0, minutes: r?.totalStorageMinutes ?? 0, limit: r?.totalStorageMinutesLimit ?? 0 };
				await ctx.kv.set(STORAGE_KEY, { usage, at: Date.now() });
				return usage;
			},
		})),

		/** Rebuild the embed index from all content, one page per call (the admin loops until done). */
		"videos/reindex": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.main);
				const { state } = parseInput(z.object({ state: z.object({ collections: z.array(z.string()), index: z.number().int(), cursor: z.string().nullable(), cleanup: z.number().int().optional() }).nullish() }), ctx.input ?? {});
				if (!ctx.content || !ctx.schema) throw PluginRouteError.internal("Content access is unavailable.");
				const collections = state?.collections ?? (await ctx.schema.listCollections()).map((c) => c.slug);
				let index = state?.index ?? 0;
				let cursor = state?.cursor ?? null;
				let scanned = 0;
				let found = 0;
				const started = Date.now();
				while (index < collections.length && Date.now() - started < 10_000) {
					const page = await ctx.content.list(collections[index], { limit: 50, ...(cursor ? { cursor } : {}) });
					for (const item of page.items) {
						scanned++;
						found += await indexEntry(ctx, collections[index], item as unknown as Record<string, unknown>, false, true);
					}
					if (page.hasMore && page.cursor) cursor = page.cursor;
					else {
						index++;
						cursor = null;
					}
				}
				if (index < collections.length) {
					return { done: false, scanned, found, removed: 0, state: { collections, index, cursor }, progress: `${Math.min(index + 1, collections.length)} of ${collections.length} collections` };
				}
				// Then drop index rows whose entries no longer exist.
				invalidateEmbeds();
				const entries = await allEmbeds(ctx);
				let at = state?.cleanup ?? 0;
				let removed = 0;
				while (at < entries.length && Date.now() - started < 10_000) {
					const e = entries[at++];
					if (!(await ctx.content.get(e.collection, e.entryId))) {
						await embedStore(ctx).delete(embedKey(e.collection, e.entryId));
						removed++;
					}
				}
				if (removed) {
					invalidateEmbeds();
					await invalidateSitemap(ctx);
				}
				const done = at >= entries.length;
				return { done, scanned, found, removed, state: done ? null : { collections, index, cursor, cleanup: at }, progress: "checking for deleted entries" };
			},
		}),

		"videos/captions/list": readOnlyRoute(definePluginRoute({
			permission: "media:upload",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.captions);
				const { uid } = parseInput(z.object({ uid: uidSchema }), ctx.input);
				const api = await requireClient(ctx);
				return { captions: await stream(() => api.listCaptions(uid)) };
			},
		})),

		"videos/captions/upload": definePluginRoute({
			permission: "media:edit_any",
			methods: ["POST"],
			request: { body: "json", maxBytes: 2 * 1024 * 1024 },
			handler: async (ctx) => {
				await requireFeature(ctx, F.captions);
				const { uid, lang, vtt } = parseInput(z.object({ uid: uidSchema, lang: langSchema, vtt: z.string().min(8).max(MAX_CAPTION_BYTES) }), ctx.input);
				if (utf8Bytes(vtt) > MAX_CAPTION_BYTES) throw PluginRouteError.badRequest("Caption files must be under 1.5 MB.");
				if (!/^﻿?WEBVTT/.test(vtt)) throw PluginRouteError.badRequest("That isn't a WebVTT file (it must start with WEBVTT).");
				const api = await requireClient(ctx);
				await stream(() => api.uploadCaption(uid, lang, vtt));
				await stream(() => refreshCaptions(ctx, uid, api));
				// The video's schema lists its captions and transcript: clear the pages that show it.
				afterResponse(clearVideoPages(ctx, uid));
				return { captions: await stream(() => api.listCaptions(uid)) };
			},
		}),

		"videos/captions/generate": definePluginRoute({
			permission: "media:edit_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.captions);
				const { uid, lang } = parseInput(z.object({ uid: uidSchema, lang: langSchema }), ctx.input);
				const api = await requireClient(ctx);
				await stream(() => api.generateCaption(uid, lang));
				await patchMeta(ctx, uid, { captionsPending: true });
				return { captions: await stream(() => api.listCaptions(uid)) };
			},
		}),

		"videos/captions/delete": definePluginRoute({
			permission: "media:edit_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.captions);
				const { uid, lang } = parseInput(z.object({ uid: uidSchema, lang: langSchema }), ctx.input);
				const api = await requireClient(ctx);
				await stream(() => api.deleteCaption(uid, lang));
				await stream(() => refreshCaptions(ctx, uid, api));
				afterResponse(clearVideoPages(ctx, uid));
				return { captions: await stream(() => api.listCaptions(uid)) };
			},
		}),

		/** Copy the current tracks into the site (for schema and the public caption files). */
		"videos/captions/refresh": definePluginRoute({
			permission: "media:edit_any",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.captions);
				const { uid } = parseInput(z.object({ uid: uidSchema }), ctx.input);
				const meta = await stream(() => refreshCaptions(ctx, uid));
				afterResponse(clearVideoPages(ctx, uid));
				return { meta };
			},
		}),

		"videos/webhook/subscribe": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.webhook);
				const api = await requireClient(ctx);
				const url = ctx.url("/_emdash/api/plugins/coywolf-pack/videos/webhook");
				if (!url.startsWith("https://")) throw PluginRouteError.badRequest(`Stream only calls HTTPS URLs; this site's URL is ${url}.`);
				const result = await stream(() => api.setWebhook(url));
				if (!result?.secret) throw PluginRouteError.internal("Stream didn't return a signing secret.");
				try {
					await ctx.settings.set(SETTINGS.webhookSecret, result.secret);
				} catch {
					await stream(() => api.deleteWebhook());
					throw PluginRouteError.badRequest("Couldn't store the webhook secret. Secret plugin settings need the EMDASH_ENCRYPTION_KEY Worker secret.");
				}
				ctx.log.info("Stream webhook subscribed", { url });
				return { subscribed: true, url };
			},
		}),

		"videos/webhook/unsubscribe": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, F.webhook);
				const api = await requireClient(ctx);
				await stream(() => api.deleteWebhook());
				await ctx.settings.delete(SETTINGS.webhookSecret);
				return { subscribed: false };
			},
		}),

		// ── Public ──────────────────────────────────────────────

		/** Render data for one block (called in-process by the Astro component). */
		"videos/embed": definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 1024 },
			handler: async (ctx) => {
				// Called once per video block on every render: the switches and the player settings
				// come from per-isolate caches; the video's facts are one D1 batch, shared with the
				// page's schema (videoFacts), so a video page reads them once.
				await requireCachedFeature(ctx, F.main);
				const { uid } = parseInput(z.object({ uid: uidSchema }), ctx.input);
				const [facts, features, cfg] = await Promise.all([videoFacts(ctx, [uid], () => publishedUids(ctx)), cachedCtxFeatures(ctx), publicConfig(ctx)]);
				const fact = facts.get(uid);
				// Only videos embedded in published content get metadata (no probing the library
				// by ID, and nothing about videos that are only in drafts).
				const embedded = fact?.published === true;
				const engagement = embedded && isOn(features, F.engagement);
				const meta = embedded ? (fact?.meta ?? null) : null;
				const counts = engagement ? (fact?.counts ?? { plays: 0, likes: 0 }) : null;
				return {
					...cfg,
					engagement,
					video: meta
						? {
								name: meta.name ?? null,
								description: meta.description ?? null,
								duration: meta.duration ?? 0,
								created: meta.created ?? null,
								width: meta.width ?? 0,
								height: meta.height ?? 0,
								posterTime: meta.posterTime ?? null,
								posterImage: meta.posterImage ?? null,
							}
						: null,
					counts,
					watchUrl: watchUrl(cfg.host, uid),
				};
			},
		}),

		"videos/sitemap": definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 1024 },
			handler: async (ctx) => {
				await requireFeature(ctx, F.sitemap);
				return sitemapXml(ctx, ctx.site.url || new URL(ctx.request.url).origin);
			},
		}),

		"videos/caption": definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 1024 },
			handler: async (ctx) => {
				await requireFeature(ctx, F.captions);
				const { uid, lang } = parseInput(z.object({ uid: uidSchema, lang: langSchema }), ctx.input);
				// Like videos/embed, play and like: only videos embedded in published content. A transcript of a video
				// that's only in drafts stays private, even to someone who has its id.
				if (!(await publishedUids(ctx)).has(uid)) throw PluginRouteError.notFound("No such caption track.");
				const doc = await captionStore(ctx).get(`${uid}:${lang}`);
				if (!doc) throw PluginRouteError.notFound("No such caption track.");
				return { vtt: doc.vtt };
			},
		}),

		"videos/play": definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 512, headers: [ENGAGEMENT_HEADER] },
			handler: async (ctx) => {
				await requireCachedFeature(ctx, F.engagement);
				const { uid } = parseInput(z.object({ uid: uidSchema }), ctx.input);
				if (!(await publishedUids(ctx)).has(uid)) throw PluginRouteError.notFound("Unknown video.");
				// The header isn't required here: pages cached before it was added (for days, at the
				// edge) still send plays without it. A play only bumps a counter, and every address
				// is rate limited and counted once per half hour per isolate, header or not.
				// Likes (a stored row per visitor) do require it.
				const visitor = await visitorHash(ctx);
				// No address: plays aren't counted (they'd all be one visitor, see visitorHash).
				if (!visitor) return { plays: ((await statsStore(ctx).get(uid)) ?? { plays: 0 }).plays, counted: false };
				const { hash } = visitor;
				if (!limiter.play(hash) || !(await bindingLets(rateLimiter, `play:${hash}`))) throw rateLimited();
				if (seenRecently(`${uid}:${hash}`)) return { plays: ((await statsStore(ctx).get(uid)) ?? { plays: 0 }).plays, counted: false };
				const counts = await bump(ctx, uid, "plays", 1);
				return { plays: counts.plays, counted: true };
			},
		}),

		"videos/like": definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 512, headers: [ENGAGEMENT_HEADER] },
			handler: async (ctx) => {
				await requireCachedFeature(ctx, F.engagement);
				// Only the Coywolf Video script sends this header, so another site can't like (or
				// unlike) on a visitor's behalf.
				if (!hasEngagementHeader(ctx.request.headers)) throw PluginRouteError.forbidden("Missing the X-Coywolf-Video header.");
				const { uid, liked } = parseInput(z.object({ uid: uidSchema, liked: z.boolean().optional() }), ctx.input);
				if (!(await publishedUids(ctx)).has(uid)) throw PluginRouteError.notFound("Unknown video.");
				const current = async (isLiked: boolean) => ({ likes: ((await statsStore(ctx).get(uid)) ?? { likes: 0 }).likes, liked: isLiked });
				const visitor = await visitorHash(ctx);
				// No address: likes can't be told apart (every visitor would share one), so nothing
				// is stored and the button shows the count without the visitor's like.
				if (!visitor) return current(false);
				const { hash, day } = visitor;
				if (!limiter.like(hash) || !(await bindingLets(rateLimiter, `like:${hash}`))) throw rateLimited();
				const id = await sha256Hex(`${uid}|${hash}`);
				const likes = (ctx.storage as Record<string, import("emdash").StorageCollection<{ uid: string; day: string }>>)[COLLECTIONS.likes];
				const action = likeAction(liked, await likes.exists(id));
				if (action === "keep") return current(Boolean(liked));
				if (action === "remove") {
					if (!(await likes.delete(id))) return current(false);
					const counts = await bump(ctx, uid, "likes", -1);
					return { likes: counts.likes, liked: false };
				}
				// A daily cap on new likes per address: counted in KV (across isolates) and per isolate.
				const capKey = likesByKey(day, hash);
				const given = (await ctx.kv.get<number>(capKey)) ?? 0;
				if (given >= ENGAGEMENT_LIMITS.likesPerDay || !limiter.newLike(hash)) throw rateLimited();
				const created = await likes.compareAndSet(id, null, { uid, day });
				if (!created.applied) return current(true);
				await ctx.kv.set(capKey, given + 1);
				const counts = await bump(ctx, uid, "likes", 1);
				return { likes: counts.likes, liked: true };
			},
		}),

		"videos/webhook": definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "text", maxBytes: 64 * 1024, headers: ["webhook-signature"] },
			handler: async (ctx) => {
				await requireFeature(ctx, F.webhook);
				const secretValue = await ctx.settings.get<string>(SETTINGS.webhookSecret);
				if (!secretValue) throw PluginRouteError.forbidden("The webhook isn't subscribed.");
				const body = typeof ctx.input === "string" ? ctx.input : "";
				if (!(await verifyWebhookSignature(ctx.request.headers.get("webhook-signature"), body, secretValue))) {
					throw PluginRouteError.forbidden("Invalid webhook signature.");
				}
				let uid: unknown = null;
				try {
					uid = (JSON.parse(body) as { uid?: unknown }).uid;
				} catch {
					uid = null;
				}
				await invalidateLibrary(ctx);
				await invalidateSitemap(ctx);
				if (isUid(uid)) {
					try {
						const meta = await refreshVideo(ctx, uid);
						if (meta?.downloadStatus === "inprogress") await refreshDownload(ctx, uid);
						// Only the pages that show this video: the webhook isn't an admin save (no full purge,
						// no settings generation, no re-warm; see src/pageCache/lib.ts purgesAfter).
						afterResponse(clearVideoPages(ctx, uid));
					} catch (error) {
						ctx.log.warn("Videos: webhook refresh failed", { uid, error: String(error) });
					}
				}
				return { ok: true };
			},
		}),
	};

	const hooks = {
		"content:afterSave": (event: { content: Record<string, unknown>; collection: string }, ctx: Ctx) => indexEntry(ctx, event.collection, event.content),
		"content:afterPublish": (event: { content: Record<string, unknown>; collection: string }, ctx: Ctx) => indexEntry(ctx, event.collection, event.content),
		"content:afterUnpublish": (event: { content: Record<string, unknown>; collection: string }, ctx: Ctx) => indexEntry(ctx, event.collection, event.content),
		"content:afterRestore": (event: { content: Record<string, unknown>; collection: string }, ctx: Ctx) => indexEntry(ctx, event.collection, event.content),
		"content:afterDelete": (event: { id: string; collection: string }, ctx: Ctx) => unindexEntry(ctx, event.collection, event.id),
		"page:metadata": pageMetadata,
	};

	const tasks = [
		{
			// MP4 downloads take a while to generate; record the URL (schema contentUrl) once ready.
			name: TASKS.downloads,
			schedule: "@hourly",
			feature: F.main,
			handler: async (ctx: Ctx) => {
				const pending = await metaStore(ctx).query({ where: { downloadStatus: "inprogress" }, limit: 20 });
				if (!pending.items.length) return;
				const api = await client(ctx);
				if (!api) return;
				for (const item of pending.items) {
					try {
						await refreshDownload(ctx, item.id, api);
					} catch (error) {
						ctx.log.warn("Videos: download refresh failed", { uid: item.id, error: String(error) });
					}
				}
				await invalidateSitemap(ctx);
			},
		},
		{
			name: TASKS.captions,
			schedule: "@hourly",
			feature: F.captions,
			handler: async (ctx: Ctx) => {
				const pending = await metaStore(ctx).query({ where: { captionsPending: true }, limit: 10 });
				const api = await client(ctx);
				if (!api) return;
				for (const item of pending.items) {
					try {
						const before = JSON.stringify(item.data.captions ?? []);
						const meta = await refreshCaptions(ctx, item.id, api);
						// Generated captions arrived (or changed): the pages that show the video list them in their schema.
						if (meta && JSON.stringify(meta.captions ?? []) !== before) await clearVideoPages(ctx, item.id);
					} catch (error) {
						ctx.log.warn("Videos: caption refresh failed", { uid: item.id, error: String(error) });
					}
				}
			},
		},
		{
			name: TASKS.likes,
			schedule: "@daily",
			feature: F.engagement,
			handler: async (ctx: Ctx) => {
				// Like rows only dedupe within a day (the visitor hash rotates daily); drop old ones.
				const cutoff = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
				const likes = (ctx.storage as Record<string, import("emdash").StorageCollection<unknown>>)[COLLECTIONS.likes];
				for (let i = 0; i < 50; i++) {
					const old = await likes.query({ where: { day: { lt: cutoff } }, limit: 90 });
					if (!old.items.length) break;
					await likes.deleteMany(old.items.map((x) => x.id));
				}
				// And the per-address daily like counts from before then.
				for (const { key } of await ctx.kv.list(LIKES_BY_PREFIX)) if (staleLikesByKey(key, cutoff)) await ctx.kv.delete(key);
			},
		},
	];

	return { routes, hooks, tasks };
}

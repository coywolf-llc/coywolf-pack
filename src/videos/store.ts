/**
 * Videos module storage: settings, the Stream library cache, per-video
 * metadata, play/like counters and the embed index (which entries embed
 * which videos).
 */
import { STORAGE_IN_LIMIT, deleteManyBatched, getManyBatched } from "../core/storage.js";
import type { PluginContext, StorageCollection } from "emdash";

import { contextFetch } from "../core/cloudflare-api.js";
import { UNREADABLE_TOKEN_MESSAGE, cloudflareAccountId, cloudflareToken, noAccountMessage, noTokenMessage, sharedTokenState } from "../core/cloudflare-token.js";
import { PLUGIN_ID, isCurrent, readSiteSetting, registerSiteSetting, settingsEpoch } from "../core/features.js";
import { batchedAll } from "../core/d1-batch.js";
import { peekRequestMemo, seedRequestMemo } from "../core/request-memo.js";
import { secret, workerEnv } from "../shared.js";
import {
	type VideoFacts,
	type VideoRef,
	customerHostFromUrl,
	isHex,
	MAX_CAPTION_BYTES,
	isUid,
	normalizeCustomerHost,
	parseTags,
	utf8Bytes,
	vttToTranscript,
} from "./lib.js";
import { type VideoDisplay, normalizeDisplay } from "./render.js";
import { type StreamClient, type StreamCredentials, type StreamVideo, streamClient } from "./stream.js";

export const COLLECTIONS = {
	meta: "videosMeta",
	stats: "videosStats",
	likes: "videosLikes",
	embeds: "videosEmbeds",
	captions: "videosCaptions",
} as const;

export const STORAGE = {
	[COLLECTIONS.meta]: { indexes: ["captionsPending", "downloadStatus"] },
	[COLLECTIONS.stats]: { indexes: [] },
	[COLLECTIONS.likes]: { indexes: ["day"] },
	[COLLECTIONS.embeds]: { indexes: ["status", "collection"] },
	[COLLECTIONS.captions]: { indexes: ["uid"] },
};

export const SETTINGS = {
	accountId: "videosAccountId",
	token: "videosApiToken",
	host: "videosCustomerSubdomain",
	accent: "videosAccentColor",
	background: "videosBackgroundColor",
	webhookSecret: "videosWebhookSecret",
	/** Poster first, player when needed (default on; false loads the player with the page). */
	lightEmbed: "videosLightEmbed",
	/** Views & likes and Appearance (one object, see render.ts VideoDisplay). */
	display: "videosDisplay",
	/** Tags added to every upload (comma-separated). */
	defaultTags: "videosDefaultTags",
} as const;

/**
 * The older Stream token and the webhook secret are declared secret in the
 * plugin's settingsSchema (src/core/secrets.ts); the account ID and player
 * settings are plain values edited on the Videos page → Settings, read with
 * fallbacks. The token is the Cloudflare API token when there is one
 * (src/core/cloudflare-token.ts).
 */

export type Ctx = PluginContext;

const coll = <T>(ctx: Ctx, name: string) => (ctx.storage as Record<string, StorageCollection<T>>)[name];

// ── Settings ─────────────────────────────────────────────────────

export interface PublicConfig {
	host: string | null;
	accent: string | null;
	background: string | null;
	/** Show the poster and load Stream's player only when it's needed. */
	lightEmbed: boolean;
	/** What blocks show by default, and how the figure looks. */
	display: VideoDisplay;
}

let publicCache: { value: PublicConfig; at: number; epoch: number } | null = null;
/** Kept until a pack settings save (here or in another isolate) or ten minutes. */
const PUBLIC_TTL = 10 * 60_000;
/** The player settings public pages need, read with the feature switches (no query of their own). */
const PUBLIC_SETTINGS = [SETTINGS.host, SETTINGS.accent, SETTINGS.background, SETTINGS.lightEmbed, SETTINGS.display] as const;
for (const key of PUBLIC_SETTINGS) registerSiteSetting(key);

export function invalidatePublicConfig(): void {
	publicCache = null;
}

const HOST_KEY = "state:videos:customerHost";

/** The player and display settings: from the switches' cached query, else one read each through the plugin context. */
async function playerSettings(ctx: Ctx): Promise<Array<unknown>> {
	const shared = await Promise.all(PUBLIC_SETTINGS.map((key) => readSiteSetting(key).catch(() => null)));
	if (shared.every(Boolean)) return shared.map((read) => read?.value ?? null);
	return Promise.all(PUBLIC_SETTINGS.map((key) => ctx.settings.get<unknown>(key)));
}

/** Player settings safe to use on public pages (cached per isolate until settings change, ten minutes at most). */
export async function publicConfig(ctx: Ctx): Promise<PublicConfig> {
	if (publicCache && isCurrent(publicCache, PUBLIC_TTL)) return publicCache.value;
	const epoch = settingsEpoch();
	const [host, accent, background, lightEmbed, display] = await playerSettings(ctx);
	const value: PublicConfig = {
		host: normalizeCustomerHost(host as string | null) ?? normalizeCustomerHost(await ctx.kv.get<string>(HOST_KEY)),
		accent: isHex(accent) ? accent : null,
		background: isHex(background) ? background : null,
		lightEmbed: lightEmbed !== false,
		display: normalizeDisplay(display),
	};
	if (epoch === settingsEpoch()) publicCache = { value, at: Date.now(), epoch };
	return value;
}

/** Remember the customer host seen in Stream's own URLs when none is configured. */
async function learnHost(ctx: Ctx, videos: StreamVideo[]): Promise<void> {
	for (const v of videos) {
		const host = customerHostFromUrl(v.thumbnail) ?? customerHostFromUrl(v.preview) ?? customerHostFromUrl(v.playback?.hls);
		if (!host) continue;
		if ((await ctx.kv.get<string>(HOST_KEY)) !== host) {
			await ctx.kv.set(HOST_KEY, host);
			invalidatePublicConfig();
		}
		return;
	}
}

/**
 * Stream's token and account: the Cloudflare API token (else the older Stream token, else CF_STREAM_TOKEN, else
 * CLOUDFLARE_API_TOKEN), and the account saved on the Videos page, else CF_ACCOUNT_ID, else the token's own.
 * `reason` says what's missing until both are known (a saved token that can't be decrypted, no token, no
 * account). `bindings` replaces the Worker's env (tests).
 */
export async function streamAccess(ctx: Ctx, bindings?: Record<string, unknown>): Promise<{ credentials: StreamCredentials } | { credentials: null; reason: string }> {
	const env = bindings ?? (await workerEnv().catch(() => ({}) as Record<string, unknown>));
	const [accountId, { token, unreadable }] = await Promise.all([ctx.settings.get<string>(SETTINGS.accountId), cloudflareToken(ctx, env, "stream")]);
	if (!token) return { credentials: null, reason: unreadable ? UNREADABLE_TOKEN_MESSAGE : noTokenMessage("Stream → Edit") };
	const a = await cloudflareAccountId(ctx, env, { token, fetch: contextFetch(ctx) }, accountId);
	return a ? { credentials: { accountId: a, token } } : { credentials: null, reason: noAccountMessage("Videos → Settings → Advanced") };
}

/** Stream's token and account, or null until both are known (streamAccess says why). */
export async function credentials(ctx: Ctx, bindings?: Record<string, unknown>): Promise<StreamCredentials | null> {
	return (await streamAccess(ctx, bindings)).credentials;
}

/** The saved settings for the Videos page's Settings tab (the token only as set / not set). */
export async function adminSettings(ctx: Ctx) {
	const [accountId, token, host, accent, background, lightEmbed, display, defaultTags] = await Promise.all([
		ctx.settings.get<string>(SETTINGS.accountId),
		ctx.settings.get<string>(SETTINGS.token).catch(() => null),
		ctx.settings.get<string>(SETTINGS.host),
		ctx.settings.get<string>(SETTINGS.accent),
		ctx.settings.get<string>(SETTINGS.background),
		ctx.settings.get<boolean>(SETTINGS.lightEmbed),
		ctx.settings.get<unknown>(SETTINGS.display),
		ctx.settings.get<string>(SETTINGS.defaultTags),
	]);
	let env: Record<string, unknown> = {};
	try {
		env = await workerEnv();
	} catch {
		env = {};
	}
	return {
		accountId: accountId ?? "",
		tokenSet: Boolean(token?.trim()),
		/** The Cloudflare API token is the one in use: the page shows no token field of its own. */
		...sharedTokenState(await cloudflareToken(ctx, env, "stream")),
		customerSubdomain: host ?? "",
		accentColor: accent ?? "",
		backgroundColor: background ?? "",
		lightEmbed: lightEmbed !== false,
		display: normalizeDisplay(display),
		defaultTags: defaultTags ?? "",
		/** Worker variables used when the settings are empty. */
		envAccountId: Boolean(secret(env, "CF_ACCOUNT_ID")),
		envToken: Boolean(secret(env, "CF_STREAM_TOKEN")),
	};
}

export async function client(ctx: Ctx): Promise<StreamClient | null> {
	const creds = await credentials(ctx);
	return creds ? streamClient(creds) : null;
}

// ── Library cache ────────────────────────────────────────────────

export interface LibraryVideo {
	uid: string;
	name: string;
	duration: number;
	created: string | null;
	width: number;
	height: number;
	state: string;
	ready: boolean;
	size: number;
	allowedOrigins: string[];
	/** From Stream's meta.tags (Video Manager's tags). */
	tags: string[];
	creator: string;
	meta: Record<string, unknown>;
}

const LIST_KEY = "cache:videos:list:v2";
const LIST_TTL = 5 * 60_000;
let listMemo: { items: LibraryVideo[]; at: number } | null = null;

export async function invalidateLibrary(ctx: Ctx): Promise<void> {
	listMemo = null;
	await ctx.kv.delete(LIST_KEY);
}

function slim(v: StreamVideo): LibraryVideo {
	const name = typeof v.meta?.name === "string" && v.meta.name ? (v.meta.name as string) : v.uid;
	return {
		uid: v.uid,
		name,
		duration: typeof v.duration === "number" && v.duration > 0 ? v.duration : 0,
		created: v.created ?? null,
		width: v.input?.width ?? 0,
		height: v.input?.height ?? 0,
		state: v.status?.state ?? "unknown",
		ready: v.readyToStream === true,
		size: v.size ?? 0,
		allowedOrigins: v.allowedOrigins ?? [],
		tags: parseTags(v.meta?.tags),
		creator: typeof v.creator === "string" ? v.creator : "",
		meta: v.meta ?? {},
	};
}

/** The Stream library: isolate memory → plugin KV (5 minutes) → one Stream API call. */
export async function library(ctx: Ctx, force = false): Promise<LibraryVideo[]> {
	if (!force && listMemo && Date.now() - listMemo.at < LIST_TTL) return listMemo.items;
	if (!force) {
		const cached = await ctx.kv.get<{ items: LibraryVideo[]; at: number }>(LIST_KEY);
		if (cached && Date.now() - cached.at < LIST_TTL) {
			listMemo = cached;
			return cached.items;
		}
	}
	const api = await client(ctx);
	if (!api) {
		const access = await streamAccess(ctx);
		throw new Error(`Connect Cloudflare Stream first. ${"reason" in access ? access.reason : ""}`.trim());
	}
	const videos = await api.list();
	await learnHost(ctx, videos);
	const items = videos.map(slim);
	listMemo = { items, at: Date.now() };
	await ctx.kv.set(LIST_KEY, listMemo);
	await syncMeta(ctx, items);
	return items;
}

// ── Per-video metadata ───────────────────────────────────────────

export interface VideoMeta extends VideoFacts {
	ready?: boolean;
	allowedOrigins?: string[];
	downloadStatus?: string;
	captionsPending?: boolean;
	captionsChecked?: string;
	updatedAt?: string;
}

export const metaStore = (ctx: Ctx) => coll<VideoMeta>(ctx, COLLECTIONS.meta);

const SYNCED: Array<keyof VideoMeta> = ["name", "duration", "created", "width", "height", "ready"];

function fromLibrary(v: LibraryVideo): Partial<VideoMeta> {
	return { name: v.name, duration: v.duration, created: v.created ?? undefined, width: v.width, height: v.height, ready: v.ready, allowedOrigins: v.allowedOrigins };
}

/** Write Stream's facts into the metadata docs that changed (one read, at most one batched write). */
async function syncMeta(ctx: Ctx, items: LibraryVideo[]): Promise<void> {
	const store = metaStore(ctx);
	for (let i = 0; i < items.length; i += STORAGE_IN_LIMIT) {
		const chunk = items.slice(i, i + STORAGE_IN_LIMIT);
		const existing = await store.getMany(chunk.map((v) => v.uid));
		const changed: Array<{ id: string; data: VideoMeta }> = [];
		for (const v of chunk) {
			const prev = existing.get(v.uid);
			const next = { ...(prev ?? { uid: v.uid }), ...fromLibrary(v), uid: v.uid } as VideoMeta;
			if (!prev || SYNCED.some((k) => prev[k] !== next[k])) changed.push({ id: v.uid, data: { ...next, updatedAt: new Date().toISOString() } });
		}
		if (changed.length) await store.putMany(changed);
	}
}

/** Re-read one video from Stream into its metadata doc. */
export async function refreshVideo(ctx: Ctx, uid: string, api?: StreamClient | null): Promise<VideoMeta | null> {
	const stream = api ?? (await client(ctx));
	if (!stream || !isUid(uid)) return null;
	const video = await stream.get(uid);
	if (!video) return null;
	await learnHost(ctx, [video]);
	const store = metaStore(ctx);
	const prev = await store.get(uid);
	const next: VideoMeta = { ...(prev ?? { uid }), ...fromLibrary(slim(video)), uid, updatedAt: new Date().toISOString() };
	await store.put(uid, next);
	return next;
}

export async function patchMeta(ctx: Ctx, uid: string, patch: Partial<VideoMeta>): Promise<VideoMeta> {
	const store = metaStore(ctx);
	const prev = (await store.get(uid)) ?? { uid };
	const next: VideoMeta = { ...prev, ...patch, uid, updatedAt: new Date().toISOString() };
	for (const [k, v] of Object.entries(next)) if (v === undefined || v === null || v === "") delete (next as unknown as Record<string, unknown>)[k];
	next.uid = uid;
	await store.put(uid, next);
	return next;
}

/** Check a pending MP4 download and record its URL once Stream has it ready. */
export async function refreshDownload(ctx: Ctx, uid: string, api?: StreamClient | null): Promise<VideoMeta | null> {
	const stream = api ?? (await client(ctx));
	if (!stream) return null;
	let d: { status?: string; url?: string } | undefined;
	try {
		d = (await stream.getDownloads(uid))?.default;
	} catch (error) {
		if ((error as { status?: number }).status === 404) return patchMeta(ctx, uid, { downloadStatus: undefined, downloadUrl: undefined });
		throw error;
	}
	if (!d) return patchMeta(ctx, uid, { downloadStatus: undefined, downloadUrl: undefined });
	return patchMeta(ctx, uid, { downloadStatus: d.status, downloadUrl: d.status === "ready" ? d.url : undefined });
}

// ── Captions cache ───────────────────────────────────────────────

export interface CaptionDoc {
	uid: string;
	language: string;
	label: string;
	vtt: string;
}

export const captionStore = (ctx: Ctx) => coll<CaptionDoc>(ctx, COLLECTIONS.captions);

/** Copy a video's ready caption tracks (and a transcript) from Stream, so public pages never call the API. */
export async function refreshCaptions(ctx: Ctx, uid: string, api?: StreamClient | null): Promise<VideoMeta | null> {
	const stream = api ?? (await client(ctx));
	if (!stream) return null;
	const list = await stream.listCaptions(uid);
	const ready = list.filter((c) => (c.status ?? "ready") === "ready" && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(c.language)).slice(0, 10);
	const pending = list.some((c) => c.status === "inprogress");
	const store = captionStore(ctx);
	const docs: CaptionDoc[] = [];
	for (const c of ready) {
		try {
			const vtt = await stream.captionVtt(uid, c.language);
			if (utf8Bytes(vtt) > MAX_CAPTION_BYTES) {
				ctx.log.warn("Videos: caption track too large to copy, skipped", { uid, language: c.language, bytes: utf8Bytes(vtt) });
				continue;
			}
			docs.push({ uid, language: c.language, label: c.label || c.language, vtt });
		} catch (error) {
			ctx.log.warn("Videos: caption download failed", { uid, language: c.language, error: String(error) });
		}
	}
	const old = await store.query({ where: { uid }, limit: 50 });
	const keep = new Set(docs.map((d) => `${uid}:${d.language}`));
	const stale = old.items.map((i) => i.id).filter((id) => !keep.has(id));
	if (stale.length) await deleteManyBatched(store, stale);
	if (docs.length) await store.putMany(docs.map((d) => ({ id: `${uid}:${d.language}`, data: d })));
	const preferred = docs.find((d) => d.language.toLowerCase().startsWith((ctx.site.locale || "en").slice(0, 2).toLowerCase())) ?? docs[0];
	return patchMeta(ctx, uid, {
		captions: docs.map((d) => ({ language: d.language, label: d.label })),
		transcript: preferred ? vttToTranscript(preferred.vtt).slice(0, 50_000) : undefined,
		captionsPending: pending || undefined,
		captionsChecked: new Date().toISOString(),
	});
}

// ── Counters ─────────────────────────────────────────────────────

export interface Counts {
	plays: number;
	likes: number;
}

export const statsStore = (ctx: Ctx) => coll<Counts>(ctx, COLLECTIONS.stats);

/** Atomically add to a counter, creating the row on first use. */
export async function bump(ctx: Ctx, uid: string, field: keyof Counts, by: 1 | -1): Promise<Counts> {
	const store = statsStore(ctx);
	const args = by > 0 ? { where: {}, delta: { [field]: { inc: 1 } } } : { where: { [field]: { gte: 1 } }, delta: { [field]: { dec: 1 } } };
	for (let attempt = 0; attempt < 3; attempt++) {
		const r = await store.updateIf(uid, args as Parameters<typeof store.updateIf>[1]);
		if (r.applied) return r.data;
		if (by < 0) return (await store.get(uid)) ?? { plays: 0, likes: 0 };
		const init: Counts = { plays: 0, likes: 0, [field]: 1 };
		const c = await store.compareAndSet(uid, null, init);
		if (c.applied) return init;
	}
	return (await store.get(uid)) ?? { plays: 0, likes: 0 };
}

export async function countsFor(ctx: Ctx, uids: string[]): Promise<Map<string, Counts>> {
	const out = new Map<string, Counts>();
	const store = statsStore(ctx);
	for (const [k, v] of await getManyBatched(store, uids)) out.set(k, v);
	return out;
}

/** What a page render needs about one video. */
export interface PageVideoFacts {
	/** Embedded in a published entry (public routes only answer for these). */
	published: boolean;
	meta: VideoMeta | null;
	counts: Counts | null;
}

const factsKey = (uid: string) => `coywolf-video-facts:${uid}`;

/** One D1 batch for many videos: their metadata and counters, and which are embedded in published entries. */
async function readFactsD1(db: D1Database, uids: string[]): Promise<Map<string, PageVideoFacts>> {
	const marks = uids.map(() => "?").join(",");
	// Both go out with the page's other pack reads of this tick (one D1 batch).
	const [docs, published] = await Promise.all([
		batchedAll<{ collection: string; id: string; data: string | null }>(
			db,
			db
				.prepare(`SELECT collection, id, data FROM _plugin_storage WHERE plugin_id = ? AND collection IN (?, ?) AND id IN (${marks})`)
				.bind(PLUGIN_ID, COLLECTIONS.meta, COLLECTIONS.stats, ...uids),
		),
		batchedAll<{ uid: string }>(
			db,
			db
				.prepare(
					`SELECT DISTINCT j.value AS uid FROM _plugin_storage AS s, json_each(s.data, '$.uids') AS j WHERE s.plugin_id = ? AND s.collection = ? AND json_extract(s.data, '$.status') = 'published' AND j.value IN (${marks})`,
				)
				.bind(PLUGIN_ID, COLLECTIONS.embeds, ...uids),
		),
	]);
	const out = new Map<string, PageVideoFacts>(uids.map((uid) => [uid, { published: false, meta: null, counts: null }]));
	for (const row of docs) {
		const facts = out.get(row.id);
		if (!facts || !row.data) continue;
		try {
			if (row.collection === COLLECTIONS.meta) facts.meta = JSON.parse(row.data) as VideoMeta;
			else facts.counts = JSON.parse(row.data) as Counts;
		} catch {
			// An unreadable doc reads as missing.
		}
	}
	for (const row of published) {
		const facts = out.get(row.uid);
		if (facts) facts.published = true;
	}
	return out;
}

async function readFactsCtx(ctx: Ctx, uids: string[], publishedUids: () => Promise<Set<string>>): Promise<Map<string, PageVideoFacts>> {
	const [published, meta, counts] = await Promise.all([publishedUids(), getManyBatched(metaStore(ctx), uids), getManyBatched(statsStore(ctx), uids)]);
	return new Map(uids.map((uid) => [uid, { published: published.has(uid), meta: meta.get(uid) ?? null, counts: counts.get(uid) ?? null }]));
}

/**
 * Facts about these videos for a page render, shared within the request: the
 * page:metadata hook (VideoObject schema) and every Coywolf Video block on
 * the page (the videos/embed route) read each video once, in one D1 batch
 * for all the videos asked for together. `publishedUids` is the fallback
 * check when there's no D1 binding.
 */
export async function videoFacts(ctx: Ctx, uids: string[], publishedUids: () => Promise<Set<string>>): Promise<Map<string, PageVideoFacts>> {
	const unique = [...new Set(uids)].slice(0, STORAGE_IN_LIMIT);
	const pending = new Map<string, Promise<PageVideoFacts>>();
	const missing: string[] = [];
	for (const uid of unique) {
		const hit = peekRequestMemo<PageVideoFacts>(factsKey(uid));
		if (hit) pending.set(uid, hit);
		else missing.push(uid);
	}
	if (missing.length) {
		const batch = (async () => {
			let db: D1Database | undefined;
			try {
				db = (await workerEnv()).DB as D1Database | undefined;
			} catch {
				db = undefined; // Not on Workers.
			}
			if (db && typeof db.prepare === "function") {
				try {
					return await readFactsD1(db, missing);
				} catch (error) {
					ctx.log?.warn?.("Videos: batched read failed; reading one by one", { error: String(error) });
				}
			}
			return readFactsCtx(ctx, missing, publishedUids);
		})();
		for (const uid of missing) {
			const one = batch.then((m) => m.get(uid) as PageVideoFacts);
			seedRequestMemo(factsKey(uid), one);
			pending.set(uid, one);
		}
	}
	const entries = [...pending];
	const values = await Promise.all(entries.map(([, facts]) => facts));
	return new Map(entries.map(([uid], i) => [uid, values[i]]));
}

export async function metaFor(ctx: Ctx, uids: string[]): Promise<Map<string, VideoMeta>> {
	const out = new Map<string, VideoMeta>();
	const store = metaStore(ctx);
	for (const [k, v] of await getManyBatched(store, uids)) out.set(k, v);
	return out;
}

// ── Embed index ──────────────────────────────────────────────────

export interface EmbedEntry {
	collection: string;
	entryId: string;
	slug: string | null;
	status: string;
	title: string | null;
	url: string | null;
	publishedAt: string | null;
	updatedAt: string | null;
	uids: string[];
	videos: VideoRef[];
}

export const embedStore = (ctx: Ctx) => coll<EmbedEntry>(ctx, COLLECTIONS.embeds);
export const embedKey = (collection: string, id: string) => `${collection}:${id}`;

/** Keyed on the settings epoch too: a reindex (a pack admin save) in another isolate reaches this one with the settings generation. */
let embedsMemo: { items: EmbedEntry[]; at: number; epoch: number } | null = null;
const EMBEDS_TTL = 60_000;

export function invalidateEmbeds(): void {
	embedsMemo = null;
}

/** Every indexed entry (paged through plugin storage; cached per isolate for a minute). */
export async function allEmbeds(ctx: Ctx): Promise<EmbedEntry[]> {
	if (embedsMemo && isCurrent(embedsMemo, EMBEDS_TTL)) return embedsMemo.items;
	const epoch = settingsEpoch();
	const store = embedStore(ctx);
	const items: EmbedEntry[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 200; page++) {
		const res = await store.query({ limit: 100, ...(cursor ? { cursor } : {}) });
		items.push(...res.items.map((i) => i.data));
		if (!res.hasMore || !res.cursor) break;
		cursor = res.cursor;
	}
	if (epoch === settingsEpoch()) embedsMemo = { items, at: Date.now(), epoch };
	return items;
}

// ── Sitemap cache ────────────────────────────────────────────────

export const SITEMAP_KEY = "cache:videos:sitemap";

export async function invalidateSitemap(ctx: Ctx): Promise<void> {
	await ctx.kv.delete(SITEMAP_KEY);
}

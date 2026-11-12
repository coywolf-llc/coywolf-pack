/**
 * WordPress import module: finishes a WordPress → EmDash move. EmDash's own
 * importer has no plugin hook, so this works around what it drops or misses.
 *
 * - While on, every save (including each entry EmDash's WordPress importer
 *   creates) runs the converter (./convert.ts), so a prepared export
 *   (./prepare.ts) imports straight into native blocks: heading ids, core
 *   Details, and blocks from Coywolf's WordPress plugins. It runs before
 *   Headings & TOC, so imported heading ids become the headings' anchors.
 * - "Convert imported content" scans every entry (dry run first) and converts
 *   what's already in the database, draft-aware, never overwriting an entry
 *   that changed while it ran. Given a URL map (./urls.ts), the same scan
 *   rewrites old `/wp-content/` URLs to media library files.
 * - "Find old-site URLs" lists every `/wp-content/` URL of the old site left
 *   in content, for the WordPress import page to map, import and redirect.
 * - Video facts from WordPress (name, length, upload date, size) fill the
 *   Videos module's per-video data where it has none, so players size
 *   correctly and VideoObject schema has a duration without a Stream token.
 * - Coywolf plugins: Coywolf Files records and Video Manager library data
 *   (descriptions, posters, MP4 links) can be imported from WordPress's
 *   database.
 */
import type { PluginContext, StorageCollection } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, isOn, registerFeatures, requireFeature } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { COLLECTIONS as FILE_COLLECTIONS, type UploadDoc, invalidateSiteCache } from "../files/site.js";
import { WORDPRESS_FILE_ID } from "../files/format.js";
import { latestData } from "../links/store.js";
import { parseInput } from "../shared.js";
import { type VideoMeta, invalidatePublicConfig, metaStore, SETTINGS as VIDEO_SETTINGS } from "../videos/store.js";
import { type ConvertOptions, type VideoFact, convertEntryData, mightNeedConversion } from "./convert.js";
import { type ImportDefaults, defaultsFromWordPress, parseFileRows } from "./sources.js";
import { findSiteUrls, rewriteSiteUrls, siteUrlPattern } from "./urls.js";
import { readOnlyRoute } from "../core/routes.js";
import { isConflict } from "../core/conflict.js";
import { imageCdn } from "../images/lib.js";
import { refreshMediaHost } from "../images/settings.js";

export const F = { main: "wpImport" } as const;

const FEATURES = [
	{
		id: F.main,
		label: "WordPress Migration",
		description:
			"Tools to finish a move from WordPress: keep heading ids, reusable blocks and Details blocks, credit co-authors and guest authors, restore category and page parents, point old /wp-content/ URLs at the media library, and bring over redirects. Blocks from Coywolf's WordPress plugins become Coywolf Pack blocks as content is imported or saved.",
		default: false,
	},
];
registerFeatures(FEATURES);

export const DEFAULTS_SETTING = "wpImportDefaults";

function normalizeDefaults(value: unknown): ImportDefaults {
	if (!value || typeof value !== "object") return {};
	const v = value as ImportDefaults;
	return { video: v.video && typeof v.video === "object" ? v.video : undefined, files: v.files && typeof v.files === "object" ? v.files : undefined };
}

async function convertOptions(ctx: PluginContext): Promise<ConvertOptions> {
	const d = normalizeDefaults(await ctx.settings.get(DEFAULTS_SETTING));
	const features = await ctxFeatures(ctx);
	// Custom Blocks that are off aren't converted to: their markers stay HTML until the block is turned on.
	const customBlocks = {
		note: isOn(features, "customBlocks.note"),
		details: isOn(features, "customBlocks.details"),
		disclosure: isOn(features, "customBlocks.disclosure"),
		quote: isOn(features, "customBlocks.quote"),
		testimonial: isOn(features, "customBlocks.testimonial"),
		podcast: isOn(features, "customBlocks.podcast"),
	};
	return { videoDefaults: d.video, fileDefaults: d.files, customBlocks };
}

// ── Video facts ──────────────────────────────────────────────────

/**
 * Fill in the Videos module's per-video data from WordPress where it has
 * none. Stream's own data (library refresh, webhook) replaces it later.
 * Returns how many videos were added.
 */
async function seedVideos(ctx: PluginContext, facts: VideoFact[]): Promise<number> {
	const store = (ctx.storage as Record<string, StorageCollection<VideoMeta> | undefined>).videosMeta ? metaStore(ctx) : null;
	if (!store || !facts.length) return 0;
	const byUid = new Map<string, VideoFact>();
	for (const f of facts) byUid.set(f.uid, { ...byUid.get(f.uid), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) } as VideoFact);
	const uids = [...byUid.keys()].slice(0, 50);
	const existing = await store.getMany(uids);
	const add: Array<{ id: string; data: VideoMeta }> = [];
	let host: string | undefined;
	for (const uid of uids) {
		const fact = byUid.get(uid) as VideoFact;
		host ??= fact.host;
		if (existing.has(uid)) continue;
		const doc: VideoMeta = { uid, updatedAt: new Date().toISOString() };
		if (fact.name) doc.name = fact.name;
		if (fact.duration) doc.duration = fact.duration;
		if (fact.created) doc.created = fact.created;
		if (fact.width && fact.height) {
			doc.width = fact.width;
			doc.height = fact.height;
		}
		add.push({ id: uid, data: doc });
	}
	if (add.length) await store.putMany(add);
	// The customer subdomain, when the Videos page hasn't learned one yet.
	if (host && !(await ctx.settings.get<string>(VIDEO_SETTINGS.host))) {
		await ctx.settings.set(VIDEO_SETTINGS.host, host);
		invalidatePublicConfig();
	}
	return add.length;
}

// ── Save hook ────────────────────────────────────────────────────

export async function beforeSave(event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) {
	if (!event.content || !mightNeedConversion(event.content)) return undefined;
	const result = convertEntryData(event.content, await convertOptions(ctx));
	if (result.videos.length) {
		try {
			await seedVideos(ctx, result.videos);
		} catch (error) {
			ctx.log.warn("WordPress import: could not record video details", { error: String(error) });
		}
	}
	if (!result.changed) return undefined;
	ctx.log.info("WordPress import: converted blocks", { collection: event.collection, changes: result.changes.length });
	return result.value;
}

// ── Converting stored content ────────────────────────────────────

interface ScanState {
	collections: string[];
	index: number;
	cursor: string | null;
}

export interface ScanEntry {
	collection: string;
	id: string;
	title: string;
	status: string;
	/** "coywolf-video" → 2, "anchor" → 14, … */
	changes: Record<string, number>;
	result?: "updated" | "published" | "draft" | "conflict" | "failed";
	error?: string;
}

const stateInput = z.object({ collections: z.array(z.string().max(100)).max(200), index: z.number().int().min(0), cursor: z.string().max(2000).nullable() }).nullish();

const scanInput = z.object({
	apply: z.boolean(),
	state: stateInput,
	/** Old-site URL → media library URL, to rewrite in content (see ./urls.ts). */
	urlMap: z.record(z.string().max(2000), z.string().max(2000)).optional(),
	/** Point the site's own media file URLs inside HTML (/_emdash/api/media/file/<key>) at the media host. */
	mediaHost: z.boolean().optional(),
});

const findInput = z.object({
	hosts: z.array(z.string().max(253)).max(50),
	prefixes: z.array(z.string().max(200).regex(/^(?:\/[\w.~-]+){1,3}$/)).max(5).optional(),
	state: stateInput,
});

/** Rewrite mapped URLs in an entry's Portable Text and text fields (media fields are left to EmDash). */
function rewriteEntryUrls(data: Record<string, unknown>, urlMap: Record<string, string>): { value: Record<string, unknown>; count: number } {
	let out: Record<string, unknown> | null = null;
	let count = 0;
	for (const [field, value] of Object.entries(data)) {
		if (typeof value !== "string" && !Array.isArray(value)) continue;
		const r = rewriteSiteUrls(value, urlMap);
		if (!r.count) continue;
		out ??= { ...data };
		out[field] = r.value;
		count += r.count;
	}
	return { value: out ?? data, count };
}

/**
 * The site's own media file URLs (/_emdash/api/media/file/<key>, relative or absolute on `origin`) in an entry's
 * text and Portable Text fields, pointed at the media host: inside HTML blocks and other blocks' HTML or URL
 * strings (a converted How-To step's image src, a Details block's body). The key is kept verbatim (R2 keys are
 * case-sensitive). Left alone: code blocks (example code), image and file blocks' `asset` (EmDash's media usage
 * tracking reads it), link `markDefs`, and media fields (objects: callers pass only string and array fields).
 */
export function rewriteSiteMediaUrls<T>(value: T, origin: string | null, toHost: (key: string) => string | null): { value: T; count: number } {
	let count = 0;
	const site = origin ? origin.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
	// The site's own origin, or a site path (not preceded by another host's name).
	const re = new RegExp(`(?:${site ? `${site}|` : ""}(?<![\\w.:/-]))\\/_emdash\\/api\\/media\\/file\\/([A-Za-z0-9._~%-]+(?:\\/[A-Za-z0-9._~%-]+)*)`, "g");
	const SKIP_KEYS = new Set(["asset", "markDefs", "_ref"]);
	const walk = (v: unknown, depth: number): unknown => {
		if (depth > 40) return v;
		if (typeof v === "string") {
			if (!v.includes("/_emdash/api/media/file/")) return v;
			return v.replace(re, (match, key: string) => {
				const to = toHost(key);
				if (!to || to === match) return match;
				count++;
				return to;
			});
		}
		if (Array.isArray(v)) {
			let out: unknown[] | null = null;
			v.forEach((item, i) => {
				const next = walk(item, depth + 1);
				if (next !== item) (out ??= v.slice())[i] = next;
			});
			return out ?? v;
		}
		if (v && typeof v === "object") {
			if ((v as { _type?: unknown })._type === "code") return v;
			let out: Record<string, unknown> | null = null;
			for (const [k, item] of Object.entries(v)) {
				if (SKIP_KEYS.has(k)) continue;
				const next = walk(item, depth + 1);
				if (next !== item) (out ??= { ...(v as Record<string, unknown>) })[k] = next;
			}
			return out ?? v;
		}
		return v;
	};
	return { value: walk(value, 0) as T, count };
}

/** rewriteSiteMediaUrls on an entry's string and array fields only (media fields are objects, read by EmDash's usage tracking). */
function rewriteEntryMediaHost(data: Record<string, unknown>, origin: string | null, toHost: (key: string) => string | null): { value: Record<string, unknown>; count: number } {
	let out: Record<string, unknown> | null = null;
	let count = 0;
	for (const [field, value] of Object.entries(data)) {
		if (typeof value !== "string" && !Array.isArray(value)) continue;
		const r = rewriteSiteMediaUrls(value, origin, toHost);
		if (!r.count) continue;
		out ??= { ...data };
		out[field] = r.value;
		count += r.count;
	}
	return { value: out ?? data, count };
}

type Content = NonNullable<PluginContext["content"]>;
type Writable = Content & Required<Pick<Content, "update">>;

const versionOf = (item: { version?: number; updatedAt?: string; draftRevisionId?: string | null }) =>
	`${item.version ?? ""}|${item.updatedAt ?? ""}|${item.draftRevisionId ?? ""}`;

const PAGE_MS = 12_000;

async function scan(ctx: PluginContext, apply: boolean, state: ScanState | null, urlMap: Record<string, string> | null = null, mediaHost = false) {
	if (!ctx.content || !ctx.schema) throw PluginRouteError.internal("Content access is unavailable.");
	if (apply && !ctx.content.update) throw PluginRouteError.internal("WordPress import needs the content:write capability.");
	const content = ctx.content as Writable;
	const schemas = await ctx.schema.listCollections();
	const info = new Map(schemas.map((c) => [c.slug, c]));
	const collections = state?.collections ?? schemas.filter((c) => c.fields.some((f) => f.type === "portableText")).map((c) => c.slug);
	let index = state?.index ?? 0;
	let cursor = state?.cursor ?? null;
	const opts = await convertOptions(ctx);
	if (mediaHost) await refreshMediaHost();
	const host = mediaHost ? imageCdn() : null;
	if (mediaHost && !host) throw PluginRouteError.badRequest("There's no media host: set EmDash's storage publicUrl (or one on the Clean Image URLs page) first.");
	const entries: ScanEntry[] = [];
	const leftovers: Record<string, number> = {};
	let scanned = 0;
	let videosAdded = 0;
	const started = Date.now();

	while (index < collections.length && Date.now() - started < PAGE_MS) {
		const collection = collections[index] as string;
		const page = await content.list(collection, { limit: 25, ...(cursor ? { cursor } : {}) });
		for (const item of page.items) {
			scanned++;
			const data = await latestData(ctx, collection, item as unknown as { id: string; data: Record<string, unknown>; draftRevisionId?: string | null });
			const convertible = mightNeedConversion(data);
			const serialized = JSON.stringify(data);
			const rewritable = urlMap !== null && serialized.includes("/wp-content/");
			const hostable = host !== null && serialized.includes("/_emdash/api/media/file/");
			if (!convertible && !rewritable && !hostable) continue;
			const result = convertible ? convertEntryData(data, opts) : { value: data, changed: false, changes: [], videos: [], leftovers: {} };
			for (const [k, v] of Object.entries(result.leftovers)) leftovers[k] = (leftovers[k] ?? 0) + v;
			const urls = rewritable ? rewriteEntryUrls(result.value, urlMap) : { value: result.value, count: 0 };
			const hosted = hostable ? rewriteEntryMediaHost(urls.value, ctx.site?.url ?? null, (key) => (/^[A-Za-z0-9_.-]+\.[A-Za-z0-9]{2,5}$/.test(key) ? `${host}/${key}` : null)) : { value: urls.value, count: 0 };
			// Media host only: save just the entries whose media addresses change (no conversions on their own).
			if (host !== null && urlMap === null && !hosted.count) continue;
			if (!result.changed && !urls.count && !hosted.count) continue;
			result.value = hosted.value;
			const changes: Record<string, number> = {};
			for (const c of result.changes) changes[c.to] = (changes[c.to] ?? 0) + 1;
			if (urls.count) changes["media URL"] = urls.count;
			if (hosted.count) changes["media host URL"] = hosted.count;
			const schema = info.get(collection);
			const titleField = schema?.titleField ?? "title";
			const title = String(data[titleField] ?? data.title ?? item.slug ?? item.id).slice(0, 200);
			const entry: ScanEntry = { collection, id: item.id, title, status: String(item.status ?? ""), changes };
			entries.push(entry);
			if (!apply) continue;
			try {
				const patch: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(result.value)) if (v !== data[k]) patch[k] = v;
				const fresh = await content.get(collection, item.id);
				if (!fresh || versionOf(fresh) !== versionOf(item)) {
					entry.result = "conflict";
					entry.error = "Changed while converting. Run it again.";
					continue;
				}
				const hadDraft = Boolean(item.draftRevisionId);
				await content.update(collection, item.id, patch);
				entry.result = "updated";
				if (schema?.supports.includes("revisions") && item.status === "published") {
					entry.result = "draft";
					if (!hadDraft && content.getVersioned && content.publish) {
						const versioned = await content.getVersioned(collection, item.id);
						// Publish only the draft this update made: exactly one version after the one read.
						if (versioned && versioned.item.version === (fresh.version ?? 0) + 1) {
							try {
								await content.publish(collection, item.id, { _rev: versioned._rev });
								entry.result = "published";
							} catch (error) {
								// Someone saved it in between (co-editing saves every few seconds): the update stays a draft.
								if (!isConflict(error)) throw error;
							}
						}
					}
				}
				videosAdded += await seedVideos(ctx, result.videos).catch(() => 0);
			} catch (error) {
				entry.result = "failed";
				entry.error = String(error).slice(0, 300);
				ctx.log.error("WordPress import: convert failed", { collection, id: item.id, error: String(error) });
			}
		}
		if (page.hasMore && page.cursor) cursor = page.cursor;
		else {
			index++;
			cursor = null;
		}
	}
	const done = index >= collections.length;
	return {
		done,
		scanned,
		entries,
		leftovers,
		videosAdded,
		state: done ? null : { collections, index, cursor },
		progress: done ? "Done" : `Collection ${Math.min(index + 1, collections.length)} of ${collections.length}`,
	};
}

/** Count the old site's `/wp-content/` URLs in every entry (latest draft included), a page at a time. */
async function findUrls(ctx: PluginContext, hosts: string[], prefixes: string[], state: ScanState | null) {
	if (!ctx.content || !ctx.schema) throw PluginRouteError.internal("Content access is unavailable.");
	const schemas = await ctx.schema.listCollections();
	const collections = state?.collections ?? schemas.map((c) => c.slug);
	let index = state?.index ?? 0;
	let cursor = state?.cursor ?? null;
	const re = siteUrlPattern(hosts, prefixes);
	const urls = new Map<string, number>();
	let scanned = 0;
	const started = Date.now();
	while (index < collections.length && Date.now() - started < PAGE_MS) {
		const collection = collections[index] as string;
		const page = await ctx.content.list(collection, { limit: 25, ...(cursor ? { cursor } : {}) });
		for (const item of page.items) {
			scanned++;
			const data = await latestData(ctx, collection, item as unknown as { id: string; data: Record<string, unknown>; draftRevisionId?: string | null });
			if (JSON.stringify(data).includes("/wp-content/")) findSiteUrls(data, re, urls);
		}
		if (page.hasMore && page.cursor) cursor = page.cursor;
		else {
			index++;
			cursor = null;
		}
	}
	const done = index >= collections.length;
	return {
		done,
		scanned,
		urls: Object.fromEntries([...urls].slice(0, 20_000)),
		state: done ? null : { collections, index, cursor },
		progress: done ? "Done" : `Collection ${Math.min(index + 1, collections.length)} of ${collections.length}`,
	};
}

// ── Coywolf Files records ────────────────────────────────────────

const fileRow = z.object({
	file_id: z.string().regex(WORDPRESS_FILE_ID, "file_id must be the 20-character Coywolf Files id."),
	object_key: z
		.string()
		.min(1)
		.max(512)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/, "object_key must be a plain bucket key.")
		.refine((k) => !k.split("/").includes(".."), "object_key must be a plain bucket key."),
	filename: z.string().min(1).max(255),
	mime: z.string().max(150).optional().default("application/octet-stream"),
	size: z.coerce.number().int().min(0),
	downloads: z.coerce.number().int().min(0).optional().default(0),
	created: z.string().max(40).optional().default(""),
});

const wpDate = (value: string) => {
	const iso = value && !value.startsWith("0000") ? new Date(`${value.replace(" ", "T")}Z`) : null;
	return iso && !Number.isNaN(iso.getTime()) ? iso.toISOString() : new Date().toISOString();
};

// ── Video Manager library data ───────────────────────────────────

const videoLibraryInput = z.object({
	descriptions: z.record(z.string(), z.string().max(5000)).optional(),
	posters: z.record(z.string(), z.object({ mode: z.string().optional(), time: z.coerce.number().optional(), image_url: z.string().max(2000).optional() }).passthrough()).optional(),
	downloads: z.record(z.string(), z.string().max(2000)).optional(),
});

const UID = /^[0-9a-f]{32}$/;

export function wpImportPack(): PackModule {
	return {
		id: "wpImport",
		label: "WordPress Migration",
		features: FEATURES,
		capabilities: ["content:read", "content:write", "schema:read"],
		adminPages: [{ path: "/wordpress-import", label: "WordPress Migration", icon: "upload-simple" }],
		hooks: { "content:beforeSave": beforeSave },
		routes: {
			"wpImport/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: PluginContext) => ({ defaults: normalizeDefaults(await ctx.settings.get(DEFAULTS_SETTING)) }),
			},
			"wpImport/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const input = parseInput(z.object({ cvm: z.unknown().optional(), files: z.unknown().optional() }), ctx.input);
					const defaults = defaultsFromWordPress(input.cvm, input.files);
					await ctx.settings.set(DEFAULTS_SETTING, defaults);
					return { defaults };
				},
			}),
			"wpImport/scan": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json", maxBytes: 6 * 1024 * 1024 },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const input = parseInput(scanInput, ctx.input ?? {});
					const urlMap = input.urlMap && Object.keys(input.urlMap).length ? input.urlMap : null;
					return scan(ctx, input.apply, input.state ?? null, urlMap, input.mediaHost === true);
				},
			}),
			"wpImport/urls": readOnlyRoute(definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const input = parseInput(findInput, ctx.input ?? {});
					return findUrls(ctx, input.hosts, input.prefixes ?? [], input.state ?? null);
				},
			})),
			"wpImport/files": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json", maxBytes: 1024 * 1024 },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const { text } = parseInput(z.object({ text: z.string().min(1).max(1_000_000) }), ctx.input);
					let rows: Array<Record<string, string>>;
					try {
						rows = parseFileRows(text);
					} catch {
						throw PluginRouteError.badRequest("Paste the tab-separated output of the query, or a JSON array.");
					}
					const uploads = (ctx.storage as Record<string, StorageCollection<UploadDoc> | undefined>)[FILE_COLLECTIONS.uploads];
					const counts = (ctx.storage as Record<string, StorageCollection<{ downloads: number; lastDownload?: string }> | undefined>)[FILE_COLLECTIONS.counts];
					if (!uploads || !counts) throw PluginRouteError.badRequest("Turn on File Downloads first.");
					const added: string[] = [];
					const errors: Array<{ row: number; error: string }> = [];
					for (const [i, raw] of rows.slice(0, 2000).entries()) {
						const parsed = fileRow.safeParse(raw);
						if (!parsed.success) {
							errors.push({ row: i + 1, error: parsed.error.issues[0]?.message ?? "Invalid row" });
							continue;
						}
						const r = parsed.data;
						await uploads.put(r.file_id, { id: r.file_id, key: r.object_key, name: r.filename, size: r.size, type: r.mime || "application/octet-stream", uploadedAt: wpDate(r.created), status: "ready" });
						if (r.downloads > 0 && !(await counts.get(r.file_id))) await counts.put(r.file_id, { downloads: r.downloads });
						invalidateSiteCache(r.file_id);
						added.push(r.file_id);
					}
					return { added: added.length, ids: added, errors };
				},
			}),
			"wpImport/videos": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json", maxBytes: 1024 * 1024 },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					if (!(ctx.storage as Record<string, unknown>).videosMeta) throw PluginRouteError.badRequest("Turn on Videos first.");
					const input = parseInput(videoLibraryInput, ctx.input);
					const store = metaStore(ctx);
					const uids = new Set([...Object.keys(input.descriptions ?? {}), ...Object.keys(input.posters ?? {}), ...Object.keys(input.downloads ?? {})].filter((u) => UID.test(u)));
					let updated = 0;
					for (const uid of uids) {
						const prev = (await store.get(uid)) ?? { uid };
						const next: VideoMeta = { ...prev, uid, updatedAt: new Date().toISOString() };
						const description = input.descriptions?.[uid]?.trim();
						if (description) next.description = description;
						const poster = input.posters?.[uid];
						if (poster?.mode === "image" && poster.image_url && /^https?:\/\//i.test(poster.image_url)) next.posterImage = poster.image_url;
						else if (poster?.mode === "timestamp" && typeof poster.time === "number" && poster.time > 0) next.posterTime = poster.time;
						const download = input.downloads?.[uid];
						if (download && /^https:\/\/\S+\.mp4$/i.test(download)) {
							next.downloadUrl = download;
							next.downloadStatus = "ready";
						}
						await store.put(uid, next);
						updated++;
					}
					return { updated };
				},
			}),
		},
	};
}

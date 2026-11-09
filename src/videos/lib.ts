/**
 * Videos module: pure helpers (no I/O, no imports) for Stream URLs, the
 * coywolf-video block, VideoObject schema, the video sitemap, Portable Text
 * walking and webhook signatures. Unit-tested in test/videos.test.mjs.
 */

export const BLOCK_TYPE = "coywolf-video";
/** Thumbnail width for schema and the sitemap (Google wants large images). */
export const SCHEMA_THUMB_WIDTH = 1200;
const UID = /^[0-9a-f]{32}$/;
const HOST = /^customer-[a-z0-9]+\.cloudflarestream\.com$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const isUid = (value: unknown): value is string => typeof value === "string" && UID.test(value);
export const isHex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

// ── Stream URLs ──────────────────────────────────────────────────

/** "customer-abc.cloudflarestream.com", a URL on it, or the bare code → the host; anything else → null. */
export function normalizeCustomerHost(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let v = value.trim().toLowerCase();
	if (!v) return null;
	v = v.replace(/^https?:\/\//, "").split("/")[0];
	if (/^[a-z0-9]+$/.test(v)) v = `customer-${v}.cloudflarestream.com`;
	return HOST.test(v) ? v : null;
}

/** Pull the customer host out of any Stream delivery URL (thumbnail, preview, HLS). */
export function customerHostFromUrl(url: unknown): string | null {
	if (typeof url !== "string") return null;
	const m = url.match(/\/\/(customer-[a-z0-9]+\.cloudflarestream\.com)\//i);
	return m ? m[1].toLowerCase() : null;
}

type Params = Record<string, string | number | boolean | null | undefined>;

function query(params: Params): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
	const s = q.toString();
	return s ? `?${s}` : "";
}

/** Iframe player URL. Without a customer host, Stream's account-independent hostnames work too. */
export function iframeUrl(host: string | null, uid: string, params: Params = {}): string {
	const base = host ? `https://${host}/${uid}/iframe` : `https://iframe.videodelivery.net/${uid}`;
	return base + query(params);
}

export function thumbnailUrl(host: string | null, uid: string, params: Params = {}): string {
	const base = host ? `https://${host}/${uid}` : `https://videodelivery.net/${uid}`;
	return `${base}/thumbnails/thumbnail.jpg${query(params)}`;
}

export function watchUrl(host: string | null, uid: string): string {
	return host ? `https://${host}/${uid}/watch` : `https://iframe.videodelivery.net/${uid}`;
}

/** An http(s) URL or a root-relative path (EmDash media is /_emdash/api/media/file/<key>). */
export function isImageUrl(value: unknown): value is string {
	return typeof value === "string" && (/^https?:\/\/[^\s]+$/i.test(value) || /^\/(?!\/)[^\s]*$/.test(value));
}

/** Resolve a root-relative URL against the site origin; absolute http(s) URLs pass through; anything else → undefined. */
export function absoluteUrl(url: unknown, origin?: string | null): string | undefined {
	if (!isImageUrl(url)) return undefined;
	if (/^https?:/i.test(url)) return url;
	if (!origin) return undefined;
	try {
		return new URL(url, origin).href;
	} catch {
		return undefined;
	}
}

/** Largest caption track kept (D1 rows max out at 2 MB). */
export const MAX_CAPTION_BYTES = 1_500_000;
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

// ── Tags ─────────────────────────────────────────────────────────

/** Most tags kept on a video, and the longest tag (Video Manager's limits). */
export const MAX_TAGS = 25;
export const MAX_TAG_LENGTH = 50;

/**
 * Tags from a comma/newline list or an array, as Video Manager keeps them in
 * Stream's meta.tags: no leading #, spaces as hyphens, only letters, digits,
 * _ . and -, de-duplicated without regard to case.
 */
export function parseTags(raw: unknown): string[] {
	const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\r\n]+/) : [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const part of parts) {
		let tag = String(part ?? "").trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.-]+/g, "").replace(/^[-.]+|[-.]+$/g, "");
		if (!tag) continue;
		tag = tag.slice(0, MAX_TAG_LENGTH);
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(tag);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

// ── Formatting ───────────────────────────────────────────────────

/** Seconds → ISO 8601 duration (PT1H2M3S). Zero or invalid → null. */
export function isoDuration(seconds: unknown): string | null {
	const n = typeof seconds === "number" ? seconds : Number(seconds);
	if (!Number.isFinite(n) || n <= 0) return null;
	const total = Math.max(1, Math.round(n));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

/** Seconds → "1:02:03" / "4:05" for display. */
export function clockDuration(seconds: unknown): string {
	const n = typeof seconds === "number" ? seconds : Number(seconds);
	if (!Number.isFinite(n) || n <= 0) return "";
	const total = Math.round(n);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Strip tags and decode the common entities (descriptions may hold simple HTML). */
export function plainText(html: unknown): string {
	if (typeof html !== "string") return "";
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
			if (e[0] === "#") {
				const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
				return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
			}
			return NAMED[e.toLowerCase()] ?? all;
		})
		.replace(/\s+/g, " ")
		.trim();
}

/** WebVTT → running prose (headers, NOTE/STYLE/REGION blocks, cue ids, timings and tags removed). */
export function vttToTranscript(vtt: string): string {
	const pieces: string[] = [];
	const text = vtt.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	for (const block of text.split(/\n{2,}/)) {
		const lines = block.trim().split("\n");
		if (/^(WEBVTT|NOTE|STYLE|REGION)/.test(lines[0] ?? "")) continue;
		const timing = lines.findIndex((l) => l.includes("-->"));
		if (timing < 0) continue;
		const cue = lines.slice(timing + 1).join(" ").trim();
		if (cue) pieces.push(cue);
	}
	return plainText(pieces.join(" "));
}

// ── The coywolf-video block ─────────────────────────────────────

export interface VideoBlock {
	_type?: string;
	_key?: string;
	uid?: string;
	/** "standard" or "gif" (muted, autoplaying, looping, no controls: like an animated GIF). */
	preset?: string;
	title?: string;
	caption?: string;
	posterTime?: number;
	posterImage?: string;
	startTime?: number;
	controls?: boolean;
	autoplay?: boolean;
	loop?: boolean;
	muted?: boolean;
	preload?: string;
	sizeMode?: string;
	maxWidth?: number;
	/**
	 * Show/hide choices: "show", "hide", or empty/missing for the site default
	 * (Videos → Settings). Booleans are from before the site defaults existed
	 * (the old on/off toggles, and WordPress imports): kept as they were
	 * unless the site is set to make every block follow its defaults.
	 */
	showName?: BlockShow;
	showDescription?: BlockShow;
	showPlays?: BlockShow;
	showLikes?: BlockShow;
	showLikeCount?: BlockShow;
	/** Per-video look (empty/missing: the site's Appearance settings). See render.ts blockDisplay. */
	contentAlign?: string;
	metaAlign?: string;
	radius?: number;
	/** "show"/"hide" (true/false from WordPress imports). */
	showBorder?: BlockShow;
	borderWidth?: number;
	borderColor?: string;
	showDate?: BlockShow;
	/** Legacy WordPress cloudflare-stream marker attributes (wellbeing.io). */
	id?: string;
	host?: string;
	aspect?: number;
	name?: string;
	description?: string;
	seconds?: number;
	url?: string;
}

/** What the index keeps about each embedded video. */
export interface VideoRef {
	uid: string;
	title?: string;
	caption?: string;
	posterTime?: number;
	posterImage?: string;
	/** Found in a WordPress marker block rendered by the theme, not a coywolf-video block. */
	legacy?: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function refFromBlock(node: Record<string, unknown>, legacy = false): VideoRef | null {
	const uid = isUid(node.uid) ? node.uid : isUid(node.id) ? node.id : null;
	if (!uid) return null;
	const ref: VideoRef = { uid };
	const title = str(node.title) ?? str(node.name);
	const caption = str(node.caption) ?? str(node.description);
	const posterTime = num(node.posterTime);
	const posterImage = str(node.posterImage);
	if (title) ref.title = title;
	if (caption) ref.caption = caption;
	if (posterTime !== undefined) ref.posterTime = posterTime;
	if (isImageUrl(posterImage)) ref.posterImage = posterImage;
	if (legacy) ref.legacy = true;
	return ref;
}

const MARKER = /^\s*<div data-wb-block="cloudflare-stream" data-wb-attrs="([^"]*)"><\/div>\s*$/;
const MARKER_ENTITIES: Record<string, string> = { "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };

/**
 * Every video embedded anywhere in an entry's data: coywolf-video blocks at
 * any depth (columns, nested arrays), plus WordPress cloudflare-stream marker
 * HTML blocks. Duplicates of the same video are kept once (first wins).
 */
export function findVideoBlocks(data: unknown): VideoRef[] {
	const out: VideoRef[] = [];
	const seen = new Set<string>();
	const visit = (value: unknown, depth: number) => {
		if (depth > 12 || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		const node = value as Record<string, unknown>;
		let ref: VideoRef | null = null;
		if (node._type === BLOCK_TYPE) ref = refFromBlock(node);
		else if (node._type === "htmlBlock" && typeof node.html === "string") {
			const m = node.html.match(MARKER);
			if (m) {
				try {
					ref = refFromBlock(JSON.parse(m[1].replace(/&(?:quot|#x27|#39|lt|gt|amp);/g, (e) => MARKER_ENTITIES[e])), true);
				} catch {
					ref = null;
				}
			}
		}
		if (ref) {
			if (!seen.has(ref.uid)) {
				seen.add(ref.uid);
				out.push(ref);
			}
			return;
		}
		for (const child of Object.values(node)) visit(child, depth + 1);
	};
	visit(data, 0);
	return out;
}

/**
 * Which copy of an entry to index. Save hooks can carry draft-hydrated data
 * (with the live status), so prefer the live row read back from the database;
 * without one, only trust the event when the entry has no pending draft.
 */
export function indexSource<T extends Record<string, unknown>>(event: T, live: T | null | undefined): T | null {
	if (live && typeof live.data === "object" && live.data !== null) return live;
	if (event.draftRevisionId) return null;
	return typeof event.data === "object" && event.data !== null ? event : null;
}

export type BlockShow = boolean | "show" | "hide" | "";

/** The site-wide show/hide defaults blocks inherit (Videos → Settings → Views & likes). */
export interface ShowDefaults {
	showName: boolean;
	showDescription: boolean;
	showPlays: boolean;
	showLikes: boolean;
	showLikeCount: boolean;
	showDate: boolean;
	/** Ignore the booleans older blocks carry, so they follow the defaults above too. */
	followSiteDefaults: boolean;
}

/** Video Manager's defaults: everything shown. */
export const SHOW_DEFAULTS: ShowDefaults = {
	showName: true,
	showDescription: true,
	showPlays: true,
	showLikes: true,
	showLikeCount: true,
	showDate: true,
	followSiteDefaults: false,
};

/** A block's show/hide choice: "show"/"hide" win; an older boolean counts unless the site follows its defaults; else the site default. */
export function resolveShow(value: unknown, siteDefault: boolean, followSiteDefaults: boolean): boolean {
	if (value === "show") return true;
	if (value === "hide") return false;
	if (typeof value === "boolean" && !followSiteDefaults) return value;
	return siteDefault;
}

const SHOW_KEYS = ["showName", "showDescription", "showPlays", "showLikes", "showLikeCount", "showDate"] as const;

/**
 * A coywolf-video block with its true/false show choices (older blocks and
 * WordPress imports) turned into what the block editor shows, rendering the
 * same: "show"/"hide", or, when the site makes every block follow its
 * defaults (so the booleans were ignored), removed (Site default). The
 * border was always honored, so true/false → "show"/"hide" either way.
 * Strings and missing values are left alone. Returns the same object when
 * nothing changes.
 */
export function normalizeVideoShow<T extends Record<string, unknown>>(block: T, followSiteDefaults: boolean): T {
	let out: Record<string, unknown> | null = null;
	for (const key of [...SHOW_KEYS, "showBorder"] as const) {
		const value = block[key];
		if (typeof value !== "boolean") continue;
		out ??= { ...block };
		if (followSiteDefaults && key !== "showBorder") delete out[key];
		else out[key] = value ? "show" : "hide";
	}
	return (out ?? block) as T;
}

/**
 * normalizeVideoShow on every coywolf-video block in a content value (a
 * Portable Text array, an entry's data, at any depth). Returns a copy only
 * along changed paths; `changed` counts the blocks rewritten.
 */
export function normalizeVideoShows<T>(value: T, followSiteDefaults: boolean): { value: T; changed: number } {
	let changed = 0;
	const visit = (node: unknown, depth: number): unknown => {
		if (depth > 12 || node === null || typeof node !== "object") return node;
		if (Array.isArray(node)) {
			let copy: unknown[] | null = null;
			node.forEach((item, i) => {
				const next = visit(item, depth + 1);
				if (next !== item) (copy ??= [...node])[i] = next;
			});
			return copy ?? node;
		}
		const record = node as Record<string, unknown>;
		if (record._type === BLOCK_TYPE) {
			const next = normalizeVideoShow(record, followSiteDefaults);
			if (next !== record) changed++;
			return next;
		}
		let copy: Record<string, unknown> | null = null;
		for (const [key, child] of Object.entries(record)) {
			const next = visit(child, depth + 1);
			if (next !== child) (copy ??= { ...record })[key] = next;
		}
		return copy ?? record;
	};
	return { value: visit(value, 0) as T, changed };
}

export interface PlayerConfig {
	controls: boolean;
	autoplay: boolean;
	loop: boolean;
	muted: boolean;
	preload: "none" | "metadata" | "auto";
	showName: boolean;
	showDescription: boolean;
	showPlays: boolean;
	showLikes: boolean;
	showLikeCount: boolean;
	showDate: boolean;
	gif: boolean;
}

/**
 * Resolve a block's playback options, applying the GIF preset (legacy marker
 * blocks default to it) and the site's show/hide defaults.
 */
export function playerConfig(block: VideoBlock, site: ShowDefaults = SHOW_DEFAULTS): PlayerConfig {
	const legacy = !block.uid && !!block.host;
	const gif = block.preset === "gif" || (legacy && block.preset !== "standard");
	if (gif) {
		return { controls: false, autoplay: true, loop: true, muted: true, preload: "auto", showName: false, showDescription: false, showPlays: false, showLikes: false, showLikeCount: false, showDate: false, gif };
	}
	const preload = block.preload === "none" || block.preload === "auto" ? block.preload : "metadata";
	const autoplay = block.autoplay === true;
	const show = (key: keyof Omit<ShowDefaults, "followSiteDefaults">) => resolveShow(block[key], site[key], site.followSiteDefaults);
	return {
		controls: block.controls !== false,
		autoplay,
		loop: block.loop === true,
		muted: autoplay || block.muted === true,
		preload,
		showName: show("showName"),
		showDescription: show("showDescription"),
		showPlays: show("showPlays"),
		showLikes: show("showLikes"),
		showLikeCount: show("showLikeCount"),
		showDate: show("showDate"),
		gif,
	};
}

/** The poster for a video: an explicit image, else a frame at the block's (or the video's) poster time. */
export function posterUrl(
	host: string | null,
	uid: string,
	ref: { posterImage?: string; posterTime?: number },
	fallback: { posterImage?: string; posterTime?: number } = {},
	width = SCHEMA_THUMB_WIDTH,
	origin?: string | null,
): string {
	const image = absoluteUrl(ref.posterImage, origin) ?? (ref.posterTime === undefined ? absoluteUrl(fallback.posterImage, origin) : undefined);
	if (image) return image;
	const time = ref.posterTime ?? fallback.posterTime ?? 0;
	return thumbnailUrl(host, uid, { time: `${time}s`, width });
}

/** Poster widths for the page's poster image (the player isn't loaded until it's needed). */
export const POSTER_WIDTHS = [400, 800, 1200] as const;

/**
 * The poster as a responsive image: Stream thumbnails in a few widths, so a
 * phone downloads a small one. An explicit poster image is used as it is.
 */
export function posterImage(
	host: string | null,
	uid: string,
	ref: { posterImage?: string; posterTime?: number },
	fallback: { posterImage?: string; posterTime?: number } = {},
	origin?: string | null,
): { src: string; srcset?: string } {
	const explicit = absoluteUrl(ref.posterImage, origin) ?? (ref.posterTime === undefined ? absoluteUrl(fallback.posterImage, origin) : undefined);
	if (explicit) return { src: explicit };
	const at = (width: number) => posterUrl(host, uid, ref, fallback, width, origin);
	return { src: at(800), srcset: POSTER_WIDTHS.map((w) => `${at(w)} ${w}w`).join(", ") };
}

/** The Stream iframe src for a block. */
export function playerSrc(host: string | null, uid: string, cfg: PlayerConfig, extra: { startTime?: number; poster?: string; accent?: string; background?: string } = {}): string {
	return iframeUrl(host, uid, {
		preload: cfg.preload,
		autoplay: cfg.autoplay ? "true" : undefined,
		muted: cfg.muted ? "true" : undefined,
		loop: cfg.loop ? "true" : undefined,
		controls: cfg.controls ? undefined : "false",
		startTime: extra.startTime && extra.startTime > 0 ? `${Math.floor(extra.startTime)}s` : undefined,
		primaryColor: isHex(extra.accent) ? extra.accent : undefined,
		letterboxColor: isHex(extra.background) ? extra.background : "transparent",
		poster: extra.poster,
	});
}

/** Aspect ratio as "w / h" for CSS, from dimensions or a legacy padding percentage. Default 16 / 9. */
export function aspectRatio(width?: number, height?: number, paddingPct?: number): string {
	if (width && height && width > 0 && height > 0) return `${Math.round(width)} / ${Math.round(height)}`;
	if (paddingPct && paddingPct > 0 && paddingPct < 400) return `100 / ${Math.round(paddingPct * 100) / 100}`;
	return "16 / 9";
}

// ── Schema ───────────────────────────────────────────────────────

export interface VideoFacts {
	uid: string;
	name?: string;
	description?: string;
	duration?: number;
	created?: string;
	width?: number;
	height?: number;
	posterTime?: number;
	posterImage?: string;
	downloadUrl?: string;
	captions?: Array<{ language: string; label?: string }>;
	transcript?: string;
}

export interface SchemaInput {
	ref: VideoRef;
	video?: VideoFacts;
	host: string | null;
	/** Absolute URL of the site, for caption file URLs. */
	siteUrl: string;
	page: { title?: string | null; description?: string | null; publishedTime?: string | null; url?: string };
	counts?: { plays: number; likes: number };
	likesEnabled?: boolean;
	captionsEnabled?: boolean;
	/** Transcript cap (characters). */
	maxTranscript?: number;
}

/** Path of the public caption file served by the pack middleware. */
export const captionPath = (uid: string, language: string) => `/coywolf-video-captions/${uid}/${encodeURIComponent(language)}.vtt`;

/** VideoObject JSON-LD for one embedded video. */
export function buildVideoObject(input: SchemaInput): Record<string, unknown> {
	const { ref, video = { uid: ref.uid }, host, page } = input;
	const name = ref.title ?? video.name ?? page.title ?? "Video";
	const description = plainText(ref.caption ?? video.description ?? "") || plainText(page.description ?? "") || name;
	const thumb = posterUrl(host, ref.uid, ref, video, SCHEMA_THUMB_WIDTH, input.siteUrl);
	const schema: Record<string, unknown> = {
		"@context": "https://schema.org",
		"@type": "VideoObject",
		name,
		description,
		thumbnailUrl: [thumb],
		uploadDate: video.created ?? page.publishedTime ?? undefined,
		embedUrl: iframeUrl(host, ref.uid),
	};
	const duration = isoDuration(video.duration);
	if (duration) schema.duration = duration;
	if (video.downloadUrl) schema.contentUrl = video.downloadUrl;
	if (input.counts) {
		const stats: Record<string, unknown>[] = [
			{ "@type": "InteractionCounter", interactionType: { "@type": "WatchAction" }, userInteractionCount: input.counts.plays },
		];
		if (input.likesEnabled) stats.push({ "@type": "InteractionCounter", interactionType: { "@type": "LikeAction" }, userInteractionCount: input.counts.likes });
		schema.interactionStatistic = stats;
	}
	if (input.captionsEnabled && video.captions?.length) {
		const site = input.siteUrl.replace(/\/$/, "");
		const tracks = video.captions.map((c) => ({
			"@type": "MediaObject",
			contentUrl: `${site}${captionPath(ref.uid, c.language)}`,
			encodingFormat: "text/vtt",
			inLanguage: c.language,
			name: c.label || c.language,
		}));
		schema.caption = tracks.length === 1 ? tracks[0] : tracks;
		const max = input.maxTranscript ?? 10_000;
		if (video.transcript) schema.transcript = video.transcript.length > max ? `${video.transcript.slice(0, max).replace(/\s+\S*$/, "")}…` : video.transcript;
	}
	if (schema.uploadDate === undefined) delete schema.uploadDate;
	return schema;
}

// ── Sitemap ──────────────────────────────────────────────────────

export interface SitemapVideo {
	thumbnail: string;
	title: string;
	description: string;
	playerLoc: string;
	contentLoc?: string;
	duration?: number;
	viewCount?: number;
	publicationDate?: string;
}

export interface SitemapEntry {
	loc: string;
	videos: SitemapVideo[];
}

/** A Google video sitemap (sitemap-video 1.1; element order follows the schema). */
export function buildVideoSitemap(entries: SitemapEntry[]): string {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
	];
	for (const entry of entries) {
		if (!entry.videos.length) continue;
		lines.push("\t<url>", `\t\t<loc>${escapeXml(entry.loc)}</loc>`);
		for (const v of entry.videos) {
			lines.push("\t\t<video:video>");
			lines.push(`\t\t\t<video:thumbnail_loc>${escapeXml(v.thumbnail)}</video:thumbnail_loc>`);
			lines.push(`\t\t\t<video:title>${escapeXml(v.title.slice(0, 100))}</video:title>`);
			lines.push(`\t\t\t<video:description>${escapeXml((v.description || v.title).slice(0, 2048))}</video:description>`);
			if (v.contentLoc) lines.push(`\t\t\t<video:content_loc>${escapeXml(v.contentLoc)}</video:content_loc>`);
			lines.push(`\t\t\t<video:player_loc>${escapeXml(v.playerLoc)}</video:player_loc>`);
			if (v.duration && v.duration >= 1 && v.duration <= 28_800) lines.push(`\t\t\t<video:duration>${Math.round(v.duration)}</video:duration>`);
			if (v.viewCount !== undefined) lines.push(`\t\t\t<video:view_count>${Math.max(0, Math.floor(v.viewCount))}</video:view_count>`);
			if (v.publicationDate) lines.push(`\t\t\t<video:publication_date>${escapeXml(v.publicationDate)}</video:publication_date>`);
			lines.push("\t\t\t<video:family_friendly>yes</video:family_friendly>");
			lines.push("\t\t\t<video:requires_subscription>no</video:requires_subscription>");
			lines.push("\t\t\t<video:live>no</video:live>");
			lines.push("\t\t</video:video>");
		}
		lines.push("\t</url>");
	}
	lines.push("</urlset>", "");
	return lines.join("\n");
}

// ── Webhook signatures ──────────────────────────────────────────

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(secret: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export async function sha256Hex(text: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Verify Cloudflare Stream's Webhook-Signature header ("time=<unix>,sig1=<hex>",
 * HMAC-SHA256 of "<time>.<body>"). Rejects timestamps more than 10 minutes off.
 */
export async function verifyWebhookSignature(header: string | null, body: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
	if (!header || !secret) return false;
	let time = "";
	let sig = "";
	for (const part of header.split(",")) {
		const [k, v] = part.trim().split("=", 2);
		if (k === "time") time = v ?? "";
		else if (k === "sig1") sig = (v ?? "").toLowerCase();
	}
	if (!/^\d+$/.test(time) || !/^[0-9a-f]{64}$/.test(sig)) return false;
	if (Math.abs(nowSeconds - Number(time)) > 600) return false;
	const expected = await hmacHex(secret, `${time}.${body}`);
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
	return diff === 0;
}

// ── Bounded recent-key memory ───────────────────────────────────

/** An LRU of keys seen within a time window, capped at `max` entries (oldest evicted first). */
export class RecentKeys {
	private readonly map = new Map<string, number>();
	private readonly max: number;
	private readonly windowMs: number;
	constructor(max: number, windowMs: number) {
		this.max = max;
		this.windowMs = windowMs;
	}

	/** Record `key`; true when it was already seen within the window. */
	seen(key: string, now = Date.now()): boolean {
		const last = this.map.get(key);
		this.map.delete(key);
		this.map.set(key, now);
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next().value as string;
			this.map.delete(oldest);
		}
		return last !== undefined && now - last < this.windowMs;
	}

	get size(): number {
		return this.map.size;
	}
}

// ── Webhook: pages to clear ──────────────────────────────────────

/** Most pages one webhook call clears by path; a video shown on more is left to expire on its own. */
export const MAX_WEBHOOK_PAGES = 30;

/**
 * The cached pages a Stream webhook call for `uid` has to clear: the
 * published entries that embed the video (from the embed index), as path
 * prefixes, which cover each page's trailing-slash form and query strings.
 * Never everything: null when no page shows the video, when one of them is
 * the home page (a "/" prefix would clear every page), or when more than
 * MAX_WEBHOOK_PAGES do. Pages aren't cache-tagged per video, so paths are
 * how to reach just these.
 */
export function videoPagesScope(entries: Array<{ uids: string[]; status: string; url: string | null }>, uid: string, max = MAX_WEBHOOK_PAGES): { pathPrefixes: string[] } | null {
	const paths = new Set<string>();
	for (const entry of entries) {
		if (entry.status !== "published" || !entry.url || !entry.uids.includes(uid)) continue;
		let path: string;
		try {
			path = new URL(entry.url).pathname.replace(/\/+$/, "") || "/";
		} catch {
			continue;
		}
		if (path === "/") return null;
		paths.add(path);
	}
	if (!paths.size || paths.size > max) return null;
	return { pathPrefixes: [...paths] };
}

/**
 * Turn imported WordPress blocks into native Coywolf Pack blocks, in stored
 * Portable Text. Reads:
 *
 * - markers written by the prepare step (./prepare.ts, ./markers.ts);
 * - the `data-wb-block` markers an earlier, site-specific import script wrote
 *   (wellbeing.io: cloudflare-stream, review);
 * - what EmDash's importer makes of Coywolf blocks with saved HTML when the
 *   export wasn't prepared (`htmlBlock` with `originalBlockName` and
 *   `originalAttrs`: coywolf/video, coywolf/file).
 *
 * For any WordPress site it moves "anchor" markers (heading ids) onto the
 * next heading's `anchor` field, "table-caption" markers onto the table
 * before them (its `caption` field; EmDash's editor keeps the field when it
 * saves), turns core Details markers into
 * `coywolf-details`, and maps Prism language names on code blocks to the
 * editor's (markup → html). For content from Coywolf's WordPress plugins it
 * produces `coywolf-video`, `coywolf-review`, `coywolf-toc` and
 * `coywolf-file` blocks, plus `coywolf-note`, `coywolf-details`,
 * `coywolf-quote`, `coywolf-disclosure`, `coywolf-testimonial` and
 * `coywolf-podcast` (Custom Blocks, each only while its switch is on). Other
 * template markers (related links, Gravity Forms) stay HTML blocks. Anything
 * else is left exactly as it is, and running it again changes nothing.
 *
 * Pure, no I/O.
 */
import { ratingValue } from "../reviews/lib.js";
import { type Marker, parseMarker } from "./markers.js";
import { type StreamEmbed, decodeHtml, textOf } from "./stream.js";

/** Video Manager's site-wide defaults (WordPress option coywolf_cvm_settings). Blocks without a value used these. */
export interface VideoDefaults {
	controls: boolean;
	autoplay: boolean;
	loop: boolean;
	mute: boolean;
	preload: "auto" | "metadata" | "none";
	showName: boolean;
	showDescription: boolean;
	showDate: boolean;
	showPlays: boolean;
	showLikes: boolean;
	showLikeCount: boolean;
}

/** The Video Manager plugin's own defaults, used when the site's settings weren't pasted on the import page. */
export const VIDEO_MANAGER_DEFAULTS: VideoDefaults = {
	controls: true,
	autoplay: false,
	loop: false,
	mute: false,
	preload: "metadata",
	showName: true,
	showDescription: true,
	showDate: true,
	showPlays: true,
	showLikes: true,
	showLikeCount: true,
};

/** Coywolf Files' card defaults (WordPress option coywolf_files_settings). */
export interface FileDefaults {
	showIcon: boolean;
	showDescription: boolean;
	showMeta: boolean;
	showDownload: boolean;
	showCopyLink: boolean;
}

export const FILES_DEFAULTS: FileDefaults = { showIcon: true, showDescription: true, showMeta: true, showDownload: true, showCopyLink: true };

/** Which Custom Blocks are on. A block that's off isn't converted to (its marker stays an HTML block until it's on). */
export interface CustomBlockSwitches {
	note: boolean;
	details: boolean;
	disclosure: boolean;
	quote: boolean;
	testimonial: boolean;
	podcast: boolean;
}

export interface ConvertOptions {
	videoDefaults?: Partial<VideoDefaults>;
	fileDefaults?: Partial<FileDefaults>;
	/** Defaults to all on. */
	customBlocks?: Partial<CustomBlockSwitches>;
	/** @deprecated The 0.10/0.11 name of `customBlocks`. */
	contentBlocks?: Partial<CustomBlockSwitches>;
	/** Key generator for new blocks (defaults to a random one). */
	key?: () => string;
}

/** Facts about a video learned from WordPress, for the Videos module's per-video data. */
export interface VideoFact {
	uid: string;
	name?: string;
	duration?: number;
	created?: string;
	width?: number;
	height?: number;
	host?: string;
}

export interface Change {
	/** What it was: a marker name or WordPress block name. */
	from: string;
	/** What it became: a block type, "anchor", or "removed". */
	to: string;
	detail?: string;
}

export interface ConvertResult<T> {
	value: T;
	changed: boolean;
	changes: Change[];
	videos: VideoFact[];
	/** Imported blocks left as HTML, by original block or marker name (for the report). */
	leftovers: Record<string, number>;
}

type Block = Record<string, unknown> & { _type?: unknown; _key?: unknown };

const UID = /^[0-9a-f]{32}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const num = (v: unknown): number | undefined => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function randomKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

// ── Videos ───────────────────────────────────────────────────────

const HEIGHT_FOR = (pct: number) => Math.round((1920 * pct) / 100);

/** Seconds from the cloudflare-stream block's hours / minutes / seconds fields. */
export function streamSeconds(a: Record<string, unknown>): number | undefined {
	const total = (num(a["cs-hours"]) ?? 0) * 3600 + (num(a["cs-minutes"]) ?? 0) * 60 + (num(a["cs-seconds"]) ?? 0);
	return total > 0 ? total : undefined;
}

function embedFields(embed: StreamEmbed | null | undefined, block: Block): void {
	if (!embed) return;
	block.controls = embed.controls;
	block.autoplay = embed.autoplay;
	block.loop = embed.loop;
	block.muted = embed.muted || embed.autoplay;
	if (embed.preload) block.preload = embed.preload;
	if (embed.posterTime !== null && embed.posterTime >= 0) block.posterTime = embed.posterTime;
	if (embed.startTime) block.startTime = embed.startTime;
	if (embed.maxWidth) {
		block.sizeMode = "maxwidth";
		block.maxWidth = embed.maxWidth;
	}
	if (embed.aspect) block.aspect = Math.round(embed.aspect * 1000) / 1000;
}

/** coywolf-custom-blocks/cloudflare-stream (+ its embed), a stand-alone embed, or a wellbeing marker → coywolf-video. */
function streamVideo(attrs: Record<string, unknown>, embed: StreamEmbed | null): { block: Block; fact: VideoFact } | null {
	const uid = (str(attrs["cs-id"]) || embed?.uid || "").toLowerCase();
	if (!UID.test(uid)) return null;
	const caption = embed?.caption ?? null;
	const block: Block = {
		_type: "coywolf-video",
		uid,
		preset: "standard",
		title: str(attrs["cs-name"]) || embed?.title || undefined,
		caption: caption ?? (str(attrs["cs-description"]) || undefined),
		showName: "hide",
		showDescription: caption ? "show" : "hide",
		showPlays: "hide",
		showLikes: "hide",
		showDate: "hide",
	};
	embedFields(embed, block);
	const host = embed?.host ?? (/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(str(attrs["cs-subdomain"])) ? str(attrs["cs-subdomain"]) : undefined);
	const fact: VideoFact = { uid, name: str(attrs["cs-name"]) || undefined, duration: streamSeconds(attrs) };
	if (embed?.aspect) {
		fact.width = 1920;
		fact.height = HEIGHT_FOR(embed.aspect);
	}
	if (host) fact.host = host;
	return { block, fact };
}

/** wellbeing.io's cloudflare-stream marker ({ id, host, aspect, name, description, seconds }): it played like a GIF. */
function wellbeingVideo(a: Record<string, unknown>): { block: Block; fact: VideoFact } | null {
	const uid = str(a.id).toLowerCase();
	if (!UID.test(uid)) return null;
	const aspect = num(a.aspect);
	const block: Block = { _type: "coywolf-video", uid, preset: "gif", title: str(a.name) || undefined, caption: str(a.description) || undefined };
	if (aspect) block.aspect = aspect;
	const fact: VideoFact = { uid, name: str(a.name) || undefined, duration: num(a.seconds) };
	if (aspect) {
		fact.width = 1920;
		fact.height = HEIGHT_FOR(aspect);
	}
	if (/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(str(a.host))) fact.host = str(a.host);
	return { block, fact };
}

/**
 * A show/hide attribute: "show"/"hide" when the WordPress block set it.
 * Unset, WordPress used its site setting, as the Videos module does: left
 * unset (the Videos site default, on unless changed), or "hide" when the
 * WordPress site had it off, so the page looks as it did.
 */
const showAttr = (value: unknown, wpDefault: boolean): "show" | "hide" | undefined => {
	const v = bool(value);
	if (v !== undefined) return v ? "show" : "hide";
	return wpDefault ? undefined : "hide";
};

/** Video Manager's coywolf/video → coywolf-video, applying the site defaults where the block had no value. */
function managerVideo(a: Record<string, unknown>, d: VideoDefaults): { block: Block; fact: VideoFact } | null {
	const uid = str(a.videoId).toLowerCase();
	if (!UID.test(uid)) return null;
	const autoplay = bool(a.autoplay) ?? d.autoplay;
	const preload = str(a.preload);
	const block: Block = {
		_type: "coywolf-video",
		uid,
		preset: "standard",
		title: str(a.videoName) || undefined,
		caption: textOf(str(a.videoDescription)) || undefined,
		controls: bool(a.controls) ?? d.controls,
		autoplay,
		loop: bool(a.loop) ?? d.loop,
		muted: (bool(a.mute) ?? d.mute) || autoplay,
		preload: preload === "auto" || preload === "none" || preload === "metadata" ? preload : d.preload,
	};
	const shows: Array<[string, unknown, boolean]> = [
		["showName", a.showName, d.showName],
		["showDescription", a.showDescription, d.showDescription],
		["showDate", a.showDate, d.showDate],
		["showPlays", a.showPlays, d.showPlays],
		["showLikes", a.enableLikes, d.showLikes],
		["showLikeCount", a.showLikeCount, d.showLikeCount],
	];
	for (const [key, value, wpDefault] of shows) {
		const show = showAttr(value, wpDefault);
		if (show) block[key] = show;
	}
	// Per-video look, only where the WordPress block set it (else it followed the site settings).
	for (const key of ["contentAlign", "metaAlign"]) if (a[key] === "left" || a[key] === "center" || a[key] === "right") block[key] = a[key];
	const radius = num(a.radius);
	if (radius !== undefined) block.radius = Math.max(0, Math.min(48, Math.round(radius)));
	const border = bool(a.showBorder);
	if (border !== undefined) block.showBorder = border ? "show" : "hide";
	const borderWidth = num(a.borderWidth);
	if (borderWidth !== undefined) block.borderWidth = Math.max(0, Math.min(20, Math.round(borderWidth)));
	if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(str(a.borderColor))) block.borderColor = str(a.borderColor);
	const posterTime = num(a.posterTime);
	if (posterTime && posterTime > 0) block.posterTime = posterTime;
	const startTime = num(a.startTime);
	if (startTime && startTime > 0) block.startTime = startTime;
	if (a.sizeMode === "maxwidth") {
		block.sizeMode = "maxwidth";
		block.maxWidth = num(a.maxWidth) ?? 800;
	}
	const ratio = num(a.aspectRatio);
	if (ratio && ratio > 0) block.aspect = Math.round(ratio * 100_000) / 1000;
	const fact: VideoFact = { uid, name: str(a.videoName) || undefined, duration: num(a.duration) };
	if (ratio && ratio > 0) {
		fact.width = 1920;
		fact.height = Math.round(1920 * ratio);
	}
	const uploaded = str(a.uploaded);
	if (uploaded && !Number.isNaN(Date.parse(uploaded))) fact.created = uploaded;
	return { block, fact };
}

// ── Reviews ──────────────────────────────────────────────────────

/** Text of each <li> (or line) in a WordPress list field. */
export function listItems(html: unknown): string[] {
	if (typeof html !== "string" || !html.trim()) return [];
	const source = html.slice(0, 50_000);
	const items = [...source.matchAll(/<li\b[^>]*>([\s\S]*?)(?=<\/li\s*>|<li\b|<\/[uo]l\s*>|$)/gi)].map((m) => textOf(m[1] as string));
	const list = items.length ? items : source.split(/<br\s*\/?>|<\/p\s*>|\n/i).map((t) => textOf(t));
	return list.filter(Boolean);
}

const SCHEMA_TYPES: Record<string, string> = { product: "Product", software: "SoftwareApplication", softwareapplication: "SoftwareApplication", book: "Book" };

/** `"macOS","Windows"` (the WordPress field held a JSON array body) → "macOS, Windows". */
export function operatingSystems(value: unknown): string {
	const text = str(value);
	if (!text) return "";
	try {
		const list = JSON.parse(`[${text}]`) as unknown;
		if (Array.isArray(list)) return list.map((v) => str(v)).filter(Boolean).join(", ");
	} catch {
		// Not JSON: use it as written.
	}
	return text.replace(/"/g, "").replace(/\s*,\s*/g, ", ");
}

/** Coywolf Custom Blocks' review (or wellbeing's review marker) → coywolf-review. */
export function reviewBlock(a: Record<string, unknown>): Block | null {
	const name = textOf(str(a.name));
	if (!name && !str(a.rating)) return null;
	const explicit = SCHEMA_TYPES[str(a["schema-type"]).toLowerCase()];
	const isBook = Boolean(str(a.author) || str(a.isbn) || str(a.publisher) || str(a.genre));
	const isSoftware = Boolean(operatingSystems(a.os) || str(a.category));
	// WordPress picked the type from the post's category when the field was left at its default.
	const itemType = explicit && explicit !== "Product" ? explicit : isBook ? "Book" : isSoftware ? "SoftwareApplication" : "Product";
	const block: Block = {
		_type: "coywolf-review",
		itemName: name,
		itemType,
		// Exact, to one decimal (4.7 stays 4.7), in the block's menu format.
		rating: ratingValue(a.rating),
		pros: listItems(a.strengths).join("\n"),
		cons: listItems(a.shortcomings).join("\n"),
		headingLevel: "2",
	};
	const brand = textOf(str(a.brand));
	if (brand) block.brand = brand;
	const url = str(a.id) || str(a.url);
	if (/^https?:\/\/\S+$/i.test(url)) block.itemUrl = url;
	if (itemType === "Book") {
		if (str(a.author)) block.bookAuthor = textOf(str(a.author));
		if (str(a.isbn)) block.isbn = str(a.isbn);
		if (str(a.publisher)) block.bookPublisher = textOf(str(a.publisher));
		if (str(a.genre)) block.genre = textOf(str(a.genre));
		if (num(a.copyright)) block.copyrightYear = String(num(a.copyright));
	}
	if (itemType === "SoftwareApplication") {
		const os = operatingSystems(a.os);
		if (os) block.operatingSystem = os;
		if (str(a.category)) block.applicationCategory = textOf(str(a.category));
	}
	return block;
}

// ── Table of contents ────────────────────────────────────────────

/** Coywolf SEO's table-of-contents attributes → coywolf-toc (WordPress defaults made explicit). */
export function tocBlock(a: Record<string, unknown>): Block {
	const levels = Array.isArray(a.levels) ? a.levels.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 2 && n <= 6) : [];
	const style = str(a.listStyle);
	const block: Block = {
		_type: "coywolf-toc",
		levels: (levels.length ? levels : [2, 3]).map(String),
		listStyle: style === "disc" ? "bulleted" : style === "decimal" ? "numbered" : "none",
		display: a.initiallyCollapsed === true ? "collapsed" : a.collapsible === true ? "collapsible" : "open",
		showTitle: a.showTitle === false ? "hide" : "show",
	};
	const title = textOf(str(a.title));
	if (title) block.title = title;
	return block;
}

// ── Files ────────────────────────────────────────────────────────

/** Coywolf Files' coywolf/file → coywolf-file. The id stays the WordPress file id (see docs/wordpress-import.md for moving the file). */
export function fileBlock(a: Record<string, unknown>, d: FileDefaults): Block | null {
	const id = str(a.fileId);
	if (!/^[0-9a-z]{6,40}$/i.test(id)) return null;
	const block: Block = {
		_type: "coywolf-file",
		id,
		showIcon: bool(a.showIcon) ?? d.showIcon,
		showDescription: bool(a.showDescription) ?? d.showDescription,
		showMeta: bool(a.showMeta) ?? d.showMeta,
		showDownload: bool(a.showDownload) ?? d.showDownload,
		showCopyLink: bool(a.showCopyLink) ?? d.showCopyLink,
	};
	const title = textOf(str(a.title));
	if (title) block.title = title;
	const description = textOf(str(a.description));
	if (description) block.description = description;
	return block;
}

// ── Notes, details, quotes, disclosures (Custom Blocks) ─────────

const NOTE_TITLES: Record<string, string> = { sidenote: "\u{1F4CC} Sidenote", editorsnote: "\u{1F4DD} Editor's Note" };

const unescapeAttr = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Coywolf Custom Blocks' sidenote / editor's note → coywolf-note, with WordPress's title (an H2 with an emoji). */
export function noteBlock(kind: "sidenote" | "editorsnote", attrs: Record<string, unknown>, inner = ""): Block | null {
	// Markers from 0.10.0 had no fields: read the body back from the fallback HTML.
	const text = typeof attrs.text === "string" ? attrs.text : inner.match(/^\s*<aside class="sidenote[^"]*"><h2>[\s\S]*?<\/h2>([\s\S]*)<\/aside>\s*$/)?.[1];
	if (typeof text !== "string" || !text.trim()) return null;
	return { _type: "coywolf-note", variant: kind === "editorsnote" ? "editor" : "note", title: NOTE_TITLES[kind], hideTitle: false, titleTag: "h2", body: text.trim() };
}

/** Transcript, accordion or core Details → coywolf-details. */
export function detailsBlock(kind: "transcript" | "accordion" | "details", attrs: Record<string, unknown>, inner = ""): Block | null {
	let summary = typeof attrs.summary === "string" ? attrs.summary : null;
	let body = typeof attrs.body === "string" ? attrs.body : null;
	let open = attrs.open === true;
	if (summary === null || body === null) {
		const m =
			inner.match(/^\s*<details class="(?:transcript|accordion)"><summary>([\s\S]*?)<\/summary><div class="(?:transcript|accordion)__body">([\s\S]*)<\/div><\/details>\s*$/) ??
			inner.match(/^\s*<details\b([^>]*)>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*)<\/details>\s*$/);
		if (!m) return null;
		if (m.length === 3) [summary, body] = [m[1] as string, m[2] as string];
		else {
			[summary, body] = [m[2] as string, m[3] as string];
			open = /\sopen\b/.test(m[1] as string);
		}
	}
	if (!summary.trim() && !body.trim()) return null;
	const block: Block = { _type: "coywolf-details", variant: kind === "transcript" ? "transcript" : "details", summary: summary.trim(), body: body.trim() };
	if (open) block.open = true;
	return block;
}

/** Coywolf Custom Blocks' blockquote → coywolf-quote (quote, who said it, source URL). */
export function quoteBlock(attrs: Record<string, unknown>, inner = ""): Block | null {
	let quote = typeof attrs.quote === "string" ? attrs.quote : null;
	let cite = typeof attrs.cite === "string" ? attrs.cite : "";
	let url = typeof attrs.url === "string" ? attrs.url : "";
	if (quote === null) {
		const m = inner.match(/^\s*<figure class="wp-custom-blockquote"><blockquote(?: cite="([^"]*)")?>([\s\S]*?)<\/blockquote>(?:<figcaption><cite>([\s\S]*?)<\/cite><\/figcaption>)?<\/figure>\s*$/);
		if (!m) return null;
		[url, quote, cite] = [unescapeAttr(m[1] ?? ""), m[2] as string, m[3] ?? ""];
	}
	if (!quote.trim()) return null;
	const block: Block = { _type: "coywolf-quote", quote: quote.trim() };
	if (cite.trim()) block.citation = cite.trim();
	if (/^https?:\/\/\S+$/i.test(url.trim())) block.sourceUrl = url.trim();
	return block;
}

/** ftc / Genesis disclosure → an affiliate disclosure; amazon → the Amazon Associates one. Both use the site's wording. */
export function disclosureBlock(attrs: Record<string, unknown>): Block {
	return { _type: "coywolf-disclosure", kind: attrs.block === "coywolf-custom-blocks/amazon" ? "amazon" : "affiliate" };
}

/**
 * Coywolf Custom Blocks' testimonial → coywolf-testimonial. Reads the marker's
 * fields, or (markers from 0.10/0.11, which held only WordPress's markup) the
 * fallback HTML. The headshot keeps its WordPress URL.
 */
export function testimonialBlock(attrs: Record<string, unknown>, inner = ""): Block | null {
	let f: { quote: string; name: string; title: string; photo: string; nameUrl: string; titleUrl: string };
	if (typeof attrs.quote === "string") {
		f = { quote: attrs.quote, name: str(attrs.name), title: str(attrs.title), photo: str(attrs.photo), nameUrl: str(attrs.nameUrl), titleUrl: str(attrs.titleUrl) };
	} else {
		const m = inner.match(
			/^\s*<blockquote class="testimonial"><div class="quote"><p><q>([\s\S]*?)<\/q><\/p><\/div><div class="influencer">(?:<img alt="[^"]*" height="60" width="60" src="([^"]*)">)?<p>(?:<a href="([^"]*)">([\s\S]*?)<\/a>|([\s\S]*?))<\/p><p>(?:<a href="([^"]*)">([\s\S]*?)<\/a>|([\s\S]*?))<\/p><\/div><\/blockquote>\s*$/,
		);
		if (!m) return null;
		f = {
			quote: m[1] as string,
			photo: unescapeAttr(m[2] ?? ""),
			nameUrl: unescapeAttr(m[3] ?? ""),
			name: m[4] ?? m[5] ?? "",
			titleUrl: unescapeAttr(m[6] ?? ""),
			title: m[7] ?? m[8] ?? "",
		};
	}
	if (!f.quote.trim()) return null;
	const block: Block = { _type: "coywolf-testimonial", quote: f.quote.trim() };
	// Name and title were printed as HTML on WordPress; the block's fields are plain text.
	const name = textOf(f.name);
	if (name) block.name = name;
	const title = textOf(f.title);
	if (title) block.title = title;
	const url = (v: string) => (/^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : "");
	if (url(f.photo)) block.photo = url(f.photo);
	if (url(f.nameUrl)) block.nameUrl = url(f.nameUrl);
	if (url(f.titleUrl)) block.titleUrl = url(f.titleUrl);
	return block;
}

/** The podcast links block had no fields (its template printed the show's links): it uses the site's links. */
export function podcastBlock(): Block {
	return { _type: "coywolf-podcast", source: "site" };
}

// ── Walking ──────────────────────────────────────────────────────

/** Prism names (Code Block Enhancer) the editor's language list spells differently. */
const PRISM_LANGUAGES: Record<string, string> = { markup: "html", svg: "xml", mathml: "xml" };

const isHeading = (b: Block) => b._type === "block" && typeof b.style === "string" && /^h[1-6]$/.test(b.style);
const validAnchor = (id: string) => id.length <= 120 && /^[\p{L}][\p{L}\p{N}_-]*$/u.test(id);

interface Walk {
	opts: Required<Pick<ConvertOptions, "key">> & { videoDefaults: VideoDefaults; fileDefaults: FileDefaults; customBlocks: CustomBlockSwitches };
	changes: Change[];
	videos: VideoFact[];
	leftovers: Record<string, number>;
}

/** The native block for an imported HTML block, or undefined to leave it. `null` removes it. */
function convertHtmlBlock(block: Block, w: Walk): Block | null | undefined | { anchor: string } {
	const marker: Marker | null = parseMarker(block.html);
	const original = typeof block.originalBlockName === "string" ? block.originalBlockName : null;
	const originalAttrs = (block.originalAttrs && typeof block.originalAttrs === "object" ? block.originalAttrs : null) as Record<string, unknown> | null;
	const name = marker ? (marker.source === "wellbeing" ? `wb:${marker.name}` : marker.name) : original === "coywolf/video" ? "video" : original === "coywolf/file" ? "file" : null;
	const attrs = marker?.attrs ?? originalAttrs ?? {};
	if (!name) {
		if (original && original !== "core/html") w.leftovers[original] = (w.leftovers[original] ?? 0) + 1;
		return undefined;
	}
	const video = (made: { block: Block; fact: VideoFact } | null) => {
		if (!made) return undefined;
		w.videos.push(made.fact);
		return made.block;
	};
	switch (name) {
		case "cloudflare-stream":
			return video(streamVideo(attrs, (attrs.embed as StreamEmbed | null) ?? null));
		case "stream-embed":
			return video(streamVideo({}, (attrs.embed as StreamEmbed | null) ?? null));
		case "wb:cloudflare-stream":
			return video(wellbeingVideo(attrs));
		case "video":
			return video(managerVideo(attrs, w.opts.videoDefaults));
		case "review":
		case "wb:review":
			return reviewBlock(attrs) ?? undefined;
		case "toc":
			return tocBlock(attrs);
		case "file":
			return fileBlock(attrs, w.opts.fileDefaults) ?? undefined;
		case "sidenote":
		case "editorsnote":
			return w.opts.customBlocks.note ? (noteBlock(name, attrs, marker?.inner) ?? leftover(name, w)) : leftover(name, w);
		case "transcript":
		case "accordion":
		case "details":
			return w.opts.customBlocks.details ? (detailsBlock(name, attrs, marker?.inner) ?? leftover(name, w)) : leftover(name, w);
		case "blockquote":
			return w.opts.customBlocks.quote ? (quoteBlock(attrs, marker?.inner) ?? leftover(name, w)) : leftover(name, w);
		case "disclosure":
			return w.opts.customBlocks.disclosure ? disclosureBlock(attrs) : leftover(name, w);
		case "testimonial":
			return w.opts.customBlocks.testimonial ? (testimonialBlock(attrs, marker?.inner) ?? leftover(name, w)) : leftover(name, w);
		case "podcast-links":
			return w.opts.customBlocks.podcast ? podcastBlock() : leftover(name, w);
		case "anchor": {
			const id = decodeHtml(str(attrs.id));
			return validAnchor(id) ? { anchor: id } : null;
		}
		default:
			return leftover(name, w);
	}
}

/** The caption in a "table-caption" marker (prepare step), or null when the block isn't one. */
function tableCaptionMarker(block: Block): string | null {
	const marker = parseMarker(block.html);
	if (marker?.name !== "table-caption" || marker.source !== "coywolf") return null;
	return str(marker.attrs.caption).replace(/\s+/g, " ");
}

/** Leave a marker as it is, counting it for the report. */
function leftover(name: string, w: Walk): undefined {
	w.leftovers[`marker:${name}`] = (w.leftovers[`marker:${name}`] ?? 0) + 1;
	return undefined;
}

function convertArray(blocks: unknown[], w: Walk, depth: number): unknown[] | null {
	let out: unknown[] | null = null;
	let pendingAnchor: string | null = null;
	const set = (i: number, value: unknown) => {
		out ??= blocks.slice();
		out[i] = value;
	};
	const REMOVE = Symbol("remove");
	/** Index of the block just before this one when it's a table (a caption marker attaches to it). */
	let tableBefore: number | null = null;
	for (let i = 0; i < blocks.length; i++) {
		const item = blocks[i];
		const table = tableBefore;
		tableBefore = null;
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			if (Array.isArray(item)) {
				const inner = convertArray(item, w, depth + 1);
				if (inner) set(i, inner);
			}
			continue;
		}
		const block = item as Block;
		if (block._type === "table") tableBefore = i;
		if (block._type === "htmlBlock") {
			const caption = tableCaptionMarker(block);
			if (caption !== null) {
				if (table === null) {
					leftover("table-caption", w);
					continue;
				}
				const current = ((out as unknown[] | null) ?? blocks)[table] as Block;
				if (caption && current.caption !== caption) set(table, { ...current, caption });
				set(i, REMOVE);
				w.changes.push({ from: "table-caption", to: "table", detail: caption || undefined });
				continue;
			}
			const result = convertHtmlBlock(block, w);
			if (result === undefined) continue;
			const from = parseMarker(block.html)?.name ?? String(block.originalBlockName ?? "htmlBlock");
			if (result === null) {
				set(i, REMOVE);
				w.changes.push({ from, to: "removed" });
				continue;
			}
			if ("anchor" in result && typeof result.anchor === "string") {
				pendingAnchor = result.anchor;
				set(i, REMOVE);
				continue;
			}
			const next: Block = { ...(result as Block), _key: typeof block._key === "string" ? block._key : w.opts.key() };
			for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
			set(i, next);
			w.changes.push({ from, to: String(next._type), detail: String(next.uid ?? next.itemName ?? next.id ?? "") || undefined });
			continue;
		}
		if (isHeading(block)) {
			if (pendingAnchor) {
				if (block.anchor !== pendingAnchor) {
					set(i, { ...block, anchor: pendingAnchor });
					w.changes.push({ from: "anchor", to: "heading", detail: pendingAnchor });
				}
				pendingAnchor = null;
			}
			continue;
		}
		if (block._type === "code" && typeof block.language === "string") {
			const lang = PRISM_LANGUAGES[block.language.toLowerCase()];
			if (lang) {
				set(i, { ...block, language: lang });
				w.changes.push({ from: `code:${block.language}`, to: `code:${lang}` });
			}
			continue;
		}
		if (depth < 8) {
			// Nested Portable Text (columns, covers, custom blocks with content arrays).
			let patched: Block | null = null;
			for (const [k, v] of Object.entries(block)) {
				if (!Array.isArray(v) || !v.length) continue;
				const inner = convertArray(v, w, depth + 1);
				if (inner) {
					patched ??= { ...block };
					patched[k] = inner;
				}
			}
			if (patched) set(i, patched);
		}
	}
	// An anchor marker with no heading after it: it was removed (nothing to attach to).
	if (!out) return null;
	return (out as unknown[]).filter((b) => b !== REMOVE);
}

/** An array that looks like Portable Text. */
function isPortableText(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0 && value.every((b) => b && typeof b === "object" && typeof (b as { _type?: unknown })._type === "string");
}

function walkFor(opts: ConvertOptions): Walk {
	return {
		opts: {
			key: opts.key ?? randomKey,
			videoDefaults: { ...VIDEO_MANAGER_DEFAULTS, ...opts.videoDefaults },
			fileDefaults: { ...FILES_DEFAULTS, ...opts.fileDefaults },
			customBlocks: { note: true, details: true, disclosure: true, quote: true, testimonial: true, podcast: true, ...opts.contentBlocks, ...opts.customBlocks },
		},
		changes: [],
		videos: [],
		leftovers: {},
	};
}

/** Convert one Portable Text array. */
export function convertPortableText(blocks: unknown[], opts: ConvertOptions = {}): ConvertResult<unknown[]> {
	const w = walkFor(opts);
	const out = convertArray(blocks, w, 0);
	return { value: out ?? blocks, changed: Boolean(out), changes: w.changes, videos: w.videos, leftovers: w.leftovers };
}

/** Convert every Portable Text field of an entry's data. */
export function convertEntryData(data: Record<string, unknown>, opts: ConvertOptions = {}): ConvertResult<Record<string, unknown>> {
	const w = walkFor(opts);
	let out: Record<string, unknown> | null = null;
	for (const [field, value] of Object.entries(data)) {
		if (!isPortableText(value)) continue;
		const next = convertArray(value, w, 0);
		if (next) {
			out ??= { ...data };
			out[field] = next;
		}
	}
	return { value: out ?? data, changed: Boolean(out), changes: w.changes, videos: w.videos, leftovers: w.leftovers };
}

/** Quick check before the full walk: does this data hold anything to convert? */
export function mightNeedConversion(data: unknown): boolean {
	const json = JSON.stringify(data ?? null);
	return /data-coywolf-wp=|data-wb-block=|"originalBlockName":"coywolf\/|"language":"(?:markup|svg|mathml)"/.test(json);
}

/**
 * Buttondown Drafts: Markdown for the blocks the shared Portable Text
 * converter (src/discovery/markdown.ts) leaves out: the Pack's own blocks,
 * embeds and buttons, and a placeholder (plus a warning) for anything else,
 * so nothing disappears from the email without a trace. The table of contents
 * and breadcrumbs are left out on purpose: they're navigation.
 *
 * Also the one block it writes differently from the shared converter: a
 * table, as an HTML table in Buttondown's own table style (renderTableBlock).
 *
 * Pure (no I/O): what it needs from the site (the post's URL, file details,
 * the Custom Blocks settings, the email image rule) is passed in.
 */
import { BLOCK_TYPES, DEFAULT_DISCLOSURE, DEFAULT_PODCAST, DEFAULT_SUMMARY, type DisclosureSettings, NOTE_VARIANTS, PODCAST_SERVICES, type PodcastSettings, normalizeDetails, normalizeDisclosure, normalizeNote, normalizePodcast, normalizeQuote, normalizeTestimonial } from "../customBlocks/render.js";
import { escapeHtml } from "../customBlocks/rich.js";
import { escapeLineStart, escapeText, safeHref } from "../discovery/markdown.js";
import { formatSize } from "../files/format.js";
import { BLOCK_TYPE as FILE_BLOCK } from "../files/walker.js";
import { BREADCRUMBS_BLOCK } from "../breadcrumbs/stamp.js";
import { TOC_BLOCK } from "../headings/stamp.js";
import { BLOCK_TYPE as REVIEW_BLOCK, decodeEntities, formatRating, normalizeReview } from "../reviews/lib.js";
import { BLOCK_TYPE as VIDEO_BLOCK } from "../videos/lib.js";

// any: Portable Text is untyped JSON.
type Node = Record<string, any>;

/** A file card's download, from File Downloads' records (absolute URL). */
export interface EmailFile {
	name: string;
	size: number;
	href: string;
}

export interface BlockContext {
	/** The post's absolute URL (links that stand in for what email can't show). */
	postUrl: string;
	/** "coywolf.com": the "Read it on …" wording. */
	siteHost: string;
	/** Absolute URL for a site-relative one. */
	absolute: (url: string) => string;
	/** The email image rule (src/buttondown/body.ts emailImage), for video posters. */
	image: (url: string) => string;
	/** File Downloads' files by id (the block holds only the id). */
	files?: ReadonlyMap<string, EmailFile>;
	disclosure?: DisclosureSettings;
	podcast?: PodcastSettings;
	/** Collects a warning for the record. */
	warn: (warning: string) => void;
}

/** Blocks left out without a warning: navigation that means nothing in an email. */
export const NAVIGATION_BLOCKS: ReadonlySet<string> = new Set([TOC_BLOCK, BREADCRUMBS_BLOCK]);

const isRecord = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A link's URL as Markdown takes it: absolute, with spaces and parentheses encoded. Null for anything that isn't http(s), mailto or site-relative. */
export function markdownUrl(url: string, absolute: (url: string) => string): string | null {
	const raw = url.trim();
	if (!raw || /^\s*(javascript|vbscript|data):/i.test(raw)) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^(https?|mailto):/i.test(raw)) return null;
	return absolute(raw).replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c)));
}

const link = (text: string, url: string, ctx: BlockContext) => {
	const href = markdownUrl(url, ctx.absolute);
	return href ? `[${escapeText(text)}](${href})` : escapeText(text);
};

/** Marks in rich text while it's escaped: bold opens and closes, italic opens and closes. Never in the input (control characters are removed first). */
const B_OPEN = "\u0001";
const B_CLOSE = "\u0002";
const I_OPEN = "\u0003";
const I_CLOSE = "\u0004";

/** One paragraph's bold and italic marks as Markdown. The spaces just inside a pair move outside (Markdown needs that); a mark without its pair is dropped (and the double space that can leave). */
function emphasis(paragraph: string): string {
	const pair = (text: string, open: string, close: string, mark: string) =>
		text.replace(new RegExp(`${open}([^${open}${close}]*)${close}`, "g"), (_m, inner: string) => {
			const core = inner.trim();
			if (!core) return inner;
			const lead = inner.slice(0, inner.length - inner.trimStart().length);
			const tail = inner.slice(inner.trimEnd().length);
			return `${lead}${mark}${core}${mark}${tail}`;
		});
	return pair(pair(paragraph, I_OPEN, I_CLOSE, "*"), B_OPEN, B_CLOSE, "**")
		.replace(/[\u0001-\u0004]/g, "")
		.replace(/ {2,}/g, " ");
}

/**
 * The Custom Blocks' rich text (plain text with `[text](url)` links, `**bold**`, and a few HTML tags) as Markdown:
 * links, paragraphs, bold (`**bold**`, `<strong>`, `<b>`) and italic (`<em>`, `<i>`) kept, other markup dropped,
 * everything else escaped so it stays text. A single `*star*` stays text, as on the site (src/customBlocks/rich.ts
 * reads only `**bold**` and links as Markdown).
 */
export function richToMarkdown(input: unknown, ctx: Pick<BlockContext, "absolute">): string {
	let text = str(input)
		.slice(0, 100_000)
		.replace(/[\u0000-\u0008]/g, "");
	if (!text.trim()) return "";
	const links: Array<{ text: string; url: string }> = [];
	const keep = (label: string, url: string) => `\u0000${links.push({ text: label, url }) - 1}\u0000`;
	text = text
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, d: string | undefined, s: string | undefined, label: string) => keep(label.replace(/<[^>]*>/g, ""), decodeEntities(d ?? s ?? "")))
		.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_m, label: string, url: string) => keep(label, url))
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(p|div|ul|ol|h[1-6]|blockquote)\b[^>]*>/gi, "\n\n")
		.replace(/<li\b[^>]*>/gi, "\n")
		.replace(/<(\/?)(strong|b)(?:\s[^>]*)?>/gi, (_m, close: string) => (close ? B_CLOSE : B_OPEN))
		.replace(/<(\/?)(em|i)(?:\s[^>]*)?>/gi, (_m, close: string) => (close ? I_CLOSE : I_OPEN))
		.replace(/<[^>]*>/g, "")
		// The site's own rule for bold (src/customBlocks/rich.ts markdownLite).
		.replace(/\*\*(?=\S)([^*\n]{1,1000}?)\*\*/g, `${B_OPEN}$1${B_CLOSE}`);
	text = decodeEntities(text);
	const lines = text
		.split("\n")
		.map((line) => escapeLineStart(escapeText(line.replace(/\s+/g, " ").trim())))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	// Single line breaks stay line breaks (two spaces), blank lines stay paragraphs.
	return lines
		.split("\n\n")
		.map((p) => emphasis(p).split("\n").join("  \n"))
		.join("\n\n")
		.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => {
			const l = links[Number(n)];
			return l ? link(decodeEntities(l.text).replace(/\s+/g, " ").trim() || l.url, l.url, ctx as BlockContext) : "";
		});
}

/** Markdown as a block quote. */
const quote = (markdown: string) =>
	markdown
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");

const bold = (text: string) => (text ? `**${escapeText(text)}**` : "");
const plain = (rich: unknown) =>
	decodeEntities(
		str(rich)
			.replace(/<[^>]*>/g, " ")
			.replace(/\[([^\]\n]+)\]\([^()\s]+\)/g, "$1")
			.replace(/\*\*([^*\n]+)\*\*/g, "$1"),
	)
		.replace(/\s+/g, " ")
		.trim();

/** A titled box (note, details): the title in bold, then the text, as a block quote. */
function titled(title: string, body: string): string | null {
	const parts = [bold(title), body].filter(Boolean);
	return parts.length ? quote(parts.join("\n\n")) : null;
}

function note(block: Node, ctx: BlockContext): string | null {
	const n = normalizeNote(block);
	const title = n.hideTitle ? "" : plain(n.title) || (NOTE_VARIANTS.find(([v]) => v === n.variant)?.[1] ?? "Note");
	return titled(title, richToMarkdown(n.body, ctx));
}

function details(block: Node, ctx: BlockContext): string | null {
	const d = normalizeDetails(block);
	const body = richToMarkdown(d.body, ctx);
	if (!body && !d.summary) return null;
	return titled(plain(d.summary) || DEFAULT_SUMMARY[d.variant], body);
}

function disclosure(block: Node, ctx: BlockContext): string | null {
	const d = normalizeDisclosure(block);
	const s = ctx.disclosure ?? DEFAULT_DISCLOSURE;
	const text = richToMarkdown(d.text || (d.kind === "amazon" ? s.amazonText : s.affiliateText), ctx);
	if (!text) return null;
	const more = s.linkUrl ? ` ${link(s.linkText || DEFAULT_DISCLOSURE.linkText, s.linkUrl, ctx)}` : "";
	return quote(`_${text}_${more}`);
}

function quoteBlock(block: Node, ctx: BlockContext): string | null {
	const q = normalizeQuote(block);
	const body = richToMarkdown(q.quote, ctx);
	if (!body) return null;
	const by = richToMarkdown(q.citation, ctx);
	return quote(by ? `${body}\n\n— ${by}` : body);
}

function testimonial(block: Node, ctx: BlockContext): string | null {
	const t = normalizeTestimonial(block);
	const body = richToMarkdown(t.quote, ctx);
	if (!body) return null;
	const name = t.name ? (t.nameUrl ? link(t.name, t.nameUrl, ctx) : escapeText(t.name)) : "";
	const role = t.title ? (t.titleUrl ? link(t.title, t.titleUrl, ctx) : escapeText(t.title)) : "";
	const who = [name, role].filter(Boolean).join(", ");
	return quote(who ? `${body}\n\n— ${who}` : body);
}

function podcast(block: Node, ctx: BlockContext): string | null {
	const p = normalizePodcast(block);
	const s = ctx.podcast ?? DEFAULT_PODCAST;
	const links = p.source === "block" ? p.links : s.links;
	const items = PODCAST_SERVICES.filter(([svc]) => links[svc]).map(([svc, label]) => `- ${link(label, links[svc], ctx)}`);
	if (!items.length) return null;
	return `${bold(p.heading || s.heading)}\n\n${items.join("\n")}`;
}

function review(block: Node): string | null {
	const r = normalizeReview(block);
	if (!r) return null;
	const out: string[] = [];
	if (r.itemName) out.push(bold(r.itemName));
	if (r.rating !== null) out.push(`Rating: ${formatRating(r.rating)} / 5`);
	if (r.pros.length) out.push(`${bold(r.prosHeading)}\n\n${r.pros.map((p) => `- ${escapeText(p)}`).join("\n")}`);
	if (r.cons.length) out.push(`${bold(r.consHeading)}\n\n${r.cons.map((c) => `- ${escapeText(c)}`).join("\n")}`);
	if (r.summary) out.push(escapeLineStart(escapeText(r.summary)));
	return out.join("\n\n") || null;
}

function video(block: Node, ctx: BlockContext): string {
	const title = str(block.title).replace(/\s+/g, " ").trim();
	const watch = `[▶ ${escapeText(title ? `Watch the video: ${title}` : "Watch the video")}](${markdownUrl(ctx.postUrl, ctx.absolute) ?? ""})`;
	const posterRaw = str(block.posterImage).trim();
	const poster = posterRaw ? markdownUrl(ctx.image(posterRaw), ctx.absolute) : null;
	return poster ? `[![${escapeText(title || "Video")}](${poster})](${markdownUrl(ctx.postUrl, ctx.absolute) ?? ""})\n\n${watch}` : watch;
}

function fileCard(block: Node, ctx: BlockContext): string {
	const id = str(block.id).trim();
	const file = id ? ctx.files?.get(id) : undefined;
	const title = str(block.title).replace(/\s+/g, " ").trim() || file?.name || "the file";
	if (!file) return link(`Download: ${title}`, ctx.postUrl, ctx);
	const size = file.size > 0 ? ` (${formatSize(file.size)})` : "";
	return link(`Download: ${title}${size}`, file.href, ctx);
}

/**
 * A video player's address as the page a reader can open: a YouTube embed (youtube.com or youtube-nocookie.com,
 * /embed/<id>) as its watch page, a Vimeo one (player.vimeo.com/video/<id>) as its video page. Anything else as it is.
 */
export function watchUrl(url: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return url;
	}
	if (!/^https?:$/.test(u.protocol)) return url;
	const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
	if (host === "youtube.com" || host === "youtube-nocookie.com") {
		const id = /^\/embed\/([A-Za-z0-9_-]{6,20})\/?$/.exec(u.pathname)?.[1];
		// A playlist or live-stream player has no video id of its own.
		if (!id || id === "videoseries" || id === "live_stream") return url;
		const start = u.searchParams.get("start") ?? "";
		return `https://www.youtube.com/watch?v=${id}${/^[1-9]\d{0,6}$/.test(start) ? `&t=${start}s` : ""}`;
	}
	if (host === "player.vimeo.com") {
		const id = /^\/video\/(\d{1,20})\/?$/.exec(u.pathname)?.[1];
		if (!id) return url;
		// An unlisted video's key.
		const h = u.searchParams.get("h") ?? "";
		return `https://vimeo.com/${id}${/^[0-9a-f]{6,40}$/i.test(h) ? `/${h}` : ""}`;
	}
	return url;
}

/** An embed, button, iframe or core file block: its label (or URL) as a link. Null when it has no usable URL. An embed or iframe of a video player links to the video's own page (watchUrl). */
function linkBlock(block: Node, ctx: BlockContext): string | null {
	const raw = [block.url, block.href, block.src, typeof block.link === "string" ? block.link : block.link?.href].map(str).find((u) => u.trim());
	if (!raw || !markdownUrl(raw, ctx.absolute)) return null;
	const type = str(block._type);
	const url = type === "embed" || type === "iframe" ? watchUrl(ctx.absolute(raw.trim())) : raw;
	const label = [block.text, block.label, block.title, block.name, block.caption].map(str).find((t) => t.trim())?.replace(/\s+/g, " ").trim();
	return link(label || url.trim(), url, ctx);
}

/** The placeholder for a block email can't show: a link to the post, and a warning naming the block type. */
function placeholder(block: Node, ctx: BlockContext): string {
	const type = str(block._type).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 60) || "unknown";
	ctx.warn(`block:${type}`);
	return `_${link(`Part of this post isn't shown in email. Read it on ${ctx.siteHost}.`, ctx.postUrl, ctx)}_`;
}

/** Markdown for a block the shared converter doesn't know, or null to leave it out. */
export function renderUnknownBlock(block: Node, ctx: BlockContext): string | null {
	const type = str(block._type);
	if (NAVIGATION_BLOCKS.has(type)) return null;
	switch (type) {
		case BLOCK_TYPES.note:
			return note(block, ctx);
		case BLOCK_TYPES.details:
			return details(block, ctx);
		case BLOCK_TYPES.disclosure:
			return disclosure(block, ctx);
		case BLOCK_TYPES.quote:
			return quoteBlock(block, ctx);
		case BLOCK_TYPES.testimonial:
			return testimonial(block, ctx);
		case BLOCK_TYPES.podcast:
			return podcast(block, ctx);
		case REVIEW_BLOCK:
			return review(block);
		case VIDEO_BLOCK:
			return video(block, ctx);
		case FILE_BLOCK:
			return fileCard(block, ctx);
		case "embed":
		case "button":
		case "iframe":
		case "file":
			return linkBlock(block, ctx) ?? placeholder(block, ctx);
		default:
			return placeholder(block, ctx);
	}
}

/** Buttondown styles only its own tables (borders, cell padding, a shaded header), which carry this class. */
export const TABLE_CLASS = "buttondown-block-styled";

/** A table cell's spans as HTML (Markdown isn't read inside an HTML block): marks, links, and line breaks as `<br>`. */
function cellHtml(cell: Node, tableDefs: unknown, absolute: (url: string) => string): string {
	const defs = new Map<string, Node>();
	for (const def of [...(Array.isArray(tableDefs) ? tableDefs : []), ...(Array.isArray(cell.markDefs) ? cell.markDefs : [])]) if (isRecord(def) && typeof def._key === "string") defs.set(def._key, def);
	const children: unknown[] = Array.isArray(cell.content) ? cell.content : Array.isArray(cell.children) ? cell.children : [];
	let out = "";
	for (const child of children) {
		if (!isRecord(child)) continue;
		if (child._type !== "span") {
			if (child._type === "break") out += "<br>";
			continue;
		}
		const raw = typeof child.text === "string" ? child.text : "";
		if (!raw) continue;
		const marks: string[] = Array.isArray(child.marks) ? child.marks.filter((m: unknown): m is string => typeof m === "string") : [];
		let html = raw.split(/\r\n|\r|\n/).map(escapeHtml).join("<br>");
		if (raw.trim()) {
			if (marks.includes("code")) html = `<code>${html}</code>`;
			if (marks.includes("strike-through")) html = `<s>${html}</s>`;
			if (marks.includes("em")) html = `<em>${html}</em>`;
			if (marks.includes("strong")) html = `<strong>${html}</strong>`;
		}
		for (const mark of marks) {
			const def = defs.get(mark);
			if (!def || (def._type !== "link" && typeof def.href !== "string")) continue;
			// The shared converter's rule: absolute, and no javascript:, vbscript: or data: link.
			const href = safeHref(def.href, { absolute });
			if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
		}
		out += html;
	}
	return out.trim();
}

/**
 * A table block as an HTML table in Buttondown's own table style. A Markdown pipe table comes out of Buttondown
 * with no borders and no cell padding (seen in a test email, 2026-11-15): its email CSS styles only
 * `table.buttondown-block-styled`.
 *
 * - The header row is the first row, as in the shared converter's pipe table: `<thead>` and `<th>`. The other rows
 *   are `<tbody>` and `<td>`.
 * - One HTML block, which Markdown leaves alone: no blank line and no indent inside it, each cell on its own line
 *   (template code is escaped cell by cell there: src/buttondown/template.ts escapeTemplateTable).
 * - A cell that spans columns keeps its `colspan`. A short row is filled with empty cells.
 */
export function renderTableBlock(block: Node, ctx: Pick<BlockContext, "absolute">): string | null {
	const rows: Node[] = Array.isArray(block.rows) ? block.rows.filter(isRecord) : [];
	const grid = rows.map((row) =>
		(Array.isArray(row.cells) ? row.cells.filter(isRecord) : []).map((cell: Node) => ({
			html: cellHtml(cell, block.markDefs, ctx.absolute),
			span: typeof cell.colspan === "number" && cell.colspan > 1 ? Math.min(Math.floor(cell.colspan), 100) : 1,
		})),
	);
	const width = Math.max(0, ...grid.map((cells) => cells.reduce((sum, cell) => sum + cell.span, 0)));
	if (!width) return null;
	const row = (cells: { html: string; span: number }[], tag: "th" | "td") => {
		const used = cells.reduce((sum, cell) => sum + cell.span, 0);
		const filled = [...cells, ...Array.from({ length: width - used }, () => ({ html: "", span: 1 }))];
		return ["<tr>", ...filled.map((cell) => `<${tag}${cell.span > 1 ? ` colspan="${cell.span}"` : ""}>${cell.html}</${tag}>`), "</tr>"];
	};
	const [head = [], ...body] = grid;
	return [`<table class="${TABLE_CLASS}">`, "<thead>", ...row(head, "th"), "</thead>", ...(body.length ? ["<tbody>", ...body.flatMap((cells) => row(cells, "td")), "</tbody>"] : []), "</table>"].join("\n");
}

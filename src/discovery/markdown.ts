/**
 * Portable Text → Markdown, for the per-page Markdown sources served at
 * `<entry-url>/index.html.md` (the llmstxt.org convention, as in Coywolf SEO).
 *
 * Pure and dependency-free so it can be unit-tested with `node --test`.
 * Handles the core block types EmDash's editor writes: text blocks
 * (paragraphs, headings h1–h6, blockquotes, bullet and numbered lists at any
 * depth, with strong/em/code/strike-through and link marks), images, code,
 * horizontal breaks, and tables. Anything else (embeds, buttons, custom
 * plugin blocks) is skipped rather than guessed at.
 */
import { cdnOriginalUrl } from "../images/lib.js";

// any: Portable Text is untyped JSON.
type Node = Record<string, any>;

export interface MarkdownOptions {
	/** Turn a site-relative href or media URL into an absolute one. Default: unchanged. */
	absolute?: (url: string) => string;
}

export interface Frontmatter {
	[key: string]: string | string[] | undefined;
}

const HEADING = /^h([1-6])$/;
const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|data):/i;

const isRecord = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

/** Escape characters that would otherwise turn plain text into Markdown syntax. */
export function escapeText(text: string): string {
	return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

/**
 * Escape a line's leading characters that would start a block: headings,
 * quotes, list markers, code fences (``` or ~~~), and thematic breaks or
 * setext underlines (runs of 3+ "-", "*", "_" or "=", optionally spaced).
 */
export function escapeLineStart(line: string): string {
	// Thematic break / setext underline: the whole line is one repeated marker.
	if (/^\s*([-*_=])(\s*\1){2,}\s*$/.test(line)) return line.replace(/^(\s*)(\S)/, "$1\\$2");
	// Fenced code: ``` is already escaped by escapeText; ~~~ is not.
	if (/^\s*~{3,}/.test(line)) return line.replace(/^(\s*)~/, "$1\\~");
	return line.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/, (_m, space: string, marker: string) => `${space}${marker.replace(/([#>+\-.)])/, "\\$1")}`);
}

function safeHref(href: unknown, options: MarkdownOptions): string | null {
	if (typeof href !== "string" || !href.trim() || DANGEROUS_SCHEME.test(href)) return null;
	const url = options.absolute ? options.absolute(href.trim()) : href.trim();
	return url.replace(/[()\s]/g, (c) => encodeURIComponent(c));
}

/** Inline content of a text block (or table cell): spans with marks and link annotations. */
export function renderSpans(children: unknown, markDefs: unknown, options: MarkdownOptions = {}): string {
	if (!Array.isArray(children)) return "";
	const defs = new Map<string, Node>();
	if (Array.isArray(markDefs)) for (const def of markDefs) if (isRecord(def) && typeof def._key === "string") defs.set(def._key, def);

	let out = "";
	for (const child of children) {
		if (!isRecord(child)) continue;
		if (child._type !== "span") {
			// Inline objects (e.g. a hard break) — keep a break, skip the rest.
			if (child._type === "break") out += "  \n";
			continue;
		}
		const raw = typeof child.text === "string" ? child.text : "";
		if (!raw) continue;
		const marks: string[] = Array.isArray(child.marks) ? child.marks.filter((m: unknown): m is string => typeof m === "string") : [];

		const isCode = marks.includes("code");
		let text = isCode ? codeSpan(raw) : raw.split("\n").map(escapeText).join("  \n");
		if (!isCode && text.trim()) {
			// Keep surrounding whitespace outside the emphasis markers so `** bold**` never happens.
			const lead = text.match(/^\s*/)?.[0] ?? "";
			const trail = text.match(/\s*$/)?.[0] ?? "";
			let core = text.slice(lead.length, text.length - trail.length);
			if (marks.includes("strike-through")) core = `~~${core}~~`;
			if (marks.includes("em")) core = `_${core}_`;
			if (marks.includes("strong")) core = `**${core}**`;
			text = lead + core + trail;
		}
		for (const mark of marks) {
			const def = defs.get(mark);
			if (def && (def._type === "link" || typeof def.href === "string")) {
				const href = safeHref(def.href, options);
				if (href) text = `[${text}](${href})`;
			}
		}
		out += text;
	}
	return out;
}

function codeSpan(text: string): string {
	const runs = text.match(/`+/g) ?? [];
	const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

function renderCode(block: Node): string | null {
	const code = typeof block.code === "string" ? block.code : "";
	if (!code) return null;
	const runs = code.match(/`{3,}/g) ?? [];
	const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
	const language = typeof block.language === "string" ? block.language.replace(/[^\w+#.-]/g, "") : "";
	const filename = typeof block.filename === "string" && block.filename.trim() ? `${escapeText(block.filename.trim())}\n\n` : "";
	return `${filename}${fence}${language}\n${code.replace(/\n+$/, "")}\n${fence}`;
}

/**
 * The same URL resolution EmDash's image renderer uses for local media, then the original on the media host
 * when there is one (as the pack's pages print it), so Markdown readers and crawlers get the public host.
 */
function imageUrl(block: Node): string | null {
	const asset = isRecord(block.asset) ? block.asset : {};
	const url = typeof asset.url === "string" && asset.url ? asset.url : typeof asset.src === "string" && asset.src ? asset.src : null;
	const key = isRecord(asset.meta) && typeof asset.meta.storageKey === "string" ? asset.meta.storageKey : null;
	const local = url ?? (key ? `/_emdash/api/media/file/${key.split("/").map(encodeURIComponent).join("/")}` : null);
	return local ? (cdnOriginalUrl(local) ?? local) : null;
}

function renderImage(block: Node, options: MarkdownOptions): string | null {
	const src = safeHref(imageUrl(block), options);
	if (!src) return null;
	const asset = isRecord(block.asset) ? block.asset : {};
	const altRaw = typeof block.alt === "string" ? block.alt : typeof asset.alt === "string" ? asset.alt : "";
	const alt = altRaw.replace(/[\r\n]+/g, " ").replace(/([\\[\]])/g, "\\$1");
	let out = `![${alt}](${src})`;
	const link = typeof block.link === "string" ? block.link : isRecord(block.link) ? block.link.href : null;
	const href = safeHref(link, options);
	if (href) out = `[${out}](${href})`;
	const caption = typeof block.caption === "string" ? block.caption.trim() : "";
	if (caption) out += `\n\n_${escapeText(caption.replace(/\s+/g, " "))}_`;
	return out;
}

function cellText(cell: Node, tableDefs: unknown, options: MarkdownOptions): string {
	const defs = [...(Array.isArray(tableDefs) ? tableDefs : []), ...(Array.isArray(cell.markDefs) ? cell.markDefs : [])];
	const content = Array.isArray(cell.content) ? cell.content : Array.isArray(cell.children) ? cell.children : [];
	return renderSpans(content, defs, options).replace(/ {2}\n|\n/g, "<br>").replace(/\|/g, "\\|").trim();
}

function renderTable(block: Node, options: MarkdownOptions): string | null {
	const rows: Node[] = Array.isArray(block.rows) ? block.rows.filter(isRecord) : [];
	const grid: string[][] = [];
	for (const row of rows) {
		const cells: Node[] = Array.isArray(row.cells) ? row.cells.filter(isRecord) : [];
		const line: string[] = [];
		for (const cell of cells) {
			line.push(cellText(cell, block.markDefs, options));
			const span = typeof cell.colspan === "number" && cell.colspan > 1 ? Math.min(cell.colspan, 100) : 1;
			for (let i = 1; i < span; i++) line.push("");
		}
		grid.push(line);
	}
	if (!grid.length) return null;
	const width = Math.max(...grid.map((r) => r.length));
	if (!width) return null;
	const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
	const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
	// GFM tables need a header row: use the first row (the editor's header row when it has one).
	const [head, ...body] = grid;
	return [line(head), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

interface ListState {
	/** Numbering counters per nesting level for numbered lists. */
	counters: number[];
}

function renderListItem(block: Node, state: ListState, options: MarkdownOptions): string {
	const level = typeof block.level === "number" && block.level > 0 ? Math.min(block.level, 10) : 1;
	state.counters.length = level;
	const numbered = block.listItem === "number";
	let marker = "-";
	if (numbered) {
		state.counters[level - 1] = (state.counters[level - 1] ?? 0) + 1;
		marker = `${state.counters[level - 1]}.`;
	} else {
		state.counters[level - 1] = 0;
	}
	const indent = "   ".repeat(level - 1);
	const text = renderSpans(block.children, block.markDefs, options);
	const continuation = `${indent}${" ".repeat(marker.length + 1)}`;
	return `${indent}${marker} ${text.split("\n").join(`\n${continuation}`)}`;
}

function renderTextBlock(block: Node, options: MarkdownOptions): string | null {
	const text = renderSpans(block.children, block.markDefs, options);
	if (!text.trim()) return null;
	const style = typeof block.style === "string" ? block.style : "normal";
	const heading = HEADING.exec(style);
	if (heading) return `${"#".repeat(Number(heading[1]))} ${text.replace(/ {2}\n/g, " ").trim()}`;
	if (style === "blockquote") return text.split("\n").map((l) => `> ${l}`).join("\n");
	return text.split("\n").map(escapeLineStart).join("\n");
}

/**
 * Serialize a Portable Text array to Markdown. Blocks are separated by a
 * blank line; consecutive list items form one list.
 */
export function portableTextToMarkdown(value: unknown, options: MarkdownOptions = {}): string {
	const blocks: unknown[] = typeof value === "string" ? safeParse(value) : Array.isArray(value) ? value : [];
	const parts: string[] = [];
	let list: string[] | null = null;
	const listState: ListState = { counters: [] };

	const closeList = () => {
		if (list?.length) parts.push(list.join("\n"));
		list = null;
		listState.counters = [];
	};

	for (const block of blocks) {
		if (!isRecord(block)) continue;
		if (block._type === "block" && typeof block.listItem === "string") {
			list ??= [];
			list.push(renderListItem(block, listState, options));
			continue;
		}
		closeList();
		let rendered: string | null = null;
		switch (block._type) {
			case "block":
				rendered = renderTextBlock(block, options);
				break;
			case "image":
				rendered = renderImage(block, options);
				break;
			case "code":
				rendered = renderCode(block);
				break;
			case "break":
				rendered = "---";
				break;
			case "table":
				rendered = renderTable(block, options);
				break;
			default:
				rendered = null; // Unknown block types are skipped.
		}
		if (rendered) parts.push(rendered);
	}
	closeList();
	return parts.join("\n\n").trim();
}

function safeParse(text: string): unknown[] {
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** YAML frontmatter with double-quoted scalars (matches Coywolf SEO's .md output). */
export function frontmatter(fields: Frontmatter): string {
	const yaml = (value: string) => `"${value.replace(/\r\n|\r|\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	const lines = ["---"];
	for (const [key, value] of Object.entries(fields)) {
		if (Array.isArray(value)) {
			if (!value.length) continue;
			lines.push(`${key}:`);
			for (const item of value) lines.push(`  - ${yaml(item)}`);
		} else if (typeof value === "string" && value.trim()) {
			lines.push(`${key}: ${yaml(value)}`);
		}
	}
	lines.push("---");
	return `${lines.join("\n")}\n`;
}

/** Rough token count: ~4 characters per token (the same heuristic Coywolf SEO uses for X-Markdown-Tokens). */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil([...text].length / 4));
}

/** `<page-url>/index.html.md`, the llmstxt.org convention Coywolf SEO uses. */
export function markdownUrl(pageUrl: string): string {
	const url = new URL(pageUrl);
	url.search = "";
	url.hash = "";
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	url.pathname += "index.html.md";
	return url.href;
}

/** The page path an `.../index.html.md` request is for, or null when the path isn't one. */
export function pagePathFromMarkdownPath(pathname: string): string | null {
	if (!pathname.endsWith("/index.html.md")) return null;
	const page = pathname.slice(0, -"index.html.md".length);
	return page || "/";
}

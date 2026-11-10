/**
 * Rich text for the Custom Blocks' text fields. EmDash block fields are
 * plain text inputs, so a field holds simple markup that's turned into safe
 * HTML here:
 *
 * - A blank line starts a new paragraph; a single line break is a <br>.
 * - `[link text](https://…)` is a link and `**text**` is bold.
 * - A small set of HTML tags is kept (links, bold, italics, code, <abbr>,
 *   <q>, lists, paragraphs, headings, images, …), so content imported from
 *   WordPress keeps its exact markup. Their attributes are limited to safe ones
 *   (href, title, rel, cite, src, alt, …), URLs to http(s), mailto, tel and
 *   site-relative ones, and inline styles to text styling (color, font size,
 *   weight, …) with plain values.
 * - Any other tag is dropped (its text stays; <script> and <style> bodies go),
 *   stray "<" and "&" are escaped, and tags left open are closed, so a field
 *   can't break the page around it.
 *
 * Pure, no imports: runs in the Worker, the admin and tests.
 */

type Attrs = Record<string, string>;

interface TagRule {
	/** Allowed attributes (others are dropped). */
	attrs?: string[];
	/** Block-level: ends the current paragraph, not allowed in inline fields. */
	block?: boolean;
	void?: boolean;
}

const RULES: Record<string, TagRule> = {
	a: { attrs: ["href", "title", "rel", "hreflang"] },
	abbr: { attrs: ["title"] },
	b: {},
	strong: {},
	i: {},
	em: {},
	u: {},
	s: {},
	del: {},
	ins: {},
	mark: {},
	small: {},
	sub: {},
	sup: {},
	code: {},
	kbd: {},
	samp: {},
	var: {},
	cite: {},
	dfn: { attrs: ["title"] },
	q: { attrs: ["cite"] },
	time: { attrs: ["datetime"] },
	span: { attrs: ["lang", "dir"] },
	br: { void: true },
	wbr: { void: true },
	p: { block: true },
	ul: { block: true },
	ol: { block: true, attrs: ["start", "reversed", "type"] },
	li: { block: true, attrs: ["value"] },
	dl: { block: true },
	dt: { block: true },
	dd: { block: true },
	blockquote: { block: true, attrs: ["cite"] },
	pre: { block: true },
	figure: { block: true },
	figcaption: { block: true },
	h2: { block: true },
	h3: { block: true },
	h4: { block: true },
	h5: { block: true },
	h6: { block: true },
	hr: { block: true, void: true },
	img: { block: true, void: true, attrs: ["src", "alt", "width", "height", "loading", "decoding", "title"] },
};

const URL_ATTRS = new Set(["href", "src", "cite"]);
const REL_TOKENS = new Set(["nofollow", "sponsored", "ugc", "noopener", "noreferrer", "external", "me", "author", "license", "tag"]);
const DROP_BODY = new Set(["script", "style", "template", "noscript", "iframe", "object", "textarea", "title", "svg", "math"]);

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => String(text).replace(/[&<>"']/g, (c) => ESC[c] as string);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode the entities an attribute value may hold (enough to check a URL's scheme). */
function decodeAttr(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
		}
		return NAMED[code.toLowerCase()] ?? whole;
	});
}

/** A link or image URL that's safe to print: http(s), mailto, tel, or relative. Null otherwise. */
export function safeUrl(value: string): string | null {
	// Control characters in the pattern: browsers ignore these inside a scheme.
	const url = decodeAttr(value).replace(/[\u0000- \u007f]+/g, (m, i: number) => (i === 0 ? "" : m)).trim();
	if (!url || url.length > 2000) return null;
	// Control characters in the pattern: see above.
	const scheme = url.replace(/[\u0000- \u007f]/g, "").match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
	if (scheme && !["http", "https", "mailto", "tel"].includes(scheme)) return null;
	return url;
}

/** Escape text, keeping valid entity references (&amp; &#8217; &nbsp; …) as written. */
function text(chunk: string): string {
	return chunk.replace(/&(?!(?:#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `[text](url)` links and `**bold**` inside an escaped text run. */
function markdownLite(escaped: string): string {
	return escaped
		.replace(/\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)/g, (whole, label: string, href: string) => {
			const url = safeUrl(href);
			return url ? `<a href="${escapeHtml(url)}">${label}</a>` : whole;
		})
		.replace(/\*\*(?=\S)([^*\n]{1,1000}?)\*\*/g, "<strong>$1</strong>");
}

/**
 * One tag (or comment). Attribute names can't contain `<`, so a tag that never
 * closes stops being a candidate at the next `<`: with `<` allowed, every
 * unclosed `<a b c …` was scanned to the end of the field again from each
 * `<`, a quadratic case (80,000 characters took 4 seconds; fields take up to
 * 500,000). Quoted values may still contain `<`.
 */
const TAG = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const STYLE_PROPS = new Set(["color", "background-color", "font-size", "font-weight", "font-style", "font-variant", "text-decoration", "text-transform", "text-align", "letter-spacing", "white-space"]);

/** Inline styles WordPress content uses for emphasis (color, size, weight, …); anything else is dropped. */
export function cleanStyle(value: string): string {
	return value
		.split(";")
		.map((decl) => {
			const at = decl.indexOf(":");
			if (at < 0) return "";
			const prop = decl.slice(0, at).trim().toLowerCase();
			const val = decl.slice(at + 1).trim();
			if (!STYLE_PROPS.has(prop) || !val || val.length > 60) return "";
			if (!/^[#a-z0-9.%,\s()-]+$/i.test(val) || /url|expression|image|var|attr|env/i.test(val)) return "";
			return `${prop}:${val}`;
		})
		.filter(Boolean)
		.join(";");
}

function cleanAttrs(name: string, raw: string): string {
	const allowed = [...(RULES[name]?.attrs ?? []), ...(RULES[name]?.void ? [] : ["style"])];
	if (!allowed.length || !raw.trim()) return "";
	const out: Attrs = {};
	for (const m of raw.matchAll(ATTR)) {
		const key = (m[1] as string).toLowerCase();
		if (!allowed.includes(key) || key in out) continue;
		let value = decodeAttr(m[2] ?? m[3] ?? m[4] ?? "");
		if (URL_ATTRS.has(key)) {
			const url = safeUrl(value);
			if (!url) continue;
			value = url;
		} else if (key === "rel") {
			value = value
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => REL_TOKENS.has(t))
				.join(" ");
			if (!value) continue;
		} else if (["width", "height", "start", "value"].includes(key)) {
			if (!/^-?\d{1,6}$/.test(value.trim())) continue;
			value = value.trim();
		} else if (key === "loading" || key === "decoding") {
			if (!["lazy", "eager", "async", "sync", "auto"].includes(value)) continue;
		} else if (key === "reversed") {
			value = "";
		} else if (key === "style") {
			value = cleanStyle(value);
			if (!value) continue;
		}
		out[key] = value.slice(0, 2000);
	}
	if (name === "img" && !out.src) return "\u0000";
	return Object.entries(out)
		.map(([k, v]) => (k === "reversed" ? " reversed" : ` ${k}="${escapeHtml(v)}"`))
		.join("");
}

export interface RichOptions {
	/** One line of inline content (titles, citations): no paragraphs or block tags; line breaks become <br>. */
	inline?: boolean;
}

/**
 * Turn a field's text into safe HTML. Block content gets paragraphs (text that
 * isn't already inside a <p>, list, … is wrapped); inline content doesn't.
 */
export function renderRich(input: unknown, opts: RichOptions = {}): string {
	if (typeof input !== "string" || !input.trim()) return "";
	const source = input
		.slice(0, 500_000)
		.replace(/\r\n?/g, "\n")
		// Control characters in the pattern: strip control characters (keep tab and newline).
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	const inline = Boolean(opts.inline);
	let out = "";
	/** Open allowed elements, outermost first. */
	const stack: string[] = [];
	/** The paragraph being collected at the top level (block mode). */
	let para = "";
	let paraOpen: string[] = [];
	let skipUntil: string | null = null;

	const blockOpen = () => stack.some((t) => RULES[t]?.block);
	const flush = () => {
		// Close inline tags opened in this paragraph, then emit it.
		while (paraOpen.length) para += `</${paraOpen.pop()}>`;
		const body = para.replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, "");
		if (body) out += `<p>${body}</p>`;
		para = "";
	};
	const emitText = (chunk: string) => {
		if (!chunk) return;
		if (inline) {
			out += markdownLite(text(chunk)).replace(/\n+/g, "<br>");
			return;
		}
		if (blockOpen()) {
			out += markdownLite(text(chunk));
			return;
		}
		const parts = chunk.split(/\n[ \t]*\n\s*/);
		parts.forEach((part, i) => {
			if (i > 0) flush();
			para += markdownLite(text(part)).replace(/\n/g, "<br>");
		});
	};
	const emitTag = (html: string, name: string, kind: "open" | "close" | "void") => {
		const rule = RULES[name] as TagRule;
		if (inline || blockOpen() || rule.block) {
			if (!inline && rule.block && !blockOpen()) flush();
			out += html;
			if (kind === "open") stack.push(name);
			return;
		}
		// An inline tag at the top level belongs to the current paragraph.
		para += html;
		if (kind === "open") paraOpen.push(name);
		else if (kind === "close") paraOpen.splice(paraOpen.lastIndexOf(name), 1);
	};

	let last = 0;
	TAG.lastIndex = 0;
	for (let m = TAG.exec(source); m; m = TAG.exec(source)) {
		const before = source.slice(last, m.index);
		last = m.index + m[0].length;
		if (skipUntil) {
			if (m[1] && m[2]?.toLowerCase() === skipUntil) skipUntil = null;
			continue;
		}
		emitText(before);
		if (!m[2]) continue; // A comment.
		const name = m[2].toLowerCase();
		const closing = Boolean(m[1]);
		if (!closing && DROP_BODY.has(name)) {
			if (!m[4]) skipUntil = name;
			continue;
		}
		const rule = RULES[name];
		if (!rule || (inline && rule.block && name !== "br")) continue;
		if (rule.void) {
			if (closing) continue;
			const attrs = cleanAttrs(name, m[3] ?? "");
			if (attrs === "\u0000") continue;
			emitTag(`<${name}${attrs}>`, name, "void");
			continue;
		}
		if (!closing) {
			const attrs = cleanAttrs(name, m[3] ?? "");
			emitTag(`<${name}${attrs}>`, name, "open");
			if (m[4]) emitTag(`</${name}>`, name, "close"); // <b/>: treat as empty.
			continue;
		}
		// A closing tag: only when it closes something open; close what's inside it first.
		if (!inline && !blockOpen() && paraOpen.includes(name)) {
			while (paraOpen.length) {
				const top = paraOpen[paraOpen.length - 1] as string;
				emitTag(`</${top}>`, top, "close");
				if (top === name) break;
			}
			continue;
		}
		const at = stack.lastIndexOf(name);
		if (at < 0) continue;
		while (stack.length > at) out += `</${stack.pop()}>`;
	}
	if (!skipUntil) emitText(source.slice(last));
	if (!inline) {
		while (stack.length) out += `</${stack.pop()}>`;
		flush();
	} else {
		while (stack.length) out += `</${stack.pop()}>`;
	}
	return out.trim();
}

/**
 * `<script>` and `<style>` elements removed, body and all, in one pass. A lazy
 * `<script[\s\S]*?</script>` regex rescans to the end from every opening tag
 * that has no closing one (quadratic); this looks for a tag's closing tag at
 * most once after it's known to have none.
 */
function dropScriptsAndStyles(input: string): string {
	const open = /<(script|style)\b/gi;
	const unclosed = new Set<string>();
	let out = "";
	let last = 0;
	for (let m = open.exec(input); m; m = open.exec(input)) {
		const tag = (m[1] as string).toLowerCase();
		if (unclosed.has(tag)) continue;
		const close = new RegExp(`<\\/${tag}\\s*>`, "gi");
		close.lastIndex = open.lastIndex;
		const end = close.exec(input);
		if (!end) {
			unclosed.add(tag);
			continue;
		}
		out += input.slice(last, m.index);
		last = end.index + end[0].length;
		open.lastIndex = last;
	}
	return out + input.slice(last);
}

/** Plain text of a field (for labels, schema and checks): tags dropped, entities decoded, whitespace collapsed. */
export function plainText(input: unknown): string {
	if (typeof input !== "string") return "";
	return decodeAttr(
		// A tag ends at the next `>` or `<` (an unclosed `<` stays text): linear, however many `<` there are.
		dropScriptsAndStyles(input)
			.replace(/<[^<>]*>/g, " ")
			.replace(/\[([^\]\n]+)\]\([^()\s]+\)/g, "$1")
			.replace(/\*\*([^*\n]+)\*\*/g, "$1"),
	)
		.replace(/\s+/g, " ")
		.trim();
}

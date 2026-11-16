/**
 * Buttondown Drafts: template code in a post stays text in the email.
 *
 * Buttondown runs Django templating over an email's Markdown before it
 * renders it, inside fenced code too (proved live, 2026-11-15: a code line
 * with `{{ example }}` came out without it). So each piece of the body that
 * has template code (`{{`, `{%` or `{#`) is wrapped in a named verbatim block,
 * `{% verbatim pack %}…{% endverbatim pack %}`: Django prints what's inside
 * as it is and removes the two tags, so the Markdown is what it was.
 *
 * Only those pieces are wrapped, never the whole body: a template variable
 * added to the draft in Buttondown (`{{ subscriber.metadata.first_name }}`)
 * keeps working. A piece is the code inside a fence (first line to last), a
 * table cell (what's inside its `<th>` or `<td>`), or one line's text after
 * its quote, list or heading marker. The tags sit on the content's own
 * lines: no line is added.
 *
 * A piece verbatim can't hold safely is rewritten with `{% templatetag … %}`
 * instead (needsTemplatetag): one that has "endverbatim" in it, or whose last
 * line would make Django read the closing tag as part of something else.
 *
 * Pure (no I/O).
 */

/** Django template syntax, which Buttondown runs at send time. */
export const TEMPLATE_CODE = /\{\{|\{%|\{#/;

export const VERBATIM_OPEN = "{% verbatim pack %}";
export const VERBATIM_CLOSE = "{% endverbatim pack %}";

/** Django's own rule for a tag (django.template.base tag_re): it never crosses a line. */
const DJANGO_TAG = /\{%[^\n]*?%\}|\{\{[^\n]*?\}\}|\{#[^\n]*?#\}/g;

const TEMPLATETAG: Record<string, string> = {
	"{{": "openvariable",
	"}}": "closevariable",
	"{%": "openblock",
	"%}": "closeblock",
	"{#": "opencomment",
	"#}": "closecomment",
	"{": "openbrace",
};

/**
 * Whether verbatim can't hold the text:
 * - it has "endverbatim" in it (it could close the block early);
 * - its last line has a tag opening that nothing closes ("Use {% to open a tag"), or ends with "{". Django would
 *   read the closing tag as the rest of that tag, and the block would never close.
 */
function needsTemplatetag(text: string): boolean {
	if (text.includes("endverbatim")) return true;
	const lastLine = text.slice(text.lastIndexOf("\n") + 1);
	// What's left of the line once Django has taken its whole tags (a NUL keeps the two sides of a tag apart).
	const rest = lastLine.replace(DJANGO_TAG, "\u0000");
	return TEMPLATE_CODE.test(rest) || rest.endsWith("{");
}

/** One piece of text with its template code escaped. Text without template code comes back as it is. */
export function escapeTemplateText(text: string): string {
	if (!TEMPLATE_CODE.test(text)) return text;
	// Every "{" goes, so nothing in the piece can open a tag (alone, or with what comes after it on the line).
	if (needsTemplatetag(text)) return text.replace(/\{\{|\{%|\{#|\}\}|%\}|#\}|\{/g, (m) => `{% templatetag ${TEMPLATETAG[m]} %}`);
	return `${VERBATIM_OPEN}${text}${VERBATIM_CLOSE}`;
}

/** A line's block markers: quote marks, a list marker, a heading's hashes. They stay outside the wrap. */
const LINE_MARKERS = /^\s*(?:>[ \t]?)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:#{1,6}[ \t]+)?/;

/** One piece inside a line: the space around it (a hard break's two spaces too) stays outside the wrap. */
function escapePiece(piece: string): string {
	if (!TEMPLATE_CODE.test(piece)) return piece;
	const core = piece.trim();
	const start = piece.indexOf(core);
	return `${piece.slice(0, start)}${escapeTemplateText(core)}${piece.slice(start + core.length)}`;
}

/** Markdown text (a paragraph, heading, quote, list item, block fallback): each line with template code has its text wrapped, after its markers. */
export function escapeTemplateLines(markdown: string): string {
	if (!TEMPLATE_CODE.test(markdown)) return markdown;
	return markdown
		.split("\n")
		.map((line) => {
			if (!TEMPLATE_CODE.test(line)) return line;
			const markers = LINE_MARKERS.exec(line)?.[0] ?? "";
			return `${markers}${escapePiece(line.slice(markers.length))}`;
		})
		.join("\n");
}

/**
 * One cell's line in the email's HTML table (src/buttondown/blocks.ts renderTableBlock): the opening tag (with the
 * attributes it writes there, in its order: colspan, rowspan, the alignment), what's inside, the closing tag. What's
 * inside is anything at all (the `s` flag): a line separator such as U+2028 is text, not the end of the line.
 */
const TABLE_CELL = /^(<(t[hd])(?: colspan="\d+")?(?: rowspan="\d+")?(?: style="text-align:(?:left|center|right);")?>)(.*)(<\/\2>)$/s;

/**
 * The email's HTML table, which has one cell on each line: each cell with template code is wrapped inside its
 * `<th>` or `<td>`. Any other line with template code (there's none in the table as it's written) is wrapped whole.
 */
export function escapeTemplateTable(markdown: string): string {
	if (!TEMPLATE_CODE.test(markdown)) return markdown;
	return markdown
		.split("\n")
		.map((line) => {
			if (!TEMPLATE_CODE.test(line)) return line;
			const cell = TABLE_CELL.exec(line);
			return cell ? `${cell[1]}${escapePiece(cell[3] ?? "")}${cell[4]}` : escapePiece(line);
		})
		.join("\n");
}

/** A fenced code block as the shared converter writes it (a file name line, then the fence): the code inside the fence is wrapped, first line to last. */
export function escapeTemplateCodeBlock(markdown: string): string {
	if (!TEMPLATE_CODE.test(markdown)) return markdown;
	const lines = markdown.split("\n");
	const fence = lines[lines.length - 1] ?? "";
	const open = lines.findIndex((line) => line.startsWith(fence));
	// Not the shape expected: escaped line by line, which is as safe.
	if (!/^`{3,}$/.test(fence) || open < 0 || open >= lines.length - 2) return escapeTemplateLines(markdown);
	const head = lines.slice(0, open).join("\n");
	const code = lines.slice(open + 1, -1).join("\n");
	return [...(open ? [escapeTemplateLines(head)] : []), lines[open], escapeTemplateText(code), fence].join("\n");
}

/** A rendered block's Markdown with its template code escaped, by the block's type. */
export function escapeTemplateBlock(markdown: string, type: unknown): string {
	if (type === "code") return escapeTemplateCodeBlock(markdown);
	if (type === "table") return escapeTemplateTable(markdown);
	return escapeTemplateLines(markdown);
}

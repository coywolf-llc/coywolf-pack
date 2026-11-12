/**
 * AI Enrichment prompts, ported from Coywolf SEO for WordPress
 * (class-coywolf-seo-ai.php and class-coywolf-seo-image-ai.php).
 */
import { CONTEXT_MARKER } from "./image-context.js";
import type { Candidate, GroundedMention } from "./logic.js";
import { DESCRIPTION_MAX } from "./logic.js";

export const EXTRACT_SYSTEM =
	"You extract named entities from an article for SEO schema markup. " +
	"Respond with ONLY a JSON array — no prose, no code fences. Each element is an object with exactly these keys: " +
	'"surface" (the entity exactly as written in the article), ' +
	'"name" (the canonical, normalized name), ' +
	'"type" (one of "Person", "Organization", "Place", "Thing"), ' +
	'"description" (one short line stating what the entity is), ' +
	'"primary" (true when the entity is a main subject of the article, false when it is mentioned in passing). ' +
	"Rules: never output identifiers, QIDs, database IDs, or URLs of any kind. " +
	"Only include real-world entities a reader could look up — people, organizations, places, products, published works, well-defined concepts. " +
	"Skip the article author and the publishing website itself. At most 12 entities. If there are none, return [].";

export const DISAMBIGUATE_SYSTEM =
	"You match entities from an article to Wikidata items. " +
	"Respond with ONLY a JSON object — no prose, no code fences — mapping each entity name to the QID string of the best-matching candidate, or null when no candidate clearly matches. " +
	"Choose strictly among the provided candidates. Never produce a QID that is not listed. " +
	"Use the article context, the entity type, and each candidate's Wikidata description to decide. If the choice is unclear, use null.";

export const DESCRIBE_SYSTEM =
	"You write the meta description for a web article. " +
	"Respond with ONLY the meta description itself — plain text, a single line, no quotation marks around it, no markdown, no preamble, no explanation. " +
	"It must be a faithful summary of the article content in one or two sentences, written for a search result snippet. " +
	"No clickbait: no questions to the reader, no hype, no exclamation marks, no \"you won't believe\" teasers, and no promises the article doesn't keep. " +
	`It must be STRICTLY UNDER ${DESCRIPTION_MAX} characters.`;

export const IMAGE_SYSTEM =
	"You write accessibility-first metadata for images in a website's media library, " +
	"following WCAG-aligned guidance for alternative text, titles, and captions. " +
	"You write for the people who depend on this text — screen reader and braille users, and anyone on a " +
	"text-only or broken-image fallback — and never for search engines. " +
	"You respond with raw JSON only: a single JSON object, no markdown fences, no commentary.";

export function articlePrompt(title: string, content: string): string {
	return `Title: ${title}\n\n${content}`;
}

export function disambiguatePrompt(ambiguous: GroundedMention[], title: string, content: string): string {
	const lines = [`Article: ${title} — ${[...content].slice(0, 600).join("")}`, "", "Entities and their candidates:"];
	for (const m of ambiguous) {
		lines.push(`${m.name} (${m.type}${m.description ? ` — ${m.description}` : ""}):`);
		for (const c of m.candidates as Candidate[]) lines.push(`  ${c.id}: ${c.label}${c.description ? ` — ${c.description}` : ""}`);
	}
	return lines.join("\n");
}

export function imagePrompt(opts: { filename: string; site: string; locale: string; extra?: string; articleContext?: string }): string {
	const articleContext = opts.articleContext?.trim() ?? "";
	const intro = articleContext
		? "This metadata becomes the default for the file; it appears in the article shown below, so make the alternative text and caption fit how it is used there while still reading well on their own.\n\n"
		: "This metadata becomes the default for every future use of the file, and you are given no specific post context, so it must stand on its own.\n\n";
	let prompt =
		"Analyze the image and write accessibility-first media library metadata for it, following the rules below. " +
		intro +
		"Respond with a JSON object:\n" +
		'{"alt_text": string, "title": string, "caption": string}\n\n' +
		"Write alt_text only when the image warrants it (an empty string for a purely decorative image); always provide a title and a caption.\n\n" +
		"First, silently decide what kind of image this is, then write accordingly:\n" +
		'- Decorative (a divider, texture, background flourish, or an icon that only repeats nearby text): return an empty alt_text. Do not invent text and do not write "decorative image". Still give it a useful title.\n' +
		'- Functional (the image acts as a button or link): alt_text states the action or destination, not the artwork — a magnifying-glass search icon is "Search", not "Magnifying glass".\n' +
		"- Text-bearing (a sign, quote card, screenshot, or graphic whose text is the point): transcribe the text verbatim in alt_text. If the visual design of the text is the point, describe that design as well.\n" +
		"- Complex (a chart, infographic, diagram, or data-dense screenshot): alt_text is one sentence giving the takeaway.\n" +
		"- Informative (any other image that carries meaning): alt_text describes what matters.\n\n" +
		"alt_text — becomes the alt attribute:\n" +
		"- Front-load the core subject and action, then add secondary details in descending importance, so a reader who stops after the first clause still has the essential picture.\n" +
		"- Write full sentences in sentence case, ending with a period.\n" +
		"- Default to one concise sentence (around 125 characters).\n" +
		'- Never begin with "Image of", "Photo of", or "Graphic of". Name the medium only when it matters, e.g. "Watercolor painting of…" or "Screenshot of…".\n' +
		'- Expand anything normally abbreviated: spell out units, measurements, and addresses ("5GB" becomes "5 gigabytes"; "123 Main St." becomes "123 Main Street"). Spell out acronyms unless this audience knows the acronym better.\n' +
		"- Use proper typographic curly quotes and apostrophes (not straight ones) when quoting text that appears in the image.\n" +
		"- Do not repeat what the caption says; alt_text and caption are read together, so write them as complements.\n\n" +
		"title — an internal media library label:\n" +
		'- A short, human-readable identifier of three to eight words in title case, e.g. "Barista Pouring Latte Art". Never a filename, never keywords, and never a copy of alt_text.\n\n' +
		"caption — visible to everyone, shown as the figure caption:\n" +
		"- One concise, informative sentence suitable to display beneath the image, phrased differently from alt_text.\n" +
		"- Add editorial context a sighted reader would value when you can infer it (names, place, date, or why it matters); otherwise a clear descriptive sentence is fine.\n\n" +
		`- Write every field in the language of locale "${opts.locale}".\n` +
		"- Plain text only: no HTML and no markdown. Write for human readers; never write for SEO.\n";
	const context: string[] = [];
	if (opts.filename) context.push(`filename "${opts.filename}"`);
	if (opts.site) context.push(`site "${opts.site}"`);
	if (context.length) prompt += `\nContext that may help (ignore it if misleading): ${context.join(", ")}.`;
	if (articleContext) {
		prompt +=
			`\n\nThe image appears in the article below. The marker ${CONTEXT_MARKER} shows exactly where it sits. ` +
			"Use this only to make the alternative text and caption fit how the image is used here — describe the image itself, and never restate or summarize the article text:\n\n" +
			articleContext;
	}
	const extra = opts.extra?.trim();
	if (extra) prompt += `\n\nAdditional site-specific instructions:\n${extra}`;
	return prompt;
}

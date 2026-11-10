/**
 * Reviews module, pure logic: cleaning block fields (and legacy WordPress
 * review markers) into a Review, the review box markup and CSS shared by the
 * site renderer and the admin preview, custom CSS sanitizing, and the
 * Schema.org nodes. No EmDash or Astro imports, so it runs in tests and in the
 * admin bundle.
 */

export const BLOCK_TYPE = "coywolf-review";
export const STYLE_SETTING = "reviewsStyle";
export const DEFAULT_ACCENT = "#2C8452";
export const DEFAULT_PROS_HEADING = "What I liked most";
export const DEFAULT_CONS_HEADING = "Could be better";
export const BEST_RATING = 5;
export const WORST_RATING = 0;
export const MAX_CUSTOM_CSS = 20_000;
const MAX_ITEMS = 20;
const MAX_REVIEWS = 20;

/**
 * Types Google accepts as `itemReviewed` for review snippets
 * (developers.google.com/search/docs/appearance/structured-data/review-snippet).
 * Product first: it's the default and the only type eligible for pros and cons.
 */
export const ITEM_TYPES: Array<[string, string]> = [
	["Product", "Product"],
	["SoftwareApplication", "Software application"],
	["Book", "Book"],
	["Course", "Course"],
	["Movie", "Movie"],
	["Game", "Game"],
	["Event", "Event"],
	["Recipe", "Recipe"],
	["LocalBusiness", "Local business"],
	["Organization", "Organization"],
	["CreativeWorkSeries", "Creative work series"],
	["CreativeWorkSeason", "Creative work season"],
	["Episode", "Episode"],
	["MediaObject", "Media object"],
	["HowTo", "How-to"],
];
const ITEM_TYPE_SET = new Set(ITEM_TYPES.map(([t]) => t));
/** schema.org `brand` applies to Product, Service, Organization and Person. */
const BRAND_TYPES = new Set(["Product", "Organization", "LocalBusiness"]);
/** Reviewing these on their own site is "self-serving" and ineligible for review snippets. */
const SELF_SERVING_TYPES = new Set(["Organization", "LocalBusiness"]);

export interface ReviewStyle {
	accent: string;
	css: string;
}

/** A cleaned review, ready to render or turn into schema. */
export interface Review {
	itemName: string;
	itemType: string;
	brand?: string;
	itemUrl?: string;
	/** Absolute http(s) URL or a root-relative path (resolved against the site for schema). */
	image?: string;
	/** 0–5 in 0.1 steps; null when missing (the box shows no badge and there's no schema). */
	rating: number | null;
	prosHeading: string;
	pros: string[];
	consHeading: string;
	cons: string[];
	summary?: string;
	headingLevel: 2 | 3 | 4;
	/** Book details (schema only). */
	bookAuthor?: string;
	isbn?: string;
	bookPublisher?: string;
	genre?: string;
	copyrightYear?: number;
	/** Software details (schema only): "macOS, Windows". */
	operatingSystem?: string;
	applicationCategory?: string;
}

// ── Cleaning ─────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** Decode the HTML entities WordPress content commonly holds. Unknown named entities are left alone. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
		}
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

const clean = (value: unknown, max: number): string => {
	if (typeof value !== "string" && typeof value !== "number") return "";
	const text = String(value)
		// Control characters in the pattern: strip control characters.
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};

/** HTML to plain text: drop tags (and script/style bodies), decode entities, collapse whitespace. */
export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<[^>]*>/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * List item text from a WordPress `<ul><li>…</li></ul>` field. Nested markup
 * is reduced to text; without any <li>, each line (or <br>/<p>) is an item.
 */
export function listFromHtml(html: unknown): string[] {
	if (typeof html !== "string" || !html.trim()) return [];
	const source = html.slice(0, 50_000);
	const items = [...source.matchAll(/<li\b[^>]*>([\s\S]*?)(?=<\/li\s*>|<li\b|<\/[uo]l\s*>|$)/gi)].map((m) => htmlToText(m[1]));
	const list = items.length ? items : source.split(/<br\s*\/?>|<\/p\s*>|\n/i).map(htmlToText);
	return list.map((t) => clean(t, 300)).filter(Boolean).slice(0, MAX_ITEMS);
}

/** One item per line (editor textarea), or an array of strings. Leading bullets ("- ", "• ", "* ") are dropped. */
export function listFromLines(value: unknown): string[] {
	const lines = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
	return lines
		.map((line) => clean(typeof line === "string" ? line.replace(/^\s*(?:[-*•–]\s+)/, "") : line, 300))
		.filter(Boolean)
		.slice(0, MAX_ITEMS);
}

/**
 * A rating on the 0–5 scale, clamped and rounded to one decimal (4.7 stays
 * 4.7, 4.25 becomes 4.3); null when missing or not a number. Half steps saved
 * before 0.11.0 ("4.5", "4") read the same as before.
 */
export function parseRating(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const text = typeof value === "string" ? value.trim().replace(",", ".") : null;
	if (text === "") return null;
	const n = typeof value === "number" ? value : text !== null ? Number(text) : Number.NaN;
	if (!Number.isFinite(n)) return null;
	return Math.round(Math.min(BEST_RATING, Math.max(WORST_RATING, n)) * 10) / 10;
}

/** "4.7", "5" — no trailing ".0". */
export function formatRating(rating: number): string {
	return Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
}

/**
 * The block's stored rating value: one decimal, always with the ".0"
 * ("4.7", "5.0"), or "" when there's no rating. The editor's rating menu uses
 * these values; whole numbers need the ".0" because the menu lists integer-like
 * values out of order ("0" … "5" before "4.9").
 */
export function ratingValue(value: unknown): string {
	const rating = parseRating(value);
	return rating === null ? "" : rating.toFixed(1);
}

/** The editor's rating menu: 5.0 down to 0.0 in 0.1 steps. */
export const RATING_OPTIONS: Array<{ value: string; label: string }> = Array.from({ length: BEST_RATING * 10 + 1 }, (_, i) => (BEST_RATING * 10 - i) / 10).map((n) => ({
	value: n.toFixed(1),
	label: `${formatRating(n)} out of ${BEST_RATING}`,
}));

/**
 * Rewrite each `coywolf-review` block's rating to its menu value ("4" →
 * "4.0", 4.7 → "4.7"), so reviews saved with the old half-step menu (or
 * imported) show their rating in the editor. Returns null when nothing changed.
 */
export function normalizeReviewRatings<T>(data: T): T | null {
	let changed = false;
	const visit = (value: unknown, depth: number): unknown => {
		if (depth > 12 || !value || typeof value !== "object") return value;
		if (Array.isArray(value)) {
			let out: unknown[] | null = null;
			value.forEach((v, i) => {
				const next = visit(v, depth + 1);
				if (next !== v) {
					out ??= value.slice();
					out[i] = next;
				}
			});
			return out ?? value;
		}
		const obj = value as Record<string, unknown>;
		if (obj._type === BLOCK_TYPE) {
			const next = ratingValue(obj.rating);
			// Leave missing or unreadable values alone.
			if (!next || next === obj.rating) return obj;
			changed = true;
			return { ...obj, rating: next };
		}
		let out: Record<string, unknown> | null = null;
		for (const [k, v] of Object.entries(obj)) {
			const next = visit(v, depth + 1);
			if (next !== v) {
				out ??= { ...obj };
				out[k] = next;
			}
		}
		return out ?? obj;
	};
	const result = visit(data, 0) as T;
	return changed ? result : null;
}

/** An absolute http(s) URL (no credentials), or undefined. */
export function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!/^https?:\/\/[^\s]+$/i.test(text) || text.length > 2000) return undefined;
	try {
		const url = new URL(text);
		if (url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

/** An absolute http(s) URL or a root-relative path. */
function imageRef(value: unknown): string | undefined {
	if (typeof value === "string" && /^\/(?!\/)[^\s]*$/.test(value.trim()) && value.length <= 2000) return value.trim();
	// media_picker values may be objects with a url.
	if (value && typeof value === "object" && "url" in value) return imageRef((value as { url: unknown }).url);
	return httpUrl(value);
}

/**
 * Clean a `coywolf-review` block (or the same shape from a theme) into a
 * Review. Returns null when there's nothing to show (no rating, no pros, no
 * cons, no summary).
 */
export function normalizeReview(input: unknown): Review | null {
	if (!input || typeof input !== "object") return null;
	const v = input as Record<string, unknown>;
	const itemType = typeof v.itemType === "string" && ITEM_TYPE_SET.has(v.itemType) ? v.itemType : "Product";
	const level = Number(v.headingLevel);
	const review: Review = {
		itemName: clean(v.itemName ?? v.name, 200),
		itemType,
		rating: parseRating(v.rating),
		prosHeading: clean(v.prosHeading, 80) || DEFAULT_PROS_HEADING,
		pros: listFromLines(v.pros),
		consHeading: clean(v.consHeading, 80) || DEFAULT_CONS_HEADING,
		cons: listFromLines(v.cons),
		headingLevel: level === 3 || level === 4 ? level : 2,
	};
	const brand = clean(v.brand, 100);
	if (brand) review.brand = brand;
	const itemUrl = httpUrl(v.itemUrl ?? v.url);
	if (itemUrl) review.itemUrl = itemUrl;
	const image = imageRef(v.image);
	if (image) review.image = image;
	const summary = clean(v.summary, 2000);
	if (summary) review.summary = summary;
	if (itemType === "Book") {
		const author = clean(v.bookAuthor, 200);
		if (author) review.bookAuthor = author;
		const isbn = clean(v.isbn, 20).replace(/[^0-9Xx-]/g, "");
		if (isbn) review.isbn = isbn;
		const publisher = clean(v.bookPublisher, 200);
		if (publisher) review.bookPublisher = publisher;
		const genre = clean(v.genre, 100);
		if (genre) review.genre = genre;
		const year = Number(clean(v.copyrightYear, 4));
		if (Number.isInteger(year) && year >= 1000 && year <= 9999) review.copyrightYear = year;
	}
	if (itemType === "SoftwareApplication") {
		const os = clean(v.operatingSystem, 300);
		if (os) review.operatingSystem = os;
		const category = clean(v.applicationCategory, 100);
		if (category) review.applicationCategory = category;
	}
	if (review.rating === null && !review.pros.length && !review.cons.length && !review.summary) return null;
	return review;
}

/**
 * The fields of a legacy WordPress review marker (Coywolf Custom Blocks:
 * `{ name, brand, rating, strengths, shortcomings }`, pros and cons as <ul>
 * HTML, plus the book fields `author`, `isbn`, `publisher`, `genre`,
 * `copyright` and the software fields `os`, `category`) in the block's shape,
 * for <Review> and `page.coywolf.reviews`.
 */
export function reviewFromAttrs(attrs: unknown): Record<string, unknown> {
	if (!attrs || typeof attrs !== "object") return {};
	const a = attrs as Record<string, unknown>;
	const text = (x: unknown) => (typeof x === "string" ? htmlToText(x) : typeof x === "number" ? String(x) : "");
	return {
		itemName: text(a.name),
		itemType: typeof a.itemType === "string" ? a.itemType : "Product",
		brand: text(a.brand),
		itemUrl: typeof a.url === "string" ? a.url : undefined,
		image: typeof a.image === "string" ? a.image : undefined,
		rating: a.rating,
		pros: listFromHtml(a.strengths),
		cons: listFromHtml(a.shortcomings),
		...(typeof a.summary === "string" ? { summary: htmlToText(a.summary) } : {}),
		bookAuthor: text(a.author),
		isbn: text(a.isbn),
		bookPublisher: text(a.publisher),
		genre: text(a.genre),
		copyrightYear: text(a.copyright),
		operatingSystem: text(a.os).replace(/"/g, "").replace(/\s*,\s*/g, ", "),
		applicationCategory: text(a.category),
	};
}

/** Every `coywolf-review` block in an entry's data (any Portable Text field), in document order. */
export function findReviewBlocks(data: unknown, limit = MAX_REVIEWS): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	const visit = (value: unknown, depth: number) => {
		if (out.length >= limit || depth > 12 || !value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const v of value) visit(v, depth + 1);
			return;
		}
		const obj = value as Record<string, unknown>;
		if (obj._type === BLOCK_TYPE) {
			out.push(obj);
			return;
		}
		for (const v of Object.values(obj)) visit(v, depth + 1);
	};
	visit(data, 0);
	return out;
}

// ── Style settings ───────────────────────────────────────────────

export function isAccent(value: unknown): value is string {
	return typeof value === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

/**
 * Make custom CSS safe to put inside a <style> element: no `</style` (so it
 * can't close the element), no HTML comment markers, no NUL, at most 20 KB.
 * Rules aren't rewritten; by convention they target `.cw-review …`.
 */
export function sanitizeCustomCss(value: unknown): string {
	if (typeof value !== "string") return "";
	let css = value.replace(/\u0000/g, "").slice(0, MAX_CUSTOM_CSS);
	let previous: string;
	do {
		previous = css;
		css = css.replace(/<\/style/gi, "").replace(/<!--/g, "").replace(/-->/g, "");
	} while (css !== previous);
	return css.trim();
}

export function normalizeStyle(value: unknown): ReviewStyle {
	const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	return { accent: isAccent(v.accent) ? v.accent : DEFAULT_ACCENT, css: sanitizeCustomCss(v.css) };
}

// ── Markup ───────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The review box. Visually the Coywolf rating summary (badge with the score,
 * "4.5 out of 5" under it, then the two lists); every part has a stable
 * `cw-review__*` class for custom CSS.
 */
export function renderReviewHtml(review: Review): string {
	const h = `h${review.headingLevel}`;
	const label = review.itemName ? `Review of ${review.itemName}` : "Review";
	const list = (kind: "pros" | "cons", heading: string, items: string[]) =>
		items.length
			? `<div class="cw-review__col cw-review__${kind}"><${h} class="cw-review__heading">${escapeHtml(heading)}</${h}><ul class="cw-review__list">${items
					.map((item) => `<li class="cw-review__item">${escapeHtml(item)}</li>`)
					.join("")}</ul></div>`
			: "";
	const score = review.rating === null ? null : formatRating(review.rating);
	const badge =
		score === null
			? ""
			: `<div class="cw-review__rating"><span class="cw-review__badge" aria-hidden="true">${score}</span><span class="cw-review__caption"><span class="cw-review__sr">Rated </span>${score} out of ${BEST_RATING}</span></div>`;
	const columns = list("pros", review.prosHeading, review.pros) + list("cons", review.consHeading, review.cons);
	return `<section class="cw-review" aria-label="${escapeHtml(label)}">${badge}${columns ? `<div class="cw-review__columns">${columns}</div>` : ""}${
		review.summary ? `<p class="cw-review__summary">${escapeHtml(review.summary)}</p>` : ""
	}</section>`;
}

/**
 * The box's CSS. Light/dark colors use light-dark(), so the box follows the
 * page's own `color-scheme` (a light-only theme stays light). Every design value is a custom property read with a fallback
 * (never set by this CSS), so a site can set them on `.cw-review`, on a
 * wrapper, or on :root. The accent setting is the badge's fallback color.
 */
export function reviewCss(accent: string = DEFAULT_ACCENT): string {
	const a = isAccent(accent) ? accent : DEFAULT_ACCENT;
	return `.cw-review{box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:var(--cw-review-gap,1rem 1.5rem);margin:var(--cw-review-margin,0 0 1.5rem);padding:var(--cw-review-padding,2rem 1rem);background:var(--cw-review-bg,light-dark(#fff,var(--cw-review-bg-dark,#1d1f23)));color:var(--cw-review-color,inherit);border:var(--cw-review-border,1px solid var(--cw-review-border-color,light-dark(#dfe0e3,var(--cw-review-border-color-dark,#3a3d44))));border-radius:var(--cw-review-radius,12px);font-family:var(--cw-review-font,inherit)}
.cw-review *{box-sizing:border-box}
.cw-review__rating{flex:1 0 var(--cw-review-rating-width,7rem);margin:0;text-align:center}
.cw-review__badge{display:inline-block;padding:var(--cw-review-badge-padding,.5rem 1rem);background:var(--cw-review-accent,${a});color:var(--cw-review-badge-color,#fff);border-radius:var(--cw-review-badge-radius,10%);font-size:var(--cw-review-badge-size,3.5rem);font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
.cw-review__caption{display:block;margin-top:.75rem;font-size:var(--cw-review-caption-size,1rem);color:var(--cw-review-caption-color,inherit)}
.cw-review__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.cw-review__columns{flex:6 1 var(--cw-review-stack-at,26rem);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--cw-review-column-min,13rem)),1fr));gap:var(--cw-review-column-gap,1rem 1.5rem);align-self:start}
.cw-review__col{min-width:0}
.cw-review .cw-review__heading{margin:0;padding:0;font-size:var(--cw-review-heading-size,1.2rem);line-height:1.3;text-transform:var(--cw-review-heading-transform,uppercase);color:var(--cw-review-heading-color,inherit)}
.cw-review .cw-review__list{margin:.75rem 0 0 1.25rem;padding:0;list-style:var(--cw-review-list-style,square)}
.cw-review .cw-review__item{margin:0;padding:.2rem 0;font-size:var(--cw-review-list-size,1rem);font-weight:500;color:var(--cw-review-list-color,light-dark(#555,var(--cw-review-list-color-dark,#c9ccd1)))}
.cw-review .cw-review__summary{flex:1 1 100%;margin:0;color:var(--cw-review-summary-color,inherit)}`;
}

/** Built-in CSS followed by the site's custom CSS (so it overrides). */
export function pageCss(style: ReviewStyle): string {
	const custom = sanitizeCustomCss(style.css);
	return reviewCss(style.accent) + (custom ? `\n/* Custom CSS (Reviews page) */\n${custom}` : "");
}

/** A sample review for the admin preview. */
export const SAMPLE_REVIEW: Review = {
	itemName: "Example Coffee Grinder",
	itemType: "Product",
	brand: "Example",
	rating: 4.5,
	prosHeading: DEFAULT_PROS_HEADING,
	pros: ["Consistent grind from espresso to French press", "Quiet, quick, and easy to clean", "Small enough for any counter"],
	consHeading: DEFAULT_CONS_HEADING,
	cons: ["The hopper only holds 8 oz of beans"],
	headingLevel: 2,
};

// ── Schema ───────────────────────────────────────────────────────

export type Node = Record<string, unknown>;

export interface ReviewSchemaContext {
	/** The page URL (canonical), without a fragment. */
	pageUrl: string;
	/** Site origin, for root-relative image paths and the self-serving check. */
	origin: string;
	/** Reference (or node) for the review's author: the Article's author(s), else the publisher. */
	author: unknown;
	/** Reference (or node) for the publisher. */
	publisher?: unknown;
	/** Publisher name, for the self-serving check. */
	publisherName?: string;
	datePublished?: string | null;
}

/** Is this review of the site's own organization or business (ineligible, "self-serving")? */
export function isSelfServing(review: Review, ctx: Pick<ReviewSchemaContext, "origin" | "publisherName">): boolean {
	if (!SELF_SERVING_TYPES.has(review.itemType)) return false;
	try {
		if (review.itemUrl && new URL(review.itemUrl).hostname.replace(/^www\./, "") === new URL(ctx.origin).hostname.replace(/^www\./, "")) return true;
	} catch {
		// ignore
	}
	return !!ctx.publisherName && review.itemName.toLowerCase() === ctx.publisherName.trim().toLowerCase();
}

const itemList = (items: string[]): Node => ({
	"@type": "ItemList",
	itemListElement: items.map((name, i) => ({ "@type": "ListItem", position: i + 1, name })),
});

function absoluteImage(image: string | undefined, origin: string): string | undefined {
	if (!image) return undefined;
	if (/^https?:/i.test(image)) return image;
	try {
		return new URL(image, origin).href;
	} catch {
		return undefined;
	}
}

/**
 * The Schema.org node for one review, or null when it isn't eligible (no item
 * name, no rating, or self-serving). `n` is its 1-based position on the page.
 *
 * Products are top-level Product nodes with the Review nested as `review`:
 * Google reads pros and cons (positiveNotes/negativeNotes) only from "the
 * Review nested within a Product", and a nested review needs no
 * itemReviewed. Other types are top-level Review nodes with the item in
 * `itemReviewed`, which is what the review snippet docs show and avoids
 * validating, say, an Event or SoftwareApplication as its own rich result.
 * Either way the Review is `${pageUrl}#review-N` and the item `#review-N-item`.
 */
export function reviewSchema(review: Review, n: number, ctx: ReviewSchemaContext): Node | null {
	if (!review.itemName || review.rating === null || isSelfServing(review, ctx)) return null;
	const reviewId = `${ctx.pageUrl}#review-${n}`;
	const itemId = `${ctx.pageUrl}#review-${n}-item`;
	const item: Node = { "@type": review.itemType, "@id": itemId, name: review.itemName };
	if (review.brand && BRAND_TYPES.has(review.itemType)) item.brand = { "@type": "Brand", name: review.brand };
	if (review.itemUrl) item.url = review.itemUrl;
	const image = absoluteImage(review.image, ctx.origin);
	if (image) item.image = image;
	if (review.itemType === "Book") {
		if (review.bookAuthor) item.author = { "@type": "Person", name: review.bookAuthor };
		if (review.isbn) item.isbn = review.isbn;
		if (review.bookPublisher) item.publisher = { "@type": "Organization", name: review.bookPublisher };
		if (review.genre) item.genre = review.genre;
		if (review.copyrightYear) item.copyrightYear = review.copyrightYear;
	}
	if (review.itemType === "SoftwareApplication") {
		if (review.operatingSystem) item.operatingSystem = review.operatingSystem;
		if (review.applicationCategory) item.applicationCategory = review.applicationCategory;
	}

	const node: Node = {
		"@type": "Review",
		"@id": reviewId,
		reviewRating: { "@type": "Rating", ratingValue: review.rating, bestRating: BEST_RATING, worstRating: WORST_RATING },
		author: ctx.author,
		...(ctx.publisher ? { publisher: ctx.publisher } : {}),
		...(ctx.datePublished && !Number.isNaN(Date.parse(ctx.datePublished)) ? { datePublished: ctx.datePublished } : {}),
		mainEntityOfPage: { "@id": `${ctx.pageUrl}#webpage` },
	};
	// Pros and cons: Product reviews only, and Google needs at least two statements in all.
	if (review.itemType === "Product" && review.pros.length + review.cons.length >= 2) {
		if (review.pros.length) node.positiveNotes = itemList(review.pros);
		if (review.cons.length) node.negativeNotes = itemList(review.cons);
	}
	if (review.summary) node.reviewBody = review.summary;

	if (review.itemType === "Product") return { ...item, review: node };
	return { ...node, itemReviewed: item };
}

const reviewKey = (r: Review) => `${r.itemType} ${r.itemName.toLowerCase()}`;

/** Drop repeats (same item type and name), keeping the first; at most 20. */
export function dedupeReviews(reviews: Review[]): Review[] {
	const seen = new Set<string>();
	return reviews
		.filter((r) => {
			const key = reviewKey(r);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, MAX_REVIEWS);
}

/**
 * Add review nodes to a Schema & Social @graph. The item each review is about
 * is added to the Article's (or WebPage's) `about`; the review's author is
 * the Article's author, its publisher the graph's publisher.
 */
export function attachReviews(graph: { "@graph": Node[] }, reviews: Review[], opts: { origin: string; publisherName?: string }): void {
	if (!reviews.length) return;
	const nodes = graph["@graph"];
	const byId = (suffix: string) => nodes.find((n) => typeof n["@id"] === "string" && (n["@id"] as string).endsWith(suffix));
	const article = byId("#article");
	const webpage = byId("#webpage");
	const owner = article ?? webpage;
	if (!owner) return;
	const pageUrl = String(owner["@id"]).replace(/#[^#]*$/, "");
	const website = nodes.find((n) => n["@type"] === "WebSite");
	const publisher = owner.publisher ?? website?.publisher;
	const author = article?.author ?? publisher;
	if (!author) return;
	const publisherNode = publisher && typeof publisher === "object" && "@id" in publisher ? nodes.find((n) => n["@id"] === (publisher as Node)["@id"]) : undefined;
	const ctx: ReviewSchemaContext = {
		pageUrl,
		origin: opts.origin,
		author,
		publisher,
		publisherName: opts.publisherName ?? (typeof publisherNode?.name === "string" ? publisherNode.name : undefined),
		datePublished: (article?.datePublished ?? webpage?.datePublished) as string | undefined,
	};
	const existing = new Set(nodes.map((n) => String(n["@id"] ?? "")));
	const added: Node[] = [];
	dedupeReviews(reviews).forEach((review, i) => {
		const node = reviewSchema(review, i + 1, ctx);
		if (node && !existing.has(String(node["@id"]))) added.push(node);
	});
	if (!added.length) return;
	nodes.splice(nodes.indexOf(owner) + 1, 0, ...added);
	const itemRefs = added.map((n) => ({ "@id": String(n["@type"] === "Review" ? (n.itemReviewed as Node)["@id"] : n["@id"]) }));
	const about = owner.about === undefined ? [] : Array.isArray(owner.about) ? owner.about : [owner.about];
	const all = [...about, ...itemRefs];
	owner.about = all.length === 1 ? all[0] : all;
}

/**
 * Standalone JSON-LD documents (one per review) for when Schema & Social's
 * graph is off. The author is the page's byline name (else the site), the
 * publisher the site.
 */
export function reviewDocuments(
	reviews: Review[],
	page: { pageUrl: string; origin: string; siteName: string; authorName?: string | null; datePublished?: string | null },
): Node[] {
	const publisher: Node = { "@type": "Organization", name: page.siteName, url: `${page.origin}/` };
	const authorName = page.authorName?.trim().slice(0, 100);
	const author: Node = authorName ? { "@type": "Person", name: authorName } : publisher;
	const ctx: ReviewSchemaContext = {
		pageUrl: page.pageUrl,
		origin: page.origin,
		author,
		publisher: page.siteName ? publisher : undefined,
		publisherName: page.siteName,
		datePublished: page.datePublished,
	};
	const out: Node[] = [];
	dedupeReviews(reviews).forEach((review, i) => {
		const node = reviewSchema(review, i + 1, ctx);
		if (!node) return;
		// No graph, so no #webpage node to point at.
		const strip = (n: Node) => {
			if (n.mainEntityOfPage) n.mainEntityOfPage = page.pageUrl;
		};
		strip(node);
		if (node.review) strip(node.review as Node);
		out.push({ "@context": "https://schema.org", ...node });
	});
	return out;
}

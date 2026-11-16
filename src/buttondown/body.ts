/**
 * Buttondown Drafts: the email the Pack writes for a post. Its fields
 * (subject, description, canonical URL, image, slug, metadata), its body as
 * Markdown, the email image rule, the warnings worth showing, and the hash
 * that tells whether anything changed since the last write.
 *
 * The body:
 * - starts with Buttondown's plaintext editor-mode comment (its own guess at
 *   the mode isn't reliable: a fenced html block made it switch to HTML);
 * - has no frontmatter (Buttondown refuses a body that starts with it): it's
 *   made with portableTextToMarkdown directly, never Discovery's .md builder;
 * - holds each Portable Text field of the collection in field order, with
 *   relative links made absolute, images resized and in a format email apps
 *   show, the Pack's blocks as Markdown, and each table as an HTML table
 *   in Buttondown's own table style (src/buttondown/blocks.ts);
 * - has its template code ({{, {% or {#) escaped piece by piece, so Buttondown
 *   prints it instead of running it (src/buttondown/template.ts). The public
 *   .md pages don't get this: it's for Buttondown only;
 * - ends with a rule and "Read it on <site>" linking to the post (footerLink);
 *   a post with no content gets the link alone (a rule at the top would read
 *   as frontmatter).
 *
 * Pure apart from the media host the images module knows (src/images/lib.ts).
 */
import { portableTextToMarkdown } from "../discovery/markdown.js";
import { imageCdn, mediaFile, parseCdnUrl } from "../images/lib.js";
import type { DisclosureSettings, PodcastSettings } from "../customBlocks/render.js";
import { type EmailFile, markdownUrl, renderTableBlock, renderUnknownBlock } from "./blocks.js";
import type { DraftFields } from "./client.js";
import { BUTTONDOWN_LIMITS } from "./keys.js";
import { TEMPLATE_CODE, VERBATIM_OPEN, escapeTemplateBlock, escapeTemplateLines } from "./template.js";

export { TEMPLATE_CODE };

export const MODE_COMMENT = "<!-- buttondown-editor-mode: plaintext -->";
/** Buttondown's slug rule. A slug that doesn't fit is left out (Buttondown makes its own). */
export const SLUG = /^[a-zA-Z0-9_-]{1,100}$/;
export const METADATA_VERSION = 1;

/**
 * Originals Cloudflare's resizer can keep in their format, and the ones it turns into JPEG. It can't read AVIF, and
 * it doesn't resize or convert SVG (it serves the SVG itself, whatever `format` says), so those two go as they are.
 */
const KEEP_FORMAT = new Set(["jpg", "jpeg", "png", "gif"]);
const TO_JPEG = new Set(["webp", "heic"]);

export type ImageKind = "resized" | "original" | "external";

/**
 * An image for email: a media-library file at 1200 px on the media host
 * (JPEG, PNG and GIF keep their format; WebP and HEIC become JPEG, which
 * every email app shows); an AVIF or SVG original, or any file on a site
 * without a media host, as the original (with a warning); another site's
 * image as it is (a warning when it's WebP, AVIF or SVG).
 */
export function emailImage(src: string, absolute: (url: string) => string): { url: string; kind: ImageKind; risky: boolean } {
	const value = String(src ?? "").trim();
	const file = mediaFile(value) ?? parseCdnUrl(value);
	if (file) {
		const cdn = imageCdn();
		const ext = file.ext.toLowerCase();
		const name = `${file.id}.${file.ext}`;
		const size = `width=${BUTTONDOWN_LIMITS.imageWidth},fit=scale-down,quality=85`;
		if (cdn && KEEP_FORMAT.has(ext)) return { url: `${cdn}/cdn-cgi/image/${size}/${name}`, kind: "resized", risky: false };
		if (cdn && TO_JPEG.has(ext)) return { url: `${cdn}/cdn-cgi/image/${size},format=jpeg/${name}`, kind: "resized", risky: false };
		// The "original" warning covers the format too.
		return { url: cdn ? `${cdn}/${name}` : absolute(value), kind: "original", risky: false };
	}
	const url = absolute(value);
	let path = url;
	try {
		path = new URL(url).pathname;
	} catch {
		// Not a URL: checked as it is.
	}
	return { url, kind: "external", risky: /\.(webp|avif|svg)$/i.test(path) };
}

/** An image field's value (a URL, or EmDash's media value) as a URL, or null. */
export function imageValueUrl(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;
	if (!value || typeof value !== "object") return null;
	const v = value as { src?: unknown; url?: unknown; meta?: { storageKey?: unknown } | null };
	for (const candidate of [v.src, v.url]) if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	const key = typeof v.meta?.storageKey === "string" ? v.meta.storageKey : null;
	return key ? `/_emdash/api/media/file/${key.split("/").map(encodeURIComponent).join("/")}` : null;
}

export interface EmailSource {
	collection: string;
	entryId: string;
	/** "<site host>:<collection>:<entry id>": how the Pack finds its draft in Buttondown again. */
	key: string;
	title: string;
	/** The excerpt field, else the SEO description: the email's description. */
	excerpt?: string | null;
	seoDescription?: string | null;
	slug?: string | null;
	/** Absolute. */
	postUrl: string;
	/** Absolute, no trailing slash. */
	siteUrl: string;
	/** Each Portable Text field's value, in the collection's field order. */
	bodyFields: unknown[];
	/** The featured image (an image field's URL), if any. */
	featuredImage?: string | null;
	footerLink: boolean;
	/** Leave the slug out (Buttondown refused it once). */
	noSlug?: boolean;
	files?: ReadonlyMap<string, EmailFile>;
	disclosure?: DisclosureSettings;
	podcast?: PodcastSettings;
}

export interface BuiltEmail {
	fields: DraftFields;
	/** SHA-256 of what the email shows (every field but the metadata). */
	hash: string;
	warnings: string[];
}

const plainLine = (text: unknown, max: number) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "coywolf.com" from the site URL. */
export function siteHost(siteUrl: string): string {
	try {
		return new URL(siteUrl).host.replace(/^www\./, "");
	} catch {
		return "the site";
	}
}

/** The key the Pack puts in an email's metadata to find it again. */
export const entryKey = (siteUrl: string, collection: string, entryId: string) => `${siteHost(siteUrl)}:${collection}:${entryId}`;

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hash of what an email shows: the same post gives the same hash; any change to a field changes it. */
export function emailHash(fields: Omit<DraftFields, "metadata">): Promise<string> {
	return sha256Hex(JSON.stringify([fields.subject, fields.body, fields.description ?? null, fields.canonical_url ?? null, fields.image ?? null, fields.slug ?? null]));
}

/** The metadata the Pack writes: Buttondown's own keys and anything you added stay, the Pack's object is replaced. */
export function packMetadata(source: Pick<EmailSource, "key" | "collection" | "entryId">, hash: string, current: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...current, coywolf_pack: { v: METADATA_VERSION, key: source.key, collection: source.collection, entry: source.entryId, hash } };
}

export async function buildEmail(source: EmailSource): Promise<BuiltEmail> {
	const origin = source.siteUrl.replace(/\/+$/, "");
	const absolute = (href: string) => {
		if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
		try {
			return new URL(href, `${origin}/`).href;
		} catch {
			return href;
		}
	};
	const host = siteHost(origin);
	const counts = { original: 0, risky: 0 };
	const blocks = new Map<string, number>();
	const image = (url: string) => {
		const out = emailImage(url, absolute);
		if (out.kind === "original") counts.original++;
		if (out.risky) counts.risky++;
		return out.url;
	};
	const ctx = {
		postUrl: source.postUrl,
		siteHost: host,
		absolute,
		image,
		files: source.files,
		disclosure: source.disclosure,
		podcast: source.podcast,
		warn: (w: string) => {
			if (w.startsWith("block:")) blocks.set(w.slice(6), (blocks.get(w.slice(6)) ?? 0) + 1);
		},
	};

	let content = source.bodyFields
		.map((value) => portableTextToMarkdown(value, { absolute, image: (url) => image(url), unknownBlock: (block) => renderUnknownBlock(block, ctx), table: (block) => renderTableBlock(block, ctx), rendered: (markdown, block) => escapeTemplateBlock(markdown, block._type) }))
		.filter(Boolean)
		.join("\n\n");
	// A leading horizontal rule would read as the start of frontmatter: it says nothing at the top of an email anyway.
	while (/^---\s*(\n|$)/.test(content)) content = content.replace(/^---\s*\n*/, "");
	if (source.footerLink) {
		const href = markdownUrl(source.postUrl, absolute);
		// With nothing above it, the rule would be the body's first line (frontmatter to Buttondown): the link goes alone.
		const footer = href ? escapeTemplateLines(`[Read it on ${host}](${href})`) : "";
		if (footer) content = content ? `${content}\n\n---\n\n${footer}` : footer;
	}
	// Checked as Buttondown reads it: the verbatim tag in front of a first line is gone by then.
	if (/^\s*---/.test(content.startsWith(VERBATIM_OPEN) ? content.slice(VERBATIM_OPEN.length) : content)) throw new Error("The email body would start with frontmatter.");
	const body = `${MODE_COMMENT}\n${content}\n`;

	const subject = plainLine(source.title, 2000) || plainLine(source.slug, 2000) || "Untitled post";
	const description = plainLine(source.excerpt, 1000) || plainLine(source.seoDescription, 1000);
	const featured = source.featuredImage ? image(source.featuredImage) : "";
	const slug = !source.noSlug && source.slug && SLUG.test(source.slug) ? source.slug : undefined;
	const canonical = /^https?:\/\//i.test(source.postUrl) && source.postUrl.length <= 2000 ? source.postUrl : undefined;
	const shown: Omit<DraftFields, "metadata"> = {
		subject,
		body,
		...(description ? { description } : {}),
		...(canonical ? { canonical_url: canonical } : {}),
		...(featured && featured.length <= 2000 ? { image: featured } : {}),
		...(slug ? { slug } : {}),
	};
	const hash = await emailHash(shown);

	const warnings: string[] = [];
	if (blocks.size) {
		const total = [...blocks.values()].reduce((a, b) => a + b, 0);
		warnings.push(`${plural(total, "block")} can't be shown in email (${[...blocks.keys()].slice(0, 5).join(", ")}): the email links to the post there.`);
	}
	if (counts.original) warnings.push(`${plural(counts.original, "image")} can't be resized for email (an AVIF or SVG file, or no media host), so the original is used. Check ${counts.original === 1 ? "it" : "them"} in Buttondown's preview.`);
	if (counts.risky) warnings.push(`${plural(counts.risky, "image")} ${counts.risky === 1 ? "is" : "are"} WebP, AVIF or SVG, which some email apps don't show.`);
	// The body's template code is escaped. The subject and the description go as they are: a verbatim tag there isn't proved to work.
	const unescaped = [TEMPLATE_CODE.test(subject) ? "subject" : "", TEMPLATE_CODE.test(description) ? "description" : ""].filter(Boolean);
	if (unescaped.length) warnings.push(`The ${unescaped.join(" and the ")} ${unescaped.length === 1 ? "contains" : "contain"} template code ({{, {% or {#). The Pack escapes it in the body only: check the ${unescaped.join(" and the ")} in Buttondown before sending.`);

	return { fields: { ...shown, metadata: packMetadata(source, hash) }, hash, warnings };
}

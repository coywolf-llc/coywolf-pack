/**
 * Content audit checks: what's wrong with one published entry, as facts
 * ("2 images without alt text", "H2 → H4"), never a score. Pure functions,
 * no I/O, so tests can load this file.
 *
 * Duplicate titles and descriptions, and broken internal links, need the
 * whole site, so they're found after every entry has been checked (run.ts).
 */
import { headingLevel } from "../headings/slug.js";

export const CHECKS = [
	"seoTitleMissing",
	"titleDuplicate",
	"titleLength",
	"descriptionMissing",
	"descriptionDuplicate",
	"descriptionLength",
	"altMissing",
	"socialImageMissing",
	"thin",
	"stale",
	"headings",
	"brokenLinks",
] as const;
export type CheckId = (typeof CHECKS)[number];

/** Labels and what each check means, for the report page and emails. US English, plain. */
export const CHECK_INFO: Record<CheckId, { label: string; description: string }> = {
	seoTitleMissing: { label: "No SEO title", description: "No title in the entry's SEO panel, so search results show the entry's own title." },
	titleDuplicate: { label: "Duplicate titles", description: "Another entry has the same title (SEO title, else the entry's title)." },
	titleLength: { label: "Title length", description: "The title is shorter or longer than the range in Settings. Search results cut long titles off." },
	descriptionMissing: { label: "No meta description", description: "No description in the entry's SEO panel." },
	descriptionDuplicate: { label: "Duplicate descriptions", description: "Another entry has the same meta description." },
	descriptionLength: { label: "Description length", description: "The meta description is shorter or longer than the range in Settings." },
	altMissing: { label: "Images without alt text", description: "Images in the content, or the entry's image fields, with no alt text." },
	socialImageMissing: { label: "No social image", description: "No image of its own for Open Graph and social cards (no SEO image or image field), so shares show the site's default image or none." },
	thin: { label: "Thin content", description: "Fewer words than the minimum in Settings." },
	stale: { label: "Not updated lately", description: "Not updated in longer than Settings allows." },
	headings: { label: "Heading problems", description: "Skipped heading levels (an H2 followed by an H4) or more than one H1 on the page." },
	brokenLinks: { label: "Broken internal links", description: "Links to pages on this site that Link Manager found broken." },
};

export interface AuditSettings {
	/** Collections to audit (slugs); empty means every collection with public pages. */
	collections: string[];
	/** Checks that are off. */
	off: CheckId[];
	titleMin: number;
	titleMax: number;
	descriptionMin: number;
	descriptionMax: number;
	/** Entries with fewer words are thin (0 turns the check off). */
	thinWords: number;
	/** Entries not updated in this many months are stale (0 turns the check off). */
	staleMonths: number;
	/** The theme prints the entry's title as the page's H1, so an H1 in the content is a second one. */
	titleIsH1: boolean;
}

export const AUDIT_DEFAULTS: AuditSettings = {
	collections: [],
	off: [],
	titleMin: 15,
	titleMax: 60,
	descriptionMin: 70,
	descriptionMax: 160,
	thinWords: 300,
	staleMonths: 12,
	titleIsH1: true,
};

/** Settings as stored (or anything), with defaults for whatever's missing or invalid. */
export function normalizeAuditSettings(raw: unknown): AuditSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof AuditSettings, unknown>>;
	const int = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback);
	const off = Array.isArray(r.off) ? r.off.filter((c): c is CheckId => (CHECKS as readonly string[]).includes(c as string)) : [];
	const collections = Array.isArray(r.collections) ? r.collections.filter((c): c is string => typeof c === "string" && /^[a-z][a-z0-9_]*$/.test(c)).slice(0, 100) : [];
	return {
		collections,
		off: [...new Set(off)],
		titleMin: int(r.titleMin, AUDIT_DEFAULTS.titleMin, 0, 200),
		titleMax: int(r.titleMax, AUDIT_DEFAULTS.titleMax, 10, 300),
		descriptionMin: int(r.descriptionMin, AUDIT_DEFAULTS.descriptionMin, 0, 500),
		descriptionMax: int(r.descriptionMax, AUDIT_DEFAULTS.descriptionMax, 50, 1000),
		thinWords: int(r.thinWords, AUDIT_DEFAULTS.thinWords, 0, 100_000),
		staleMonths: int(r.staleMonths, AUDIT_DEFAULTS.staleMonths, 0, 240),
		titleIsH1: typeof r.titleIsH1 === "boolean" ? r.titleIsH1 : AUDIT_DEFAULTS.titleIsH1,
	};
}

export const checkOn = (settings: AuditSettings, check: CheckId) => !settings.off.includes(check);

// ── Reading content ──────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Every node of a Portable Text value (or any JSON), depth first, in document order. Media references aren't followed. */
export function* walk(value: unknown, depth = 0): Generator<Obj> {
	if (depth > 40) return;
	if (Array.isArray(value)) {
		for (const item of value) yield* walk(item, depth + 1);
		return;
	}
	if (!isObj(value)) return;
	yield value;
	for (const [key, child] of Object.entries(value)) {
		if (key === "asset" || key === "markDefs") continue;
		if (typeof child === "object" && child !== null) yield* walk(child, depth + 1);
	}
}

/** Words in a Portable Text value: its spans' text. */
export function wordCount(value: unknown): number {
	let words = 0;
	for (const node of walk(value)) {
		if (node._type === "span" && typeof node.text === "string") words += node.text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0;
	}
	return words;
}

/** Images in Portable Text without alt text (an image block's or its asset's, the way EmDash renders them), gallery images included. */
export function imagesWithoutAlt(value: unknown): number {
	let missing = 0;
	for (const node of walk(value)) {
		if (node._type === "image" && isObj(node.asset)) {
			if (!nonEmpty(node.alt) && !nonEmpty(node.asset.alt)) missing++;
		} else if (node._type === "gallery" && Array.isArray(node.images)) {
			for (const image of node.images) if (isObj(image) && !nonEmpty(image.alt) && !(isObj(image.asset) && nonEmpty(image.asset.alt))) missing++;
		}
	}
	return missing;
}

/** Headings in a Portable Text value, in order. */
export function headingLevels(value: unknown): number[] {
	const out: number[] = [];
	for (const node of walk(value)) {
		const level = headingLevel(node);
		if (level) out.push(level);
	}
	return out;
}

/** Heading problems: more than one H1 on the page, and each skipped level ("H2 → H4"). */
export function headingProblems(levels: number[], titleIsH1: boolean): string[] {
	const problems: string[] = [];
	const h1s = levels.filter((l) => l === 1).length + (titleIsH1 ? 1 : 0);
	if (h1s > 1) problems.push(titleIsH1 ? `${h1s} H1s (the title and ${h1s - 1} in the content)` : `${h1s} H1s`);
	const skips = new Set<string>();
	let previous = titleIsH1 ? 1 : 0;
	for (const level of levels) {
		if (previous && level > previous + 1) skips.add(`H${previous} → H${level}`);
		previous = level;
	}
	problems.push(...skips);
	return problems.slice(0, 6);
}

/** Whether a media field value has an image, and whether it has alt text. */
function mediaValue(value: unknown): { set: boolean; alt: boolean } {
	if (nonEmpty(value)) return { set: true, alt: false };
	if (!isObj(value)) return { set: false, alt: false };
	const set = nonEmpty(value.id) || nonEmpty(value.src) || nonEmpty(value.url);
	return { set, alt: nonEmpty(value.alt) };
}

// ── One entry ────────────────────────────────────────────────────

export interface AuditEntry {
	collection: string;
	id: string;
	title: string;
	data: Record<string, unknown>;
	seo?: { title: string | null; description: string | null; image: string | null; noIndex?: boolean } | null;
	updatedAt: string | null;
}

export interface CollectionShape {
	slug: string;
	hasSeo: boolean;
	titleField: string | null;
	fields: Array<{ slug: string; type: string }>;
}

export type Issue = [CheckId, string];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The title search engines see: the SEO title, else the entry's title. */
export const effectiveTitle = (entry: AuditEntry) => (nonEmpty(entry.seo?.title) ? entry.seo.title.trim() : entry.title.trim());

/**
 * The per-entry checks (everything but duplicates and broken links).
 * `hasGeneratedImage`: Social Images made one for it, so it isn't missing.
 */
export function checkEntry(entry: AuditEntry, shape: CollectionShape, settings: AuditSettings, options: { now?: number; hasGeneratedImage?: boolean } = {}): Issue[] {
	const issues: Issue[] = [];
	const on = (c: CheckId) => checkOn(settings, c);
	const now = options.now ?? Date.now();
	const portable = shape.fields.filter((f) => f.type === "portableText");
	const images = shape.fields.filter((f) => f.type === "image");

	if (shape.hasSeo && on("seoTitleMissing") && !nonEmpty(entry.seo?.title)) issues.push(["seoTitleMissing", nonEmpty(entry.title) ? `Uses the entry title: “${entry.title.trim().slice(0, 120)}”` : "No title at all"]);
	const title = effectiveTitle(entry);
	if (on("titleLength") && title && (title.length < settings.titleMin || title.length > settings.titleMax)) issues.push(["titleLength", `${plural(title.length, "character")} (${title.length < settings.titleMin ? `under ${settings.titleMin}` : `over ${settings.titleMax}`})`]);

	if (shape.hasSeo) {
		const description = nonEmpty(entry.seo?.description) ? entry.seo.description.trim() : "";
		if (!description) {
			if (on("descriptionMissing")) issues.push(["descriptionMissing", "No meta description"]);
		} else if (on("descriptionLength") && (description.length < settings.descriptionMin || description.length > settings.descriptionMax)) {
			issues.push(["descriptionLength", `${plural(description.length, "character")} (${description.length < settings.descriptionMin ? `under ${settings.descriptionMin}` : `over ${settings.descriptionMax}`})`]);
		}
	}

	if (on("altMissing")) {
		let missing = 0;
		for (const f of portable) missing += imagesWithoutAlt(entry.data[f.slug]);
		for (const f of images) {
			const v = mediaValue(entry.data[f.slug]);
			if (v.set && !v.alt) missing++;
		}
		if (missing) issues.push(["altMissing", plural(missing, "image")]);
	}

	if (on("socialImageMissing") && !options.hasGeneratedImage) {
		const own = nonEmpty(entry.seo?.image) || images.some((f) => mediaValue(entry.data[f.slug]).set);
		if (!own) issues.push(["socialImageMissing", "No image of its own"]);
	}

	if (on("thin") && settings.thinWords > 0 && portable.length) {
		const words = portable.reduce((n, f) => n + wordCount(entry.data[f.slug]), 0);
		if (words < settings.thinWords) issues.push(["thin", plural(words, "word")]);
	}

	if (on("stale") && settings.staleMonths > 0 && entry.updatedAt) {
		const updated = Date.parse(entry.updatedAt.includes("T") || entry.updatedAt.endsWith("Z") ? entry.updatedAt : `${entry.updatedAt.replace(" ", "T")}Z`);
		const months = Number.isFinite(updated) ? Math.floor((now - updated) / (30.44 * 86_400_000)) : 0;
		if (months >= settings.staleMonths) issues.push(["stale", `Last updated ${months >= 24 ? `${Math.floor(months / 12)} years` : plural(months, "month")} ago`]);
	}

	if (on("headings") && portable.length) {
		const levels = portable.flatMap((f) => headingLevels(entry.data[f.slug]));
		const problems = headingProblems(levels, settings.titleIsH1);
		if (problems.length) issues.push(["headings", problems.join("; ")]);
	}
	return issues;
}

// ── Duplicates ───────────────────────────────────────────────────

/** A short, stable key for comparing titles and descriptions (case, spacing and punctuation at the ends ignored). */
export function textKey(text: string | null | undefined): string | null {
	const normalized = (text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
	if (!normalized) return null;
	// Two 32-bit FNV-1a hashes with different offsets: about one false match in 10^19 pairs.
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0x5bd1e995;
	for (let i = 0; i < normalized.length; i++) {
		const c = normalized.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0;
		b = Math.imul(b ^ c, 0x01000193) >>> 0;
	}
	return a.toString(36) + b.toString(36);
}

/** Groups of more than one item sharing a key: key → the items' indexes. */
export function duplicateGroups(keys: Array<string | null>): Map<string, number[]> {
	const groups = new Map<string, number[]>();
	keys.forEach((k, i) => {
		if (!k) return;
		const list = groups.get(k);
		if (list) list.push(i);
		else groups.set(k, [i]);
	});
	for (const [k, list] of groups) if (list.length < 2) groups.delete(k);
	return groups;
}

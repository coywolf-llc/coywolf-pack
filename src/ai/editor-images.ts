/**
 * AI Enrich's image text, pure (src/ai/editor-enrich.ts): the images in an
 * entry's draft that miss alt text or a caption, and the draft with text
 * filled in (only where it's empty: text a person wrote is never replaced).
 * No imports, so the admin's panel (src/admin/enrich-core.ts) can share
 * LEFT_ALONE_REASON.
 *
 * Images: every Portable Text image node (`_type: "image"` with an `asset`)
 * at any depth, galleries too, and each image field's value. A media item is
 * known by `asset._ref` or `asset.id` (an image field's `id`); one added by URL
 * or from another provider has none, and is left alone.
 */

type Node = Record<string, unknown>;

const isRecord = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");
const MAX_DEPTH = 20;

/** One image use in the draft that misses alt text, a caption, or both. */
export interface ImageSlot {
	field: string;
	/** The node's place in a Portable Text field (indexes and keys); [] for an image field's value. */
	path: Array<string | number>;
	/** The media library item, or null when it can't be known. */
	mediaId: string | null;
	needsAlt: boolean;
	needsCaption: boolean;
}

/** A media item's id, only for the local media library (EmDash's default provider). */
function localId(id: unknown, provider: unknown): string | null {
	if (typeof id !== "string" || !id || id.includes("/")) return null;
	return provider === undefined || provider === null || provider === "local" ? id : null;
}

function walk(value: unknown, field: string, path: Array<string | number>, out: ImageSlot[], depth: number): void {
	if (depth > MAX_DEPTH) return;
	if (Array.isArray(value)) {
		value.forEach((v, i) => walk(v, field, [...path, i], out, depth + 1));
		return;
	}
	if (!isRecord(value)) return;
	if (value._type === "image" && isRecord(value.asset)) {
		const needsAlt = !text(value.alt).trim();
		const needsCaption = !text(value.caption).trim();
		if (needsAlt || needsCaption) out.push({ field, path, mediaId: localId(value.asset._ref ?? value.asset.id, value.asset.provider), needsAlt, needsCaption });
		return;
	}
	for (const [key, v] of Object.entries(value)) {
		if (key === "markDefs" || key.startsWith("_")) continue;
		if (Array.isArray(v) || isRecord(v)) walk(v, field, [...path, key], out, depth + 1);
	}
}

/** The images that miss text: image fields first (a featured image), then each Portable Text field's in order. */
export function imageSlots(data: Record<string, unknown>, ptFields: readonly string[], imageFields: readonly string[]): ImageSlot[] {
	const out: ImageSlot[] = [];
	for (const field of imageFields) {
		const value = data[field];
		if (!isRecord(value)) continue;
		const needsAlt = !text(value.alt).trim();
		const needsCaption = !text(value.caption).trim();
		if (needsAlt || needsCaption) out.push({ field, path: [], mediaId: localId(value.id, value.provider), needsAlt, needsCaption });
	}
	for (const field of ptFields) walk(data[field], field, [], out, 0);
	return out;
}

/** Text for one image use: only what's set here, and only where the image has none. */
export interface ImageFill {
	path: Array<string | number>;
	alt?: string;
	caption?: string;
}

function setAt(value: unknown, path: ReadonlyArray<string | number>, fill: ImageFill): unknown {
	if (!path.length) {
		if (!isRecord(value)) return value;
		const next: Node = { ...value };
		if (fill.alt && !text(value.alt).trim()) next.alt = fill.alt;
		if (fill.caption && !text(value.caption).trim()) next.caption = fill.caption;
		return next;
	}
	const [step, ...rest] = path;
	if (Array.isArray(value) && typeof step === "number" && step < value.length) {
		const copy = value.slice();
		copy[step] = setAt(value[step], rest, fill);
		return copy;
	}
	if (isRecord(value) && typeof step === "string" && step in value) return { ...value, [step]: setAt(value[step], rest, fill) };
	return value;
}

/** A field's value with alt text and captions filled in (a copy; the input is unchanged). */
export function withImageText(value: unknown, fills: readonly ImageFill[]): unknown {
	let out = value;
	for (const fill of fills) out = setAt(out, fill.path, fill);
	return out;
}

/** Why an image without text is left as it is (the answer's toast, and the panel's review). */
export const LEFT_ALONE_REASON = "AI Enrich skips images whose suggestion was dismissed or marked decorative, SVGs, and images it can't read from the media library.";

const ENCODER = new TextEncoder();

/** The size of a value as JSON, in bytes (the route's body cap). */
export function jsonBytes(value: unknown): number {
	return ENCODER.encode(JSON.stringify(value) ?? "").byteLength;
}

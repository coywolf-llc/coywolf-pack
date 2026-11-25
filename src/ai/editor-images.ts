/**
 * AI Enrich's image text, pure (src/ai/editor-enrich.ts): the images in an
 * entry's draft that miss alt text or a caption, the draft with text filled
 * in (only where it's empty: text a person wrote is never replaced), the
 * size limits EmDash puts on an editor action's answer, and the patch
 * trimmed to them (fitPatch).
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

// ── Fitting the patch ────────────────────────────────────────────

/** One field's part of the patch: its value in the draft, that value with its glossary.io links (when it gets any), and its image text. */
export interface FieldPatch<F extends ImageFill = ImageFill> {
	field: string;
	base: unknown;
	linked?: unknown;
	fills: F[];
}

export interface FittedPatch<F extends ImageFill = ImageFill> {
	/** The value to set for each field that's in. */
	values: Map<string, unknown>;
	/** The image text that's in, per field. */
	fills: Map<string, F[]>;
	/** The fields whose links are in. */
	linked: Set<string>;
	/** Something was left out. */
	trimmed: boolean;
}

/** The fills without the last caption, or (when there's none) without the last alt text. Null when nothing is left to drop. */
function lighter<F extends ImageFill>(fills: readonly F[]): F[] | null {
	for (const prop of ["caption", "alt"] as const) {
		for (let i = fills.length - 1; i >= 0; i--) {
			if (!fills[i][prop]) continue;
			const copy: F = { ...fills[i] };
			delete copy[prop];
			return copy.alt || copy.caption ? fills.map((x, j) => (j === i ? copy : x)) : fills.filter((_, j) => j !== i);
		}
	}
	return null;
}

/** A field's versions, fullest first: with its links and less and less image text, then (when it has links) its image text alone, the same way. */
function* versions<F extends ImageFill>(f: FieldPatch<F>): Generator<{ value: unknown; fills: F[]; linked: boolean }> {
	const starts = f.linked === undefined ? [{ value: f.base, linked: false }] : [{ value: f.linked, linked: true }, { value: f.base, linked: false }];
	for (const start of starts) {
		for (let fills: F[] | null = f.fills; fills; fills = lighter(fills)) {
			if (fills.length || start.linked) yield { value: withImageText(start.value, fills), fills, linked: start.linked };
		}
	}
}

/**
 * Fit a patch into EmDash's limits (`fits`: whether these field values can go together), keeping what fits. Each
 * field in turn, the ones with links first, takes the fullest version of itself that fits with the fields already
 * in: its links and all its image text, then without captions from the last image backward, then without alt text
 * the same way, then (when its links alone don't fit) its image text without the links. It's left out only when
 * none fits, so a field that's too big never costs another field its image text.
 */
export function fitPatch<F extends ImageFill>(fields: ReadonlyArray<FieldPatch<F>>, fits: (values: ReadonlyMap<string, unknown>) => boolean): FittedPatch<F> {
	const out: FittedPatch<F> = { values: new Map(), fills: new Map(), linked: new Set(), trimmed: false };
	for (const f of [...fields.filter((x) => x.linked !== undefined), ...fields.filter((x) => x.linked === undefined)]) {
		if (f.linked === undefined && !f.fills.length) continue;
		let fullest = true;
		let taken = false;
		for (const version of versions(f)) {
			if (fits(new Map([...out.values, [f.field, version.value]]))) {
				out.values.set(f.field, version.value);
				if (version.fills.length) out.fills.set(f.field, version.fills);
				if (version.linked) out.linked.add(f.field);
				taken = true;
				break;
			}
			fullest = false;
		}
		if (!taken || !fullest) out.trimmed = true;
	}
	return out;
}

// ── EmDash's limits on an editor action's answer ─────────────────

/**
 * EmDash 1.5 (emdash/src/plugins/editor-draft.ts and @emdash-cms/blocks' validation; test/emdash-contract.test.mjs
 * checks them): a patched field's JSON, the whole patch, its operations, and the answer's node count, depth, array
 * length, string size and total size (validateResponseBounds). An answer over any of them shows EmDash's generic
 * "Plugin action failed", so the button trims its own patch to fit.
 */
export const ACTION_LIMITS = {
	fieldBytes: 64 * 1024,
	patchBytes: 192 * 1024,
	operations: 32,
	nodes: 2000,
	depth: 20,
	arrayItems: 1000,
	stringBytes: 64 * 1024,
	responseBytes: 256 * 1024,
} as const;

const ENCODER = new TextEncoder();

export function jsonBytes(value: unknown): number {
	return ENCODER.encode(JSON.stringify(value) ?? "").byteLength;
}

/** Whether an action's answer is within EmDash's response bounds (as validateResponseBounds counts them). */
export function responseFits(response: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value: response, depth: 0 }];
	let nodes = 0;
	let bytes = 0;
	while (stack.length) {
		const { value, depth } = stack.pop()!;
		if (++nodes > ACTION_LIMITS.nodes || depth > ACTION_LIMITS.depth) return false;
		if (typeof value === "string") {
			const size = ENCODER.encode(value).byteLength;
			if (value.length > ACTION_LIMITS.stringBytes || size > ACTION_LIMITS.stringBytes) return false;
			bytes += ENCODER.encode(JSON.stringify(value)).byteLength;
		} else if (value === null) bytes += 4;
		else if (typeof value === "number") bytes += Number.isFinite(value) ? String(value).length : 4;
		else if (typeof value === "boolean") bytes += value ? 4 : 5;
		else if (Array.isArray(value)) {
			if (value.length > ACTION_LIMITS.arrayItems) return false;
			for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], depth: depth + 1 });
		} else if (typeof value === "object") {
			const keys = Object.keys(value);
			if (keys.length > ACTION_LIMITS.arrayItems) return false;
			for (const key of keys) {
				bytes += ENCODER.encode(JSON.stringify(key)).byteLength;
				stack.push({ value: (value as Node)[key], depth: depth + 1 });
			}
		}
		if (bytes > ACTION_LIMITS.responseBytes) return false;
	}
	return jsonBytes(response) <= ACTION_LIMITS.responseBytes;
}

/**
 * Article context for AI image text, as Coywolf SEO's WordPress plugin sent it: when an image is used in a published
 * entry, the model also gets the entry's title, the heading above the image, and about 900 characters of text on each
 * side, with the image's place marked, so the alt text and caption fit how the image is used there while still
 * reading well on their own.
 *
 * Which entry: EmDash's media usage index (_emdash_media_usage, EmDash 1.5) gives the published, not deleted entries
 * that use the media item; the earliest-indexed one is used. Only published entries' text is sent to the AI provider.
 * No usage index (or no published use): no article context, as before.
 */

/** Plain-text marker put where the image sits, so the model knows its exact position. */
export const CONTEXT_MARKER = "«THE IMAGE BEING DESCRIBED»";

/** Characters kept on each side of the marker (about 450 input tokens in all). */
export const CONTEXT_WINDOW_CHARS = 900;

type Node = Record<string, unknown>;

const isRecord = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const squash = (s: string) => s.replace(/\s+/gu, " ").trim();
const stripTags = (html: string) => squash(html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'"));

/** Whether a Portable Text image block shows this media item (by id, or by its storage key in the URL). */
function isTarget(node: Node, mediaId: string, storageKey: string | null): boolean {
	if (node._type !== "image" || !isRecord(node.asset)) return false;
	const asset = node.asset;
	if (asset._ref === mediaId || asset.id === mediaId) return true;
	if (!storageKey) return false;
	const url = typeof asset.url === "string" ? asset.url : typeof asset.src === "string" ? asset.src : "";
	return url.endsWith(`/${storageKey}`);
}

interface WalkState {
	parts: string[];
	heading: string;
	markerHeading: string;
	found: boolean;
}

/** Plain text of a Portable Text text block (its spans). */
function blockText(node: Node): string {
	const children = Array.isArray(node.children) ? node.children : [];
	return squash(children.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : "")).join(""));
}

function walk(value: unknown, mediaId: string, storageKey: string | null, state: WalkState, depth = 0): void {
	if (depth > 20 || !Array.isArray(value)) return;
	for (const node of value) {
		if (!isRecord(node)) continue;
		if (isTarget(node, mediaId, storageKey)) {
			// Mark only the first use: a repeated image shouldn't scatter markers through the context.
			if (!state.found) {
				state.parts.push(CONTEXT_MARKER);
				state.markerHeading = state.heading;
				state.found = true;
			}
			continue;
		}
		if (node._type === "block") {
			const text = blockText(node);
			if (!text) continue;
			if (typeof node.style === "string" && /^h[1-6]$/.test(node.style)) state.heading = text;
			state.parts.push(text);
			continue;
		}
		if (node._type === "code") continue;
		// Other blocks: their HTML or text (an HTML block, a Details body…), then any nested Portable Text.
		for (const [key, v] of Object.entries(node)) {
			if (key.startsWith("_") || key === "asset" || key === "markDefs") continue;
			if (typeof v === "string" && v.length > 2 && /[\s<]/.test(v)) {
				const text = v.includes("<") ? stripTags(v) : squash(v);
				if (text) state.parts.push(text);
			} else if (Array.isArray(v)) {
				walk(v, mediaId, storageKey, state, depth + 1);
			}
		}
	}
}

/**
 * The context for one image in one entry: "Article title: …", "Section heading: …" (the nearest heading above the
 * image), then a window of the entry's text around the marker. Only the title when the image's block can't be
 * pinpointed; "" when there's nothing to give.
 */
export function buildImageContext(title: string, fields: unknown[], mediaId: string, storageKey: string | null, win = CONTEXT_WINDOW_CHARS): string {
	const state: WalkState = { parts: [], heading: "", markerHeading: "", found: false };
	for (const field of fields) walk(field, mediaId, storageKey, state);
	const cleanTitle = squash(title);
	if (!state.found) return cleanTitle ? `Article title: ${cleanTitle}` : "";
	let text = state.parts.join("\n");
	const pos = text.indexOf(CONTEXT_MARKER);
	if (pos !== -1) {
		let before = text.slice(0, pos);
		let after = text.slice(pos + CONTEXT_MARKER.length);
		if ([...before].length > win) before = `…${[...before].slice(-win).join("").trimStart()}`;
		if ([...after].length > win) after = `${[...after].slice(0, win).join("").trimEnd()}…`;
		text = `${before}${CONTEXT_MARKER}${after}`;
	}
	let out = cleanTitle ? `Article title: ${cleanTitle}` : "";
	if (state.markerHeading) out += `${out ? "\n" : ""}Section heading: ${state.markerHeading}`;
	return `${out}${out ? "\n\n" : ""}${text.trim()}`;
}

/** The published, not deleted entry that uses a media item (EmDash's media usage index), or null. */
export async function findImageEntry(db: D1Database, mediaId: string): Promise<{ collection: string; id: string; title: string | null } | null> {
	try {
		const row = await db
			.prepare(
				`SELECT s.collection_slug AS collection, s.content_id AS id, s.content_title AS title
				FROM _emdash_media_usage u JOIN _emdash_media_usage_sources s ON s.source_key = u.source_key
				WHERE u.media_id = ? AND s.source_type = 'content' AND s.content_status = 'published' AND s.content_deleted_at IS NULL
				ORDER BY s.created_at ASC LIMIT 1`,
			)
			.bind(mediaId)
			.first<{ collection: string | null; id: string | null; title: string | null }>();
		return row?.collection && row.id ? { collection: row.collection, id: row.id, title: row.title } : null;
	} catch {
		// No usage index (EmDash before 1.5, or a site that never built it): no article context.
		return null;
	}
}

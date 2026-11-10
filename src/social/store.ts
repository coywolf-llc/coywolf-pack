/**
 * Social Images' records: one plugin-storage document per entry
 * (`socialImages`, id "<collection>:<entry id>", the key the page read uses,
 * src/core/entry-docs.ts), with the stored image's key in the media bucket
 * and the hash of what it shows. A document waiting for an image is
 * "pending" (the hourly job and the admin page work through those); one that
 * failed records why.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { readEntryDocs } from "../core/entry-docs.js";
import { registerSiteSetting, siteSetting } from "../core/features.js";
import { imageCdn } from "../images/lib.js";
import { HEIGHT, WIDTH } from "./template.js";

/** Social Images' settings (template, collections, theme default images): read with the feature switches (no query of its own on a page). */
export const SOCIAL_SETTINGS_KEY = "socialImagesSettings";
registerSiteSetting(SOCIAL_SETTINGS_KEY);

/** The theme's site-wide share images from the settings: http(s) URLs or root-relative paths, at most 10. */
export function parseDefaultImages(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const v of raw) {
		if (typeof v !== "string") continue;
		const s = v.trim();
		if (s.length > 500 || !(/^https?:\/\/\S+$/i.test(s) || /^\/(?!\/)\S*$/.test(s))) continue;
		if (!out.includes(s)) out.push(s);
	}
	return out.slice(0, 10);
}

const imagePath = (url: string) => {
	try {
		return decodeURIComponent(new URL(url, "https://site.invalid").pathname);
	} catch {
		return url;
	}
};

/** Whether a page's image is one of the theme's defaults (compared by path, so the host and query don't matter). */
export function isThemeDefault(url: string | null | undefined, defaults: readonly string[]): boolean {
	if (!url || !defaults.length) return false;
	const path = imagePath(url);
	return defaults.some((d) => imagePath(d) === path);
}

/** The theme default images, from the switches' cached query. */
export async function themeDefaultImages(database?: string): Promise<string[]> {
	const settings = await siteSetting<{ defaultImages?: unknown }>(SOCIAL_SETTINGS_KEY, database).catch(() => null);
	return parseDefaultImages(settings?.defaultImages);
}

export const SOCIAL_COLLECTION = "socialImages";
export const SOCIAL_STORAGE = { [SOCIAL_COLLECTION]: { indexes: ["status", "updatedAt"] } };

export interface SocialImageDoc {
	collection: string;
	id: string;
	title: string;
	/** The current image's key in the media bucket (kept while a new one is made). */
	key: string | null;
	/** The hash of what `key` shows. */
	hash: string | null;
	/**
	 * The image `key` replaced, kept until the next one: pages still in the edge cache may point to it (a
	 * template change doesn't purge them), so it's deleted one change later.
	 */
	previousKey?: string | null;
	status: "ready" | "pending" | "failed" | "skipped";
	/** Why it failed, or why it was skipped ("Has its own image"). */
	note: string | null;
	attempts: number;
	updatedAt: string;
	renderedAt: string | null;
}

export const docId = (collection: string, id: string) => `${collection}:${id}`;

export function socialImages(ctx: PluginContext): StorageCollection<SocialImageDoc> {
	return ctx.storage[SOCIAL_COLLECTION] as StorageCollection<SocialImageDoc>;
}

/** The public URL of a stored image: on the media host when there is one, else EmDash's media file route on the site. */
export function socialImageUrl(key: string, origin: string): string {
	const cdn = imageCdn();
	if (cdn) return `${cdn}/${key}`;
	return `${origin.replace(/\/+$/, "")}/_emdash/api/media/file/${key}`;
}

export interface GeneratedImage {
	url: string;
	width: number;
	height: number;
	alt: string;
	mimeType: string;
}

/** The entry's generated image for the page:metadata hook (one read, batched with the page's other pack reads), or null. */
export async function generatedImage(ctx: PluginContext, content: { collection: string; id: string }, origin: string, database?: string): Promise<GeneratedImage | null> {
	const docs = await readEntryDocs(ctx, { collection: content.collection, id: content.id, collections: [SOCIAL_COLLECTION], database });
	const doc = docs.docs.get(SOCIAL_COLLECTION) as SocialImageDoc | null | undefined;
	// "skipped": the entry has an image of its own (or isn't published) now, so its old generated image isn't used.
	if (!doc?.key || doc.status === "skipped") return null;
	return { url: socialImageUrl(doc.key, origin), width: WIDTH, height: HEIGHT, alt: doc.title, mimeType: "image/png" };
}

/** Queue an entry for an image (kept as it is when it's already pending). */
export async function markPending(ctx: PluginContext, collection: string, id: string, title = ""): Promise<void> {
	const store = socialImages(ctx);
	const existing = await store.get(docId(collection, id));
	if (existing?.status === "pending") return;
	await store.put(docId(collection, id), {
		collection,
		id,
		title: title || existing?.title || "",
		key: existing?.key ?? null,
		hash: existing?.hash ?? null,
		status: "pending",
		note: null,
		attempts: 0,
		updatedAt: new Date().toISOString(),
		renderedAt: existing?.renderedAt ?? null,
	});
}

export async function counts(ctx: PluginContext): Promise<Record<SocialImageDoc["status"], number>> {
	const store = socialImages(ctx);
	const [ready, pending, failed, skipped] = await Promise.all([store.count({ status: "ready" }), store.count({ status: "pending" }), store.count({ status: "failed" }), store.count({ status: "skipped" })]);
	return { ready, pending, failed, skipped };
}

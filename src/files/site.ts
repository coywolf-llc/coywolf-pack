/**
 * Site-side reads and writes for File Downloads, outside the plugin context
 * (the download middleware and the Astro download card). They go straight to
 * D1: plugin settings live in `options` (read with the feature switches),
 * large uploads and download counts in `_plugin_storage`, media library files
 * in `media`. Reads are cached per isolate; download counts are batched and written after the response.
 */
import { PLUGIN_ID, invalidateFeatures, isCurrent, readSiteSetting, registerSiteSetting, settingsEpoch } from "../core/features.js";
import { createDownloadCounter } from "./counts.js";
import { isUploadId, normalizeBase, safeColor } from "./format.js";

export const COLLECTIONS = {
	uploads: "files_uploads",
	usage: "files_usage",
	counts: "files_counts",
} as const;

/** Site settings the card and downloads need (never the S3 credentials). */
export interface SiteSettings {
	base: string;
	publicBaseUrl: string;
	scheme: "auto" | "light" | "dark";
	accent: string;
}

/** A downloadable file, from either store. */
export interface FileRecord {
	id: string;
	source: "upload" | "media";
	name: string;
	type: string;
	size: number;
	uploadedAt: string;
	key: string;
}

/** Large-upload metadata in plugin storage. */
export interface UploadDoc {
	id: string;
	key: string;
	name: string;
	size: number;
	type: string;
	uploadedAt: string;
	status: "uploading" | "ready";
	uploadId?: string;
	partSize?: number;
}

const SETTING_KEYS = ["filesBase", "filesPublicBaseUrl", "filesScheme", "filesAccent"] as const;
for (const key of SETTING_KEYS) registerSiteSetting(key);
const FILE_TTL = 60_000;
const FILE_CACHE_MAX = 500;

/** The last stored values and the settings made from them, so a cache hit doesn't rebuild them. */
let settingsMemo: { raw: unknown[]; value: SiteSettings } | null = null;
/**
 * File records by id, per isolate. Keyed on the settings epoch as well as the
 * lifetime: a pack admin change in another isolate (a deleted or replaced
 * large upload) reaches this one with the settings generation, and a page
 * rendered after that carries the new generation's cache tag, so it must not
 * show the old record (the settling purge wouldn't clear it).
 */
const fileCache = new Map<string, { value: FileRecord | null; at: number; epoch: number }>();

/** Forget cached settings and files (after admin changes in this isolate). */
export function invalidateSiteCache(id?: string): void {
	if (id) fileCache.delete(id);
	else {
		invalidateFeatures();
		fileCache.clear();
	}
}

export function settingsFrom(raw: Record<string, unknown>): SiteSettings {
	const scheme = raw.filesScheme === "light" || raw.filesScheme === "dark" ? raw.filesScheme : "auto";
	const publicBase = typeof raw.filesPublicBaseUrl === "string" ? raw.filesPublicBaseUrl.trim().replace(/\/+$/, "") : "";
	return {
		base: normalizeBase(raw.filesBase),
		publicBaseUrl: /^https:\/\/[^\s"'<>]+$/i.test(publicBase) ? publicBase : "",
		scheme,
		accent: safeColor(raw.filesAccent),
	};
}

/** The settings from D1, in the feature switches' query and per-isolate cache (defaults if it can't be read). */
export async function readSiteSettings(db: D1Database): Promise<SiteSettings> {
	const reads = await Promise.all(SETTING_KEYS.map((key) => readSiteSetting(key, db)));
	if (reads.some((r) => !r)) console.error("coywolf-pack files: could not read settings");
	const raw = reads.map((r) => r?.value ?? null);
	const memo = settingsMemo;
	if (memo && raw.every((v, i) => v === memo.raw[i])) return memo.value;
	const value = settingsFrom(Object.fromEntries(SETTING_KEYS.map((key, i) => [key, raw[i] ?? undefined])));
	settingsMemo = { raw, value };
	return value;
}

export function uploadToRecord(doc: UploadDoc): FileRecord {
	return { id: doc.id, source: "upload", name: doc.name, type: doc.type, size: doc.size, uploadedAt: doc.uploadedAt, key: doc.key };
}

/** Look up a file by id: a ready large upload, or a ready media library item. Null when missing. */
export async function resolveFile(db: D1Database, id: string): Promise<FileRecord | null> {
	const hit = fileCache.get(id);
	if (hit && isCurrent(hit, FILE_TTL)) return hit.value;
	const epoch = settingsEpoch();
	let value: FileRecord | null = null;
	if (isUploadId(id)) {
		const row = await db
			.prepare("SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?")
			.bind(PLUGIN_ID, COLLECTIONS.uploads, id)
			.first<{ data: string }>();
		const doc = row ? (JSON.parse(row.data) as UploadDoc) : null;
		value = doc && doc.status === "ready" ? uploadToRecord(doc) : null;
	} else {
		const row = await db
			.prepare("SELECT id, filename, mime_type, size, storage_key, created_at, status FROM media WHERE id = ?")
			.bind(id)
			.first<{ id: string; filename: string; mime_type: string; size: number | null; storage_key: string; created_at: string; status: string | null }>();
		value =
			row && (row.status ?? "ready") === "ready"
				? {
						id: row.id,
						source: "media",
						name: row.filename,
						type: row.mime_type,
						size: row.size ?? 0,
						uploadedAt: row.created_at,
						key: row.storage_key,
					}
				: null;
	}
	if (fileCache.size >= FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value as string);
	// Not when the settings moved while this read ran: it may be from before the change.
	if (epoch === settingsEpoch()) fileCache.set(id, { value, at: Date.now(), epoch });
	return value;
}

// ── Download counts ──────────────────────────────────────────────

const counter = createDownloadCounter(PLUGIN_ID, COLLECTIONS.counts);

/** Count a download; counts within a second in this isolate are written together after the response. */
export function countDownload(db: D1Database, id: string, waitUntil: (p: Promise<unknown>) => void): void {
	counter.count(db, id, waitUntil);
}

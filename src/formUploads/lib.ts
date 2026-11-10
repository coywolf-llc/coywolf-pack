/**
 * Private form uploads: the pure parts (no EmDash or Cloudflare imports, so
 * tests run them directly). See ./wrap.ts for how the Forms plugin is wrapped.
 */

/** Prefix of the media id the Forms plugin stores for a file kept in the private bucket. */
export const PRIVATE_PREFIX = "coywolf-private:";
/** Forms plugin KV: one entry per private file (the index the admin page lists). */
export const ENTRY_PREFIX = "coywolf-private-upload:";
/** Forms plugin KV: which forms keep their files private, and for how long. */
export const CONFIG_KEY = "coywolf-private-uploads:config";
/** Cron task (on the Forms plugin) that tidies files whose submission is gone, and applies the retention setting. */
export const SWEEP_TASK = "coywolf-private-uploads";
/** Route names added to the Forms plugin, under /_emdash/api/plugins/emdash-forms/. */
export const ROUTE_PREFIX = "coywolf-private-uploads/";
/** The Forms plugin's own cap for one file; enforced again here in case a future version raises it. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Download chunk: plugin route responses are capped at 8 MB. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** A file with no submission after this long belongs to a submission that failed to save. */
export const ORPHAN_AFTER_MS = 60 * 60_000;

export interface FormUploadsConfig {
	/** "all": every form's files are private. "selected": only the forms in `forms` (form ids). */
	scope: "all" | "selected";
	forms: string[];
	/** Delete private files this many days after upload (the submission stays). 0 keeps them until the submission is deleted. */
	retentionDays: number;
}

export const DEFAULT_CONFIG: FormUploadsConfig = { scope: "all", forms: [], retentionDays: 0 };

export function normalizeConfig(value: unknown): FormUploadsConfig {
	const v = (value && typeof value === "object" ? value : {}) as Partial<FormUploadsConfig>;
	const forms = Array.isArray(v.forms) ? [...new Set(v.forms.filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= 200))].slice(0, 500) : [];
	const days = Number(v.retentionDays);
	return {
		scope: v.scope === "selected" ? "selected" : "all",
		forms,
		retentionDays: Number.isInteger(days) && days > 0 ? Math.min(days, 3650) : 0,
	};
}

/** Whether a form's files go to the private bucket. Matches the form's id or slug. */
export function formSelected(config: FormUploadsConfig, form: { id: string; slug?: string }): boolean {
	if (config.scope === "all") return true;
	return config.forms.includes(form.id) || (!!form.slug && config.forms.includes(form.slug));
}

/** One private file, as kept in the Forms plugin's KV. */
export interface UploadEntry {
	id: string;
	/** Object key in the private bucket. */
	key: string;
	formId: string;
	formSlug: string;
	formName: string;
	fieldName: string;
	fieldLabel: string;
	/** Sanitized file name (what the download is saved as). */
	filename: string;
	/** Type the visitor's browser reported (shown to admins; never served as-is). */
	contentType: string;
	size: number;
	uploadedAt: string;
	/** The Forms submission it belongs to; null until the submission is saved. */
	submissionId: string | null;
	/** "media-library" when moved by the one-time migration. */
	source?: "form" | "media-library";
}

export const privateMediaId = (id: string) => `${PRIVATE_PREFIX}${id}`;

/** The upload id in a private media id, or null for an ordinary media-library id. */
export function privateIdOf(mediaId: unknown): string | null {
	if (typeof mediaId !== "string" || !mediaId.startsWith(PRIVATE_PREFIX)) return null;
	const id = mediaId.slice(PRIVATE_PREFIX.length);
	return UPLOAD_ID.test(id) ? id : null;
}

export const UPLOAD_ID = /^[a-f0-9]{32}$/;

export function newUploadId(): string {
	return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const objectKey = (id: string) => `uploads/${id}`;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME = 120;

/**
 * A file name that's safe to show, store and save: the last path segment,
 * without control characters, characters Windows or macOS refuse
 * (\ / : * ? " < > |), leading dots (hidden files) or trailing dots and
 * spaces, at most 120 characters with the extension kept. Falls back to
 * "upload".
 */
export function sanitizeFilename(name: unknown): string {
	let base = String(name ?? "")
		.normalize("NFC")
		.split(/[\\/]/)
		.pop()!
		// Control characters in the pattern: stripping control characters is the point.
		.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
		.replace(/[:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	const dot = base.lastIndexOf(".");
	let stem = dot > 0 ? base.slice(0, dot) : base;
	let ext = dot > 0 ? base.slice(dot + 1) : "";
	if (ext.length > 16 || !/^[\p{L}\p{N}_-]+$/u.test(ext)) {
		stem = base;
		ext = "";
	}
	if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
	const room = MAX_NAME - (ext ? ext.length + 1 : 0);
	if ([...stem].length > room) stem = [...stem].slice(0, room).join("").trimEnd();
	base = ext ? `${stem}.${ext}` : stem;
	return base && base !== "." ? base : "upload";
}

/**
 * Types a download may be labeled with. Anything else (HTML, SVG, XML,
 * JavaScript, CSS, unknown types) goes out as application/octet-stream, so
 * a browser never renders an uploaded file as a page or runs it.
 */
const SAFE_TYPES = new Set([
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/json",
	"application/msword",
	"application/rtf",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
	"application/vnd.oasis.opendocument.text",
	"application/vnd.oasis.opendocument.spreadsheet",
	"application/vnd.oasis.opendocument.presentation",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/heic",
	"image/heif",
	"image/bmp",
	"image/tiff",
	"text/plain",
	"text/csv",
	"audio/mpeg",
	"audio/mp4",
	"audio/ogg",
	"audio/wav",
	"audio/webm",
	"video/mp4",
	"video/quicktime",
	"video/webm",
	"video/ogg",
]);

export function safeContentType(type: unknown): string {
	const mime = String(type ?? "")
		.split(";", 1)[0]!
		.trim()
		.toLowerCase();
	return SAFE_TYPES.has(mime) ? mime : "application/octet-stream";
}

/**
 * Types a form may store: the same as EmDash's media library accepts from a
 * plugin upload (images, video, audio, PDF), so keeping files private never
 * lets a form take files it couldn't take before. The type is the one the
 * visitor's browser reported; the field's own `accept` list is checked by
 * the Forms plugin first.
 */
const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/jxl", "application/pdf"];
const UPLOAD_PREFIXES = ["video/", "audio/"];
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export function uploadTypeAllowed(type: unknown): boolean {
	const mime = String(type ?? "")
		.split(";", 1)[0]!
		.trim()
		.toLowerCase();
	if (!MIME.test(mime)) return false;
	return UPLOAD_TYPES.includes(mime) || UPLOAD_PREFIXES.some((p) => mime.startsWith(p));
}

/** "1.2 MB" */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Byte range of download chunk `part` of a file of `size` bytes, or null past the end. */
export function chunkRange(size: number, part: number): { start: number; end: number } | null {
	if (!Number.isInteger(part) || part < 0) return null;
	const start = part * CHUNK_BYTES;
	if (start >= size && !(size === 0 && part === 0)) return null;
	return { start, end: Math.min(size, start + CHUNK_BYTES) - 1 };
}

/** Total size from a "bytes 0-99/1234" Content-Range header. */
export function totalFromContentRange(header: string | null): number | null {
	const match = /\/(\d+)\s*$/.exec(header ?? "");
	return match ? Number(match[1]) : null;
}

/**
 * Which of the submitted files a Forms upload call is for. The Forms plugin
 * uploads files one by one with (filename, type, bytes) and no field name,
 * so match on name and size, skipping fields already matched.
 */
export function matchField(
	files: Record<string, { filename: string; contentType?: string; bytes: { byteLength: number } }> | undefined,
	filename: string,
	size: number,
	taken: Set<string>,
): string {
	for (const [field, file] of Object.entries(files ?? {})) {
		if (taken.has(field)) continue;
		if (file.filename === filename && file.bytes.byteLength === size) {
			taken.add(field);
			return field;
		}
	}
	return "";
}

/** A short line from a submission's answers, so admins can tell submissions apart. */
export function submissionPreview(data: Record<string, unknown> | undefined, max = 140): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(data ?? {})) {
		if (key.startsWith("_") || key === "cf-turnstile-response") continue;
		const text = Array.isArray(value) ? value.join(", ") : value === null || value === undefined ? "" : String(value);
		const clean = text.replace(/\s+/g, " ").trim();
		if (clean) parts.push(clean);
		if (parts.join(" · ").length >= max) break;
	}
	const line = parts.join(" · ");
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Entries the daily sweep deletes: past retention, orphaned, or whose submission is gone. */
export function sweepDecision(
	entry: UploadEntry,
	opts: { now: number; retentionDays: number; submissionExists: boolean | null },
): "keep" | "retention" | "orphan" | "relink" {
	const age = opts.now - Date.parse(entry.uploadedAt);
	if (opts.retentionDays > 0 && age > opts.retentionDays * 86_400_000) return "retention";
	if (entry.submissionId) return opts.submissionExists === false ? "orphan" : "keep";
	return age > ORPHAN_AFTER_MS ? "relink" : "keep";
}

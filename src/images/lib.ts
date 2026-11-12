/**
 * Clean image URLs on the media host: resized copies of media-library images at
 *
 *   https://media.example.com/<file>              the original file
 *   https://media.example.com/s/<w>x<h>/<file>    cropped to fill
 *   https://media.example.com/s/<w>/<file>        width only, keeps the ratio
 *
 * instead of Astro's /_image?href=…&w=…&h=… endpoint. Pure helpers (no
 * imports) so tests can load them; the middleware is in pack.ts.
 *
 * The media host is an R2 custom domain on the media bucket, with Cloudflare
 * Image Transformations and the zone's /s/ rewrite rules. Where it comes from:
 *
 *  - EmDash's own setting: `storage: r2({ binding, publicUrl })` in
 *    astro.config.mjs, when publicUrl is a plain https origin (not r2.dev).
 *    EmDash's own components (Image, Gallery, site-settings logo and
 *    favicon…) print media there too, so it's one setting for both.
 *  - The host saved on the Clean Image URLs page (the pack's own host;
 *    the `images.cdn` option was removed in 0.40.0).
 *
 * When only one is set, that's the host. When both are and they differ, the
 * pack's own host wins (it's the one known to have the /s/ rules), and the
 * Clean Image URLs page says so: publicUrl takes over once it's the same
 * host, or once the pack's own is removed (after Check passes on it).
 *
 * Media URLs are recognized in each form EmDash and the pack print them:
 * /_emdash/api/media/file/<file> (EmDash without publicUrl), <publicUrl>/<file>
 * (EmDash with it, even when publicUrl isn't a plain origin), and <media host>/<file>.
 *
 * Earlier releases gave a site without a media host resized copies from the
 * Worker at /media/<file id>-<w>x<h>.<format>. That route duplicated
 * EmDash's own /_image endpoint and no site used it, so it's gone: without a
 * media host cleanImagePath() returns null (themes use their usual image
 * code), and old /media/ addresses only redirect (301) to the media host.
 */

export const IMAGE_PATH = "/media/";
/**
 * Media library files: /_emdash/api/media/file/<key> (EmDash's media route),
 * where the key is <stem>.<ext>. The stem is EmDash's file ULID (not the media
 * id), and since EmDash 1.1 uploads it can hold a dot (<ulid>.<attempt ulid>),
 * so a stem is anything up to the last dot.
 */
const MEDIA_FILE = /^(?:https?:\/\/[^/]+)?\/_emdash\/api\/media\/file\/([A-Za-z0-9_.-]+)\.([a-z0-9]{2,5})(?:[?#].*)?$/i;
const CLEAN = /^\/media\/([A-Za-z0-9_.-]+)-(?:(\d{1,4})x(\d{1,4})|(\d{1,4})w)\.(webp|avif|jpe?g|png)$/i;
export const MAX_DIMENSION = 2560;
export const FORMATS: Record<string, string> = { webp: "image/webp", avif: "image/avif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

/** MIME types of original files by extension (for og:image:type on media-host URLs). */
export const EXT_MIME: Record<string, string> = { ...FORMATS, gif: "image/gif", svg: "image/svg+xml" };
/** Originals the media host (Cloudflare Image Transformations) can resize. */
const CDN_RESIZABLE = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "heic"]);

/** The MIME type of a file extension, or undefined when unknown. */
export function mimeForExt(ext: string | null | undefined): string | undefined {
	return EXT_MIME[String(ext ?? "").toLowerCase()];
}

/**
 * Normalize a media host to its https origin ("media.example.com",
 * "https://media.example.com/" → "https://media.example.com"). Null for
 * anything that isn't a plain https host name (no path, query, user or port
 * other than the default).
 */
export function normalizeMediaHost(input: string | null | undefined): string | null {
	let v = String(input ?? "").trim();
	if (!v) return null;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
	v = v.replace(/\/+$/, "");
	const m = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i.exec(v);
	return m ? `https://${m[1].toLowerCase()}` : null;
}

/**
 * The media host saved on the Clean Image URLs page, and EmDash's storage
 * publicUrl (as a plain origin, and as written, for recognizing EmDash's media
 * URLs). The pack's own `images.cdn` option was removed in 0.40.0.
 */
let savedBase: string | null = null;
let storageBase: string | null = null;
let storagePrefix: string | null = null;

/** Set (or clear) the media host saved in the admin. */
export function setSavedImageCdn(url: string | null | undefined): void {
	savedBase = normalizeMediaHost(url);
}

/**
 * Set (or clear) EmDash's storage publicUrl (`r2({ publicUrl })`). As a plain
 * https origin it's the media host, ahead of the saved host and the option.
 * With a path (or on http) it isn't usable for /s/ resizing, but media URLs
 * under it are still recognized as media-library files.
 */
export function setStoragePublicUrl(url: string | null | undefined): void {
	const raw = String(url ?? "").trim().replace(/\/+$/, "");
	storagePrefix = /^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i.test(raw) ? raw : null;
	const host = normalizeMediaHost(raw);
	// An r2.dev address isn't in a zone, so it can't have Image Transformations or the /s/ rules: never the media host.
	storageBase = host && !/\.r2\.dev$/i.test(host) ? host : null;
}

/** The media host in use (https origin, no trailing slash), or null when there's none. */
export function imageCdn(): string | null {
	const packHost = savedBase;
	// A publicUrl that isn't the pack's own working host doesn't take over unannounced: it may lack the /s/ rules.
	if (storageBase && packHost && storageBase !== packHost) return packHost;
	return storageBase ?? packHost;
}

/** Every base under which a media-library file can appear as <base>/<file>, the host in use first. */
function mediaBases(): string[] {
	return [...new Set([imageCdn(), storagePrefix, savedBase].filter((b): b is string => Boolean(b)))];
}

/**
 * Add `Link: <media host>; rel=preconnect` to a page (HTML) response, so the
 * browser opens the connection to the media host (DNS, TCP, TLS) while the
 * page is still arriving instead of when it reaches the first image. No
 * `crossorigin`: images are fetched without CORS, so that's the connection
 * they use. Returns the response unchanged without a host, for anything but
 * HTML, or when it already has a preconnect to the host.
 */
export function withMediaPreconnect(response: Response, host: string | null = imageCdn()): Response {
	if (!host || !(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
	const link = response.headers.get("link") ?? "";
	if (link.includes(`<${host}>`) && /rel="?preconnect/i.test(link)) return response;
	const value = `<${host}>; rel=preconnect`;
	try {
		response.headers.append("link", value);
		return response;
	} catch {
		// Immutable headers (a response passed through from fetch): copy it.
		const copy = new Response(response.body, response);
		copy.headers.append("link", value);
		return copy;
	}
}

/**
 * Where the media host comes from: EmDash's publicUrl (`storage`, as a plain
 * origin; `storageUrl` as written), the admin setting, or nowhere.
 */
export function imageCdnSource(): {
	host: string | null;
	saved: string | null;
	storage: string | null;
	storageUrl: string | null;
	from: "storage" | "saved" | null;
	/** EmDash's publicUrl is a usable host but not the one in use (the pack's own differs). */
	conflict: boolean;
} {
	const host = imageCdn();
	const from = host && host === storageBase ? "storage" : savedBase ? "saved" : null;
	return { host, saved: savedBase, storage: storageBase, storageUrl: storagePrefix, from, conflict: Boolean(storageBase && host && storageBase !== host) };
}

export interface ImageRequest {
	id: string;
	width: number;
	height?: number;
	format: string;
}

/** A media-library file's bucket key as stored by EmDash (<id>.<ext>). */
const KEY = /^([A-Za-z0-9_.-]+)\.([a-z0-9]{2,5})$/i;

/**
 * The file id and extension of a media-library URL, or null for anything
 * else: EmDash's /_emdash/api/media/file/<file> (relative or absolute), or the
 * original file under EmDash's publicUrl or a media host (<base>/<file>, the
 * form EmDash prints with publicUrl set). Resized and stored sizes on the
 * media host (/s/…, /v1/…) aren't files: see parseCdnUrl.
 */
export function mediaFile(src: string | null | undefined): { id: string; ext: string } | null {
	const value = String(src ?? "").trim();
	const m = MEDIA_FILE.exec(value);
	if (m) return { id: m[1], ext: m[2].toLowerCase() };
	for (const base of mediaBases()) {
		if (!value.startsWith(`${base}/`)) continue;
		const key = KEY.exec(value.slice(base.length + 1).split(/[?#]/)[0] ?? "");
		if (key) return { id: key[1], ext: key[2].toLowerCase() };
	}
	return null;
}

/** The original file on the media host, or null when there's no host or `src` isn't a media-library file. */
export function cdnOriginalUrl(src: string | null | undefined): string | null {
	const cdn = imageCdn();
	if (!cdn) return null;
	const file = mediaFile(src);
	if (file) return `${cdn}/${file.id}.${file.ext}`;
	// Already on the media host: its original.
	const onHost = parseCdnUrl(String(src ?? "").trim());
	return onHost ? `${cdn}/${onHost.id}.${onHost.ext}` : null;
}

/**
 * Build a clean URL on the media host; null when there's no media host, `src`
 * isn't a media-library file, or the size is out of range. The host picks the
 * format (`format` is ignored: it only applied to the Worker route, which is gone).
 */
export function cleanImagePath(src: string | null | undefined, options: { width: number; height?: number; format?: string }): string | null {
	const cdn = imageCdn();
	if (!cdn) return null;
	const file = mediaFile(src);
	if (!file) return null;
	const width = Math.round(options.width);
	const height = options.height === undefined ? undefined : Math.round(options.height);
	if (!(width >= 1 && width <= MAX_DIMENSION) || (height !== undefined && !(height >= 1 && height <= MAX_DIMENSION))) return null;
	// Cloudflare's resizer reads JPEG, PNG, GIF, WebP, SVG and HEIC, not AVIF (it answers 415).
	if (!CDN_RESIZABLE.has(file.ext)) return null;
	return `${cdn}/s/${height === undefined ? width : `${width}x${height}`}/${file.id}.${file.ext}`;
}

/** Parse an old Worker-route path (/media/<id>-<w>x<h>.<format>, from earlier releases); null when it isn't one (or the size is out of range). */
export function parseImagePath(pathname: string): ImageRequest | null {
	const m = CLEAN.exec(pathname);
	if (!m) return null;
	const width = Number(m[2] ?? m[4]);
	const height = m[3] ? Number(m[3]) : undefined;
	if (!(width >= 1 && width <= MAX_DIMENSION) || (height !== undefined && !(height >= 1 && height <= MAX_DIMENSION))) return null;
	return { id: m[1], width, height, format: m[5].toLowerCase() };
}

/**
 * Parse a media-host URL (absolute, on the media host in use): the file and
 * the requested size (none for the original). The original under another
 * known base (EmDash's publicUrl, a saved or configured host that isn't the
 * one in use) counts too. Null for anything else.
 */
export function parseCdnUrl(url: string | null | undefined): { id: string; ext: string; width?: number; height?: number } | null {
	const cdn = imageCdn();
	const value = String(url ?? "");
	if (!cdn || !value.startsWith(`${cdn}/`)) {
		const file = cdn ? mediaFile(value) : null;
		return file && !MEDIA_FILE.test(value.trim()) ? { id: file.id, ext: file.ext, width: undefined, height: undefined } : null;
	}
	const path = value.slice(cdn.length).split(/[?#]/)[0];
	const m = /^\/(?:s\/(\d{1,4})(?:x(\d{1,4}))?\/)?([A-Za-z0-9_.-]+)\.([a-z0-9]{2,5})$/i.exec(path);
	if (!m) return null;
	const width = m[1] ? Number(m[1]) : undefined;
	const height = m[2] ? Number(m[2]) : undefined;
	if ((width !== undefined && !(width >= 1 && width <= MAX_DIMENSION)) || (height !== undefined && !(height >= 1 && height <= MAX_DIMENSION))) return null;
	return { id: m[3], ext: m[4].toLowerCase(), width, height };
}

/**
 * Where an old Worker-route URL (/media/<id>-<w>x<h>.<format>) lives on the
 * media host, given the file's bucket key: the same size, format chosen by
 * the host. Null without a media host or for a malformed key.
 */
export function cdnRedirectUrl(request: Pick<ImageRequest, "width" | "height">, key: string): string | null {
	const cdn = imageCdn();
	if (!cdn || !KEY.test(key)) return null;
	return `${cdn}/s/${request.height === undefined ? request.width : `${request.width}x${request.height}`}/${key}`;
}

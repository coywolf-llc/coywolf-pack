/**
 * Clean image URLs: resized copies of media-library images at
 *
 *   /media/<file id>-<width>x<height>.<format>     (cropped to fill)
 *   /media/<file id>-<width>w.<format>              (width only, keeps the ratio)
 *
 * instead of Astro's /_image?href=…&w=…&h=… endpoint. Pure helpers (no
 * imports) so tests can load them; the middleware is in pack.ts.
 *
 * With a media host configured (`images: { cdn: "https://media.example.com" }`:
 * an R2 custom domain on the media bucket, with Cloudflare Image
 * Transformations and the zone's /s/ rewrite rules), URLs point there instead
 * and never touch the Worker:
 *
 *   https://media.example.com/<file>              the original file
 *   https://media.example.com/s/<w>x<h>/<file>    cropped to fill
 *   https://media.example.com/s/<w>/<file>        width only, keeps the ratio
 *
 * The media host picks WebP or AVIF for browsers that accept them.
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
/**
 * Worker-route sizes are multiples of this many pixels, so anyone requesting
 * /media/ URLs can't make the Worker run (and bill) a new transform for every
 * pixel. 10 keeps the sizes themes ask for (50, 100, 400, 640, 800, 1200x630)
 * exact; anything else rounds up.
 */
export const SIZE_STEP = 10;

/** Round a size up to the Worker route's grid (at most MAX_DIMENSION). */
export function snapDimension(n: number): number {
	return Math.min(MAX_DIMENSION, Math.ceil(n / SIZE_STEP) * SIZE_STEP);
}
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

/** The media host set in astro.config.mjs (`images.cdn`), and the one saved on the Clean Image URLs page (wins when set). */
let optionBase: string | null = null;
let savedBase: string | null = null;

/** Set (or clear) the media host from the plugin option. Anything but an https origin is ignored. */
export function setImageCdn(url: string | null | undefined): void {
	optionBase = normalizeMediaHost(url);
}

/** Set (or clear) the media host saved in the admin. It overrides the plugin option while set. */
export function setSavedImageCdn(url: string | null | undefined): void {
	savedBase = normalizeMediaHost(url);
}

/** The media host in use (https origin, no trailing slash), or null for the Worker's /media/ route. */
export function imageCdn(): string | null {
	return savedBase ?? optionBase;
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

/** Where the media host comes from: the admin setting, the plugin option, or nowhere. */
export function imageCdnSource(): { host: string | null; option: string | null; saved: string | null } {
	return { host: imageCdn(), option: optionBase, saved: savedBase };
}

export interface ImageRequest {
	id: string;
	width: number;
	height?: number;
	format: string;
}

/** The file id and extension of a media-library URL, or null for anything else. */
export function mediaFile(src: string | null | undefined): { id: string; ext: string } | null {
	const m = MEDIA_FILE.exec(String(src ?? "").trim());
	return m ? { id: m[1], ext: m[2].toLowerCase() } : null;
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
 * Build a clean URL; null when `src` isn't a media-library file or the size is
 * out of range. On the media host when one is set (format chosen by the host),
 * otherwise the Worker's /media/ route.
 */
export function cleanImagePath(src: string | null | undefined, options: { width: number; height?: number; format?: string }): string | null {
	const file = mediaFile(src);
	if (!file) return null;
	const width = Math.round(options.width);
	const height = options.height === undefined ? undefined : Math.round(options.height);
	if (!(width >= 1 && width <= MAX_DIMENSION) || (height !== undefined && !(height >= 1 && height <= MAX_DIMENSION))) return null;
	const cdn = imageCdn();
	if (cdn) {
		// Cloudflare's resizer reads JPEG, PNG, GIF, WebP, SVG and HEIC, not AVIF (it answers 415).
		if (!CDN_RESIZABLE.has(file.ext)) return null;
		return `${cdn}/s/${height === undefined ? width : `${width}x${height}`}/${file.id}.${file.ext}`;
	}
	const format = (options.format ?? "webp").toLowerCase();
	if (!FORMATS[format]) return null;
	return imagePath({ id: file.id, width: snapDimension(width), height: height === undefined ? undefined : snapDimension(height), format });
}

/** The Worker-route path of a request, as given (no snapping). */
function imagePath(request: ImageRequest): string {
	return `${IMAGE_PATH}${request.id}-${request.height === undefined ? `${request.width}w` : `${request.width}x${request.height}`}.${request.format}`;
}

/**
 * The on-grid path for a Worker-route request whose size is off the grid
 * (see SIZE_STEP), or null when it's already on it. The middleware answers
 * off-grid requests with a redirect there instead of resizing.
 */
export function snappedImagePath(request: ImageRequest): string | null {
	const width = snapDimension(request.width);
	const height = request.height === undefined ? undefined : snapDimension(request.height);
	if (width === request.width && height === request.height) return null;
	return imagePath({ ...request, width, height });
}

/** Parse a clean URL path; null when it isn't one (or the size is out of range). */
export function parseImagePath(pathname: string): ImageRequest | null {
	const m = CLEAN.exec(pathname);
	if (!m) return null;
	const width = Number(m[2] ?? m[4]);
	const height = m[3] ? Number(m[3]) : undefined;
	if (!(width >= 1 && width <= MAX_DIMENSION) || (height !== undefined && !(height >= 1 && height <= MAX_DIMENSION))) return null;
	return { id: m[1], width, height, format: m[5].toLowerCase() };
}

/**
 * Parse a media-host URL (absolute, on the configured host): the file and the
 * requested size (none for the original). Null for anything else.
 */
export function parseCdnUrl(url: string | null | undefined): { id: string; ext: string; width?: number; height?: number } | null {
	const cdn = imageCdn();
	const value = String(url ?? "");
	if (!cdn || !value.startsWith(`${cdn}/`)) return null;
	const path = value.slice(cdn.length).split(/[?#]/)[0];
	const m = /^\/(?:s\/(\d{1,4})(?:x(\d{1,4}))?\/)?([A-Za-z0-9_.-]+)\.([a-z0-9]{2,5})$/i.exec(path);
	if (!m) return null;
	const width = m[1] ? Number(m[1]) : undefined;
	const height = m[2] ? Number(m[2]) : undefined;
	if ((width !== undefined && !(width >= 1 && width <= MAX_DIMENSION)) || (height !== undefined && !(height >= 1 && height <= MAX_DIMENSION))) return null;
	return { id: m[3], ext: m[4].toLowerCase(), width, height };
}

/** A media-library file's bucket key as stored by EmDash (<id>.<ext>). */
const KEY = /^[A-Za-z0-9_.-]+\.[a-z0-9]{2,5}$/i;

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

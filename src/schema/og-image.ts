/**
 * The page's og:image with Clean image URLs on: the default OG image at a
 * clean 1200x630 URL, the page's own media-library image as the original
 * file on the media host, and the Open Graph tags for it. Pure (no I/O), so
 * tests can load it; the media lookups are in module.ts.
 */
import type { PageMetadataContribution } from "emdash";

import { cdnOriginalUrl, cleanImagePath, imageCdn, mediaFile, mimeForExt, parseCdnUrl } from "../images/lib.js";
import type { ImageInfo } from "./graph.js";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/**
 * The site's default OG image as a clean 1200x630 URL on the media host,
 * /s/1200x630/<file> (the host serves the original format to crawlers that
 * don't ask for WebP or AVIF, so the type is the original's). The image can
 * come as EmDash's /_emdash/api/media/file/<file> or, with EmDash's
 * publicUrl, as <publicUrl>/<file>. Null without a media host or when it
 * isn't a (raster) media-library image: EmDash's own og:image stays then.
 */
export function cleanDefaultOgImage(defaultOg: ImageInfo | null | undefined, _origin: string): ImageInfo | null {
	if (!defaultOg || !imageCdn()) return null;
	const file = mediaFile(defaultOg.url);
	if (!file || file.ext.toLowerCase() === "svg") return null;
	const url = cleanImagePath(defaultOg.url, { width: OG_WIDTH, height: OG_HEIGHT });
	return url ? { url, width: OG_WIDTH, height: OG_HEIGHT, alt: defaultOg.alt, mimeType: mimeForExt(file.ext) } : null;
}

/** The page's own image (a media-library file) as its original on the media host; null without a host or for anything else. */
export function ownImageOnMediaHost(own: string | null | undefined): string | null {
	return mediaFile(own) ? cdnOriginalUrl(own) : null;
}

/** A media item's row from the media table. */
export interface MediaRow {
	width: number | null;
	height: number | null;
	alt: string | null;
	mime_type?: string | null;
}

/**
 * Image facts for a media-host URL: the requested size (width-only keeps the
 * original ratio; the original keeps its own size) and the original file's
 * type. Null when the URL isn't on the media host.
 */
export function mediaHostImageInfo(url: string, row: MediaRow): ImageInfo | null {
	const parsed = parseCdnUrl(url);
	if (!parsed) return null;
	let width: number | null = row.width;
	let height: number | null = row.height;
	if (parsed.width !== undefined) {
		width = parsed.width;
		height = parsed.height ?? (row.width && row.height ? Math.round((parsed.width * row.height) / row.width) : null);
	}
	return { url, width, height, alt: row.alt, mimeType: mimeForExt(parsed.ext) ?? row.mime_type ?? undefined };
}

/**
 * Whether the pack outputs og:image/twitter:image itself (so they win over
 * EmDash's, first contribution wins): for media-host URLs. EmDash's own tags
 * stay for everything else, so there's never a second og:image. (The other
 * arguments are kept for callers; the default image's Worker-route URL, which
 * the pack also owned, is gone with that route.)
 */
export function packOwnsOgImage(url: string, _origin: string, _hasOwnImage: boolean): boolean {
	return parseCdnUrl(url) !== null;
}

/** og:image (when the pack owns it), its size, type and alt, and twitter:image(:alt). */
export function ogImageTags(image: ImageInfo | null, ownsUrl: boolean): PageMetadataContribution[] {
	const out: PageMetadataContribution[] = [];
	if (!image) return out;
	if (ownsUrl) {
		out.push({ kind: "property", property: "og:image", content: image.url });
		out.push({ kind: "meta", name: "twitter:image", content: image.url });
	}
	if (image.width && image.height) {
		out.push({ kind: "property", property: "og:image:width", content: String(image.width) });
		out.push({ kind: "property", property: "og:image:height", content: String(image.height) });
	}
	if (image.mimeType?.startsWith("image/")) out.push({ kind: "property", property: "og:image:type", content: image.mimeType });
	if (image.alt?.trim()) {
		out.push({ kind: "property", property: "og:image:alt", content: image.alt.trim() });
		out.push({ kind: "meta", name: "twitter:image:alt", content: image.alt.trim() });
	}
	return out;
}

/**
 * Pure R2 helpers: multipart part sizing and minimal XML reading. No imports, so
 * `node --test` can load this file.
 */

/**
 * Every part goes through the site (files/upload-part; EmDash's admin CSP blocks the
 * browser from reaching R2), so parts must fit a plugin route body (8 MiB). 6 MiB is
 * above R2's 5 MiB minimum and leaves headroom.
 */
export const PART_SIZE = 6 * 1024 * 1024;
const MAX_PARTS = 10_000;
/** The largest file that fits in 10,000 parts of PART_SIZE (just under 60 GB). */
export const MAX_THROUGH_SITE = PART_SIZE * MAX_PARTS;

/** Equal-sized parts (R2 requires every part but the last to be the same size). */
export function partSizeFor(_size: number): number {
	return PART_SIZE;
}

export function xmlValue(xml: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match ? decodeXml(match[1]) : undefined;
}

export function xmlValues(xml: string, tag: string): string[] {
	return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => decodeXml(m[1]));
}

function decodeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

export function encodeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

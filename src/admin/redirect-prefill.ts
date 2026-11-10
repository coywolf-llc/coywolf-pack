/**
 * "Create redirect" links into the Redirect Manager: the Insights page's 404
 * list links to /plugins/coywolf-pack/redirects?source=<path>, and the
 * Redirect Manager opens its New redirect dialog with that source filled in.
 *
 * Kept free of JSX so tests can load it directly.
 */
import { adminHref, packPagePath } from "./router.js";

export const PREFILL_PARAM = "source";

/** The Redirect Manager's URL with `source` ready to fill in. */
export function redirectPrefillHref(source: string): string {
	return `${adminHref(packPagePath("/redirects"))}?${new URLSearchParams({ [PREFILL_PARAM]: source })}`;
}

/** The source path a link asked for (a site path, at most 2,000 characters), or null. */
export function readRedirectPrefill(search: string): string | null {
	const raw = new URLSearchParams(search).get(PREFILL_PARAM);
	if (!raw) return null;
	// TanStack Router writes a search value that looks like JSON as a JSON string.
	let value = raw;
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			value = JSON.parse(value) as string;
		} catch {
			return null;
		}
	}
	return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 2000 && !/[\s\u0000-\u001f]/.test(value) ? value : null;
}

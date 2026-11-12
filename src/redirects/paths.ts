/**
 * Redirect paths as the Redirect Manager stores and compares them. No imports, so the pure cores
 * (slug-core.ts, removed-core.ts) and Node tests can load it.
 */

/** Exact sources match with or without a trailing slash, so store them without one. */
export function normalizePath(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The key an exact source is stored and looked up by: normalized the way Astro normalizes a request's pathname
 * (decode, then re-encode through the URL parser, as EmDash 1.5's own redirects do: normalizeSourcePath in
 * emdash/src/redirects/patterns.ts), so a source typed with raw Unicode (`/café`) and the request's
 * percent-encoded path (`/caf%C3%A9`) compare equal. Without a trailing slash, as normalizePath.
 */
export function sourceKey(path: string): string {
	if (path.includes("?") || path.includes("#")) return normalizePath(path);
	try {
		const url = new URL("http://placeholder.invalid");
		url.pathname = decodeURI(path);
		return normalizePath(url.pathname);
	} catch {
		return normalizePath(path);
	}
}

/**
 * The forms an exact rule may be stored under for a request path: its key (how 0.38.0 and later save it), and the
 * key decoded (raw Unicode as typed, saved before 0.38.0 and not yet rewritten). One or two values, the key first.
 */
export function storedForms(pathname: string): string[] {
	const key = sourceKey(pathname);
	let decoded = key;
	try {
		decoded = decodeURI(key);
	} catch {
		// A malformed escape: the key is the only form.
	}
	return decoded === key ? [key] : [key, decoded];
}

/**
 * A redirect's Location with no non-ASCII characters (a header value must be ASCII), as EmDash 1.5 does. An absolute
 * URL goes through the URL parser, so an internationalized host becomes punycode (`https://xn--bcher-kva.de/`) and its
 * path and query are percent-encoded; a site path is percent-encoded as it is.
 */
export function encodeLocation(location: string): string {
	if (!/[^\p{ASCII}]/u.test(location)) return location;
	if (/^https?:\/\//i.test(location)) {
		try {
			return new URL(location).href;
		} catch {
			// Not a parseable URL: encode it as text below.
		}
	}
	return location.replace(/[^\p{ASCII}]+/gu, (part) => {
		try {
			return encodeURIComponent(part);
		} catch {
			return "";
		}
	});
}

/** Whether a path has a "." or ".." segment, which the URL parser would resolve away (an exact source can't have one). */
export function hasDotSegment(path: string): boolean {
	let p = path.split(/[?#]/)[0].replaceAll("\\", "/");
	// Percent-encoded dots (%2e) are dot segments too: the URL parser resolves them the same way.
	p = p.replace(/%2e/gi, ".");
	return /(^|\/)\.{1,2}(\/|$)/.test(p);
}

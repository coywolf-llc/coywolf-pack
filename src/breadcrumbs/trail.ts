/**
 * Breadcrumb trails. The theme's trail (PublicPageContext.breadcrumbs) wins
 * when it has one; otherwise the trail is derived from the URL path, with
 * the page title for the last crumb and humanized path segments for the
 * ancestors.
 */
import { requestStore } from "../core/request-memo.js";

export interface Crumb {
	name: string;
	url: string;
}

export interface TrailOptions {
	/** Current URL path, e.g. "/guides/setup/". */
	path: string;
	/** The theme's trail, root first. `[]` means "no breadcrumbs on this page". */
	items?: readonly Crumb[] | null;
	/** Title of the current page (last crumb when deriving). */
	title?: string | null;
	homeLabel: string;
	showHome: boolean;
	showCurrent: boolean;
}

/** "getting-started_now" → "Getting started now". */
export function humanize(segment: string): string {
	let decoded = segment;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		// Keep the raw segment.
	}
	const words = decoded.replace(/\.[a-z0-9]+$/i, "").replace(/[-_+]+/g, " ").trim();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : segment;
}

const normalizePath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path) || "/";

/** Root-relative path of a crumb URL (absolute URLs are reduced to their path). */
function crumbPath(url: string): string {
	try {
		return normalizePath(new URL(url, "https://x.invalid").pathname);
	} catch {
		return url;
	}
}

/** The trail to render: home first, current page last (unless hidden). Empty when there's nothing useful to show. */
export function resolveTrail(options: TrailOptions): Crumb[] {
	const current = normalizePath(options.path.split(/[?#]/)[0] || "/");
	let trail: Crumb[];

	if (options.items) {
		trail = options.items.filter((c) => c && typeof c.name === "string" && c.name.trim() && typeof c.url === "string").map((c) => ({ name: c.name.trim(), url: c.url }));
		if (!options.showHome && trail.length && crumbPath(trail[0].url) === "/") trail = trail.slice(1);
		else if (options.showHome && trail.length && crumbPath(trail[0].url) !== "/") trail.unshift({ name: options.homeLabel, url: "/" });
	} else {
		if (current === "/") return [];
		const trailingSlash = options.path.split(/[?#]/)[0].endsWith("/");
		const segments = current.split("/").filter(Boolean);
		trail = options.showHome ? [{ name: options.homeLabel, url: "/" }] : [];
		segments.forEach((segment, i) => {
			const url = `/${segments.slice(0, i + 1).join("/")}${trailingSlash ? "/" : ""}`;
			const last = i === segments.length - 1;
			trail.push({ name: last && options.title?.trim() ? options.title.trim() : humanize(segment), url });
		});
	}

	if (!options.showCurrent && trail.length && crumbPath(trail[trail.length - 1].url) === current) trail = trail.slice(0, -1);
	// A lone crumb (just Home, or just the page) isn't a useful trail.
	return trail.length >= 2 ? trail : [];
}

/** Escape a separator for a CSS string (`content: "…"`). */
export function cssString(value: string): string {
	return `"${value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\u0000-\u001f<>]/g, "")}"`;
}

// ── Theme trails captured from page:metadata ─────────────────────
//
// EmDashHead runs the page:metadata hook (with the theme's
// PublicPageContext) before the body renders. The hook records the page's
// breadcrumbs and title here so a Breadcrumbs block in the body can use the
// theme's trail without the theme wiring anything. This relies on the theme
// rendering <EmDashHead page={page}> with an accurate `url`; without it the
// block derives the trail from the URL path. Kept per request (EmDash's
// request context, src/core/request-memo.ts): an isolate renders many pages
// at once, and keyed only by URL, an editor's edit-mode render of a page
// (its draft title) could land in a public render of the same URL that was
// on its way to the edge cache. Within the request it's keyed by the page URL
// (path plus query, so locales and variants don't mix). Outside a request
// (tests, scripts) a short-lived map shared by the isolate stands in.

interface Captured {
	items?: Crumb[];
	title: string | null;
	at: number;
}

const CAPTURE_TTL_MS = 60_000;
const CAPTURE_MAX = 200;
/** Outside a request only. */
const captured = new Map<string, Captured>();
const perRequest = new WeakMap<object, Map<string, Captured>>();

/** This request's captures (the isolate-wide map outside a request). */
function captures(create: boolean): Map<string, Captured> | undefined {
	const request = requestStore();
	if (!request) return captured;
	let map = perRequest.get(request);
	if (!map && create) {
		map = new Map();
		perRequest.set(request, map);
	}
	return map;
}

/** Cache key for a page URL: normalized path plus query string, ignoring origin and fragment. */
export function captureKey(url: string): string {
	try {
		const parsed = new URL(url, "https://x.invalid");
		return `${normalizePath(parsed.pathname)}${parsed.search}`;
	} catch {
		return url;
	}
}

export function capturePage(page: { path?: string; url?: string; locale?: string | null; breadcrumbs?: Crumb[]; pageTitle?: string | null; title?: string | null }): void {
	const source = page.url ?? page.path;
	if (!source) return;
	const key = captureKey(source);
	const map = captures(true) as Map<string, Captured>;
	map.delete(key);
	map.set(key, { items: page.breadcrumbs, title: page.pageTitle ?? page.title ?? null, at: Date.now() });
	while (map.size > CAPTURE_MAX) map.delete(map.keys().next().value as string);
}

/** The trail captured for this request URL, if EmDashHead published one in this request (in the last minute). */
export function capturedPage(url: string): Omit<Captured, "at"> | null {
	const entry = captures(false)?.get(captureKey(url));
	if (!entry || Date.now() - entry.at > CAPTURE_TTL_MS) return null;
	return entry;
}

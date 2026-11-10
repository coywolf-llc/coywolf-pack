/**
 * RSS feed (pure part): feed URLs and the RSS 2.0 document. No imports, so
 * `node --test` can load it.
 *
 * - `/feed/` lists the newest entries of the chosen collections, at
 *   WordPress's feed URL.
 * - `<term archive>/feed/` lists one term's entries (and its child terms'),
 *   WordPress's category feeds. Only for a collection whose URL override is
 *   `<prefix>/{term:<taxonomy>|…}/{slug}/` or `{termpath:…}` (e.g.
 *   `/{termpath:category|uncategorized}/{slug}/` → `/news/seo/feed/`), since
 *   the term's archive is then the entry URL without the slug.
 */

export const FEED_PATH = "/feed/";
/** Edge cache tag on every feed, cleared when the feed settings are saved. */
export const FEED_TAG = "coywolf:feed";
/** How long the edge keeps a feed when nothing clears it sooner (changes that clear no tag, such as a byline edit). */
export const FEED_EDGE_MAX_AGE = 3600;
/** Items per feed: the default, and the most allowed. */
export const FEED_DEFAULT_ITEMS = 20;
export const FEED_MAX_ITEMS = 100;
/** Deepest term path followed in a feed URL. */
const MAX_SEGMENTS = 8;
/** A term slug: letters (any script), digits, "-" and "_", not starting with "_" or "-" (so never /_emdash/…). */
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*$/u;

/**
 * The term path a feed URL asks for: [] for the site feed (`/feed/`), the
 * segments before `/feed/` otherwise, null when the path isn't a feed URL.
 * `/feed` without the slash isn't one: the site redirects it to `/feed/`, as
 * it does for its other pages.
 */
export function parseFeedPath(pathname: string): string[] | null {
	const match = /^((?:\/[^/]+)*)\/feed\/$/.exec(pathname);
	if (!match) return null;
	const segments = match[1].split("/").filter(Boolean);
	if (segments.length > MAX_SEGMENTS) return null;
	let decoded: string[];
	try {
		decoded = segments.map((s) => decodeURIComponent(s));
	} catch {
		return null;
	}
	return decoded.every((s) => SEGMENT.test(s)) ? decoded : null;
}

export interface TermFeedRoute {
	taxonomy: string;
	/** {termpath:…}: the URL has the term's ancestors in front. */
	hierarchical: boolean;
	/** Static path segments before the term ("" or e.g. "/blog"). */
	prefix: string;
}

/**
 * Where a collection's term feeds live, from its URL override (after
 * expandPattern, so `{category}` is already `{term:category|uncategorized}`).
 * Null when the pattern isn't "static prefix, term, slug".
 */
export function termFeedRoute(pattern: string | null): TermFeedRoute | null {
	if (!pattern) return null;
	const match = /^((?:\/[A-Za-z0-9_-]+)*)\/\{(term|termpath):([A-Za-z0-9_-]+)(?:\|[^{}/]*)?\}\/\{slug\}\/?$/.exec(pattern);
	return match ? { prefix: match[1], hierarchical: match[2] === "termpath", taxonomy: match[3] } : null;
}

/** The term path in a feed URL's segments, once the route's prefix is removed (null: not under the prefix). */
export function termSegments(segments: string[], route: TermFeedRoute): string[] | null {
	const prefix = route.prefix.split("/").filter(Boolean);
	if (segments.length <= prefix.length || prefix.some((p, i) => p !== segments[i])) return null;
	const rest = segments.slice(prefix.length);
	return route.hierarchical || rest.length === 1 ? rest : null;
}

/** A term and all its descendants, from child → parent slugs. */
export function withDescendants(slug: string, parents: ReadonlyMap<string, string>): string[] {
	const children = new Map<string, string[]>();
	for (const [child, parent] of parents) children.set(parent, [...(children.get(parent) ?? []), child]);
	const out = [slug];
	for (let i = 0; i < out.length && out.length < 5000; i++) {
		for (const child of children.get(out[i]) ?? []) if (!out.includes(child)) out.push(child);
	}
	return out;
}

export interface FeedItem {
	title: string;
	url: string;
	/** ISO 8601, or SQLite's "YYYY-MM-DD HH:MM:SS" in UTC. */
	publishedAt: string;
	creator?: string | null;
	category?: string | null;
	description?: string | null;
}

export interface FeedChannel {
	title: string;
	/** The page the feed is for (the home page, or the term's archive). */
	link: string;
	/** The feed's own URL (atom:link rel="self"). */
	selfUrl: string;
	description: string;
	language: string;
	/** Newest change among the items (ISO); now when there are none. */
	lastBuildDate?: string | null;
	image?: { url: string; title: string; link: string } | null;
	items: FeedItem[];
}

const TZ_SUFFIX = /([zZ]|[+-]\d{2}(:?\d{2})?)$/;

/** Parse a stored timestamp, treating offset-less values as UTC (as EmDash does). */
export function feedDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	let normalized = value.trim();
	if (normalized.includes(" ") && !normalized.includes("T")) normalized = normalized.replace(" ", "T");
	if (!TZ_SUFFIX.test(normalized)) normalized += "Z";
	const time = Date.parse(normalized);
	return Number.isNaN(time) ? null : new Date(time);
}

export function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
		// Characters XML 1.0 forbids outright.
		// Control characters in the pattern: stripping them is the point.
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}

/** RSS's <language>: the site locale as a language tag ("en-US"), "en" when unset or malformed. */
export function feedLanguage(locale: string | null | undefined): string {
	const value = (locale ?? "").trim().replace(/_/g, "-");
	return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value) ? value : "en";
}

/** RSS 2.0 with atom:link rel="self" and dc:creator (as WordPress's feeds have). */
export function buildRss(channel: FeedChannel, now: Date = new Date()): string {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
		"\t<channel>",
		`\t\t<title>${escapeXml(channel.title)}</title>`,
		`\t\t<atom:link href="${escapeXml(channel.selfUrl)}" rel="self" type="application/rss+xml" />`,
		`\t\t<link>${escapeXml(channel.link)}</link>`,
		`\t\t<description>${escapeXml(channel.description)}</description>`,
		`\t\t<lastBuildDate>${(feedDate(channel.lastBuildDate) ?? now).toUTCString()}</lastBuildDate>`,
		`\t\t<language>${escapeXml(feedLanguage(channel.language))}</language>`,
	];
	if (channel.image) {
		lines.push(
			"\t\t<image>",
			`\t\t\t<url>${escapeXml(channel.image.url)}</url>`,
			`\t\t\t<title>${escapeXml(channel.image.title)}</title>`,
			`\t\t\t<link>${escapeXml(channel.image.link)}</link>`,
			"\t\t</image>",
		);
	}
	for (const item of channel.items) {
		const published = feedDate(item.publishedAt);
		if (!published) continue;
		lines.push("\t\t<item>", `\t\t\t<title>${escapeXml(item.title)}</title>`, `\t\t\t<link>${escapeXml(item.url)}</link>`);
		if (item.creator) lines.push(`\t\t\t<dc:creator>${escapeXml(item.creator)}</dc:creator>`);
		lines.push(`\t\t\t<pubDate>${published.toUTCString()}</pubDate>`);
		if (item.category) lines.push(`\t\t\t<category>${escapeXml(item.category)}</category>`);
		lines.push(`\t\t\t<guid isPermaLink="true">${escapeXml(item.url)}</guid>`, `\t\t\t<description>${escapeXml(item.description ?? "")}</description>`, "\t\t</item>");
	}
	lines.push("\t</channel>", "</rss>", "");
	return lines.join("\n");
}

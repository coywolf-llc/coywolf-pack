/**
 * Google News sitemap (pure part): the 48-hour selection and the XML.
 * Mirrors Coywolf SEO's news sitemap: articles published in the last
 * 48 hours (the window Google News considers), newest first, at most 1,000
 * (Google's per-sitemap limit), each with publication name and language,
 * publication date, and title.
 */

export const NEWS_WINDOW_MS = 48 * 60 * 60 * 1000;
export const NEWS_LIMIT = 1000;

export interface NewsArticle {
	url: string;
	title: string;
	/** Publish date (ISO 8601, or SQLite's "YYYY-MM-DD HH:MM:SS" in UTC). */
	publishedAt: string;
}

export interface NewsPublication {
	name: string;
	language: string;
}

const TZ_SUFFIX = /([zZ]|[+-]\d{2}(:?\d{2})?)$/;

/** Parse a stored timestamp, treating offset-less values as UTC (as EmDash does). */
export function parseDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	let normalized = value.trim();
	if (normalized.includes(" ") && !normalized.includes("T")) normalized = normalized.replace(" ", "T");
	if (!TZ_SUFFIX.test(normalized)) normalized += "Z";
	const time = Date.parse(normalized);
	return Number.isNaN(time) ? null : new Date(time);
}

/** Articles inside the 48-hour window (not in the future), newest first, capped. */
export function selectNewsArticles(articles: NewsArticle[], now: number = Date.now(), limit = NEWS_LIMIT): NewsArticle[] {
	return articles
		.map((article) => ({ article, time: parseDate(article.publishedAt)?.getTime() ?? Number.NaN }))
		.filter(({ time }) => !Number.isNaN(time) && time > now - NEWS_WINDOW_MS && time <= now)
		.sort((a, b) => b.time - a.time)
		.slice(0, limit)
		.map(({ article }) => article);
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
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
}

/**
 * The language code Google News expects: ISO 639-1/2 ("en", "fr"), except
 * Chinese, which must be "zh-cn" or "zh-tw".
 */
export function newsLanguage(locale: string | null | undefined): string {
	const value = (locale ?? "").trim().toLowerCase().replace(/_/g, "-");
	if (!value) return "en";
	if (value.startsWith("zh")) return /-(tw|hk|mo|hant)/.test(value) ? "zh-tw" : "zh-cn";
	const base = value.split("-")[0];
	return /^[a-z]{2,3}$/.test(base) ? base : "en";
}

/** W3C datetime for <news:publication_date>. */
function w3c(value: string): string {
	return parseDate(value)?.toISOString().replace(/\.\d{3}Z$/, "Z") ?? value;
}

export function buildNewsSitemap(articles: NewsArticle[], publication: NewsPublication): string {
	const name = escapeXml(publication.name);
	const language = escapeXml(newsLanguage(publication.language));
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
	];
	for (const article of articles) {
		lines.push(
			"\t<url>",
			`\t\t<loc>${escapeXml(article.url)}</loc>`,
			"\t\t<news:news>",
			"\t\t\t<news:publication>",
			`\t\t\t\t<news:name>${name}</news:name>`,
			`\t\t\t\t<news:language>${language}</news:language>`,
			"\t\t\t</news:publication>",
			`\t\t\t<news:publication_date>${escapeXml(w3c(article.publishedAt))}</news:publication_date>`,
			`\t\t\t<news:title>${escapeXml(article.title)}</news:title>`,
			"\t\t</news:news>",
			"\t</url>",
		);
	}
	lines.push("</urlset>", "");
	return lines.join("\n");
}

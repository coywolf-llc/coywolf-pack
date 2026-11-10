/**
 * Edge errors and crawlers (pure part): the GraphQL queries over the site's
 * zone, and what the answers become.
 *
 * Data comes from httpRequestsAdaptiveGroups, Cloudflare's sampled HTTP
 * request analytics, which every plan keeps for at least 31 days and can
 * query 30 days at a time (changelog 2026-10-02). Plans differ in the fields
 * they can query, so the report asks the zone's `settings` node first and
 * uses only the base fields documented for all plans (edgeResponseStatus
 * ranges, clientRequestHTTPHost, clientRequestPath, userAgent, requestSource),
 * adding Cloudflare's verifiedBotCategory only when the zone lists it.
 *
 * Unlike EmDash's own 404 log, this sees every request Cloudflare answered for
 * the zone: paths with a file extension (images, PDFs, old /wp-content/
 * uploads) and the media host, which R2 serves without the Worker.
 *
 * No imports, so `node --test` can load this file.
 */

export const EDGE_DATASET = "httpRequestsAdaptiveGroups";
const DAY_S = 86_400;
/** The longest window a Free zone can query in one request. */
export const EDGE_MAX_DAYS = 30;

export interface DatasetLimits {
	enabled: boolean;
	/** Widest time range one query may ask for, in seconds (null: not said). */
	maxDurationS: number | null;
	/** How far back a query may read, in seconds (null: not said). */
	notOlderThanS: number | null;
	/** Fields the requester may use, as Cloudflare names them ("dimensions_userAgent", "sum_requests"…); null when not listed. */
	fields: string[] | null;
}

/** The zone's settings for one dataset, read before the report. */
export const settingsQuery = (dataset: string, scope: "zones" | "accounts" = "zones") =>
	`query PackInsightsSettings($tag: String!) { viewer { ${scope}(filter: { ${scope === "zones" ? "zoneTag" : "accountTag"}: $tag }) { settings { ${dataset} { enabled maxDuration notOlderThan availableFields } } } } }`;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);

/** The settings node's answer for `dataset`, or null when it isn't there. */
export function parseDatasetSettings(body: unknown, dataset: string, scope: "zones" | "accounts" = "zones"): DatasetLimits | null {
	// any: GraphQL answer.
	const node = (body as any)?.data?.viewer?.[scope]?.[0]?.settings?.[dataset];
	if (!node || typeof node !== "object") return null;
	const fields = Array.isArray(node.availableFields) ? node.availableFields.filter((f: unknown): f is string => typeof f === "string") : null;
	return { enabled: node.enabled !== false, maxDurationS: num(node.maxDuration), notOlderThanS: num(node.notOlderThan), fields };
}

/** Whether a field can be queried: listed as itself or under its path ("dimensions_verifiedBotCategory"). Unknown lists say no. */
export function fieldAvailable(limits: DatasetLimits | null, name: string): boolean {
	if (!limits?.fields) return false;
	const lower = name.toLowerCase();
	return limits.fields.some((f) => {
		const l = f.toLowerCase();
		return l === lower || l.endsWith(`_${lower}`) || l.endsWith(`.${lower}`);
	});
}

/** The window to read: up to `maxDays`, within what the zone allows, ending now. */
export function reportWindow(limits: DatasetLimits | null, now: number, maxDays = EDGE_MAX_DAYS): { start: string; end: string; days: number } {
	let seconds = maxDays * DAY_S;
	for (const limit of [limits?.maxDurationS, limits?.notOlderThanS]) if (limit && limit > 0) seconds = Math.min(seconds, limit);
	// A minute's room, so a query sent at the edge of the retention isn't refused.
	seconds = Math.max(3_600, seconds - 60);
	const days = Math.max(1, Math.round(seconds / DAY_S));
	return { start: new Date(now - seconds * 1000).toISOString(), end: new Date(now).toISOString(), days };
}

/** A host name as it can appear in a filter literal (letters, digits, dots and hyphens; punycode included). */
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * The report: requests per host, error statuses, 404/410 and 5xx paths, and user agents. One request, six nodes.
 * Eyeball requests only (visitors and crawlers, not Workers' own subrequests), in the window, and with `hosts`
 * only the site's and media host's (clientRequestHTTPHost_in: Cloudflare's `in` operator, which every scalar
 * field takes), so a busier host in the same zone can't crowd them out of each node's top rows.
 */
export function edgeQuery(options: { verifiedBotCategory: boolean; hosts?: string[]; agentLimit?: number }): string {
	const hosts = (options.hosts ?? []).map((h) => h.toLowerCase()).filter((h) => HOST.test(h));
	const BASE = `datetime_geq: $start, datetime_leq: $end, requestSource: "eyeball"${hosts.length ? `, clientRequestHTTPHost_in: ${JSON.stringify(hosts)}` : ""}`;
	const agentDims = `clientRequestHTTPHost userAgent${options.verifiedBotCategory ? " verifiedBotCategory" : ""}`;
	return `query PackInsightsEdge($zone: String!, $start: Time!, $end: Time!) {
	viewer { zones(filter: { zoneTag: $zone }) {
		hosts: ${EDGE_DATASET}(limit: 100, filter: { ${BASE} }, orderBy: [count_DESC]) { count dimensions { clientRequestHTTPHost } }
		statuses: ${EDGE_DATASET}(limit: 200, filter: { ${BASE}, edgeResponseStatus_geq: 400 }, orderBy: [count_DESC]) { count dimensions { clientRequestHTTPHost edgeResponseStatus } }
		notFound: ${EDGE_DATASET}(limit: 200, filter: { ${BASE}, edgeResponseStatus_geq: 404, edgeResponseStatus_lt: 405 }, orderBy: [count_DESC]) { count dimensions { clientRequestHTTPHost clientRequestPath } }
		gone: ${EDGE_DATASET}(limit: 50, filter: { ${BASE}, edgeResponseStatus_geq: 410, edgeResponseStatus_lt: 411 }, orderBy: [count_DESC]) { count dimensions { clientRequestHTTPHost clientRequestPath } }
		serverErrors: ${EDGE_DATASET}(limit: 50, filter: { ${BASE}, edgeResponseStatus_geq: 500, edgeResponseStatus_lt: 600 }, orderBy: [count_DESC]) { count dimensions { clientRequestHTTPHost clientRequestPath edgeResponseStatus } }
		agents: ${EDGE_DATASET}(limit: ${options.agentLimit ?? 1000}, filter: { ${BASE} }, orderBy: [count_DESC]) { count dimensions { ${agentDims} } }
	} }
}`;
}

// ── Crawlers ─────────────────────────────────────────────────────

export interface CrawlerPattern {
	name: string;
	/** Cloudflare Radar's category (AI_CRAWLER, SEARCH_ENGINE_CRAWLER…). */
	category: string;
	/** Lower-case strings, any of which in a user agent names this crawler. */
	needles: string[];
	/** The crawler's own robots.txt token (lower case), when it's one of the needles. */
	token?: string;
}

/** Aliases too common to name one crawler (browsers' own tokens, generic HTTP clients). */
const GENERIC = new Set(["mozilla", "chrome", "safari", "headlesschrome", "applewebkit", "gecko", "khtml", "compatible", "mobile", "android", "linux", "windows", "macintosh"]);

/** Match patterns from the Robots.txt module's crawler directory (src/robots/data/bots.json): each crawler's token and specific aliases. */
export function crawlerPatterns(bots: Array<{ name: string; category?: string; token?: string | null; aliases?: string[]; delisted?: boolean }>): CrawlerPattern[] {
	const out: CrawlerPattern[] = [];
	for (const bot of bots) {
		if (bot.delisted) continue;
		const needles = [bot.token, ...(bot.aliases ?? [])]
			.filter((n): n is string => typeof n === "string")
			.map((n) => n.trim().toLowerCase())
			.filter((n) => n.length >= 4 && !GENERIC.has(n));
		const token = bot.token?.trim().toLowerCase();
		if (needles.length) out.push({ name: bot.name, category: bot.category ?? "OTHER", needles: [...new Set(needles)], ...(token && needles.includes(token) ? { token } : {}) });
	}
	return out;
}

/**
 * The crawler a user agent names: the pattern whose matching string is
 * longest ("Applebot-Extended" over "Applebot"), and at the same length a
 * crawler's own token over another's alias (Googlebot's "Googlebot" over the
 * Inspection Tool's, whose user agent also says Googlebot).
 */
export function matchCrawler(userAgent: string, patterns: CrawlerPattern[]): CrawlerPattern | null {
	const ua = userAgent.toLowerCase();
	let best: CrawlerPattern | null = null;
	let bestScore = 0;
	for (const pattern of patterns) {
		for (const needle of pattern.needles) {
			const score = needle.length * 2 + (needle === pattern.token ? 1 : 0);
			if (score > bestScore && ua.includes(needle)) {
				best = pattern;
				bestScore = score;
			}
		}
	}
	return best;
}

/** A user agent that says it's automated, though the directory doesn't know it. */
const SELF_DECLARED_BOT = /bot\b|bot\/|crawl|spider|slurp|scrap|fetcher|preview|archiver|http-?client|python-|curl\/|wget\/|go-http|java\/|okhttp|axios\//i;

// ── The report ───────────────────────────────────────────────────

export interface PathCount {
	host: string;
	path: string;
	status: number;
	count: number;
	/** On the media host (R2 answers there, not the Worker, so a redirect needs a Cloudflare rule). */
	media: boolean;
}

export interface EdgeReport {
	days: number;
	host: string;
	mediaHost: string | null;
	/** Requests Cloudflare answered for the site and media hosts (sampled estimate). */
	requests: number;
	/** 4xx and 5xx responses per status. */
	statuses: Array<{ status: number; count: number }>;
	notFound: PathCount[];
	serverErrors: { count: number; paths: PathCount[] };
	crawlers: Array<{ name: string; category: string; count: number }>;
	/** Requests from user agents that call themselves bots but aren't in the crawler directory. */
	otherBots: number;
	/** Cloudflare's verified-bot categories, when the zone can query them. */
	verifiedCategories: Array<{ category: string; count: number }> | null;
}

// any: GraphQL rows.
type Row = { count?: unknown; dimensions?: Record<string, any> };

const rowsOf = (zone: Record<string, unknown>, key: string): Row[] => (Array.isArray(zone[key]) ? (zone[key] as Row[]) : []);
const countOf = (row: Row) => num(row.count) ?? 0;
const hostOf = (row: Row) => String(row.dimensions?.clientRequestHTTPHost ?? "").toLowerCase();

export function parseEdgeReport(zone: Record<string, unknown> | null | undefined, options: { host: string; mediaHost: string | null; crawlers: CrawlerPattern[]; days: number; pathLimit?: number }): EdgeReport {
	const z = zone ?? {};
	const host = options.host.toLowerCase();
	const media = options.mediaHost?.toLowerCase() ?? null;
	const ours = (h: string) => h === host || (media !== null && h === media);
	const pathLimit = options.pathLimit ?? 50;

	const requests = rowsOf(z, "hosts")
		.filter((r) => ours(hostOf(r)))
		.reduce((sum, r) => sum + countOf(r), 0);

	const byStatus = new Map<number, number>();
	for (const row of rowsOf(z, "statuses")) {
		const status = num(row.dimensions?.edgeResponseStatus);
		if (status === null || !ours(hostOf(row))) continue;
		byStatus.set(status, (byStatus.get(status) ?? 0) + countOf(row));
	}
	const statuses = [...byStatus].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count || a.status - b.status);

	const paths = (key: string, status: number | null): PathCount[] =>
		rowsOf(z, key)
			.filter((r) => ours(hostOf(r)) && typeof r.dimensions?.clientRequestPath === "string")
			.map((r) => {
				const h = hostOf(r);
				return { host: h, path: String(r.dimensions?.clientRequestPath), status: status ?? num(r.dimensions?.edgeResponseStatus) ?? 0, count: countOf(r), media: h === media };
			});
	const notFound = [...paths("notFound", 404), ...paths("gone", 410)].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, pathLimit);
	const errorPaths = paths("serverErrors", null).sort((a, b) => b.count - a.count);
	const serverErrors = { count: statuses.filter((s) => s.status >= 500).reduce((sum, s) => sum + s.count, 0), paths: errorPaths.slice(0, 20) };

	const crawlerCounts = new Map<string, { name: string; category: string; count: number }>();
	const verified = new Map<string, number>();
	let otherBots = 0;
	let sawVerifiedField = false;
	for (const row of rowsOf(z, "agents")) {
		if (!ours(hostOf(row))) continue;
		const ua = String(row.dimensions?.userAgent ?? "");
		const count = countOf(row);
		if (row.dimensions && "verifiedBotCategory" in row.dimensions) {
			sawVerifiedField = true;
			const category = String(row.dimensions.verifiedBotCategory ?? "").trim();
			if (category) verified.set(category, (verified.get(category) ?? 0) + count);
		}
		if (!ua) continue;
		const crawler = matchCrawler(ua, options.crawlers);
		if (crawler) {
			const entry = crawlerCounts.get(crawler.name) ?? { name: crawler.name, category: crawler.category, count: 0 };
			entry.count += count;
			crawlerCounts.set(crawler.name, entry);
		} else if (SELF_DECLARED_BOT.test(ua)) otherBots += count;
	}
	const crawlers = [...crawlerCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 30);
	const verifiedCategories = sawVerifiedField ? [...verified].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count) : null;

	return { days: options.days, host, mediaHost: media, requests, statuses, notFound, serverErrors, crawlers, otherBots, verifiedCategories };
}

/** Paths a redirect can't help: EmDash's own admin and API, and Cloudflare's /cdn-cgi/ endpoints. */
export function redirectable(row: Pick<PathCount, "path" | "media">): boolean {
	return !row.media && row.path.startsWith("/") && !/^\/(_emdash|cdn-cgi)(\/|$)/.test(row.path);
}

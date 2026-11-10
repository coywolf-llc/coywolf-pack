/**
 * Fathom traffic (pure part): the aggregation URLs and what their answers
 * become. Fathom's API (api.usefathom.com/v1, documented at
 * usefathom.com/api): Bearer token; GET /aggregations with entity=pageview,
 * entity_id=<site ID>, aggregates, optional field_grouping, sort_by, limit
 * and date_from; every number comes back as a string. Each request counts
 * toward the account's monthly pageviews, and the included API allowance is
 * 600 requests an hour with 5 at once, so a reading is four requests, made
 * one after another, at most once an hour.
 *
 * No imports, so `node --test` can load this file.
 */

export const FATHOM_HOST = "api.usefathom.com";
export const FATHOM_API = `https://${FATHOM_HOST}/v1`;
const DAY_MS = 86_400_000;

/** A Fathom site ID as it appears in the embed code (data-site="ABCDEFGH"): letters and digits, upper-cased. */
export function normalizeSiteId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const id = value.trim().toUpperCase();
	return /^[A-Z0-9]{4,16}$/.test(id) ? id : null;
}

/** A time zone the runtime knows (a TZ database name such as America/New_York), or null. */
export function validTimeZone(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
		return value.trim();
	} catch {
		return null;
	}
}

/**
 * Fathom's timestamp format for date_from ("2026-11-03 00:00:00"): midnight at the start of the last `days` days
 * (today counts as one) in `timeZone`, the site's reporting time zone, which Fathom reads date_from in. UTC when
 * it isn't known.
 */
export function fathomFrom(now: number, days: number, timeZone = "UTC"): string {
	const today = new Intl.DateTimeFormat("en-CA", { timeZone: validTimeZone(timeZone) ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
	const start = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS);
	return `${start.toISOString().slice(0, 10)} 00:00:00`;
}

/** GET /sites/{id}: the site, with its reporting time zone. */
export const siteUrl = (siteId: string) => `${FATHOM_API}/sites/${encodeURIComponent(siteId)}`;

export function aggregationUrl(siteId: string, options: { from: string; aggregates: string[]; grouping?: string; sort?: string; limit?: number }): string {
	const params = new URLSearchParams({ entity: "pageview", entity_id: siteId, aggregates: options.aggregates.join(","), date_from: options.from });
	if (options.grouping) params.set("field_grouping", options.grouping);
	if (options.sort) params.set("sort_by", options.sort);
	if (options.limit) params.set("limit", String(options.limit));
	return `${FATHOM_API}/aggregations?${params}`;
}

const count = (value: unknown) => {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};

export interface FathomTotals {
	/** Unique site visits (Fathom's "visits"). */
	visitors: number;
	pageviews: number;
}

/** An ungrouped aggregation: one row (or none when the site had no traffic). */
export function fathomTotals(rows: unknown): FathomTotals {
	// any: Fathom row.
	const row = (Array.isArray(rows) ? rows[0] : null) as any;
	return { visitors: count(row?.visits), pageviews: count(row?.pageviews) };
}

export interface FathomPage {
	path: string;
	pageviews: number;
	/** Unique page visits. */
	uniques: number;
}

/** An aggregation grouped by pathname, most viewed first. */
export function fathomPages(rows: unknown, limit = 10): FathomPage[] {
	return (Array.isArray(rows) ? rows : [])
		// any: Fathom row.
		.map((row: any) => ({ path: typeof row?.pathname === "string" ? row.pathname : "", pageviews: count(row?.pageviews), uniques: count(row?.uniques) }))
		.filter((p) => p.path)
		.sort((a, b) => b.pageviews - a.pageviews || a.path.localeCompare(b.path))
		.slice(0, limit);
}

export interface FathomReport {
	siteId: string;
	/** The site's reporting time zone in Fathom (the days are counted in it). */
	timeZone: string;
	week: FathomTotals;
	month: FathomTotals;
	weekPages: FathomPage[];
	monthPages: FathomPage[];
}

/** What a failed answer means, in words (Fathom's own message when it has one; never the key). */
export function fathomError(status: number, body: unknown, retryAfter: string | null, siteId: string): string {
	// any: Fathom's error bodies ({ error: "…" }, { error: { message } }, { message }, { errors: { field: [...] } }).
	const b = (body ?? {}) as any;
	const said =
		typeof b.error === "string" ? b.error : typeof b.error?.message === "string" ? b.error.message : typeof b.message === "string" ? b.message : b.errors && typeof b.errors === "object" ? Object.values(b.errors).flat().join(" ") : "";
	const detail = said ? ` (${String(said).slice(0, 200)})` : "";
	if (status === 401) return `Fathom doesn't accept the API key${detail}: it may be mistyped or deleted. Create a new one and save it.`;
	if (status === 404) return `Fathom can't find site ${siteId} with this API key${detail}. Check the site ID, and that the key can read this site.`;
	if (status === 429) return `Fathom's API limit was reached${detail}.${retryAfter ? ` Fathom asks to wait ${retryAfter} seconds.` : ""}`;
	if (status === 400 && /permission/i.test(said)) return `The Fathom API key can't read this site${detail}. Give it Read only (all sites) or this site's read access.`;
	return `Fathom's API answered ${status}${detail}.`;
}

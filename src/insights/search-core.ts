/**
 * Search insights (pure part): what a search becomes before it's counted,
 * and the privacy rules it passes first.
 *
 * Only the normalized query text and two counts per day are kept (searches,
 * and searches that found nothing), never an IP address, a user agent, a
 * time of day or anything else about the visitor. Queries that look like an
 * email address, a handle, a long number (phone, card, order) or a key are
 * dropped before they're counted (names and short IDs can't be told from
 * ordinary words, so they aren't), and rows older than 90 days are deleted
 * every day. The report lists a query only once it's been seen MIN_SHOWN
 * times on MIN_DAYS different days. Counts can't tell visitors apart, so
 * that keeps one-off searches out, not every search one person made.
 *
 * Live results ask the server as visitors type, so the server never counts
 * those answers. The live client counts a search once the visitor stops
 * typing for a moment or opens a result (POST search/seen), and the search
 * page counts the searches it answers.
 *
 * No imports, so `node --test` can load this file.
 */

export const SEARCH_COLLECTION = "searchInsights";
export const RETENTION_DAYS = 90;
/** Longest query kept (longer ones are cut at a word). */
export const MAX_QUERY_LENGTH = 80;
/** A query is listed only once it's been searched at least this many times… */
export const MIN_SHOWN = 3;
/** …on at least this many different days. */
export const MIN_DAYS = 2;
/** Most distinct queries the site records in a day (counted in D1 before each batch); later new queries wait for tomorrow. */
export const MAX_QUERIES_PER_DAY = 1_000;

/**
 * Whether a search/seen request came from the site's own pages: the X-EmDash-Request header the clients send
 * (a cross-site form can't set it, and a cross-site fetch with it needs a CORS preflight the site never
 * grants), Sec-Fetch-Site "same-origin" when the browser says, and the site's own Origin when it's there.
 */
export function seenFromSite(header: (name: string) => string | null, origin: string): boolean {
	if (!header("x-emdash-request")) return false;
	const site = header("sec-fetch-site");
	if (site !== null && site !== "same-origin") return false;
	const from = header("origin");
	return from === null || from === origin;
}

/** A settled search from the live client: `{ q, n }` with the query as typed and its number of results. Null when malformed. */
export function parseSeen(body: unknown): { q: string; n: number } | null {
	// any: a request body.
	const b = body as any;
	if (!b || typeof b !== "object" || typeof b.q !== "string" || b.q.length > 200) return null;
	const n = typeof b.n === "number" ? b.n : Number.NaN;
	return Number.isInteger(n) && n >= 0 && n <= 100 ? { q: b.q, n } : null;
}

/** Email addresses and @handles; long digit runs, separators allowed (phones, cards, order numbers); key-like strings. */
export function looksPersonal(query: string): boolean {
	if (query.includes("@")) return true;
	const digits = query.replace(/(?<=\d)[\s().+/-]+(?=\d)/g, "");
	if (/\d{7,}/.test(digits)) return true;
	return /(?=[a-z0-9_-]*\d)(?=[a-z0-9_-]*[a-z])[a-z0-9_-]{20,}/i.test(query);
}

const EDGE_PUNCTUATION = /^[\s"'“”‘’«»()[\]{}<>*]+|[\s"'“”‘’«»()[\]{}<>*.,;:!?]+$/gu;

/** The query as it's counted (lower case, spaces collapsed, edge punctuation off), or null when it isn't kept. */
export function normalizeSearchQuery(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	let q = raw.normalize("NFKC").toLowerCase().replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
	q = q.replace(EDGE_PUNCTUATION, "").trim();
	if (q.length < 2 || looksPersonal(q)) return null;
	if (q.length > MAX_QUERY_LENGTH) {
		const cut = q.slice(0, MAX_QUERY_LENGTH);
		const space = cut.lastIndexOf(" ");
		q = (space > MAX_QUERY_LENGTH / 2 ? cut.slice(0, space) : cut).trim();
	}
	return q;
}

export type SearchSource = "live" | "page";

export interface SearchEvent {
	q: string;
	results: number;
	source: SearchSource;
}

export interface Tally {
	/** Searches. */
	n: number;
	/** Searches that found nothing. */
	z: number;
}

/** One batch's searches as counts per query. Each event is one search (the live client sends only settled ones). */
export function collapseBatch(events: SearchEvent[]): Map<string, Tally> {
	const out = new Map<string, Tally>();
	for (const e of events) {
		const tally = out.get(e.q) ?? { n: 0, z: 0 };
		tally.n++;
		if (e.results === 0) tally.z++;
		out.set(e.q, tally);
	}
	return out;
}

/** The UTC day a count belongs to. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The first day still inside a window of `days` days ending today. */
export const firstDay = (now: number, days: number) => dayOf(now - (days - 1) * 86_400_000);

/** One row per day and query. */
export const rowId = (day: string, q: string) => `${day}:${q}`;

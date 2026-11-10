/**
 * Search insights (pure part): what a search becomes before it's counted,
 * and the privacy rules it passes first.
 *
 * Only the normalized query text and two counts per day are kept (searches,
 * and searches that found nothing), never an IP address, a user agent, a
 * time of day or anything else about the visitor. Queries that look like an
 * email address, a handle, a long number (phone, card, order) or a key are
 * dropped before they're counted, and rows older than 90 days are deleted
 * every day. The report never shows a query seen only once.
 *
 * Live results ask the server as visitors type, so a batch also folds a
 * visitor's keystrokes into the search they ended up with: a live query
 * that's the start of another query in the same batch ("coy", then
 * "coyote") was typing on the way there, and a query answered both live and
 * by the search page (typed, then submitted) counts once.
 *
 * No imports, so `node --test` can load this file.
 */

export const SEARCH_COLLECTION = "searchInsights";
export const RETENTION_DAYS = 90;
/** Longest query kept (longer ones are cut at a word). */
export const MAX_QUERY_LENGTH = 80;
/** Queries seen fewer times than this in the window are never shown. */
export const MIN_SHOWN = 2;

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

/** One batch's searches as counts per query (see the file comment for the folding rules). */
export function collapseBatch(events: SearchEvent[]): Map<string, Tally> {
	const live = new Map<string, Tally>();
	const page = new Map<string, Tally>();
	for (const e of events) {
		const into = e.source === "page" ? page : live;
		const tally = into.get(e.q) ?? { n: 0, z: 0 };
		tally.n++;
		if (e.results === 0) tally.z++;
		into.set(e.q, tally);
	}
	const queries = [...new Set([...live.keys(), ...page.keys()])];
	const out = new Map<string, Tally>();
	for (const q of queries) {
		const l = live.get(q);
		const p = page.get(q);
		if (!p && queries.some((other) => other !== q && other.startsWith(q))) continue;
		const pick = !l ? p : !p ? l : p.n >= l.n ? p : l;
		if (pick) out.set(q, { n: pick.n, z: pick.z });
	}
	return out;
}

/** The UTC day a count belongs to. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The first day still inside a window of `days` days ending today. */
export const firstDay = (now: number, days: number) => dayOf(now - (days - 1) * 86_400_000);

/** One row per day and query. */
export const rowId = (day: string, q: string) => `${day}:${q}`;

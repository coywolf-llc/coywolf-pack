/**
 * Wikidata lookups for entity grounding: wbsearchentities (api.php) for real
 * candidates, then one Wikidata Query Service (SPARQL) request for P31
 * (instance of), P856 (official website) and the Wikipedia sitelink. Public
 * APIs, no key. Search results are cached per isolate so repeated names (and
 * bulk runs) cost no extra subrequests.
 *
 * Etiquette (https://www.mediawiki.org/wiki/API:Etiquette): one request at a
 * time, maxlag=5 on api.php, and a 429 or maxlag answer defers the job until
 * Retry-After instead of failing it.
 */
import { type Candidate, type WikidataDetails, detailsQuery, parseSearch, parseSparqlDetails } from "./logic.js";

export const WIKIDATA_HOST = "www.wikidata.org";
export const WIKIDATA_QUERY_HOST = "query.wikidata.org";
const API = `https://${WIKIDATA_HOST}/w/api.php`;
const SPARQL = `https://${WIKIDATA_QUERY_HOST}/sparql`;
const CACHE_MAX = 500;
const searchCache = new Map<string, Candidate[]>();

/** Tests only: forget every search, as another isolate would have. */
export function resetSearchCacheForTests(): void {
	searchCache.clear();
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Wikidata asked us to slow down (HTTP 429, or api.php's maxlag): try the job again after `retryAfterMs`. */
export class WikidataBusyError extends Error {
	readonly retryAfterMs: number;
	constructor(retryAfterMs: number) {
		super(`Wikidata asked to slow down. Retrying in ${Math.ceil(retryAfterMs / 1000)} seconds.`);
		this.name = "WikidataBusyError";
		this.retryAfterMs = retryAfterMs;
	}
}

/** A Retry-After header (seconds or an HTTP date) in ms, kept between 5 seconds and 1 hour; 60 seconds when missing or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
	const value = header?.trim() ?? "";
	let ms = /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - now : Number.NaN;
	if (!Number.isFinite(ms)) ms = 60_000;
	return Math.min(Math.max(ms, 5_000), 3_600_000);
}

async function getJson(fetcher: Fetch, url: string, userAgent: string, accept: string): Promise<unknown> {
	let response: Response;
	try {
		response = await fetcher(url, { headers: { "user-agent": userAgent, accept }, signal: AbortSignal.timeout(10_000) });
	} catch {
		return null;
	}
	const retryAfter = response.headers.get("retry-after");
	if (!response.ok) {
		console.warn(`[coywolf-pack] Wikidata (${new URL(url).host}) answered HTTP ${response.status}`, { retryAfter });
		if (response.status === 429) throw new WikidataBusyError(retryAfterMs(retryAfter));
		return null;
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return null;
	}
	if ((body as { error?: { code?: unknown } })?.error?.code === "maxlag") {
		console.warn(`[coywolf-pack] Wikidata (${new URL(url).host}) is lagged (maxlag)`, { retryAfter });
		throw new WikidataBusyError(retryAfterMs(retryAfter));
	}
	return body;
}

/** Wikidata's candidates for a name; [] when it has none or didn't answer. */
export async function searchCandidates(fetcher: Fetch, name: string, language: string, userAgent: string): Promise<Candidate[]> {
	return (await findCandidates(fetcher, name, language, userAgent)) ?? [];
}

/** As searchCandidates, telling "no answer" (null: try again later) from "no results" ([]: Wikidata answered). */
export async function findCandidates(fetcher: Fetch, name: string, language: string, userAgent: string): Promise<Candidate[] | null> {
	const key = `${language}|${name.toLowerCase()}`;
	const hit = searchCache.get(key);
	if (hit) return hit;
	const params = { action: "wbsearchentities", format: "json", maxlag: "5", language, uselang: language, type: "item", limit: "5", search: name };
	const body = await getJson(fetcher, `${API}?${new URLSearchParams(params)}`, userAgent, "application/json");
	if (body === null) return null; // Don't cache failures.
	const candidates = parseSearch(body);
	if (searchCache.size >= CACHE_MAX) searchCache.delete(searchCache.keys().next().value as string);
	searchCache.set(key, candidates);
	return candidates;
}

/** Details for up to 50 items in one SPARQL request; null when Wikidata didn't answer (the caller retries later). */
export async function entityDetails(fetcher: Fetch, qids: string[], language: string, userAgent: string): Promise<Record<string, WikidataDetails> | null> {
	const ids = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))].slice(0, 50);
	if (!ids.length) return {};
	const url = `${SPARQL}?${new URLSearchParams({ query: detailsQuery(ids, language), format: "json" })}`;
	const body = await getJson(fetcher, url, userAgent, "application/sparql-results+json");
	return body === null ? null : parseSparqlDetails(body, language);
}

/**
 * EmDash search with an OR fallback, plus resolved public URLs and type
 * labels for each result. Used by the pack's public search route (and so by
 * the SearchBox typeahead), and exported for site search pages:
 *
 * ```astro
 * ---
 * import { searchWithFallback } from "@coywolf/emdash/astro";
 * const q = Astro.url.searchParams.get("q") ?? "";
 * const { items, fallback } = q ? await searchWithFallback(q) : { items: [], fallback: false };
 * ---
 * ```
 */
import { type SearchResult, search } from "emdash";

import { COLLECTION_SLUG, type CollectionInfo, createEntryUrlResolver, interpolateUrlPattern, readCollections } from "../core/content-url.js";
import { noteSearch } from "../insights/search.js";
import { afterResponse, workerEnv } from "../shared.js";
import { buildOrQuery, rankByCoverage } from "./fallback.js";
import { type LiveSearchResponse, liveSearchD1 } from "./engine.js";

export interface PackSearchResult extends SearchResult {
	/** Public path of the entry: the site's `urls` override for the collection, or its URL pattern. */
	url: string;
	/** The collection's (singular) label, e.g. "Post". */
	type: string;
}

export interface PackSearchResponse {
	items: PackSearchResult[];
	nextCursor?: string;
	/** True when nothing matched every word, so these results match any word. */
	fallback: boolean;
}

export interface PackSearchOptions {
	collections?: string[];
	locale?: string;
	/** Default 10. */
	limit?: number;
	cursor?: string;
	/** "suggest" matches titles first (typeahead), then full text. Default "search". */
	mode?: "search" | "suggest";
	/** D1 binding of the site database, for URL patterns and terms. Default "DB". */
	database?: string;
}

/** How many OR results to rank in one go (the fallback isn't paginated). */
const FALLBACK_POOL = 50;

export async function searchWithFallback(query: string, options: PackSearchOptions = {}): Promise<PackSearchResponse> {
	const result = await searchOrFallback(query, options);
	// A full search (the site's search page, or search/query in search mode), first page only: Search insights count it when on.
	if (options.mode !== "suggest" && !options.cursor) {
		const database = options.database ?? "DB";
		void workerEnv()
			.then((env) => noteSearch(env[database] as D1Database | undefined, query, result.items.length, "page", afterResponse))
			.catch(() => undefined);
	}
	return result;
}

async function searchOrFallback(query: string, options: PackSearchOptions): Promise<PackSearchResponse> {
	const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
	const base = {
		collections: options.collections ? [...new Set(options.collections)].filter((c) => COLLECTION_SLUG.test(c)).slice(0, 10) : undefined,
		locale: options.locale,
	};

	// EmDash treats an empty list as "every collection"; a list with nothing valid in it should find nothing.
	if (base.collections && base.collections.length === 0) return { items: [], fallback: false };

	if (options.mode === "suggest" && !options.cursor) {
		const titles = await search(query, { ...base, limit, scope: "title" });
		if (titles.items.length) return { items: await withUrls(titles.items, options.database), fallback: false };
	}

	const all = await search(query, { ...base, limit, cursor: options.cursor });
	if (all.items.length || options.cursor) {
		return { items: await withUrls(all.items, options.database), nextCursor: all.nextCursor, fallback: false };
	}

	const orQuery = buildOrQuery(query);
	if (!orQuery) return { items: [], fallback: false };
	const any = await search(orQuery, { ...base, limit: FALLBACK_POOL });
	const ranked = rankByCoverage(any.items, query).slice(0, limit);
	return { items: await withUrls(ranked, options.database), fallback: ranked.length > 0 };
}

export type { LiveSearchResponse, LiveSearchResult } from "./engine.js";

/**
 * Live results (as-you-type dropdown): title matches first, then full-text
 * matches (with the OR fallback) to fill the list, each with an excerpt from
 * the entry's indexed text. Same SQL, ranking, fallback and URLs as
 * searchWithFallback, run by the batched D1 engine (src/search/engine.ts).
 * Published entries only.
 */
export async function liveSearch(query: string, options: Omit<PackSearchOptions, "cursor" | "mode"> & { version?: string } = {}): Promise<LiveSearchResponse> {
	const database = options.database ?? "DB";
	let db: D1Database | undefined;
	try {
		db = (await workerEnv())[database] as D1Database | undefined;
	} catch {
		db = undefined;
	}
	if (!db) return { items: [], fallback: false };
	return liveSearchD1(db, query, { collections: options.collections, locale: options.locale, limit: options.limit, database, version: options.version });
}

async function withUrls(items: SearchResult[], database = "DB"): Promise<PackSearchResult[]> {
	if (!items.length) return [];
	const slugs = [...new Set(items.map((i) => i.collection))];
	let db: D1Database | undefined;
	try {
		db = (await workerEnv())[database] as D1Database | undefined;
	} catch {
		db = undefined;
	}
	const collections = db ? await readCollections(db, slugs).catch(() => new Map<string, CollectionInfo>()) : new Map<string, CollectionInfo>();

	// Paths from the pack-wide resolver: the site's `urls` overrides (terms read in one batch per
	// collection) or the collection's url_pattern (publish dates read only when it has date tokens).
	const urls = new Map<string, string | null>();
	if (db) {
		const resolver = createEntryUrlResolver(db);
		for (const slug of slugs) {
			const entries = items.filter((i) => i.collection === slug).map((i) => ({ id: i.id, slug: i.slug ?? i.id, locale: i.locale }));
			try {
				for (const [id, url] of await resolver.urls(slug, entries)) urls.set(`${slug}:${id}`, url);
			} catch {
				// Fall back to the default route below rather than fail the search.
			}
		}
	}

	return items.map((item) => {
		const info = collections.get(item.collection);
		return {
			...item,
			url: urls.get(`${item.collection}:${item.id}`) ?? interpolateUrlPattern({ pattern: null, collection: item.collection, slug: item.slug ?? item.id, id: item.id }),
			type: info?.labelSingular || info?.label || item.collection,
		};
	});
}

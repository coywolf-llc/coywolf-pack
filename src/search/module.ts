/**
 * Search module routes.
 *
 * - search/query (public): EmDash search with an OR fallback, title-first
 *   suggestions, and resolved URLs.
 * - search/live (public): live results for the as-you-type dropdown
 *   (feature "search.live"): title matches, then full text, each with a
 *   highlighted excerpt. Backs the live results script (injected on every
 *   page by the page:fragments hook below) and the SearchBox. With the pack
 *   middleware installed, live-serve.ts answers this path first, from the
 *   edge cache when it can; this route is the fallback.
 * - search/index (public): the title index for instant results in the
 *   browser (title-index.ts), likewise served by the middleware first.
 * - search/touch (admin): a new search content version, after search
 *   settings change (the Search admin page calls it), so cached answers and
 *   title indexes are rebuilt.
 * - search/config (admin): each collection's search configuration and
 *   fields, read-only, for the Search admin page. The page changes settings
 *   through EmDash's own /_emdash/api/search/{enable,rebuild,stats}
 *   endpoints, so EmDash's permission checks (search:manage) apply.
 */
import { type PluginContext, PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { requireCachedFeature, requireFeature } from "../core/features.js";
import { COLLECTION_SLUG, readCollections } from "../core/content-url.js";
import { noteSearch } from "../insights/search.js";
import { afterResponse, parseInput, workerEnv } from "../shared.js";
import { liveSearchD1, loadSearchMeta } from "./engine.js";
import { normalizeCollections, normalizeLiveQuery, normalizeLocale } from "./live-cache.js";
import { INDEX_ENDPOINT, LIVE_ENDPOINT, bumpSearchVersion, configureSearchLive, liveScriptFragment, searchVersion } from "./live-serve.js";
import { searchWithFallback } from "./query.js";
import { TITLE_INDEX_MAX, buildTitleIndex } from "./title-index.js";

export { INDEX_ENDPOINT, LIVE_ENDPOINT };

export interface SearchOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** Requests per minute per visitor for search.rateLimit's in-memory fallback. Default 120; 0 turns it off. */
	requestsPerMinute?: number;
	/** Workers Rate Limiting binding name for search.rateLimit. Default none (per-isolate memory only). */
	rateLimiter?: string;
	/** Live results dropdown (feature "search.live") on the site's search forms. */
	live?: LiveOptions;
}

export interface LiveOptions {
	/** Results in the dropdown. Default 8 (1–20). */
	limit?: number;
	/** Characters typed before results show. Default 2. */
	minChars?: number;
	/** Milliseconds to wait after the last keystroke before asking the server. Default 120 (title matches show at once). */
	debounce?: number;
	/** Instant title matches from a title index loaded in the browser on first focus. Default true. */
	instant?: boolean;
	/** Most entries in the title index (newest kept). Default 5000. */
	indexMax?: number;
	/** Select the first result as results appear, so Enter opens it (Enter otherwise submits the form). Default true. */
	enterOpensTop?: boolean;
}

const clampInt = (value: number | undefined, min: number, max: number, fallback: number) =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Most collections one search may name. */
const MAX_COLLECTIONS = 10;

const liveInput = z.object({
	q: z.string().trim().min(1, "Enter a search.").max(200, "That search is too long."),
	collections: z.string().max(500).optional(),
	locale: z.string().max(35).optional(),
	limit: z.coerce.number().int().min(1).max(20).optional(),
});

const indexInput = z.object({
	collections: z.string().max(500).optional(),
	locale: z.string().max(35).optional(),
});

const queryInput = z.object({
	q: z.string().trim().min(1, "Enter a search.").max(200, "That search is too long."),
	mode: z.enum(["search", "suggest"]).optional(),
	collections: z.string().max(500).optional(),
	locale: z.string().max(35).optional(),
	limit: z.coerce.number().int().min(1).max(20).optional(),
	cursor: z.string().max(500).optional(),
});

interface CollectionRow {
	id: string;
	slug: string;
	label: string;
	search_config: string | null;
	title_field: string | null;
}

interface FieldRow {
	collection_id: string;
	slug: string;
	label: string;
	type: string;
	searchable: number;
}

export function searchModule(options: SearchOptions) {
	const database = options.database ?? "DB";
	const live = {
		endpoint: LIVE_ENDPOINT,
		limit: clampInt(options.live?.limit, 1, 20, 8),
		minChars: clampInt(options.live?.minChars, 1, 20, 2),
		debounce: clampInt(options.live?.debounce, 0, 2000, 120),
		enterOpensTop: options.live?.enterOpensTop ?? true,
	};
	const instant = options.live?.instant ?? true;
	const indexMax = clampInt(options.live?.indexMax, 1, 20_000, TITLE_INDEX_MAX);
	configureSearchLive({ database, limit: live.limit, indexMax });

	/** Only collections that exist; asking for nothing real finds nothing rather than everything. Undefined means all. */
	async function knownCollections(list: string | undefined): Promise<string[] | undefined> {
		if (!list) return undefined;
		const requested = [...new Set(list.split(",").map((c) => c.trim()))].filter((c) => COLLECTION_SLUG.test(c)).slice(0, MAX_COLLECTIONS);
		const known = requested.length ? await readCollections(await db(), requested) : new Map();
		return requested.filter((c) => known.has(c));
	}

	async function db() {
		const env = await workerEnv();
		const d1 = env[database] as D1Database | undefined;
		if (!d1) throw PluginRouteError.badRequest("Search: missing database binding.");
		return d1;
	}

	const routes = {
		"search/query": definePluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			cacheControl: "public, max-age=60",
			handler: async (ctx) => {
				await requireFeature(ctx, "search.box");
				const input = parseInput(queryInput, ctx.input);
				const collections = await knownCollections(input.collections);
				if (collections && !collections.length) return { items: [], fallback: false };
				return searchWithFallback(input.q, {
					mode: input.mode,
					collections,
					locale: input.locale,
					limit: input.limit ?? 8,
					cursor: input.cursor,
					database,
				});
			},
		}),

		"search/live": definePluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			// Published content only, the same for every visitor; a minute keeps a burst of identical keystrokes cheap.
			cacheControl: "public, max-age=60",
			handler: async (ctx) => {
				await requireCachedFeature(ctx, "search.live");
				const raw = (ctx.input ?? {}) as Record<string, unknown>;
				const version = await searchVersion(database);
				if (raw.warm === "1") {
					await loadSearchMeta(await db(), database, version).catch(() => undefined);
					return { items: [], fallback: false };
				}
				const input = parseInput(liveInput, raw);
				const d1 = await db();
				const query = normalizeLiveQuery(input.q);
				const found = await liveSearchD1(d1, query, {
					collections: normalizeCollections(input.collections),
					locale: normalizeLocale(input.locale),
					limit: input.limit ?? live.limit,
					database,
					version,
				});
				noteSearch(d1, query, found.items.length, "live", afterResponse);
				return found;
			},
		}),

		"search/index": definePluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			cacheControl: "public, max-age=300",
			handler: async (ctx) => {
				await requireCachedFeature(ctx, "search.live");
				const input = parseInput(indexInput, ctx.input ?? {});
				const version = await searchVersion(database);
				const d1 = await db();
				const meta = await loadSearchMeta(d1, database, version);
				return buildTitleIndex(d1, meta, { collections: normalizeCollections(input.collections), locale: normalizeLocale(input.locale), version, max: indexMax });
			},
		}),

		"search/touch": definePluginRoute({
			permission: "search:manage",
			methods: ["POST"],
			request: { body: "none" },
			handler: async (ctx) => {
				await requireFeature(ctx, "search");
				return { version: await bumpSearchVersion(ctx) };
			},
		}),

		"search/config": {
			permission: "search:manage" as const,
			handler: async (ctx: Parameters<typeof requireFeature>[0]) => {
				await requireFeature(ctx, "search.settings");
				const d1 = await db();
				const [collections, fields] = await Promise.all([
					d1.prepare("SELECT id, slug, label, search_config, title_field FROM _emdash_collections ORDER BY label").all<CollectionRow>(),
					d1.prepare("SELECT collection_id, slug, label, type, searchable FROM _emdash_fields ORDER BY sort_order").all<FieldRow>(),
				]);
				return {
					collections: collections.results.map((c) => {
						let config: { enabled?: boolean; weights?: Record<string, number>; tokenize?: string } = {};
						try {
							config = c.search_config ? JSON.parse(c.search_config) : {};
						} catch {
							config = {};
						}
						return {
							slug: c.slug,
							label: c.label,
							enabled: config.enabled === true,
							weights: config.weights ?? {},
							tokenize: config.tokenize ?? "porter unicode61",
							titleField: c.title_field,
							fields: fields.results
								.filter((f) => f.collection_id === c.id)
								.map((f) => ({ slug: f.slug, label: f.label, type: f.type, searchable: f.searchable === 1 })),
						};
					}),
				};
			},
		},
	};

	/** Published content changed: cached live answers and title indexes for the old version retire. */
	const touch = async (ctx: { settings: { set(key: string, value: unknown): Promise<void> } }) => {
		await bumpSearchVersion(ctx);
	};
	const isPublished = (content: Record<string, unknown> | undefined) => !content || content.status === undefined || content.status === "published";

	const hooks = {
		/**
		 * The live results script, on every public page (it attaches only where there's a search form):
		 * a deferred, versioned file browsers cache, with this page's config in an attribute, when the
		 * pack middleware serves that file; otherwise the same client inline (see liveScriptFragment).
		 */
		"page:fragments": async (event: { page: { locale: string | null } }) =>
			liveScriptFragment({ ...live, indexEndpoint: instant ? INDEX_ENDPOINT : null, version: await searchVersion(database), locale: event.page.locale ?? null }),
		"content:afterSave": (event: { content?: Record<string, unknown> }, ctx: PluginContext) => (isPublished(event.content) ? touch(ctx) : undefined),
		"content:afterPublish": (_event: unknown, ctx: PluginContext) => touch(ctx),
		"content:afterUnpublish": (_event: unknown, ctx: PluginContext) => touch(ctx),
		"content:afterDelete": (_event: unknown, ctx: PluginContext) => touch(ctx),
		"content:afterRestore": (_event: unknown, ctx: PluginContext) => touch(ctx),
	};

	return { routes, hooks };
}

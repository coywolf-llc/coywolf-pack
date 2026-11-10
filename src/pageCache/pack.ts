import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { registerSiteOption, registerSiteSetting, rememberSiteOption, rememberSiteSetting, siteFeatureOn, siteOption, siteSetting } from "../core/features.js";
import { parseInput } from "../shared.js";
import { CLOUDFLARE_API_HOST, CloudflareApiError, applyMediaCacheRule, readMediaCacheRule } from "../images/cloudflare.js";
import { mediaApiAccess, purgeMediaHost } from "../images/module.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { settleLater } from "../core/generation.js";
import { workerEnv } from "../shared.js";
import { ROBOTS_TAG, VERSION_OPTION, keepAtEdge, noteNewVersion, purgePageCache, versionId } from "./lib.js";
import { usageReport } from "./usage.js";
import { WARM_DAILY_SETTING, WARM_SETTING, WARM_STATE_OPTION, WARM_TASK, nextDailyAt, pendingRevisits, readWarmState, remainingUrls, startWarm, warmFromCron } from "./warm.js";

/**
 * Performance is always on (its page sits right below Coywolf Pack). On a site
 * without Workers Cache its purges do nothing and its lifetimes apply to no
 * route, so there's nothing to switch off.
 */
export const ALWAYS = "*";

export interface PageCacheOptions {
	/**
	 * Set this when the site shares Workers Cache across deploys
	 * (`"cache": { "enabled": true, "cross_version_cache": true }` in
	 * wrangler.jsonc). Then a page cached by the previous deploy is still
	 * served after the next one, so the first request a new Worker version
	 * handles clears every cached page, as the pack always did before 0.35.19.
	 * Default false: Workers Cache keeps each version's pages apart, a deploy
	 * starts from a cold cache by itself, and the pack only notices the new
	 * version (to start cache warming).
	 */
	crossVersionCache?: boolean;
}

/**
 * Options from coywolfPlugin({ pageCache }). EmDash creates the plugin when the Worker
 * isolate starts, before any request reaches the middleware (as with the search rate limit).
 */
let config: PageCacheOptions = {};
export function configurePageCache(options: PageCacheOptions): void {
	config = { ...options };
}
export function pageCacheConfig(): PageCacheOptions {
	return config;
}

/** How long the edge keeps a page, and how long after that it may serve it while refreshing. */
export const LIFETIME_SETTINGS = { maxAgeDays: "pageCacheMaxAgeDays", refreshDays: "pageCacheRefreshDays" } as const;
export const LIFETIME_DEFAULTS = { maxAgeDays: 7, refreshDays: 1 } as const;
registerSiteSetting(LIFETIME_SETTINGS.maxAgeDays);
registerSiteSetting(LIFETIME_SETTINGS.refreshDays);
registerSiteSetting(WARM_SETTING);
registerSiteSetting(WARM_DAILY_SETTING);
// The deployed version whose pages are cached, read with the switches (no query of its own per isolate).
registerSiteOption(VERSION_OPTION);

async function siteDb(): Promise<D1Database | undefined> {
	const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
	return env.DB as D1Database | undefined;
}

/** The hourly warming fallback (WARM_TASK): does nothing while cache warming is off. */
const WARM_SCHEDULE = "@hourly";

async function warmTask(ctx: { settings: { get<T>(key: string): Promise<T | null | undefined> }; site?: { url?: string }; log: { info(msg: string, data?: unknown): void } }): Promise<void> {
	if (!(await ctx.settings.get<boolean>(WARM_SETTING))) return;
	const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
	const db = env.DB as D1Database | undefined;
	const self = env.SELF as Fetcher | undefined;
	let origin: string | null = null;
	try {
		origin = ctx.site?.url ? new URL(ctx.site.url).origin : null;
	} catch {
		origin = null;
	}
	if (!db || !self || !origin) return;
	const daily = (await ctx.settings.get<boolean>(WARM_DAILY_SETTING)) !== false;
	const steps = await warmFromCron(db, self, origin, { daily });
	if (steps.length) ctx.log.info("Cache warming: hourly fallback", { steps });
}


const lifetimeInput = z.object({
	maxAgeDays: z.number().int().min(1, "Keep pages for at least 1 day.").max(365, "Keep pages for at most 365 days."),
	refreshDays: z.number().int().min(0).max(365, "Refresh for at most 365 days."),
});

const apiError = (error: unknown): never => {
	if (error instanceof CloudflareApiError) throw PluginRouteError.badRequest(error.message);
	throw error;
};

export function pageCachePack(options: PageCacheOptions = {}): PackModule {
	configurePageCache(options);
	return {
		id: "pageCache",
		label: "Page cache",
		features: [],
		routes: {
			/** The Performance section: page lifetimes and whether the site has Workers Cache. */
			"cache/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Parameters<typeof mediaApiAccess>[0]) => {
					const [maxAgeDays, refreshDays] = await Promise.all([
						ctx.settings.get<number>(LIFETIME_SETTINGS.maxAgeDays),
						ctx.settings.get<number>(LIFETIME_SETTINGS.refreshDays),
					]);
					return {
						maxAgeDays: maxAgeDays ?? LIFETIME_DEFAULTS.maxAgeDays,
						refreshDays: refreshDays ?? LIFETIME_DEFAULTS.refreshDays,
						images: await siteFeatureOn("images"),
					};
				},
			},

			/** Cache warming: the switch and where the current (or last) run is. */
			"cache/warm/status": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Parameters<typeof mediaApiAccess>[0]) => {
					const db = await siteDb();
					const state = db ? await readWarmState(db) : null;
					return {
						enabled: Boolean(await ctx.settings.get<boolean>(WARM_SETTING)),
						// The daily refresh: on unless turned off.
						daily: (await ctx.settings.get<boolean>(WARM_DAILY_SETTING)) !== false,
						// `revisiting`: pages warmed with a stopgap poster, to be warmed again once their posters are copied (the URLs stay out).
						// `nextDailyAt`: when the daily refresh starts a new run (ms; only once a run has finished).
						state: state && { ...state, revisit: undefined, remaining: remainingUrls(state), revisiting: pendingRevisits(state), nextDailyAt: nextDailyAt(state) ?? undefined },
					};
				},
			},

			"cache/warm/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { enabled, daily } = parseInput(z.object({ enabled: z.boolean().optional(), daily: z.boolean().optional() }), ctx.input);
					if (enabled !== undefined) {
						await ctx.settings.set(WARM_SETTING, enabled);
						rememberSiteSetting(WARM_SETTING, enabled);
						// The hourly fallback (it's also scheduled whenever the Features page opens).
						if (enabled) await ctx.cron?.schedule(WARM_TASK, { schedule: WARM_SCHEDULE }).catch((error: unknown) => ctx.log.warn("Cache warming: couldn't schedule the hourly task", { error: String(error) }));
					}
					if (daily !== undefined) {
						await ctx.settings.set(WARM_DAILY_SETTING, daily);
						rememberSiteSetting(WARM_DAILY_SETTING, daily);
					}
					return { enabled, daily };
				},
			}),

			/** Warm every page now (also restarts a run in progress). */
			"cache/warm/start": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "none" },
				handler: async (ctx) => {
					const db = await siteDb();
					if (!db) throw PluginRouteError.badRequest("Missing the DB binding.");
					if (!(await ctx.settings.get<boolean>(WARM_SETTING))) throw PluginRouteError.badRequest("Turn on cache warming first.");
					const state = await startWarm(db, "manual");
					return { state: { ...state, remaining: 0 } };
				},
			}),

			"cache/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const input = parseInput(lifetimeInput, ctx.input);
					await ctx.settings.set(LIFETIME_SETTINGS.maxAgeDays, input.maxAgeDays);
					await ctx.settings.set(LIFETIME_SETTINGS.refreshDays, input.refreshDays);
					rememberSiteSetting(LIFETIME_SETTINGS.maxAgeDays, input.maxAgeDays);
					rememberSiteSetting(LIFETIME_SETTINGS.refreshDays, input.refreshDays);
					// Pages already cached keep their old lifetime; the pack's purge-after-save clears them.
					return input;
				},
			}),

			/** The media host's Cloudflare Cache Rule (read through the Clean Image URLs token). */
			"cache/media": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Parameters<typeof mediaApiAccess>[0]) => {
					const access = await mediaApiAccess(ctx);
					if (!("config" in access)) return { host: access.hostname, reason: access.reason, rule: null };
					try {
						const { zone, rule } = await readMediaCacheRule(access.config, access.hostname);
						return { host: access.hostname, zone, rule };
					} catch (error) {
						return { host: access.hostname, reason: error instanceof Error ? error.message : String(error), rule: null };
					}
				},
			},

			"cache/media/apply": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "none" },
				handler: async (ctx) => {
					const access = await mediaApiAccess(ctx);
					if (!("config" in access)) throw PluginRouteError.badRequest(access.reason);
					const zone = await applyMediaCacheRule(access.config, access.hostname).catch(apiError);
					ctx.log.info("Media cache rule applied", { host: access.hostname, zone });
					return { host: access.hostname, zone, ...(await readMediaCacheRule(access.config, access.hostname).catch(() => ({ rule: null }))) };
				},
			}),

			/** Cloudflare usage (Performance page and the dashboard widget): kept for an hour; `refresh` reads again. */
			"cache/usage": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Parameters<typeof mediaApiAccess>[0] & { input?: unknown }) => {
					const { refresh } = parseInput(z.object({ refresh: z.union([z.literal("1"), z.literal(1), z.literal(true)]).optional() }), ctx.input ?? {});
					return usageReport(ctx, Boolean(refresh));
				},
			},

			/**
			 * Clear every cached page now, and the media host's images in the
			 * zone cache when Clean image URLs has a media host.
			 */
			"cache/purge": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "none" },
				handler: async (ctx) => {
					const pages = await purgePageCache();
					if (pages && (await ctx.settings.get<boolean>(WARM_SETTING))) {
						const db = await siteDb();
						if (db) await startWarm(db, "cleared");
					}
					const images = (await siteFeatureOn("images")) ? await purgeMediaHost(ctx) : { purged: false, host: null };
					if (!pages && !images.purged) {
						throw PluginRouteError.badRequest(images.message ?? "This site isn't using Workers Cache, so there are no pages to clear.");
					}
					ctx.log.info("Page cache cleared", { pages, images: images.purged ? images.host : false });
					return { pages, images };
				},
			}),
		},
		tasks: [
			{
				name: WARM_TASK,
				schedule: WARM_SCHEDULE,
				// Performance has no switch: the task always runs and checks the warming switch itself.
				feature: "",
				handler: warmTask,
			},
		],
		// Its page (/performance) is listed by index.ts, always, right below Coywolf Pack.
		adminPages: [],
		widgets: [{ id: "cloudflare-usage", title: "Cloudflare usage", size: "third" }],
		// Clearing the media host's images goes through the Cloudflare API.
		capabilities: ["network:request"],
		allowedHosts: [CLOUDFLARE_API_HOST],
	};
}

let checkedVersion = false;

/**
 * Once per isolate: notice a new deploy (never answers a request). It starts
 * cache warming, and clears the cache first only on sites that share it across
 * versions (PageCacheOptions.crossVersionCache) or after a rollback to a
 * version seen before (see noteNewVersion).
 */
export const pageCacheMiddleware: PackMiddleware = {
	module: "pageCache",
	feature: ALWAYS,
	handle: (_context, env, waitUntil) => {
		if (checkedVersion) return undefined;
		checkedVersion = true;
		const id = versionId(env);
		const db = env.DB as D1Database | undefined;
		if (id && db)
			waitUntil(
				noteNewVersion(db, id, siteOption(VERSION_OPTION), { purge: config.crossVersionCache === true, settleLater: (scope) => settleLater(db, scope) })
					.then(async (deployed) => {
						if (deployed && (await siteSetting<boolean>(WARM_SETTING))) rememberSiteOption(WARM_STATE_OPTION, JSON.stringify(await startWarm(db, "deploy")));
					})
					.catch((error) => console.error("coywolf-pack: page cache version check failed", error)),
			);
		return undefined;
	},
};

/** robots.txt is only ever read at the root; a crawler asking at /news/robots.txt gets a small 404, kept at the edge for a day, instead of a rendered 404 page. */
export const strayRobotsMiddleware: PackMiddleware = {
	module: "pageCache",
	feature: ALWAYS,
	ownsCache: true,
	handle: (context) => {
		const { pathname } = context.url;
		const method = context.request.method;
		if (!pathname.endsWith("/robots.txt") || pathname === "/robots.txt" || (method !== "GET" && method !== "HEAD")) return undefined;
		keepAtEdge(context, 86400, [ROBOTS_TAG]);
		return new Response(method === "HEAD" ? null : "Not found. robots.txt is at the site root.\n", {
			status: 404,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400", "X-Robots-Tag": "noindex" },
		});
	},
};

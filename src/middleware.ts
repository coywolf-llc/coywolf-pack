/**
 * Coywolf Pack site middleware: everything the pack serves outside EmDash's
 * plugin API (redirects, and module files such as sitemaps or downloads).
 * Add it first in the site's src/middleware.ts:
 *
 * ```ts
 * import { sequence } from "astro:middleware";
 * import { coywolfPack } from "@coywolf/emdash/middleware";
 * export const onRequest = sequence(coywolfPack(), yourMiddleware);
 * ```
 *
 * Each module's handler runs only while its feature is on.
 *
 * A GET or HEAD answered after one of the pack's reads failed (it then fails
 * closed: features at their defaults, settings unset, rules absent) is kept out of the edge
 * cache, so a page rendered without its schema, reviews, videos or redirects
 * isn't served for days. See src/core/read-failures.ts and settlePage.
 */
import type { MiddlewareHandler } from "astro";

import { invalidateFeatures, knownFeatures, registerSiteOption, rememberSiteOption, siteFeatures, siteOption, siteSetting, isOn } from "./core/features.js";
import { SETTLE_RETRY_MS, claimSettle, currentGenerationTag, mergeScopes, recordSettingsChange, settleLater } from "./core/generation.js";
import { invalidateRobotsCache } from "./robots/middleware.js";
import { lastReadFailure, noteReadFailure, readFailures } from "./core/read-failures.js";
import { ensurePackStarted } from "./core/ready.js";
import { DEADLINES } from "./core/single-flight.js";
import { injectAdminEnhancements } from "./core/settings-enhance.js";
import type { PackMiddleware } from "./core/module.js";
import { MIDDLEWARE } from "./modules.js";
import { ALWAYS, LIFETIME_DEFAULTS, LIFETIME_SETTINGS } from "./pageCache/pack.js";
import { ROBOTS_EDGE_MAX_AGE } from "./robots/pack.js";
import { type PurgeScope, ROBOTS_TAG, applyPageLifetime, keepAtEdge, isRedirectSave, purgeOutcome, purgeScope, purgesAfter, redirectPagesScope, settlePage, tagGeneration, watchInvalidation } from "./pageCache/lib.js";
import { STOPGAP_HEADER, WARMER_AGENT, WARM_DAILY_SETTING, WARM_SETTING, WARM_STATE_OPTION, scheduleRewarm, startWarm, warmMayHaveWork, warmStep } from "./pageCache/warm.js";
import { prefetchRedirects, serveLateRedirect } from "./redirects/middleware.js";
import { notePackMiddleware } from "./search/live-serve.js";
import { withMediaPreconnect } from "./images/lib.js";
import { pendingMediaRenders, renderedPendingMedia } from "./images/pending.js";
import { refreshMediaHost } from "./images/settings.js";
import { variantsAfterMediaWrite } from "./images/pack.js";

// The warming progress row is read with the feature switches, so requests can skip an idle warmer without a query.
registerSiteOption(WARM_STATE_OPTION);

/**
 * False when the progress row as last read with the switches says there's
 * nothing to warm (the run is done or failed, and no rewarm or daily refresh is due), so
 * the request skips its warming step and that step's read. A run started (or
 * rewarm scheduled) in another isolate is seen on this isolate's next read of
 * the switches (FEATURES_TTL_MS at most); one started here is remembered at
 * once. True when unknown.
 */
function warmingMayHaveWork(daily: boolean): boolean {
	return warmMayHaveWork(siteOption(WARM_STATE_OPTION), Date.now(), daily);
}

/** The daily refresh is on unless turned off (read with the switches, so no extra query). */
async function warmDaily(database?: string): Promise<boolean> {
	return (await siteSetting<boolean>(WARM_DAILY_SETTING, database)) !== false;
}

/** Start warming, and remember the new run in this isolate's copy of the progress row. */
async function startWarming(db: D1Database, reason: string): Promise<void> {
	const state = await startWarm(db, reason);
	rememberSiteOption(WARM_STATE_OPTION, JSON.stringify(state));
}

/** Per isolate: when this isolate last started a warming step (one at a time, at most every few seconds). */
let warmingUntil = 0;
const WARM_EVERY_MS = 5_000;
/**
 * New claims for this long; a step ends by DEADLINES.warmStepMs whatever
 * happens (src/pageCache/warm.ts), which also caps this so its last visits
 * finish in time.
 */
const WARM_BUDGET_MS = 14_000;

export interface CoywolfPackMiddlewareOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
}

// Astro's assets and its image endpoint (`/_image?href=…`, no trailing slash) are never pack pages.
const PASS_THROUGH = /^\/(_astro\/|_image(\/|$))/;
/** EmDash's site settings API (POST saves General, SEO, Social…). */
const EMDASH_SETTINGS_API = "/_emdash/api/settings";
/** Largest redirect save body read for its sources (redirects/import takes up to 2 MiB). */
const REDIRECT_BODY_MAX = 2 * 1024 * 1024 + 64 * 1024;
/** EmDash admin pages (not its API): the pack adds its admin enhancements (step-by-step guides on the plugin Settings page). */
const ADMIN_PAGE = /^\/_emdash\/admin(\/|$)/;
/**
 * EmDash's admin manifest (the sidebar). Read with fresh switches: another isolate's
 * cached read could otherwise keep a module that was just switched on (or off) out of
 * (or in) the sidebar for up to FEATURES_TTL_MS.
 */
const ADMIN_MANIFEST = "/_emdash/api/manifest";

export function coywolfPack(options: CoywolfPackMiddlewareOptions = {}, handlers: PackMiddleware[] = MIDDLEWARE): MiddlewareHandler {
	return async (context, next) => {
		if (PASS_THROUGH.test(context.url.pathname)) return next();
		if (ADMIN_PAGE.test(context.url.pathname) && context.request.method === "GET") return injectAdminEnhancements(await next());
		let workers: { env: Record<string, unknown>; waitUntil?: (p: Promise<unknown>) => void };
		try {
			workers = (await import("cloudflare:workers")) as unknown as typeof workers;
		} catch {
			return next(); // Not running on Cloudflare.
		}
		// Pages rendered in this isolate may now load the live search client as a file (it's served below).
		notePackMiddleware();
		// Reads that fail from here until the response is rendered keep it out of the edge cache.
		const failuresBefore = readFailures();
		const readFailed = () => readFailures() !== failuresBefore;
		// EmDash 1.5+ starts plugins lazily: a page rendered before the pack has started isn't the site's real page.
		if (!(await ensurePackStarted())) noteReadFailure("pack not started");
		const routeCache = (context as unknown as { cache?: Parameters<typeof settlePage>[0] }).cache;
		const env = workers.env;
		const waitUntil = (p: Promise<unknown>) => (workers.waitUntil ? workers.waitUntil(p) : void p);
		// This request's redirect lookup goes to D1 in the same batch as the switches (when they aren't cached).
		// (Skipped when the switches this isolate last read have Redirects off.)
		const known = knownFeatures();
		if (!known || isOn(known, "redirects")) prefetchRedirects(context.url, env, { database: options.database });
		const features = await siteFeatures(options.database, context.url.pathname === ADMIN_MANIFEST);
		// The settings generation this request renders with (read with the switches): its tag goes on
		// whatever this response leaves in the edge cache, so a settings save can clear just those.
		const generation = currentGenerationTag();
		const db = env[options.database ?? "DB"] as D1Database | undefined;
		/**
		 * Clear cached pages, then (for a full purge, when warming is on) start warming them again. A purge
		 * that's refused (the account's purge rate limit) or fails is kept for the settling purge (settleLater),
		 * or, when it was the settling purge, tried again a minute later.
		 */
		const purge = (scope: PurgeScope, settling = false) =>
			purgeOutcome(scope).then(async (outcome) => {
				if (outcome === "refused") {
					if (db) await settleLater(db, scope, Date.now(), settling ? SETTLE_RETRY_MS : undefined);
					return;
				}
				if (outcome === "purged" && "purgeEverything" in scope && db && (await siteSetting<boolean>(WARM_SETTING, options.database))) await startWarming(db, "settings");
			});
		// Page cache: a successful pack admin write (settings, redirects, imports…) can change any page.
		if (purgesAfter(context.request.method, context.url.pathname)) {
			// A redirect save also clears the pages cached at its sources: keep a copy of its body, the route reads
			// the original. Only a body the route would accept (anything else gets the tag purge alone), and it's
			// parsed only once the route has answered with success: EmDash checks who's asking in the route
			// dispatcher, after this middleware, so parsing first let anyone make the Worker parse 2 MiB of JSON.
			const length = Number(context.request.headers.get("content-length"));
			const redirectCopy = isRedirectSave(context.url.pathname) && length > 0 && length <= REDIRECT_BODY_MAX ? context.request.clone() : null;
			const response = await next();
			if (response.status < 400) {
				// One purge for both: the cached redirects (their tag) and the pages cached at the new sources.
				// The settling purge repeats both: an isolate that hasn't seen the edit yet may render (and cache)
				// a source's page instead of redirecting.
				const redirectBody = redirectCopy ? await redirectCopy.json().catch(() => null) : null;
				const scope = mergeScopes(purgeScope(context.url.pathname), redirectPagesScope(redirectBody));
				// This isolate's settings caches go now; other isolates drop theirs when they see the new generation.
				invalidateFeatures();
				const recorded = db
					? recordSettingsChange(db, scope, undefined, { byGeneration: true }).catch((error) => console.error("coywolf-pack: could not record the settings change", error))
					: Promise.resolve();
				if (scope) waitUntil(recorded.then(() => purge(scope)));
				else waitUntil(recorded);
			}
			return response;
		}
		// Content writes: EmDash clears the pages tagged with the collection (home page, archives, many
		// posts). With warming on, a run starts a minute after the last such write (scheduleRewarm).
		const method = context.request.method;
		const invalidated =
			method !== "GET" && method !== "HEAD" && context.url.pathname.startsWith("/_emdash/api/")
				? watchInvalidation((context as unknown as { cache?: Parameters<typeof watchInvalidation>[0] }).cache)
				: null;
		// A save with SEO settings can change /robots.txt; one without them doesn't touch the settings generation. (EmDash's
		// General, SEO and Social pages each send every setting but staging, so all three carry `seo` once it's set.)
		// A staging change (EmDash's Site Status: Go live, or back to staging, sent on its own) changes every page's robots tag.
		// A copy of the body, read only after EmDash has accepted the save (it checks permissions after this middleware).
		const settingsLength = Number(context.request.headers.get("content-length"));
		const settingsCopy = method === "POST" && context.url.pathname === EMDASH_SETTINGS_API && settingsLength > 0 && settingsLength <= 64 * 1024 ? context.request.clone() : null;
		const savedKeys = async (response: Response): Promise<{ seo: boolean; staging: boolean }> => {
			if (!settingsCopy || response.status >= 400) return { seo: false, staging: false };
			return settingsCopy
				.json()
				.then((body: unknown) => (body && typeof body === "object" ? { seo: "seo" in body, staging: "staging" in body } : { seo: false, staging: false }))
				.catch(() => ({ seo: false, staging: false }));
		};
		const afterWrite = async (response: Response): Promise<Response> => {
			const settingsKeys = await savedKeys(response);
			const seoSave = settingsKeys.seo;
			// EmDash's SEO settings change /robots.txt whichever file serves it: the pack's (Robots.txt Rules on) carries
			// their "Disallow AI training" lines, and EmDash's own (Robots.txt Rules off) is built from their robots.txt
			// setting. Both are kept at the edge for a day, and Cloudflare's purge by URL doesn't reach Workers Cache: clear
			// it here now and (settling purge) again once every isolate's robots.txt rules cache has expired.
			// Only the pack's file has a rules cache in this isolate (EmDash reads its settings on every render).
			if (seoSave && response.status < 400 && isOn(features, "robots")) invalidateRobotsCache();
			// Going live (or back to staging) changes every page's robots tag: EmDash renders noindex, nofollow on every page
			// while the site is in staging, and only clears pages tagged with its settings. Clear every cached page (which
			// restarts warming), and again once every isolate has the new settings (settling purge).
			// One scope for both, recorded and purged once: two recordSettingsChange calls at once would each rewrite the
			// row from the same read, and the last one could drop the other's settling purge.
			const settingsScope =
				response.status < 400 ? mergeScopes(seoSave ? { pathPrefixes: ["/robots.txt"] } : null, settingsKeys.staging ? { purgeEverything: true } : null) : null;
			if (settingsScope) {
				waitUntil(
					(db ? recordSettingsChange(db, settingsScope) : Promise.resolve())
						.then(() => purge(settingsScope))
						.catch((error) => console.error("coywolf-pack: could not clear robots.txt or pages after EmDash's settings changed", error)),
				);
			}
			// Stored image sizes follow media deletes, replaced files and WordPress media imports (new uploads: the media:afterUpload hook).
			if (method !== "GET" && method !== "HEAD" && response.status < 400) {
				const work = variantsAfterMediaWrite(method, context.url.pathname, isOn(features, "images"), context.url.origin);
				if (work) waitUntil(work.catch((error) => console.error("coywolf-pack images: stored sizes after a media change failed", error)));
			}
			if (invalidated?.() && response.status < 400 && db) {
				waitUntil(
					(async () => {
						if (!(await siteSetting<boolean>(WARM_SETTING, options.database))) return;
						const state = await scheduleRewarm(db);
						if (state) rememberSiteOption(WARM_STATE_OPTION, JSON.stringify(state));
					})().catch((error) => console.error("coywolf-pack: could not schedule cache warming", error)),
				);
			}
			return response;
		};
		// Settings saved in another isolate reach every isolate within the switches' lifetime; pages
		// rendered meanwhile may have used the old ones, so the first request after that purges once more.
		if (db) {
			waitUntil(
				claimSettle(db)
					.then((scope) => (scope ? purge(scope, true) : undefined))
					.catch((error) => console.error("coywolf-pack: settling purge failed", error)),
			);
		}
		// Page cache lifetimes from Plugins → Performance, on routes the site made cacheable.
		if (context.request.method === "GET") {
			const [maxAgeDays, refreshDays] = await Promise.all([
				siteSetting<number>(LIFETIME_SETTINGS.maxAgeDays, options.database),
				siteSetting<number>(LIFETIME_SETTINGS.refreshDays, options.database),
			]);
			applyPageLifetime(
				(context as unknown as { cache?: Parameters<typeof applyPageLifetime>[0] }).cache,
				maxAgeDays ?? LIFETIME_DEFAULTS.maxAgeDays,
				refreshDays ?? LIFETIME_DEFAULTS.refreshDays,
			);
		}
		// Cache warming rides on real page traffic (see src/pageCache/warm.ts): after this
		// response, claim a small batch of cold pages and visit them in the background.
		if (
			context.request.method === "GET" &&
			!context.url.pathname.startsWith("/_emdash/") &&
			context.request.headers.get("user-agent") !== WARMER_AGENT &&
			Date.now() > warmingUntil &&
			(await siteSetting<boolean>(WARM_SETTING, options.database)) &&
			warmingMayHaveWork(await warmDaily(options.database))
		) {
			const self = env.SELF as { fetch(request: Request): Promise<Response> } | undefined;
			if (db && self) {
				// A step whose finally never runs (its request was cut off) still frees the next one after its hard deadline.
				warmingUntil = Date.now() + DEADLINES.warmStepMs + WARM_EVERY_MS;
				const origin = (context.site ?? context.url).origin;
				waitUntil(
					warmStep(db, self, origin, { budgetMs: WARM_BUDGET_MS, batchSize: 4, daily: await warmDaily(options.database) })
						.catch((error) => console.error("coywolf-pack: cache warming failed", error))
						.finally(() => {
							warmingUntil = Date.now() + WARM_EVERY_MS;
						}),
				);
			}
		}
		for (const handler of handlers) {
			if (handler.feature !== ALWAYS && !isOn(features, handler.feature)) continue;
			try {
				const response = await handler.handle(context, env, waitUntil);
				if (response) {
					// The pack's own responses (robots.txt, files…) set their own Cache-Control.
					// Without this, a site route rule (e.g. on a catch-all page route) would add
					// its edge lifetime to them too. Redirects set their own edge caching.
					if (!handler.ownsCache || readFailed()) routeCache?.set?.(false);
					else tagGeneration(routeCache, generation);
					return response;
				}
			} catch (error) {
				console.error(`coywolf-pack: ${handler.module} middleware failed`, error);
				// The request goes on to the site instead (a page, or EmDash's own robots.txt): not into the edge cache.
				noteReadFailure(`${handler.module} middleware`);
			}
		}
		// The last word on edge caching, once the response has rendered (settlePage): not cached after a
		// failed read; and a page that showed a video's Stream poster or an image's /s/ size while its
		// stored copy is made (src/images/pending.ts) is cached for minutes, not days, so the next render
		// uses the copy. The cache warmer's render of such a page isn't cached; it's told so
		// (STOPGAP_HEADER) and visits again.
		if (method === "GET" || method === "HEAD") {
			const before = pendingMediaRenders();
			let response = await next();
			// A 404 at a path this isolate's redirect index doesn't know: a rule added elsewhere (a slug change) may be there.
			if (response.status === 404 && isOn(features, "redirects")) {
				const late = await serveLateRedirect(context, env, waitUntil).catch(() => undefined);
				if (late) {
					// Drain the discarded 404 render rather than cancel it, as EmDash's own redirect middleware does: a render
					// cancelled midway can leave an isolate-wide read unsettled, which later renders would wait on.
					const discarded = response.body;
					if (discarded) waitUntil(discarded.pipeTo(new WritableStream()).catch(() => undefined));
					response = late;
					tagGeneration(routeCache, generation);
					return response;
				}
			}
			// EmDash's own robots.txt (Robots.txt Rules off): kept at the edge for a day, as the pack's is.
			if (context.url.pathname === "/robots.txt" && response.status === 200 && !readFailed()) keepAtEdge(context, ROBOTS_EDGE_MAX_AGE, [ROBOTS_TAG]);
			// The media host (read with the feature switches: no extra query) for the page's preconnect header.
			await refreshMediaHost().catch(() => undefined);
			const settled = await settlePage(routeCache, response, {
				failed: readFailed,
				stopgap: method === "GET" && isOn(features, "images") ? () => renderedPendingMedia(context.locals, before) : undefined,
				markHeader: context.request.headers.get("user-agent") === WARMER_AGENT ? STOPGAP_HEADER : undefined,
				label: `${method} ${context.url.pathname}`,
				reason: lastReadFailure,
			});
			tagGeneration(routeCache, generation);
			return context.url.pathname.startsWith("/_emdash/") ? settled : withMediaPreconnect(settled);
		}
		return afterWrite(await next());
	};
}

/** Earlier name, kept so existing sites keep working. Serves all pack middleware, not just redirects. */
export const coywolfRedirects = coywolfPack;

/**
 * Insights: reports on one admin page (Coywolf Pack → Insights), each a part
 * with its own switch, all off until turned on.
 *
 * - Edge errors and crawlers (./edge.ts): 404/410 paths, 5xx and crawlers from
 *   Cloudflare's HTTP analytics for the site's zone.
 * - Core Web Vitals (./vitals.ts) from Cloudflare Web Analytics, and the
 *   Web Analytics beacon part, which adds Cloudflare's beacon to every public
 *   page through page:fragments.
 * - Fathom traffic (./fathom.ts) and Google Search Console (./gsc.ts).
 * - Search insights (./search.ts): the searches the site answers, counted per
 *   day by the Search module's routes (noteSearch).
 *
 * Every reading is kept in plugin KV (an hour; Search Console six hours) with
 * a Refresh that reads again. Credentials are encrypted secret settings
 * (src/core/secrets.ts); the Web Analytics token is public and a plain
 * setting. Everything else is in docs/insights.md.
 */
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { CLOUDFLARE_API_HOST } from "../core/cloudflare-api.js";
import { isOn, registerFeatures, registerSiteSetting, rememberSiteSetting, requireFeature, siteSetting, ctxFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { imageCdn } from "../images/lib.js";
import { refreshMediaHost } from "../images/settings.js";
import { readCloudflareToken } from "../pageCache/usage.js";
import { parseInput, workerEnv } from "../shared.js";
import { EDGE_POLICY, edgeReport } from "./edge.js";
import { FATHOM_POLICY, fathomKey, fathomReport } from "./fathom.js";
import { normalizeSiteId } from "./fathom-core.js";
import { GSC_POLICY, googleAccount, searchConsoleReport } from "./gsc.js";
import { normalizeProperty, parseServiceAccount } from "./gsc-core.js";
import { INSIGHTS_FEATURES as F, INSIGHTS_HOSTS, INSIGHTS_SETTINGS as S } from "./keys.js";
import { forgetReport } from "./report-cache.js";
import { SEARCH_COLLECTION } from "./search-core.js";
import { clearSearches, configureSearchInsights, pruneSearches, searchReport } from "./search.js";
import { VITALS_POLICY, vitalsReport } from "./vitals.js";
import { beaconLoader, isBeaconToken } from "./vitals-core.js";

export interface InsightsOptions {
	/** D1 binding of the site database (search insights' counts). Default "DB". */
	database?: string;
}

export const FEATURES = [
	{
		id: F.main,
		label: "Insights",
		description:
			"Reports on one Insights page: what Cloudflare's edge saw (404s, server errors, crawlers), real visitors' Core Web Vitals, Fathom traffic, Google Search Console, and what visitors search for. Each report has its own switch.",
		default: false,
	},
	{
		id: F.edge,
		label: "Edge errors and crawlers",
		description:
			"404 and 410 paths (files, images and the media host too), server errors and requests per crawler, from Cloudflare's analytics for the last 30 days, with Create redirect for each 404. Uses the read-only Cloudflare token with Zone → Analytics → Read added.",
		default: false,
	},
	{
		id: F.vitals,
		label: "Core Web Vitals",
		description: "Real visitors' LCP, INP and CLS from Cloudflare Web Analytics for the last 7 and 30 days, and the slowest pages. Uses the read-only Cloudflare token.",
		default: false,
	},
	{
		id: F.beacon,
		label: "Web Analytics beacon",
		description: "Adds Cloudflare's Web Analytics beacon to every public page, with the site's Web Analytics token. It sets no cookies, and pages that already have the beacon don't get a second one.",
		default: false,
	},
	{
		id: F.fathom,
		label: "Fathom traffic",
		description: "Visitors, pageviews and top pages for the last 7 and 30 days, from Fathom's API with a read-only API key.",
		default: false,
	},
	{
		id: F.searchConsole,
		label: "Google Search Console",
		description: "Clicks, impressions, click-through rate, average position, and the top queries and pages for the last 28 days, through a Google service account.",
		default: false,
	},
	{
		id: F.search,
		label: "Search insights",
		description:
			"Counts what visitors search for on the site (the query text and daily counts only, never who searched; kept 90 days) and shows the top searches and the ones that found nothing. Needs Search on.",
		default: false,
	},
];
registerFeatures(FEATURES);
// Read with the switches (no query of its own on page renders).
registerSiteSetting(S.beaconToken);

export const INSIGHTS_PRUNE_TASK = "insights-search-prune";

const refreshInput = z.object({ refresh: z.union([z.literal("1"), z.literal(1), z.literal(true)]).optional() });
const refreshOf = (input: unknown) => Boolean(parseInput(refreshInput, input ?? {}).refresh);

const settingsInput = z.object({
	fathomSiteId: z.string().max(32).optional(),
	fathomApiKey: z.string().max(500).optional(),
	clearFathomApiKey: z.boolean().optional(),
	searchConsoleProperty: z.string().max(300).optional(),
	googleKey: z.string().max(20_000).optional(),
	clearGoogleKey: z.boolean().optional(),
});

const beaconInput = z.object({ token: z.string().max(100) });
const searchesInput = z.object({ days: z.coerce.number().int().refine((d) => d === 30 || d === 90, "Choose 30 or 90 days.").optional() });

// any: plugin context, as the other modules' plain GET routes take it.
type Ctx = any;

/** The site database, or null outside a Worker or without the binding. */
async function siteDb(database: string): Promise<D1Database | null> {
	const env = await workerEnv().catch(() => null);
	return (env?.[database] as D1Database | undefined) ?? null;
}

/** What the page needs to show each part's settings: never a secret, only whether one is saved. */
async function status(ctx: Ctx) {
	const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
	const [features, beaconToken, fathomSiteId, fathom, property, google, cloudflare] = await Promise.all([
		ctxFeatures(ctx),
		ctx.settings.get(S.beaconToken).catch(() => null) as Promise<string | null>,
		ctx.settings.get(S.fathomSiteId).catch(() => null) as Promise<string | null>,
		fathomKey(ctx),
		ctx.settings.get(S.searchConsoleProperty).catch(() => null) as Promise<string | null>,
		googleAccount(ctx),
		readCloudflareToken(ctx, env),
	]);
	await refreshMediaHost().catch(() => undefined);
	return {
		beaconToken: typeof beaconToken === "string" ? beaconToken : "",
		fathomSiteId: typeof fathomSiteId === "string" ? fathomSiteId : "",
		fathomKeySaved: Boolean(fathom.key),
		fathomKeyUnreadable: fathom.unreadable,
		searchConsoleProperty: typeof property === "string" ? property : "",
		googleEmail: google.account?.client_email ?? null,
		googleKeyUnreadable: google.unreadable,
		cloudflareToken: Boolean(cloudflare.token),
		searchOn: isOn(features, "search"),
		mediaHost: imageCdn(),
	};
}

export function insightsPack(options: InsightsOptions = {}): PackModule {
	const database = options.database ?? "DB";
	configureSearchInsights({ database });
	return {
		id: "insights",
		label: "Insights",
		features: FEATURES,
		routes: {
			"insights/status": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Ctx) => {
					await requireFeature(ctx, F.main);
					return status(ctx);
				},
			},
			"insights/edge": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Ctx) => {
					await requireFeature(ctx, F.edge);
					return edgeReport(ctx, refreshOf(ctx.input));
				},
			},
			"insights/vitals": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Ctx) => {
					await requireFeature(ctx, F.vitals);
					return vitalsReport(ctx, refreshOf(ctx.input));
				},
			},
			"insights/fathom": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Ctx) => {
					await requireFeature(ctx, F.fathom);
					return fathomReport(ctx, refreshOf(ctx.input));
				},
			},
			"insights/search-console": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Ctx) => {
					await requireFeature(ctx, F.searchConsole);
					return searchConsoleReport(ctx, refreshOf(ctx.input));
				},
			},
			"insights/searches": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Ctx) => {
					await requireFeature(ctx, F.search);
					const { days } = parseInput(searchesInput, ctx.input ?? {});
					const db = await siteDb(database);
					if (!db) return { state: "error", message: "Search insights need the site's D1 database (the DB binding)." };
					return { state: "ready", report: await searchReport(db as never, days ?? 30) };
				},
			},
			/**
			 * Fathom and Search Console settings. They change nothing a page shows, so the page cache is left alone
			 * (readOnlyRoute). Secrets are only ever written here, never read back to the page.
			 */
			"insights/settings/save": readOnlyRoute(
				definePluginRoute({
					permission: "plugins:manage",
					methods: ["POST"],
					request: { body: "json" },
					handler: async (ctx) => {
						await requireFeature(ctx, F.main);
						const input = parseInput(settingsInput, ctx.input);
						const errors: string[] = [];
						if (input.fathomSiteId !== undefined) {
							const id = input.fathomSiteId.trim() ? normalizeSiteId(input.fathomSiteId) : "";
							if (id === null) errors.push("A Fathom site ID is letters and digits, like ABCDEFGH (Fathom → the site → Settings, or data-site in the embed code).");
						}
						if (input.searchConsoleProperty !== undefined && input.searchConsoleProperty.trim() && !normalizeProperty(input.searchConsoleProperty)) {
							errors.push("A Search Console property is sc-domain:example.com (a domain property) or a URL prefix such as https://example.com/.");
						}
						let googleKey: string | null = null;
						if (input.googleKey?.trim()) {
							try {
								const account = parseServiceAccount(input.googleKey);
								googleKey = JSON.stringify(account);
							} catch (error) {
								errors.push(error instanceof Error ? error.message : "That service account key couldn't be read.");
							}
						}
						if (errors.length) {
							const { PluginRouteError } = await import("emdash");
							throw PluginRouteError.badRequest(errors.join(" "));
						}
						if (input.fathomSiteId !== undefined) {
							const id = normalizeSiteId(input.fathomSiteId);
							if (id) await ctx.settings.set(S.fathomSiteId, id);
							else await ctx.settings.delete(S.fathomSiteId);
						}
						if (input.clearFathomApiKey) await ctx.settings.delete(S.fathomKey);
						else if (input.fathomApiKey?.trim()) await ctx.settings.set(S.fathomKey, input.fathomApiKey.trim());
						if (input.searchConsoleProperty !== undefined) {
							const property = normalizeProperty(input.searchConsoleProperty);
							if (property) await ctx.settings.set(S.searchConsoleProperty, property);
							else await ctx.settings.delete(S.searchConsoleProperty);
						}
						if (input.clearGoogleKey) await ctx.settings.delete(S.googleKey);
						else if (googleKey) await ctx.settings.set(S.googleKey, googleKey);
						await forgetReport(ctx.kv, FATHOM_POLICY.key);
						await forgetReport(ctx.kv, GSC_POLICY.key);
						ctx.log.info("Insights settings saved", {
							fathomSiteId: input.fathomSiteId !== undefined,
							fathomKeyChanged: Boolean(input.clearFathomApiKey || input.fathomApiKey?.trim()),
							property: input.searchConsoleProperty !== undefined,
							googleKeyChanged: Boolean(input.clearGoogleKey || googleKey),
						});
						return status(ctx);
					},
				}),
			),
			/** The Web Analytics token. Pages change (the beacon), so this save clears the page cache like other admin saves. */
			"insights/beacon/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const { token } = parseInput(beaconInput, ctx.input);
					const value = token.trim().toLowerCase();
					if (value && !isBeaconToken(value)) {
						const { PluginRouteError } = await import("emdash");
						throw PluginRouteError.badRequest("A Web Analytics token is 32 letters and digits: the token value in Cloudflare's snippet, data-cf-beacon='{\"token\": \"…\"}'.");
					}
					if (value) await ctx.settings.set(S.beaconToken, value);
					else await ctx.settings.delete(S.beaconToken);
					rememberSiteSetting(S.beaconToken, value || null);
					await forgetReport(ctx.kv, VITALS_POLICY.key);
					return status(ctx);
				},
			}),
			/** Delete every search count now (the counts change nothing a page shows). */
			"insights/searches/clear": readOnlyRoute(
				definePluginRoute({
					permission: "plugins:manage",
					methods: ["POST"],
					request: { body: "none" },
					handler: async (ctx) => {
						await requireFeature(ctx, F.main);
						const db = await siteDb(database);
						const deleted = db ? await clearSearches(db as never) : 0;
						ctx.log.info("Insights: search counts deleted", { rows: deleted });
						return { deleted };
					},
				}),
			),
		},
		hooks: {
			/** The beacon loader at the end of every public page, while there's a token. */
			"page:fragments": async () => {
				const token = await siteSetting<string>(S.beaconToken, database);
				return isBeaconToken(token) ? { kind: "inline-script" as const, placement: "body:end" as const, key: "insights-beacon", code: beaconLoader(token) } : undefined;
			},
		},
		hookFeature: { "page:fragments": F.beacon },
		tasks: [
			{
				name: INSIGHTS_PRUNE_TASK,
				schedule: "@daily",
				// Always: counts older than 90 days are deleted even after the part (or Insights) is turned off.
				feature: "",
				handler: async (ctx) => {
					const db = await siteDb(database);
					if (!db) return;
					const deleted = await pruneSearches(db as never);
					if (deleted) ctx.log.info("Insights: old search counts deleted", { rows: deleted });
				},
			},
		],
		adminPages: [{ path: "/insights", label: "Insights", icon: "chart-line" }],
		storage: { [SEARCH_COLLECTION]: { indexes: ["d"] } },
		capabilities: ["network:request"],
		allowedHosts: [CLOUDFLARE_API_HOST, ...INSIGHTS_HOSTS],
	};
}

export { EDGE_POLICY };

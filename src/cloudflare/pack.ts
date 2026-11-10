/**
 * Cloudflare Checkup module: a page (Coywolf Pack → Cloudflare Checkup) that
 * reads the site's Cloudflare zone settings and says, row by row, what each
 * does and what to do on a Workers-served EmDash site, with one-click fixes
 * for the clear-cut ones (Speed Brain off, Always Use HTTPS on, TLS 1.2 at
 * least). Off by default. Rows: ./checkup-core.ts; API calls: ./zone.ts;
 * docs/cloudflare-checkup.md.
 */
import { type PluginContext, PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { CLOUDFLARE_API_HOST, CloudflareApiError, contextFetch } from "../core/cloudflare-api.js";
import { UNREADABLE_TOKEN_MESSAGE, cloudflareToken, noTokenMessage, sharedTokenState } from "../core/cloudflare-token.js";
import { ctxFeatures, isOn, registerFeatures, requireFeature } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { TRACKING_STATE_KEY, type TrackingState, trackingWrapperInstalled } from "../core/tracking-params.js";
import { siteOrigin } from "../discovery/urls.js";
import { readCloudflareToken } from "../pageCache/usage.js";
import { parseInput, workerEnv } from "../shared.js";
import { type CheckupZone, FIXES, type FixId, isFixId } from "./checkup-core.js";
import { applyFix, findZone, readCheckup } from "./zone.js";

export const CHECKUP_FEATURE = "cloudflareCheckup";
/** The older setup token (Zone Settings → Edit), declared secret in src/core/secrets.ts; the Cloudflare API token ranks above it. */
export const SETUP_TOKEN_SETTING = "cloudflareSetupToken";
/** The site's zone, found once with the Cloudflare API token and kept: { host, zone }. */
const ZONE_KEY = "state:cloudflare:zone";

const FEATURES = [
	{
		id: CHECKUP_FEATURE,
		label: "Cloudflare Checkup",
		description:
			"A page that reads your Cloudflare zone's settings (Speed Brain, HTTPS, HSTS, Early Hints, features that rewrite pages, bot settings) and says what to change for a site served by a Worker, with one-click fixes for the clear-cut ones.",
		default: false,
	},
];
registerFeatures(FEATURES);

type Ctx = PluginContext & { input?: unknown };

/** The saved setup token: its value, and whether one is saved but can't be decrypted. */
async function savedSetupToken(ctx: Pick<PluginContext, "settings">): Promise<{ token: string | null; unreadable: boolean }> {
	try {
		const value = await ctx.settings.get<string>(SETUP_TOKEN_SETTING);
		return { token: typeof value === "string" && value.trim() ? value.trim() : null, unreadable: false };
	} catch {
		return { token: null, unreadable: true };
	}
}

const siteHost = (ctx: Pick<PluginContext, "site">) => new URL(siteOrigin(ctx)).host;

async function storedZone(ctx: PluginContext, host: string): Promise<CheckupZone | null> {
	const stored = await ctx.kv.get<{ host: string; zone: CheckupZone }>(ZONE_KEY).catch(() => null);
	return stored?.host === host ? stored.zone : null;
}

export function cloudflarePack(): PackModule {
	return {
		id: "cloudflare",
		label: "Cloudflare Checkup",
		features: FEATURES,
		routes: {
			/** The checkup, read from Cloudflare each time the page asks (a GET: it changes nothing). */
			"cloudflare/checkup": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Ctx) => {
					await requireFeature(ctx, CHECKUP_FEATURE);
					const host = siteHost(ctx);
					const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
					const { token, unreadable } = await readCloudflareToken(ctx, env);
					const features = await ctxFeatures(ctx);
					const known = await storedZone(ctx, host);
					// What the Worker wrapper last recorded (src/worker.ts): whether it could call itself, and the cache status.
					const trackingState = await ctx.kv.get<TrackingState>(TRACKING_STATE_KEY).catch(() => null);
					const deps = {
						token,
						fetch: contextFetch(ctx),
						trackingWrapper: trackingWrapperInstalled() !== null,
						trackingState: trackingState && typeof trackingState === "object" ? trackingState : null,
						speculationOn: isOn(features, "speculation"),
						robotsOn: isOn(features, "robots"),
					};
					let result = await readCheckup(host, { ...deps, knownZone: known });
					// The remembered zone stopped working (deleted and added again, moved): look it up again, once.
					if (known && !result.zone && result.problem?.kind !== "bad-token") {
						await ctx.kv.delete(ZONE_KEY).catch(() => undefined);
						result = await readCheckup(host, { ...deps, knownZone: null });
					}
					if (result.zone && !(known && known.id === result.zone.id)) await ctx.kv.set(ZONE_KEY, { host, zone: result.zone }).catch(() => undefined);
					const [setup, fixToken] = await Promise.all([savedSetupToken(ctx), cloudflareToken(ctx, env, "checkupFix")]);
					return {
						...result,
						...(!token && unreadable ? { problem: { kind: "bad-token" as const, message: UNREADABLE_TOKEN_MESSAGE } } : {}),
						setupToken: { saved: Boolean(setup.token), unreadable: setup.unreadable },
						// The fixes use the Cloudflare API token when there is one: the page then hides the setup token.
						...sharedTokenState(fixToken),
						fixes: Object.fromEntries(Object.entries(FIXES).map(([id, f]) => [id, { title: f.title, button: f.button, setting: f.setting, target: f.target, targetLabel: f.targetLabel, effect: f.effect }])),
					};
				},
			},

			/**
			 * Apply one fix with a token typed in (used just this once), else the Cloudflare API token, else the older
			 * saved setup token (src/core/cloudflare-token.ts). Changes one zone setting, only if it isn't already set;
			 * no page changes, so it clears no cache (readOnlyRoute).
			 */
			"cloudflare/fix": readOnlyRoute(
				definePluginRoute({
					permission: "plugins:manage",
					methods: ["POST"],
					request: { body: "json" },
					handler: async (ctx) => {
						await requireFeature(ctx, CHECKUP_FEATURE);
						const input = parseInput(z.object({ fix: z.string().refine(isFixId, "Unknown fix."), token: z.string().max(400).optional() }), ctx.input);
						const fix = input.fix as FixId;
						const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
						const { token, unreadable } = await cloudflareToken(ctx, env, "checkupFix", { typed: input.token });
						if (!token) throw PluginRouteError.badRequest(unreadable ? UNREADABLE_TOKEN_MESSAGE : noTokenMessage("Zone → Read and Zone Settings → Edit, for this site's domain"));
						const host = siteHost(ctx);
						const doFetch = contextFetch(ctx);
						try {
							const zone = (await storedZone(ctx, host)) ?? (await findZone(host, { token, fetch: doFetch }));
							if (!zone) throw PluginRouteError.badRequest(`The Cloudflare API token can't see a zone for ${host}. Add Zone → Read to it, for this site's domain.`);
							const result = await applyFix(fix, zone, { token, fetch: doFetch });
							ctx.log.info("Cloudflare Checkup: fix", { fix, zone: result.zone, setting: result.setting, changed: result.changed, before: String(result.before), after: String(result.after) });
							return result;
						} catch (error) {
							if (error instanceof CloudflareApiError) throw PluginRouteError.badRequest(error.message);
							throw error;
						}
					},
				}),
			),

			/** Save or remove the older setup token (stored encrypted). Shown on no page, so it clears no cache. Kept so a saved one can still be removed here. */
			"cloudflare/token/save": readOnlyRoute(
				definePluginRoute({
					permission: "plugins:manage",
					methods: ["POST"],
					request: { body: "json" },
					handler: async (ctx) => {
						await requireFeature(ctx, CHECKUP_FEATURE);
						const { token, clear } = parseInput(z.object({ token: z.string().trim().max(400).optional(), clear: z.boolean().optional() }), ctx.input);
						if (clear) {
							await ctx.settings.delete(SETUP_TOKEN_SETTING);
							return { saved: false };
						}
						if (!token) throw PluginRouteError.badRequest("Paste the setup token first.");
						await ctx.settings.set(SETUP_TOKEN_SETTING, token);
						return { saved: true };
					},
				}),
			),
		},
		adminPages: [{ path: "/cloudflare", label: "Cloudflare Checkup", icon: "cloud-check" }],
		capabilities: ["network:request"],
		allowedHosts: [CLOUDFLARE_API_HOST],
	};
}

/**
 * Alerts & Digest: email when something needs a look (a failed backup, new
 * broken links, the Cloudflare bill estimate over a threshold, a Coywolf Pack
 * update, a worse content audit), and a weekly summary. Sent through
 * EmDash's email provider (ctx.email). See docs/alerts.md.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, isOn, registerFeatures, requireFeature } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { parseInput } from "../shared.js";
import { MAX_RECIPIENTS, parseRecipients } from "./email.js";
import { ALERT_INFO, ALERT_TYPES, SETTINGS_KEY, checkAlerts, emailConfigured, normalizeAlertsSettings, readAlertsSettings, readState, recipients, sendDigest, sendTest } from "./run.js";

export const ALERTS_FEATURE = "alerts";
export const DIGEST_FEATURE = "alerts.digest";

const FEATURES = [
	{
		id: ALERTS_FEATURE,
		label: "Alerts & Digest",
		description:
			"Email the site's admins (or a list you choose) when a backup fails, links break, the Cloudflare bill estimate passes a threshold, a Coywolf Pack update is out, or the content audit gets worse. At most once a day per issue. Needs an email provider (Settings → Email).",
		default: false,
	},
	{
		id: DIGEST_FEATURE,
		label: "Weekly digest",
		description: "A summary email once a week: backups, links, the content audit, the Cloudflare bill estimate and updates (and Insights, when it's on). Nothing is sent when there's nothing to report.",
		default: false,
	},
];
registerFeatures(FEATURES);

export const ALERTS_CHECK_TASK = "alerts-check";
export const ALERTS_DIGEST_TASK = "alerts-digest";
/** Mondays at 13:00 UTC (morning in the US), away from Sunday 00:00, where @weekly, @daily and @hourly tasks all fall due. */
export const ALERTS_DIGEST_SCHEDULE = "0 13 * * 1";

const settingsInput = z.object({
	recipients: z.enum(["admins", "list"]),
	emails: z.string().max(5_000),
	alerts: z.object(Object.fromEntries(ALERT_TYPES.map((t) => [t, z.boolean()])) as Record<(typeof ALERT_TYPES)[number], z.ZodBoolean>),
	billThreshold: z.number().min(0, "Use 0 or more.").max(1_000_000),
});

export function alertsPack(): PackModule {
	const routes = {
		/** Settings, whether email is set up, who gets alerts, and the last sends. */
		"alerts/status": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, ALERTS_FEATURE);
					const [settings, state, features] = await Promise.all([readAlertsSettings(ctx), readState(ctx), ctxFeatures(ctx)]);
					const to = await recipients(ctx, settings).catch(() => []);
					return {
						settings,
						emailConfigured: emailConfigured(ctx),
						usersReadable: Boolean(ctx.users),
						recipients: to,
						digest: isOn(features, DIGEST_FEATURE),
						alerts: ALERT_TYPES.map((t) => ({ id: t, ...ALERT_INFO[t], available: !ALERT_INFO[t].feature || isOn(features, ALERT_INFO[t].feature) })),
						lastCheckAt: state.lastCheckAt,
						lastDigestAt: state.lastDigestAt,
						log: [...state.log].reverse(),
					};
				},
			}),
		),

		// The routes below change only Alerts' own settings and state, which no page shows: read-only for the page cache.
		"alerts/settings/save": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, ALERTS_FEATURE);
					const input = parseInput(settingsInput, ctx.input);
					const { valid, invalid } = parseRecipients(input.emails);
					if (invalid.length) throw PluginRouteError.badRequest(`These aren't email addresses: ${invalid.slice(0, 5).join(", ")}`);
					if (input.recipients === "list" && !valid.length) throw PluginRouteError.badRequest("Add at least one email address, or send alerts to the site's admins.");
					if (valid.length > MAX_RECIPIENTS) throw PluginRouteError.badRequest(`Alerts go to ${MAX_RECIPIENTS} addresses at most.`);
					const settings = normalizeAlertsSettings({ ...input, emails: valid });
					await ctx.settings.set(SETTINGS_KEY, settings);
					return { settings };
				},
			}),
		),

		/** Send a test email to the recipients. */
		"alerts/test": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, ALERTS_FEATURE);
					return sendTest(ctx as PluginContext);
				},
			}),
		),

		/** Check for alerts now (what the hourly job does), sending any that are due. */
		"alerts/check": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, ALERTS_FEATURE);
					const out = await checkAlerts(ctx as PluginContext);
					return { issues: out.issues, sent: out.sent.map((i) => i.section.title), result: out.result ?? null };
				},
			}),
		),

		/** The weekly digest as it would be sent now (nothing is sent). */
		"alerts/digest/preview": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, ALERTS_FEATURE);
					return sendDigest(ctx as PluginContext, Date.now(), { preview: true });
				},
			}),
		),
	};

	return {
		id: "alerts",
		label: "Alerts & Digest",
		features: FEATURES,
		routes,
		tasks: [
			// Both are scheduled only while their switch is on (cancelled while it's off).
			{ name: ALERTS_CHECK_TASK, schedule: "@hourly", onlyWhileOn: true, handler: async (ctx: PluginContext) => void (await checkAlerts(ctx)) },
			{ name: ALERTS_DIGEST_TASK, schedule: ALERTS_DIGEST_SCHEDULE, feature: DIGEST_FEATURE, onlyWhileOn: true, handler: async (ctx: PluginContext) => void (await sendDigest(ctx)) },
		],
		adminPages: [{ path: "/alerts", label: "Alerts & Digest", icon: "bell" }],
		// users:read lists the site's admins (the default recipients); email:send is ctx.email.
		capabilities: ["email:send", "users:read"],
	};
}

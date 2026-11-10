/**
 * Content Audit: a weekly report of what's missing or wrong in published
 * entries (SEO titles and descriptions, alt text, social images, thin and
 * stale entries, headings, broken internal links), with trends since the
 * last run. See docs/content-audit.md.
 */
import type { PluginContext } from "emdash";
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, isOn, registerFeatures, requireFeature } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { Ops } from "../links/store.js";
import { parseInput } from "../shared.js";
import { CHECKS, CHECK_INFO, type CheckId, normalizeAuditSettings } from "./checks.js";
import { AUDIT_STORAGE, SETTINGS_KEY, auditStep, cancelRun, findings, getReport, getRun, pageCollectionSchemas, readAuditSettings, startRun, trend } from "./run.js";

export const AUDIT_FEATURE = "audit";
const FEATURES = [
	{
		id: AUDIT_FEATURE,
		label: "Content Audit",
		description:
			"A weekly report on published entries: missing or duplicate SEO titles and descriptions, lengths, images without alt text, missing social images, thin and stale entries, heading problems and broken internal links, with the change since the last run.",
		default: false,
	},
];
registerFeatures(FEATURES);

/** Starts a run once a week; the run continues in AUDIT_CONTINUE_TASK's hourly ticks until it's done. */
export const AUDIT_WEEKLY_TASK = "audit-weekly";
export const AUDIT_CONTINUE_TASK = "audit-continue";

/** A scheduled step: statements and wall time (Workers Free allows 50 D1 queries per invocation, shared with other jobs). */
const CRON_OPS = 40;
const CRON_MS = 60_000;
/** An admin step (Run now, while the page is open). */
const REQUEST_OPS = 120;
const REQUEST_MS = 20_000;

async function stepOptions(ctx: PluginContext) {
	const features = await ctxFeatures(ctx);
	return { socialImages: isOn(features, "socialImages"), links: isOn(features, "links") };
}

const settingsInput = z.object({
	collections: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(100),
	off: z.array(z.enum(CHECKS)).max(CHECKS.length),
	titleMin: z.number().int().min(0).max(200),
	titleMax: z.number().int().min(10, "Use at least 10 characters for the longest title.").max(300),
	descriptionMin: z.number().int().min(0).max(500),
	descriptionMax: z.number().int().min(50, "Use at least 50 characters for the longest description.").max(1000),
	thinWords: z.number().int().min(0).max(100_000),
	staleMonths: z.number().int().min(0).max(240),
	titleIsH1: z.boolean(),
});

export function auditPack(): PackModule {
	const routes = {
		/** The latest report, the run in progress, the trends and the settings. */
		"audit/status": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, AUDIT_FEATURE);
					const [report, run, settings, collections, features] = await Promise.all([getReport(ctx), getRun(ctx), readAuditSettings(ctx), pageCollectionSchemas(ctx), ctxFeatures(ctx)]);
					return {
						report,
						trend: report ? trend(report) : {},
						run: { ...run, settings: undefined },
						settings,
						collections: collections.map((c) => ({ slug: c.slug, label: c.label })),
						checks: CHECKS.map((id) => ({ id, ...CHECK_INFO[id] })),
						links: isOn(features, "links"),
						ai: isOn(features, "ai"),
					};
				},
			}),
		),

		/** One check's findings (or all), a page at a time. */
		"audit/findings": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, AUDIT_FEATURE);
					const input = parseInput(
						z.object({ check: z.enum(CHECKS).optional(), offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(10_000).optional() }),
						ctx.input ?? {},
					);
					const all = await findings(ctx, input.check as CheckId | undefined);
					const offset = input.offset ?? 0;
					const limit = input.limit ?? 50;
					return { items: all.slice(offset, offset + limit), total: all.length, offset, limit };
				},
			}),
		),

		// The routes below write only the audit's own state, settings and report, which no page shows: read-only for the page cache.
		/** Start a run now (or continue the one under way) and take one step; the page calls again while it's running. */
		"audit/run": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, AUDIT_FEATURE);
				const { start } = parseInput(z.object({ start: z.boolean().optional() }), ctx.input ?? {});
				if (start) await startRun(ctx, "admin");
				const state = await auditStep(ctx, new Ops(REQUEST_OPS, Date.now() + REQUEST_MS), await stepOptions(ctx));
				return { ...state, settings: undefined };
			},
		})),

		"audit/cancel": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, AUDIT_FEATURE);
				return { ...(await cancelRun(ctx)), settings: undefined };
			},
		})),

		"audit/settings/save": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, AUDIT_FEATURE);
				const input = parseInput(settingsInput, ctx.input);
				const settings = normalizeAuditSettings(input);
				await ctx.settings.set(SETTINGS_KEY, settings);
				return { settings };
			},
		})),
	};

	return {
		id: "audit",
		label: "Content Audit",
		features: FEATURES,
		routes,
		tasks: [
			{
				name: AUDIT_WEEKLY_TASK,
				schedule: "@weekly",
				handler: async (ctx: PluginContext) => {
					await startRun(ctx, "scheduled");
					await auditStep(ctx, new Ops(CRON_OPS, Date.now() + CRON_MS), await stepOptions(ctx));
				},
			},
			{
				name: AUDIT_CONTINUE_TASK,
				schedule: "@hourly",
				// One KV read an hour while no run is under way.
				handler: async (ctx: PluginContext) => {
					if ((await getRun(ctx)).status !== "running") return;
					await auditStep(ctx, new Ops(CRON_OPS, Date.now() + CRON_MS), await stepOptions(ctx));
				},
			},
		],
		adminPages: [{ path: "/content-audit", label: "Content Audit", icon: "list-checks" }],
		storage: AUDIT_STORAGE,
		capabilities: ["content:read", "schema:read"],
	};
}

/**
 * Routes behind the Features admin page: list every feature with its state,
 * and save the switches.
 */
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { parseInput } from "../shared.js";
import { ensureTasks } from "./compose.js";
import { FEATURES_SETTING, type FeatureMap, ctxFeatures, featureCatalog, invalidateFeatures, recordDefaults, withRecordedDefaults } from "./features.js";
import type { PackModule, TaskDef } from "./module.js";

export function featuresRoutes(modules: PackModule[], tasks: TaskDef[]) {
	return {
		"features/list": {
			permission: "plugins:manage" as const,
			// biome-ignore lint/suspicious/noExplicitAny: plugin context.
			handler: async (ctx: any) => {
				await ensureTasks(ctx, tasks);
				// Sites set up before 0.36.0 keep their defaults (src/core/features.ts); a failure leaves them unrecorded, which reads the same.
				await recordDefaults(ctx).catch((error: unknown) => ctx.log.warn("Could not record the feature defaults", { error: String(error) }));
				const state = await ctxFeatures(ctx);
				const known = new Set(featureCatalog().map((f) => f.id));
				return {
					modules: modules.map((m) => ({
						id: m.id,
						label: m.label,
						features: m.features.filter((f) => known.has(f.id)).map((f) => ({ ...f, enabled: state[f.id] ?? false })),
					})),
				};
			},
		},

		"features/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const { features } = parseInput(z.object({ features: z.record(z.string(), z.boolean()) }), ctx.input);
				const known = new Set(featureCatalog().map((f) => f.id));
				// A save before the defaults were recorded records them too (an existing site: it had the pack's switches page).
				const stored = withRecordedDefaults(await ctx.settings.get<FeatureMap>(FEATURES_SETTING), true);
				for (const [id, on] of Object.entries(features)) if (known.has(id)) stored[id] = on;
				await ctx.settings.set(FEATURES_SETTING, stored);
				invalidateFeatures();
				ctx.log.info("Features saved", stored);
				return { features: await ctxFeatures(ctx) };
			},
		}),
	};
}

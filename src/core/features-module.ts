/**
 * Routes behind the Features admin page: list every feature with its state,
 * and save the switches.
 *
 * Each feature comes with `enabled` (whether it runs: a part is off while
 * its module is) and `choice` (its own switch, which a part keeps while its
 * module is off). features/save takes any number of switches at once and
 * stores them in one write; it answers with both maps (`features`, `choices`).
 */
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { parseInput } from "../shared.js";
import { ensureTasks } from "./compose.js";
import { FEATURES_SETTING, type FeatureMap, ctxFeatureState, featureCatalog, invalidateFeatures, recordDefaults, withRecordedDefaults } from "./features.js";
import type { PackModule, TaskDef } from "./module.js";

export function featuresRoutes(modules: PackModule[], tasks: TaskDef[]) {
	return {
		"features/list": {
			permission: "plugins:manage" as const,
			// any: plugin context.
			handler: async (ctx: any) => {
				// Sites set up before 0.36.0 keep their defaults (src/core/features.ts); a failure leaves them unrecorded, which reads the same.
				await recordDefaults(ctx).catch((error: unknown) => ctx.log.warn("Could not record the feature defaults", { error: String(error) }));
				const { features: state, choices } = await ctxFeatureState(ctx);
				// Tasks that run only while their feature is on are scheduled or cancelled to match the switches.
				await ensureTasks(ctx, tasks, state);
				const known = new Set(featureCatalog().map((f) => f.id));
				return {
					modules: modules.map((m) => ({
						id: m.id,
						label: m.label,
						features: m.features
							.filter((f) => known.has(f.id))
							.map((f) => ({ ...f, enabled: state[f.id] ?? false, choice: choices[f.id] ?? false })),
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
				// Record the defaults first if they aren't yet (a fresh install's flag still counts); should that fail,
				// the save records them as an existing site's.
				await recordDefaults(ctx).catch((error: unknown) => ctx.log.warn("Could not record the feature defaults", { error: String(error) }));
				const stored = withRecordedDefaults(await ctx.settings.get<FeatureMap>(FEATURES_SETTING), true);
				// Every switch in the request, in one write. A part sent with its module keeps its own value (a part
				// turned on with its module off stays off until the module is on).
				for (const [id, on] of Object.entries(features)) if (known.has(id)) stored[id] = on;
				await ctx.settings.set(FEATURES_SETTING, stored);
				invalidateFeatures();
				ctx.log.info("Features saved", stored);
				const { features: now, choices } = await ctxFeatureState(ctx);
				// A switch turned on schedules its tasks that run only while on; turned off, cancels them (a task that
				// fires while off cancels itself too). A task that couldn't be scheduled is reported, not just logged.
				const failed = (await ensureTasks(ctx, tasks.filter((t) => t.onlyWhileOn), now)).filter((f) => f.scheduling);
				if (failed.length) {
					const { PluginRouteError } = await import("emdash");
					throw new PluginRouteError(
						"TASK_SCHEDULE_FAILED",
						`The switches are saved, but ${failed.map((f) => f.task).join(", ")} couldn't be scheduled, so ${failed.length === 1 ? "it" : "they"} won't run yet: ${failed[0].error}. Open the Features page again to retry.`,
						500,
					);
				}
				return { features: now, choices };
			},
		}),
	};
}

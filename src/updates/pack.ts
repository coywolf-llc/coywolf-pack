import { definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, isOn, registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { parseInput } from "../shared.js";
import { NPM_HOST, parseVersion } from "./core.js";
import { checkForUpdate, dismissUpdate, updateCardVisible, updateStatus } from "./check.js";

/** Off by default, like every feature: nothing asks npm until the site turns it on. */
const FEATURES = [
	{
		id: "updates",
		label: "Update check",
		description:
			"Once a day, asks npm for the newest version of Coywolf Pack. When there's an update, a card on the dashboard and a notice on the pack's pages show the command to install it. It sends nothing about your site and never updates anything by itself.",
		default: false,
	},
];
registerFeatures(FEATURES);

export const UPDATES_CHECK_TASK = "updates-check";

export function updatesPack(): PackModule {
	return {
		id: "updates",
		label: "Update check",
		features: FEATURES,
		routes: {
			/** The running version and npm's latest (asked at most once a day). */
			"updates/status": {
				permission: "plugins:manage" as const,
				// any: plugin context.
				handler: async (ctx: any) => updateStatus(ctx, isOn(await ctxFeatures(ctx), "updates")),
			},
			/** Hide the notice for this version, for everyone on the site (a newer version shows again). */
			"updates/dismiss": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { version } = parseInput(z.object({ version: z.string().refine((v) => parseVersion(v) !== null, "Not a version") }), ctx.input);
					const state = await dismissUpdate(ctx, version.trim());
					return { dismissed: state.dismissed };
				},
			}),
		},
		tasks: [{ name: UPDATES_CHECK_TASK, schedule: "@daily", handler: async (ctx) => void (await checkForUpdate(ctx)) }],
		// Listed on the dashboard only while an update is waiting (see updateCardVisible).
		widgets: [{ id: "update", title: "Coywolf Pack update", size: "full", when: updateCardVisible }],
		capabilities: ["network:request"],
		allowedHosts: [NPM_HOST],
	};
}

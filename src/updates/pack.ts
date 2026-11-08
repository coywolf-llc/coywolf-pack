import { ctxFeatures, isOn, registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { NPM_HOST } from "./core.js";
import { updateStatus } from "./check.js";

/** Off by default, like every feature: nothing asks npm until the site turns it on. */
const FEATURES = [
	{
		id: "updates",
		label: "Update check",
		description:
			"Once a day, asks npm for the newest version of Coywolf Pack and shows a notice on the pack's pages and the dashboard when there's an update, with the command to install it. It sends nothing about your site and never updates anything by itself.",
		default: false,
	},
];
registerFeatures(FEATURES);

export function updatesPack(): PackModule {
	return {
		id: "updates",
		label: "Update check",
		features: FEATURES,
		routes: {
			/** The running version and npm's latest (checked at most once a day). */
			"updates/status": {
				permission: "plugins:manage" as const,
				// biome-ignore lint/suspicious/noExplicitAny: plugin context.
				handler: async (ctx: any) => updateStatus(ctx, isOn(await ctxFeatures(ctx), "updates")),
			},
		},
		capabilities: ["network:request"],
		allowedHosts: [NPM_HOST],
	};
}

import type { PluginContext } from "emdash";

import { registerFeatures } from "../core/features.js";
import { ROBOTS_TAG, keepAtEdge } from "../pageCache/lib.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { serveRobots } from "./middleware.js";
import { BOT_OVERRIDES_COLLECTION, HISTORY_COLLECTION, type RobotsOptions, robotsModule } from "./module.js";
import { OVERLAY_COLLECTION, RADAR_HOST, syncRadar } from "./radar.js";

const FEATURES = [
	{
		id: "robots",
		label: "Robots.txt Rules",
		description:
			"Manage robots.txt with plain-English rules: block AI training crawlers, keep sections private, with live checks and a URL tester. Turning it on takes over EmDash's robots.txt with equivalent rules; turning it off gives it back.",
		default: false,
	},
	{
		id: "robots.radarSync",
		label: "Weekly crawler list from Cloudflare Radar",
		description: "Refresh the crawler directory every week from the Cloudflare Radar API (needs a Radar API token).",
		default: false,
	},
];
registerFeatures(FEATURES);

export const ROBOTS_TASK = "robots-refresh-bots";

export function robotsPack(options: RobotsOptions): PackModule {
	return {
		id: "robots",
		label: "Robots.txt Rules",
		features: FEATURES,
		routes: robotsModule(options).routes,
		tasks: [
			{
				name: ROBOTS_TASK,
				schedule: "@weekly",
				feature: "robots.radarSync",
				handler: async (ctx: PluginContext) => {
					try {
						await syncRadar(ctx);
					} catch {
						// Already logged and recorded for the admin page.
					}
				},
			},
		],
		adminPages: [{ path: "/robots", label: "Robots.txt", icon: "robot" }],
		storage: { [OVERLAY_COLLECTION]: { indexes: [] }, [HISTORY_COLLECTION]: { indexes: [] }, [BOT_OVERRIDES_COLLECTION]: { indexes: [] } },
		capabilities: ["network:request"],
		allowedHosts: [RADAR_HOST],
	};
}

/** Serves /robots.txt while the feature is on (site database binding "DB"). */
/** robots.txt barely changes: kept at the edge for a day (crawlers ask for it constantly). */
export const ROBOTS_EDGE_MAX_AGE = 86400;

export const robotsMiddleware: PackMiddleware = {
	module: "robots",
	feature: "robots",
	ownsCache: true,
	handle: async (context, env) => {
		const response = await serveRobots(context.url, context.request.method, env);
		if (response) keepAtEdge(context, ROBOTS_EDGE_MAX_AGE, [ROBOTS_TAG]);
		return response;
	},
};

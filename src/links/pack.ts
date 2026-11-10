import type { PluginContext } from "emdash";

import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { INBOUND_FEATURE, inboundRoutes } from "./inbound-routes.js";
import { LINKS_CHECK_TASK, LINKS_SCAN_TASK, linksModule } from "./module.js";
import { STORAGE } from "./store.js";

const FEATURES = [
	{
		id: "links",
		label: "Link Manager",
		description: "An inventory of every link in your content, with bulk replace, unlink, and ignore rules.",
		default: false,
	},
	{
		id: "links.check",
		label: "Scheduled link checking",
		description:
			"Scan content and check links on a schedule (weekly by default; daily or monthly on the Link Manager page) and flag broken, redirected and blocked ones. While off, nothing runs in the background.",
		default: false,
	},
	{
		id: INBOUND_FEATURE,
		label: "Inbound links and orphans",
		description:
			"An Entries view on the Link Manager page: how many entries link to each published entry, and the ones nothing links to (orphans), with related entries to link from. Reads the links Link Manager already indexed; nothing runs in the background.",
		default: false,
	},
];
registerFeatures(FEATURES);

export function linksPack(): PackModule {
	const links = linksModule();
	return {
		id: "links",
		label: "Link Manager",
		features: FEATURES,
		routes: { ...links.routes, ...inboundRoutes() },
		hooks: links.hooks,
		tasks: [
			// Hourly ticks continue a run in progress; a new run starts only when the chosen frequency is due.
			{ name: LINKS_SCAN_TASK, schedule: "@hourly", feature: "links.check", handler: (ctx: PluginContext) => links.scanTask(ctx) },
			{ name: LINKS_CHECK_TASK, schedule: "@hourly", feature: "links.check", handler: (ctx: PluginContext) => links.checkTask(ctx) },
		],
		adminPages: [{ path: "/links", label: "Link Manager", icon: "link" }],
		widgets: [{ id: "links-status", title: "Links", size: "third" }],
		storage: STORAGE,
		capabilities: ["content:read", "content:write", "content:revisions:read", "content:publish", "schema:read"],
	};
}

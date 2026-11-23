import type { PluginContext } from "emdash";

import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { INBOUND_FEATURE, inboundRoutes } from "./inbound-routes.js";
import { joinEntrySplitLinks } from "./join.js";
import { LINKS_CHECK_TASK, LINKS_SCAN_TASK, linksModule } from "./module.js";
import { STORAGE } from "./store.js";

/** The Join split links part: one link saved in pieces is stored as one link (src/links/join.ts). */
export const JOIN_FEATURE = "links.join";

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
	{
		id: JOIN_FEATURE,
		label: "Join split links",
		description:
			"When the editor saves one link in pieces (words next to each other, each linked separately to the same address), the pieces are saved as one link, so hover styles, screen readers and link tooltips see one link. Text and formatting stay as they are. Runs as entries are saved; nothing runs in the background.",
		default: true,
	},
];
registerFeatures(FEATURES);

/**
 * content:beforeSave for Join split links. Only reads the content being saved (no I/O), returns undefined when
 * nothing needs joining, and never throws: on any error the content is saved as it came.
 */
export async function joinSplitLinksBeforeSave(
	event: { content?: unknown; collection?: string; id?: string },
	ctx: Pick<PluginContext, "log">,
): Promise<Record<string, unknown> | undefined> {
	try {
		const content = event?.content;
		if (typeof content !== "object" || content === null || Array.isArray(content)) return undefined;
		const result = joinEntrySplitLinks(content as Record<string, unknown>);
		if (!result) return undefined;
		// Debug: an open editor keeps its split copy and sends it again with every autosave until it's reloaded.
		ctx.log.debug("links: joined split links", { collection: event.collection, id: event.id ?? null, joined: result.joined });
		return result.content;
	} catch (error) {
		try {
			ctx.log.warn("links: couldn't check for split links; saved as it was", { error: String(error) });
		} catch {
			// Logging must not fail the save either.
		}
		return undefined;
	}
}

export function linksPack(): PackModule {
	const links = linksModule();
	return {
		id: "links",
		label: "Link Manager",
		features: FEATURES,
		routes: { ...links.routes, ...inboundRoutes() },
		hooks: { ...links.hooks, "content:beforeSave": joinSplitLinksBeforeSave },
		hookFeature: { "content:beforeSave": JOIN_FEATURE },
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

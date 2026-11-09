import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { CLOUDFLARE_API_HOST } from "../images/cloudflare.js";
import { discoveryMiddleware } from "./middleware.js";
import { type DiscoveryOptions, FEATURE, discoveryModule } from "./module.js";

const FEATURES = [
	{
		id: FEATURE.main,
		label: "Discovery",
		description: "Help search engines, feed readers and AI agents find your content: a Google News sitemap, an RSS feed, llms.txt with Markdown versions of entries, and whether Cloudflare's Crawler Hints tells IndexNow engines about changes.",
		default: false,
	},
	{
		id: FEATURE.news,
		label: "News sitemap",
		description: "A Google News sitemap at /news-sitemap.xml with entries published in the last 48 hours.",
		default: false,
	},
	{
		id: FEATURE.feed,
		label: "RSS feed",
		description: "An RSS feed of the newest entries at /feed/ (and a feed per category), linked from every page so feed readers and apps find it.",
		default: false,
	},
	{
		id: FEATURE.llms,
		label: "llms.txt and Markdown",
		description: "An llms.txt index at /llms.txt and a Markdown version of each entry at its URL + index.html.md.",
		default: false,
	},
];
registerFeatures(FEATURES);

export type { DiscoveryOptions } from "./module.js";

export function discoveryPack(options: DiscoveryOptions): PackModule {
	const { routes, hooks, tasks, retiredTasks } = discoveryModule(options);
	return {
		id: "discovery",
		label: "Discovery",
		features: FEATURES,
		routes,
		hooks,
		tasks,
		retiredTasks,
		// page:fragments adds the feed link and the Markdown link, each checked against its own switch.
		hookFeature: { "page:fragments": FEATURE.main },
		adminPages: [{ path: "/discovery", label: "Discovery", icon: "compass" }],
		capabilities: ["content:read", "schema:read", "bylines:read", "network:request", "hooks.page-fragments:register"],
		// Crawler Hints is read from Cloudflare's API (the read-only token).
		allowedHosts: [CLOUDFLARE_API_HOST],
	};
}

export { discoveryMiddleware };

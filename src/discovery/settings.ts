/**
 * Discovery settings: one plugin setting ("discoverySettings") edited on the
 * Discovery admin page (news sitemap, RSS feed, llms.txt, security.txt).
 */
import { z } from "zod";

import type { SettingsReader } from "../shared.js";
import { FEED_DEFAULT_ITEMS, FEED_MAX_ITEMS } from "./feed.js";
import { DEFAULT_MAX_ENTRIES } from "./llms.js";
import { SECURITY_TXT_DEFAULTS } from "./security-txt.js";

export const SETTINGS_KEY = "discoverySettings";

/**
 * Settings of IndexNow and Bing submission, which 0.35.18 removed (Crawler Hints took their place):
 * the IndexNow key and the Bing Webmaster API key (stored encrypted). Deleted by retireIndexNow
 * (module.ts); nothing reads them. The old `indexnow` part of discoverySettings is dropped by the
 * schema below when it's parsed, and from the stored value at the next save.
 */
export const RETIRED_SETTINGS = ["discoveryIndexnowKey", "discoveryBingApiKey"] as const;

export const settingsSchema = z.object({
	news: z
		.object({
			/** Collections listed in the news sitemap (Coywolf SEO's default: posts only). */
			collections: z.array(z.string().max(100)).max(200).default(["posts"]),
			/** <news:name>; empty = the site title. */
			publicationName: z.string().max(200).default(""),
			/** <news:language>; empty = the site locale. */
			language: z.string().max(20).default(""),
		})
		.default({ collections: ["posts"], publicationName: "", language: "" }),
	feed: z
		.object({
			/** Collections in the feed (default: posts). */
			collections: z.array(z.string().max(100)).max(200).default(["posts"]),
			/** Newest entries listed in each feed. */
			items: z.number().int().min(1).max(FEED_MAX_ITEMS).default(FEED_DEFAULT_ITEMS),
			/** Term feeds at <term archive>/feed/ (WordPress's category feeds). */
			termFeeds: z.boolean().default(true),
		})
		.default({ collections: ["posts"], items: FEED_DEFAULT_ITEMS, termFeeds: true }),
	llms: z
		.object({
			/** Blockquote summary; empty = the site tagline. */
			summary: z.string().max(500).default(""),
			/** Detail paragraph under the summary; empty = the default sentence. */
			intro: z.string().max(4000).default(""),
			/** Collections listed in llms.txt; empty = every routable collection. */
			collections: z.array(z.string().max(100)).max(200).default([]),
			maxEntries: z.number().int().min(1).max(5000).default(DEFAULT_MAX_ENTRIES),
			/** Serve `<entry-url>/index.html.md` and link llms.txt to it. */
			markdown: z.boolean().default(true),
			/** Optional content license noted in the Markdown frontmatter. */
			license: z.string().max(200).default(""),
		})
		.default({ summary: "", intro: "", collections: [], maxEntries: DEFAULT_MAX_ENTRIES, markdown: true, license: "" }),
	/**
	 * security.txt (./security-txt.ts). Plain strings here: an entry that isn't valid is refused when saving
	 * (securityTxtProblems) and skipped when serving, so a bad value can't reset the other Discovery settings.
	 */
	securityTxt: z
		.object({
			/** Email addresses or https:// / tel: URIs, most preferred first. */
			contacts: z.array(z.string().max(300)).max(10).default([]),
			policy: z.string().max(500).default(""),
			languages: z.string().max(100).default(SECURITY_TXT_DEFAULTS.languages),
			encryption: z.string().max(500).default(""),
			acknowledgments: z.string().max(500).default(""),
			hiring: z.string().max(500).default(""),
		})
		.default(() => ({ ...SECURITY_TXT_DEFAULTS, contacts: [] })),
});

export type DiscoverySettings = z.infer<typeof settingsSchema>;

export async function loadSettings(ctx: SettingsReader): Promise<DiscoverySettings> {
	const stored = await ctx.settings.get<unknown>(SETTINGS_KEY);
	const parsed = settingsSchema.safeParse(stored ?? {});
	return parsed.success ? parsed.data : settingsSchema.parse({});
}

/** Whether a collection is selected, where an empty selection means "all". */
export function selected(collections: string[], slug: string): boolean {
	return collections.length === 0 || collections.includes(slug);
}

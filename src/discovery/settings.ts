/**
 * Discovery settings: one plugin setting ("discoverySettings") edited on the
 * Discovery admin page, plus the IndexNow key ("discoveryIndexnowKey").
 */
import { z } from "zod";

import type { SettingsReader } from "../shared.js";
import { FEED_DEFAULT_ITEMS, FEED_MAX_ITEMS } from "./feed.js";
import { DEFAULT_MAX_ENTRIES } from "./llms.js";
import { INDEXNOW_ENDPOINTS, KEY_PATTERN, generateKey } from "./indexnow.js";

export const SETTINGS_KEY = "discoverySettings";
export const INDEXNOW_KEY_SETTING = "discoveryIndexnowKey";

const endpoints = Object.keys(INDEXNOW_ENDPOINTS) as [keyof typeof INDEXNOW_ENDPOINTS, ...(keyof typeof INDEXNOW_ENDPOINTS)[]];

export const settingsSchema = z.object({
	indexnow: z
		.object({
			endpoint: z.enum(endpoints).default("api.indexnow.org"),
			/** Collections whose changes are submitted; empty = every routable collection. */
			collections: z.array(z.string().max(100)).max(200).default([]),
		})
		.default({ endpoint: "api.indexnow.org", collections: [] }),
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
});

export type DiscoverySettings = z.infer<typeof settingsSchema>;

export async function loadSettings(ctx: SettingsReader): Promise<DiscoverySettings> {
	const stored = await ctx.settings.get<unknown>(SETTINGS_KEY);
	const parsed = settingsSchema.safeParse(stored ?? {});
	return parsed.success ? parsed.data : settingsSchema.parse({});
}

interface SettingsWriter extends SettingsReader {
	settings: SettingsReader["settings"] & { set(key: string, value: unknown): Promise<void> };
}

/** The IndexNow key, generating and storing one the first time. */
export async function ensureIndexNowKey(ctx: SettingsWriter): Promise<string> {
	const existing = await ctx.settings.get<string>(INDEXNOW_KEY_SETTING);
	if (typeof existing === "string" && KEY_PATTERN.test(existing)) return existing;
	const key = generateKey();
	await ctx.settings.set(INDEXNOW_KEY_SETTING, key);
	return key;
}

export async function readIndexNowKey(ctx: SettingsReader): Promise<string | null> {
	const key = await ctx.settings.get<string>(INDEXNOW_KEY_SETTING);
	return typeof key === "string" && KEY_PATTERN.test(key) ? key : null;
}

/** Whether a collection is selected, where an empty selection means "all". */
export function selected(collections: string[], slug: string): boolean {
	return collections.length === 0 || collections.includes(slug);
}

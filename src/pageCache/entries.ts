/**
 * Clear the cached pages of a few entries (Social Images after a new image,
 * glossary.io links after keepDates puts an entry's updated date back).
 */
import type { PluginContext } from "emdash";

import { createEntryUrlResolver } from "../core/content-url.js";
import { type PurgeScope, purgePageCache } from "./lib.js";

export interface EntryPagesOptions {
	/** Who's asking, for the log line when it fails. */
	label: string;
	/**
	 * Also clear by the entries' ids: EmDash tags every cached page that renders
	 * an entry with its id, so this reaches the home page and listings built from
	 * it. An entry whose page is the home page ("/") then goes by its tag alone
	 * (a "/" prefix would be every page).
	 */
	tags?: boolean;
}

/** Purge the pages of these entries (at most 100 paths, Cloudflare's limit per purge). Never throws. */
export async function purgeEntryPages(ctx: PluginContext, entries: Array<{ collection: string; id: string; slug: string | null }>, options: EntryPagesOptions): Promise<void> {
	if (!entries.length) return;
	try {
		const resolver = createEntryUrlResolver(ctx);
		const paths: string[] = [];
		const byCollection = new Map<string, Array<{ id: string; slug: string | null }>>();
		for (const e of entries) byCollection.set(e.collection, [...(byCollection.get(e.collection) ?? []), e]);
		for (const [collection, list] of byCollection) for (const path of (await resolver.urls(collection, list.map((e) => ({ ...e, status: "published" })))).values()) if (path) paths.push(path);
		if (options.tags) {
			const tags = [...new Set(entries.map((e) => e.id))].slice(0, 50);
			const prefixes = paths.filter((p) => p !== "/").slice(0, 100 - tags.length);
			const scope: PurgeScope = prefixes.length ? { pathPrefixes: prefixes, tags } : { tags };
			await purgePageCache(scope);
		} else if (paths.length) await purgePageCache({ pathPrefixes: paths.slice(0, 100) });
	} catch (error) {
		ctx.log.warn(`${options.label}: couldn't clear the pages' cached copies`, { error: String(error) });
	}
}

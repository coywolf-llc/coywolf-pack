/**
 * Public URLs of content entries for discovery (llms.txt, the news sitemap,
 * the RSS feed), from the pack-wide resolver in core/content-url.ts: the site's
 * `urls` overrides when configured, otherwise EmDash's own resolution
 * (getPublicUrl, verified once per collection and locale against local
 * url_pattern interpolation so long lists don't cost two queries an entry).
 */
import type { CollectionSchemaInfo, PluginContentItem, PluginContext } from "emdash";

import { absoluteUrl, createEntryUrlResolver } from "../core/content-url.js";

export function siteOrigin(ctx: Pick<PluginContext, "site">): string {
	return ctx.site.url.replace(/\/+$/, "");
}

export interface UrlResolver {
	/** Absolute URLs of published entries, keyed by id (null: none). Terms are read in one batch. */
	urls(collection: CollectionSchemaInfo, items: PluginContentItem[]): Promise<Map<string, string | null>>;
}

/** One resolver per build (it remembers collection routes and verdicts). */
export function createUrlResolver(ctx: PluginContext): UrlResolver {
	const resolver = createEntryUrlResolver(ctx);
	const origin = siteOrigin(ctx);
	return {
		async urls(collection, items) {
			const out = new Map<string, string | null>();
			const usable = items.filter((item) => collection.routable && item.status === "published" && item.slug);
			for (const item of items) out.set(item.id, null);
			const paths = await resolver.urls(collection.slug, usable);
			for (const [id, path] of paths) out.set(id, path ? absoluteUrl(path, origin) : null);
			return out;
		},
	};
}

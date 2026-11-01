/**
 * Builds the RSS feeds (inside the plugin context): the site feed at /feed/
 * and term feeds at <term archive>/feed/ (see ./feed.ts). Entries come from
 * EmDash's content API; a term feed's entries are found with one D1 query on
 * EmDash's taxonomy tables (the content API can't filter by term). URLs come
 * from the pack-wide resolver, so they match the sitemaps.
 */
import { type CollectionSchemaInfo, type PluginContentItem, type PluginContext, getSiteSetting } from "emdash";

import { COLLECTION_SLUG, ancestorTrail, expandPattern, hostDefaultLocale, primaryTerms, termParentMaps, urlOverride } from "../core/content-url.js";
import { siteName } from "../core/site.js";
import { workerEnv } from "../shared.js";
import { entryTitle, pickCollections } from "./build.js";
import { FEED_PATH, FEED_TAG, type FeedItem, type TermFeedRoute, buildRss, feedDate, parseFeedPath, termFeedRoute, termSegments, withDescendants } from "./feed.js";
import type { DiscoverySettings } from "./settings.js";
import { createUrlResolver, siteOrigin } from "./urls.js";

export interface FeedDocument {
	body: string;
	count: number;
	/** Edge cache tags: EmDash clears a collection's tag (its slug) on every live-content write, and a taxonomy's on term edits. */
	tags: string[];
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

async function db(binding: string): Promise<D1Database | null> {
	try {
		return ((await workerEnv())[binding] as D1Database | undefined) ?? null;
	} catch {
		return null;
	}
}

interface Term {
	slug: string;
	label: string;
	/** Archive path, e.g. /news/seo/ */
	path: string;
	taxonomy: string;
}

/** The collection and term a term feed path asks for, or null. */
async function findTerm(d1: D1Database, collections: CollectionSchemaInfo[], segments: string[]): Promise<{ collection: CollectionSchemaInfo; route: TermFeedRoute; term: Term; groups: string[] } | null> {
	for (const collection of collections) {
		const override = urlOverride(collection.slug);
		const route = termFeedRoute(override ? expandPattern(override) : null);
		if (!route) continue;
		const path = termSegments(segments, route);
		if (!path) continue;
		const slug = path[path.length - 1];
		const parents = (await termParentMaps(d1, [route.taxonomy])).get(route.taxonomy) ?? new Map<string, string>();
		// {termpath}: the URL must be the term's full trail (as its entries' URLs are); {term}: just the slug.
		if (route.hierarchical && ancestorTrail(slug, parents).join("/") !== path.join("/")) continue;
		const slugs = withDescendants(slug, parents);
		const defaultLocale = await hostDefaultLocale();
		const { results } = await d1
			.prepare(`SELECT slug, label, locale, translation_group FROM taxonomies WHERE name = ? AND slug IN (${slugs.map(() => "?").join(",")})`)
			.bind(route.taxonomy, ...slugs)
			.all<{ slug: string; label: string | null; locale: string | null; translation_group: string | null }>();
		const own = results.filter((r) => r.slug === slug);
		if (!own.length) continue;
		const label = (own.find((r) => r.locale === defaultLocale) ?? own[0]).label || slug;
		const groups = [...new Set(results.map((r) => r.translation_group).filter((g): g is string => Boolean(g)))];
		return { collection, route, groups, term: { slug, label, taxonomy: route.taxonomy, path: `${route.prefix}/${path.join("/")}/` } };
	}
	return null;
}

/** Ids of a term's published, indexable entries (default locale), newest first. */
async function termEntryIds(d1: D1Database, collection: string, groups: string[], limit: number): Promise<string[]> {
	if (!groups.length || !COLLECTION_SLUG.test(collection)) return [];
	const { results } = await d1
		.prepare(
			`SELECT content.id AS id FROM "ec_${collection}" AS content
			LEFT JOIN _emdash_seo AS seo ON seo.collection = ? AND seo.content_id = content.id
			WHERE content.status = 'published' AND content.deleted_at IS NULL AND content.published_at IS NOT NULL
				AND coalesce(seo.seo_no_index, 0) = 0
				AND (content.locale IS NULL OR content.locale = ?)
				AND content.translation_group IN (SELECT entry_id FROM content_taxonomies WHERE collection = ? AND taxonomy_id IN (${groups.map(() => "?").join(",")}))
			ORDER BY content.published_at DESC LIMIT ?`,
		)
		.bind(collection, await hostDefaultLocale(), collection, ...groups, limit)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** The newest `limit` published, indexable entries (default locale) of a collection: a page of 100 at a time (the content API's most). */
async function newest(ctx: PluginContext, collection: string, limit: number): Promise<PluginContentItem[]> {
	if (!ctx.content) return [];
	const locale = await hostDefaultLocale();
	const out: PluginContentItem[] = [];
	let cursor: string | undefined;
	for (let pages = 0; pages < 10 && out.length < limit; pages++) {
		const page = await ctx.content.list(collection, { limit: 100, cursor, orderBy: { publishedAt: "desc" }, where: { status: "published" } });
		for (const item of page.items) {
			if (item.publishedAt && !item.seo?.noIndex && (!item.locale || item.locale === locale)) out.push(item);
			if (out.length >= limit) break;
		}
		cursor = page.hasMore ? page.cursor : undefined;
		if (!cursor) break;
	}
	return out;
}

/** Labels of terms by slug (default locale first). */
async function termLabels(d1: D1Database | null, taxonomy: string, slugs: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (!d1 || !slugs.length) return out;
	try {
		const defaultLocale = await hostDefaultLocale();
		const { results } = await d1
			.prepare(`SELECT slug, label, locale FROM taxonomies WHERE name = ? AND slug IN (${slugs.map(() => "?").join(",")})`)
			.bind(taxonomy, ...slugs)
			.all<{ slug: string; label: string | null; locale: string | null }>();
		for (const r of results) if (r.label && (!out.has(r.slug) || r.locale === defaultLocale)) out.set(r.slug, r.label);
	} catch {
		// No taxonomy table: items go out without a category.
	}
	return out;
}

/** The site logo (or favicon) as the channel image, when it's a GIF, JPEG or PNG (all RSS allows). */
async function channelImage(origin: string): Promise<string | null> {
	for (const key of ["logo", "favicon"] as const) {
		const ref = (await getSiteSetting(key).catch(() => undefined)) as { url?: string; contentType?: string } | undefined;
		if (ref?.url && /^image\/(png|jpeg|gif)$/.test(ref.contentType ?? "")) return new URL(ref.url, `${origin}/`).href;
	}
	return null;
}

/** The feed for a path (/feed/ or <term archive>/feed/), or null when there's none at that path. */
export async function buildFeed(ctx: PluginContext, settings: DiscoverySettings, pathname: string, database = "DB"): Promise<FeedDocument | null> {
	const segments = parseFeedPath(pathname);
	if (!segments) return null;
	const { collections: chosen, items: limit } = settings.feed;
	// An empty selection lists nothing (like the news sitemap).
	const collections = chosen.length ? await pickCollections(ctx, chosen) : [];
	if (!collections.length) return null;
	const origin = siteOrigin(ctx);
	const d1 = await db(database);

	let entries: Array<{ collection: CollectionSchemaInfo; item: PluginContentItem }> = [];
	let term: Term | null = null;
	if (segments.length === 0) {
		for (const collection of collections) for (const item of await newest(ctx, collection.slug, limit)) entries.push({ collection, item });
	} else {
		if (!settings.feed.termFeeds || !d1) return null;
		const found = await findTerm(d1, collections, segments);
		if (!found) return null;
		term = found.term;
		const ids = await termEntryIds(d1, found.collection.slug, found.groups, limit);
		const items = await Promise.all(ids.map((id) => ctx.content?.get(found.collection.slug, id) ?? null));
		entries = items.filter((item): item is PluginContentItem => Boolean(item && item.status === "published" && item.publishedAt)).map((item) => ({ collection: found.collection, item }));
	}

	entries = entries
		.filter(({ item }) => !item.seo?.noIndex)
		.sort((a, b) => (feedDate(b.item.publishedAt)?.getTime() ?? 0) - (feedDate(a.item.publishedAt)?.getTime() ?? 0));

	const resolver = createUrlResolver(ctx);
	const items: Array<FeedItem & { changed: string }> = [];
	for (const collection of collections) {
		const own = entries.filter((e) => e.collection.slug === collection.slug).map((e) => e.item);
		if (!own.length) continue;
		const urls = await resolver.urls(collection, own);
		const taxonomy = term?.taxonomy ?? termFeedRoute(urlOverride(collection.slug) ? expandPattern(urlOverride(collection.slug)!) : null)?.taxonomy ?? "category";
		const primary = await primaryTerms(ctx, collection.slug, own.map((i) => i.id), [taxonomy]).catch(() => new Map<string, Record<string, string>>());
		const labels = await termLabels(d1, taxonomy, [...new Set([...primary.values()].map((t) => t[taxonomy]).filter(Boolean))]);
		const bylines = new Map<string, string>();
		if (ctx.bylines) {
			for (let i = 0; i < own.length; i += 100) {
				const credits = await ctx.bylines.getEntriesBylines(collection.slug, own.slice(i, i + 100).map((x) => x.id)).catch(() => []);
				for (const c of credits) {
					const name = c.bylines[0]?.byline.displayName;
					if (name) bylines.set(c.entryId, name);
				}
			}
		}
		for (const item of own) {
			const url = urls.get(item.id);
			if (!url || !item.publishedAt) continue;
			const slug = primary.get(item.id)?.[taxonomy];
			items.push({
				title: entryTitle(collection, item),
				url,
				publishedAt: item.publishedAt,
				creator: bylines.get(item.id) ?? null,
				category: slug ? (labels.get(slug) ?? null) : null,
				description: str(item.data.excerpt).trim() || str(item.seo?.description).trim(),
				changed: item.updatedAt || item.publishedAt,
			});
		}
	}
	items.sort((a, b) => (feedDate(b.publishedAt)?.getTime() ?? 0) - (feedDate(a.publishedAt)?.getTime() ?? 0));
	const listed = items.slice(0, limit);
	const newestChange = listed
		.map((i) => feedDate(i.changed))
		.filter((d): d is Date => Boolean(d))
		.sort((a, b) => b.getTime() - a.getTime())[0];

	const name = (await siteName(ctx)) || new URL(origin).host;
	const tagline = str(await getSiteSetting("tagline").catch(() => undefined)).trim();
	const image = await channelImage(origin);
	const body = buildRss({
		title: term ? `${term.label} Archives - ${name}` : name,
		link: `${origin}${term ? term.path : "/"}`,
		selfUrl: `${origin}${term ? `${term.path}feed/` : FEED_PATH}`,
		description: tagline,
		language: ctx.site.locale,
		lastBuildDate: (newestChange ?? feedDate(listed[0]?.publishedAt))?.toISOString() ?? null,
		image: image ? { url: image, title: name, link: `${origin}/` } : null,
		items: listed.map(({ changed: _, ...item }) => item),
	});
	const taxonomies = new Set(collections.map((c) => termFeedRoute(urlOverride(c.slug) ? expandPattern(urlOverride(c.slug)!) : null)?.taxonomy ?? "category"));
	return { body, count: listed.length, tags: [FEED_TAG, ...collections.map((c) => c.slug), ...[...taxonomies].map((t) => `emdash:taxonomy:${t}`)] };
}

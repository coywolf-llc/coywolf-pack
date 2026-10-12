/**
 * Review schema for a rendered page: the `coywolf-review` blocks in the
 * entry, plus any reviews the theme passes as `page.coywolf.reviews` (legacy
 * WordPress markers). Schema & Social folds them into its @graph
 * (attachPageReviews); with the graph off, the page:metadata hook here prints
 * standalone JSON-LD instead.
 */
import type { PageMetadataContribution, PageMetadataEvent, PluginContext } from "emdash";

import { cachedCtxFeatures, isOn } from "../core/features.js";
import { noteReadFailure, readFailures } from "../core/read-failures.js";
import { siteName } from "../core/site.js";
import { originOf, pageUrl } from "../schema/graph.js";
import { BLOCK_TYPE, type Node, type Review, attachReviews, findReviewBlocks, normalizeReview, reviewDocuments } from "./lib.js";

/** Text every stored review block contains: entry columns without it can't hold one (and aren't parsed). */
export const REVIEW_MARKER = `"${BLOCK_TYPE}"`;

type Page = PageMetadataEvent["page"];

const TTL_MS = 5 * 60_000;
const MAX_CACHED = 300;
/** Per-isolate cache of each entry's review blocks, keyed by entry and its modified time. */
const memo = new Map<string, { at: number; stamp: string; reviews: Review[] }>();

function themeReviews(page: Page): Review[] {
	const themed = (page as Page & { coywolf?: { reviews?: unknown } }).coywolf?.reviews;
	if (!Array.isArray(themed)) return [];
	return themed
		.slice(0, 20)
		.map(normalizeReview)
		.filter((r): r is Review => r !== null);
}

const reviewsIn = (data: unknown): Review[] =>
	findReviewBlocks(data ?? null)
		.map(normalizeReview)
		.filter((r): r is Review => r !== null);

function memoHit(page: Page): Review[] | undefined {
	if (!page.content) return undefined;
	const hit = memo.get(`${page.content.collection}:${page.content.id}`);
	return hit && hit.stamp === (page.articleMeta?.modifiedTime ?? "") && Date.now() - hit.at < TTL_MS ? hit.reviews : undefined;
}

/** Whether finding the page's review blocks needs the entry's data (no recent copy in this isolate). */
export function needsEntryData(page: Page): boolean {
	return Boolean(page.content) && memoHit(page) === undefined;
}

/**
 * Where the entry's data comes from: the entry itself (the theme passed it;
 * nothing is read), or a function that reads it (Schema & Social's batched
 * read). Without one, it's read through the plugin context.
 */
export type EntryDataSource = Record<string, unknown> | (() => Promise<Record<string, unknown> | null | undefined>);

async function blockReviews(ctx: PluginContext, page: Page, source?: EntryDataSource): Promise<Review[]> {
	if (!page.content) return [];
	if (source && typeof source === "object") return reviewsIn(source);
	const hit = memoHit(page);
	if (hit) return hit;
	let data: unknown;
	const failures = readFailures();
	if (typeof source === "function") data = await source();
	else if (ctx.content) data = (await ctx.content.get(page.content.collection, page.content.id))?.data;
	else return [];
	const reviews = reviewsIn(data);
	// Entry data that couldn't be read (null, its failure noted) isn't remembered as "no reviews".
	if (readFailures() !== failures) return reviews;
	if (memo.size >= MAX_CACHED) memo.delete(memo.keys().next().value as string);
	memo.set(`${page.content.collection}:${page.content.id}`, { at: Date.now(), stamp: page.articleMeta?.modifiedTime ?? "", reviews });
	return reviews;
}

/** The page's reviews: blocks first, then the theme's. */
export async function pageReviews(ctx: PluginContext, page: Page, source?: EntryDataSource): Promise<Review[]> {
	const [blocks, themed] = [await blockReviews(ctx, page, source), themeReviews(page)];
	return [...blocks, ...themed];
}

/** Fold the page's reviews into Schema & Social's graph. Errors are logged, never fatal. */
export async function attachPageReviews(ctx: PluginContext, page: Page, graph: { "@graph": Node[] }, origin: string): Promise<void> {
	(await pageReviewsStep(ctx, page, origin))(graph);
}

/**
 * Load the page's reviews now and return the step that folds them into the
 * graph later, so Schema & Social can load them alongside its other reads.
 * Errors are logged, never fatal.
 */
export async function pageReviewsStep(ctx: PluginContext, page: Page, origin: string, source?: EntryDataSource): Promise<(graph: { "@graph": Node[] }) => void> {
	const warn = (error: unknown) => ctx.log.warn("reviews: could not attach review schema", { error: String(error) });
	let reviews: Review[];
	try {
		reviews = await pageReviews(ctx, page, source);
	} catch (error) {
		warn(error);
		noteReadFailure("reviews");
		return () => {};
	}
	return (graph) => {
		try {
			attachReviews(graph, reviews, { origin });
		} catch (error) {
			warn(error);
		}
	};
}

/** page:metadata (reviews.schema): standalone JSON-LD, only when Schema & Social's graph is off. */
export async function reviewsMetadata(event: PageMetadataEvent, ctx: PluginContext): Promise<PageMetadataContribution[] | null> {
	if (isOn(await cachedCtxFeatures(ctx), "schema.graph")) return null;
	const page = event.page;
	const entry = (page as Page & { coywolf?: { entry?: { data?: unknown } } }).coywolf?.entry;
	const data = entry?.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : undefined;
	const reviews = await pageReviews(ctx, page, data && (typeof data.id !== "string" || data.id === page.content?.id) ? data : undefined);
	if (!reviews.length) return null;
	const origin = originOf(page.siteUrl || ctx.site.url || page.url);
	const docs = reviewDocuments(reviews, {
		pageUrl: pageUrl(page),
		origin,
		siteName: page.siteName || (await siteName(ctx)),
		authorName: page.articleMeta?.author,
		datePublished: page.articleMeta?.publishedTime,
	});
	return docs.map((graph, i) => ({ kind: "jsonld" as const, id: `coywolf-review-${i + 1}`, graph }));
}

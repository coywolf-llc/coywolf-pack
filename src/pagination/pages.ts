/**
 * Which page links a pagination nav shows, at each of its three widths. The
 * server renders the union of the levels' links in page order, each marked
 * with the levels it shows at, and the component's container queries pick
 * one level (src/pagination/css.ts):
 *
 * | Level | Shows                              | Container width            |
 * | ----- | ---------------------------------- | -------------------------- |
 * | 0     | arrows, first, current, last       | under 27rem, and without container queries |
 * | 1     | arrows, first, current ± 1, last   | 27rem to under 39rem       |
 * | 2     | first, current ± 2, last           | 39rem and wider            |
 *
 * At levels 1 and 2 a gap that would hide exactly one page shows that page
 * instead; at level 0 a gap always shows (3 of 20 reads "1 … 3 … 20"). With an
 * unknown last page (search, author archives) each level drops the last page
 * and its gap.
 *
 * Long numbers get fewer links, so the line never overflows: the widest
 * number a nav shows is its last page, or with an unknown last page the
 * furthest page it knows of (the next one, or the current one).
 * - Up to 999: the table above.
 * - 1,000 to 9,999 (four digits): levels 0 and 1 both show the level 0 links,
 *   and level 2 shows current ± 1 (five four-digit links and the Previous and
 *   Next text don't fit 32rem).
 * - From 10,000 (five digits): every width shows the level 0 links.
 *
 * Imports only ./urls.ts (no imports of its own), so `node --test` can load it.
 */
import { MAX_PAGE } from "./urls.js";

export type PageLevel = 0 | 1 | 2;

export const PAGE_LEVELS: readonly PageLevel[] = [0, 1, 2];

/** A page link, or a gap ("…") keyed by the page it follows. `levels` are the widths it shows at. */
export type PageItem = { type: "page"; page: number; current: boolean; levels: PageLevel[] } | { type: "gap"; after: number; levels: PageLevel[] };

/** From this page number on (four digits), levels 0 and 1 show the level 0 links and level 2 shows current ± 1. */
export const NARROWER_FROM = 1_000;

/** From this page number on (five digits), every width shows the level 0 links. */
export const LEVEL_ZERO_FROM = 10_000;

/** How many pages either side of the current one each level shows, for the widest page number the nav shows. */
function radii(widest: number): Record<PageLevel, number> {
	if (widest >= LEVEL_ZERO_FROM) return { 0: 0, 1: 0, 2: 0 };
	if (widest >= NARROWER_FROM) return { 0: 0, 1: 0, 2: 1 };
	return { 0: 0, 1: 1, 2: 2 };
}

/** The pages and gaps one level shows, in order, with `radius` pages either side of the current one. */
function levelItems(radius: number, current: number, last: number | null, upper: number): Array<{ page: number } | { after: number }> {
	const pages = new Set<number>([1, current]);
	if (last !== null) pages.add(last);
	for (let p = Math.max(1, current - radius); p <= Math.min(upper, current + radius); p++) pages.add(p);
	const sorted = [...pages].sort((a, b) => a - b);
	const out: Array<{ page: number } | { after: number }> = [];
	sorted.forEach((page, i) => {
		const previous = sorted[i - 1];
		if (previous !== undefined && page - previous > 1) {
			// One hidden page: a level with nearby pages shows it rather than a gap the same size as the link.
			if (radius > 0 && page - previous === 2) out.push({ page: previous + 1 });
			else out.push({ after: previous });
		}
		out.push({ page });
	});
	return out;
}

/**
 * The page links and gaps for page `current` of `last` (null when the last
 * page isn't known; `hasMore` then says whether there's a next page), as the
 * union of the three levels in page order. A gap that exists only at a narrow
 * level is its own item, so it can be shown and hidden on its own.
 */
export function pageItems(current: number, last: number | null, options: { hasMore?: boolean } = {}): PageItem[] {
	const page = Math.max(1, Math.floor(current) || 1);
	const end = last === null ? null : Math.max(page, Math.floor(last) || 1);
	// With no known last page, the pages after the current one are known to exist only as far as the next one.
	const upper = end ?? (options.hasMore ? page + 1 : page);
	const radius = radii(upper);
	const pages = new Map<number, PageLevel[]>();
	const gaps = new Map<number, PageLevel[]>();
	for (const level of PAGE_LEVELS) {
		for (const item of levelItems(radius[level], page, end, upper)) {
			const [map, key] = "page" in item ? [pages, item.page] : [gaps, item.after];
			const levels = map.get(key) ?? [];
			levels.push(level);
			map.set(key, levels);
		}
	}
	// A gap after page n sits between n and n + 1.
	const items: Array<PageItem & { at: number }> = [
		...[...pages].map(([p, levels]) => ({ type: "page" as const, page: p, current: p === page, levels, at: p })),
		...[...gaps].map(([after, levels]) => ({ type: "gap" as const, after, levels, at: after + 0.5 })),
	];
	return items.sort((a, b) => a.at - b.at).map(({ at: _at, ...item }) => item as PageItem);
}

/**
 * The last page to link to, from the entry count (null when unknown) and
 * what the current page's list said: `ceil(count / perPage)`, but never less
 * than the current page, at least the next one when `hasMore`, and exactly
 * the current page when `hasMore` is false (the list ended here). So a count
 * that drifted from the list (an entry published or trashed in between) can't
 * link to a page that doesn't exist. Never more than MAX_PAGE (99999), the
 * highest page a URL can name. Null when the count is null.
 */
export function lastPage(count: number | null | undefined, perPage: number, current: number, hasMore?: boolean): number | null {
	if (count === null || count === undefined || !Number.isFinite(count)) return null;
	const page = Math.max(1, Math.floor(current) || 1);
	if (hasMore === false) return Math.min(MAX_PAGE, page);
	const size = Math.max(1, Math.floor(perPage) || 1);
	const counted = Math.ceil(Math.max(0, count) / size);
	return Math.min(MAX_PAGE, Math.max(counted, hasMore ? page + 1 : page));
}

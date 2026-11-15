/**
 * The pagination nav's markup (the W3C design system's pagination pattern),
 * for src/astro/pagination/Pagination.astro. Kept apart from the component,
 * as the file card's is (src/files/card.ts), so tests can read exactly what a
 * page prints. Differences from the W3C example:
 *
 * - the gaps are `<li aria-hidden="true">…</li>`, not links without an href;
 * - the heading's id is unique per nav on the page (`cw-pagination-1`, -2…);
 * - the current page links to its real URL, with `aria-current="page"`;
 * - each number reads "Page 3" (a visually hidden "Page "), and Previous and
 *   Next read "Previous page" and "Next page" at every width, while narrow
 *   navs show only their arrow (an inline SVG);
 * - Previous and Next are left out on the first and last pages, and carry
 *   `rel="prev"` and `rel="next"` (no `<link>` tags);
 * - every page link and gap says which levels it shows at (`data-l="0 1 2"`,
 *   see ./pages.ts), and the CSS (./css.ts) shows one level per width.
 *
 * Imports only ./pages.ts and ./urls.ts, so `node --test` can load it.
 */
import { type PageItem, pageItems } from "./pages.js";
import { MAX_PAGE } from "./urls.js";

export interface PaginationMarkup {
	/** The current page (1 or more). */
	page: number;
	/** The last page (from lastPage in ./pages.ts), or null when it isn't known. */
	last: number | null;
	/** There's a page after this one (used when `last` is null). */
	hasMore?: boolean;
	/** Numbered page links (the Pagination switch); without them, only Previous and Next. */
	numbered: boolean;
	/** A page's URL (pageHref with the archive's base, form and query). */
	href: (page: number) => string;
	/** The heading's id, unique on the page. */
	id: string;
	/** The nav's name, its visually hidden heading. Default "Pagination". */
	label?: string;
	/** The heading's level, 2–6. Default 2. */
	headingLevel?: number;
}

const escapeHtml = (text: string) =>
	String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const arrow = (d: string) =>
	`<svg class="cw-pagination__arrow" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}" /></svg>`;
const ARROW_PREVIOUS = arrow("M15 18l-6-6 6-6");
const ARROW_NEXT = arrow("M9 18l6-6-6-6");

/** Whether a nav has anything to show: a page before this one or after it. */
export function hasOtherPages(page: number, last: number | null, hasMore?: boolean): boolean {
	return page > 1 || (last !== null ? page < last : Boolean(hasMore));
}

function itemHtml(item: PageItem, href: (page: number) => string): string {
	const levels = escapeHtml(item.levels.join(" "));
	if (item.type === "gap") return `<li data-l="${levels}" class="cw-pagination__gap" aria-hidden="true">…</li>`;
	const current = item.current ? ' aria-current="page"' : "";
	return `<li data-l="${levels}"><a href="${escapeHtml(href(item.page))}"${current}><span class="cw-visually-hidden">Page </span>${item.page}</a></li>`;
}

/** The nav's HTML, or "" when there's only one page (no nav at all). */
export function paginationHtml(o: PaginationMarkup): string {
	const page = Math.max(1, Math.floor(o.page) || 1);
	const last = o.last === null ? null : Math.max(page, Math.floor(o.last) || 1);
	if (!hasOtherPages(page, last, o.hasMore)) return "";
	// No Next past the highest page a URL can name.
	const hasNext = page < MAX_PAGE && (last !== null ? page < last : Boolean(o.hasMore));
	const level = Math.min(6, Math.max(2, Math.floor(o.headingLevel ?? 2) || 2));
	const id = escapeHtml(o.id);
	const parts: string[] = [];
	if (page > 1)
		parts.push(
			`<li class="cw-pagination__prev"><a rel="prev" href="${escapeHtml(o.href(page - 1))}">${ARROW_PREVIOUS}<span class="cw-pagination__text">Previous<span class="cw-visually-hidden"> page</span></span></a></li>`,
		);
	if (o.numbered) for (const item of pageItems(page, last, { hasMore: o.hasMore })) parts.push(itemHtml(item, o.href));
	if (hasNext)
		parts.push(
			`<li class="cw-pagination__next"><a rel="next" href="${escapeHtml(o.href(page + 1))}"><span class="cw-pagination__text">Next<span class="cw-visually-hidden"> page</span></span>${ARROW_NEXT}</a></li>`,
		);
	return `<div class="cw-pagination-wrap"><nav class="cw-pagination" aria-labelledby="${id}"><h${level} id="${id}" class="cw-visually-hidden">${escapeHtml(o.label ?? "Pagination")}</h${level}><ul class="cw-pagination__list">${parts.join("")}</ul></nav></div>`;
}

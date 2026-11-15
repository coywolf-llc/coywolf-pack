/**
 * The pagination nav's CSS, sent once per page with the first nav
 * (src/astro/pagination/Pagination.astro). One line at every width: the nav
 * never wraps; its links shrink, and container queries on the wrapper pick
 * how many show (the levels in ./pages.ts).
 *
 * - The rules outside `@container` are level 0 (arrows, first, current,
 *   last), which is also the layout where container queries aren't supported.
 *   `@container cw-pagination (inline-size >= …)` blocks then show level 1
 *   (27rem), the Previous and Next text (32rem) and level 2 (39rem); each sets
 *   `--cw-pagination-level` (0, 1 or 2) for tests.
 * - Container units (`cqi`) only inside `@supports (inline-size: 1cqi)`, after
 *   the same rule with a px or rem value: a declaration with var() in it is
 *   never dropped at parse time, so a fallback before it wouldn't apply.
 * - Layout, sizes, the current page's border and what each level hides have
 *   class specificity, since themes' `main li` and `a` rules would beat
 *   `:where()` (coywolf.com sets `main li { font-size }` and `a { border: none
 *   }`, wellbeing.io `main li { margin; line-height }`). Theme them with the
 *   custom properties: `--cw-pagination-size` (2.75rem targets), `-font-size`,
 *   `-gap`, `-color`, `-border`, `-radius`, `-current-bg`, `-current-color`.
 *   Text decoration and the wrapper's margin are `:where()` defaults, which any
 *   theme rule overrides.
 * - The current page is bold with a border (not only a color), never a box
 *   shadow (forced colors strip shadows). No transitions or animations.
 *
 * No imports, so `node --test` can load it.
 */

export const PAGINATION_CSS = `.cw-pagination-wrap {
	container: cw-pagination / inline-size;
	inline-size: 100%;
}
:where(.cw-pagination-wrap) {
	margin-block: 1.5rem;
}
.cw-pagination {
	--cw-pagination-level: 0;
}
.cw-pagination .cw-visually-hidden {
	position: absolute !important;
	clip-path: inset(50%) !important;
	overflow: hidden !important;
	width: 1px !important;
	height: 1px !important;
	margin: -1px !important;
	padding: 0 !important;
	border: 0 !important;
	white-space: nowrap !important;
}
.cw-pagination__list {
	display: flex;
	flex-wrap: nowrap;
	justify-content: center;
	justify-content: safe center;
	align-items: stretch;
	gap: var(--cw-pagination-gap, 4px);
	margin: 0;
	padding: 0;
	list-style: none;
	white-space: nowrap;
}
.cw-pagination__list > li {
	display: flex;
	flex: 0 1 var(--cw-pagination-size, 2.75rem);
	min-width: auto;
	margin: 0;
	padding: 0;
	list-style: none;
	line-height: 1;
}
.cw-pagination__list > .cw-pagination__gap {
	flex: 0 1 1rem;
	align-items: center;
	justify-content: center;
	font-size: var(--cw-pagination-font-size, 1rem);
}
.cw-pagination__list > li[data-l]:not([data-l~="0"]) {
	display: none;
}
.cw-pagination__list a {
	display: flex;
	flex: 1 1 auto;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	min-inline-size: 24px;
	min-block-size: var(--cw-pagination-size, 2.75rem);
	margin: 0;
	padding: 0 4px;
	border: var(--cw-pagination-border, 2px solid currentColor);
	border-color: transparent;
	border-radius: var(--cw-pagination-radius, 4px);
	color: var(--cw-pagination-color, currentColor);
	font-size: var(--cw-pagination-font-size, 1rem);
	font-variant-numeric: tabular-nums;
	line-height: 1;
}
.cw-pagination__list a[aria-current="page"] {
	border: var(--cw-pagination-border, 2px solid currentColor);
	background: var(--cw-pagination-current-bg, transparent);
	color: var(--cw-pagination-current-color, var(--cw-pagination-color, currentColor));
	font-weight: 700;
}
:where(.cw-pagination__list a) {
	text-decoration: none;
}
:where(.cw-pagination__list a:is(:hover, :focus-visible)) {
	text-decoration: underline;
	text-underline-offset: 0.2em;
}
.cw-pagination__list .cw-pagination__arrow {
	display: block;
	flex: none;
	inline-size: 1.25em;
	block-size: 1.25em;
}
.cw-pagination__list .cw-pagination__text {
	position: absolute;
	clip-path: inset(50%);
	overflow: hidden;
	width: 1px;
	height: 1px;
	margin: -1px;
	padding: 0;
	border: 0;
	white-space: nowrap;
}
@supports (inline-size: 1cqi) {
	.cw-pagination__list {
		gap: var(--cw-pagination-gap, clamp(2px, 2cqi, 8px));
	}
	.cw-pagination__list > .cw-pagination__gap {
		font-size: min(var(--cw-pagination-font-size, 1rem), 6.5cqi);
	}
	.cw-pagination__list a {
		padding: 0 clamp(1px, 0.75cqi, 4px);
		font-size: min(var(--cw-pagination-font-size, 1rem), 6.5cqi);
	}
}
@container cw-pagination (inline-size >= 27rem) {
	.cw-pagination {
		--cw-pagination-level: 1;
	}
	.cw-pagination__list > li[data-l]:not([data-l~="1"]) {
		display: none;
	}
	.cw-pagination__list > li[data-l][data-l~="1"] {
		display: flex;
	}
}
@container cw-pagination (inline-size >= 32rem) {
	.cw-pagination {
		--cw-pagination-level: 1;
	}
	.cw-pagination__list > :is(.cw-pagination__prev, .cw-pagination__next) {
		flex: 0 0 auto;
	}
	.cw-pagination__list :is(.cw-pagination__prev, .cw-pagination__next) a {
		padding: 0 0.75em;
	}
	.cw-pagination__list .cw-pagination__arrow {
		display: none;
	}
	.cw-pagination__list .cw-pagination__text {
		position: static;
		clip-path: none;
		overflow: visible;
		width: auto;
		height: auto;
		margin: 0;
	}
}
@container cw-pagination (inline-size >= 39rem) {
	.cw-pagination {
		--cw-pagination-level: 2;
	}
	.cw-pagination__list > li[data-l]:not([data-l~="2"]) {
		display: none;
	}
	.cw-pagination__list > li[data-l][data-l~="2"] {
		display: flex;
	}
}
@media (forced-colors: active) {
	.cw-pagination__list a {
		border-color: Canvas;
	}
	.cw-pagination__list a[aria-current="page"] {
		border-color: CanvasText;
	}
}
`;

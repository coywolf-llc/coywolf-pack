// Run: node --test test/pagination.test.mjs
//
// Pagination (src/pagination/): which page links each width shows (pageItems), the last page
// (lastPage), page URLs (parsePagePath, pageHref, archiveRedirect, archivePage), the nav's markup and
// CSS, the /page/N/ → /N/ redirect through the pack middleware with Astro's own route cache, and the
// module's switches. The entry count is checked against EmDash itself in test/emdash-contract.test.mjs.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return {
				url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => { globalThis.__waitUntil?.push(p); };`,
				shortCircuit: true,
			};
		}
		// The middleware's module list pulls in every module (some need a bundler); tests pass their own handlers.
		if (specifier === "./modules.js" && context.parentURL?.endsWith("/src/middleware.ts")) {
			return { url: "data:text/javascript,export const MIDDLEWARE = [];", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const { LEVEL_ZERO_FROM, NARROWER_FROM, lastPage, pageItems } = await import("../src/pagination/pages.ts");
const { MAX_PAGE, PAGE_NUMBER, archiveRedirect, legacyPageRedirect, pageBases, pageHref, parsePagePath, queryString } = await import("../src/pagination/urls.ts");
const { paginationHtml } = await import("../src/pagination/html.ts");
const { PAGINATION_CSS } = await import("../src/pagination/css.ts");
const { FEATURES, PAGE_REDIRECT_EDGE_MAX_AGE, archivePage, paginationMiddleware, paginationPack, shortPageUrlsPack } = await import("../src/pagination/pack.ts");
const { countEntries, countQuery } = await import("../src/pagination/count.ts");
const features = await import("../src/core/features.ts");
const { readFailures } = await import("../src/core/read-failures.ts");
const { configureContentUrls } = await import("../src/core/content-url.ts");
const { coywolfPack } = await import("../src/middleware.ts");
const { AstroCache, applyCacheHeaders } = await import(new URL("../node_modules/astro/dist/core/cache/runtime/cache.js", import.meta.url).href);
const { Window } = await import("happy-dom");

// ── pageItems: the levels ─────────────────────────────────────────

/** What one level shows, as text: "1 … [3] … 20" (the current page in brackets). */
const shown = (items, level) =>
	items
		.filter((i) => i.levels.includes(level))
		.map((i) => (i.type === "gap" ? "…" : i.current ? `[${i.page}]` : String(i.page)))
		.join(" ");
const levels = (items) => [0, 1, 2].map((level) => shown(items, level));

/** Total → current → [level 0, level 1, level 2]: current at 1, 2, 3, the middle, last − 1 and last. */
const MATRIX = {
	1: { 1: ["[1]", "[1]", "[1]"] },
	2: { 1: ["[1] 2", "[1] 2", "[1] 2"], 2: ["1 [2]", "1 [2]", "1 [2]"] },
	5: {
		1: ["[1] … 5", "[1] 2 … 5", "[1] 2 3 4 5"],
		2: ["1 [2] … 5", "1 [2] 3 4 5", "1 [2] 3 4 5"],
		3: ["1 … [3] … 5", "1 2 [3] 4 5", "1 2 [3] 4 5"],
		4: ["1 … [4] 5", "1 2 3 [4] 5", "1 2 3 [4] 5"],
		5: ["1 … [5]", "1 … 4 [5]", "1 2 3 4 [5]"],
	},
	7: {
		1: ["[1] … 7", "[1] 2 … 7", "[1] 2 3 … 7"],
		2: ["1 [2] … 7", "1 [2] 3 … 7", "1 [2] 3 4 … 7"],
		3: ["1 … [3] … 7", "1 2 [3] 4 … 7", "1 2 [3] 4 5 6 7"],
		4: ["1 … [4] … 7", "1 2 3 [4] 5 6 7", "1 2 3 [4] 5 6 7"],
		6: ["1 … [6] 7", "1 … 5 [6] 7", "1 … 4 5 [6] 7"],
		7: ["1 … [7]", "1 … 6 [7]", "1 … 5 6 [7]"],
	},
	8: {
		1: ["[1] … 8", "[1] 2 … 8", "[1] 2 3 … 8"],
		2: ["1 [2] … 8", "1 [2] 3 … 8", "1 [2] 3 4 … 8"],
		3: ["1 … [3] … 8", "1 2 [3] 4 … 8", "1 2 [3] 4 5 … 8"],
		4: ["1 … [4] … 8", "1 2 3 [4] 5 … 8", "1 2 3 [4] 5 6 7 8"],
		5: ["1 … [5] … 8", "1 … 4 [5] 6 7 8", "1 2 3 4 [5] 6 7 8"],
		7: ["1 … [7] 8", "1 … 6 [7] 8", "1 … 5 6 [7] 8"],
		8: ["1 … [8]", "1 … 7 [8]", "1 … 6 7 [8]"],
	},
	20: {
		1: ["[1] … 20", "[1] 2 … 20", "[1] 2 3 … 20"],
		2: ["1 [2] … 20", "1 [2] 3 … 20", "1 [2] 3 4 … 20"],
		3: ["1 … [3] … 20", "1 2 [3] 4 … 20", "1 2 [3] 4 5 … 20"],
		10: ["1 … [10] … 20", "1 … 9 [10] 11 … 20", "1 … 8 9 [10] 11 12 … 20"],
		19: ["1 … [19] 20", "1 … 18 [19] 20", "1 … 17 18 [19] 20"],
		20: ["1 … [20]", "1 … 19 [20]", "1 … 18 19 [20]"],
	},
};

test("pageItems: each level's links for current at 1, 2, 3, the middle, last − 1 and last, of 1, 2, 5, 7, 8 and 20 pages", () => {
	for (const [total, cases] of Object.entries(MATRIX)) {
		for (const [current, expected] of Object.entries(cases)) {
			assert.deepEqual(levels(pageItems(Number(current), Number(total))), expected, `${current} of ${total}`);
		}
	}
});

/** Every rule a level must keep, for any current page and total. */
function checkLevels(items, current, last, hasMore) {
	const at = (i) => (i.type === "page" ? i.page : i.after + 0.5);
	for (let k = 1; k < items.length; k++) assert.ok(at(items[k - 1]) < at(items[k]), `the union is in page order: ${JSON.stringify(items)}`);
	for (const item of items) assert.deepEqual(item.levels, [...item.levels].sort(), "levels in order");
	const upper = last ?? (hasMore ? current + 1 : current);
	for (const level of [0, 1, 2]) {
		const row = items.filter((i) => i.levels.includes(level));
		const label = `level ${level}, ${current} of ${last ?? "?"}${hasMore ? " (more)" : ""}`;
		assert.equal(row[0].type, "page", label);
		assert.equal(row[0].page, 1, label);
		const tail = row.at(-1);
		assert.equal(tail.type, "page", `${label}: never ends in a gap`);
		assert.equal(tail.page, last ?? Math.min(upper, current + level), label);
		assert.equal(row.filter((i) => i.type === "page" && i.current).length, 1, label);
		assert.equal(row.find((i) => i.current).page, current, label);
		for (let p = Math.max(1, current - level); p <= Math.min(upper, current + level); p++) assert.ok(row.some((i) => i.type === "page" && i.page === p), `${label}: shows ${p}`);
		row.forEach((item, k) => {
			if (item.type !== "gap") return;
			const before = row[k - 1];
			const after = row[k + 1];
			assert.equal(before?.type, "page", `${label}: a gap follows a page`);
			assert.equal(after?.type, "page", `${label}: a page follows a gap`);
			assert.equal(item.after, before.page, `${label}: a gap is keyed by the page before it`);
			const hidden = after.page - before.page - 1;
			// Level 0 always shows a gap; levels 1 and 2 show the page instead of a gap that hides only one.
			assert.ok(hidden >= (level === 0 ? 1 : 2), `${label}: a gap after ${before.page} hides ${hidden}`);
		});
		row.forEach((item, k) => {
			const next = row[k + 1];
			if (item.type === "page" && next?.type === "page") assert.equal(next.page, item.page + 1, `${label}: pages ${item.page} and ${next.page} need a gap between them`);
		});
	}
}

test("pageItems: for every page of 1 to 30 pages, each level starts at 1, ends at the last, shows its neighbors, and fills one-page gaps only above level 0", () => {
	for (let total = 1; total <= 30; total++) for (let current = 1; current <= total; current++) checkLevels(pageItems(current, total), current, total, false);
});

test("pageItems: the union keeps a gap that exists only at one level as its own item (3 of 20)", () => {
	assert.deepEqual(pageItems(3, 20), [
		{ type: "page", page: 1, current: false, levels: [0, 1, 2] },
		{ type: "gap", after: 1, levels: [0] },
		{ type: "page", page: 2, current: false, levels: [1, 2] },
		{ type: "page", page: 3, current: true, levels: [0, 1, 2] },
		{ type: "gap", after: 3, levels: [0] },
		{ type: "page", page: 4, current: false, levels: [1, 2] },
		{ type: "gap", after: 4, levels: [1] },
		{ type: "page", page: 5, current: false, levels: [2] },
		{ type: "gap", after: 5, levels: [2] },
		{ type: "page", page: 20, current: false, levels: [0, 1, 2] },
	]);
	// A gap at the same place at several levels is one item.
	assert.deepEqual(
		pageItems(10, 20).filter((i) => i.type === "gap"),
		[
			{ type: "gap", after: 1, levels: [0, 1, 2] },
			{ type: "gap", after: 10, levels: [0] },
			{ type: "gap", after: 11, levels: [1] },
			{ type: "gap", after: 12, levels: [2] },
		],
	);
});

test("pageItems: an unknown last page drops the last link and its gap, showing the next page only when there's more", () => {
	assert.deepEqual(levels(pageItems(5, null, { hasMore: true })), ["1 … [5]", "1 … 4 [5] 6", "1 2 3 4 [5] 6"]);
	assert.deepEqual(levels(pageItems(5, null, { hasMore: false })), ["1 … [5]", "1 … 4 [5]", "1 2 3 4 [5]"]);
	assert.deepEqual(levels(pageItems(5, null)), ["1 … [5]", "1 … 4 [5]", "1 2 3 4 [5]"]);
	assert.deepEqual(levels(pageItems(1, null, { hasMore: true })), ["[1]", "[1] 2", "[1] 2"]);
	assert.deepEqual(levels(pageItems(1, null, { hasMore: false })), ["[1]", "[1]", "[1]"]);
	assert.deepEqual(levels(pageItems(2, null, { hasMore: true })), ["1 [2]", "1 [2] 3", "1 [2] 3"]);
	for (let current = 1; current <= 12; current++) for (const hasMore of [true, false]) checkLevels(pageItems(current, null, { hasMore }), current, null, hasMore);
});

test("pageItems: long numbers get fewer links: four digits show level 0 up to 39rem and current ± 1 from there, five digits level 0 at every width", () => {
	// Five digits.
	const items = pageItems(5000, 12000);
	assert.ok(items.every((i) => i.levels.join() === "0,1,2"), JSON.stringify(items));
	assert.deepEqual(levels(items), ["1 … [5000] … 12000", "1 … [5000] … 12000", "1 … [5000] … 12000"]);
	assert.deepEqual(levels(pageItems(LEVEL_ZERO_FROM, LEVEL_ZERO_FROM)), ["1 … [10000]", "1 … [10000]", "1 … [10000]"]);
	assert.deepEqual(levels(pageItems(3, LEVEL_ZERO_FROM)), ["1 … [3] … 10000", "1 … [3] … 10000", "1 … [3] … 10000"], "the last page decides, not the current one");
	// Four digits: level 1 is level 0's links, and level 2 has what level 1 has for shorter numbers.
	assert.deepEqual(levels(pageItems(9996, 9999)), ["1 … [9996] … 9999", "1 … [9996] … 9999", "1 … 9995 [9996] 9997 9998 9999"], "a one-page gap shows the page");
	assert.deepEqual(levels(pageItems(9990, 9999)), ["1 … [9990] … 9999", "1 … [9990] … 9999", "1 … 9989 [9990] 9991 … 9999"]);
	assert.deepEqual(levels(pageItems(9998, 9999)), ["1 … [9998] 9999", "1 … [9998] 9999", "1 … 9997 [9998] 9999"]);
	assert.deepEqual(levels(pageItems(1234, 1240)), ["1 … [1234] … 1240", "1 … [1234] … 1240", "1 … 1233 [1234] 1235 … 1240"]);
	assert.deepEqual(levels(pageItems(3, NARROWER_FROM)), ["1 … [3] … 1000", "1 … [3] … 1000", "1 2 [3] 4 … 1000"], "a one-page gap still shows the page at level 2");
	// Three digits: the usual levels, right up to 999.
	assert.deepEqual(levels(pageItems(996, 999)), ["1 … [996] … 999", "1 … 995 [996] 997 998 999", "1 … 994 995 [996] 997 998 999"]);
	for (const [current, last] of [
		[1, 1000],
		[500, 1000],
		[1000, 1000],
		[9996, 9999],
		[1, 9999],
	]) {
		const row = pageItems(current, last);
		assert.deepEqual(shown(row, 0), shown(row, 1), `${current} of ${last}: levels 0 and 1 show the same links`);
		assert.ok(row.filter((i) => i.type === "page" && i.levels.includes(2)).length <= 6, `${current} of ${last}: at most six numbers at level 2`);
	}
});

test("pageItems: with an unknown last page, the furthest page the nav shows decides (the next one, or the current one)", () => {
	assert.deepEqual(levels(pageItems(998, null, { hasMore: true })), ["1 … [998]", "1 … 997 [998] 999", "1 … 996 997 [998] 999"]);
	assert.deepEqual(levels(pageItems(999, null, { hasMore: false })), ["1 … [999]", "1 … 998 [999]", "1 … 997 998 [999]"]);
	assert.deepEqual(levels(pageItems(999, null, { hasMore: true })), ["1 … [999]", "1 … [999]", "1 … 998 [999] 1000"], "the next page has four digits");
	assert.deepEqual(levels(pageItems(5000, null, { hasMore: true })), ["1 … [5000]", "1 … [5000]", "1 … 4999 [5000] 5001"]);
	assert.deepEqual(levels(pageItems(9999, null, { hasMore: false })), ["1 … [9999]", "1 … [9999]", "1 … 9998 [9999]"]);
	assert.deepEqual(levels(pageItems(9999, null, { hasMore: true })), ["1 … [9999]", "1 … [9999]", "1 … [9999]"], "the next page has five digits");
	for (const hasMore of [true, false]) {
		const row = pageItems(12345, null, { hasMore });
		assert.deepEqual(levels(row), ["1 … [12345]", "1 … [12345]", "1 … [12345]"], "a five-digit current page: level 0 at every width");
		assert.ok(row.every((i) => i.levels.join() === "0,1,2"));
	}
});

test("pageItems: a current page past the last counts as the last, and odd input reads as page 1", () => {
	assert.deepEqual(levels(pageItems(7, 5)), levels(pageItems(7, 7)));
	assert.deepEqual(levels(pageItems(0, 3)), levels(pageItems(1, 3)));
	assert.deepEqual(levels(pageItems(Number.NaN, 3)), levels(pageItems(1, 3)));
});

// ── lastPage: the clamp ───────────────────────────────────────────

test("lastPage: ceil(count / perPage), at least the current page, at least the next one when there's more, exactly this one when there isn't", () => {
	assert.equal(lastPage(null, 20, 3, true), null);
	assert.equal(lastPage(undefined, 20, 3, true), null);
	assert.equal(lastPage(100, 20, 1, true), 5);
	assert.equal(lastPage(101, 20, 1), 6);
	assert.equal(lastPage(100, 20, 5, false), 5);
	// The count drifted from the list (entries published or trashed in between): no dead links.
	assert.equal(lastPage(100, 20, 3, false), 3, "the list ended here");
	assert.equal(lastPage(40, 20, 3, true), 4, "the list says there's a page 4");
	assert.equal(lastPage(10, 20, 3), 3, "never before the current page");
	assert.equal(lastPage(0, 20, 1, false), 1);
	assert.equal(lastPage(5, 0, 1), 5, "a zero page size counts as 1");
});

test("lastPage: never past the highest page a URL can name (99999), and the nav has no Next from there", () => {
	assert.equal(MAX_PAGE, 99999);
	assert.ok(PAGE_NUMBER.test(String(MAX_PAGE)) && !PAGE_NUMBER.test(String(MAX_PAGE + 1)));
	assert.equal(lastPage(2_000_000, 20, 1, true), MAX_PAGE, "exactly 100,000 pages");
	assert.equal(lastPage(50_000_000, 20, 7, true), MAX_PAGE);
	assert.equal(lastPage(10, 20, MAX_PAGE, true), MAX_PAGE, "no page 100000 after the last one a URL can name");
	assert.equal(lastPage(10, 20, MAX_PAGE, false), MAX_PAGE);
	assert.equal(lastPage(1_999_980, 20, 1, true), MAX_PAGE, "99,999 pages: unchanged");
	assert.equal(lastPage(1_999_960, 20, 1, true), MAX_PAGE - 1);
	for (const [count, current, hasMore] of [
		[2_000_000, 1, true],
		[2_000_000, MAX_PAGE, true],
		[null, MAX_PAGE, true],
	]) {
		const html = paginationHtml({ page: current, last: lastPage(count, 20, current, hasMore), hasMore, numbered: true, href: (n) => pageHref("/", n, { short: true }), id: "x" });
		for (const [, n] of html.matchAll(/href="\/(\d+)\/"/g)) assert.ok(PAGE_NUMBER.test(n), `links to /${n}/`);
		assert.equal(html.includes('rel="next"'), current < MAX_PAGE);
	}
});

// ── URLs ──────────────────────────────────────────────────────────

test("page numbers: 1 to 99999, no leading zero", () => {
	for (const ok of ["1", "2", "9", "10", "99999"]) assert.ok(PAGE_NUMBER.test(ok), ok);
	for (const no of ["0", "03", "007", "100000", "1.5", "-1", "+2", "", "2a", " 2"]) assert.ok(!PAGE_NUMBER.test(no), JSON.stringify(no));
});

test("parsePagePath: /N/ and /page/N/, with minBase keeping a route's own segments", () => {
	assert.deepEqual(parsePagePath([]), { segments: [], page: 1, form: null });
	assert.deepEqual(parsePagePath(["3"]), { segments: [], page: 3, form: "short" });
	assert.deepEqual(parsePagePath(["page", "3"]), { segments: [], page: 3, form: "folder" });
	assert.deepEqual(parsePagePath(["news", "web-development", "2"]), { segments: ["news", "web-development"], page: 2, form: "short" });
	assert.deepEqual(parsePagePath(["news", "web-development", "page", "2"]), { segments: ["news", "web-development"], page: 2, form: "folder" });
	assert.deepEqual(parsePagePath(["1"]), { segments: [], page: 1, form: "short" }, "page 1 named (archivePage redirects it)");
	// Not page numbers: the whole path is the archive (or an entry).
	assert.deepEqual(parsePagePath(["03"]), { segments: ["03"], page: 1, form: null });
	assert.deepEqual(parsePagePath(["news", "100000"]), { segments: ["news", "100000"], page: 1, form: null });
	assert.deepEqual(parsePagePath(["news", "page", "03"]), { segments: ["news", "page", "03"], page: 1, form: null });
	assert.deepEqual(parsePagePath(["page"]), { segments: ["page"], page: 1, form: null });
	// minBase: /tag/2024/ is the tag "2024"; /search/2/ is a search for "2".
	assert.deepEqual(parsePagePath(["2024"], { minBase: 1 }), { segments: ["2024"], page: 1, form: null });
	assert.deepEqual(parsePagePath(["2024", "2"], { minBase: 1 }), { segments: ["2024"], page: 2, form: "short" });
	assert.deepEqual(parsePagePath(["2024", "page", "2"], { minBase: 1 }), { segments: ["2024"], page: 2, form: "folder" });
	assert.deepEqual(parsePagePath(["search", "2"], { minBase: 2 }), { segments: ["search", "2"], page: 1, form: null });
	assert.deepEqual(parsePagePath(["search", "coyote", "2"], { minBase: 2 }), { segments: ["search", "coyote"], page: 2, form: "short" });
	assert.deepEqual(parsePagePath(["page", "2"], { minBase: 1 }), { segments: ["page"], page: 2, form: "short" }, "the folder form needs its base too");
});

test("pageHref: page 1 is the base; /N/ or /page/N/ after it, with the base's trailing slash and the query", () => {
	assert.equal(pageHref("/news/", 1, { short: true }), "/news/");
	assert.equal(pageHref("/news/", 2, { short: true }), "/news/2/");
	assert.equal(pageHref("/news/", 2, { short: false }), "/news/page/2/");
	assert.equal(pageHref("/news/web-development/", 3, { short: true }), "/news/web-development/3/");
	assert.equal(pageHref("/", 3, { short: true }), "/3/");
	assert.equal(pageHref("/", 3, { short: false }), "/page/3/");
	assert.equal(pageHref("", 3, { short: true }), "/3/");
	assert.equal(pageHref("news/", 2, { short: true }), "/news/2/", "a site path");
	assert.equal(pageHref("/news", 2, { short: true }), "/news/2", "no trailing slash on the base, none on its pages");
	assert.equal(pageHref("/news", 2, { short: true, slash: true }), "/news/2/");
	assert.equal(pageHref("/news/", 2, { short: true, slash: false }), "/news/2");
	assert.equal(pageHref("/news/", 0, { short: true }), "/news/");
	assert.equal(pageHref("/news/", Number.NaN, { short: true }), "/news/");
	// Queries.
	assert.equal(pageHref("/", 3, { short: false, query: "?s=coyote" }), "/page/3/?s=coyote");
	assert.equal(pageHref("/", 2, { short: true, query: "s=coyote" }), "/2/?s=coyote");
	assert.equal(pageHref("/", 1, { short: true, query: new URLSearchParams({ s: "coyote tracks" }) }), "/?s=coyote+tracks");
	assert.equal(pageHref("/", 2, { short: true, query: { s: "a&b" } }), "/2/?s=a%26b");
	assert.equal(queryString("?"), "");
	assert.equal(queryString(""), "");
	assert.equal(queryString(null), "");
});

test("legacyPageRedirect: /page/N/ → /N/ in one hop, the query kept, the trailing slash as the site has it, and never another host", () => {
	const slash = { slash: true };
	assert.equal(legacyPageRedirect("/page/3/", "", slash), "/3/");
	assert.equal(legacyPageRedirect("/page/3", "", slash), "/3/", "one hop: not via /page/3/");
	assert.equal(legacyPageRedirect("/page/1/", "", slash), "/");
	assert.equal(legacyPageRedirect("/page/1", "", slash), "/");
	assert.equal(legacyPageRedirect("/news/web-development/page/1/", "", slash), "/news/web-development/");
	assert.equal(legacyPageRedirect("/news/page/2/", "?s=coyote&x=1", slash), "/news/2/?s=coyote&x=1");
	assert.equal(legacyPageRedirect("/caf%C3%A9/page/2/", "", slash), "/caf%C3%A9/2/");
	assert.equal(legacyPageRedirect("/news/page/2/", "", { slash: false }), "/news/2");
	assert.equal(legacyPageRedirect("/news/page/1/", "", { slash: false }), "/news");
	assert.equal(legacyPageRedirect("/page/1/", "", { slash: false }), "/");
	for (const path of ["/page/03/", "/page/100000/", "/page/0/", "/page/", "/page", "/news/", "/page/2/extra/", "/pages/2/", "/news/2/"]) assert.equal(legacyPageRedirect(path, "", slash), null, path);
	// A path that starts with "//" must not become a protocol-relative Location (another host).
	assert.equal(legacyPageRedirect("//evil.example/page/2/", "", slash), "/evil.example/2/");
	assert.equal(legacyPageRedirect("//page/2/", "", slash), "/2/");
});

test("legacyPageRedirect with bases: under a listed prefix, a /page/N/ whose \"page\" is the archive's own name is left for the theme", () => {
	const options = { slash: true, bases: pageBases({ "/tag/": 1, "/author/": 1, "/search/": 1, "/docs/api/": 2 }) };
	// The tag (author, search) named "page", page 2 in the short form: what parsePagePath with minBase 1 reads.
	assert.equal(legacyPageRedirect("/tag/page/2/", "", options), null);
	assert.equal(legacyPageRedirect("/tag/page/2", "?x=1", options), null);
	assert.equal(legacyPageRedirect("/author/page/7/", "", options), null);
	assert.equal(legacyPageRedirect("/search/page/2/", "", options), null);
	assert.equal(legacyPageRedirect("/tag/page/1/", "", options), null, "page 1 of the tag \"page\": the theme sends it to /tag/page/");
	assert.deepEqual(parsePagePath(["page", "2"], { minBase: 1 }), { segments: ["page"], page: 2, form: "short" }, "the theme agrees");
	// With the archive's own segments in place, the folder form redirects as usual.
	assert.equal(legacyPageRedirect("/tag/coyotes/page/2/", "", options), "/tag/coyotes/2/");
	assert.equal(legacyPageRedirect("/tag/page/page/2/", "?x=1", options), "/tag/page/2/?x=1", "page 2 of the tag \"page\"");
	assert.equal(legacyPageRedirect("/search/coyote/page/3", "", options), "/search/coyote/3/");
	assert.equal(legacyPageRedirect("/tag/coyotes/page/1/", "", options), "/tag/coyotes/");
	// The longest prefix decides.
	assert.equal(legacyPageRedirect("/docs/api/v2/page/2/", "", options), null, "/docs/api/ keeps two segments");
	assert.equal(legacyPageRedirect("/docs/api/v2/auth/page/2/", "", options), "/docs/api/v2/auth/2/");
	assert.equal(legacyPageRedirect("/docs/page/2/", "", options), "/docs/2/", "not under /docs/api/");
	// Other paths are as without the option: whole segments only, case as written.
	assert.equal(legacyPageRedirect("/page/2/", "", options), "/2/");
	assert.equal(legacyPageRedirect("/news/page/2/", "", options), "/news/2/");
	assert.equal(legacyPageRedirect("/tags/page/2/", "", options), "/tags/2/");
	assert.equal(legacyPageRedirect("/news/tag/page/2/", "", options), "/news/tag/2/", "a prefix is the start of the path");
	assert.equal(legacyPageRedirect("//tag//page/2/", "", options), null, "repeated slashes don't get around it");
	// Without the option, every /page/N/ redirects (the documented limit).
	assert.equal(legacyPageRedirect("/tag/page/2/", "", { slash: true }), "/tag/2/");
	assert.equal(legacyPageRedirect("/tag/page/2/", "", { slash: true, bases: [] }), "/tag/2/");
});

test("pageBases: prefixes as segments, longest first; entries that say nothing are left out", () => {
	assert.deepEqual(pageBases({ "/tag/": 1, "docs/api": 2, "/search": 1.9 }), [
		{ prefix: ["docs", "api"], minBase: 2 },
		{ prefix: ["tag"], minBase: 1 },
		{ prefix: ["search"], minBase: 1 },
	]);
	assert.deepEqual(pageBases({ "/": 1, "/tag/": 0, "/author/": -1, "/x/": Number.NaN, "/y/": "2" }), [{ prefix: ["y"], minBase: 2 }]);
	assert.deepEqual(pageBases(undefined), []);
	assert.deepEqual(pageBases(null), []);
});

test("archiveRedirect: page 1 to the base, and the page form that isn't in use to the one that is, from the request's own path", () => {
	const on = { short: true, slash: true };
	const off = { short: false, slash: true };
	const redirect = (path, search, segments, options, minBase = 0) => archiveRedirect(path, search, parsePagePath(segments, { minBase }), options);
	assert.equal(redirect("/news/", "", ["news"], on), null);
	assert.equal(redirect("/news/2/", "", ["news", "2"], on), null, "already short");
	assert.equal(redirect("/news/page/2/", "?s=1", ["news", "page", "2"], on), "/news/2/?s=1");
	assert.equal(redirect("/news/1/", "", ["news", "1"], on), "/news/");
	assert.equal(redirect("/news/page/1/", "", ["news", "page", "1"], on), "/news/");
	assert.equal(redirect("/1/", "?s=x", ["1"], on), "/?s=x");
	assert.equal(redirect("/news/page/2/", "", ["news", "page", "2"], off), null, "already the folder form");
	assert.equal(redirect("/news/2/", "", ["news", "2"], off), "/news/page/2/");
	assert.equal(redirect("/2/", "?s=x", ["2"], off), "/page/2/?s=x");
	assert.equal(redirect("/news/1/", "", ["news", "1"], off), "/news/");
	assert.equal(redirect("/news/2", "", ["news", "2"], { short: false, slash: false }), "/news/page/2");
	// The route's prefix (here /tag/) and the path's encoding are kept.
	assert.equal(redirect("/tag/coyotes/2/", "", ["coyotes", "2"], off, 1), "/tag/coyotes/page/2/");
	assert.equal(redirect("/tag/caf%C3%A9/page/2/", "", ["café", "page", "2"], on, 1), "/tag/caf%C3%A9/2/");
	assert.equal(redirect("//evil.example/page/2/", "", ["evil.example", "page", "2"], on), "/evil.example/2/");
});

// ── archivePage, with the switches from the site database ────────

/** A D1 stand-in over node:sqlite with the options table, the feature switches stored. */
function d1(switches = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT DEFAULT '0' NOT NULL);");
	db.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify(switches));
	const state = { statements: [] };
	const exec = (sql, params) => {
		const st = db.prepare(sql);
		return /^\s*(select|with)/i.test(sql) ? { results: st.all(...params) } : { results: [], meta: { changes: Number(st.run(...params).changes) } };
	};
	const statement = (sql, params = []) => ({
		sql,
		params,
		bind: (...p) => statement(sql, p),
		all: async () => exec(sql, params),
		first: async () => exec(sql, params).results[0] ?? null,
		run: async () => exec(sql, params),
	});
	return Object.assign(state, {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => (state.statements.push(sql), statement(sql)),
		batch: async (statements) => statements.map((s) => exec(s.sql, s.params)),
	});
}

/** A fresh isolate's view of the switches, with `db` as the site database. */
function freshIsolate(db) {
	globalThis.__testEnv = { DB: db };
	globalThis.__waitUntil = [];
	features.invalidateFeatures();
}

/** archivePage's answer without its Response (checked on its own). */
const plain = ({ response: _response, ...paged }) => paged;

test("archivePage: the page, the URL form in use, and where to redirect, from the Short page URLs switch and the trailing-slash policy", async () => {
	const short = d1({ shortPageUrls: true });
	freshIsolate(short);
	assert.deepEqual(plain(await archivePage(["news", "page", "2"], new URL("https://coywolf.com/news/page/2/?s=1"), { database: short })), {
		segments: ["news"],
		page: 2,
		form: "folder",
		short: true,
		redirect: "/news/2/?s=1",
	});
	assert.deepEqual(await archivePage(["news", "2"], new URL("https://coywolf.com/news/2/"), { database: short }), { segments: ["news"], page: 2, form: "short", short: true });
	assert.deepEqual(await archivePage([], new URL("https://coywolf.com/"), { database: short }), { segments: [], page: 1, form: null, short: true });
	assert.equal((await archivePage("news/1", "/news/1/", { database: short })).redirect, "/news/", "Astro.params' string and a path");
	assert.deepEqual(await archivePage(undefined, "/", { database: short }), { segments: [], page: 1, form: null, short: true });
	await assert.rejects(archivePage(["news", "page", "1"], "?s=1", { database: short }), TypeError, "a query string alone can't place the redirect");
	await assert.rejects(archivePage(["news", "page", "1"], "", { database: short }), TypeError);

	// Off: /N/ goes to /page/N/, and /page/N/ renders. Pagination's own switch changes neither.
	for (const switches of [{ pagination: true }, { pagination: true, shortPageUrls: false }, {}]) {
		const db = d1(switches);
		freshIsolate(db);
		const paged = await archivePage(["news", "2"], new URL("https://coywolf.com/news/2/?s=1"), { database: db });
		assert.deepEqual(plain(paged), { segments: ["news"], page: 2, form: "short", short: false, redirect: "/news/page/2/?s=1" }, JSON.stringify(switches));
		assert.equal((await archivePage(["news", "page", "2"], "/news/page/2/", { database: db })).redirect, undefined);
	}
	// On, with Pagination off or on: the same answers.
	for (const switches of [{ shortPageUrls: true }, { pagination: false, shortPageUrls: true }, { pagination: true, shortPageUrls: true }]) {
		const db = d1(switches);
		freshIsolate(db);
		assert.equal((await archivePage(["news", "2"], "/news/2/", { database: db })).redirect, undefined, JSON.stringify(switches));
		assert.equal((await archivePage(["news", "page", "2"], "/news/page/2/", { database: db })).redirect, "/news/2/", JSON.stringify(switches));
	}

	// minBase: /tag/2024/ is the tag "2024", page 1 (no redirect whatever the switch says).
	freshIsolate(short);
	assert.deepEqual(await archivePage(["2024"], "/tag/2024/", { minBase: 1, database: short }), { segments: ["2024"], page: 1, form: null, short: true });

	// A site whose trailing-slash policy is "never".
	configureContentUrls({ trailingSlash: "never" });
	try {
		assert.equal((await archivePage(["news", "page", "2"], "/news/page/2", { database: short })).redirect, "/news/2");
	} finally {
		configureContentUrls({});
	}
});

test("archivePage: its redirect comes as a ready 301 that browsers don't keep (Cache-Control: no-cache), with a site-relative Location", async () => {
	// A browser that kept /3/ → /page/3/ would loop with the middleware's /page/3/ → /3/ once the switch is turned on.
	for (const [switches, segments, path, location] of [
		[{}, ["3"], "/3/", "/page/3/"],
		[{}, ["news", "2"], "/news/2/?s=coyote", "/news/page/2/?s=coyote"],
		[{ shortPageUrls: true }, ["news", "page", "2"], "/news/page/2/", "/news/2/"],
		[{ shortPageUrls: true }, ["1"], "/1/", "/"],
		[{}, ["page", "1"], "/page/1/", "/"],
	]) {
		const db = d1(switches);
		freshIsolate(db);
		const paged = await archivePage(segments, new URL(`https://coywolf.com${path}`), { database: db });
		assert.equal(paged.redirect, location, path);
		assert.ok(paged.response instanceof Response, path);
		assert.equal(paged.response.status, 301, path);
		assert.equal(paged.response.headers.get("Location"), location, "site-relative, the same as `redirect`");
		assert.equal(paged.response.headers.get("Cache-Control"), "no-cache", path);
		assert.equal(await paged.response.text(), "");
	}
	// Nothing to redirect: no response either.
	const db = d1({});
	freshIsolate(db);
	const rendered = await archivePage(["news", "page", "2"], "/news/page/2/", { database: db });
	assert.equal(rendered.response, undefined);
	assert.ok(!("response" in rendered) && !("redirect" in rendered));
});

test("archivePage: when the switches can't be read, neither form redirects to the other; the page renders as asked and the failure is noted", async () => {
	// The site has Short page URLs on, but D1 fails for a moment: the defaults (off) would send /3/ to /page/3/.
	const down = { prepare: () => ({ bind: () => ({ all: async () => Promise.reject(new Error("D1 is down")) }), all: async () => Promise.reject(new Error("D1 is down")) }), batch: async () => Promise.reject(new Error("D1 is down")) };
	const error = console.error;
	console.error = () => {};
	try {
		for (const [segments, path, form] of [
			[["3"], "/3/?s=1", "short"],
			[["news", "page", "3"], "/news/page/3/", "folder"],
		]) {
			freshIsolate(down);
			const before = readFailures();
			const paged = await archivePage(segments, new URL(`https://coywolf.com${path}`), { database: down });
			assert.equal(paged.redirect, undefined, `${path}: no redirect from a default`);
			assert.equal(paged.response, undefined, path);
			assert.equal(paged.page, 3);
			assert.equal(paged.form, form);
			assert.equal(paged.short, form === "short", "page links follow the form the request used");
			assert.ok(readFailures() > before, "noted, so the page isn't kept in the edge cache");
		}
		// Page 1 named in the URL goes to the base whatever the switch is.
		freshIsolate(down);
		for (const [segments, path] of [
			[["news", "1"], "/news/1/"],
			[["news", "page", "1"], "/news/page/1/"],
		]) {
			const paged = await archivePage(segments, path, { database: down });
			assert.equal(paged.redirect, "/news/", path);
			assert.equal(paged.response.headers.get("Cache-Control"), "no-cache");
		}
		// No page in the URL: page 1, nothing to redirect.
		freshIsolate(down);
		assert.deepEqual(await archivePage(["news"], "/news/", { database: down }), { segments: ["news"], page: 1, form: null, short: false });
	} finally {
		console.error = error;
	}
	// Once D1 answers again, the switch decides again.
	const up = d1({ shortPageUrls: true });
	freshIsolate(up);
	assert.equal((await archivePage(["news", "page", "3"], "/news/page/3/", { database: up })).redirect, "/news/3/");
	// With the read cached, a later failure of D1 isn't even seen.
	assert.equal((await archivePage(["news", "page", "3"], "/news/page/3/", { database: down })).redirect, "/news/3/");
});

// ── The nav's markup ──────────────────────────────────────────────

const href = (n) => pageHref("/news/", n, { short: true });
const nav = (o) => paginationHtml({ numbered: true, href, id: "cw-pagination-1", ...o });

test("markup: a nav named by a visually hidden heading, Previous and Next with rel, the current page linked with aria-current, hidden gaps", () => {
	const html = nav({ page: 3, last: 20 });
	assert.match(html, /^<div class="cw-pagination-wrap"><nav class="cw-pagination" aria-labelledby="cw-pagination-1"><h2 id="cw-pagination-1" class="cw-visually-hidden">Pagination<\/h2><ul class="cw-pagination__list">/);
	assert.match(html, /<li class="cw-pagination__prev"><a rel="prev" href="\/news\/2\/"><svg class="cw-pagination__arrow"[^>]* aria-hidden="true" focusable="false">.*?<\/svg><span class="cw-pagination__text">Previous<span class="cw-visually-hidden"> page<\/span><\/span><\/a><\/li>/);
	assert.match(html, /<li class="cw-pagination__next"><a rel="next" href="\/news\/4\/"><span class="cw-pagination__text">Next<span class="cw-visually-hidden"> page<\/span><\/span><svg /);
	assert.match(html, /<li data-l="0 1 2"><a href="\/news\/3\/" aria-current="page"><span class="cw-visually-hidden">Page <\/span>3<\/a><\/li>/);
	assert.match(html, /<li data-l="0 1 2"><a href="\/news\/"><span class="cw-visually-hidden">Page <\/span>1<\/a><\/li>/, "page 1 is the base");
	assert.match(html, /<li data-l="0" class="cw-pagination__gap" aria-hidden="true">…<\/li>/);
	assert.equal((html.match(/aria-current/g) ?? []).length, 1);
	assert.ok(!/<a(?![^>]*href)/.test(html), "every link has an href");
	assert.ok(!/<link /.test(html));
	// One li per item, in pageItems' order, with its levels.
	const items = [...html.matchAll(/<li data-l="([^"]*)"( class="cw-pagination__gap")?/g)].map((m) => m[1]);
	assert.deepEqual(items, pageItems(3, 20).map((i) => i.levels.join(" ")));
});

test("markup: no Previous on the first page, no Next on the last, nothing for a single page; Previous and Next only with the switch off", () => {
	assert.ok(!nav({ page: 1, last: 5 }).includes("cw-pagination__prev"));
	assert.ok(nav({ page: 1, last: 5 }).includes("cw-pagination__next"));
	assert.ok(!nav({ page: 5, last: 5 }).includes("cw-pagination__next"));
	assert.equal(nav({ page: 1, last: 1 }), "");
	assert.equal(nav({ page: 1, last: null, hasMore: false }), "");
	assert.equal(nav({ page: 1, last: null }), "");
	const unknown = nav({ page: 4, last: null, hasMore: true });
	assert.match(unknown, /rel="next" href="\/news\/5\/"/);
	assert.ok(!unknown.includes(">20<"));
	const plain = nav({ page: 2, last: 5, numbered: false });
	assert.ok(plain.includes('rel="prev"') && plain.includes('rel="next"'));
	assert.ok(!plain.includes("data-l"), "no numbered links");
	assert.equal(nav({ page: 1, last: null, hasMore: true, numbered: false }).includes('rel="next"'), true);
});

test("markup: the heading's level and name, and every value escaped", () => {
	const html = paginationHtml({ page: 2, last: 3, numbered: true, href: (n) => `/x/?a="${n}"&b=<i>`, id: 'cw-pagination-"2"', label: "Older & newer <posts>", headingLevel: 3 });
	assert.match(html, /<h3 id="cw-pagination-&quot;2&quot;" class="cw-visually-hidden">Older &amp; newer &lt;posts&gt;<\/h3>/);
	assert.match(html, /aria-labelledby="cw-pagination-&quot;2&quot;"/);
	assert.ok(html.includes('href="/x/?a=&quot;1&quot;&amp;b=&lt;i&gt;"'));
	assert.ok(!html.includes("<i>"));
	assert.match(paginationHtml({ page: 2, last: 3, numbered: true, href, id: "x", headingLevel: 9 }), /<h6 /);
	assert.match(paginationHtml({ page: 2, last: 3, numbered: true, href, id: "x", headingLevel: 1 }), /<h2 /);
});

// The component itself is rendered in test/pagination-render.test.mjs (Astro's container API).

// ── The CSS ───────────────────────────────────────────────────────

/** Every rule of a stylesheet, flattened: { selector, at (its at-rules), declarations: [[property, value]] } in source order. */
function rules(css) {
	const out = [];
	const stack = [];
	let buffer = "";
	for (const char of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
		if (char === "{") {
			stack.push(buffer.trim());
			buffer = "";
		} else if (char === "}") {
			const head = stack.pop();
			if (!head.startsWith("@")) {
				const declarations = buffer
					.split(";")
					.map((d) => d.trim())
					.filter(Boolean)
					.map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]);
				out.push({ selector: head, at: stack.filter((s) => s.startsWith("@")), declarations });
			}
			buffer = "";
		} else buffer += char;
	}
	return out;
}

test("CSS: one line (no wrapping), no box-shadow, no transitions or animations, and borders for the current page", () => {
	assert.ok(!/flex-wrap:\s*wrap/.test(PAGINATION_CSS));
	assert.match(PAGINATION_CSS, /flex-wrap: nowrap;/);
	assert.match(PAGINATION_CSS, /white-space: nowrap;/);
	// Centered, but if it ever overflows, never off the start edge where it can't be scrolled to.
	assert.match(PAGINATION_CSS, /justify-content: center;\n\tjustify-content: safe center;/);
	for (const banned of ["box-shadow", "transition", "animation", "@keyframes"]) assert.ok(!PAGINATION_CSS.includes(banned), banned);
	const current = rules(PAGINATION_CSS).find((r) => r.selector === '.cw-pagination .cw-pagination__list a[aria-current="page"]' && !r.at.length);
	assert.deepEqual(Object.fromEntries(current.declarations).border, "var(--cw-pagination-border, 2px solid currentColor)");
	assert.equal(Object.fromEntries(current.declarations)["font-weight"], "700");
	const forced = rules(PAGINATION_CSS).filter((r) => r.at.includes("@media (forced-colors: active)"));
	assert.deepEqual(forced.map((r) => Object.fromEntries(r.declarations)["border-color"]), ["Canvas", "CanvasText"]);
});

test("CSS: every cqi declaration comes after the same rule's px or rem value, inside @supports", () => {
	const all = rules(PAGINATION_CSS);
	let checked = 0;
	all.forEach((rule, i) => {
		for (const [property, value] of rule.declarations) {
			if (!/\dcqi\b/.test(value)) continue;
			checked++;
			assert.ok(rule.at.includes("@supports (inline-size: 1cqi)"), `${rule.selector} { ${property} }: only where container units are supported`);
			const fallback = all.slice(0, i).find((r) => r.selector === rule.selector && !r.at.length && r.declarations.some(([p, v]) => p === property && !/cqi/.test(v) && /\d(px|rem)\b/.test(v)));
			assert.ok(fallback, `${rule.selector} { ${property}: ${value} } has no px or rem value before it`);
		}
	});
	assert.equal(checked, 4);
});

test("CSS: the container is a wrapper around the nav; three @container blocks add items and set --cw-pagination-level", () => {
	const all = rules(PAGINATION_CSS);
	const wrap = all.find((r) => r.selector === ".cw-pagination-wrap");
	assert.deepEqual(Object.fromEntries(wrap.declarations), { container: "cw-pagination / inline-size", "inline-size": "100%" });
	assert.ok(!all.some((r) => r.selector === ".cw-pagination" && r.declarations.some(([p]) => p.startsWith("container"))), "not on the nav itself");
	const blocks = [...new Set(all.flatMap((r) => r.at).filter((a) => a.startsWith("@container")))];
	assert.deepEqual(blocks, ["@container cw-pagination (inline-size >= 27rem)", "@container cw-pagination (inline-size >= 32rem)", "@container cw-pagination (inline-size >= 39rem)"]);
	const level = (at) => Object.fromEntries(all.find((r) => r.selector === ".cw-pagination" && r.at.includes(at)).declarations)["--cw-pagination-level"];
	assert.deepEqual(blocks.map(level), ["1", "1", "2"]);
	assert.equal(Object.fromEntries(all.find((r) => r.selector === ".cw-pagination" && !r.at.length).declarations)["--cw-pagination-level"], "0");
	// Pseudo-classes a browser may not know sit inside :is() or :where() (a plain selector list would drop the rule).
	for (const rule of all) if (rule.selector.includes(":focus-visible")) assert.match(rule.selector, /:(is|where)\([^)]*:focus-visible/);
	assert.ok(all.some((r) => r.selector.startsWith(":where(")), "themeable defaults in :where()");
});

test("CSS: visually hidden text is clipped, not display: none (it's part of the link names); hidden levels are display: none", () => {
	const all = rules(PAGINATION_CSS);
	for (const selector of [".cw-pagination .cw-visually-hidden", ".cw-pagination__list .cw-pagination__text"]) {
		const rule = Object.fromEntries(all.find((r) => r.selector === selector && !r.at.length).declarations);
		assert.match(rule["clip-path"], /^inset\(50%\)/, selector);
		assert.match(rule.position, /^absolute/, selector);
		assert.ok(!/none/.test(rule.display ?? ""), selector);
	}
	const text = all.find((r) => r.selector === ".cw-pagination__list .cw-pagination__text" && r.at.includes("@container cw-pagination (inline-size >= 32rem)"));
	assert.equal(Object.fromEntries(text.declarations)["clip-path"], "none", "the text shows from 32rem");
	const arrow = all.find((r) => r.selector === ".cw-pagination__list .cw-pagination__arrow" && r.at.includes("@container cw-pagination (inline-size >= 32rem)"));
	assert.equal(Object.fromEntries(arrow.declarations).display, "none", "the arrow goes (aria-hidden, so the name is unchanged)");
});

test("CSS: without container queries (the rules outside @container), every item that isn't level 0 is hidden and every level 0 item shows", async () => {
	// happy-dom applies the cascade but not @container: the layout a browser without container queries gets.
	const window = new Window();
	try {
		const pages = [
			[3, 20],
			[1, 8],
			[10, 20],
			[5, null],
			[1234, 1240],
			[5000, 12000],
		];
		const body = pages.map(([page, last], i) => paginationHtml({ page, last, hasMore: true, numbered: true, href, id: `cw-pagination-${i + 1}` })).join("");
		// A theme's own list rules (coywolf.com's and wellbeing.io's) don't change it.
		window.document.write(`<!doctype html><html><head><style>main li { display: list-item; margin: 1rem 0; font-size: 1.2rem; } a { border: none; }</style><style>${PAGINATION_CSS}</style></head><body><main>${body}</main></body></html>`);
		const items = [...window.document.querySelectorAll(".cw-pagination__list > li")];
		assert.ok(items.length > 30);
		for (const li of items) {
			const style = window.getComputedStyle(li);
			const level = li.getAttribute("data-l");
			const visible = level === null || level.split(" ").includes("0");
			assert.equal(style.display, visible ? "flex" : "none", `${li.outerHTML.slice(0, 80)}`);
			if (visible) assert.equal(style.marginTop, "0px", "the theme's li margin is reset");
		}
		for (const nav of window.document.querySelectorAll(".cw-pagination")) assert.equal(window.getComputedStyle(nav).getPropertyValue("--cw-pagination-level").trim(), "0");
		const current = window.document.querySelector('a[aria-current="page"]');
		assert.match(window.getComputedStyle(current).borderTopStyle, /solid/, "the theme's a { border: none } doesn't take the current page's border");
	} finally {
		await window.happyDOM.close();
	}
});

test("CSS: the links' rules have two classes and a type, so a theme's link rules (hover too) lose wherever its stylesheet comes", () => {
	const all = rules(PAGINATION_CSS);
	// Every rule that styles the links themselves (not what's inside them).
	const links = all.filter((r) => /(^|\s)a(\[[^\]]*\]|:is\([^)]*\))?$/.test(r.selector));
	assert.ok(links.length >= 6, links.map((r) => r.selector).join("\n"));
	for (const rule of links) assert.ok(rule.selector.startsWith(".cw-pagination .cw-pagination__list "), `${rule.selector}: under both classes`);
	// (classes + attributes + pseudo-classes, types): wellbeing.io's `:where(.wb-site) a:hover` is (1, 1); `main a:hover` would be (1, 2).
	const specificity = (selector) => {
		const inner = selector.replace(/:is\(([^)]*)\)/g, (_, list) => list.split(",")[0].trim()).replace(/:where\([^)]*\)/g, "");
		return [(inner.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length, (inner.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length];
	};
	assert.deepEqual(specificity(":where(.wb-site) a:hover"), [1, 1]);
	assert.deepEqual(specificity(".cw-pagination .cw-pagination__list a"), [2, 1]);
	for (const rule of links) assert.ok(specificity(rule.selector)[0] >= 2, `${rule.selector} beats a theme's a:hover`);
	const base = Object.fromEntries(all.find((r) => r.selector === ".cw-pagination .cw-pagination__list a" && !r.at.length).declarations);
	assert.equal(base["font-weight"], "normal", "only the current page is bold");
	assert.equal(base["text-decoration"], "none");
	const hover = Object.fromEntries(all.find((r) => r.selector === ".cw-pagination .cw-pagination__list a:is(:hover, :focus-visible)").declarations);
	assert.equal(hover["text-decoration"], "underline", "hover and keyboard focus still show");
	const current = Object.fromEntries(all.find((r) => r.selector === '.cw-pagination .cw-pagination__list a[aria-current="page"]' && !r.at.length).declarations);
	assert.equal(current.background, "var(--cw-pagination-current-bg, transparent)", "the current page's background stays themeable");
});

test("CSS: on a theme whose links are all bold and underlined, only the current page is bold, whichever stylesheet comes last", async () => {
	// coywolf.com and wellbeing.io both set `a { font-weight: bold }`; wellbeing.io's link rules are under :where(.wb-site).
	const theme = "a { font-weight: bold; text-decoration: underline; border: none; } :where(.wb-site) a { font-weight: 700; text-decoration: underline; } main li a { font-weight: bold; }";
	const body = `<main class="wb-site">${paginationHtml({ page: 3, last: 20, numbered: true, href, id: "cw-pagination-1" })}</main>`;
	for (const [order, styles] of [
		["theme first", `<style>${theme}</style><style>${PAGINATION_CSS}</style>`],
		["theme last", `<style>${PAGINATION_CSS}</style><style>${theme}</style>`],
	]) {
		const window = new Window();
		try {
			window.document.write(`<!doctype html><html><head>${styles}</head><body>${body}</body></html>`);
			const anchors = [...window.document.querySelectorAll(".cw-pagination__list a")];
			assert.ok(anchors.length >= 5);
			for (const a of anchors) {
				const style = window.getComputedStyle(a);
				const isCurrent = a.getAttribute("aria-current") === "page";
				assert.match(style.fontWeight, isCurrent ? /^(700|bold)$/ : /^(400|normal)$/, `${order}: ${a.textContent}`);
				assert.match(style.textDecoration || style.textDecorationLine, /^none/, `${order}: ${a.textContent} isn't underlined`);
				if (isCurrent) assert.match(style.borderTopStyle, /solid/, order);
			}
			assert.equal(anchors.filter((a) => /^(700|bold)$/.test(window.getComputedStyle(a).fontWeight)).length, 1, `${order}: one bold link`);
		} finally {
			await window.happyDOM.close();
		}
	}
});

// ── The /page/N/ redirect, through the pack middleware ───────────

/** Astro's route cache as a "/[...path]" route rule leaves it: cacheable, with the rule's lifetime. */
function routeCache(maxAge = 3600) {
	const cache = new AstroCache({ setHeaders: (o) => new Headers({ "Cloudflare-CDN-Cache-Control": o.maxAge === undefined ? "public" : `public, max-age=${o.maxAge}` }) });
	cache.set({ maxAge });
	return cache;
}
const cdnHeader = (cache) => {
	const response = new Response(null);
	applyCacheHeaders(cache, response, new Request("https://coywolf.com/"));
	return response.headers.get("Cloudflare-CDN-Cache-Control");
};
function context(path, cache, method = "GET") {
	const url = new URL(`https://coywolf.com${path}`);
	return { url, request: new Request(url, { method }), cache, locals: {}, site: undefined };
}
const page = async () => new Response("<html><main>page</main></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
const serve = async (path, { method = "GET", cache = routeCache() } = {}) => {
	const response = await coywolfPack({}, [paginationMiddleware])(context(path, cache, method), page);
	await Promise.allSettled(globalThis.__waitUntil);
	return { response, cache };
};

test("middleware: with Short page URLs on, GET and HEAD /page/N/ get one 301 to /N/ (query kept), kept at the edge with the redirects' and the generation's tags, no-cache for browsers", async () => {
	// Pagination (the numbered links) is off: Short page URLs doesn't need it.
	freshIsolate(d1({ shortPageUrls: true }));
	const { response, cache } = await serve("/news/web-development/page/2/?s=coyote");
	assert.equal(response.status, 301);
	assert.equal(response.headers.get("Location"), "/news/web-development/2/?s=coyote", "site-relative: the edge cache is shared by every hostname");
	assert.equal(response.headers.get("Cache-Control"), "no-cache");
	assert.equal(cdnHeader(cache), `public, max-age=${PAGE_REDIRECT_EDGE_MAX_AGE}`);
	assert.ok(cache.options.tags.includes("coywolf-redirects"), "a redirect save clears it (a stored rule for the URL wins)");
	assert.ok(cache.options.tags.some((t) => t.startsWith("coywolf-gen-")), "a Features save clears it");

	const head = await serve("/page/3", { method: "HEAD" });
	assert.equal(head.response.status, 301);
	assert.equal(head.response.headers.get("Location"), "/3/", "one hop, with the trailing slash");
	assert.equal((await serve("/page/1/")).response.headers.get("Location"), "/");
	assert.equal((await serve("/news/page/1/?s=x")).response.headers.get("Location"), "/news/?s=x");

	// Everything else goes on to the site.
	for (const [path, method] of [
		["/news/page/2/", "POST"],
		["/_emdash/api/content/posts/page/2/", "GET"],
		["/_emdash/page/2/", "GET"],
		["/news/2/", "GET"],
		["/page/03/", "GET"],
		["/news/", "GET"],
	]) {
		const { response: passed } = await serve(path, { method });
		assert.equal(passed.status, 200, `${method} ${path}`);
		assert.equal(passed.headers.get("Location"), null);
	}
});

test("middleware: the site's trailing-slash policy, and a protocol-relative path stays on the site", async () => {
	freshIsolate(d1({ pagination: true, shortPageUrls: true }));
	configureContentUrls({ trailingSlash: "never" });
	try {
		assert.equal((await serve("/news/page/2/")).response.headers.get("Location"), "/news/2");
		assert.equal((await serve("/page/1")).response.headers.get("Location"), "/");
	} finally {
		configureContentUrls({});
	}
	configureContentUrls({ trailingSlash: "always" });
	try {
		assert.equal((await serve("/news/page/2")).response.headers.get("Location"), "/news/2/");
	} finally {
		configureContentUrls({});
	}
	const url = new URL("https://coywolf.com/x");
	url.pathname = "//evil.example/page/2/";
	const cache = routeCache();
	const response = await coywolfPack({}, [paginationMiddleware])({ url, request: new Request(url), cache, locals: {}, site: undefined }, page);
	assert.equal(response.headers.get("Location"), "/evil.example/2/");
});

test("middleware: inert with Short page URLs off; on, it redirects with Pagination on or off", async () => {
	for (const switches of [{ pagination: true }, { shortPageUrls: false }, { pagination: true, shortPageUrls: false }, {}]) {
		freshIsolate(d1(switches));
		const { response } = await serve("/news/page/2/");
		assert.equal(response.status, 200, JSON.stringify(switches));
	}
	for (const switches of [{ shortPageUrls: true }, { pagination: false, shortPageUrls: true }, { pagination: true, shortPageUrls: true }]) {
		freshIsolate(d1(switches));
		const { response } = await serve("/news/page/2/");
		assert.equal(response.status, 301, JSON.stringify(switches));
		assert.equal(response.headers.get("Location"), "/news/2/");
	}
});

test("middleware: the bases option leaves /tag/page/2/ (the tag \"page\") for the theme; without it every /page/N/ redirects", async () => {
	freshIsolate(d1({ shortPageUrls: true }));
	paginationPack({ bases: { "/tag/": 1, "/author/": 1, "/search/": 1 } });
	try {
		for (const path of ["/tag/page/2/", "/author/page/3", "/search/page/2/?x=1", "/tag/page/1/"]) {
			const { response } = await serve(path);
			assert.equal(response.status, 200, `${path} goes on to the theme's route`);
			assert.equal(response.headers.get("Location"), null);
		}
		assert.equal((await serve("/tag/coyotes/page/2/")).response.headers.get("Location"), "/tag/coyotes/2/");
		assert.equal((await serve("/tag/page/page/2/")).response.headers.get("Location"), "/tag/page/2/");
		assert.equal((await serve("/search/coyote/page/2/?x=1")).response.headers.get("Location"), "/search/coyote/2/?x=1");
		assert.equal((await serve("/news/page/2/")).response.headers.get("Location"), "/news/2/");
		assert.equal((await serve("/page/2/")).response.headers.get("Location"), "/2/");
	} finally {
		paginationPack();
	}
	// The option is the module's, set again each time the pack is built: none, and /tag/page/2/ redirects like any other.
	assert.equal((await serve("/tag/page/2/")).response.headers.get("Location"), "/tag/2/");
});

test("middleware: registered right after the Redirect Manager's, so stored rules win", () => {
	const modules = readFileSync(new URL("../src/modules.ts", import.meta.url), "utf8");
	assert.match(modules, /redirectsMiddleware, paginationMiddleware,/);
	assert.match(modules, /\(o\) => \(o\.pagination === false \? null : paginationPack\(o\.pagination \?\? \{\}\)\),\n[^\n]*\n\t\(o\) => \(o\.pagination === false \? null : shortPageUrlsPack\(\)\),/);
	assert.equal(paginationMiddleware.feature, "shortPageUrls");
	assert.equal(paginationMiddleware.ownsCache, true);
});

// ── The module and its switches ───────────────────────────────────

test("modules: Pagination and Short page URLs are two modules with a main switch each, both off by default, neither a part of the other", () => {
	const pack = paginationPack();
	const shortUrls = shortPageUrlsPack();
	assert.deepEqual([pack.id, pack.label, pack.features.map((f) => [f.id, f.label, f.default])], ["pagination", "Pagination", [["pagination", "Pagination", false]]]);
	assert.deepEqual([shortUrls.id, shortUrls.label, shortUrls.features.map((f) => [f.id, f.label, f.default])], ["shortPageUrls", "Short page URLs", [["shortPageUrls", "Short page URLs", false]]]);
	for (const module of [pack, shortUrls]) {
		assert.deepEqual(module.adminPages, []);
		assert.equal(module.hooks, undefined);
		assert.equal(module.routes, undefined);
	}
	assert.deepEqual(FEATURES.map((f) => f.id), ["pagination", "shortPageUrls"]);
	for (const f of FEATURES) {
		assert.equal(features.featureCatalog().find((c) => c.id === f.id)?.default, false, f.id);
		// A part ("a.b") is forced off with its module (resolveFeatures) and its switch is disabled on the Features page.
		assert.ok(!f.id.includes("."), `${f.id} is a main switch`);
	}
	const state = (stored) => [features.resolveFeatures(stored).pagination, features.resolveFeatures(stored).shortPageUrls];
	assert.deepEqual(state({}), [false, false]);
	assert.deepEqual(state({ shortPageUrls: true }), [false, true], "Short page URLs on its own");
	assert.deepEqual(state({ pagination: false, shortPageUrls: true }), [false, true], "turning Pagination off leaves the page URLs alone");
	assert.deepEqual(state({ pagination: true }), [true, false]);
	assert.deepEqual(state({ pagination: true, shortPageUrls: true }), [true, true]);
	// Each description says the other switch is separate.
	assert.match(FEATURES[0].description, /Short page URLs is a switch of its own/);
	assert.match(FEATURES[1].description, /Works with Pagination on or off/);
});

test("countEntries: null with Pagination off, without a query; countQuery refuses what it can't mirror", async () => {
	const db = d1({});
	freshIsolate(db);
	assert.equal(await countEntries("posts", { where: { category: "news" } }, { database: db }), null);
	assert.ok(!db.statements.some((q) => q.includes("ec_posts")), db.statements.join("\n"));
	assert.equal(countQuery("Posts; DROP", {}), null, "not a collection slug");
	assert.equal(countQuery("posts", { where: { byline: [] } }), 0, "an empty byline list matches nothing");
	const plain = countQuery("posts", {}, null);
	assert.deepEqual(plain.binds, ["published"]);
	assert.equal(plain.taxonomies, 0);
	const filtered = countQuery("posts", { status: "draft", locale: "fr", where: { category: ["news", "seo"], byline: "g1", tag: undefined } }, { defaultLocale: "en", locales: ["en", "fr"] });
	assert.deepEqual(filtered.binds, [JSON.stringify(["category"]), "posts", "draft", JSON.stringify(["fr"]), "posts", "category", JSON.stringify(["news", "seo"]), JSON.stringify(["fr"]), "posts", JSON.stringify(["g1"])]);
	assert.equal(filtered.taxonomies, 1);
	assert.equal((filtered.sql.match(/\?/g) ?? []).length, filtered.binds.length);
});

test("countQuery: an empty locale is no locale filter, as in EmDash, for the entries and for their terms", () => {
	const config = { defaultLocale: "en", locales: ["en", "fr"] };
	const all = countQuery("posts", { locale: "", where: { category: "news" } }, config);
	assert.ok(!all.sql.includes("c.locale") && !all.sql.includes("t.locale"), all.sql);
	assert.deepEqual(all.binds, [JSON.stringify(["category"]), "posts", "published", "posts", "category", JSON.stringify(["news"])]);
	assert.equal((all.sql.match(/\?/g) ?? []).length, all.binds.length);
	assert.deepEqual(countQuery("posts", { locale: "" }, config).binds, ["published"], "not the default locale, and not an empty one");
	// No locale at all on a site with several: the default one.
	assert.deepEqual(countQuery("posts", {}, config).binds, ["published", JSON.stringify(["en"])]);
	assert.deepEqual(countQuery("posts", { locale: "fr" }, config).binds, ["published", JSON.stringify(["fr"])]);
});

test("countEntries: an empty locale counts every locale's entries; a missing D1 binding or a failed query is null and noted", async () => {
	const db = d1({ pagination: true });
	db.exec(`CREATE TABLE ec_posts (id TEXT PRIMARY KEY, status TEXT, locale TEXT, deleted_at TEXT, translation_group TEXT);
		INSERT INTO ec_posts VALUES ('a', 'published', 'en', NULL, 'a'), ('b', 'published', 'fr', NULL, 'b'), ('c', 'published', 'en', NULL, 'c'), ('d', 'draft', 'en', NULL, 'd');`);
	freshIsolate(db);
	assert.equal(await countEntries("posts", { locale: "" }, { database: db }), 3);
	assert.equal(await countEntries("posts", { locale: "fr" }, { database: db }), 1);
	assert.equal(await countEntries("posts", {}, { database: db }), 3, "one locale configured: no filter");

	const error = console.error;
	const logged = [];
	console.error = (...args) => logged.push(args.join(" "));
	try {
		// The switches are cached (Pagination on), then the binding isn't there: a count that can't be read.
		globalThis.__testEnv = {};
		let before = readFailures();
		assert.equal(await countEntries("posts", {}, { database: "MISSING" }), null);
		assert.equal(readFailures(), before + 1, "noted: the page without its last-page link isn't edge-cached");
		assert.match(logged.at(-1), /no D1 binding named MISSING/);
		before = readFailures();
		assert.equal(await countEntries("nope", {}, { database: db }), null, "no such table");
		assert.equal(readFailures(), before + 1);
	} finally {
		console.error = error;
	}
});

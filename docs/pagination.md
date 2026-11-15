# Pagination

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Numbered page links for archives (home page, categories, tags, authors, search), following the [W3C design system's pagination pattern](https://design-system.w3.org/components/pagination.html), and short page URLs: page 3 of the home page is `https://coywolf.com/3/`, and page 2 of a category is `https://coywolf.com/news/web-development/2/`. The pack ships the parts and the theme's routes use them; nothing changes on a page until the theme renders the `Pagination` component.

There are two switches, both off until you turn them on on the **Features** page (**Coywolf Pack → Features** in the sidebar). Each has its own section there and works without the other: turning Pagination off hides the page numbers and leaves every page URL and canonical as it is.

| Feature | Default | What it does |
| --- | --- | --- |
| `pagination` | off | **Pagination**: numbered page links (first, nearby pages, last) in the `Pagination` component, and the entry count (`countEntries`) for the last-page link. Off, the component shows only Previous and Next, and `countEntries` reads nothing. |
| `shortPageUrls` | off | **Short page URLs**: page 3 is `/3/` (`/news/3/`) instead of `/page/3/`, and old `/page/3/` URLs redirect to it. Off, page links are `/page/N/`, and a `/N/` URL redirects to `/page/N/`. The same with Pagination on or off. |

## What visitors see

A `<nav>` named by a visually hidden "Pagination" heading, with Previous, page links, gaps (…) and Next, on **one line at every width**. Narrow navs show fewer page links rather than wrapping to a second line. Container queries on the nav's wrapper pick one of three levels, so the nav fits its column, not the window:

| Level | Shows | Container width |
| --- | --- | --- |
| 0 | Previous, first, current, last, Next | under 27rem (432px), and in browsers without container queries |
| 1 | Previous, first, current ± 1, last, Next | 27rem to under 39rem |
| 2 | Previous, first, current ± 2, last, Next | 39rem (624px) and wider |

- **Previous and Next** show only an arrow under 32rem (512px), and their text from there. Screen readers hear "Previous page" and "Next page" at every width. They're left out on the first and last pages.
- **Gaps:** at levels 1 and 2, a gap that would hide exactly one page shows that page instead. At level 0 a gap always shows: page 3 of 20 reads "1 … 3 … 20".
- **Long page numbers** get fewer links, so the line never overflows. The widest number decides: the last page, or without a known last page the furthest page the nav shows.
  - Up to 999: the levels above.
  - 1,000 to 9,999: under 39rem the nav shows the level 0 links, and from 39rem current ± 1.
  - From 10,000: every width shows the level 0 links.
- **No known last page** (search, author archives): each level leaves out the last page and its gap.
- **The current page** links to its own URL with `aria-current="page"`, and is bold with a border (not only a color, and never a shadow, which forced colors remove). The other page links are normal weight with no underline, also on themes whose links are all bold, and underlined on hover and keyboard focus.
- **Each number** reads "Page 3" to screen readers. Gaps are hidden from them. Links hidden at the current width are `display: none`, so they're out of the tab order too.
- **Targets** are 2.75rem (44px) square and shrink, never under 24px wide, only when a level is tight. At 320px (288px of content) the level 0 links stay 44×44 up to three-digit page numbers.

With only one page there's no nav at all. Server-rendered, with no script.

## Set it up

coywolf.com is the example throughout. Each step says where to work and what you should see.

### 1. Update the theme's archive routes

In the site's code, give each archive route the page number from `archivePage`, the entry count from `countEntries`, and the `Pagination` component. The [route code](#route-code) below has the home page, categories, tags and search. Do this before turning anything on: with both switches off the component shows Previous and Next with `/page/N/` links, as WordPress did.

1. Open each archive route in the theme. For coywolf.com:
   - `src/pages/[...path].astro` (the home page, categories and search)
   - `src/pages/tag/[...path].astro`
   - `src/pages/author/[...path].astro`
2. Replace the route's own page parsing with `archivePage`, and its Older/Newer links with `<Pagination>`.
3. Answer with `archivePage`'s redirect when it has one: `if (paged.response) return paged.response;`. Don't use `Astro.redirect()` for it (see [Route code](#route-code)).
4. Point each archive page's canonical URL at itself with `pageHref` (page 2's canonical is page 2, not page 1).
5. In `astro.config.mjs`, list the theme's archive routes that sit under a prefix in the pack's `pagination.bases` option, each with how many segments after the prefix are the archive's own name (see [Which URLs it answers](#which-urls-it-answers)). For coywolf.com:

   ```js
   coywolfPlugin({
   	pagination: { bases: { "/tag/": 1, "/author/": 1, "/search/": 1 } },
   }),
   ```

6. Deploy the site.
7. Expected: `https://coywolf.com/page/2/` shows page 2 with Previous and Next links, and `https://coywolf.com/2/` redirects to it (301).

### 2. Turn on Pagination

This step and step 4 don't depend on each other: do either one, or both, in any order (step 3 comes before step 4).

1. In the admin, open **Coywolf Pack → Features**.
2. Turn on **Pagination**.
3. Select **Save**.
4. Expected: archive pages show numbered links. In a wide window, the home page shows "1 2 3 … 312 Next" and its page 10 shows "Previous 1 … 8 9 10 11 12 … 312 Next". Search results show no last page.

### 3. Delete old redirect rules for /page/ URLs

EmDash's own redirects answer before the pack's, so a rule that sends `/page/2/` somewhere (a WordPress import often adds rules that send old page URLs to page 1) would win over Short page URLs. Do this before step 4.

1. In the admin, open **Manage → Redirects** (EmDash's redirects).
2. Search for `page`.
3. Delete every rule whose source is a page URL, with or without a trailing slash. For example:
   - `/page/[n]`
   - `/[archive]/page/[n]`
   - `/tag/[slug]/page/[n]`
   - `/author/[slug]/page/[n]`
4. If Redirect Manager is on, open **SEO → Redirect Manager**, search for `/page/`, and delete those rules there too.
5. Expected: neither list has a rule whose source contains `/page/`.

### 4. Turn on Short page URLs

1. In the admin, open **Coywolf Pack → Features**.
2. Turn on **Short page URLs** (its own section, right below **Pagination**).
3. Select **Save**. The save clears every cached page, and again about five minutes later (the switches reach every Worker isolate within five minutes).
4. Check the redirect from a terminal:

   ```bash
   curl -sI https://coywolf.com/page/2/
   ```

5. Expected: `HTTP/2 301` with `location: /2/`. Page links on the site now read `/2/`, `/news/web-development/2/` and so on.

To turn either switch off again, turn it off on the same page and select **Save**. Nothing 404s, and neither switch changes what the other does:

- **Short page URLs off:** `/2/` redirects to `/page/2/`, and page links read `/page/2/` again.
- **Pagination off:** the component goes back to Previous and Next. Page URLs and canonicals stay as they are (`/2/` while Short page URLs is on).

## Route code

`archivePage(segments, Astro.url, { minBase })` reads the page number from a route's path segments and answers `{ segments, page, form, short, response?, redirect? }`:

- `segments`: the archive's own path, without the page part (`["news", "web-development"]`).
- `page`: the page number, 1 when the URL names none.
- `form`: how the URL named the page, `"short"` (`/2/`), `"folder"` (`/page/2/`) or `null`.
- `short`: whether page URLs are `/N/` (the Short page URLs switch). Pass it to `pageHref`.
- `response`: the answer to return instead of rendering, when the URL names page 1 (`/1/`, `/page/1/`) or uses the form that's switched off. It's a 301 with a site-relative `Location` that keeps the route's prefix and the query string, and `Cache-Control: no-cache`.
- `redirect`: that `Location`, for logs and tests. Set whenever `response` is.

Return `paged.response` as it is. `Astro.redirect(paged.redirect, 301)` sends the same 301 without `Cache-Control`, so a browser may keep it: one that kept `/3/` → `/page/3/` would then bounce between the two URLs once Short page URLs is turned on, since `/page/3/` redirects back to `/3/`.

When the switch can't be read (the database didn't answer for a moment), `archivePage` doesn't guess: neither form redirects to the other, the page renders as it was asked for (`short` follows the URL), and that page is kept out of the edge cache. Only `/1/` and `/page/1/` still go to the base, which is right whatever the switch says.

`minBase` is how many segments the archive itself always has, so a route's own first segments are never read as a page number:

- `0` for a route whose home page pages (`/2/`);
- `1` for `/tag/[...path]`: `/tag/2024/` is the tag "2024", and `/tag/2024/2/` its page 2;
- `2` for `/search/{terms}/` in a catch-all route: `/search/2/` searches for "2".

### Home page and categories

coywolf.com serves its home page and categories from one catch-all route, `src/pages/[...path].astro`:

```astro
---
import { getEmDashCollection } from "emdash";
import { Pagination, archivePage, countEntries, pageHref } from "@coywolf/emdash/astro";

const PER_PAGE = 20;
const segments = (Astro.params.path ?? "").split("/").filter(Boolean);
// /search/{terms}/ keeps its two segments: /search/2/ is a search for "2".
const paged = await archivePage(segments, Astro.url, { minBase: segments[0] === "search" ? 2 : 0 });
// A ready 301 that browsers don't keep (not Astro.redirect, which they may).
if (paged.response) return paged.response;

// The archive at paged.segments: the home page ([]) or a category (["news", "web-development"]).
const category = paged.segments.length ? categoryByPath(paged.segments) : null;
const base = paged.segments.length ? `/${paged.segments.map(encodeURIComponent).join("/")}/` : "/";
const filter = {
	status: "published" as const,
	...(category ? { where: { category: category.slug } } : {}),
	orderBy: { published_at: "desc" as const },
	limit: PER_PAGE,
	offset: (paged.page - 1) * PER_PAGE,
};
// Started together, the count costs the page no extra wait.
const [result, count] = await Promise.all([getEmDashCollection("posts", filter), countEntries("posts", filter)]);
if (Astro.cache?.enabled) Astro.cache.set(result.cacheHint);
// Past the last page: not found (or an entry with an all-digit slug, see below).
if (paged.page > 1 && result.entries.length === 0) return Astro.rewrite("/404");
const canonical = new URL(pageHref(base, paged.page, { short: paged.short }), "https://coywolf.com").href;
---

<!-- the list of posts -->
<Pagination base={base} page={paged.page} perPage={PER_PAGE} count={count} hasMore={result.hasMore} />
```

A category that includes its subcategories passes them all: `where: { category: ["news", "web-development", "seo"] }`. `countEntries` takes the same filter as `getEmDashCollection` and ignores `orderBy`, `limit` and `offset`.

### Tags (and other archives under a prefix)

`src/pages/tag/[...path].astro` gets only the part after `/tag/`, so its first segment is always the tag:

```astro
---
import { getEmDashCollection, getTerm } from "emdash";
import { Pagination, archivePage, countEntries, pageHref } from "@coywolf/emdash/astro";

const PER_PAGE = 20;
const paged = await archivePage(Astro.params.path, Astro.url, { minBase: 1 });
if (paged.response) return paged.response;
const term = paged.segments.length === 1 ? await getTerm("tag", paged.segments[0]) : null;
if (!term) return Astro.rewrite("/404");

const base = `/tag/${encodeURIComponent(term.slug)}/`;
const filter = { status: "published" as const, where: { tag: term.slug }, orderBy: { published_at: "desc" as const }, limit: PER_PAGE, offset: (paged.page - 1) * PER_PAGE };
const [result, count] = await Promise.all([getEmDashCollection("posts", filter), countEntries("posts", filter)]);
if (paged.page > 1 && result.entries.length === 0) return Astro.rewrite("/404");
const canonical = new URL(pageHref(base, paged.page, { short: paged.short }), "https://coywolf.com").href;
---

<Pagination base={base} page={paged.page} perPage={PER_PAGE} count={count} hasMore={result.hasMore} />
```

Author archives work the same way (`minBase: 1`), but leave `count` out: coywolf.com's author lists merge explicit bylines and inferred credits in theme code, so a byline count wouldn't match them. Without a count there's no last-page link, and Next follows `hasMore`.

### Search

Search pages keep the terms on every link with `query`, and pass no count: EmDash's search pages by cursor and has no total. On coywolf.com, `https://coywolf.com/?s=coyote` is the home route with a query, so page 2 is `/2/?s=coyote` (`/page/2/?s=coyote` with Short page URLs off):

```astro
<Pagination base="/" page={paged.page} perPage={PER_PAGE} hasMore={hasMore} query={`?s=${encodeURIComponent(terms)}`} />
```

`archivePage` keeps the query string on its redirect (`paged.response`), and the `/page/N/` redirect keeps it too. Keep search pages `noindex, follow`; give the other archive pages a self-referencing canonical (`pageHref` with the page's own number) and leave them indexable.

### Numeric slugs

A numeric last segment is read as a page number first: `/2024/` is page 2,024 of the home page. Neither coywolf.com nor wellbeing.io has an entry, page, category or tag whose slug is all digits, but one created later is handled this way:

- **Short page URLs on:** the page number wins when that page of the archive exists. When it's empty, the route can look the whole path up as an entry instead. `paged.form === "short"` tells it the number came from the last segment:

  ```ts
  if (paged.page > 1 && result.entries.length === 0) {
  	// /2024/ isn't a page of the home page: maybe it's the page whose slug is "2024".
  	if (paged.form === "short") entry = await findEntry(segments);
  	if (!entry) return Astro.rewrite("/404");
  }
  ```

- **Short page URLs off:** `/2024/` redirects to `/page/2024/` before any lookup, so an all-digit slug at an archive's page position can't be reached while the switch is off.
- **Page numbers** are 1 to 99999 without a leading zero, so `/03/` and `/100000/` are never page numbers.
- **`minBase`** keeps a route's own segments safe: `/tag/2024/` stays the tag "2024".

## The entry count

`countEntries(collection, filter)` counts the entries `getEmDashCollection(collection, filter)` lists across all its pages, with one D1 query that goes in the same batch as the pack's other reads of the moment. It mirrors EmDash 1.5's listing rules:

- not in the trash;
- the filter's status (`published` when it has none), with no date rule (a published entry dated in the future is listed, as EmDash lists it);
- the locale: the filter's, else the request's, else the default one when the site has several, with its alias codes;
- each taxonomy in `where` (`category`, `tag`…): tagged with one of its slugs in that taxonomy, in that locale; several taxonomies must all match;
- `where.byline`: credited to one of those bylines (their translation groups).

An empty locale (`locale: ""`) is no locale filter, as in EmDash.

Any other `where` key is a field filter, which the count doesn't mirror: it answers `null` (no last-page link) rather than a wrong number. It's `null` too while Pagination is off (no query at all) and when the count can't be read (a query error, or a D1 binding that isn't there); that page is then kept out of the edge cache, like any page rendered after a failed read. The count has no cache of its own: it's rendered into the archive page, which is tagged with the collection, so it's fresh whenever the list is.

The last page is `ceil(count / perPage)`, but never before the current page, at least the next page when the list says there's more, exactly the current page when it says there isn't, and never past 99999 (the highest page a URL can name). A count that drifted from the list (an entry published or trashed in between) can't link to a page that doesn't exist. `test/emdash-contract.test.mjs` checks the count against paging through `getEmDashCollection` to the end, for every EmDash version CI runs.

The page size is the template's (`PER_PAGE` on coywolf.com). EmDash's **Posts per page** setting isn't read.

## The /page/N/ redirect

While Short page URLs is on, the pack's middleware answers an old `/page/N/` URL with a 301 to `/N/`:

- **GET and HEAD only.** Other methods and EmDash's own URLs (`/_emdash/…`) go on as they are.
- **One hop.** `/page/1/` goes to the archive's base, and `/page/3` (no trailing slash) goes straight to `/3/`.
- **The query string is kept:** `/page/2/?s=coyote` → `/2/?s=coyote`.
- **The site's trailing-slash policy:** `/3/`, or `/3` when Astro's `trailingSlash` (or the pack's `trailingSlash` option) is `"never"`.
- **Site-relative,** since the edge cache is shared by every hostname the Worker answers. A path that starts with `//` never becomes another host.
- **After the Redirect Manager's middleware,** so a stored rule for the same URL wins.
- **Kept at the edge** for 30 days, tagged with the redirects' tag (any redirect change clears it) and the settings generation (a Features save clears it).
- **Never kept by browsers.** Both directions send `Cache-Control: no-cache`: this redirect, and the theme's `/N/` → `/page/N/` (`archivePage`'s `response`). A browser that kept either one would loop with the other once the switch changes. A route that answers with `Astro.redirect()` instead loses that header.

The theme maps `/N/` to `/page/N/` only while the switch is off, and the middleware maps `/page/N/` to `/N/` only while it's on, so the two never loop. For up to five minutes after a switch is saved, Worker isolates can disagree; the Features save clears every cached page, and again once every isolate has the new switches.

### Which URLs it answers

The middleware doesn't know the theme's routes. While Short page URLs is on, it redirects **every** GET or HEAD whose path ends in `/page/N` (N from 1 to 99999, no leading zero) and isn't under `/_emdash/`, whether or not the theme has an archive there. So a page or entry whose own URL ends that way (a page with the slug `page` and a child `2`, say) can't be reached while the switch is on.

One case needs telling apart: an archive under a prefix whose own name is "page". `https://coywolf.com/tag/page/2/` is page 2 of the tag "page" (in the short form), not the old URL of `/tag/2/`. List the theme's prefix routes in the pack's `pagination.bases` option, each with how many path segments after the prefix always belong to the archive:

```js
// astro.config.mjs
coywolfPlugin({
	pagination: { bases: { "/tag/": 1, "/author/": 1, "/search/": 1 } },
}),
```

- **The number** is the route's `minBase`, counted after the prefix: `1` for `/tag/[...path]` (`minBase: 1`), and `1` for `/search/{terms}/` in the catch-all route (`minBase: 2` there, less the `search` segment itself).
- **With it,** `/tag/page/2/` is left for the theme's tag route, `/tag/coyotes/page/2/` still redirects to `/tag/coyotes/2/`, and `/tag/page/page/2/` (the old URL of the tag "page", page 2) redirects to `/tag/page/2/`.
- **Without it,** `/tag/page/2/` redirects to `/tag/2/`, so page 2 of a tag, author or search named "page" can't be reached while Short page URLs is on. A site with no such tag, author or search loses nothing.
- **The longest prefix** a path is under decides. Prefixes match whole segments, as written in the URL.

## Reference

Everything is exported from `@coywolf/emdash/astro`.

**`<Pagination>` props:**

- `base` (required): the archive's page 1, such as `"/"`, `"/news/web-development/"` or `"/tag/coyotes/"`.
- `page` (required): the current page.
- `perPage` (required): entries per page (the list's `limit`).
- `count`: the entry count from `countEntries`. Leave it out, or pass `null`, for no last-page link.
- `hasMore`: the list's `hasMore`. With a count it keeps the last page honest; without one it decides whether there's a Next link.
- `query`: a query string kept on every link, as any of:
  - a string, with or without the `?` (`"?s=coyote"`, `"s=coyote"`);
  - `URLSearchParams`;
  - a record (`{ s: "coyote" }`).
- `label`: the nav's name (its visually hidden heading). Default "Pagination". Give each nav on a page its own name.
- `headingLevel`: that heading's level, 2 to 6. Default 2.
- `styles`: print the CSS (once per page, before the first nav). Default true; pass false when the theme's own stylesheet includes `PAGINATION_CSS`.
- `database`: the site database the switches are read from, as `archivePage` and `countEntries` take it: a D1 binding name (default `"DB"`) or the binding itself.

**Functions:**

- `archivePage(segments, url, { minBase?, database? })`: see [Route code](#route-code). Answers `{ segments, page, form, short, response?, redirect? }`. `segments` is an array of decoded path segments, or the catch-all parameter's string; `url` is `Astro.url`, or the request's path with its query (`"/news/page/2/?s=coyote"`). It throws when given only a query string (`Astro.url.search`): the redirect is built from the path.
- `countEntries(collection, filter?, { database? })`: see [The entry count](#the-entry-count). Returns a number or `null`.
- `pageHref(base, page, { short, query?, slash? })`: page `page` of the archive at `base`, with the query. `short` comes from `archivePage`. Page URLs end in a slash when the base does (the home page's `/` counts), unless `slash` says otherwise.
- `lastPage(count, perPage, page, hasMore?)`: the clamped last page (`null` without a count), 99999 at most.
- `pageItems(page, last, { hasMore? })`: the page links and gaps, each with the levels it shows at, for a theme that renders its own nav.
- `parsePagePath(segments, { minBase? })`: `archivePage`'s parsing, without the switch or the redirect.
- `PAGE_NUMBER`: the page-number pattern, `/^[1-9]\d{0,4}$/`.
- `PAGINATION_CSS`: the nav's stylesheet.

## Styling

Classes:

- `.cw-pagination-wrap`: the container;
- `.cw-pagination`: the `<nav>`;
- `.cw-pagination__list`: the `<ul>`;
- `.cw-pagination__prev` and `.cw-pagination__next`: the Previous and Next `<li>`s;
- `.cw-pagination__arrow` and `.cw-pagination__text`: the arrow and the text inside them;
- `.cw-pagination__gap`: the gaps.

Each page link's `<li>` has `data-l` with the levels it shows at (`"0 1 2"`).

Theme it with custom properties, on `.cw-pagination` or any ancestor:

- `--cw-pagination-size`: the target size (default `2.75rem`);
- `--cw-pagination-font-size` (default `1rem`, never more than 6.5% of the container's width);
- `--cw-pagination-gap`: the space between items (default 2% of the container's width, 2px to 8px);
- `--cw-pagination-color`: the links' color (default the surrounding text color);
- `--cw-pagination-border`: the current page's border (default `2px solid currentColor`);
- `--cw-pagination-radius` (default `4px`);
- `--cw-pagination-current-bg` and `--cw-pagination-current-color`: the current page's background and text.

For example, in coywolf.com's stylesheet:

```css
.cw-pagination {
	--cw-pagination-color: var(--link);
	--cw-pagination-current-bg: var(--link);
	--cw-pagination-current-color: #fff;
	--cw-pagination-border: 2px solid var(--link);
}
```

The rules that keep the nav on one line and pick its level have class specificity, so a theme's `main li` or `a` rules don't undo them (coywolf.com's `a { border: none }` would otherwise remove the current page's border). The links' own rules are written `.cw-pagination .cw-pagination__list a` (two classes), so they also win over a theme's link rules that come later in the page, hover rules included. They set:

- the size, border, radius and color (the custom properties above);
- the weight: normal, and bold for the current page, so it stands out on a theme whose links are all bold (coywolf.com's `a { font-weight: bold }`);
- the text decoration: none, and an underline on hover and keyboard focus.

To change one of those in a theme, match the selector and add to it (`.cw-pagination .cw-pagination__list a:hover { … }` in a stylesheet after the nav's, or with one more class). The wrapper's margin is a `:where()` default, which any theme rule overrides. There are no transitions or animations.

## Notes

- The module has no settings page and no hooks: the theme passes everything to the component.
- The component reads the switches with the pack's per-isolate cache (no query of its own on most requests).
- An EmDash site with the pack's middleware but no `<Pagination>` in its theme sees no change from either switch, except the `/page/N/` redirect, which only makes sense once the theme serves `/N/`. Turn Short page URLs on only after step 1.

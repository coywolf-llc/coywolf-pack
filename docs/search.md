# Search

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

EmDash has full-text search built in: SQLite FTS5 with BM25 ranking, English stemming, prefix matching, highlighted snippets, a public API (`/_emdash/api/search`), and a `LiveSearch` component. This module adds what it leaves out. Turn on **Search** and its parts on the Coywolf Pack page. Search is off by default; once it's on, **Live results** is on too, and the other parts are off until you turn them on.

- **Search settings** (`search.settings`): a **Search** admin page to choose which collections are searchable, set field weights, pick the tokenizer (English stemming, exact words, or trigram substrings), and rebuild indexes with a progress readout and per-collection entry counts. It calls EmDash's own search API, so it needs EmDash's `search:manage` permission (admins). Fields are made searchable in each collection's schema.
- **Live results** (`search.live`, on by default with Search): matching entries in a dropdown as visitors type into the site's search box, like the Coywolf Search WordPress plugin. See [Live results](#live-results).
- **Search box** (`search.box`): a `SearchBox` component with as-you-type suggestions while **Live results** is on (titles first, then full text, with excerpts), arrow keys, Enter and Escape, a clear button, content-type labels, highlighted matches, screen-reader announcements, and a fade that respects reduced motion. When nothing matches every word, it shows results for any of the words, ranked by how many they contain. Without JavaScript it's a plain search form that submits to your search page.
- **Search rate limit** (`search.rateLimit`): limits each visitor to 120 searches a minute (configurable) on EmDash's public search and suggestion endpoints and the pack's search and live results routes, answering `429` with `Retry-After`. Visitors are keyed by a salted hash of their IP address, never the address itself.

## Live results

With **Live results** on, every public page gets a small deferred script at the end of the body (via EmDash's page fragments, so the layout needs `<EmDashBodyEnd>`): `<script src="/_emdash/api/plugins/coywolf-pack/search/live-client?v=<version>" defer data-cw-live="…">`, with the page's settings in the attribute. The file (about 21 KB, 6.5 KB compressed) has a versioned URL, so browsers download it once and keep it for a year (`immutable`); a new pack version changes the URL. Only the pack middleware serves that file (EmDash's plugin routes can't answer with a JavaScript content type or set its cache headers), so on sites without the middleware the same client is added inline at the end of the body instead. It attaches to any GET form with a search field (`type="search"`, or a field named `s` or `q`), so a theme's own search form works as is; the pack's `SearchBox` has the same dropdown built in. Pages without a search form do nothing with it, and its styles are added only when a form is found.

- **Instant title matches.** The first time a visitor focuses a search field, the script loads a compact title index (every published entry's title, URL and type, newest first, up to 5,000) and sends a tiny warm-up request so the server is ready. From then on, title matches appear as soon as a key is pressed, with no server round trip. Matching ignores case and accents ("ecole" finds "École"); titles that start with what was typed come first, then titles with every word at the start of a word, then titles that contain the words (3+ letters).
- From 2 characters, 120 ms after the last keystroke, it also asks the server, which answers with up to 8 entries: title matches first, then full-text matches (with the any-word fallback). The answer merges into the list without reshuffling it: rows the server also found gain their excerpt in place, its other results are added below, and when the list is full, title matches the server didn't confirm make room. Each row has the title, with the typed words underlined, and an excerpt of about 180 characters around the first match, with the matches in bold and "…" where it was cut. A final **View all results** row opens the search page, the same URL the form submits.
- The first result is selected as results appear, so Enter opens it. Arrow keys move (wrapping, and through View all results), Escape closes the list and a second Escape clears the field, Tab or a click elsewhere closes it, and submitting the form searches as before. Results are real links, so middle-click and "open in new tab" work.
- Accessible as an ARIA combobox: `role="combobox"` with `aria-expanded`, `aria-controls` and `aria-activedescendant` on the field, a `listbox` of `option`s, and a polite live region announcing the result count (with a one-time keyboard hint). When the list fills in twice (instant matches, then the server's answer), the count is announced once, for the final list, unless the server takes longer than 0.7 seconds. A result picked with the arrow keys or the pointer stays picked when the server's answer arrives. A clear (×) button sits inside the field for pointer and touch; Escape does the same from the keyboard. Forced colors are respected, and the fade is skipped for reduced motion.
- It takes the theme's font and text color from the form and its background from the nearest opaque ancestor, and tints with `currentColor`, so it fits light and dark themes without configuration.
- In-flight requests are cancelled as you type, answers are cached per query for the page view, and a slow earlier answer never replaces a newer one. Without JavaScript the form works exactly as before.

Results come from `GET /_emdash/api/plugins/coywolf-pack/search/live?q=…` (optional `limit` up to 20, `collections`, `locale`): published entries only, each with `title`, `titleHtml`, `url`, `type` and `snippet`. `titleHtml` and `snippet` are escaped HTML whose only tags are `<mark>`. Excerpts come from the text EmDash indexed (the searchable fields other than the title). `?warm=1` does nothing but load the search setup into a server isolate (answers `204`). The title index is `GET /_emdash/api/plugins/coywolf-pack/search/index?v=…` (optional `locale`, `collections`): `{ v, types, entries: [[title, url, typeIndex], …] }`.

**Speed and caching.** With the pack middleware installed (`coywolfPack()` in `src/middleware.ts`), the middleware answers both URLs itself, before EmDash's plugin routing:

- With Astro route caching on (Workers Cache in front of the Worker), every successful answer is kept in the edge cache, so repeats don't run the Worker at all: live answers for 5 minutes, the title index for a day when the URL names the current content version (5 minutes for an old page's version). Each is tagged `coywolf-search` and with every searchable collection's slug, which EmDash clears whenever content in that collection changes, so a publish shows up in search at once. Bad input (400), the rate limit's 429, the warm-up's 204 and failures are never kept. Answers sent to the edge carry no `Server-Timing` or `X-Coywolf-Cache` (the edge would hand one render's timings to every later visitor).
- Without route caching, every answer is stored in Cloudflare's cache (the Cache API, per location; live answers for 5 minutes, title indexes for a day) and in a small per-isolate memory cache instead. The key is the query (trimmed, spaces collapsed, lower-cased), `limit`, `collections`, `locale` and the **search content version**. With route caching those two layers are skipped: an isolate that hasn't read a new content version yet would put its old answer back at the edge right after EmDash cleared it. Browsers keep live answers for 60 seconds, and the title index for a year when the page's version matches (its URL changes with every version), 5 minutes otherwise.
- The content version changes whenever published content does (publish, unpublish, update, delete, restore), and when search settings change on the **Search** admin page. New keys miss, so visitors never see results from before an edit; old copies just expire. Other Worker isolates pick up a new version within five minutes (it's read with the feature switches).
- Cache hits skip the database and the rate limit. Misses count against **Search rate limit** when it's on.
- A miss reads the database in a few batched round trips: search settings (cached per isolate for a minute), then title and full-text matches for every collection at once, then excerpts and URL terms at once. The any-word fallback adds one more. That's 2–3 D1 round trips (about 7 statements) where it was 25–31 queries.
- Without route caching, responses carry `Server-Timing` (`cw-search` says `hit-memory`, `hit-edge`, `miss` or `warm`; `cw-d1` counts statements and round trips) and `X-Coywolf-Cache: HIT` or `MISS`. With it, check `cf-cache-status` instead (`HIT` once the edge has the answer).

Without the middleware, the plugin routes run the same batched search, without the Cache API layer.

Tune it in `astro.config.mjs` (defaults shown):

```js
coywolfPlugin({ search: { live: { limit: 8, minChars: 2, debounce: 120, enterOpensTop: true, instant: true, indexMax: 5000 } } });
```

`enterOpensTop: false` leaves nothing selected until the visitor arrows to a result, so Enter runs a full search. `instant: false` skips the title index (server results only). `indexMax` caps the title index (newest entries kept); at 5,000 entries it's roughly 100–150 KB compressed, loaded once per content version.

To measure on a live site:

```sh
# A miss, then a hit (same URL: the edge cache keys on the exact query string).
curl -s -o /dev/null -D - "https://coywolf.com/_emdash/api/plugins/coywolf-pack/search/live?q=wolf%20$RANDOM" | grep -iE "cf-cache-status|cache-control"
curl -s -o /dev/null -D - "https://coywolf.com/_emdash/api/plugins/coywolf-pack/search/live?q=wolf" | grep -iE "cf-cache-status"
# The title index and the warm-up.
curl -s --compressed -o /dev/null -w "%{size_download} bytes, %{time_total}s\n" "https://coywolf.com/_emdash/api/plugins/coywolf-pack/search/index?v=x"
curl -s -o /dev/null -D - "https://coywolf.com/_emdash/api/plugins/coywolf-pack/search/live?warm=1" | grep -i server-timing
```

## Search box

```astro
---
import { SearchBox } from "@coywolf/emdash/astro";
---
<SearchBox action="/search" collections={["posts", "pages"]} placeholder="Search articles" />
```

Props: `action` (your search page, default `/search`), `name` (`q`), `label`, `showLabel`, `placeholder`, `collections`, `locale`, `minChars` (2), `debounce` (200 ms; its answers come from the same edge-cached live results route), `limit` (8), `showType`, `showSnippets`, `submitButton`, `value`, `class`, and `id` (set a different one for each box on a page). Its script (about 4 KB minified, 2 KB compressed) and styles load only on pages that render it, and nothing at all is sent while **Search box** is off. Suggestions are real links, so middle-click and "open in new tab" work.

Colors are CSS custom properties with light and dark defaults. Override them on `.cw-search`:

```css
.cw-search {
  --cw-search-bg: #fff;
  --cw-search-fg: #1a1a1a;
  --cw-search-muted: #5c5c5c;
  --cw-search-border: #d4d4d4;
  --cw-search-active-bg: #f1f1f1;
  --cw-search-active-border: currentColor;
  --cw-search-active-fg: inherit;
  --cw-search-mark: rgb(255 214 0 / 0.35);
  --cw-search-radius: 0.5rem;
}
```

Suggestions come from the live results route (above); with **Live results** off the SearchBox is a plain search form with a clear button. `GET /_emdash/api/plugins/coywolf-pack/search/query?q=…&mode=suggest` still returns EmDash's results plus each entry's URL (from the collection's URL pattern) and type label. Use the same OR fallback on your search page:

```astro
---
import { searchWithFallback } from "@coywolf/emdash/astro";
const q = Astro.url.searchParams.get("q")?.trim() ?? "";
const { items, fallback } = q ? await searchWithFallback(q, { limit: 20 }) : { items: [], fallback: false };
---
{fallback && <p>No results for all of your words. Showing results for some of them.</p>}
{items.map((item) => <a href={item.url}>{item.title}</a>)}
```

Fallback results aren't paginated (the best 50 are ranked together).

## Rate limit setup

The limit is enforced by a [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding when you add one. Its limit and period (10 or 60 seconds) come from `wrangler.jsonc`:

```jsonc
"ratelimits": [
  { "name": "SEARCH_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } }
]
```

```js
coywolfPlugin({ search: { rateLimiter: "SEARCH_RATE_LIMITER" } });
```

- `rateLimiter`: the binding's name. Counting happens at Cloudflare (per location), so it holds across Worker isolates. Blocked requests get `Retry-After: 60`.
- Without a binding, each Worker isolate counts on its own (`requestsPerMinute`, default 120; `0` turns it off). That's best effort: it stops one client hammering one isolate, but it isn't a hard limit.
- Optional Worker secret `SEARCH_RATE_LIMIT_SALT` for the IP hash (recommended; a fixed built-in salt is used otherwise, so keys agree across isolates).
- Requires the pack middleware (`coywolfPack()` in `src/middleware.ts`). The admin endpoints (enable, rebuild, stats) aren't limited.

For a hard limit that never reaches your Worker, use a Cloudflare WAF rate limiting rule instead of (or as well as) this feature. The free plan includes one: **Security → WAF → Rate limiting rules**, match `URI Path starts with /_emdash/api/search` or `URI Path starts with /_emdash/api/plugins/coywolf-pack/search/`, counted per IP, for example 60 requests per 10 seconds with a 10-second block.

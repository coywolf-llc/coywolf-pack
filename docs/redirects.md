# Redirects

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

EmDash's built-in Redirects (**Manage → Redirects**) handle site-relative page redirects. This module covers what they can't, and leaves the rest to EmDash. Compared with EmDash 1.3:

| | EmDash Redirects | Coywolf Pack Redirects |
|---|---|---|
| External destinations (affiliate links such as `/visit/partner`, articles that moved to another site) | No: destinations must be site paths | Yes |
| File paths (old WordPress `/wp-content/uploads/` image URLs, `/file.pdf`) | No: its middleware skips any path with a file extension | Yes |
| Patterns | Whole-segment placeholders only (`/old/[slug]`, `/docs/[...rest]`) | Regular expressions with `$1`–`$9` substitution |
| Query strings | Dropped | Passed on to the destination (unless it has its own), before any `#anchor`: `/pricing/?x=1` → `/?x=1#pricing` |
| Bulk import and export | No (only seed files and full-site transfers) | Paste or upload JSON, CSV or TSV (a Coywolf SEO export from WordPress works as is); export as CSV or JSON |
| URL tester | No | Yes |
| Notes | A group label | A note per rule |
| Trashed or unpublished entries | Nothing | Prompt for a redirect or 410, undone when the entry comes back (see [Removed content](#removed-content)) |
| Changed slugs, categories or parent pages | A redirect built from the collection's URL pattern (posts without a pattern get `/posts/<slug>`, which isn't a real URL; category and parent paths are never covered) | A 301 from the old public URL to the new one (see [Slug changes](#slug-changes)) |
| Edge caching | Doesn't cache redirects (checks its rules before a page is cached) | Kept in Workers Cache for 30 days, cleared on any redirect change, along with the pages at new sources |
| Status codes, trailing slashes, hit counts, enable/disable | Yes (also 451) | Yes (301/302/307/308/410) |

Left to EmDash, which does them and the pack doesn't: **automatic redirects when an entry's slug changes**, the **404 log** with "create redirect from this 404", and **loop detection** across rules. When both have a rule for the same path, EmDash's wins (its middleware runs first).

Features: exact paths (with or without a trailing slash) or regular expressions with `$1`–`$9` substitution, 301/302/307/308/410, enable/disable, notes, hit counts, a URL tester, bulk import (paste or choose a file: JSON, or tab/comma-separated `source, target, type, is_regex` rows; a Coywolf SEO export from WordPress works as is), and **Export** as CSV or JSON. Rules are stored in the site's D1 database (`coywolf_redirects`), so backups include them.

A capture group can't send visitors to another site: with a site-path destination such as `/$1`, leading slashes from the capture are collapsed (`/blog//evil.com` → `/evil.com` on your site, never `//evil.com`), and a destination that names its host (`https://coywolf.com$1`) only redirects when the result keeps that host. A destination whose host is itself a capture (`https://$1/`) is followed as written.

## Setup

Add the middleware to `src/middleware.ts` (step 3 of [Getting started](../README.md#getting-started); `coywolfRedirects` is its earlier name and still works):

```ts
import { sequence } from "astro:middleware";
import { coywolfPack } from "@coywolf/emdash/middleware";

export const onRequest = sequence(coywolfPack(), /* your middleware */);
```

Each Worker isolate keeps the rules' index in memory: the pattern rules (usually few), compiled in source order, and the set of exact sources (up to 5,000). A request whose path isn't an exact source, which is almost every page request, makes no D1 read for its redirect at all; one whose path is reads its rule (one indexed read of the request path, trailing slash removed), so an exact rule changed or deleted in another isolate is never served from memory. On a site with more than 5,000 exact rules every request reads its own, as before. The index is read again after a redirect change: at once in the isolate that made it, and in others within five minutes, when they see the new settings generation (pack admin saves; see [Database reads](internals.md)) or the new redirects version (`plugin:coywolf-pack:redirects:version`, written when a content hook changes rules: slug changes and removed-content rules), both read with the feature switches, or after ten minutes. Until then another isolate may render the page at a new rule's source instead of redirecting; a redirect save's settling clear (about five minutes later) clears those pages again. The patterns load through their own index (`coywolf_redirects_patterns`, added to existing sites the next time the Redirects page opens). Exact rules win over patterns. Patterns are tried only on paths up to 1,024 characters (longer paths match exact rules only), and a pattern that repeats a group which itself repeats, such as `^/(a+)+$`, is refused when it's saved or imported: on a path that almost matches, such a pattern takes exponential time, and every request without an exact rule runs every pattern. Write it without the nested repeat (`^/blog/[a-z0-9/-]+$` rather than `^/blog(/[a-z0-9-]+)+$`); patterns saved before 0.35.19 keep working. When the feature switches aren't cached, the lookups go in the same D1 batch as them. Concurrent requests of a cold isolate share one load of the index, but none waits for another request's load more than 2.5 seconds: then it loads the index itself, so a load whose request was canceled can't hold up the requests after it (see [Shared reads have deadlines](internals.md#shared-reads-have-deadlines)). Serving never writes: the `coywolf_redirects` table is created by the first admin write (saving or importing a rule), and until then there are simply no rules. Hits are counted after the response is sent, batched per isolate: the hits a rule gets within a second are one D1 write, so a flood of uncached requests (a query string skips the edge cache) can't make a write each.

**Edge caching.** With Astro's route caching on (`cacheCloudflare()`), GET and HEAD redirects (and 410s) are kept in the edge cache (Workers Cache) for 30 days, keyed by path and query string, and tagged `coywolf-redirects`. Any redirect change (saving, deleting, enabling or disabling, importing, resolving removed content, rewinding the database) purges that tag, as does **Clear pages and images**; a deploy starts with an empty cache. Browsers keep a redirect for an hour (`Cache-Control: max-age=3600`); the edge lifetime and tag go in `Cloudflare-CDN-Cache-Control` and `Cache-Tag`, which Cloudflare strips before the response reaches the browser. Cached site-path redirects carry a site-relative `Location`, since the edge cache is shared by every hostname the Worker answers. Repeat requests served from the cache never reach the Worker, so **hits count requests the Worker answered**, not every visit. Without route caching, redirects send `Cache-Control: private, max-age=3600` and are never edge-cached.

`coywolfPack()` takes no redirect options; `serveRedirect(url, env, waitUntil, { cacheSeconds })` (ten minutes by default) is the longest time to keep the rules' index.

## Removed content

Feature **Redirects → Removed content** (`redirects.trashPrompt`, off by default). When a published entry is trashed or unpublished, the admin asks right away what its old URL should do:

- **Redirect to…** creates a Coywolf redirect rule (301 by default) from the old URL.
- **Return 410 Gone** creates a 410 rule, telling search engines the page is gone for good.
- **Decide later** (or Escape) closes the prompt. Until you decide, the old URL returns 404.

Trashing several entries at once (bulk trash) asks once, listing each of them. Undecided URLs stay listed in a **Removed content** panel on the Redirects page, with the same choices plus **Dismiss**, which forgets an entry (for example, when the URL should simply 404).

The old URL is resolved the way EmDash resolves it: the collection's URL pattern (`{slug}`, `{id}`, and date tokens from the publish date), or `/<collection>/<slug>`. Locale prefixes aren't added. Drafts that were never published aren't listed or prompted for. Restoring an entry from the trash (it comes back as a draft) or republishing it removes it from the list and **undoes the rule its decision created**, as long as that rule still has its `Removed:` note and the same source; a republished entry must also be back at the same URL (a new slug keeps the redirect from the old one, and a later publish back at the old URL still undoes it). A redirect that already exists for the old URL is never overwritten or adopted: the decision says so, and you can keep it (Dismiss the entry) or change it under Redirects. An entry that turns out to be live after all (its trash failed, or it came back some other way) is forgotten the next time the list is read. Decisions are kept in plugin storage (`redirects_removed`), and the rules they created in `redirects_applied`. The module declares the `content:read` capability for the delete and publish hooks.

How the prompt knows: EmDash has no admin event for a trash or unpublish, so the pack's admin module watches the admin's own content API calls (`DELETE /_emdash/api/content/<collection>/<id>` and `POST …/<id>/unpublish`), never altering or reading their responses, then asks the server which of those entries it recorded. The trash is recorded before EmDash answers the request; an unpublish is recorded just after, so the prompt looks again for up to about two seconds when an unpublish isn't listed yet (trashed drafts don't hold it up). If a future EmDash release changes those API paths, the prompt stops appearing, but the Removed content list on the Redirects page keeps working.

## Slug changes

Feature **Redirects → Slug changes** (`redirects.slugChanges`, on by default). When a published entry's public URL changes, because of a new slug, category or parent page, the pack adds a 301 from the old URL to the new one, noted `Slug change: <title>`. The URLs come from the pack's URL resolver (the one the sitemaps and breadcrumbs use, with the site's `urls`, `termParents` and `pageParents` options), so they're the URLs readers and search engines saw.

- **How it knows the old URL.** Each published entry's URL is remembered in plugin storage: recorded from the live row before a save, and after every save or publish. An entry that hasn't been saved since the feature was turned on is recorded at its first save, before anything changes.
- **No chains or loops.** Renaming A → B → C points the A rule at C. Renaming back to A deletes the A → B rule, which would otherwise shadow the live page.
- **Hand-made rules win.** If a rule someone made already answers the old URL, it's left as is (and logged). Only rules noted `Slug change:` are ever edited or deleted.
- **Limits.** Translations are skipped (they can share a slug with the default-language entry, so a rule could shadow it); only default-language entries get rules. Recording happens in `content:beforeSave`, which EmDash runs only when a save carries content fields, and within a 1.5-second budget (EmDash fails a save whose beforeSave hook times out), so a slug-only API update to an entry never saved since the feature was turned on isn't caught. A category changed through EmDash's separate terms endpoint fires no content hook; its redirect is made at the entry's next save or publish.
- **A URL that's live again is freed.** When an entry is published at a URL that a slug-change rule redirects (another entry took the old slug, or this one moved back), that rule is deleted.
- **Replaces EmDash's own.** EmDash writes a pattern-based redirect for the same change (its Redirects, group "Auto: slug change"). Without a URL pattern its paths don't exist (`/posts/<slug>`); for a nested page it writes a top-level `/<old>` that can hijack a real page there; and its middleware answers before the pack's, without the trailing slash. When the pack makes its rule, it deletes EmDash's auto row for the same change (source ending in the old slug, destination ending in the new one). EmDash's in-memory redirect cache may serve that row for a short while in other isolates.

## Export redirects from WordPress (Coywolf SEO)

```bash
wp db query "SELECT source, target, type, is_regex FROM wp_coywolf_seo_redirects"
```

Paste the output into **Redirects → Import**.

## Export and move redirects

**Export** (next to Import) downloads every rule as CSV (for spreadsheets) or JSON. Either file imports back on this or any other site through **Import → Choose file**, updating rules with the same source:

- CSV columns: `source, target, type, is_regex, enabled, note`, then `hits, last_hit, created_at, updated_at` for reference (Import ignores them, so hit counts start over on the new site). Cells that a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`) get a leading apostrophe, which spreadsheets hide; Import removes it again, so the round trip is exact.
- JSON: an array of rules, as the list route returns them.

Import takes up to 5,000 rules (2 MB) at a time; split bigger files.

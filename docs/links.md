# Link Manager

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

An inventory of every link in your content, ported from Coywolf SEO's Link Manager:

- **Inventory**: link marks in Portable Text (including nested blocks, columns and tables), linked images, buttons, embeds, iframes, and URL fields. Each link shows its anchor text, internal or external, and the entries that use it, with links to edit them. Entries are re-indexed when they're saved, deleted or restored; **Scan content** (and each scheduled run, when **Scheduled link checking** is on) indexes everything else.
- **Checking** (sub-feature, off by default): nothing runs in the background until **Scheduled link checking** is on. Then a scheduled run starts **weekly** (or **daily** or **monthly**: **How often** in **Link Manager → Settings**), scans the content, then checks the links that are due, continuing hourly until it's done. Each check is HEAD first, then GET when HEAD is refused, 10-second timeout, up to 5 redirects recorded. Statuses are **OK**, **Redirect** (with where it ends up), **Broken** (4xx/5xx), **Blocked** (403, 429, LinkedIn's 999, or a Cloudflare/AWS/DataDome bot challenge: the link is probably fine but can't be verified from a server), and **Error** (DNS, TLS, timeout, too many redirects). Within runs, broken links and errors are due again after a day, the rest after a week. **Check now** and **Recheck** run checks on demand.
- **Bulk actions**: **Replace** a URL across every entry that uses it (link text and other formatting are kept), **Unlink** (the text stays; linked images and buttons lose their link; embeds are left alone), **Ignore** a URL or domain, and **Recheck**. Ignore rules can also be domains, exact URLs, wildcards (`https://coywolf.com/visit/*`) or regular expressions. Ignored links aren't checked or counted.
- **Export CSV**: every link matching the current filters (all pages), with its status, HTTP code, final URL, the entries that use it, and their anchor text. Filter by **Broken** first for a list to hand to whoever fixes links. Cells that look like spreadsheet formulas are prefixed with an apostrophe.
- **Dashboard widget** with the number of broken links.
- **In the entry editor and content lists** (EmDash 1.4+, admins only, while Link Manager is on): a saved entry's sidebar has a **Link status** section with its links, worst first, each with its status and HTTP code, and a link to Link Manager. Content lists get a **Links** column: "2 broken", "1 blocked", or "5 OK" per entry. The column reads a whole page of entries in one request (one D1 read per 90 entries, over the references' `entryKey` index), not one per row. Both only read; the inventory is updated when entries are saved.
- **Entries view** (sub-feature, off by default): inbound internal link counts per published entry and orphans. See [Inbound links and orphans](#inbound-links-and-orphans).

Feature switches: **Link Manager** (`links`), **Scheduled link checking** (`links.check`) and **Inbound links and orphans** (`links.inbound`), all off by default.

## Setup

No bindings or secrets, but EmDash needs to know the site URL (**Settings → General**, or `site` in `astro.config`) to tell internal links from external ones; nothing is indexed until it's set. Settings (**Link Manager → Settings**): how often scheduled runs start (daily, weekly or monthly; default weekly), subrequests per check run (default 40), whether to check links to your own site (default on), and a User-Agent override (see [How links are checked](#how-links-are-checked)).

## Notes

- Edits go through EmDash's content API. A published entry is republished so the fix goes live. An entry with unpublished changes (or a schedule) is fixed in its draft only, so its live version keeps the old link until the draft is published (the result message says how many). An entry saved by someone else while the action runs is left alone and reported, so run the action again for it. An editor with the entry open may still overwrite the change on their next save.
- The inventory follows each entry's latest saved version (its pending draft, if it has one). Links inside raw HTML blocks aren't tracked.
- Workers limit subrequests per invocation (50 on Free, 1,000 on Paid), and database calls count. A checked link takes 1–2 requests plus 1 per redirect, and 1 database write; keep **subrequests per check run** under your plan's limit, leaving room for other scheduled jobs. Scheduled runs work in hourly steps (scan steps of about 200 database statements or 60 seconds, then one check run of **subrequests per check run** each hour), so on a big site a run can take several hours or more; raise subrequests per check run on the Paid plan to finish sooner. While Scheduled link checking is off, the hourly tasks read only the feature switches; between runs, they also read one small state row and the frequency. A scan started from the page runs faster while the page is open; admin actions stop at about 150 statements or 25 seconds and continue on the next call.
- Links are stored in plugin storage (`links_urls`, `links_refs`) in the site's D1 database, so backups include them. The list pages through indexed queries; search matches the start of a URL (when it starts with `http` or `/`) or of a domain. Indexing an entry looks up its references with one D1 query on the `entryKey` expression index, with no sort (storage queries always sort by creation time, and for that SQLite picked the generic list index and read every reference row of the site, once per entry scanned). A scan writes only references that are new or changed (an unchanged entry costs that one read and no writes), drops links removed from an entry as it indexes it, and then removes the references of entries it can't visit (deleted, trashed, or in a collection without link fields now): one query lists the entries that have references, and one per 90 of them checks they still exist. Status counts are cached for up to a minute (10 minutes in the dashboard widget).
- Regular-expression ignore rules are limited to 200 characters, and patterns that can take exponential time (repeated groups containing a quantifier or alternation, backreferences) are refused.
## How links are checked

- **From Cloudflare's network.** External links are fetched by the site's Worker, so the requests come from Cloudflare's shared Worker IP addresses, not from your site's address or a browser. Many other Workers share those addresses, and some sites rate-limit or block them as a group: the same reason Bing throttled the pack's IndexNow pings. A link that answers that way shows as **Blocked**, not **Broken**.
- **As itself.** The checker sends an honest user agent that names it, its version, where to read about it, and the site whose links it's checking:

  ```text
  Mozilla/5.0 (compatible; CoywolfPack-LinkChecker/<version>; +https://github.com/coywolf-llc/coywolf-pack/blob/main/docs/links.md#how-links-are-checked) checking links on https://coywolf.com
  ```

  and only `Accept` and `Accept-Language` besides (no browser-only headers such as `Sec-Fetch-*`). Earlier releases presented it as desktop Chrome; a browser's name from a data center is what bot rules look for, and it hid who was asking. A site owner who sees the checker in their logs can tell whose links it's checking. **User-Agent override** (Link Manager → Settings) replaces it, for example with a name a partner site allows.
- **Blocked.** HTTP 403, 429, LinkedIn's 999, or a bot challenge (Cloudflare's `cf-mitigated: challenge`, AWS WAF, DataDome, PerimeterX): the link probably works for people, but a server can't confirm it. Blocked links aren't counted as broken, in the report or the dashboard widget. A HEAD request that's refused is tried again with GET, so a page that's really gone (404) still shows as Broken. If many links to one site are Blocked, **Ignore** its domain, or check a few by hand.

## Checking internal links

A Worker can't fetch its own custom domain over HTTP (Cloudflare answers 522), so internal links are checked through a service binding to the site's own Worker. Add it to `wrangler.jsonc` (use your Worker's `name`):

```jsonc
"services": [{ "binding": "SELF", "service": "coywolf" }]
```

Without the binding, internal links are listed but not checked (they're never reported as broken).

## Inbound links and orphans

With **Inbound links and orphans** on, the Link Manager page has two views: **Links** (the inventory above) and **Entries**. Entries lists every published entry with how many of your entries link to it:

- **Orphans** (the default filter): published entries, not set to No index, that no other entry links to. Readers and search engines find them only through menus, lists or search.
- **Linked entries** and **All entries**, filtered by collection or searched by title or path, sorted by fewest or most inbound links, title, or most recently updated.
- For each orphan, up to three published entries of the same collection that share the most categories or tags with it (newest first among ties): good places to add a link to it. Each links to its editor.
- **Export CSV** of the current filter (title, collection, path, inbound links, whether it's an orphan, No index, last update, editor link).

How it counts:

- It reads the links Link Manager already indexed, so scan your content first (**Links → Scan content**); saves keep it current after that. Nothing runs in the background, and nothing new is stored.
- A link counts for the entry at its path, or at the end of its redirect when Link Manager has checked it. Query strings, fragments, `www.` and a trailing slash don't matter.
- Each linking entry counts once per target, only when it's published, and never for itself.
- Only links in content count. Navigation, footers, category and tag pages, and other theme templates aren't in Link Manager's index, so an entry linked only from a menu is still an orphan here.
- Paths come from each collection's URL pattern (and the pack's `urls` option, see [Content URLs](content-urls.md)). Locale prefixes aren't applied, so on a multilingual site, links to translated pages may not match their entries.

Reads, from the site's D1 database: one statement per routable collection (sent as one batch) for the published entries, the term reads their URL patterns need, one statement for the internal links, and the references in pages of 5,000 rows on the storage table's primary key. Related entries for the orphans on the page are one batch of one statement each.

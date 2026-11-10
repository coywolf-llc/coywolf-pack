# Insights

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

One admin page (**Coywolf Pack → Insights**) with reports EmDash doesn't have: what Cloudflare's edge saw, how fast the site is for real visitors, traffic, Google Search, and what visitors search for on the site. Turn on **Insights** on the **Features** page, then each report with the switch next to its title on the Insights page (or on the Features page). Everything is off by default, and a report makes no outside request until its part is on and the page is open.

| Part | Feature id | What it shows | Needs |
| --- | --- | --- | --- |
| Edge errors and crawlers | `insights.edge` | 404 and 410 paths (files, images and the media host included), 5xx errors, requests per crawler, for the last 30 days | The read-only Cloudflare token, with **Zone → Zone → Read** and **Zone → Analytics → Read** |
| Core Web Vitals | `insights.vitals` | Real visitors' LCP, INP and CLS at the 75th percentile, for 7 and 30 days, and the slowest pages | Cloudflare Web Analytics for the site; the read-only token (**Account Analytics → Read**, **Account Settings → Read**) |
| Web Analytics beacon | `insights.beacon` | Adds Cloudflare's beacon to every public page | The site's Web Analytics token (public) |
| Fathom traffic | `insights.fathom` | Visitors, pageviews and top pages for 7 and 30 days | The Fathom site ID and a read-only Fathom API key |
| Google Search Console | `insights.searchConsole` | Clicks, impressions, CTR, average position, top queries and pages for 28 days | A Google service account's JSON key, added as a user on the property |
| Search insights | `insights.search` | Top searches and searches with no results, for 30 or 90 days | **Search** on |

Each report is kept in plugin KV: an hour for the Cloudflare and Fathom reports, six hours for Search Console. **Refresh** reads again (at most once a minute; Search Console every ten minutes). After a failed reading the provider isn't asked again for a few minutes, and the last good reading, if any, shows with what went wrong. A reading belongs to the settings it was made with, so changing a site ID, property, key or token reads again at once. Every call has a deadline (20 seconds for Cloudflare, 15 for Fathom and Google) and goes through EmDash's `ctx.http` with the plugin's allowed hosts: `api.cloudflare.com`, `api.usefathom.com`, `oauth2.googleapis.com` and `www.googleapis.com`.

Credentials are encrypted secret settings (the Fathom API key and the Google key: **Insights — Fathom API key** and **Insights — Google service account key (JSON)** on the plugin's Settings page, or on the Insights page), never shown again after they're saved, and never logged. The Cloudflare token is the one the Performance page's usage card uses (**Cloudflare usage** on the Settings page, or the `USAGE_API_TOKEN` Worker secret).

## Edge errors and crawlers

EmDash's 404 log only sees requests that reach its redirect middleware, which skips every path with a file extension. And the media host (`media.example.com`) is served by R2 without the Worker, so EmDash never hears about it at all. This report reads what Cloudflare answered for the site's zone, so it sees old `/wp-content/uploads/…` image URLs, missing PDFs and broken media links too.

- **Not found (404) and gone (410):** the 50 most requested paths on the site and its media host, with **Create redirect** for each site path. That opens the **Redirect Manager** with **New redirect** filled in (the link is `/_emdash/admin/plugins/coywolf-pack/redirects?source=/old-path/`). Media host paths can't be redirected by the Worker; use a Cloudflare redirect rule for those. EmDash's own `/_emdash/` routes and `/cdn-cgi/` have no action.
- **Server errors (5xx):** totals by status and the paths that answered with them. 52x statuses are Cloudflare's own, when the Worker didn't answer in time or at all.
- **Crawlers:** requests per crawler, named from the user agent with the crawler directory of [Robots.txt](robots.md) (a user agent can claim to be anyone), plus a count of other self-declared bots. When the zone's plan can query Cloudflare's `verifiedBotCategory` field, the report also lists the bots Cloudflare verified, by category.

How it reads: the zone is found once with **Zone → Zone → Read** and remembered. The `settings` node of the GraphQL Analytics API says how far back and how wide a query the zone may make and which fields it may use (checked once a day). Then one query to `httpRequestsAdaptiveGroups` with six grouped nodes, eyeball requests only (`requestSource: "eyeball"`): requests per host, error statuses, 404 paths, 410 paths, 5xx paths, and user agents. It uses only fields Cloudflare documents for every plan (`edgeResponseStatus` ranges, `clientRequestHTTPHost`, `clientRequestPath`, `userAgent`), adding `verifiedBotCategory` only when the zone lists it.

- Every plan keeps at least 31 days of this dataset, and a Free zone can query 30 days at a time ([Cloudflare's changelog, October 2, 2026](https://developers.cloudflare.com/changelog/post/2026-10-02-30-days-analytics-on-every-plan/)). Zones that allow less get a shorter window, and the card says how many days it covers.
- The data is [sampled](https://developers.cloudflare.com/analytics/graphql-api/sampling/), so counts are estimates. A path seen a few times may be missing.
- The GraphQL API allows 300 queries per five minutes per user. A reading is two queries at most (one when the zone's limits are known), at most once a minute.

### The token

Add two zone permissions to the read-only token: **Zone → Read** and **Analytics → Read** (the zone one, not Account Analytics), in a policy scoped to **All Domains** or the site's domain. For a new token, Cloudflare's pre-filled form selects Account Analytics → Read, Account Settings → Read, Zone → Read and Analytics → Read; the guide on the card has the steps. Errors name the missing permission.

## Core Web Vitals

Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift at the 75th percentile, from real visits measured by [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/), for the last 7 and 30 days, with a Good, Needs improvement or Poor label from web.dev's thresholds (2.5 s / 4 s, 200 ms / 500 ms, 0.1 / 0.25), and the slowest of the 50 most visited pages (with at least five measured views). Known bots are left out (`bot: 0`). CLS is measured in Chromium browsers only, and a low-traffic site needs a few days of visits before the numbers mean much.

The card reads the account's `rumWebVitalsEventsAdaptiveGroups` dataset with the read-only token (**Account Analytics → Read**), filtered by the site's Web Analytics tag. It finds the tag in the account's Web Analytics sites (`GET /accounts/{id}/rum/site_info/list`, **Account Settings → Read**): the site with the saved beacon token, or the one for the site's host or zone. Without Account Settings → Read, the beacon token stands in for the tag. The account is the `CF_ACCOUNT_ID` Worker variable, the Clean Image URLs account, the zone's account, or the token's only account.

### The beacon

**Web Analytics beacon** adds a small script at the end of every public page (through EmDash's page fragments, so the layout needs `<EmDashBodyEnd>`). Once the page is parsed, it adds Cloudflare's beacon as a module script, `https://static.cloudflareinsights.com/beacon.min.js?token=<token>` (the form Cloudflare documents for tag managers), unless the page already has one. So a theme that loads the beacon itself, or Cloudflare's automatic setup, never makes a page report twice. It never blocks rendering. Saving the token clears the page cache, so cached pages get the beacon at once.

Why the pack adds it: Cloudflare's automatic setup injects the beacon "as the HTML response passes through Cloudflare's edge" for proxied sites, but Cloudflare doesn't document whether that covers responses a Worker makes, and reports from Workers sites disagree (some see it injected on Workers custom domains, others never do). None of the eight sites had the beacon on November 9, 2026. The pack's beacon works either way.

The token is the 32-character `token` in Cloudflare's snippet (`data-cf-beacon='{"token": "…"}'`), found under **Web Analytics → the site → Manage site**. It's public (every page carries it), so it's a plain setting.

Privacy: Web Analytics sets no cookies and uses no localStorage, doesn't fingerprint visitors by IP address or user agent, and doesn't log query strings ([Cloudflare's docs](https://developers.cloudflare.com/web-analytics/data-metrics/core-web-vitals/)). The beacon loads from `static.cloudflareinsights.com` and reports to `cloudflareinsights.com`; a site with a Content Security Policy must allow both. It's one more script on every page, next to Fathom on the sites that use it.

## Fathom traffic

Visitors (Fathom's `visits`, unique site visits) and pageviews for the last 7 and 30 days, and the 10 most viewed pages for each, from [Fathom's API](https://usefathom.com/api): `GET https://api.usefathom.com/v1/aggregations` with `entity=pageview`, `entity_id=<site ID>`, `aggregates`, `date_from`, and for pages `field_grouping=pathname`, `sort_by=pageviews:desc` and `limit=10`. Days start at midnight UTC (Fathom's dashboard uses the site's time zone, so numbers can differ slightly).

- **Site ID:** the code of letters in the site's Fathom settings, also the `data-site` value of the embed code (recollect.fyi's is `JZZOSMVG`).
- **API key:** [Fathom → API](https://app.usefathom.com/api) → **Create new**, with **Site-specific** read access to this site or **Read only (all sites)**. Fathom shows the key once. It's saved as an encrypted secret.
- **Cost and limits:** each API request counts toward the Fathom plan's monthly pageviews. The included API allowance is 600 requests an hour and 5 at once, per account. A reading is four requests, made one after another, at most once an hour and only while someone has the Insights page open.
- **From Workers:** Fathom's documentation names no limits by IP address (its limits are per account), and a community Fathom SDK lists Cloudflare Workers among its tested runtimes. Fathom doesn't promise it, though, and Bing throttles Workers' shared IP addresses, so a 429 or 403 here could be that. The card shows what Fathom answered (it sends `Accept: application/json`, so errors come back as JSON with a message).

## Google Search Console

Clicks, impressions, click-through rate and average position for the last 28 full days (Pacific Time, Search Console's), and the 10 top queries and pages by clicks, from the [Search Analytics API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) (`POST https://www.googleapis.com/webmasters/v3/sites/{property}/searchAnalytics/query`, `type: "web"`, `dataState: "all"`, so the newest days may still change; the card says from when).

How it signs in, in the Worker, with no library: a JWT with `alg: "RS256"` and the key's `kid`, claims `iss` (the service account's email), `scope: https://www.googleapis.com/auth/webmasters.readonly`, `aud: https://oauth2.googleapis.com/token`, `iat` and `exp` (an hour), signed with WebCrypto (`RSASSA-PKCS1-v1_5`, SHA-256) and exchanged at `https://oauth2.googleapis.com/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) for an access token, as [Google's server-to-server guide](https://developers.google.com/identity/protocols/oauth2/service-account) describes. The access token stays in the isolate's memory until five minutes before it expires; neither it nor the key is ever stored elsewhere, logged or put in an error message. Of the pasted JSON key, the pack keeps only `client_email`, `private_key`, `private_key_id` and `project_id`.

- **Property:** empty uses the property the service account can see for the site (its domain property `sc-domain:…` first, then a URL-prefix property for the site's origin). Or enter `sc-domain:example.com` or `https://example.com/`.
- **Setup:** create a service account in Google Cloud, turn on the **Google Search Console API** for its project, create a JSON key, and add the service account's email as a user on the property in Search Console (**Settings → Users and permissions → Add user**, Restricted is enough). Both domain and URL-prefix properties work. The guide on the card has each step with links. Some Google Cloud organizations block key creation by policy (`iam.disableServiceAccountKeyCreation`); an organization admin has to allow it.
- **Limits:** Search Analytics allows 1,200 queries a minute per site and per user, with extra load limits on queries grouped by page or query ([Google's limits](https://developers.google.com/webmaster-tools/limits)). A reading is three small queries (four when the property is found automatically), kept six hours.
- **From Workers:** Google's quotas are per project, site and user, not per IP address, and nothing in Google's docs restricts Workers' addresses.

## Search insights

Top searches and searches that found nothing, over 30 or 90 days. No-result searches are the cheapest content-gap list a site has (missing glossary terms, say).

What's counted: the searches the site answers. That's the site's search page (`searchWithFallback()` from `@coywolf/emdash/astro`, first page only), the `search/query` route in search mode, and live results as visitors type (`search/live`, answered by the pack middleware or the plugin route). A visitor's keystrokes count as the one search they ended with: searches wait a few seconds in the isolate's memory, and a live query that's the start of another one in the same batch (`coy`, then `coyote`) is dropped, while one typed and then submitted counts once. What isn't counted: repeats Cloudflare answers from its edge cache (with Workers Cache on, a live answer is cached for five minutes), so popular searches are undercounted; and clicks on results, since results are plain links and the pages they open are usually served from the cache too. The card says so ("counts searches the site answered").

Privacy first:

- Only the normalized query (lower case, spaces collapsed, at most 80 characters) and two counts per day (searches, and searches with no results) are stored. Never an IP address, a user agent, a time of day, a referrer or anything else about who searched.
- Queries that look like an email address or @handle, a long number (seven or more digits, with or without spaces and dashes: phones, cards, order numbers) or a key or token are dropped before they're counted.
- The report never lists a query seen fewer than two times.
- Counts older than 90 days are deleted every day (the `insights-search-prune` task runs whatever the switches say), and **Delete search data** deletes them all at once.

Writes are cheap: noting a search is synchronous and does nothing while the part is off. Searches are written after the response (`waitUntil`) in one D1 batch per isolate every few seconds, one upsert per query and day, into plugin storage (collection `searchInsights`, indexed by day). Each isolate writes at most 500 distinct queries a day, so a flood of made-up searches can't grow the table without bound. **Search rate limit** ([Search](search.md#rate-limit-setup)) limits how fast one visitor can search at all.

## Options

```js
coywolfPlugin({ insights: { database: "DB" } }); // the D1 binding search insights write to (default "DB")
coywolfPlugin({ insights: false }); // leave the module out
```

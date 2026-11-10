# Cloudflare Checkup

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

The settings of your site's Cloudflare zone that matter for an EmDash site served by a Worker, on one page, each with what it does in plain words, what it's set to and what to do. A few clear-cut ones have a one-click fix; the rest link to the switch in the Cloudflare dashboard. It's off until you turn on **Cloudflare Checkup** on the **Features** page; its page is then **Coywolf Pack → Cloudflare Checkup**. The settings are read from Cloudflare each time the page opens (**Check again** reads them again). Reading changes nothing.

| Feature switch | Default | What it does |
| --- | --- | --- |
| `cloudflareCheckup` | off | The Cloudflare Checkup page |

## What it checks

| Row | Recommended for a Workers-served EmDash site | One-click fix |
| --- | --- | --- |
| **Speed Brain** | Off. Cloudflare's docs say it ["will not prefetch on routes that run Workers"](https://developers.cloudflare.com/speed/optimization/content/speed-brain/), which is every page of the site, so it only adds a `Speculation-Rules` header and a request for its rules file. Use the pack's [Speculation Rules](performance.md#speculation-rules) instead. | **Turn off Speed Brain** |
| **Tracking parameters** | Served from the cache (see [below](#tracking-parameters)). A site step, not a button. | No |
| **Crawler Hints** | On. Read as the [Discovery page](discovery.md#crawler-hints) reads it; Cloudflare doesn't let API tokens switch it. | No (dashboard only) |
| **Early Hints** | On (optional, low risk). Cloudflare sends a page's `Link` headers (the pack's preconnect to the media host) as a `103` before the page. The gain is small when pages answer from the cache in 60–90 ms. | No |
| **HTTP/3** | On. Free, and browsers fall back to HTTP/2 on their own. | No |
| **Always Use HTTPS** | On, once every hostname in the zone works over HTTPS. | **Turn on Always Use HTTPS** |
| **Minimum TLS version** | TLS 1.2 or newer. TLS 1.0 and 1.1 were dropped by browsers in 2020. | **Require TLS 1.2** (never lowers 1.3) |
| **TLS 1.3** | On. | No |
| **HSTS** | Recommended, but only in the dashboard and only once everything works over HTTPS; start with a max-age of 1 day, without Include subdomains or Preload. Hard to undo: browsers remember it for the max-age, Include subdomains covers every subdomain in the zone (apps included), and Preload takes months to leave. | **Never** |
| **Rocket Loader** | Off. It rewrites script tags and can run them in a different order, which breaks some scripts and analytics. | No |
| **Email Address Obfuscation** | Off. Cloudflare's docs say it doesn't touch HTML a Worker adds, so it likely does nothing on the site; off means nothing rewrites the pages. Leave it on if another hostname in the zone relies on it. | No |
| **Automatic HTTPS Rewrites** | Either. It fixes `http://` links in old content (WordPress imports); once links use `https://` (Link Manager lists them), it has nothing left to do. | No |
| **Bot Fight Mode** | Off unless the site is under attack. On the Free plan no rule can make an exception, so it can stop feed readers, link checkers and other tools robots.txt allows. | No |
| **Block AI bots** | Your choice. With [Robots.txt Rules](robots.md) on as well, decide in one place: Cloudflare blocks AI crawlers whatever robots.txt allows. | No |
| **Cloudflare-managed robots.txt** | Off: Cloudflare adds its own lines to the top of the site's robots.txt, and two sets of rules can contradict each other. | No |
| **AI Labyrinth** | Either: it only affects crawlers that ignore robots.txt. | No |

Each row links to its page in the Cloudflare dashboard (with the account and zone in the address once the zone is found). Settings are read from `GET /zones/{id}/settings`, plus `GET /zones/{id}/settings/{name}` for any the bulk answer leaves out; the bot rows from `GET /zones/{id}/bot_management`.

## Zone-wide settings

Every row except Tracking parameters is a setting of the zone, so it applies to **every hostname in the zone**, not only the site. Some zones serve apps besides the site (`essential.support` and `recollect.fyi` do). The page lists the zone's other proxied hostnames (from its DNS records, with **DNS → Read** on the token), and every fix's confirmation repeats which hostnames it reaches. A zone whose only proxied hostname is the site says so.

## One-click fixes

**Turn off Speed Brain**, **Turn on Always Use HTTPS** and **Require TLS 1.2** each:

- show what they change before anything happens: the setting, its current value and the new one, what that means for visitors, and the zone's other hostnames, in a confirmation;
- change exactly one zone setting (`PATCH /zones/{id}/settings/{name}`), and only when it isn't already at the new value (pressing twice changes nothing, and **Require TLS 1.2** never lowers TLS 1.3);
- report the result in a toast (or Cloudflare's error, with the permission the token needs) and read the zone again;
- clear no cached pages: no page changes.

HSTS is never a button. Neither is anything the pack can't undo safely or that Cloudflare doesn't let tokens change (Crawler Hints).

## Tokens

**Reading** uses the read-only token the Performance page already has ([Cloudflare usage](performance.md#cloudflare-usage): saved on the plugin's Settings page, or the `USAGE_API_TOKEN` Worker secret). In its policy scoped to **All Domains** (or **Specified Domains** → the site's domain), it needs:

- **Zone → Read**: finds the zone (also used by Crawler Hints);
- **Zone Settings → Read**: the settings rows;
- **DNS → Read** (optional): lists the zone's other hostnames;
- **Bot Management → Read** (optional): the bot rows.

A part the token can't read says which permission to add; the page has the steps and a pre-filled form for a new token.

**Fixes** use a separate setup token, so the read-only token stays read-only: **Zone → Read** and **Zone Settings → Edit**, for the site's domain only (a pre-filled form is on the page: *Coywolf Pack Cloudflare setup*). Paste it in **Setup token** on the page and save it (stored encrypted as `cloudflareSetupToken`), or leave it unsaved to use it just for the next fix. It's only ever sent to `api.cloudflare.com`, never logged or returned. You can delete it in Cloudflare once you're done.

## Tracking parameters

Workers Cache keys a page by its path and query string, so `/?utm_source=newsletter` is a different entry from `/`: campaign, newsletter and social visitors get a freshly built page (on coywolf.com, a MISS at about 250 ms against 60–90 ms for the cached page), and click IDs (`fbclid`, `gclid`) are unique per click, so those visitors always do.

**Why it isn't a setup button.** The owner's plan was a zone URL Rewrite (Transform) Rule that drops the parameters before the cache. Cloudflare's Workers Cache docs rule that out: under [Limitations](https://developers.cloudflare.com/workers/cache/limitations/), "Rulesets that modify request or response before cache" are among the zone features that don't apply to Workers Caching, with the advice to transform the request in the Worker; the [cache key docs](https://developers.cloudflare.com/workers/cache/cache-keys/) and the [overview](https://developers.cloudflare.com/workers/cache/) suggest a gateway in the Worker for exactly this ("strip a tracking query parameter before caching? Rewrite the URL … in a gateway Worker"). Rules language does have a `remove_query_args()` function for URL rewrites, but a rule using it wouldn't change what Workers Cache keys on. So the pack exports a wrapper for the site's Worker instead (checked November 2026).

**The site step.** In the site's `src/worker.ts`:

```ts
// src/worker.ts (coywolf.com)
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { stripTrackingParams } from "@coywolf/emdash/worker";

export { PluginBridge };

export default stripTrackingParams({
	...handler,
	// keep the site's own fetch wrapper, if it has one
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler);
```

It needs a compatibility date of 2025-11-17 or later (or the `enable_ctx_exports` flag) so the Worker can call itself through its cache (`ctx.exports.default`); a `SELF` service binding works too. Without either, requests are served as they come.

**How it works.**

- Requests without tracking parameters (nearly all of them) never run the wrapper: they're answered from the cache before the Worker runs, as now.
- A GET or HEAD whose URL has tracking parameters misses the cache and reaches the Worker. The wrapper asks the Worker again, through its cache, for the same URL without them: usually a cache hit, so nothing is rendered and D1 isn't read. On a miss the clean page is rendered and cached, as a plain visit would.
- The answer isn't stored again under the tracking URL (`Cache-Control: private`), so EmDash's and the pack's purges of the clean page keep working.
- A same-origin redirect (a slash-less URL, a moved page) gets the removed parameters added back to its `Location`, so the visitor lands with them in the address bar. A redirect to another site never gets them.
- EmDash's admin and API (`/_emdash/`), Astro's `/_astro/` and `/_image` are never touched, nor are other methods.

**Analytics.** Fathom, Google Analytics and other analytics that run in the browser read the address bar, which still has the parameters: a server-side change doesn't reach them. Only code on the server would stop seeing them.

**Cost.** Each request with tracking parameters runs the Worker once (the wrapper only, a few milliseconds of CPU) and is billed twice: the request and the call through the cache. Requests without them cost nothing extra.

**Parameters removed** (`TRACKING_PARAMS` and `TRACKING_PREFIXES`, exported): every `utm_…`, `fbclid`, `gclid`, `gclsrc`, `gbraid`, `wbraid`, `dclid`, `msclkid`, `twclid`, `ttclid`, `li_fat_id`, `igshid`, `yclid`, `srsltid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `mkt_tok`, `_ga`, `_gl` and `ref`. Names match case-insensitively; everything else in the query stays exactly as sent. A site whose server code reads one of them passes its own list: `stripTrackingParams(handler, { params: TRACKING_PARAMS.filter((p) => p !== "ref") })`.

**Check it.** `curl -sI 'https://coywolf.com/?utm_source=test' | grep -i coywolf-tracking` prints `coywolf-tracking-params: removed`. The checkup's Tracking parameters row shows **Removed before the cache** once the wrapper is deployed.

## Setup

Nothing beyond the switch and the tokens. The plugin asks for `network:request` (host `api.cloudflare.com`).

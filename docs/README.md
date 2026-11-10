# Coywolf Pack documentation

Coywolf Pack is an [EmDash](https://emdashcms.com) plugin that enhances existing features and adds features not available in EmDash. It helps you manage your site like a pro and ensure it's absurdly fast for humans and bots.

- **Absurdly fast for humans and bots:** cached pages answer in 60–90 ms, cache warming keeps pages cached for visitors and crawlers alike, and images come straight from Cloudflare's edge.
- **Enhances what EmDash already does:** redirects, search, robots.txt, schema, images and RSS feeds go well beyond EmDash's built-in versions and starter templates.
- **Adds what EmDash doesn't have:** backups and restore, link checking, videos, reviews, AI enrichment and more.
- **Manage your site like a pro:** turn each feature on or off, see your Cloudflare usage and estimated bill, and finish a move from WordPress. On a new site everything starts off, so installing changes nothing until you're ready, and updating never turns a feature on.
- **Free and open source** (MIT).

Start with [Getting started](../README.md#getting-started) to install the pack and turn features on.

## Site-wide

- [Performance](performance.md): Workers Cache, clearing after deploys and edits, cache warming, Cloudflare usage, Speculation Rules
- [Cloudflare Checkup](cloudflare-checkup.md): the zone settings that matter for a Workers-served site, one-click fixes, and serving links with tracking parameters from the cache
- [Content URLs](content-urls.md): telling the pack how your theme routes entries (category paths, nested pages)
- [Internals](internals.md): how the pack keeps D1 reads to about one round trip per uncached page, and the deadlines on reads requests share

## Modules

- [Insights](insights.md): edge errors and crawlers, Core Web Vitals, Fathom traffic, Google Search Console, search insights
- [Clean Image URLs](images.md)
- [Backups](backups.md)
- [Alerts & Digest](alerts.md): email alerts and a weekly digest
- [Redirect Manager](redirects.md)
- [Schema & Social](schema.md)
- [Social Images](social-images.md): generated Open Graph images
- [Discovery](discovery.md): RSS feed, news sitemap, llms.txt, security.txt, Crawler Hints status
- [Robots.txt](robots.md)
- [Search](search.md)
- [Link Manager](links.md): with inbound link counts and orphans
- [Content Audit](content-audit.md)
- [Headings & TOC](headings.md)
- [Breadcrumb Nav](breadcrumbs.md)
- [Code Blocks](code-blocks.md)
- [File Downloads](files.md)
- [Private Form Uploads](form-uploads.md)
- [Videos](videos.md)
- [Reviews](reviews.md)
- [Custom Blocks](custom-blocks.md)
- [AI Enrichment](ai.md)

## The Cloudflare API token

One token covers every Cloudflare feature. It's saved as **Cloudflare API token** on the plugin's Settings page (or set as the `CLOUDFLARE_API_TOKEN` Worker secret), and its guide there opens Cloudflare's account token form with the name **Coywolf Pack** and these permissions:

| Permission | Policy | Pre-filled | For |
| --- | --- | --- | --- |
| Account Analytics → Read | Entire Account | Yes | Cloudflare usage, Insights |
| Account Settings → Read | Entire Account | Yes | Finding the account and its plan |
| Workers R2 Storage → Edit | Entire Account | Yes | Set up media host, Retention on Cloudflare, large uploads |
| Stream → Edit | Entire Account | Yes | Videos |
| Workers → Metadata Read-Only | Entire Account | By hand | Cloudflare usage (this site's Worker and database, Workers Logs) |
| Account Rulesets → Read | Entire Account | By hand | Set up media host |
| Browser Run → Edit | Entire Account | By hand | Social Images |
| Radar → Read | Entire Account | By hand | The Robots.txt crawler list |
| Zone → Read | This site's domain | Yes | Finding the site's zone |
| Zone Settings → Edit | This site's domain | Yes | Cloudflare Checkup, Set up media host |
| DNS → Edit | This site's domain | Yes | Set up media host, Cloudflare Checkup |
| Analytics → Read | This site's domain | Yes | Insights (edge errors and crawlers) |
| Transform Rules → Edit | This site's domain | By hand | Set up media host |
| Cache Rules → Edit | This site's domain | By hand | The media host's cache rule |
| Cache Purge → Purge | This site's domain | By hand | Clearing the media host's images |
| Bot Management → Read | This site's domain | By hand | Cloudflare Checkup's bot rows |

Skip any whose feature you don't use: a page whose token lacks a permission says which one to add. For the domains policy, **Specified Domains → this site's domain** is recommended (the token can then change only this site); **All Domains** lets one token work on every site in the account. The account comes from `CF_ACCOUNT_ID`, the Clean Image URLs account ID, or the token's only account (remembered); a page that needs it asks for the account ID under **Advanced** when the token sees more than one. Large uploads make R2's S3 keys from the token (its ID and its SHA-256). D1 → Edit is never part of it: restores keep the `BACKUPS_API_TOKEN` Worker secret.

Older per-feature tokens keep working until the Cloudflare API token is saved; [Internals](internals.md#which-cloudflare-token-a-feature-uses) has the order. **Features → Cloudflare API token** shows which are still saved and removes them (the File Downloads R2 key pair only when you tick it).

## Moving to EmDash

- [Migrating from WordPress](wordpress-import.md)

## Maintaining

- [Releasing](releasing.md): tags, GitHub releases and npm publishing

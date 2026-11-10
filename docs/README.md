# Coywolf Pack documentation

Coywolf Pack is an [EmDash](https://emdashcms.com) plugin that enhances existing features and adds features not available in EmDash. It helps you manage your site like a pro and ensure it's absurdly fast for humans and bots.

- **Absurdly fast for humans and bots:** cached pages answer in 60–90 ms, cache warming keeps pages cached for visitors and crawlers alike, and images come straight from Cloudflare's edge.
- **Enhances what EmDash already does:** redirects, search, robots.txt, schema, images and RSS feeds go well beyond EmDash's built-in versions and starter templates.
- **Adds what EmDash doesn't have:** backups and restore, link checking, videos, reviews, AI enrichment and more.
- **Manage your site like a pro:** turn each feature on or off, see your Cloudflare usage and estimated bill, and finish a move from WordPress. Everything starts off, so installing or updating changes nothing until you're ready.
- **Free and open source** (MIT).

Start with [Getting started](../README.md#getting-started) to install the pack and turn features on.

## Site-wide

- [Performance](performance.md): Workers Cache, clearing after deploys and edits, cache warming, Cloudflare usage
- [Content URLs](content-urls.md): telling the pack how your theme routes entries (category paths, nested pages)
- [Internals](internals.md): how the pack keeps D1 reads to about one round trip per uncached page, and the deadlines on reads requests share

## Modules

- [Clean Image URLs](images.md)
- [Backups](backups.md)
- [Redirect Manager](redirects.md)
- [Schema & Social](schema.md)
- [Discovery](discovery.md): RSS feed, news sitemap, llms.txt, Crawler Hints status
- [Robots.txt](robots.md)
- [Search](search.md)
- [Link Manager](links.md)
- [Headings & TOC](headings.md)
- [Breadcrumb Nav](breadcrumbs.md)
- [Code Blocks](code-blocks.md)
- [File Downloads](files.md)
- [Private Form Uploads](form-uploads.md)
- [Videos](videos.md)
- [Reviews](reviews.md)
- [Custom Blocks](custom-blocks.md)
- [AI Enrichment](ai.md)

## Moving to EmDash

- [Migrating from WordPress](wordpress-import.md)

## Maintaining

- [Releasing](releasing.md): tags, GitHub releases and npm publishing

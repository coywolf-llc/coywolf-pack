# Coywolf Pack for EmDash

Coywolf Pack is an [EmDash](https://emdashcms.com) plugin that enhances existing features and adds features not available in EmDash. It helps you manage your site like a pro and ensure it's absurdly fast for humans and bots.

- **Absurdly fast for humans and bots:** cached pages answer in 60–90 ms, cache warming keeps pages cached for visitors and crawlers alike, and images come straight from Cloudflare's edge.
- **Enhances what EmDash already does:** redirects, search, robots.txt, schema, images and RSS feeds go well beyond EmDash's built-in versions and starter templates.
- **Adds what EmDash doesn't have:** backups and restore, link checking, videos, reviews, AI enrichment and more.
- **Manage your site like a pro:** turn each feature on or off, see your Cloudflare usage and estimated bill, and finish a move from WordPress. On a new site everything starts off, so installing changes nothing until you're ready, and updating never turns a feature on.
- **Free and open source** (MIT).

**New here?** Follow [Getting started](#getting-started) to install it and turn features on.

## Modules

Every module starts off on a new site. Turn on only the ones you want on the **Features** page (in the sidebar, **Coywolf Pack → Features**). Sites set up before 0.36.0 keep Redirect Manager, its Slug changes part and Backups the way they were: those three were on by default until then.

| Module | What it does |
| --- | --- |
| [Performance](docs/performance.md) | Always on: keeps Cloudflare's edge page cache correct (cleared after deploys and edits), optional cache warming, a Cloudflare usage card with the estimated bill, and optional Speculation Rules (the next page prefetched on hover) |
| [Cloudflare Checkup](docs/cloudflare-checkup.md) | The zone settings that matter for a Workers-served site (Speed Brain, HTTPS, HSTS, Early Hints, features that rewrite pages, bot settings), each with what to do, and one-click fixes for the clear-cut ones |
| [Insights](docs/insights.md) | 404s (files and the media host too), server errors and crawlers from Cloudflare's analytics, real visitors' Core Web Vitals, Fathom traffic, Google Search Console, and what visitors search for |
| [Clean Image URLs](docs/images.md) | Images from a `media.` subdomain on R2, resized to the sizes the theme uses, cached for a year |
| [Backups](docs/backups.md) | Backups of the D1 database and R2 media, rewind with undo, restore to a new database |
| [Alerts & Digest](docs/alerts.md) | Emails when a backup fails, links break, the Cloudflare bill estimate passes a threshold, an update is out or the content audit gets worse, plus a weekly digest |
| [Redirect Manager](docs/redirects.md) | External, file-path and regex redirects, bulk import and export, and automatic redirects for slug changes and removed content (alongside EmDash's own Redirects page) |
| [Schema & Social](docs/schema.md) | One Schema.org graph per page (publisher, articles, authors), breadcrumbs, robots directives, Open Graph, custom JSON-LD |
| [Social Images](docs/social-images.md) | A generated Open Graph image (title, site name, logo, your colors) for entries without one, made with Cloudflare Browser Run |
| [Discovery](docs/discovery.md) | An RSS feed, a Google News sitemap, llms.txt with Markdown versions of entries, a self-renewing security.txt, and whether Cloudflare's Crawler Hints is on |
| [Robots.txt](docs/robots.md) | Plain-English robots.txt rules with a guided editor, a verified crawler directory, history and a URL tester |
| [Search](docs/search.md) | Fast as-you-type results on EmDash's full-text search, a search box, and rate limiting |
| [Link Manager](docs/links.md) | Every link in your content with its status, bulk replace, unlink and ignore, and inbound link counts with orphans |
| [Content Audit](docs/content-audit.md) | A weekly report of missing SEO titles and descriptions, alt text and social images, thin and stale entries, heading problems and broken internal links, with trends |
| [Headings & TOC](docs/headings.md) | Linkable headings and a Table of Contents block |
| [Breadcrumb Nav](docs/breadcrumbs.md) | An accessible breadcrumb trail for themes and as a block |
| [Code Blocks](docs/code-blocks.md) | Server-side syntax highlighting, themes, language labels, copy buttons |
| [File Downloads](docs/files.md) | Download cards, stable download URLs with counts, uploads of any size |
| [Private Form Uploads](docs/form-uploads.md) | Files sent through EmDash Forms go to a private bucket that only admins can read |
| [Videos](docs/videos.md) | Cloudflare Stream library, a video block with a light embed, video schema and sitemap, plays and likes |
| [Reviews](docs/reviews.md) | A review block (rating, pros and cons) with Review schema |
| [Custom Blocks](docs/custom-blocks.md) | Note, Details, Affiliate disclosure, Quote, Testimonial and Podcast links blocks |
| [AI Enrichment](docs/ai.md) | Wikidata-grounded entities for schema, meta descriptions and image alt text |
| [WordPress Migration](docs/wordpress-import.md) | Finishes a move from WordPress after EmDash's own Import: blocks, authors, category parents, media URLs and redirects |

## Getting started

Coywolf Pack is a native (trusted) EmDash plugin: you add it to your site's code and deploy, rather than installing it from EmDash's plugin directory (which lists only sandboxed plugins, and those can't read the database or buckets directly). The steps below use coywolf.com as the example: change the names to your site's.

### What you need

- An EmDash site (1.4 or later) on Cloudflare Workers, using EmDash's Cloudflare adapter with a D1 database bound as `DB` and an R2 media bucket bound as `MEDIA`. That's the setup EmDash's own Cloudflare starter creates.
- The site's code in a folder (or Git repository) you can edit and deploy, with Node.js and Wrangler.

### 1. Install the package

From the site's folder:

```bash
npm install @coywolf/emdash
```

The package is [`@coywolf/emdash` on npm](https://www.npmjs.com/package/@coywolf/emdash). Each version links to the GitHub commit and workflow run that built it (npm provenance). What changed in each release is under [Releases](https://github.com/coywolf-llc/coywolf-pack/releases).

### 2. Add the plugin to `astro.config.mjs`

Import `coywolfPlugin` and add it to EmDash's `plugins`:

```js
// astro.config.mjs
import { coywolfPlugin } from "@coywolf/emdash";

export default defineConfig({
  // ...
  integrations: [
    emdash({
      // ...your existing database and storage settings
      plugins: [
        coywolfPlugin({
          // Backups is the one module that's added only when you give it a name (it names the backup files).
          backups: { name: "coywolf" },
        }),
      ],
    }),
  ],
});
```

`coywolfPlugin()` with no options works too: every module except Backups is included with its defaults. Each module's page in [docs](docs/README.md) lists its options; set a module to `false` (for example `videos: false`) to leave it out of the site entirely.

### 3. Add the middleware

Several features answer their own URLs before EmDash renders a page: redirects, `/robots.txt` rules, the RSS feed, llms.txt and Markdown versions, file downloads, sitemaps for videos and news, image sizes, and cache warming. They need the pack's middleware, first in `src/middleware.ts`:

```ts
// src/middleware.ts
import { sequence } from "astro:middleware";
import { coywolfPack } from "@coywolf/emdash/middleware";

export const onRequest = sequence(coywolfPack() /* , your own middleware */);
```

If the site has no `src/middleware.ts` yet, create it with just these lines.

### 4. Check `wrangler.jsonc`

`DB` and `MEDIA` are all the pack needs to start. Other bindings turn on more features; add them when you turn those features on (each module's page in [docs](docs/README.md) has the details):

```jsonc
// wrangler.jsonc (coywolf.com)
{
  "name": "coywolf",
  "d1_databases": [{ "binding": "DB", "database_name": "coywolf", "database_id": "<D1 database id>" }],
  "r2_buckets": [
    { "binding": "MEDIA", "bucket_name": "coywolf-media" },
    // Backups: a second bucket for backup files.
    { "binding": "BACKUPS", "bucket_name": "coywolf-backups" }
  ],
  // Page cache: Workers Cache in front of the Worker, and the deployed version so cache warming starts after a deploy.
  "cache": { "enabled": true },
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  // Cache warming and checking internal links: the Worker calling itself.
  "services": [{ "binding": "SELF", "service": "coywolf" }],
  // Optional: search, video plays and likes limited per visitor across isolates (namespace_id: one per site in the account).
  "ratelimits": [{ "name": "COYWOLF_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } }]
}
```

API keys and tokens (for AI Enrichment, Videos, Robots.txt's Cloudflare Radar sync, Clean Image URLs setup, Cloudflare usage) are stored encrypted, so the site also needs EmDash's `EMDASH_ENCRYPTION_KEY` secret. EmDash's setup usually creates it; if not:

```bash
npx wrangler secret put EMDASH_ENCRYPTION_KEY
```

Keep that key in a password manager: encrypted settings can't be read without it.

### 5. Deploy

Deploy the site the way you usually do (for example `npx wrangler deploy`, or your CI). Nothing changes for visitors yet: on a new site every feature starts off.

### 6. Turn features on

1. Sign in to the site's admin (`https://coywolf.com/_emdash/admin`).
2. Open **Coywolf Pack → Features** in the sidebar.
3. Turn on the modules you want, and any of their parts. Each module that's on adds its page to one of the pack's sidebar folders: **Coywolf Pack** (Features, Performance, Cloudflare Checkup, Backups, WordPress Migration), **SEO** (Schema & Social, Discovery, Robots.txt, Redirect Manager, Link Manager, Breadcrumb Nav), **Content Tools** (Headings & TOC, Code Blocks, Custom Blocks, Reviews, AI Enrichment, Search) and **Media Tools** (Clean Image URLs, Videos, File Downloads, Private Form Uploads).
4. Open each module's page for its settings and step-by-step guides. A part can also be turned on or off there.

A good first set for most sites:

| Turn on | What you get | Then |
| --- | --- | --- |
| **Update check** | A card on the EmDash dashboard when a new version of Coywolf Pack is out, with the command to install it | Nothing: it checks npm once a day (see [Updating](#updating)) |
| **Performance** (always on) | Page cache lifetimes, clearing after deploys, cache warming | Turn on **Cache warming** on the Performance page (needs `SELF`) |
| **Clean Image URLs** | Images from a `media.` subdomain, resized and cached | Run **Set up media host** on its page (see [Setting up a media host](docs/images.md#setting-up-a-media-host)) |
| **Schema & Social** | Schema.org markup and Open Graph tags | Review the publisher on the Schema page |
| **Redirect Manager** | Redirects EmDash's own can't handle, plus slug-change and removed-content redirects | Import old redirects on the Redirect Manager page |
| **Discovery** | An RSS feed, a news sitemap, llms.txt; Crawler Hints status | Turn on the parts you want on the Discovery page |
| **Backups** | Backups of the database and media, on demand or daily | Add `backups: { name: "coywolf" }` (step 2) and the `BACKUPS` bucket, then turn on the daily backup (see [Backups](docs/backups.md)) |

### Using the admin

- **Features** (**Coywolf Pack → Features**) turns modules and their parts on or off. A module's page also has switches for its parts.
- **Each module's page** holds its settings, grouped into sections, with step-by-step guides. A feature that needs an API key or a binding shows a setup card until it's there.
- **API keys and tokens** can be entered on their module's page or on the plugin's **Settings** page, which lists only those. EmDash stores them encrypted.
- **Saving:** a bar appears at the bottom of a settings page when there are unsaved changes, with **Discard** and **Save** (also Ctrl/⌘+S). The result shows as a notice at the bottom of the screen. Leaving the page with unsaved changes asks first.
- **Hiding EmDash's own pages:** a site that uses Redirect Manager or WordPress Migration instead of EmDash's Redirects or Import can hide those with EmDash's `admin.hiddenNavItems` option in `astro.config.mjs` (for example `emdash({ admin: { hiddenNavItems: ["redirects"] } })`).
- **Language:** the pack's admin pages and docs are in English only; they don't follow EmDash's admin language setting.

### Updating

Install the latest version, then deploy:

```bash
npm install @coywolf/emdash@latest
```

If your `package.json` points at a GitHub tarball URL from before the pack was on npm (0.35.13 and earlier), this command replaces it with the npm version. Updates never turn features on by themselves: new features start off.

**Update notices:** turn on **Update check**, the first switch on the **Features** page. Once a day it asks npm for the newest version of Coywolf Pack. When there's an update, a **Coywolf Pack update** card on the EmDash dashboard and a notice at the top of the pack's pages show the command above, with a **Copy command** button. **Dismiss** hides both for everyone on the site until the next version. The check sends nothing about your site and never updates anything by itself.

### Local development

In development, keep Vite from pre-bundling the plugin. A pre-bundled copy gets its own instance of `emdash`, which breaks plugin error handling. Its UI libraries should stay pre-bundled:

```js
// astro.config.mjs
export default defineConfig({
  vite: {
    optimizeDeps: { exclude: ["@coywolf/emdash"], include: ["@phosphor-icons/react", "@cloudflare/kumo"] },
    ssr: { optimizeDeps: { exclude: ["@coywolf/emdash"] } },
  },
});
```

### Troubleshooting

- **Coywolf Pack isn't in the admin.** Check that `coywolfPlugin()` is in `emdash({ plugins: [...] })` in `astro.config.mjs` and that the site was deployed (or the dev server restarted) after adding it.
- **A module's page isn't in the sidebar.** Its main switch is off: turn it on on the **Features** page (**Coywolf Pack → Features**).
- **Redirect Manager's redirects, `/robots.txt` rules, the feed or downloads don't answer.** The middleware isn't running: check step 3, and that `coywolfPack()` comes before your own middleware in `sequence()`.
- **A feature shows a setup card instead of its settings.** It needs a binding, an API key or `EMDASH_ENCRYPTION_KEY`; the card says which.
- **Pages don't change after an edit.** EmDash and the pack clear cached pages on edits and deploys; **Coywolf Pack → Performance → Clear pages and images** clears everything now. Cloudflare's zone **Purge Everything** doesn't reach the Worker's page cache.
- **Pages time out (524) after 100 seconds, with almost no CPU time in Workers Logs.** A Worker isolate is stuck: before 0.35.16, a request canceled in the middle of a read the pack shares could leave every later request of that isolate waiting forever. Update to 0.35.16 or later, which puts a deadline on every shared wait (see [Shared reads have deadlines](docs/internals.md#shared-reads-have-deadlines)). Until then, re-running the deploy clears it at once: a new Worker version replaces every isolate.

## Documentation

Each module has its own page in [docs](docs/README.md), with its setup, settings and notes:

- [Performance](docs/performance.md): page cache, cache warming, Cloudflare usage
- [Content URLs](docs/content-urls.md): telling the pack how your theme routes entries
- Modules: [Clean Image URLs](docs/images.md) · [Backups](docs/backups.md) · [Redirect Manager](docs/redirects.md) · [Schema & Social](docs/schema.md) · [Discovery](docs/discovery.md) · [Robots.txt](docs/robots.md) · [Search](docs/search.md) · [Link Manager](docs/links.md) · [Headings & TOC](docs/headings.md) · [Breadcrumb Nav](docs/breadcrumbs.md) · [Code Blocks](docs/code-blocks.md) · [File Downloads](docs/files.md) · [Private Form Uploads](docs/form-uploads.md) · [Videos](docs/videos.md) · [Reviews](docs/reviews.md) · [Custom Blocks](docs/custom-blocks.md) · [AI Enrichment](docs/ai.md)
- [WordPress Migration](docs/wordpress-import.md): finishing a move from WordPress
- [Internals](docs/internals.md): how the pack keeps database reads low, and the deadlines on shared reads

## Development

Releases are tagged, published on GitHub and on npm: see [Releasing](docs/releasing.md).

```bash
npx tsc --noEmit -p .        # typecheck
npm test                     # unit tests: test/ and src/**/*.test.ts (Node 22.15+; runs the TypeScript sources directly)
```

## License

MIT

# Coywolf Pack for EmDash

One plugin with [Coywolf](https://coywolf.com)'s features for [EmDash](https://emdashcms.com) sites on Cloudflare: what Coywolf's WordPress plugins did, for EmDash. coywolf.com runs on it, scores 100 in every PageSpeed category, and costs $5 a month to host alongside six other sites.

- **Fast:** cached pages answer in 60–90 ms, cache warming keeps them cached, and images come straight from Cloudflare's edge.
- **Complete:** backups and restore, redirects, schema, robots.txt rules, link checking, search, videos, feeds and more, in one plugin.
- **Safe to try:** everything starts off. Installing or updating changes nothing on your site until you turn features on.
- **Free and open source** (MIT).

**New here?** Follow [Getting started](#getting-started) to install it and turn features on.

## Modules

Every module starts off. Turn on only the ones you want under **Plugins → Coywolf Pack → Features**.

| Module | What it does |
| --- | --- |
| [Performance](docs/performance.md) | Always on: keeps Cloudflare's edge page cache correct (cleared after deploys and edits), optional cache warming, and a Cloudflare usage card with the estimated bill |
| [Clean Image URLs](docs/images.md) | Images from a `media.` subdomain on R2, resized to the sizes the theme uses, cached for a year |
| [Backups](docs/backups.md) | Backups of the D1 database and R2 media, rewind with undo, restore to a new database |
| [Redirects](docs/redirects.md) | External, file-path and regex redirects, bulk import and export, and automatic redirects for slug changes and removed content |
| [Schema & Social](docs/schema.md) | One Schema.org graph per page (publisher, articles, authors), breadcrumbs, robots directives, Open Graph |
| [Discovery](docs/discovery.md) | IndexNow, an RSS feed, a Google News sitemap, and llms.txt with Markdown versions of entries |
| [Robots.txt Rules](docs/robots.md) | Plain-English robots.txt rules with a guided editor, a verified crawler directory, history and a URL tester |
| [Search](docs/search.md) | Fast as-you-type results on EmDash's full-text search, a search box, and rate limiting |
| [Link Manager](docs/links.md) | Every link in your content with its status, and bulk replace, unlink and ignore |
| [Headings & TOC](docs/headings.md) | Linkable headings and a Table of Contents block |
| [Breadcrumb Nav](docs/breadcrumbs.md) | An accessible breadcrumb trail for themes and as a block |
| [Code Blocks](docs/code-blocks.md) | Server-side syntax highlighting, themes, language labels, copy buttons |
| [File Downloads](docs/files.md) | Download cards, stable download URLs with counts, uploads of any size |
| [Private form uploads](docs/form-uploads.md) | Files sent through EmDash Forms go to a private bucket that only admins can read |
| [Videos](docs/videos.md) | Cloudflare Stream library, a video block with a light embed, video schema and sitemap, plays and likes |
| [Reviews](docs/reviews.md) | A review block (rating, pros and cons) with Review schema |
| [Custom Blocks](docs/custom-blocks.md) | Note, Details, Affiliate disclosure, Quote, Testimonial and Podcast links blocks |
| [AI Enrichment](docs/ai.md) | Wikidata-grounded entities for schema, meta descriptions and image alt text |
| [WordPress import](docs/wordpress-import.md) | Finishes a move from WordPress: blocks, authors, category parents, media URLs and redirects |

## Getting started

Coywolf Pack is a native (trusted) EmDash plugin: you add it to your site's code and deploy, rather than installing it from EmDash's plugin directory (which lists only sandboxed plugins, and those can't read the database or buckets directly). The steps below use coywolf.com as the example: change the names to your site's.

### What you need

- An EmDash site (1.2 or later) on Cloudflare Workers, using EmDash's Cloudflare adapter with a D1 database bound as `DB` and an R2 media bucket bound as `MEDIA`. That's the setup EmDash's own Cloudflare starter creates.
- The site's code in a folder (or Git repository) you can edit and deploy, with Node.js and Wrangler.

### 1. Install the package

From the site's folder, install the latest release. Releases are listed under [Tags](https://github.com/coywolf-llc/coywolf-pack/tags); replace `v0.35.12` with the newest one:

```bash
npm install https://codeload.github.com/coywolf-llc/coywolf-pack/tar.gz/refs/tags/v0.35.12
```

The package is named `@coywolf/emdash`. Use the tarball URL rather than `github:coywolf-llc/coywolf-pack`: npm records `github:` installs as SSH Git URLs, which CI runners without an SSH key can't fetch.

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
  // Page cache: Workers Cache in front of the Worker, and the deployed version so old pages are cleared after a deploy.
  "cache": { "enabled": true },
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  // Cache warming and checking internal links: the Worker calling itself.
  "services": [{ "binding": "SELF", "service": "coywolf" }]
}
```

API keys and tokens (for AI Enrichment, Videos, Robots.txt's Cloudflare Radar sync, Clean Image URLs setup, Cloudflare usage) are stored encrypted, so the site also needs EmDash's `EMDASH_ENCRYPTION_KEY` secret. EmDash's setup usually creates it; if not:

```bash
npx wrangler secret put EMDASH_ENCRYPTION_KEY
```

Keep that key in a password manager: encrypted settings can't be read without it.

### 5. Deploy

Deploy the site the way you usually do (for example `npx wrangler deploy`, or your CI). Nothing changes for visitors yet: every feature starts off.

### 6. Turn features on

1. Sign in to the site's admin (`https://coywolf.com/_emdash/admin`).
2. Open **Plugins → Coywolf Pack → Features**.
3. Turn on the modules you want, and any of their parts. Each module that's on adds its page to the **Coywolf Pack** section of the sidebar.
4. Open each module's page for its settings and step-by-step guides. A part can also be turned on or off there.

A good first set for most sites:

| Turn on | What you get | Then |
| --- | --- | --- |
| **Performance** (always on) | Page cache lifetimes, clearing after deploys, cache warming | Turn on **Cache warming** on the Performance page (needs `SELF`) |
| **Clean Image URLs** | Images from a `media.` subdomain, resized and cached | Run **Set up media host** on its page (see [Setting up a media host](docs/images.md#setting-up-a-media-host)) |
| **Schema & Social** | Schema.org markup and Open Graph tags | Review the publisher on the Schema page |
| **Redirects** | Redirects EmDash's own can't handle, plus slug-change and removed-content redirects | Import old redirects on the Redirects page |
| **Discovery** | IndexNow, an RSS feed, a news sitemap, llms.txt | Turn on the parts you want on the Discovery page |
| **Backups** | Backups of the database and media, on demand or daily | Add `backups: { name: "coywolf" }` (step 2) and the `BACKUPS` bucket, then turn on the daily backup (see [Backups](docs/backups.md)) |

### Using the admin

- **Features** (**Plugins → Coywolf Pack → Features**) turns modules and their parts on or off. A module's page also has switches for its parts.
- **Each module's page** holds its settings, grouped into sections, with step-by-step guides. A feature that needs an API key or a binding shows a setup card until it's there.
- **API keys and tokens** can be entered on their module's page or on the plugin's **Settings** page, which lists only those. EmDash stores them encrypted.
- **Saving:** a bar appears at the bottom of a settings page when there are unsaved changes, with **Discard** and **Save** (also Ctrl/⌘+S).

### Updating

Install the newer release's tarball (step 1 with the new tag), then deploy. Updates never turn features on by themselves: new features start off.

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
- **A module's page isn't in the sidebar.** Its main switch is off: turn it on under **Plugins → Coywolf Pack → Features**.
- **Redirects, `/robots.txt` rules, the feed or downloads don't answer.** The middleware isn't running: check step 3, and that `coywolfPack()` comes before your own middleware in `sequence()`.
- **A feature shows a setup card instead of its settings.** It needs a binding, an API key or `EMDASH_ENCRYPTION_KEY`; the card says which.
- **Pages don't change after an edit.** EmDash and the pack clear cached pages on edits and deploys; **Plugins → Coywolf Pack → Performance → Clear pages and images** clears everything now. Cloudflare's zone **Purge Everything** doesn't reach the Worker's page cache.

## Documentation

Each module has its own page in [docs](docs/README.md), with its setup, settings and notes:

- [Performance](docs/performance.md): page cache, cache warming, Cloudflare usage
- [Content URLs](docs/content-urls.md): telling the pack how your theme routes entries
- Modules: [Clean Image URLs](docs/images.md) · [Backups](docs/backups.md) · [Redirects](docs/redirects.md) · [Schema & Social](docs/schema.md) · [Discovery](docs/discovery.md) · [Robots.txt Rules](docs/robots.md) · [Search](docs/search.md) · [Link Manager](docs/links.md) · [Headings & TOC](docs/headings.md) · [Breadcrumb Nav](docs/breadcrumbs.md) · [Code Blocks](docs/code-blocks.md) · [File Downloads](docs/files.md) · [Private form uploads](docs/form-uploads.md) · [Videos](docs/videos.md) · [Reviews](docs/reviews.md) · [Custom Blocks](docs/custom-blocks.md) · [AI Enrichment](docs/ai.md)
- [Migrating from WordPress](docs/wordpress-import.md)
- [Internals](docs/internals.md): how the pack keeps database reads low

## Development

```bash
npx tsc --noEmit -p .        # typecheck
npm test                     # unit tests: test/ and src/**/*.test.ts (Node 22.15+; runs the TypeScript sources directly)
```

## License

MIT

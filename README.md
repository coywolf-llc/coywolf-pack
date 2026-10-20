# Coywolf Pack for EmDash

One plugin with [Coywolf](https://coywolf.com)'s features for [EmDash](https://emdashcms.com) sites on Cloudflare: the things Coywolf's WordPress plugins do that EmDash doesn't do natively. Enable only the modules you want.

## Faster sites

EmDash on Cloudflare builds every page in a Worker, and a Worker that hasn't run recently in a data center has to start up, load EmDash and query D1 before it can answer. On coywolf.com that meant 1.1–2 seconds before the first byte and a mobile PageSpeed Speed Index of 5–8 seconds. With Coywolf Pack's performance features, the same site scores 100 in every PageSpeed category.

| What it improves | How |
| --- | --- |
| **First visits** | Keeps Cloudflare's Workers Cache (the edge HTML cache in front of the Worker) correct, so pages can stay cached for days: it clears everything after each deploy and whenever pack settings change, and sets page lifetimes at runtime. Cached pages answer in 60–90 ms instead of 1–2 s. |
| **Clearing the cache** | **Plugins → Performance → Clear pages and images**. Cloudflare's zone "Purge Everything" doesn't reach Workers Cache, which belongs to the Worker. Settings that don't change pages (backups, the link report) don't clear it, redirect edits clear only cached redirects, and robots.txt rules clear only `/robots.txt`. |
| **Cold pages after a clear** | Optional cache warming: after a deploy, a full clear or (a minute later) content edits, every page in the sitemap, plus the section pages the home page links to (category archives sitemaps often leave out), is visited in the background of the site's own traffic (home page and its menu pages first, then newest posts), so visitors and crawlers get cached pages instead of waiting for them to be built. |
| **Images** | Serves media from a `media.` subdomain (R2 custom domain + Image Transformations), never through the Worker, with clean resized URLs, a one-year Cache Rule, responsive `srcset` helpers, and width/height lookups for images that have none (WordPress imports), so layouts don't shift. |
| **Live search** | Results as you type in tens of milliseconds: an instant title index in the browser, an edge cache keyed to content changes, and 2–3 D1 queries instead of 25–31. |
| **Redirects** | Answered by middleware from rules cached per isolate, before EmDash renders anything, then kept in the edge cache (tagged `coywolf-redirects`) until a redirect edit clears them. |
| **Fewer D1 round trips** | Pages that aren't cached yet cost the pack about one D1 round trip: settings come with the feature switches' query (cached per isolate for five minutes), an entry's pack data is one query, and the pack's own reads of a moment go to D1 as one batch. See [Database reads](#database-reads). |
| **No client JavaScript where it isn't needed** | Code highlighting, tables of contents, breadcrumbs, reviews and schema are rendered on the server. |

See [Page cache](#page-cache) for setup.

## Database reads

A page that isn't in the edge cache yet is built by the Worker, and every D1 round trip costs it about 25–30 ms. The pack keeps its share to about one:

- **Settings with the switches.** The feature switches, the settings page renders need (schema, videos player, discovery, code theme, review style…), the deployed version and the settings generation are one query, cached per Worker isolate for five minutes. A save through the pack's admin pages applies at once in the isolate that made it.
- **Settings generation.** Every successful pack admin save writes a new generation (`plugin:coywolf-pack:state:settingsGeneration`). Other isolates see it on their next read of the switches (within five minutes) and drop everything they derived from settings (schema config, player settings, redirect patterns…), which otherwise lasts up to ten minutes. Because those isolates may render pages with the old settings in the meantime, a save that clears the page cache clears it once more about five minutes later (see [Page cache](#page-cache)). Changes made outside the pack's admin pages (a byline's profile in EmDash) show up within ten minutes.
- **One query per entry.** An entry's Schema override, Videos embed index and AI entities are one query (and its blocks, for review schema, when the theme didn't pass the entry), read once per request however many hooks ask.
- **Batched.** The pack reads D1 through the raw binding (`env.DB`), which EmDash's per-request session (and its `coalesce` option) never sees, so reads the pack starts in the same moment are sent as one `db.batch()`: one round trip. A request's redirect lookup goes in the same batch as the feature switches when those aren't cached; on a page, the entry's data, image dimensions and video details are another.
- **From the theme.** Pass the entry you rendered as `coywolf.entry` on the page context (see [Schema & Social](#pass-the-entry-to-save-reads)) and the pack doesn't read its bylines or blocks again.

## Modules

| Module | What it does |
| --- | --- |
| **Performance** | Always on: page cache lifetimes, cache clearing after deploys and settings changes, a Clear pages and images button, and the media host's Cache Rule (see [Faster sites](#faster-sites)) |
| **Backups** | Full backups (D1 database + R2 media), rewind with undo, restore to a new database, missing-media restore |
| **Redirects** | Redirect manager for what EmDash's built-in Redirects can't handle: external destinations, file paths, regular expressions, query strings, bulk import and export, a URL tester, and redirects for removed content (see [Redirects](#redirects)) |
| **Headings & TOC** | Linkable headings (`#jump-…` anchors) and a Table of Contents block |
| **Breadcrumb Nav** | An accessible breadcrumb trail as a theme component and a Breadcrumbs block, fed by the same trail as the breadcrumb schema |
| **Code Blocks** | Server-side syntax highlighting, themes, language label, copy button and line numbers for code blocks |
| **File Downloads** | A download card block, stable download URLs with counts, a Files page, and direct-to-R2 uploads of any size |
| **Private form uploads** | Files sent through EmDash Forms plugin forms go to a private R2 bucket instead of the public media library; admins list, download and delete them |
| **Search** | Settings page for EmDash's full-text search, a search box with as-you-type suggestions and an OR fallback, and rate limiting |
| **Discovery** | IndexNow pings, a Google News sitemap, and llms.txt with Markdown versions of entries |
| **Link Manager** | Every link in your content with its HTTP status, where it's used, and bulk replace, unlink, and ignore |
| **Videos** | Cloudflare Stream library and uploads, the Coywolf Video block, VideoObject schema, a video sitemap, plays and likes, captions |
| **Reviews** | The Coywolf Review block (rating badge, pros and cons) with custom CSS, and Review schema with pros and cons |
| **Custom Blocks** | Note (callout), Details (expandable, with a transcript style), Affiliate disclosure, Quote, Testimonial and Podcast links blocks |
| **Schema & Social** | One Schema.org graph per page (publisher, typed pages and articles, authors), breadcrumbs, robots directives, Open Graph extras |
| **Robots.txt Rules** | Plain-English robots.txt rules with a guided editor, live checks and a self-check, a verified crawler directory kept current from Cloudflare Radar, version history, and a URL tester |
| **WordPress import** | Finishes a move from any WordPress site: keeps heading ids, reusable blocks, quotes and Details blocks through EmDash's importer, credits co-authors and guest authors, restores category and page parents, points leftover `/wp-content/` URLs (size variants and files outside the media library included) at the media library, and turns old slugs and Redirection, Rank Math and Yoast rules into redirects. Blocks from Coywolf's WordPress plugins become Coywolf Pack blocks |
| **AI Enrichment** | Wikidata-grounded entities for schema, meta-description suggestions, and image alt text, with Workers AI or your own key |

Every feature can be turned on or off under **Plugins → Coywolf Pack**, like Coywolf SEO's feature switches. New features start off, so installing or updating changes nothing on the site until you turn them on. A module that is off also leaves the admin sidebar and dashboard. The pack's pages share one **Coywolf Pack** folder in the sidebar's Plugins section (EmDash 1.2.0+): the feature switches (**Features**) first, then Performance, then Clean Image URLs when it's on, then the other modules.

More modules will follow as Coywolf's WordPress plugins move to EmDash.

This is a native (trusted) EmDash plugin, so it installs from GitHub or npm rather than the EmDash plugin directory. The directory lists only sandboxed plugins, which can't read the database or buckets directly.

## Requirements

EmDash 1.2+ on the Cloudflare adapter, with a D1 database (`DB`) and an R2 media bucket (`MEDIA`).

## Install

```bash
npm install https://codeload.github.com/coywolf-llc/coywolf-pack/tar.gz/refs/tags/v0.17.0
```

Use the tarball URL rather than `github:coywolf-llc/coywolf-pack`: npm records `github:` installs as SSH Git URLs, which CI runners without an SSH key can't fetch.

```js
// astro.config.mjs
import { coywolfPlugin } from "@coywolf/emdash";

emdash({
  // ...
  plugins: [
    coywolfPlugin({
      backups: { name: "mysite" },
      redirects: {},
    }),
  ],
});
```

Each module appears under **Plugins → Coywolf Pack** in the admin. Omit a module (or set it to `false`) to turn it off.

Each module's settings live on its own page (Backups, Files → Settings, Videos → Settings, Link Manager → Settings, AI Enrichment → Settings, Schema, Code Blocks, Discovery, Robots.txt, Clean Image URLs), grouped into sections. Features that need an API key or binding stay hidden until it's there, with a setup card in their place. The plugin's generic **Settings** page (**Plugins → Coywolf Pack → Settings**) lists only the API keys and tokens, which EmDash stores encrypted (so the site needs `EMDASH_ENCRYPTION_KEY`): the AI Enrichment API key, the File Downloads R2 secret access key, the Videos Stream API token and webhook secret, the Cloudflare Radar API token, and the Clean image URLs Cloudflare API token. Each can also be entered on its module's page, which has a step-by-step guide (closed by default) for getting it; the Settings page shows the same guides (the pack's middleware adds them to that EmDash page; without it, each field keeps a short plain-text version).

Settings pages save from one bar pinned to the bottom of the page: it appears only when there are unsaved changes, with **Discard** (back to what's saved) and **Save** (also Ctrl/⌘+S), and the browser asks before you leave with changes unsaved.

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

## Content URLs

Several modules link to entries: llms.txt and the news sitemap, IndexNow, per-entry Markdown, the video sitemap, Schema previews, search results, and removed-content redirects. By default they resolve an entry's URL the way EmDash does, from the collection's URL pattern (`{slug}`, `{id}`, and date tokens such as `{year}`). If your theme routes a collection differently, tell the pack with `urls`:

```js
// wellbeing.io serves posts at WordPress-style /{category}/{slug}/
coywolfPlugin({
  urls: { posts: "/{term:category|uncategorized}/{slug}/" },
});
```

Patterns take EmDash's tokens plus taxonomy tokens:

- `{term:<taxonomy>}` is the slug of the entry's first term in that taxonomy, in the order EmDash's `getTermsForEntries` returns them (by label).
- `{term:<taxonomy>|<fallback>}` uses `<fallback>` when the entry has no term. Without a fallback, an entry with no term has no URL.
- `{category}` is shorthand for `{term:category|uncategorized}`.
- `{termpath:<taxonomy>}` (and `{termpath:<taxonomy>|<fallback>}`) is the same term with its parent terms in front, root first, like WordPress's `%category%` permalink: `news/seo` for SEO under News, `guides/method-seo/structure` three levels down. A term with no parent is just its slug. Parents come from EmDash's categories (the parent set under **Taxonomies**), read once per request or build. Chains stop at a loop or after 32 levels.
- `{pagepath}` is the entry's slug with its parent pages' slugs in front (`apps/coywolf-seo`). EmDash entries have no parent field, so the parents come from the `pageParents` option (slug → parent slug). An entry with no parent is just its slug.

```js
// coywolf.com: WordPress's /%category%/%postname%/ with the full category path, and nested pages
coywolfPlugin({
  urls: {
    posts: "/{termpath:category|uncategorized}/{slug}/",
    pages: "/{pagepath}/",
  },
  pageParents: { "coywolf-seo": "apps", "coywolf-files": "apps" },
  // Optional: parents for categories that have none in EmDash yet (e.g. right after a WordPress import).
  termParents: { category: { seo: "news", "method-seo": "guides", structure: "method-seo" } },
});
```

`termParents` (taxonomy → term slug → parent slug) is a fallback: it's used only for terms that have no parent in EmDash, so once the parents are restored (see [Migrating from WordPress](#migrating-from-wordpress), "Category and page parents") it can go.

Collections without an override keep EmDash's resolution. The pack also maps paths back to entries (for example, the Markdown source at `/mind/some-post/index.html.md` resolves only when `mind` is the post's primary category), so a wrong category doesn't match. With `{termpath:…}` the whole path must match: `/news/seo/some-post/` resolves, `/seo/some-post/` doesn't (the theme should redirect it, as WordPress did). With `{pagepath}`, a page under a parent resolves only at its full path.

Trailing slashes follow Astro's `trailingSlash` setting. With the default (`"ignore"`), an override keeps the pattern's own trailing slash. Set `trailingSlash: "always" | "never"` on `coywolfPlugin()` to force one for every entry URL the pack builds. Override URLs get no locale prefix.

The options are read when the Worker starts (EmDash creates the plugin then), so the middleware and Astro components use them too. Sites can resolve URLs the same way with `entryUrl`, `entryUrls`, and `matchEntryPath` from `@coywolf/emdash/astro`.

## Clean Image URLs

Resized copies of media-library images at short, cacheable addresses instead of Astro's `/_image?href=…&w=…&h=…` endpoint. Off until you turn on **Clean image URLs** on the Coywolf Pack page; the **Clean Image URLs** admin page appears once it's on.

### Two modes

**Media host (recommended).** A subdomain of the site, such as `media.example.com`, serves the media bucket directly from Cloudflare, which resizes on the fly and picks AVIF or WebP for browsers that accept them. Images never touch the site's Worker.

```
https://media.example.com/<file>               the original file
https://media.example.com/s/<w>x<h>/<file>     cropped to fill (fit: cover)
https://media.example.com/s/<w>/<file>         width only, keeps the ratio
```

`<file>` is the media item's stored file name (`<id>.<ext>`, as in `/_emdash/api/media/file/<id>.<ext>`). Sizes go up to 2560px.

**Worker route (no setup).** Without a media host, the pack's middleware serves

```
/media/<file id>-<width>x<height>.<webp|avif|jpg|png>   cropped to fill (fit: cover)
/media/<file id>-<width>w.<format>                      width only, keeps the ratio
```

reading the original from the media bucket (`MEDIA`), resizing it with the Cloudflare Images binding (`IMAGES`, which the Astro Cloudflare adapter already binds) and caching the result at the edge for a year (keyed by the path alone, so a query string never forces a new resize). Widths and heights on this route are multiples of 10px: `cleanImageUrl()` rounds other sizes up (640×336 becomes 640×340), and a request for an off-grid size gets a 301 to the rounded one, so nobody can make the Worker run (and bill) a new resize for every pixel. SVGs aren't resized. Other binding names: `coywolfPlugin({ images: { bucket: "MYMEDIA", images: "MYIMAGES" } })`. Once a media host is set, these addresses redirect (301) to the same size on the media host, so old links keep working.

### Setting up a media host

The media host needs three things on Cloudflare, in the zone of the site's domain:

1. **Image Transformations** turned on for the zone (Images → Transformations → Enable for zone; same-zone sources only, so leave "Resize images from any origin" off).
2. **An R2 custom domain** on the media bucket (the bucket bound as `MEDIA`): R2 → the bucket → Settings → Custom Domains → Add `media.example.com`, minimum TLS 1.2. Cloudflare adds the DNS record and certificate.
3. **Two URL rewrite rules** (Rules → URL Rewrite, phase `http_request_transform`), named exactly so the setup button recognizes them:

| Name | Filter expression | Path rewrite (dynamic) |
| --- | --- | --- |
| `media.example.com: /s/<W>x<H>/<file> → cropped resize (Coywolf Pack clean image URLs)` | `(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*x*/*")` | `wildcard_replace(http.request.uri.path, "/s/*x*/*", "/cdn-cgi/image/width=${1},height=${2},fit=cover,format=auto,quality=85/${3}")` |
| `media.example.com: /s/<W>/<file> → resize to width (Coywolf Pack clean image URLs)` | `(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*/*" and not http.request.uri.path wildcard "/s/*x*/*")` | `wildcard_replace(http.request.uri.path, "/s/*/*", "/cdn-cgi/image/width=${1},format=auto,quality=85/${2}")` |

Do it by hand with the step-by-step guide on the Clean Image URLs page, or let **Set up media host** on that page do it through the Cloudflare API: enter the media host, your Cloudflare account ID, the media bucket's name and an API token, select **Review setup** to see the plan ("Turn on Image Transformations for example.com, connect media.example.com to the R2 bucket example-media, add 2 URL rewrite rules"), then **Apply**. Anything already done is skipped, the zone's other URL rewrite rules are kept as they are, and only the pack's own two rules (matched by name) are replaced. It finishes with a check. The page checks the media host each time it opens: when it works, Set up media host shows as done with **Run setup again**, and the host field opens with **Change host**.

The API token needs these permissions (Account Resources: your account; Zone Resources: the site's zone):

- Zone → Zone → Read (to find the zone)
- Zone → Zone Settings → Edit (Image Transformations)
- Zone → Transform Rules → Edit, and Account → Account Rulesets → Read (the URL rewrite rules)
- Account → Workers R2 Storage → Edit, and Zone → DNS → Edit (the custom domain and its DNS record)

The token can be typed just for the setup, saved (encrypted) on the page or the plugin's Settings page, or set as the `IMAGES_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`) Worker secret; the account ID can come from `CF_ACCOUNT_ID`. It's only sent to `api.cloudflare.com`, and you can delete it in Cloudflare afterward.

**Check** (on the page) fetches a recent image from the media host, and a 64×64 copy of it twice, and reports whether the host is reachable, the original is served, resizing works (`cf-resized` header or an image type) and the copy is cached.

Then turn the media host on, either on the Clean Image URLs page (takes effect within a minute, no deploy) or in `astro.config.mjs`:

```js
coywolfPlugin({ images: { cdn: "https://media.example.com" } })
```

A host saved on the page wins over the option; clear it there to fall back to the option. The host must be an `https://` origin with no path.

**Quota.** Cloudflare's Free plan includes 5,000 unique image transformations a month (each new size of each image counts once a month; repeat views come from the cache). Beyond that, transformations need a paid Cloudflare Images plan.

### Open Graph and schema

With Schema & Social's Open Graph extras on:

- Pages without their own image use the site's default OG image (Settings → SEO) at a clean 1200×630 URL with its width, height, type and alt. On the media host that's `https://media.example.com/s/1200x630/<file>` (crawlers that don't ask for WebP get the original format, so the type is the original's); on the Worker route PNG stays PNG and anything else becomes JPEG.
- With a media host, a page's own image (featured image or SEO image from the media library) is output as its original on the media host, with its width, height, type and alt. The JSON-LD `primaryImageOfPage` uses the same URL.
- These og:image and twitter:image tags replace EmDash's own (never a second og:image), and clean URLs anywhere in og:image resolve back to their media item.

### In theme code

```astro
---
import { cleanImageUrl, originalImageUrl } from "@coywolf/emdash/astro";
const src = post.data.featured_image?.src;
const thumb = await cleanImageUrl(src, { width: 600, height: 315 });
const full = await originalImageUrl(src);
---
{thumb && <img src={thumb} width="600" height="315" alt="" />}
<a href={full}>Full size</a>
```

- `cleanImageUrl(src, { width, height?, format? })`: the resized URL (on the media host when set, else `/media/…`; `format` applies to the Worker route only, as the media host picks it). `null` when the feature is off, `src` isn't a media-library file, or it's an AVIF original on a media host (Cloudflare's resizer can't read AVIF), so fall back to your usual image code.
- `originalImageUrl(src)` (also exported as `mediaUrl`): the original file on the media host; returns `src` unchanged when the feature is off, no media host is set, or `src` isn't a media-library file.
- `imageDimensions(srcs)`: a `Map` of `src` → `{ width, height }` from the media library, for images whose Portable Text block has no size (WordPress imports don't record one). One query for a whole page, remembered per isolate; works whether or not the feature is on. Use it to build `srcset` and set `width`/`height` on content images.

### Stored image sizes

With a media host, each image is also stored, once, in a few sizes as AVIF and WebP, next to the original in the media bucket, and pages use those files instead of resizing on each visit:

```
https://media.example.com/v1/<id>-<w>.avif|.webp          widths 400, 640, 800, 1200, 1600 (keeps the ratio)
https://media.example.com/v1/<id>-<w>x<h>.avif|.webp      the site's crops (fit: cover, around the image's focal point)
```

- **What's made.** Each width smaller than the original (the original is always the largest candidate; images under 400 pixels have none and render as a plain `<img>`), and, when a page first shows it, each crop in `images.crops` that fits inside the original (never upscaled). JPEG, PNG and WebP originals up to 20 MB; GIFs, SVGs, AVIF originals and larger files keep using `/s/`. WebP is made at quality 85, AVIF at 80; Cloudflare doesn't encode AVIF beyond 1200 pixels on a side, so those sizes are stored as WebP under the `.avif` name too (with their real `Content-Type: image/webp`; a `<source type="image/avif">` only picks the candidate list, and every browser that takes AVIF also decodes WebP). Files are stored with `Cache-Control: public, max-age=31536000, immutable`.
- **Crops** are the exact sizes the theme shows (list thumbnails, avatars at 1x and 2x, the Testimonial block's 64×64 and 128×128 photo). They're made **on first use**: when `croppedImage()` finds an image's widths stored but a listed crop missing, it makes just that crop after the response (one at a time per isolate, at most 6 images queued; a failure waits an hour before it's tried again), merges it into the record in SQL (crops added meanwhile by another isolate are kept), and marks the page as a stopgap so its next render uses it. So avatars and testimonial crops are made only for the images that are shown that way, and list crops only for featured images. A size not in `images.crops` always uses `/s/`.

  ```js
  coywolfPlugin({ images: { cdn: "https://media.example.com", crops: [[400, 210], [600, 315], [900, 473], [50, 50], [100, 100], [64, 64], [128, 128]] } })
  ```

  Adding crops later is fine: they're made as pages show them. Removed crops' files stay until the image is deleted.
- **When.** New images: right after an upload (in the background; the upload doesn't wait; EmDash 1.2.0+ notifies plugins of direct uploads too, once confirmed), and after a file is replaced. An image whose sizes already exist isn't made again. These always run (one image's widths cost a few cents at most).
- **Existing images are opt-in.** Making sizes for a whole library (for example after a WordPress import) is a one-time Cloudflare fee, so it doesn't start on its own. Until an admin turns on **Sizes for existing images** on the Clean Image URLs page (setting `imagesVariantsBulk`, read with the feature switches, so checking it adds no query), the backfill, the step after a WordPress media import and legacy video-poster upgrades do nothing, and existing images keep using `/s/`. Turning it on takes a confirmation that shows the estimate (below) and starts a run. A finished run starts over a day later to retry failures. Turning it off stops further work, including a run under way (it checks the setting before each batch of five images and before the cleanup, so within the switches' cache); sizes already made stay in use. Turning it back on starts a fresh run.
- **Back-to-back batches.** A run works in a chain of steps, each in a Worker invocation of its own (so each gets its own subrequest budget), one after another until every image is done; nobody has to keep the admin page open. Turning sizes for existing images on, **Make missing sizes now**, a WordPress media import, the hourly job (it restarts a run that finished a day ago, or a chain that stopped), and page traffic (a request that sees a run with no chain working on it, from the progress row read with the feature switches, so no extra query) start a chain. The trigger takes the run's **lease** (a compare-and-swap on the progress row `plugin:coywolf-pack:images:variantsState`: one chain at a time) and posts the first step to the Worker itself through the `SELF` service binding (internal path `/_coywolf-pack/images/backfill`), so no image work happens in the Cron Trigger, which runs wherever Cloudflare has room, often far from the database (the same reason cache warming rides on traffic). Each step renews the lease, makes sizes for up to 25 images (2 at a time; it claims no new batch after 15 seconds), then posts the next step. The endpoint only works for the request carrying the lease's current token (a random UUID kept in the database, never sent to browsers); anything else gets a 403 and starts nothing, so visitors can't trigger transformations. Budget per step: an image takes up to ~22 subrequests (a list, the original, and for up to five widths a WebP and an AVIF transform and two writes) plus its record, so 25 images are at most ~575, plus ~30 for claims, counts, the lease and the next step: about 600 of the 1,000 an invocation may make, finishing within the 30 seconds a step's background work may run after its response. That's roughly 2,000–4,000 images an hour (fewer with large originals), instead of 15 an hour from the hourly job alone. Cloudflare allows 32 Worker invocations per incoming request, so a chain lets go after 24 steps and the next page request (or the hourly job) starts a new one; a chain that dies leaves a lease that runs out after 90 seconds and is taken over the same way. When Cloudflare Images rate-limits or refuses work (a 429, the monthly quota), the batch is handed back and the run pauses for 30 minutes (`pausedUntil`; a batch where every image failed for another reason pauses it too, its images counted as failed); page traffic and the hourly job resume it afterward. The page shows the progress ("working, about N images an hour", or paused until when). Without the `SELF` binding, or when the hand-off isn't accepted (something ahead of the pack's middleware refuses the internal request, as a staging site's password gate does), each trigger makes one step's worth of sizes itself and lets go; the hourly job and page traffic carry on from there.
- **Until an image's sizes exist** (and for images that can't have them), `responsiveImage()` and `croppedImage()` return `null` and themes use `cleanImageUrl()` (`/s/`). A page that showed such a stopgap is cached for minutes instead of days, so its next render uses the stored files, only when the sizes are moments away: the image was uploaded in the last 15 minutes (`created_at` comes with the media row `imageInfo()` already reads), or a crop was just queued. Existing images waiting for the backfill don't shorten pages (that would rebuild every page every few minutes for as long as the run takes): those pages keep their normal lifetime, and when a run that made sizes for at least one image finishes, the backfill clears the page cache once (exactly once per run: only the step whose compare-and-swap finishes the run does it) and, with cache warming on, starts a warm-up, so every page picks up the stored sizes together. An image that can't have sizes, or a crop that failed recently, uses `/s/` and the page is cached normally.
- **Records.** Each image's sizes are recorded in plugin storage (`imageVariants`, by media id) once all its files are in the bucket; pages read them with the media rows in one query per page (`imageInfo()`), remembered per isolate for up to 10 minutes.
- **Deleting** an image from the media library deletes its stored sizes and record. A replaced file gets new sizes (the media host may keep serving cached old ones, as it does for the original).
- **Changing the widths or quality** (in `src/images/variants.ts`) means bumping `VARIANTS_VERSION`: renders treat older records as missing, the backfill makes the new set (with sizes for existing images on; otherwise those images use `/s/`), and its cleanup deletes the previous version's files.
- **Cost.** Each stored file is one transformation, made once (Free plan: 5,000 a month; beyond that $0.50 per 1,000 on a paid Images plan): a size is two (WebP and AVIF), or one above 1,200 pixels. An image with 4 widths is about 7, so a 2,000-image library is about 14,000 once. After that, visits cost nothing but R2 storage and reads. Without stored sizes, `/s/` costs one transformation per size of each image asked for, **every month** (the AVIF and WebP a visitor gets from one `/s/` URL count once).
- **Estimate.** The Clean Image URLs page shows, from one scan of the media table and a count of published entries (admin only, `images/variants/estimate`): the one-time fee as a range (the site may already have used the month's free 5,000), storage a month (rough per-width file sizes; R2 at $0.015 per GB-month), the most `/s/` could cost a month (every size of every image asked for once) and when the fee pays for itself, and a **traffic calculator** (page views a month; pages seen = P × (1 − e^(−V/P)), at least 80% with search engines crawling; about 3 sizes per image shown; one Open Graph `/s/` image per page either way). The math is in `src/images/variants-estimate.ts`.
- **Video posters** get stored sizes too (400, 800 and 1200 wide); posters copied before 0.30.0 keep using `/s/` until the backfill's cleanup makes theirs (only with sizes for existing images on).
- **Open Graph** images stay on `/s/1200x630/` (crawlers that don't ask for WebP get the original's format there).

In theme code, read every image of the page once, then build each `<picture>`:

```astro
---
import { croppedImage, imageInfo, responsiveImage, cleanImageUrl } from "@coywolf/emdash/astro";
await imageInfo(allImageSrcsOnThePage); // one query; later calls come from the cache
const r = await responsiveImage(src, { locals: Astro.locals });
const thumb = await croppedImage(src, [[400, 210, "400w"], [600, 315, "600w"], [900, 473, "900w"]], { locals: Astro.locals, srcIndex: 1 });
---
{r ? (
	<picture>
		<source type="image/avif" srcset={r.avif} sizes="(min-width: 50rem) 768px, 100vw" />
		<img src={r.src} srcset={r.webp} sizes="(min-width: 50rem) 768px, 100vw" width={r.width} height={r.height} alt="" />
	</picture>
) : (
	<img src={await cleanImageUrl(src, { width: 800 })} alt="" />
)}
```

Or use the `ResponsiveImage` component (`src`, `alt`, `sizes`, `width`, `height`, `priority`, `class`, `dataFull`), which renders the `<picture>` or the `/s/` fallback.

## Page cache

For sites that put Cloudflare's [Workers Cache](https://developers.cloudflare.com/workers/cache/) in front of the Worker, which serves cached pages without running the Worker. That's what makes first visits fast: a cold Worker spends a second or more starting up and querying D1. Turn it on in the site, as in EmDash's Cloudflare guide:

```js
// astro.config.mjs
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
export default defineConfig({
	cache: { provider: cacheCloudflare() },
	routeRules: { "/": { maxAge: 3600, swr: 86400 }, "/[...path]": { maxAge: 3600, swr: 86400 } },
});
```

and add `"version_metadata": { "binding": "CF_VERSION_METADATA" }` to `wrangler.jsonc`.

EmDash clears the pages it tagged when content, menus or site settings change. **Plugins → Performance** (always on, right below Coywolf Pack; on a site without Workers Cache it does nothing) covers the rest:

- **After a deploy**: the first request a new Worker version handles clears every cached page, so theme and code changes show up right away.
- **After Coywolf Pack settings change**: a successful admin save that changes page output (schema, blocks, videos, images, feature switches…) clears every cached page (see Scoped clearing below). Other Worker isolates may keep the old settings for up to five minutes (see [Database reads](#database-reads)), so pages they render meanwhile could be cached with them: about five minutes after the save, the first request in any isolate clears the same pages once more (a "settling" clear; with warming on, it restarts the warm-up).
- **Page cache lifetimes**: how many days the edge keeps a page (default 7) and how many more days it may serve it while fetching a fresh copy in the background (default 1). They replace the `routeRules` lifetimes on the routes the site made cacheable, at runtime, so no deploy is needed. Routes without a route rule are never cached by this.
- **Media cache**: shows whether the media host (Clean Image URLs) has a Cloudflare Cache Rule, and **Cache media for a year** adds one (edge and browser TTL one year; media file names never change). Needs the Clean Image URLs token with **Zone → Cache Rules → Edit**. Other cache rules on the zone are kept.
- **Cache warming** (off until an admin turns it on): after a deploy or a full clear, the pack reads `/sitemap.xml` (following a sitemap index) and visits every page, home page first, then the pages the home page links to (menus and section pages such as category archives, which sitemaps often leave out; up to 200, same site only, no feeds, files or query strings), then in sitemap order. The work rides on real traffic: after the site answers a request, the Worker claims a few queued pages and visits them in the background through its own `SELF` service binding, so the warm-up runs where readers and crawlers are (with Smart Placement, near the database) and fills that region's cache tiers. It doesn't use a Cron Trigger: those run in whatever data center has spare capacity, often on another continent, and placement hints don't apply to them. Batches are claimed atomically, so parallel isolates never repeat pages; a new clear or deploy restarts the run. The run's URLs are stored once (`plugin:coywolf-pack:pageCache:warmQueue:<run>:<n>` option rows of up to 500 URLs, removed when the run finishes or a new one starts; a batch claimed and never recorded, because its isolate stopped, counts as failed after two minutes so the run still finishes) and each claim only updates a small progress row, so even a 5,000-page run writes little per batch. Pages whose render used a stopgap (a video poster still being copied to the media host, see **Posters from your media host**) aren't left cold: the warmer's render of such a page isn't cached (the middleware answers it with an internal `X-Coywolf-Stopgap: 1` header, which is never stored in the cache, so visitors don't see it), and the page is listed in the progress row (up to 200, same site only) and visited again once the rest of the run is done and 20 seconds have passed, by which time its posters are copied, so it's cached with the normal lifetime. A page still on a stopgap is tried at most twice more, then given up on (it's counted, the run still finishes). The list belongs to its run: a new clear or deploy starts over. The page shows progress ("Re-warming N pages after their video posters were copied" while revisits are pending), and **Warm now** starts a run by hand. Needs a `services` binding named `SELF` pointing at the Worker itself.
- **Warming after content edits**: EmDash clears cached pages by tag when content, menus, taxonomies, widgets or site settings change, and list pages carry their collection's tag, so saving or publishing one post clears the home page, the category archives and many posts. With warming on, the pack middleware notices those clears (it wraps the request's `cache.invalidate`, so it fires exactly when EmDash clears something, through the admin, its API or MCP; draft saves that don't change live content clear nothing and start nothing) and starts a run a minute after the last such write: each write pushes the start back a minute, up to five minutes after the first, so a burst of edits makes one run. The schedule is a `rewarmAfter` time in the progress row; the next warm step after it starts the run (reason "edit"), replacing a run still under way (pages it already warmed are cache hits, so they cost little). The Performance page shows "Content changed: warming again at about …" meanwhile. The warmer's own visits are GET requests, which never schedule a run.
- **Daily refresh**: Cloudflare doesn't keep every page for its full cache lifetime; pages that aren't requested often are dropped from a data center's cache early, so a search bot crawling older posts, or a visitor arriving from a search result, would wait for those pages to be built. With warming on, a run also starts once a day: the first warm step more than 24 hours after the last run finished (whatever started it) starts a new one (reason "daily"; on a site with no run yet, the first page view starts one). It visits the same pages in the same order as any other run; pages still cached come back as cache hits and cost little (no database queries), so only the pages Cloudflare dropped are built again. A deploy, clear, edit or **Warm now** run resets the clock, since the next refresh is due a day after the last run finished. The due time comes from the progress row's `finishedAt`, which requests already have with the feature switches, so requests in between still skip the warm step without a query, and the run starts through the same atomic claim as the others, so parallel isolates start it once. The Performance page shows "Next daily refresh: about …" while warming is idle. The refresh is on by default; uncheck **Refresh daily** under Cache warming (setting `pageCacheWarmDaily`, read with the other switches, so it adds no query) to turn it off: no daily runs then (and no first run on a site that has none), while deploys, clears, edits and **Warm now** still start runs.
- **Scoped clearing**: saving settings that don't change pages (backups, the link report, the Performance page's media and warming controls) clears nothing; redirect edits (including resolving removed content, imports, and a database rewind or undo) clear only cached redirects (tag `coywolf-redirects`, cleared again about five minutes later like other saves); robots.txt rules clear only `/robots.txt`. Everything else clears every page.
- **Clear pages and images**: clears every cached page and redirect now, plus the media host's images (originals and resized copies) from the zone cache. Cloudflare's zone **Purge Everything** doesn't reach Workers Cache, which belongs to the Worker. Clearing images uses the Clean Image URLs token, which needs **Zone → Cache Purge → Purge**.
- **Pages rendered after a failed read aren't cached**: when the pack can't read what it needs (D1 unreachable for a moment, a query error), it fails closed for that request. The feature switches fall back to their defaults (most are off), settings read as unset, redirect and robots.txt rules as absent, and a module whose page metadata failed (or ran into EmDash's 5-second hook timeout) adds none. The page still goes out, but without its schema, reviews, videos or redirects, so it isn't put in the edge cache, where it would stay for the Page cache lifetime. The next request renders it again. Each such fallback is counted (`noteReadFailure()` in `src/core/read-failures.ts`). The middleware compares the count before the request and after the response has rendered, and turns route caching off (`cache.set(false)`) when it moved. For a cacheable HTML page, that happens after the page is read in full: Astro streams pages, so a component can still read settings, or call `cache.set()` (which would turn caching back on), after the headers are ready. The log says `coywolf-pack: GET /path/ not edge-cached: a read failed while it rendered (last failure: …)`, naming what failed (for example `schema: page:metadata`). A module that fails on every render (a bug rather than a blip) keeps every page out of the cache until it's fixed, so a steady stream of these lines means something to fix, not a D1 problem. A plugin route answering "not found" (a feature that's off, or the plugin not enabled) isn't a failure; only server errors are. The count is per isolate, so a failure while another page renders at the same moment keeps that page out of the cache too, which only costs one render. A failed read is never remembered as the answer: the switches, the schema configuration, a page's reviews and discovery files are read again on the next request.

Responses the pack serves itself (robots.txt, llms.txt, files, clean image URLs) keep their own `Cache-Control`: the middleware turns Astro's route caching off for them, so a site route rule (for example on a catch-all page route) doesn't add its edge lifetime. Redirects set their own: see [Redirects](#redirects).

## Backups

- **Database**: a restorable SQL dump of the site's D1 database: users, passkeys, settings, redirects, menus, plugin data, and content. Search indexes rebuild automatically on restore.
- **Media**: a mirror of the R2 media bucket. Replaced or deleted files are kept under a dated folder until retention expires.
- **Private form uploads**: when the site has a `FORM_UPLOADS` binding (**Private form uploads**), a mirror of that bucket too, under `uploads/`. Set `backups.uploads` to another binding name, or `false` to leave uploads out. Keep the backup bucket private: these are files people sent through forms.
- **Large rows**: D1 rejects statements over 100 KB, but posts can be bigger. Rows that don't fit in one INSERT are written with their long values in pieces, and the restore puts them back together exactly. Plugin caches are left out (they rebuild on demand).
- **Admin**: **Back up now**, **Download** any backup (see below), and a dashboard widget that warns when backups stop. Settings (**Schedule and retention** on the Backups page): daily scheduled backup (default off), retention (default 30 days), staleness warning (default 36 hours).
- **Restore** (optional, see below): **Rewind to this backup** (D1 Time Travel, with **Undo rewind**), **Restore to a new database** (import plus per-table row-count check), and **Restore missing media** (media first, then private form uploads, a batch of 200 files per request until done).

Theme code isn't included: it lives in your Git repository.

### Download a backup

Each backup's menu has **Download (.sql.gz)**: the gzipped SQL dump of the whole database, saved as `<name>-<stamp>.sql.gz`. It restores into any D1 database (see **Manual restore**), so you always have your own copy. The page asks the `backups/download-link` route (admins only) for a link that works for ten minutes, and the `coywolfPack()` middleware streams the file from R2 at `/_coywolf-pack/backup/<token>/<file name>`, so dumps of any size download without the Worker holding them in memory. Links are random, unlisted tokens stored in the backup bucket (`downloads/`), sent with `Cache-Control: private, no-store`; expired ones are deleted when the next link is made. Media isn't part of the download: the media mirror stays in the backup bucket (copy it with `rclone` or the R2 dashboard).

### Setup

1. Create a backup bucket and bind it as `BACKUPS` in `wrangler.jsonc`:

   ```bash
   npx wrangler r2 bucket create mysite-backups
   ```

   ```jsonc
   "r2_buckets": [
     { "binding": "MEDIA", "bucket_name": "mysite-media" },
     { "binding": "BACKUPS", "bucket_name": "mysite-backups" }
   ]
   ```

2. Options: `database` (default `"DB"`), `media` (`"MEDIA"`), `backups` (`"BACKUPS"`), `name` (dump file prefix, default `"database"`).
3. Downloads need the `coywolfPack()` middleware (see the Redirects setup).

### Enable restore

Restores use the Cloudflare API, because a Worker can't create databases or time-travel through its D1 binding.

1. Create an API token with one permission, **Account → D1 → Edit**.
2. Store it as a Worker secret. It isn't a plugin setting, because a rewind rolls plugin settings back too:

   ```bash
   npx wrangler secret put BACKUPS_API_TOKEN
   ```

3. Add the IDs and deploy:

   ```js
   coywolfPlugin({
     backups: { name: "mysite", restore: { accountId: "<account id>", databaseId: "<D1 database id>" } },
   });
   ```

Rewinds save an undo point to the backup bucket first; undo steps back one rewind at a time.

### Backup layout

```text
d1/<stamp>/<name>.sql.gz         database dump
d1/<stamp>/manifest.json         stamp, size, SHA-256, source, row counts, Time Travel bookmark
media/current/<key>              mirror of the media bucket
media/changed/<stamp>/<key>      media replaced or deleted at that backup
uploads/current/<key>            mirror of the private form uploads bucket
uploads/changed/<stamp>/<key>    uploads replaced or deleted at that backup
restore/undo/<time>.json         undo points for rewinds
downloads/<token>.json           download links (ten minutes each)
```

External jobs (a nightly GitHub Action, for example) can write to the same layout, and the admin lists those backups too.

### Manual restore

Restore a downloaded backup (or one copied from the bucket) into a **new, empty** D1 database and switch the `DB` binding to it. Never import over the live database:

```bash
npx wrangler d1 create mysite-restore
gunzip -c mysite.sql.gz > restore.sql
npx wrangler d1 execute mysite-restore --remote --file restore.sql
```

Keep `EMDASH_ENCRYPTION_KEY` in a password manager. It isn't in backups, and encrypted plugin settings can't be read without it.

### Notes

- `wrangler d1 export` refuses databases with FTS5 tables (EmDash search). The dump writes tables, then search tables and their triggers, then rows with parent tables before child tables (D1 imports large files in batches, so deferred foreign keys aren't enough), then indexes and the remaining triggers.
- Backups run in one Worker request, so they suit small and medium sites. The dump is streamed: rows are read 500 at a time (paged by rowid) and gzipped straight into the backup bucket (as a multipart upload in 5 MB parts once it's bigger than one part), so the Worker never holds the whole dump in memory. The database is saved before the media mirror runs. The mirror copies at most 300 changed files per run, 8 at a time; the rest follow on the next run.
- Integers larger than 2^53 lose precision (D1 returns JavaScript numbers). EmDash stores IDs as text.

## Redirects

EmDash's built-in Redirects (**Manage → Redirects**) handle site-relative page redirects. This module covers what they can't, and leaves the rest to EmDash. Compared with EmDash 1.3:

| | EmDash Redirects | Coywolf Pack Redirects |
|---|---|---|
| External destinations (affiliate links such as `/visit/partner`, articles that moved to another site) | No: destinations must be site paths | Yes |
| File paths (old WordPress `/wp-content/uploads/` image URLs, `/file.pdf`) | No: its middleware skips any path with a file extension | Yes |
| Patterns | Whole-segment placeholders only (`/old/[slug]`, `/docs/[...rest]`) | Regular expressions with `$1`–`$9` substitution |
| Query strings | Dropped | Passed on to the destination (unless it has its own) |
| Bulk import and export | No (only seed files and full-site transfers) | Paste or upload JSON, CSV or TSV (a Coywolf SEO export from WordPress works as is); export as CSV or JSON |
| URL tester | No | Yes |
| Notes | A group label | A note per rule |
| Trashed or unpublished entries | Nothing | Prompt for a redirect or 410, undone when the entry comes back (see [Removed content](#removed-content)) |
| Edge caching | Doesn't cache redirects (checks its rules before a page is cached) | Kept in Workers Cache for 30 days, cleared on any redirect change, along with the pages at new sources |
| Status codes, trailing slashes, hit counts, enable/disable | Yes (also 451) | Yes (301/302/307/308/410) |

Left to EmDash, which does them and the pack doesn't: **automatic redirects when an entry's slug changes**, the **404 log** with "create redirect from this 404", and **loop detection** across rules. When both have a rule for the same path, EmDash's wins (its middleware runs first).

Features: exact paths (with or without a trailing slash) or regular expressions with `$1`–`$9` substitution, 301/302/307/308/410, enable/disable, notes, hit counts, a URL tester, bulk import (paste or choose a file: JSON, or tab/comma-separated `source, target, type, is_regex` rows; a Coywolf SEO export from WordPress works as is), and **Export** as CSV or JSON. Rules are stored in the site's D1 database (`coywolf_redirects`), so backups include them.

A capture group can't send visitors to another site: with a site-path destination such as `/$1`, leading slashes from the capture are collapsed (`/blog//evil.com` → `/evil.com` on your site, never `//evil.com`), and a destination that names its host (`https://example.com$1`) only redirects when the result keeps that host. A destination whose host is itself a capture (`https://$1/`) is followed as written.

### Setup

Add the middleware to `src/middleware.ts`:

```ts
import { sequence } from "astro:middleware";
import { coywolfRedirects } from "@coywolf/emdash/middleware";

export const onRequest = sequence(coywolfRedirects(), /* your middleware */);
```

Each request looks up its exact rule in D1: one indexed read of the request path (trailing slash removed), so an exact rule edit applies at once and the database reads at most one row however many rules there are. Pattern rules (usually few) are kept in memory per Worker isolate, in source order, and read again after a redirect edit (at once in the isolate that saved it, in others within five minutes; see [Database reads](#database-reads)) or after ten minutes, through their own index (`coywolf_redirects_patterns`, added to existing sites the next time the Redirects page opens). Exact rules win over patterns. When the feature switches aren't cached, the lookup goes in the same D1 batch as them. Serving never writes: the `coywolf_redirects` table is created by the first admin write (saving or importing a rule), and until then there are simply no rules. Hits are counted after the response is sent.

**Edge caching.** With Astro's route caching on (`cacheCloudflare()`), GET and HEAD redirects (and 410s) are kept in the edge cache (Workers Cache) for 30 days, keyed by path and query string, and tagged `coywolf-redirects`. Any redirect change (saving, deleting, enabling or disabling, importing, resolving removed content, rewinding the database) purges that tag, as does **Clear pages and images** and every deploy. Browsers keep a redirect for an hour (`Cache-Control: max-age=3600`); the edge lifetime and tag go in `Cloudflare-CDN-Cache-Control` and `Cache-Tag`, which Cloudflare strips before the response reaches the browser. Cached site-path redirects carry a site-relative `Location`, since the edge cache is shared by every hostname the Worker answers. Repeat requests served from the cache never reach the Worker, so **hits count requests the Worker answered**, not every visit. Without route caching, redirects send `Cache-Control: private, max-age=3600` and are never edge-cached.

`coywolfPack()` takes no redirect options; `serveRedirect(url, env, waitUntil, { cacheSeconds })` (ten minutes by default) is the longest time to keep pattern rules.

### Removed content

Feature **Redirects → Removed content** (`redirects.trashPrompt`, off by default). When a published entry is trashed or unpublished, the admin asks right away what its old URL should do:

- **Redirect to…** creates a Coywolf redirect rule (301 by default) from the old URL.
- **Return 410 Gone** creates a 410 rule, telling search engines the page is gone for good.
- **Decide later** (or Escape) closes the prompt. Until you decide, the old URL returns 404.

Trashing several entries at once (bulk trash) asks once, listing each of them. Undecided URLs stay listed in a **Removed content** panel on the Redirects page, with the same choices plus **Dismiss**, which forgets an entry (for example, when the URL should simply 404).

The old URL is resolved the way EmDash resolves it: the collection's URL pattern (`{slug}`, `{id}`, and date tokens from the publish date), or `/<collection>/<slug>`. Locale prefixes aren't added. Drafts that were never published aren't listed or prompted for. Restoring an entry from the trash (it comes back as a draft) or republishing it removes it from the list and **undoes the rule its decision created**, as long as that rule still has its `Removed:` note and the same source; a republished entry must also be back at the same URL (a new slug keeps the redirect from the old one, and a later publish back at the old URL still undoes it). A redirect that already exists for the old URL is never overwritten or adopted: the decision says so, and you can keep it (Dismiss the entry) or change it under Redirects. An entry that turns out to be live after all (its trash failed, or it came back some other way) is forgotten the next time the list is read. Decisions are kept in plugin storage (`redirects_removed`), and the rules they created in `redirects_applied`. The module declares the `content:read` capability for the delete and publish hooks.

How the prompt knows: EmDash has no admin event for a trash or unpublish, so the pack's admin module watches the admin's own content API calls (`DELETE /_emdash/api/content/<collection>/<id>` and `POST …/<id>/unpublish`), never altering or reading their responses, then asks the server which of those entries it recorded. The trash is recorded before EmDash answers the request; an unpublish is recorded just after, so the prompt looks again for up to about two seconds when an unpublish isn't listed yet (trashed drafts don't hold it up). If a future EmDash release changes those API paths, the prompt stops appearing, but the Removed content list on the Redirects page keeps working.

### Export redirects from WordPress (Coywolf SEO)

```bash
wp db query "SELECT source, target, type, is_regex FROM wp_coywolf_seo_redirects"
```

Paste the output into **Redirects → Import**.

### Export and move redirects

**Export** (next to Import) downloads every rule as CSV (for spreadsheets) or JSON. Either file imports back on this or any other site through **Import → Choose file**, updating rules with the same source:

- CSV columns: `source, target, type, is_regex, enabled, note`, then `hits, last_hit, created_at, updated_at` for reference (Import ignores them, so hit counts start over on the new site). Cells that a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`) get a leading apostrophe, which spreadsheets hide; Import removes it again, so the round trip is exact.
- JSON: an array of rules, as the list route returns them.

Import takes up to 5,000 rules (2 MB) at a time; split bigger files.

## Headings & TOC

Ported from Coywolf SEO. Off until you turn it on under **Plugins → Coywolf Pack**:

| Feature | Default | What it does |
| --- | --- | --- |
| `headings` | off | Main switch |
| `headings.anchors` | off | Every H2–H6 gets an id like `jump-pricing`, plus an optional "copy link to section" button on hover and focus |
| `headings.toc` | off | **Table of Contents** block: title (shown or hidden, and its heading level, H2 by default, for always-open tables), heading levels (any of H2–H6), plain/bulleted/numbered (1, 1.1, 1.1.1), always open or collapsible (open or collapsed) |

Site defaults live on **Headings & TOC**: id prefix, copy link, scroll offset for sticky headers (px or rem), and TOC defaults (title, show title, levels, style, display, minimum headings, smooth scrolling). Breadcrumbs moved to their own module, [Breadcrumb Nav](#breadcrumb-nav), in 0.6.0.

Anchors are written into the content when it's saved (an `anchor` field on each heading block), so they're unique within the entry and stay the same when a heading is reworded. A Table of Contents block stores the entry's heading list the same way, so the table always matches the anchors. After turning the features on, re-save an entry to stamp it; until then headings get ids from their text when the page renders.

### Setup

EmDash lets plugins add block types but not change how headings render, so the theme passes the pack's heading renderer to `PortableText` (one line, wherever content is rendered):

```astro
---
import { PortableText } from "emdash/ui";
import { portableTextComponents } from "@coywolf/emdash/astro";
---
<PortableText value={entry.data.content} components={portableTextComponents} />
```

If you already pass components, merge them: `components={{ ...portableTextComponents, type: myTypes }}`. With the anchors and TOC features off, headings render exactly as before.

### Notes

- Output is server-rendered. Collapsing uses `<details>`, smooth scrolling is CSS (and is skipped for visitors who prefer reduced motion), and the only script is a small inline one for the copy-link button, sent only when that option is on.
- Markup follows Coywolf SEO's accessibility rules: the TOC is a labeled `<nav>` (its title is never a heading inside `<summary>`).
- The module declares the `content:write` capability (EmDash only registers a `content:beforeSave` hook for plugins that have it; the hook changes nothing but heading anchors and the TOC block's stored data) and `content:read`. Anchors are kept across edits by matching block keys (then heading text) against the stored entry. When an entry has unpublished draft revisions, anchors of headings added in an earlier draft are matched by text.
- Styles use `cw-` classes and the theme's colors, in light and dark mode.
- With the features off, markup is unchanged, but the components' small global stylesheet (`cw-` classes only) is still bundled on pages that import them.

## Breadcrumb Nav

An accessible breadcrumb trail (`<nav aria-label="Breadcrumb">` around an `<ol>`, `aria-current="page"` on the current page, separators in CSS that screen readers skip), as a component for theme layouts and as a **Breadcrumbs** block for content. Off until you turn it on under **Plugins → Coywolf Pack**:

| Feature | Default | What it does |
| --- | --- | --- |
| `breadcrumbs` | off | Main switch: the `Breadcrumbs` component, the **Breadcrumbs** block, and the **Breadcrumb Nav** page |

Until 0.6.0 this was the `headings.breadcrumbs` sub-feature of Headings & TOC. Sites keep their state: while `breadcrumbs` has never been saved, it follows the stored `headings.breadcrumbs` switch (on only if Headings & TOC was on too), and the settings fall back to the breadcrumb defaults stored with Headings & TOC until the Breadcrumb Nav page saves its own. The block type (`coywolf-breadcrumbs`), the `Breadcrumbs` export and the stored block data are unchanged, and Breadcrumb Nav no longer depends on Headings & TOC being on.

Site defaults live on **Breadcrumb Nav** (with a live preview): separator (`/`, `›`, `»`, `•`, `→`, `>`, or a custom string of up to 8 characters), home label, and whether the trail starts with the home page and ends with the current page. The page also has a step-by-step guide for adding the component to a theme, with copyable code.

### Setup

Add the component to a layout, passing the same page context you give `EmDashHead`:

```astro
---
import { EmDashHead } from "emdash/ui";
import { createPublicPageContext } from "emdash/page";
import { Breadcrumbs } from "@coywolf/emdash/astro";

const page = createPublicPageContext({ Astro, kind: "custom", title, pageTitle: title, breadcrumbs });
---
<EmDashHead page={page} />
…
<Breadcrumbs page={page} />
```

Give each page its real trail with `breadcrumbs` (root first, current page last); `[]` hides the trail on that page, and leaving it out derives one from the URL:

```js
breadcrumbs: [
  { name: "Home", url: "/" },
  { name: category.label, url: `/${category.slug}/` },
  { name: entry.data.title, url: Astro.url.pathname },
],
```

Props: `page` (the `PublicPageContext` you pass to `EmDashHead`), `items` (`{ name, url }[]`), `title`, `separator` (`slash`, `chevron`, `guillemet`, `bullet`, `arrow`, `gt`, or any short string), `homeLabel`, `showHome`, `showCurrent`, `class`, `label` (the nav's `aria-label`, default "Breadcrumb"). Props override the site defaults.

The trail comes from, in order: `items`, `page.breadcrumbs`, the trail the theme gave `EmDashHead` for the same URL (picked up by the module's `page:metadata` hook, so the Breadcrumbs block uses it too), or the URL path (home, one crumb per path segment with a readable name, then the page title). Give themes with archives or nested content a real trail through `page.breadcrumbs`: derived ancestor links point at whatever the path segments are, which may not be pages.

With Schema & Social's `schema.breadcrumbs` on, the `BreadcrumbList` is built from the same `page.breadcrumbs`, so one trail feeds both the visible nav and the structured data. The schema uses the trail as given (include Home and the current page); the nav applies the start-with-home and end-with-current settings.

Without theme changes, add a **Breadcrumbs** block to an entry instead. Each block can override the separator, home label, and whether the current page shows; the entry's title is saved with the block for the last crumb.

### Styling

Classes: `.cw-breadcrumbs` (the `<nav>`, plus `.cw-breadcrumbs--sep-<preset>`), `.cw-breadcrumbs__list` (the `<ol>`, a wrapping flex row), `.cw-breadcrumbs__item` (each `<li>`; the separator is its `::before`), `.cw-breadcrumbs__current` (the current page). The separator is the `--cw-bc-sep` custom property (a CSS string). Links use the theme's colors. The component's rules are single-class, so a selector like `.site-header .cw-breadcrumbs a { … }` overrides them regardless of stylesheet order.

### Notes

- Server-rendered with no script; the small global stylesheet (`cw-` classes only) is bundled on pages that import the component, even with the feature off.
- A trail of one crumb (just Home, or just the page) isn't shown.
- The Breadcrumbs block picks up the theme's trail only when the theme renders `<EmDashHead page={page} />` with the page's real `url`; it's matched by path and query string, so locales and variants don't mix.
- The module's `content:beforeSave` hook only writes `_title` on Breadcrumbs blocks (it declares the `content:write` capability EmDash requires for the hook).
## File Downloads

The Coywolf Files plugin for WordPress, on EmDash. Add a **File download** block to any entry and visitors get a download card: a colored file-type badge, the file name, a "PDF · 2.4 MB · Uploaded Mar 4, 2026" line, a Download button, and a Copy link button.

- **Block**: pick a file from the Media Library or from large uploads, then give it a title and description for that placement. Toggles show or hide the icon, description, meta line, Download, and Copy link. The card is server-rendered, scoped (`cw-file`), follows light/dark (or a fixed scheme), and ships one small script for Copy link (clipboard, checkmark, screen-reader announcement).
- **Download URLs**: `/download/<id>/<file name>`, served by the pack middleware. Files stream from R2 with `Content-Disposition: attachment`, the right `Content-Type`, `Content-Length`, `ETag`, conditional requests, and single byte ranges with `If-Range` (resumable downloads; a request for several ranges gets the whole file). Or set a public bucket / CDN URL and downloads redirect there.
- **Files page** (**Plugins → Files**): every file used in a File download block plus every large upload, with type, size, upload date, downloads, and the entries that use it. Search, In use / Unused filters, copy link, delete, and **Export CSV** (every file with its full download URL, size, download count, last download, and the entries that use it). Deleting a large upload removes the object from R2; the page lists the entries that still use it (their blocks then render nothing). Media Library files are deleted in the Media Library.
- **Large uploads**: files of any type and size (EmDash's own uploads stop at 50 MB and images, video, audio, and PDF) go straight from the browser to R2 in 8 MB+ parts, four at a time, with progress, retries, and Cancel. The Worker only signs URLs (AWS Signature V4 with Web Crypto, no AWS SDK).

### Feature switches

| Feature | Default | What it does |
| --- | --- | --- |
| `files` | off | The block, download URLs, and the Files page |
| `files.counts` | off | Count downloads (batched D1 writes after the response) |
| `files.largeUploads` | off | Large uploads to R2, up to 50 GB (needs the settings below) |

### Setup

1. Turn on **File Downloads** under **Plugins → Coywolf Pack**. The middleware from the Redirects setup (`coywolfPack()`) serves the download URLs; nothing else to add.
2. Settings (**Files → Settings**): download URL base (default `download`), optional public bucket / CDN URL, card color scheme, accent color, and largest upload (default 5 GB).
3. Bindings: `DB` and `MEDIA`. To keep large uploads in their own bucket, bind it as `FILES` (or pass `files: { uploads: "MYBINDING" }`, and note the middleware looks for `FILES`).

### Large uploads

1. Create an R2 API token (**R2 → Manage API tokens**) with **Object Read & Write** on the bucket. Enter the account ID, access key ID, secret access key (stored encrypted), and bucket name under **Files → Settings → Large uploads**. Until all four are saved, the Files page shows a setup card instead of the uploader. The bucket must be the one bound as `MEDIA` (or `FILES`), since downloads stream through that binding.
2. Add a lifecycle rule to the bucket (**R2 → bucket → Settings → Object lifecycle rules**): **Abort incomplete multipart uploads after 1 day**. The pack also aborts uploads left unfinished for 24 hours in a daily task, but the rule catches anything the task can't reach (for example after the credentials change).
3. On the Files page, **Upload large file**.

The browser sends the file to the site in 6 MiB parts (`files/upload-part`), and the Worker uploads each to R2's multipart upload. Since EmDash 1.3.1, admin pages send `Content-Security-Policy: connect-src 'self'`, which blocks the browser from talking to R2 directly; the bucket needs no CORS policy. Each part must be exactly its expected size and belongs to the upload `files/upload-start` recorded, so a request can't write anywhere else. With 10,000 parts at most, a file can be up to just under 60 GB; the **largest upload** setting goes up to 50 GB.

Only administrators (`plugins:manage`) can upload, and uploads above the **largest upload** setting (default 5 GB, at most 50 GB) are refused. R2 storage and operations are billed to your Cloudflare account.

Files are stored as `files/<id>/<name>` with their metadata in plugin storage. Files moved from Coywolf Files for WordPress keep their 20-character WordPress id and object key (see [Migrating from WordPress](#migrating-from-wordpress)). The pack calls only `<account>.r2.cloudflarestorage.com`.

### Notes

- Which entries use which file comes from an index updated on every save and delete. **Rebuild usage** rescans all content (needed once if blocks existed while the module was off). Entries moved to the trash stop counting as uses.
- Download counts are kept per isolate for a second and written together, so a burst of downloads costs one D1 batch. Counts made just before an isolate is evicted can be lost. A HEAD request, a 304, or a later range chunk isn't counted.
- Any ready Media Library item can be downloaded through `/download/<its id>/…`, whether or not a block uses it. That's the same exposure as EmDash's own `/_emdash/api/media/file/<key>` URLs: media files are public to anyone with the link.
- Lookups are cached per Worker isolate for 60 seconds, including "not found". A file requested just before its upload finished can keep answering 404 on that isolate for up to a minute.
- With a public bucket / CDN URL, downloads redirect to it, so the file name comes from the object key and the CDN decides the headers.

## Private form uploads

The EmDash Forms plugin (`@emdash-cms/plugin-forms`) saves a file field's upload in the **media library**, where every file is public to anyone with its URL (`/_emdash/api/media/file/<key>`). With **Private form uploads** on, those files go to a private R2 bucket instead, and only admins can get them back.

- **Where files go**: an R2 bucket with no public access (no r2.dev URL, no custom domain), bound as `FORM_UPLOADS`. Nothing is written to the media library, so there's no public URL to cache.
- **Form uploads page** (**Plugins → Form uploads**): every private file, newest first, with its form and field, size, upload time, and the submission it came with (date and a short preview of the answers). **Download** and **Delete** per file.
- **Downloads**: an admin-only route (`plugins:manage`, EmDash's CSRF header required). The file is always sent as an attachment with a type that can't render (HTML, SVG, XML, scripts and unknown types go out as `application/octet-stream`), with `nosniff`, a sandbox CSP and `no-store`. The page saves the bytes as a file; it never opens them.
- **Cleanup**: deleting a submission in Forms (one, all of a form's, or by the form's retention setting) deletes its files. A daily task also removes files whose submission is gone or never saved, and, if **Delete files after (days)** is set, files older than that (the submission stays).
- **Which forms**: all forms (default) or only the ones checked on the Form uploads page.
- **Files from before**: a **Move to private bucket** button moves files that earlier submissions left in the media library, points each submission at its private copy, and deletes the media library copy.

Everything else about the form is still the Forms plugin's own: spam protection (honeypot, Turnstile), validation, the field's accepted types and size limit (and its 10 MB cap), notifications, webhooks, and the confirmation message. The private bucket takes the same file types the media library would (images, video, audio, PDF); anything else is refused, as before. File names are cleaned up (no paths, control or invisible characters, or characters Windows and macOS refuse; at most 120 characters) before they're stored or saved.

### Feature switches

| Feature | Default | What it does |
| --- | --- | --- |
| `formUploads` | off | Files from selected forms go to the private bucket |

### Setup

1. Create the bucket and leave public access off: `npx wrangler r2 bucket create mysite-form-uploads`.
2. Bind it in `wrangler.jsonc`:

   ```jsonc
   "r2_buckets": [
     { "binding": "MEDIA", "bucket_name": "mysite-media" },
     { "binding": "FORM_UPLOADS", "bucket_name": "mysite-form-uploads" }
   ]
   ```

3. Wrap the Forms plugin in `astro.config.mjs`:

   ```js
   import { coywolfPlugin, privateFormUploads } from "@coywolf/emdash";
   import { formsPlugin } from "@emdash-cms/plugin-forms";

   plugins: [
     coywolfPlugin({ /* … */ }),
     privateFormUploads(formsPlugin({ defaultSpamProtection: "honeypot" })),
   ]
   ```

   Options (second argument): `bucket` (default `"FORM_UPLOADS"`), `mediaBucket` (default `"MEDIA"`, for moving earlier files), `database` (default `"DB"`).
4. Deploy, turn on **Private form uploads** under **Plugins → Coywolf Pack**, and check **Plugins → Form uploads**.

### How it works

`privateFormUploads()` keeps the Forms plugin's id, storage, settings and admin pages, and points its code entry at `@coywolf/emdash/forms`, which runs the Forms plugin's own routes and hooks with one change: the `ctx.media` they get. Its `upload()` writes to the private bucket (when the feature is on and the form is selected) and its `delete()` removes private files; every other call goes to the media library as before. The submission records the file as media id `coywolf-private:<id>`, and the file's details (form, field, name, size, submission) are kept in the Forms plugin's KV. The Form uploads page calls routes added to the Forms plugin at `/_emdash/api/plugins/emdash-forms/coywolf-private-uploads/*`.

### Notes

- With the feature on but no `FORM_UPLOADS` binding, a submission with a file fails ("File uploads are not configured") rather than storing the file publicly. If the switch can't be read, files stay private.
- Turning the feature off sends new files back to the media library and takes Form uploads out of the sidebar. Files already in the private bucket stay private; turn the feature back on to download or delete them.
- The Forms plugin's own admin doesn't show files; use the Form uploads page. Its CSV export and notification emails show the file name, and its webhook payload carries the `coywolf-private:<id>` media id.
- Downloads arrive in 4 MB parts (plugin responses are capped at 8 MB) that the page joins.
- The wrapper relies on the Forms plugin storing files through `ctx.media.upload()` and deleting them through `ctx.media.delete()` (true in 0.2.x). If a Forms update changes that, re-check before updating.

## Code Blocks

A port of Coywolf Code Block Enhancer. It replaces the site renderer for EmDash's built-in code block (the editor's language picker is unchanged) with one that highlights code **on the server** using highlight.js grammars (via lowlight, which EmDash already ships). Visitors download no highlighting script.

- **Themes** (**Plugins → Code Blocks**, with a live preview): Coywolf Auto (light/dark by system), Coywolf Always light, Coywolf Always dark, four light/dark pairs that follow the system setting (GitHub, Atom One, A11y, Tokyo Night), and 19 popular highlight.js themes (GitHub, GitHub Dark, Monokai, Nord, Dracula, Solarized, Visual Studio, Xcode, Night Owl and more). The theme is the `codeBlocksTheme` setting. Every theme meets WCAG AA contrast (4.5:1): highlight.js colors below that against their theme's background (comments in most themes, Rosé Pine's body text) are darkened or lightened, keeping their hue, and line numbers and the language label use muted colors that still pass (the faded text they always had, raised only where that fell under 4.5:1).
- **Language label**, **Copy button** and **Line numbers** are sub-features. The copy button follows the WordPress plugin's accessible pattern: a labeled button, a polite live region that announces "Copied to clipboard", a two-second confirmation, and no animation for visitors who prefer reduced motion. Line numbers are drawn with CSS, so they're never selected or copied. The header shows the language on the left (file names aren't shown) with the copy button on the right.
- **Page weight**: the layout CSS (about 2 KB), the active theme's CSS (1–4 KB) and, with the copy button on, one small inline script (under 1 KB) are inlined once per page by the first code block. Pages without code blocks get nothing, and no external requests are made.

Feature switches: `codeBlocks` (main), `codeBlocks.label`, `codeBlocks.copy`, `codeBlocks.lineNumbers`, all off by default. While `codeBlocks` is off, code blocks render exactly as EmDash's built-in renderer does.

### Setup

Nothing beyond the plugin itself: the block renderer is registered through the plugin's `componentsEntry`, so it applies wherever the site renders Portable Text with EmDash's `<PortableText>`. It reads the theme and switches from the site's D1 database (`DB`), cached for five minutes per Worker isolate (a save on the Code Blocks page applies at once in that isolate; see [Database reads](#database-reads)).

### Notes

- Languages: Prism names used by Code Block Enhancer for WordPress work too (`markup` is HTML, `svg` and `mathml` are XML). EmDash's editor list (Astro, Svelte and Vue are highlighted as HTML, MDX as Markdown, TOML as INI) plus highlight.js's common grammars. Unknown languages, blocks over 30,000 characters and blocks with any line over 2,000 characters are shown as plain text (highlight.js slows sharply on long lines). Rendered blocks are cached in memory (200 per Worker isolate), so repeat page views don't re-highlight.
- Theme CSS is generated from highlight.js's own stylesheets (BSD-3-Clause, each theme's original credits kept) by `node scripts/gen-code-themes.mjs`.
- Tests: `node --import ./test/ts-resolve.mjs --test src/codeBlocks/render.test.ts`.

## Schema & Social

The structured data and social tags from Coywolf SEO for WordPress, configured on **Plugins → Schema**. Everything is off until you turn it on under **Plugins → Coywolf Pack → Schema & Social**:

| Feature | What it does |
| --- | --- |
| `schema` | The module's main switch. |
| `schema.graph` | One JSON-LD `@graph` per page in place of EmDash's built-in JSON-LD (it uses the same `primary` id, so EmDash's is replaced, not duplicated): WebSite (with a SearchAction), the publisher Organization or Person, a typed WebPage, the primary ImageObject (with dimensions and alt), author Person nodes, and a typed Article. It keeps everything EmDash's own JSON-LD has: headline, description, image, dates, author and publisher. |
| `schema.breadcrumbs` | A BreadcrumbList. Uses the theme's `breadcrumbs` from the page context when it passes them (`[]` means none), otherwise it's derived from the URL path (parent segments, then the page title). **If your theme prints its own BreadcrumbList, remove it when you turn this on**, or pages will have two. |
| `schema.robots` | A robots meta tag: `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1` by default, merged with each entry's **No index** (which stays `noindex, nofollow`). |
| `schema.openGraph` | `og:locale`, plus `og:image:width`, `og:image:height`, `og:image:type`, `og:image:alt` and `twitter:image:alt` when the image is from the media library. |
| `schema.authors` | Schema.org Person properties per byline (job title, sameAs profiles, image, description…), used as article authors. |

The Schema page has:

- **Site details**: whether the publisher is an Organization or a Person (a byline), and the publisher's properties, picked from the same property list as on WordPress (name, legalName, url, logo, sameAs, address, contactPoint, founder, and so on; logo and image can come from the media library). Anything left empty falls back to EmDash's site title, URL and logo.
- **Types**: the WebPage subtype (AboutPage, ContactPage, CollectionPage…) and Article subtype (BlogPosting, NewsArticle, TechArticle… or none) for the home page, other non-entry pages, and each collection. By default, article pages get a BlogPosting, as with EmDash's own JSON-LD, and everything else a WebPage.
- **Authors**: Person properties per byline. Bylines without saved properties use their name, website (or the author page URL), bio and avatar. Tick **Profile page only** on a property (birthDate, birthPlace, email, gender, nationality…) to output it only on the page whose main subject is that person, not on every article they wrote.
- **Overrides**: for a single entry, a different page or article type, and its **main subject**: what the page is about. Pick a byline for a profile page, or the site publisher for an About or Contact page. See [Main subject](#main-subject).
- **Robots & social**: the search URL template (`/?s={search_term_string}` by default; empty for no SearchAction), the author page URL pattern (empty by default: set it to match your site's author pages, e.g. `/author/{slug}/`, so authors get a `url` and `@id` there; without it, authors without a byline website get no `url` and an `@id` on the site root), the breadcrumb home label, the robots directives (a blank max-snippet or max-video-preview means -1, no limit), and an `og:locale` override (derived from the site locale otherwise, e.g. `en` → `en_US`).
- **Preview**: the tags and JSON-LD the module would add to the home page or an entry.

### Setup

Nothing to configure beyond the Schema page. The module reads the site database (`DB` by default; set `schema: { database: "MY_DB" }` otherwise) to look up image dimensions and alt text, cached per Worker isolate for 10 minutes. Its settings come with the feature switches' query; its Site Details, types and author properties are cached until a pack settings save (here or in another isolate, see [Database reads](#database-reads)) or ten minutes. It needs the `content:read`, `schema:read`, `bylines:read` and `media:read` capabilities, which it declares.

#### Pass the entry to save reads

A theme that renders an entry already has it (from `getEmDashEntry()`), with its bylines hydrated by EmDash. Pass it on the page context as `coywolf.entry`, and Schema & Social takes the credited bylines (`entry.data.bylines`) and the entry's blocks (for review schema) from it instead of reading them again: two to five fewer queries per page. It's only used when `entry.data.id` is the page's `content.id`. `coywolf.bylines` (just the credits) works too.

```astro
---
const { entry } = await getEmDashEntry("posts", slug);
const page = { ...createPublicPageContext({ Astro, kind: "content", content: { collection: "posts", id: entry.data.id, slug: entry.id }, /* … */ }), coywolf: { entry } };
---
<EmDashHead page={page} />
```

### Notes

- Page types come from the page context your theme passes to `EmDashHead`: an entry page is matched to its collection through `content`, and `pageType: "article"` is what makes a page an article by default. Pages without `content` use the home page or "other pages" types.
- Derived breadcrumbs name parent segments from the URL (`/health-tips/` → "Health tips"); pass `breadcrumbs` in the page context for exact names.
- A content page costs a few extra database reads per render (the entry override, its bylines, and saved author properties); image lookups and settings are cached.
- **Default bylines: link your byline to your user account under Bylines** (Content → Bylines → your byline → user; that also turns off **Guest**). EmDash then credits every post or page you create without picking a byline to your byline: the editor shows it as **Automatic**, and EmDash's reads (`entry.data.bylines`, `getEntriesBylines`) return it like a picked one, so the article's author schema names you with no change here. EmDash stores no credit for it, so `where: { byline }` (and `getEntriesByByline`) don't list those entries: an author page that should has to add the user's own (`where: { author_id }`) entries credited to the byline, as the Coywolf themes' `src/lib/byline-entries.ts` does. To link from the command line: `node scripts/byline-link-user.mjs --url=https://example.com` (a dry run that finds the site's admin and the byline with their name and lists the entries that will start showing it; `--byline=<slug>` and `--user=<id>` pick others, `--apply` saves, `--purge-cache` then clears the page cache). It uses EmDash's admin API with your `npx emdash login` (or `EMDASH_TOKEN`) and sends the byline's bio, avatar and website back with it, since EmDash's byline save clears them when they're left out.

### Main subject

An override's **Main subject** makes the page's WebPage node point at what the page is about with `mainEntity`, and puts that entity in the graph once:

- **A byline**: the Person from the Authors tab, with the same `@id` it has as an article author, plus its **Profile page only** properties. The entry's own credited bylines are listed first.
- **Site publisher**: the publisher Organization (or Person) from Site details.

For an author's profile page, set the page type to **Profile page**, the article type to **None**, and the main subject to the person:

```json
{ "@type": "ProfilePage", "@id": "https://example.com/jon-henshaw/#webpage", "mainEntity": { "@id": "https://example.com/jon-henshaw/#person" }, "dateCreated": "…", "dateModified": "…" },
{ "@type": "Person", "@id": "https://example.com/jon-henshaw/#person", "name": "Jon Henshaw", "birthDate": "1973-09-09", "…": "…" }
```

A ProfilePage also gets `dateCreated` (the entry's publish date) next to `dateModified`. When the main subject is the publisher, or is also credited as the article's author, it's still one node: the copies are merged. `birthPlace`, `homeLocation` and `workLocation` are output as a `Place` and `nationality` as a `Country` (named by the value).

### Videos in the graph

With the graph on, embedded videos are VideoObject nodes inside it, linked from the Article (or WebPage) as `video`: videos from the Videos module (when Video schema is on) and any a theme passes on the page context:

```astro
---
const page = { ...createPublicPageContext({ /* … */ }), coywolf: { videos: [
	{ name, description, thumbnailUrl, embedUrl, contentUrl, uploadDate, duration: "PT18S" },
] } };
---
<EmDashHead page={page} />
```

Theme videos are validated (absolute http(s) URLs, ISO 8601 duration) and de-duplicated by embed or content URL. When the graph is on, the Videos module doesn't print separate VideoObject blocks.

A video's details (metadata, plays and likes, whether it's in a published entry) are read once per request: the schema and every Coywolf Video block on the page share one D1 batch.

## Search

EmDash has full-text search built in: SQLite FTS5 with BM25 ranking, English stemming, prefix matching, highlighted snippets, a public API (`/_emdash/api/search`), and a `LiveSearch` component. This module adds what it leaves out. Turn on **Search** and its parts on the Coywolf Pack page. Search is off by default; once it's on, **Live results** is on too, and the other parts are off until you turn them on.

- **Search settings** (`search.settings`): a **Search** admin page to choose which collections are searchable, set field weights, pick the tokenizer (English stemming, exact words, or trigram substrings), and rebuild indexes with a progress readout and per-collection entry counts. It calls EmDash's own search API, so it needs EmDash's `search:manage` permission (admins). Fields are made searchable in each collection's schema.
- **Live results** (`search.live`, on by default with Search): matching entries in a dropdown as visitors type into the site's search box, like the Coywolf Search WordPress plugin. See [Live results](#live-results).
- **Search box** (`search.box`): a `SearchBox` component with as-you-type suggestions while **Live results** is on (titles first, then full text, with excerpts), arrow keys, Enter and Escape, a clear button, content-type labels, highlighted matches, screen-reader announcements, and a fade that respects reduced motion. When nothing matches every word, it shows results for any of the words, ranked by how many they contain. Without JavaScript it's a plain search form that submits to your search page.
- **Search rate limit** (`search.rateLimit`): limits each visitor to 120 searches a minute (configurable) on EmDash's public search and suggestion endpoints and the pack's search and live results routes, answering `429` with `Retry-After`. Visitors are keyed by a salted hash of their IP address, never the address itself.

### Live results

With **Live results** on, every public page gets a small deferred script at the end of the body (via EmDash's page fragments, so the layout needs `<EmDashBodyEnd>`): `<script src="/_emdash/api/plugins/coywolf-pack/search/live-client?v=<version>" defer data-cw-live="…">`, with the page's settings in the attribute. The file (about 21 KB, 6.5 KB compressed) has a versioned URL, so browsers download it once and keep it for a year (`immutable`); a new pack version changes the URL. Only the pack middleware serves that file (EmDash's plugin routes can't answer with a JavaScript content type or set its cache headers), so on sites without the middleware the same client is added inline at the end of the body instead. It attaches to any GET form with a search field (`type="search"`, or a field named `s` or `q`), so a theme's own search form works as is; the pack's `SearchBox` has the same dropdown built in. Pages without a search form do nothing with it, and its styles are added only when a form is found.

- **Instant title matches.** The first time a visitor focuses a search field, the script loads a compact title index (every published entry's title, URL and type, newest first, up to 5,000) and sends a tiny warm-up request so the server is ready. From then on, title matches appear as soon as a key is pressed, with no server round trip. Matching ignores case and accents ("ecole" finds "École"); titles that start with what was typed come first, then titles with every word at the start of a word, then titles that contain the words (3+ letters).
- From 2 characters, 120 ms after the last keystroke, it also asks the server, which answers with up to 8 entries: title matches first, then full-text matches (with the any-word fallback). The answer merges into the list without reshuffling it: rows the server also found gain their excerpt in place, its other results are added below, and when the list is full, title matches the server didn't confirm make room. Each row has the title, with the typed words underlined, and an excerpt of about 180 characters around the first match, with the matches in bold and "…" where it was cut. A final **View all results** row opens the search page, the same URL the form submits.
- The first result is selected as results appear, so Enter opens it. Arrow keys move (wrapping, and through View all results), Escape closes the list and a second Escape clears the field, Tab or a click elsewhere closes it, and submitting the form searches as before. Results are real links, so middle-click and "open in new tab" work.
- Accessible as an ARIA combobox: `role="combobox"` with `aria-expanded`, `aria-controls` and `aria-activedescendant` on the field, a `listbox` of `option`s, and a polite live region announcing the result count (with a one-time keyboard hint). When the list fills in twice (instant matches, then the server's answer), the count is announced once, for the final list, unless the server takes longer than 0.7 seconds. A result picked with the arrow keys or the pointer stays picked when the server's answer arrives. A clear (×) button sits inside the field for pointer and touch; Escape does the same from the keyboard. Forced colors are respected, and the fade is skipped for reduced motion.
- It takes the theme's font and text color from the form and its background from the nearest opaque ancestor, and tints with `currentColor`, so it fits light and dark themes without configuration.
- In-flight requests are cancelled as you type, answers are cached per query for the page view, and a slow earlier answer never replaces a newer one. Without JavaScript the form works exactly as before.

Results come from `GET /_emdash/api/plugins/coywolf-pack/search/live?q=…` (optional `limit` up to 20, `collections`, `locale`): published entries only, each with `title`, `titleHtml`, `url`, `type` and `snippet`. `titleHtml` and `snippet` are escaped HTML whose only tags are `<mark>`. Excerpts come from the text EmDash indexed (the searchable fields other than the title). `?warm=1` does nothing but load the search setup into a server isolate (answers `204`). The title index is `GET /_emdash/api/plugins/coywolf-pack/search/index?v=…` (optional `locale`, `collections`): `{ v, types, entries: [[title, url, typeIndex], …] }`.

**Speed and caching.** With the pack middleware installed (`coywolfPack()` in `src/middleware.ts`), the middleware answers both URLs itself, before EmDash's plugin routing:

- Every answer is stored in Cloudflare's cache (the Cache API, per location; live answers for 5 minutes, title indexes for a day) and in a small per-isolate memory cache. The key is the query (trimmed, spaces collapsed, lower-cased), `limit`, `collections`, `locale` and the **search content version**. Browsers keep live answers for 60 seconds, and the title index for a year when the page's version matches (its URL changes with every version), 5 minutes otherwise.
- The content version changes whenever published content does (publish, unpublish, update, delete, restore), and when search settings change on the **Search** admin page. New keys miss, so visitors never see results from before an edit; old copies just expire. Other Worker isolates pick up a new version within five minutes (it's read with the feature switches).
- Cache hits skip the database and the rate limit. Misses count against **Search rate limit** when it's on.
- A miss reads the database in a few batched round trips: search settings (cached per isolate for a minute), then title and full-text matches for every collection at once, then excerpts and URL terms at once. The any-word fallback adds one more. That's 2–3 D1 round trips (about 7 statements) where it was 25–31 queries.
- Responses carry `Server-Timing` (`cw-search` says `hit-memory`, `hit-edge`, `miss` or `warm`; `cw-d1` counts statements and round trips) and `X-Coywolf-Cache: HIT` or `MISS`.

Without the middleware, the plugin routes run the same batched search, without the Cache API layer.

Tune it in `astro.config.mjs` (defaults shown):

```js
coywolfPlugin({ search: { live: { limit: 8, minChars: 2, debounce: 120, enterOpensTop: true, instant: true, indexMax: 5000 } } });
```

`enterOpensTop: false` leaves nothing selected until the visitor arrows to a result, so Enter runs a full search. `instant: false` skips the title index (server results only). `indexMax` caps the title index (newest entries kept); at 5,000 entries it's roughly 100–150 KB compressed, loaded once per content version.

To measure on a live site:

```sh
# A miss, then a hit (same query, any case or spacing).
curl -s -o /dev/null -D - "https://example.com/_emdash/api/plugins/coywolf-pack/search/live?q=wolf%20$RANDOM" | grep -iE "server-timing|x-coywolf-cache|cache-control"
curl -s -o /dev/null -D - "https://example.com/_emdash/api/plugins/coywolf-pack/search/live?q=wolf" | grep -iE "server-timing|x-coywolf-cache"
# The title index and the warm-up.
curl -s --compressed -o /dev/null -w "%{size_download} bytes, %{time_total}s\n" "https://example.com/_emdash/api/plugins/coywolf-pack/search/index?v=x"
curl -s -o /dev/null -D - "https://example.com/_emdash/api/plugins/coywolf-pack/search/live?warm=1" | grep -i server-timing
```

### Search box

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

### Rate limit setup

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

## AI Enrichment

Ported from Coywolf SEO's AI features, with the same prompts and validation:

- **Entities for schema** (`ai.entities`). The model lists the people, organizations, places, and things a page is about, without identifiers. Each name is looked up on Wikidata (`wbsearchentities`), and only items whose label or alias is that name (ignoring case, accents, and punctuation) count. When several match, the model may only pick one of them. Each chosen item's `instance of` (P31) claims are then checked (one Wikidata Query Service request per entry for all its items): disambiguation pages are dropped, a Person must be human, an Organization or Place can't be a creative work (the album instead of the band), and an Organization can't be a place. The JSON-LD `name` is Wikidata's label. The result is stored per entry as Schema.org `about` (main subjects) and `mentions`, each with `sameAs` links to Wikidata, Wikipedia, and the official website (P856) when there is one. Coywolf's Schema module reads them with `getEntryEntities(ctx | db, collection, id)` from `src/ai/entities.ts`.
- **Output entities on their own** (`ai.entitiesStandalone`). Adds the entities to the page's JSON-LD as a `WebPage` node (same `@id` as EmDash's `mainEntityOfPage`). Only for sites that don't use Coywolf Schema.
- **Meta descriptions** (`ai.descriptions`). Writes a description (under 155 characters, no clickbait) for published entries in SEO-enabled collections that don't have one. By default they're suggestions you edit and apply on the AI page; or have empty descriptions filled automatically. Either way it writes only EmDash's SEO panel field and never replaces a description someone wrote unless you choose **Replace**.
- **Image text** (`ai.imageText`). Writes alt text (and, if you turn it on, captions) for images on upload and in bulk, with accessibility-first prompts. Alt text and captions people wrote are kept unless you turn on overwrite. EmDash media has no title or description fields, so titles are shown on the AI page for reference only.

All four are off by default, under the **AI Enrichment** switch on the Coywolf Pack page.

### How it runs

Saving, publishing, or uploading never waits on AI: hooks only add the entry or image to a queue (after a short wait, so a burst of saves becomes one job, and only when the entry's text actually changed). A scheduled job works through the queue every two minutes (or with each cron tick, if the site's cron runs less often), a few items at a time (**Items per scheduled run**; raise it on a site with a slower cron), and stops for the day at **Max model calls per day** (default 200; an entry costs up to three calls, an image one). Each run also stays under 40 outbound requests (model calls plus Wikidata lookups), so it fits the Workers Free plan's subrequest limit; entries and images take turns, so a backlog of one doesn't hold up the other. Failed items are retried after 5 and 20 minutes, then marked as errors; a retry reuses the model output it already paid for. Deleting an entry removes its analysis. **Run bulk** on the AI page queues every published entry (skipping unchanged ones) or every image without alt text. The AI page also has a connection test, the queue status, suggestions to review, the analyzed entities (with **Export CSV**: one row per entity with its Wikidata, Wikipedia and website links, plus each entry's AI description), and a 30-day usage log with token counts.

### Setup

Pick a provider on **Plugins → AI Enrichment → Settings**:

- **Cloudflare Workers AI** (the default when the binding exists). Add the binding to `wrangler.jsonc`:

  ```jsonc
  "ai": { "binding": "AI" }
  ```

  The default model is `@cf/meta/llama-4-scout-17b-16e-instruct` for both text and images. A different binding name goes in `coywolfPlugin({ ai: { binding: "MY_AI" } })`.
- **Anthropic, OpenAI, or Google Gemini** with your own API key (stored encrypted, so the site needs `EMDASH_ENCRYPTION_KEY`). Defaults (checked October 2026): `claude-sonnet-5-5`, `gpt-6-luna`, `gemini-3.8-flash`. To use another model, such as a cheaper one or a newer one after a default is retired, enter its id in **Text model** and **Image model** on the Settings tab; leave them blank to follow the defaults.

Images are sent to the model at up to 3.5 MB. With a Cloudflare Images binding (`"images": { "binding": "IMAGES" }`, the same one EmDash uses for resizing) larger images are downscaled to 1568 pixels first; without one they're skipped. SVGs are skipped.

Set `ai: false` in `coywolfPlugin()` to leave the module out entirely. The module declares the `network:request` capability (for `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `www.wikidata.org`, and `query.wikidata.org`), plus content read/write (SEO panel only), schema read, and media read, bytes, and metadata write.

### Notes

- Only published entries are analyzed. Change the model or switch features and entries are re-analyzed the next time they're saved (or with **Re-analyze unchanged entries**).
- The daily limit is counted in UTC days. Each call's token usage is in the usage log; costs depend on your provider.
- Wikidata lookups are cached per Worker isolate and made one at a time, with `maxlag=5`. If Wikidata doesn't answer, the item is retried rather than saved unverified; if it asks to slow down (HTTP 429 or maxlag), every entity job waits for its `Retry-After` without counting as a failed attempt (after 10 waits in a row, the next counts as one). When an item lists several official websites, the preferred-rank one is kept, then https over http, then the first alphabetically.
## Discovery

Help search engines and AI agents find your content. Ported from Coywolf SEO for WordPress. Everything is off until you turn it on under **Plugins → Coywolf Pack**: the **Discovery** switch, then any of its three parts. Settings and status are under **Plugins → Coywolf Pack → Discovery**.

| Feature switch | Default | What it does |
| --- | --- | --- |
| `discovery` | off | Main switch for the module |
| `discovery.indexnow` | off | IndexNow submissions and the key file |
| `discovery.newsSitemap` | off | `/news-sitemap.xml` |
| `discovery.llms` | off | `/llms.txt`, Markdown versions of entries, and the `<link rel="alternate" type="text/markdown">` head tag |

- **IndexNow**: when an entry is published, updated (in collections without draft revisions), unpublished, or deleted, its public URL goes to `api.indexnow.org` (or `www.bing.com`), which shares it with Bing, Yandex, Seznam, Naver, and the other participating engines. Changes made within 3 seconds of each other go out as one request, after the response is sent. A changed slug submits the old URL too. Entries set to noindex aren't submitted. The key is generated the first time it's needed (or when you open the Discovery page with IndexNow on) and served at `/<key>.txt`; **New key** replaces it. The page shows the last 25 submissions and has **Submit home page** for checking the setup.
- **News sitemap**: entries published in the last 48 hours (the window Google News uses), newest first, at most 1,000, with publication name and language (defaults: site title and locale). Choose the collections (default: `posts`). Also served at `/coywolf-news-sitemap.xml`, Coywolf SEO's URL, so a sitemap submitted from WordPress keeps working. Submit it in Google Search Console; to list it in robots.txt, add `Sitemap: https://example.com/news-sitemap.xml` to the custom robots.txt under **Settings → SEO**. The module doesn't change robots.txt.
- **llms.txt** ([llmstxt.org](https://llmstxt.org/)): the site name, a summary (default: the site tagline), an optional introduction, then one list per collection (newest first, 100 per collection) and an **Optional** list for the rest, up to 500 entries (configurable up to 5,000). Each link points at the entry's Markdown version, or at the page itself when Markdown is off. Excerpts (`excerpt` field or SEO description) become link notes. A static `public/llms.txt` takes precedence, because Cloudflare serves static assets before the Worker runs.
- **Markdown versions**: each entry at its URL + `index.html.md` (`/blog/post/` → `/blog/post/index.html.md`, Coywolf SEO's convention). The Portable Text body becomes Markdown (headings, paragraphs, lists, links, images with captions, code, block quotes, tables, and horizontal rules; other blocks are skipped) under YAML frontmatter with the title, URL, dates, sources, and an optional license. There's no `Accept: text/markdown` negotiation on the entry's own URL: Cloudflare's cache key ignores `Accept`, so one such request could put Markdown into the cached HTML page. Responses carry `X-Markdown-Tokens`, an estimate at about 4 characters per token. Entry pages get `<link rel="alternate" type="text/markdown">` in the head.

Only published, non-noindex entries in routable collections are included. URLs come from EmDash's own routing (each collection's URL pattern, date tokens, locale prefix, and trailing-slash setting), so they match the native sitemap.

### Setup

Nothing to configure beyond the feature switches. The module's site URLs are served by the pack middleware (see Redirects → Setup), so add `coywolfPack()` from `@coywolf/emdash/middleware` to `src/middleware.ts` if you haven't. The plugin asks for `content:read`, `schema:read`, `network:request` (hosts `api.indexnow.org` and `www.bing.com`), and `hooks.page-fragments:register`.

### Caching and limits

- llms.txt and the news sitemap are stored in plugin storage and visitors are always served the stored copy. Content changes (publish, unpublish, delete, or a live edit) and settings saves rebuild them in the background after the response, debounced by 5 seconds; a copy older than its limit (5 minutes for the news sitemap, whose window moves; 24 hours for llms.txt) is served once more while a background rebuild runs. Only the very first request, before anything is stored, builds inline. **Rebuild now** on the Discovery page rebuilds both immediately. Each Worker isolate also keeps responses for a minute (up to about 2 MB), and CDNs may keep `llms.txt` and `.md` files for an hour (`Cache-Control: public, max-age=3600`; 5 minutes for the news sitemap).
- Markdown URLs resolve through EmDash's routing (`resolveEmDashPath`, or `/{collection}/{slug}` for collections without a URL pattern), then are checked against the entry's public URL. Entries behind a locale prefix or a custom route don't get a Markdown version.
- An entry's old URL is known only if it was published while IndexNow was on, so unpublishing or deleting an entry published earlier submits nothing.
- The news sitemap has no category include/exclude filter (Coywolf SEO's WordPress option); pick collections instead. Coywolf SEO's AI entity sections (a Labs feature) aren't ported.

## Link Manager

An inventory of every link in your content, ported from Coywolf SEO's Link Manager:

- **Inventory**: link marks in Portable Text (including nested blocks, columns and tables), linked images, buttons, embeds, iframes, and URL fields. Each link shows its anchor text, internal or external, and the entries that use it, with links to edit them. Entries are re-indexed when they're saved, deleted or restored; **Scan content** (and each scheduled run, when **Scheduled link checking** is on) indexes everything else.
- **Checking** (sub-feature, off by default): nothing runs in the background until **Scheduled link checking** is on. Then a scheduled run starts **weekly** (or **daily** or **monthly**: **How often** in **Link Manager → Settings**), scans the content, then checks the links that are due, continuing hourly until it's done. Each check is HEAD first, then GET when HEAD is refused, 10-second timeout, up to 5 redirects recorded. Statuses are **OK**, **Redirect** (with where it ends up), **Broken** (4xx/5xx), **Blocked** (403, 429, LinkedIn's 999, or a Cloudflare/AWS/DataDome bot challenge: the link is probably fine but can't be verified from a server), and **Error** (DNS, TLS, timeout, too many redirects). Within runs, broken links and errors are due again after a day, the rest after a week. **Check now** and **Recheck** run checks on demand.
- **Bulk actions**: **Replace** a URL across every entry that uses it (link text and other formatting are kept), **Unlink** (the text stays; linked images and buttons lose their link; embeds are left alone), **Ignore** a URL or domain, and **Recheck**. Ignore rules can also be domains, exact URLs, wildcards (`https://example.com/visit/*`) or regular expressions. Ignored links aren't checked or counted.
- **Export CSV**: every link matching the current filters (all pages), with its status, HTTP code, final URL, the entries that use it, and their anchor text. Filter by **Broken** first for a list to hand to whoever fixes links. Cells that look like spreadsheet formulas are prefixed with an apostrophe.
- **Dashboard widget** with the number of broken links.

Feature switches: **Link Manager** (`links`) and **Scheduled link checking** (`links.check`), both off by default.

### Setup

No bindings or secrets, but EmDash needs to know the site URL (**Settings → General**, or `site` in `astro.config`) to tell internal links from external ones; nothing is indexed until it's set. Settings (**Link Manager → Settings**): how often scheduled runs start (daily, weekly or monthly; default weekly), subrequests per check run (default 40), whether to check links to your own site (default on), and a User-Agent override. The checker presents a current desktop Chrome by default, which avoids most false "Blocked" results.

### Notes

- Edits go through EmDash's content API. A published entry is republished so the fix goes live. An entry with unpublished changes (or a schedule) is fixed in its draft only, so its live version keeps the old link until the draft is published (the result message says how many). An entry saved by someone else while the action runs is left alone and reported, so run the action again for it. An editor with the entry open may still overwrite the change on their next save.
- The inventory follows each entry's latest saved version (its pending draft, if it has one). Links inside raw HTML blocks aren't tracked.
- Workers limit subrequests per invocation (50 on Free, 1,000 on Paid), and database calls count. A checked link takes 1–2 requests plus 1 per redirect, and 1 database write; keep **subrequests per check run** under your plan's limit, leaving room for other scheduled jobs. Scheduled runs work in hourly steps (scan steps of about 200 database statements or 60 seconds, then one check run of **subrequests per check run** each hour), so on a big site a run can take several hours or more; raise subrequests per check run on the Paid plan to finish sooner. While Scheduled link checking is off, the hourly tasks read only the feature switches; between runs, they also read one small state row and the frequency. A scan started from the page runs faster while the page is open; admin actions stop at about 150 statements or 25 seconds and continue on the next call.
- Links are stored in plugin storage (`links_urls`, `links_refs`) in the site's D1 database, so backups include them. The list pages through indexed queries; search matches the start of a URL (when it starts with `http` or `/`) or of a domain. Indexing an entry looks up its references with one D1 query on the `entryKey` expression index, with no sort (storage queries always sort by creation time, and for that SQLite picked the generic list index and read every reference row of the site, once per entry scanned). A scan writes only references that are new or changed (an unchanged entry costs that one read and no writes), drops links removed from an entry as it indexes it, and then removes the references of entries it can't visit (deleted, trashed, or in a collection without link fields now): one query lists the entries that have references, and one per 90 of them checks they still exist. Status counts are cached for up to a minute (10 minutes in the dashboard widget).
- Regular-expression ignore rules are limited to 200 characters, and patterns that can take exponential time (repeated groups containing a quantifier or alternation, backreferences) are refused.
### Checking internal links

A Worker can't fetch its own custom domain over HTTP (Cloudflare answers 522), so internal links are checked through a service binding to the site's own Worker. Add it to `wrangler.jsonc` (use your Worker's `name`):

```jsonc
"services": [{ "binding": "SELF", "service": "mysite" }]
```

Without the binding, internal links are listed but not checked (they're never reported as broken).

## Videos

The Coywolf Video Manager for EmDash, on Cloudflare Stream.

EmDash 1.2.0 added its own **Video** block (`video`): a media-library video in the browser's player, or a media provider's embed, with a caption. It's a different block from **Coywolf Video** (`coywolf-video`), which plays Cloudflare Stream videos with the light embed, posters, views and likes, schema and the sitemap below. Both can be used side by side; the pack doesn't render or index EmDash's.

- **Coywolf Video block** (slash menu → Media): pick a video from your Stream library, then set a title, description, poster (a frame time or an image), start time, controls/autoplay/loop/muted/preload, full or maximum width, and whether to show the name, description, views, a like button, the like count and the upload date: **Site default** (follow **Videos → Settings**), **Show** or **Hide**. The **Loop like a GIF** style plays muted, autoplaying and looping with no controls. Server-rendered in a `<figure>` sized by the video's aspect ratio, so nothing shifts.
- **Light embed** (the default; **Videos → Player → Load the player only when it's needed**): pages show the video's poster as a responsive image (Stream thumbnails at 480, 800 and 1200 px) with a play button, and load Stream's player (about 350 KB of JavaScript) when someone presses play, already playing. Autoplaying and GIF-style videos show the poster until the visitor's first scroll, touch, pointer move or key press, then load their player once on screen (loading it on idle still ran Stream's ~1.5 s of player script inside PageSpeed's measuring window). Without it, a video near the top of a page loads with the page and, on a slow phone connection, becomes its largest paint several seconds late (coywolf.com's mobile Performance score was 70 on such a page, 100 on the home page). Without JavaScript the player loads as before. Turn the setting off to load the player with the page.
- **Pause and reduced motion** (WCAG 2.2.2): autoplaying videos without controls (including the GIF style) show a pause/play button in the corner, so the motion can always be stopped; pausing before the player has loaded keeps the poster (also when that press is the visitor's first interaction), and a pause pressed while the player is still starting holds once it's ready. Visitors whose system asks for reduced motion get the poster and a play button instead of autoplay.
- **Posters from your media host**: with **Clean Image URLs** on and a media host set, each video's poster is copied from Stream into the media bucket the first time it's shown (`cwposter-<uid>-<hash>.jpg`, one per video and poster time), then served as resized WebP/AVIF from the media host like any other image. Stream makes thumbnails on request: even cached ones took 120–450 ms to start arriving (over a second for a new one), always as JPEG, from a host the browser had to connect to first. Rendering never waits for the copy: the copied posters are listed in one plugin setting (`videosMirroredPosters`, read with the feature switches, so it adds no query), and a poster that isn't listed yet is shown from Stream for that page view while it's copied and listed in the background. A page shown that way is cached for 5 minutes (plus 1 minute served while refreshing) instead of the Page cache lifetime, so the next render uses the media host; when cache warming rendered it, it isn't cached at all and the warmer visits it again once the poster is copied (see **Cache warming**). This needs the pack middleware: since Astro streams pages and a video renders after the page's headers are ready, the middleware reads each cacheable HTML page in full before returning it (it does for every cacheable HTML page, so it can also keep a page rendered after a failed read out of the cache; see [Page cache](#page-cache)). Pass `Astro.locals` as the last argument of `hostedPosterImage()` in your own components so the page is marked exactly; without it the middleware still notices, but may also shorten another page rendered at the same moment. Without a media host, or if a copy fails, Stream's thumbnails are used and the copy is retried later. Themes can use `hostedPosterImage()` from `@coywolf/emdash/astro` for their own video markup. A newly copied poster is resized at each size right away (AVIF and WebP), so the first visitor doesn't wait for it. Posters load lazily; when a video is the first thing on the page, set `Astro.locals.coywolfPriorityKey` to its block's `_key` and its poster loads at once with high priority.
- **Views & likes** (**Videos → Settings**, like Video Manager's): site-wide defaults for showing the name, description, views, like button, like count and upload date (all on), the date style (**Oct 6, 2026** or **7 months ago**; a relative date is refreshed in the browser, since pages are cached). Blocks set to **Site default** follow them. Blocks saved before these settings existed (with the old on/off toggles) and blocks imported from WordPress with an earlier pack keep their own choices; **Make all video blocks follow the site defaults** ignores those older choices without editing any content (turn it off to bring them back). Blocks set to Show or Hide always win. The WordPress importer now sets these only when the WordPress block did (or when the WordPress site had the option off), as Video Manager inherited them, and always as Show or Hide. Older blocks store those choices as true/false, which the block editor can't show (it says **Site default** while the page follows the stored choice). `node scripts/video-show-migrate.mjs --url=https://example.com` lists them; add `--apply` to rewrite them as Show/Hide (or, with **Make all video blocks follow the site defaults** on, as Site default), so pages render the same. It uses EmDash's content API with your `npx emdash login` (or `EMDASH_TOKEN`), backs up each entry to a local folder first, republishes published entries (keeping their published date), saves drafts as drafts, and skips published entries with pending draft changes. Republishing sets each entry's updated date to now (EmDash's API can't save without it), which a theme may show as **Updated** and use for `article:modified_time`, sitemap `lastmod` and feed dates; `node scripts/video-show-migrate.mjs --url=https://example.com --restore-updated-at --backup-dir=<the backup folder>` lists the original dates and writes the guarded SQL that puts them back, and with `--apply --d1=<database>` (run from the folder with the site's wrangler config) runs it through `wrangler d1 execute --remote` and clears the page cache. An entry edited since the migration keeps its new date.
- **Appearance** (**Videos → Settings**, with a live preview of unsaved changes): color scheme (auto, always light, always dark, or off to use the theme's text color), alignment of the name and of the like/views/date row, corner radius, an optional border, player background, name and description color, size and weights, the like icon (heart, thumbs up or star, Video Manager's icons), like colors (unclicked, clicked and their backgrounds; hovering previews the other state, and the clicked state holds until the pointer leaves), and the views/date color and size. The like icon pops when clicked (not with reduced motion). Each Coywolf Video block can override the alignments, corner radius and border (on/off, width, color) for that video; left empty, it uses these settings (WordPress imports keep Video Manager's per-block values where they were set). Only settings changed from their defaults are printed (as `--cw-video-*` custom properties on the figure), so a site that changes nothing looks as before, and theme CSS that targets `.cw-video__*` still wins. The figure's CSS is printed once per page.
- **Admin** (**Plugins → Coywolf Pack → Videos**): the library with thumbnails, tags, length, upload date, plays, likes and the number of entries each video is used in; search (with `#tag`) and a filter (with plays, with likes, used, not used); Stream storage used; a notice for embedded videos no longer in Stream; edit name, description, tags, creator, poster, allowed origins and MP4 downloads; delete (from Stream and the site, with a warning listing the entries that use it); captions; and uploads (tagged with the default tags from **Settings → Uploads** unless you enter others) that go straight from the browser to Stream (tus for files over 200 MB), so they never pass through the Worker.
- **Embed index**: saving, publishing, unpublishing, restoring or deleting an entry records which videos it embeds (any Portable Text field, at any depth). **Rebuild embed index** scans existing content. WordPress `cloudflare-stream` marker blocks (as imported to wellbeing.io) are indexed too, for usage counts and the sitemap.

| Feature | Default | What it adds |
| --- | --- | --- |
| `videos` | off | The module: library, uploads, block, index |
| `videos.schema` | off | A VideoObject JSON-LD script per embedded video (`page:metadata`, one script per video, never `primary`): name, description, 1200px thumbnail, ISO 8601 duration, upload date, embed URL, the MP4 as `contentUrl` when downloads are on, view and like counts when plays and likes are on, and caption tracks plus a transcript (up to 10,000 characters) when captions are on |
| `videos.sitemap` | off | A Google video sitemap at `/coywolf-video-sitemap.xml` for published entries (cached 10 minutes; rebuilt when content changes) |
| `videos.engagement` | off | Plays (counted once per browser session after 2 seconds of playback, not for autoplaying videos) and likes (one per visitor per day, using a daily-salted hash of the IP address; no cookies, nothing personal stored) |
| `videos.captions` | off | Upload WebVTT, generate captions with Stream, delete; ready tracks are copied to the site and served at `/coywolf-video-captions/<id>/<lang>.vtt` |
| `videos.webhook` | off | A Stream webhook (HMAC-verified) that refreshes a video's details as soon as Stream finishes processing it; **Subscribe** on the Videos page |

### Setup

1. Create an API token with **Account → Stream → Edit**.
2. On the **Videos** page, enter the account ID and the token in the **Connect** card (or later under **Videos → Settings**; the token is a secret setting, which needs EmDash's `EMDASH_ENCRYPTION_KEY`). Until Stream is connected, the page shows only that card: the library, uploads, captions and the webhook appear once it's connected. Or set `CF_ACCOUNT_ID` and the `CF_STREAM_TOKEN` Worker secret, the same variables EmDash's `cloudflareStream()` media provider reads. Optional settings (**Videos → Settings**): the customer subdomain (`customer-….cloudflarestream.com`, learned from the library if empty), the player accent color, Views & likes, Appearance (including the background color) and default upload tags.
3. Turn on **Videos** (and any sub-features) under **Plugins → Coywolf Pack**, open the **Videos** page, and click **Test connection**. Then **Rebuild embed index** once.
4. For the sitemap and caption files, add `coywolfPack()` to the site middleware (see Redirects), and list the sitemap in `robots.txt`:

   ```text
   Sitemap: https://example.com/coywolf-video-sitemap.xml
   ```

Option: `videos: { maxUploadDurationSeconds: 3600 }` (the longest upload Stream accepts; Stream reserves that much quota while an upload is in progress). `videos: false` leaves the module out.

Use the block from theme code too: `import { CoywolfVideo } from "@coywolf/emdash/astro"` and `<CoywolfVideo node={{ uid, preset: "gif" }} />`. It also accepts the WordPress marker attributes (`id`, `host`, `aspect`, `name`, `description`, `seconds`), which default to the GIF style, so it can replace a theme's own Stream component. Those marker blocks don't get schema from this module, because a theme rendering them usually emits its own.

### Limits

- Stream lists up to 1,000 videos per call; the library is cached for 5 minutes (plugin KV and isolate memory). **Refresh** reloads it.
- Page views make no Stream API calls: player sizes, names and counts come from the site's own copy, filled when the library loads, when an entry with a new video is saved, and by the webhook.
- Plays aren't counted for autoplaying videos (including the GIF style), so muted previews don't inflate them.
- Plays and likes count per IP address (not per browser), and only for videos embedded in published entries: drafts' videos get no public data. Each address may send 10 plays and 20 likes a minute and add 100 likes a day; over that the routes answer 429. Likes must come from the Coywolf Video script (it sends an `X-Coywolf-Video: 1` header), so other sites can't like on a visitor's behalf; plays without the header still count, since pages cached before the header was added don't send it. People sharing an address (an office, a mobile carrier) share one like per video. Requests without an address (EmDash reads it from Cloudflare's request data, missing in local dev or behind some proxies) count no plays or likes, rather than all counting as one visitor. Visitors who block `embed.cloudflarestream.com` (the player SDK, loaded only where plays are counted) aren't counted.
- Signed URLs (`requireSignedURLs`) aren't supported.

## Robots.txt Rules

Manage `robots.txt` in plain English instead of a text box. The page opens with a one-paragraph summary of the whole file (**Search engines can crawl everything. AI training crawlers are blocked from the whole site.**), then three tabs:

- **Rules**: each rule as a sentence (“Block AI training crawlers (10) from the /private/ section and everything in it”), with an on/off switch, Edit (the same guided dialog), Duplicate and Delete. Order doesn't matter: crawlers follow the most specific matching line, and the file is written most-specific-first so older top-to-bottom crawlers agree. Below the list: a URL tester (**Can GPTBot fetch /2026/my-post/?**) and **What's being served**, the live file with Copy and Download, plus EmDash's original file for reference.
- **Bots**: the crawler directory (about 700 bots) with search and filters for category, purpose, operator, verification status and “used in rules”. Mark a bot verified (source URL and note, stored with the date and your name), rename it (the token never changes), add bots the directory lacks (token checked against `[A-Za-z0-9._-]+`, with a purpose), edit or delete them, and sync from Cloudflare Radar.
- **Settings and history**: keep EmDash's admin private, keep media crawlable, “crawlers named in a rule also keep the rules for all crawlers”, sitemaps, rule-name comments, Extra lines (for experts), the last 20 saved versions with Restore, **Reset to EmDash's original**, and **Export rules** / **Import rules…**: the rules and settings as a JSON file, to keep a copy or move them to another site. An import goes through the same checks as any change (with a confirmation listing the effects), replaces the current rules and settings, and keeps the current version in history.

**Templates** (header) replace the rule list in one click, through the same checks: *Block AI training, allow AI search*, *Allow everything*, *Block everything except search engines*.

### Taking over from EmDash

Turning the feature on takes over seamlessly. The first `/robots.txt` request or the first visit to the page (whichever comes first) converts the robots.txt EmDash was serving (its SEO setting, or its built-in default) into rules: groups become rules (identical lines for several bots become one rule, and known crawler groups are recognized), `Sitemap:` lines become sitemap settings, other lines (Crawl-delay, Content-Signal…) become Extra lines with their `User-agent` lines. The import is checked: for every crawler named in either file plus a few well-known ones and a stand-in for “any other crawler”, and every path the files' lines target, both files must give the same allow/block verdict (Google's matcher). If no combination of settings reproduces the file exactly, the original is kept as Extra lines, so crawlers always see the same rules. The one deliberate change: media in EmDash's library (`/_emdash/api/media/`) is opened to crawlers so images can appear in image search, and the summary under **What's being served** says so. The import is saved with an insert-if-absent, so concurrent first requests can't import twice. Turning the feature off serves EmDash's robots.txt again and keeps your rules for next time.

### Adding a rule

**Add rule** opens a four-step dialog:

1. **What do you want to do?** Keep crawlers out, or let crawlers in.
2. **Which part of your site?** Everything · A section (with “also wherever this folder name appears deeper”) · One page (with “only this exact address”) · A kind of file (PDF, Word, spreadsheets, images, ZIP, video… or other extensions, optionally only inside a section) · Links with tracking or extra parameters (utm_…, ref, fbclid, gclid, session IDs, sort and filters, site search, any `?`, or one you name) · Advanced pattern. Paste any address from your site: it's trimmed to its path, encoded, and read (“We read this as the /recipes/ section”), with a one-click switch when another choice fits better. Your collections' sections are offered as chips. A live box shows addresses the rule **will match** and nearby ones it **won't**, from the real matcher.
3. **Which crawlers?** Everyone · Search engines · AI training · AI search and assistants · SEO tools · Pick specific bots (search, categories with tick-all, verified badges, or a token that isn't listed). Each preset lists its members. Presets are curated by **purpose** from the operator's own documentation (`purposes` in `src/robots/data/verified.json`, with source URLs), never by Radar category, and only include verified tokens; bots that only come from Radar never join a preset, while verified custom bots with a matching purpose do. AI training is GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, meta-externalagent, Bytespider, Amazonbot, MistralAI-Training and Webzio-Extended. Rules made from a preset follow it: when a preset changes, the rule is updated on the next page load, with a one-time note listing crawlers added and removed.
4. **Review**: consequences first (“Search engines can fetch this section. 10 AI training crawlers can't.”), **Except…** for allowed items inside a blocked area, the name and note (prefilled), **Try a URL**, the exact lines under **Show robots.txt lines**, and the checks.

### Checks

Every change is checked in the browser as you type and again on the server before saving. Errors block saving; warnings need “I understand, add it anyway”.

- **Errors**: invalid crawler tokens, exceptions outside the blocked area (or ones that reopen all of it), line breaks, control characters or `#` in a value, patterns not starting with `/` or `*`, values over 2,083 characters, bad extensions or parameter names, an exact duplicate of another rule, the same crawlers both allowed and blocked on the same path, and a failed self-check.
- **Warnings**: a block on a discovery file that's kept readable, an Allow that nothing blocks, a block already covered by a wider block (naming it), a rule for everyone that named crawlers won't follow (with “Also apply it to these crawlers”), naming a crawler that then ignores the rules for all crawlers (RFC 9309 group selection; with the setting off, offers to turn it on), search engines blocked from your pages, CSS/JavaScript/images that renderers need, the media library, the sitemap, opening EmDash's admin, and blocks that the “Keep media crawlable” setting overrides.
- **Notes**: an Allow inside a block (valid; explained), where a more specific rule still decides, a partial duplicate (with **Merge**), unknown or unverified tokens, and case-sensitive paths.
- **Self-check**: after generating the file, every rule's crawlers are tested on addresses the rule targets, and the parsed file must give the verdict the rules say; crawlers the rule doesn't name must get the same verdict with and without it. A failure names the rule, crawler, address and deciding line.

### Automatic lines and the sitemap

**Discovery files stay readable.** Any crawler that your rules would block from `/.well-known/` (security.txt, ai-plugin.json and future machine-discovery manifests), from `/llms.txt` while Discovery's llms.txt feature is on (`/llms-full.txt` holds your full text, so add it yourself if you want it), or from discovery paths you add, gets an `Allow` line for them. The Rules tab lists these as **Automatic** lines with the reason. Turn the allowance off, or add paths, under **Settings and history**. Feature switches are read when the file is generated (middleware and admin preview), the self-check confirms each allowance, and a rule that targets a discovery file gets a warning.

**List the site's sitemap** sits at the top of the Rules tab. It's on for new and imported setups. A saved choice to turn it off is kept (for example when you submit sitemaps in Search Console), with a small note you can dismiss.

### How the file is written

One group per set of crawlers that follow the same lines. With “keep the rules for all crawlers” on (the default), a named crawler's group also gets the general rules, except where its own rules cover the same addresses (so “block GPTBot from the whole site” beats a general Allow). Every crawler not blocked from the whole site gets `Allow: /_emdash/api/media/` and `Disallow: /_emdash/`. We serve the file rather than writing EmDash's **SEO → robots.txt** setting because that setting is capped at 5,000 characters and couldn't keep EmDash's lines in every group.

Extra lines that would block search engines or the whole site are flagged on the page (they don't block saving). If EmDash's robots.txt settings can't be read during the takeover, nothing is imported and EmDash's file keeps being served until a later request succeeds.

Rules saved before 0.7.0 keep working unchanged: the stored config is read with defaults for the new fields, and “keep the rules for all crawlers” is turned on only when that changes no verdict.

Feature switches: **Robots.txt Rules** (`robots`) and **Weekly crawler list from Cloudflare Radar** (`robots.radarSync`). Both default to off.

### Setup

Uses the same `coywolfPack()` middleware as Redirects, and the `DB` binding. A static `public/robots.txt` in the site would be served by Workers static assets before the Worker runs, so remove it. Rules are read at most once a minute per Worker isolate; history and bot changes live in plugin storage (`robots_history`, `robots_bot_overrides`), the dismissed sitemap note in KV; the response is cached for an hour (`Cache-Control: public, max-age=3600`).

### The crawler directory

A robots.txt `User-agent:` line takes a product token (`GPTBot`, `Claude-SearchBot`, `meta-externalagent`), which often isn't the bot's name or full user-agent string. The bundled directory (`src/robots/data/bots.json`) starts from Cloudflare Radar's bot directory and Coywolf SEO's curated tokens, and records for every bot how its token was confirmed:

- **verified, operator docs**: the operator's own documentation names the token (`sourceUrl`, `verifiedAt`). The major AI crawlers and search engines were re-checked on 2026-10-03: OpenAI, Anthropic, Google (including Google-Extended), Bing, Apple (Applebot-Extended), Perplexity, Common Crawl, Amazon, Meta, DuckDuckGo, Yandex, Baidu, Mistral, Webz.io and ImageSift.
- **verified, user agent**: the token appears in the user-agent string Radar publishes for the bot.
- **unverified**: derived from a pattern or name, or a legacy token the operator no longer documents (for example `anthropic-ai`, `Claude-Web`, `FacebookBot`, `cohere-ai`). These still work in robots.txt if the crawler uses them, and are flagged in the picker.

Signed agents that identify only cryptographically (Web Bot Auth) and have no token, such as ChatGPT agent, are left out. Bots that share a token (for example the nine regional Amazon Bedrock AgentCore browsers) are one entry, and hash-like identifiers that aren't product tokens are flagged unverified.

To rebuild the list, run `scripts/build-bots.mjs`. It reads Cloudflare Radar's directory (`RADAR_API_TOKEN`, or a snapshot saved earlier with `--save-snapshot` and passed back with `--radar-snapshot`), Coywolf SEO's curated tokens (`--wp <dir>`, or fetched with `gh api` from coywolf-llc/coywolf-seo), and the hand-verified tokens in `src/robots/data/verified.json`. To verify a token, add it to `verified.json` with the operator's documentation URL and the date you checked it, then rerun:

```bash
RADAR_API_TOKEN=… node scripts/build-bots.mjs
```

### Weekly refresh from Cloudflare Radar

With `robots.radarSync` on and a token set, the `robots-refresh-bots` task runs weekly (and **Refresh from Radar** runs it now). It makes one request, `GET https://api.cloudflare.com/client/v4/radar/bots?limit=1000`, and stores only differences from the bundled list in plugin storage (`robots_bots`), so a quiet week writes nothing. Radar publishes user-agent patterns, not robots.txt tokens, so bots that first appear this way get a token derived from their pattern and stay **unverified** until the bundled list is updated with a source. Bots that leave Radar stay usable and are marked.

Create a Cloudflare API token with **Account → Radar → Read** and either paste it into the setup card on the Robots.txt page's **Bots** tab (stored encrypted; it's also on the plugin's generic Settings page) or set it as a Worker secret:

```bash
npx wrangler secret put RADAR_API_TOKEN
```

The module declares `network:request` for `api.cloudflare.com` only.

## Reviews

The review box Coywolf uses on WordPress (Coywolf Custom Blocks' review block): a rating badge with "4.5 out of 5" under it, then **What I liked most** and **Could be better** lists side by side, stacking on narrow screens. It adds Review schema that Google can read for review snippets and product pros and cons.

- **Coywolf Review block** (slash menu → Content): item name, item type (the types Google accepts for reviews: Product, Software application, Book, Course, Movie, Game, Event, Recipe, Local business, Organization, and a few more), brand, item URL, item image (for schema only), book details (author, ISBN, publisher, genre, copyright year) and software details (operating systems, app category) for schema, rating (0–5 in tenths, e.g. 4.7), the two headings (defaults above), pros and cons (one per line), an optional summary or verdict, and the heading level (H2 by default, like WordPress). It's server-rendered plain HTML with no script. Its CSS is about 2 KB, inlined once per page before the first box, so nothing shifts.
- **Ratings** are picked from a menu of 5.0 down to 0.0 in steps of 0.1 (EmDash's number field only takes whole numbers). The badge and caption show the rating as stored ("4.7 out of 5", "5 out of 5"), and Review schema's `ratingValue` is the same number. Reviews saved before 0.11.0 with half steps keep working; saving the entry stores them in the new format (`"4"` becomes `"4.0"`) so the menu shows them.
- **Reviews page** (**Plugins → Coywolf Pack → Reviews**): the badge's accent color (default `#2C8452`; badge text is white), **Custom CSS**, and a live preview of a sample review, wide or at phone width. The preview runs in a sandboxed frame, so your CSS can't restyle the admin.
- **Accessible**: the box is a `<section>` labeled "Review of <item>". The badge number is hidden from screen readers, which read "Rated 4.5 out of 5" instead. The lists are real headings and lists.

| Feature | Default | What it adds |
| --- | --- | --- |
| `reviews` | off | The block on the site, and the Reviews page |
| `reviews.schema` | off | Review JSON-LD for each review, in Schema & Social's graph when it's on, otherwise one standalone script per review (`page:metadata`, ids `coywolf-review-N`) |

### Customizing the look

Every part has a stable class: `.cw-review` (the card), `__rating`, `__badge`, `__caption`, `__columns`, `__col` (plus `__pros` / `__cons`), `__heading`, `__list`, `__item` and `__summary`. Every design value is a CSS custom property. The built-in CSS only reads them, with fallbacks, so you can set them on `.cw-review`, on a wrapper, or on `:root`:

| Property | Default | |
| --- | --- | --- |
| `--cw-review-accent` | the Reviews page color | Badge background |
| `--cw-review-badge-color` | `#fff` | Badge text |
| `--cw-review-badge-size` / `-badge-padding` / `-badge-radius` | `3.5rem` / `.5rem 1rem` / `10%` | |
| `--cw-review-bg` / `--cw-review-bg-dark` | `#fff` / `#1d1f23` | Card background (light / dark); `--cw-review-bg` alone sets both |
| `--cw-review-border` | `1px solid` + the border color | Whole border shorthand (e.g. `0`); overrides the colors below |
| `--cw-review-border-color` / `--cw-review-border-color-dark` | `#dfe0e3` / `#3a3d44` | |
| `--cw-review-radius` / `-padding` / `-margin` | `12px` / `2rem 1rem` / `0 0 1.5rem` | |
| `--cw-review-color` / `-font` | `inherit` | Text color and font |
| `--cw-review-heading-color` / `-heading-size` / `-heading-transform` | `inherit` / `1.2rem` / `uppercase` | |
| `--cw-review-list-color` / `--cw-review-list-color-dark` / `-list-size` / `-list-style` | `#555` / `#c9ccd1` / `1rem` / `square` | `--cw-review-list-color` alone sets both |
| `--cw-review-caption-color` / `-caption-size` | `inherit` / `1rem` | The "4.5 out of 5" line |
| `--cw-review-gap` / `-column-gap` | `1rem 1.5rem` | Space between the badge and lists, and between the lists |
| `--cw-review-rating-width` | `7rem` | Badge column's minimum width |
| `--cw-review-stack-at` | `26rem` | Narrowest the lists area gets beside the badge before the badge moves above it |
| `--cw-review-column-min` | `13rem` | Narrowest a list column gets before the lists stack; `100%` keeps them in one column |

Light and dark colors use CSS `light-dark()`, so the box follows the page's own `color-scheme`: on a theme that declares `color-scheme: light dark` it turns dark with the page, and on a light-only theme (no `color-scheme`) it stays light whatever the visitor's system setting. The `-dark` properties are the dark half.

The layout uses flex and grid wrapping instead of a media query, so it adapts to the box's own width (a sidebar or a phone alike) and the "breakpoints" are the custom properties above.

Put overrides in **Custom CSS** on the Reviews page. It's added after the built-in styles on pages with a review, so it wins. Start every rule with `.cw-review` so it only reaches review boxes; it's printed as-is (not rewritten), with `</style`, `<!--` and `-->` removed and a 20 KB cap. For example, a crimson badge and one column:

```css
.cw-review {
  --cw-review-accent: #b22d47;
  --cw-review-column-min: 100%;
}
.cw-review .cw-review__heading { text-transform: none; }
```

### Review schema

With Schema & Social's graph on, each review joins the page's `@graph` like videos do. The reviews come from the entry's `coywolf-review` blocks (any Portable Text field), followed by any the theme passes as `page.coywolf.reviews`, de-duplicated by item type and name, up to 20.

- **Products** become a top-level `Product` (`<page>#review-N-item`, with name, `brand` as a `Brand`, url and image). The `Review` (`<page>#review-N`) is nested in it as `review`. Google reads pros and cons (`positiveNotes` / `negativeNotes`, each an `ItemList` of `ListItem`s with position and name) only from a Review nested in a Product, and a nested review needs no `itemReviewed`.
- **Other types** become a top-level `Review` with the item in `itemReviewed`. That's the shape Google's review-snippet docs show, and it avoids validating, say, an Event or SoftwareApplication as its own rich result.
- **Pros and cons** are emitted only for Product reviews with at least two statements in all (Google's minimum); they still show in the box either way.
- **Books and software** get their details on the item: a Book's `author` (Person), `isbn`, `publisher` (Organization), `genre` and `copyrightYear`; a SoftwareApplication's `operatingSystem` and `applicationCategory`.
- **Every review** has a `reviewRating` (`Rating`, `ratingValue`, `bestRating` 5, `worstRating` 0, because the scale starts at 0), the Article's author(s) as `author` (else the publisher), the graph's publisher, the Article's `datePublished`, `mainEntityOfPage` → the WebPage, and the summary as `reviewBody`. The item is added to the Article's (or WebPage's) `about`, alongside AI Enrichment's entities.
- **Not emitted**: reviews without an item name or a rating, and "self-serving" reviews, which Google ignores. Those are an Organization or Local business whose URL is on your own site or whose name is the publisher's.

With the graph off, each review is a standalone JSON-LD script in the same shape. The author is the page's byline name (else the site), and the publisher is the site. Some item types need more properties for their own rich results (an Event's date and location, for example). The block doesn't collect those, so validate important pages in Google's Rich Results Test. Google's product snippets focus on one product per page: several Product reviews on one page are all output, but Google may use only one of them.

### Legacy WordPress reviews

Themes that render imported WordPress review markers (`{ name, brand, rating, strengths, shortcomings }`, with the lists as `<ul>` HTML) can use the same box and schema:

```astro
---
import { Review, reviewFromAttrs } from "@coywolf/emdash/astro";
---
<Review attrs={markerAttrs} />   <!-- or <Review {...markerAttrs} /> -->
```

and pass the same reviews to the page context for schema:

```astro
---
const reviews = reviewMarkers(post.data.content).map(reviewFromAttrs); // your marker parser
const page = { ...createPublicPageContext({ /* … */ }), coywolf: { videos, reviews } };
---
<EmDashHead page={page} />
```

`reviewFromAttrs` reduces the `<li>` HTML to plain text (tags dropped, entities decoded) and maps the marker attributes to the block's fields. You can also pass `itemType`, `url`, `image` and `summary` attributes, and the WordPress book (`author`, `isbn`, `publisher`, `genre`, `copyright`) and software (`os`, `category`) fields. To turn imported markers into Coywolf Review blocks instead, see [Migrating from WordPress](#migrating-from-wordpress). `<Review>` isn't gated by the feature switch, because a theme that uses it has opted in, but it uses the Reviews page's accent and custom CSS. Schema still needs `reviews.schema`. Remove any review JSON-LD the theme prints itself.

`reviews: false` leaves the module out.

## Custom Blocks

Six editor blocks (slash menu → Content), each with its own switch, named after Coywolf's WordPress plugin, Custom Blocks. They're server-rendered plain HTML with no script, accessible (landmarks with names, native disclosure widgets, real quotations), and share one small stylesheet (under 5 KB) inlined once per page before the first block. They're rendered by the pack's components rather than stored as HTML, so EmDash's HTML sanitizer doesn't strip `<details>`, `<summary>`, `<aside>` or `<figure>`.

| Feature | Default | Block | Fields |
| --- | --- | --- | --- |
| `customBlocks` | off | (module switch; the Custom Blocks page) | |
| `customBlocks.note` | off | **Note**: a callout in an `<aside>` labeled by its title | Kind (Note, Editor's note, Tip, Warning), title (empty = the kind's name), hide title, title style (bold text or an H2–H4), text |
| `customBlocks.details` | off | **Details**: native `<details>`/`<summary>` | Style (Details, or Transcript: the hidden text sits in a tinted panel), summary (default "Details" / "Read the transcript"), hidden text, open when the page loads |
| `customBlocks.disclosure` | off | **Affiliate disclosure**: small, muted text in an `<aside>` labeled "Affiliate disclosure" | Disclosure (Affiliate links or Amazon Associates), wording for this page (optional; empty uses the site's) |
| `customBlocks.quote` | off | **Quote**: `<figure><blockquote cite>…</blockquote><figcaption><cite>…</cite></figcaption></figure>` | Quote, who said it, source URL (the `cite` attribute) |
| `customBlocks.testimonial` | off | **Testimonial**: `<figure><blockquote>…</blockquote><figcaption>` photo, name, title `</figcaption></figure>`; the quote sits in a speech bubble with the person below it | What they said, name, title, photo (media library), link for the name (e.g. a social profile), link for the title (e.g. their company) |
| `customBlocks.podcast` | off | **Podcast links**: a `<section>` labeled by its heading, with a list of links named by service (Apple Podcasts, Spotify, YouTube, Amazon Music, Overcast, Pocket Casts, RSS feed), each with a small line icon | Links (the site's podcast from the Custom Blocks page, or only this block's), heading (empty = the site's), a link per service |

**Text fields** are plain text: a blank line starts a new paragraph, a single line break is a line break, `[link text](https://…)` is a link and `**text**` is bold. Simple HTML works too, so imported WordPress content keeps its exact markup: links (`href`, `title`, `rel` limited to `nofollow`, `sponsored`, `ugc` and the like), bold, italics, `<code>`, `<abbr title>`, `<q cite>`, `<mark>`, `<sub>`/`<sup>`, lists, paragraphs, H2–H6, `<figure>` and `<img>`, and text styling in `style` (color, font size and weight, …). Everything else is dropped (its text stays), links are limited to http(s), mailto, tel and site-relative URLs, and tags left open are closed, so a block can't break the page around it. Titles, summaries and citations are one line (no paragraphs or block tags). A testimonial's name and title are plain text.

**Testimonials** have no schema: Google doesn't show review rich results for reviews a site collects and shows about itself, and a testimonial has no rating. The photo's alt text is empty because the name right next to it says who it is.

**Custom Blocks page** (**Plugins → Coywolf Pack → Custom Blocks**): the site's disclosure wording for affiliate links and for Amazon Associates (Amazon requires "As an Amazon Associate I earn from qualifying purchases."), an optional disclosure page linked after it ("Learn more" by default); the podcast's links (one per service; empty ones are left out), heading ("Subscribe to the podcast" by default), heading style (H2–H4 or bold text) and whether to show icons; and live previews of every block. A Podcast links block with no links shows nothing.

**Styling**: colors are mixed from the theme's text color (`currentColor`), so the blocks follow light and dark themes; notes add a hue per kind, a little stronger in dark mode. Override with the theme's CSS: `--cw-note-accent` on `.cw-note` (or `.cw-note--tip`, …), and the classes `.cw-note`, `__title`, `__body`; `.cw-details`, `--transcript`, `__summary`, `__body`; `.cw-disclosure`, `__text`, `__link`; `.cw-quote`, `__text`, `__caption`; `.cw-testimonial`, `__quote`, `__person`, `__photo`, `__name`, `__title`; `.cw-podcast`, `__title`, `__links`, `__link` (and `--apple`, `--spotify`, … per service), `__icon`.

**Renamed in 0.12.0**: this module was called Content Blocks. Its page moved from `/content-blocks` to `/custom-blocks` (the old address still opens it), and its feature ids from `contentBlocks*` to `customBlocks*`; saved switches carry over, and the block types (`coywolf-note`, `coywolf-details`, `coywolf-disclosure`, `coywolf-quote`) and the saved disclosure wording are unchanged.

`customBlocks: false` leaves the module out (`contentBlocks: false` still works).

## Migrating from WordPress

The **WordPress import** module (**Plugins → WordPress import**, off until you turn it on under **Plugins → Coywolf Pack**) finishes a move from any WordPress site to EmDash. EmDash's own importer (**Settings → Import**) brings over posts, pages, custom post types, categories, tags, authors and media, but it has no plugin hook, and it drops or misses some things every WordPress site has. The module covers them with three parts:

- a **prepare** step that rewrites the export (WXR) before EmDash imports it, so what EmDash would drop survives as marker HTML blocks;
- a **converter** that runs on every save while the module is on (including each entry the importer creates) and turns those markers into native blocks, plus **Convert imported content** for entries already on the site;
- **tools for after the import**: co-author and guest-author bylines, category and page parents, old `/wp-content/` URLs, and redirects.

Sites that used Coywolf's WordPress plugins (Video Manager, Coywolf SEO, Custom Blocks, Coywolf Files, Guest Author) get more: see [Coywolf WordPress plugins](#coywolf-wordpress-plugins).

### What EmDash's importer misses, and what closes the gap

| Gap | What happens on import | What closes it |
| --- | --- | --- |
| Heading `id`s | Dropped, so old `#links` break | Prepare + converter: each id becomes the heading's anchor (Headings & TOC → Heading anchors) |
| Reusable blocks (synced patterns) | The `core/block` reference is dropped | Prepare puts the pattern's blocks in its place, from the export's `wp_block` items |
| Core Details blocks | The summary is dropped | Prepare + converter: a Details block (Custom Blocks → Details) |
| Core Quote blocks | The quote's paragraphs are dropped; only the citation is kept | Prepare + converter: a Quote block with the paragraphs and citation (Custom Blocks → Quote); with Quote off, the quote stays HTML |
| Core Table captions (`<figcaption>`) | Dropped; the rows are kept | Prepare + converter: the table's `caption` field (plain text). Render it with `CaptionedTable` (see below) |
| Self-closing third-party blocks (all their content is in settings) | Dropped without a trace | Prepare lists them under **Blocks EmDash will drop**; rebuild them by hand |
| `&#91;` and bold markup in code blocks | Shown as literal text | Prepare cleans them |
| Co-authors and guest authors (Co-Authors Plus, PublishPress Authors) | Each post is credited to its WordPress user only | Step 3, **Co-authors and guest authors** |
| Category parents and page parents (`/{parent}/{child}/` URLs) | Every category is top level; pages lose their parent | Step 4, **Category and page parents**, with `{termpath:category}` and `{pagepath}` in [Content URLs](#content-urls) |
| `/wp-content/` URLs EmDash's URL rewrite misses: other blocks' fields (a testimonial photo, a video poster or caption track), `-scaled`, `-rotated` and image-editor copies of large images, files that were never media-library attachments, theme and plugin files (since EmDash 1.2.0 its rewrite also covers HTML blocks, embeds, links in text and tables, file and button blocks, covers, and `-1024x683` size variants of attachments) | Still point at the old site, and break when it goes away | Step 5, **Old-site media URLs**: matches, imports, rewrites and redirects them |
| Old slugs (`_wp_old_slug`, which WordPress redirects by itself) and redirect plugins' rules (Redirection, Rank Math, Yoast SEO Premium, Coywolf SEO) | Not in the export | Step 6, **Redirects from WordPress** |
| `/wp-content/uploads/` URLs that other sites and image search link to | 404 | Step 5 adds a redirect for every old file URL it matched |
| Image width and height | Not recorded on imported image blocks | Theme: `imageDimensions(srcs)` from `@coywolf/emdash/astro` (see [In theme code](#in-theme-code)) |
| Shortcodes, widgets, menus, theme settings, forms | Shortcodes stay as plain text; the rest isn't content | Rebuild by hand (see [Gaps to close by hand](#gaps-to-close-by-hand)) |

### Before you import

Set the site up first, so imported content comes over connected:

1. Install EmDash and Coywolf Pack ([Install](#install)) and deploy. Set `EMDASH_ENCRYPTION_KEY` so the site can store API keys.
2. Add API keys and tokens before importing, under **Plugins → Coywolf Pack → Settings** or on each module's page (for example the Stream API token on Videos, the AI Enrichment key, the Cloudflare API token for Clean Image URLs). Modules that read content as it's saved then work on imported entries right away.
3. Turn on, under **Plugins → Coywolf Pack**: **WordPress import**; **Headings & TOC** with **Heading anchors**; **Custom Blocks** with the **Details** block; **Redirects** (and add its middleware, see [Redirects](#redirects)); **Code Blocks** if the site has code. Coywolf plugin users turn on more (see below).
4. Set `urls` in `coywolfPlugin()` to the permalink structure WordPress used (for example `posts: "/{termpath:category|uncategorized}/{slug}/"` for `/%category%/%postname%/`), so links, sitemaps and redirects use the same URLs. See [Content URLs](#content-urls).
5. Keep the WordPress site online until you finish: EmDash imports media from it, and step 5 downloads files that weren't in its media library. Back up the EmDash site before converting (see [Backups](#backups)).

### Step by step

Every step is on **Plugins → WordPress import**, in this order. Steps that change content have a **Dry run** that changes nothing, and running a step again changes nothing.

1. **Export** from WordPress: **Tools → Export → All content**.
2. **Prepare the WordPress export** (step 1): choose the file, check the report, and download the prepared copy. The file is processed in your browser and isn't uploaded. Or, from a checkout of this repository:

   ```bash
   node scripts/wp-prepare.mjs export.xml export-prepared.xml --redirects=old-slugs.json
   ```

   The report lists what changed per block (`core/heading → anchor`, `core/block → inlined`, …) and, separately, **Blocks EmDash will drop**: note those to rebuild after importing.
3. **Import** the prepared file under **Settings → Import** with EmDash's importer, including its media (attachments) and its URL rewrite. Map WordPress authors to users as you like.
4. **Convert imported content** (step 2) → **Dry run**. It should list nothing, because entries convert as they're imported. If the module (or a block) was off during the import, run **Convert**.
5. **Co-authors and guest authors** (step 3) → **Dry run**, then **Create bylines and credit posts**.
6. **Category and page parents** (step 4) → **Dry run**, then **Set category parents**. Paste the `pageParents` it shows into `coywolfPlugin()`, and use `{termpath:category}` and `{pagepath}` in `urls`.
7. **Old-site media URLs** (step 5): **Find old URLs**, then **Import missing files**, then under **Rewrite URLs in content** a **Dry run** and **Rewrite URLs**, then **Add to Redirects** for the old file URLs.
8. **Redirects from WordPress** (step 6): paste each redirect plugin's rules (commands below), **Build rules**, check the list and what was skipped, then **Add to Redirects** (or **Download JSON** and import it on the Redirects page).
9. Close the [gaps to close by hand](#gaps-to-close-by-hand), then [verify](#verifying-the-move).
10. When everything checks out, turn **WordPress import** off (nothing converts on save anymore; converted content stays).

### Prepare and convert

EmDash converts Gutenberg with `@emdash-cms/gutenberg-to-portable-text`, which plugins can't extend: blocks it doesn't know become an HTML block of their saved HTML, and self-closing blocks (which keep everything in their settings) are dropped. Heading ids are dropped too. The prepare step rewrites, inside each entry's content only, what would be lost into HTML blocks holding a marker (`<div data-coywolf-wp="…" data-coywolf-attrs="…">`), which EmDash keeps, and leaves everything else byte for byte. While WordPress import is on, every save turns markers into native blocks; **Convert imported content** does the same for entries already on the site, draft-aware (an entry with unpublished changes is updated in its draft) and never overwriting an entry that changed while it ran.

| WordPress | Becomes | Notes |
| --- | --- | --- |
| Heading `id`s | the heading's anchor | Kept as written (no `jump-` prefix), so old `#links` work. Turn on Headings & TOC's anchors. |
| `core/block` (reusable block, synced pattern) | the pattern's blocks | Inlined from the export's `wp_block` items, up to 5 levels deep, and prepared like the rest. A pattern that isn't in the export is listed as `core/block (reusable block not in the export)`. Later edits to the pattern don't carry over (EmDash has no synced patterns). |
| core `details` | Details | Summary and content exactly; "open by default" kept. Needs the Custom Blocks Details block. |
| core `quote` | Quote | The paragraphs (formatting, links and the spaces between them kept) and the `<cite>` directly inside the quote as who said it (several are joined with commas). A `<cite>` inside a paragraph (a cited title) and a quote nested in it stay part of the quote. Needs the Custom Blocks Quote block; without it, a blockquote in an HTML block. |
| core `table` with a caption | EmDash table + `caption` | EmDash keeps the rows; the `<figcaption>` becomes a `caption` string on the table block (tags dropped, entities decoded). EmDash's editor keeps the field when it saves. EmDash's own table renderer ignores it: pass `CaptionedTable` from `@coywolf/emdash/astro` as the table renderer, `<PortableText value={value} components={{ type: { table: CaptionedTable } }} />`, which wraps a captioned table in `<figure class="cw-table">` with a `<figcaption>` (and renders tables without a caption as EmDash does). |
| `code` | EmDash code block | Language kept (Prism's `markup` → `html`); bold markup and `&#91;` inside code are cleaned |
| Yoast related links | HTML block | The markup WordPress rendered |
| `gravityforms/form` | empty marker (`gravity-form`, with `formId`) | Rebuild the form (EmDash forms plugin or theme) |
| Other self-closing third-party blocks | dropped by EmDash | Listed in the prepare report; nothing changes |

Everything else goes through EmDash's importer unchanged. Blocks from Coywolf's WordPress plugins are in [Coywolf WordPress plugins](#coywolf-wordpress-plugins).

### Co-authors and guest authors

EmDash's importer credits each post to its WordPress user (`dc:creator`) and nothing else. **Co-authors and guest authors** (step 3) reads, from the export:

- **Co-Authors Plus**: the post's `author` terms (`cap-<login>`), with users' display names from the export's authors and guest authors' profiles from their `guest-author` entries (display name, website, bio, avatar);
- **PublishPress Authors**: the post's `author` terms, with profiles from term meta (`user_url`, `description`, `avatar`);
- **Coywolf Guest Author**: the guest in post meta (`_guest_author`, `_guest_author_url`, `_guest_author_bio`, `_guest_author_avatar_id`), which replaced the byline.

A post whose only author is its own WordPress user is left alone. Then, from your browser with EmDash's own byline and content API, as you:

1. **Dry run** looks up, for each author, a byline with the same name (the importer creates one per WordPress user), the avatar in the media library (by file name; present when the importer imported the attachments), and each imported post (by its WordPress slug) with its current bylines.
2. **Create bylines and credit posts** creates a guest byline (name, website, bio as plain text, avatar) for each author who has none, and sets each post's bylines to its authors in WordPress's order. Posts already credited are skipped. You need permission to manage bylines and edit any entry.

Schema & Social's author and Review schema then name the authors. What stays manual: an avatar that isn't in the media library (upload it, then pick it on the byline under **Bylines**); a post whose slug changed on import ("Not found" in the dry run; credit it in the editor).

### Category and page parents

EmDash's importer creates every category at the top level and drops each page's parent, so WordPress URLs with parent categories (`/news/local/a-post/`) or parent pages (`/about/team/`) are lost. **Category and page parents** (step 4) puts them back, from your browser:

1. It reads the categories (`<wp:category>` with `<wp:category_parent>`) and pages (`<wp:post_parent>`) from the export.
2. **Dry run** lists each category that had a parent in WordPress with its parent on the site now: "Set to …", "Change to …", "Already set", or why it can't be set.
3. **Set category parents** sets them through EmDash's own taxonomy API (`PUT /_emdash/api/taxonomies/category/terms/<slug>`), as you, parents first. You need permission to manage taxonomies.

EmDash pages have no parent, so the step shows a ready-to-paste `pageParents` option for `coywolfPlugin()` instead (use it with `{pagepath}`, see [Content URLs](#content-urls)). `node scripts/wp-prepare.mjs` prints the same option, plus a `termParents` option you can use until the category parents are set.

### Old-site media URLs

EmDash's importer imports attachments into the media library and rewrites their URLs in image, gallery, column and cover blocks, file and button blocks, embeds and HTML blocks, and links in text and tables (EmDash 1.2.0+), including `-1024x683` size variants of an attachment. **Old-site media URLs** (step 5) handles every other `/wp-content/uploads/`, `/wp-content/themes/` and `/wp-content/plugins/` URL of the old site:

1. **Find old URLs** searches every entry (its latest draft included) for URLs on the old site's host names (filled in from the export; add a CDN host if media was served from one), protocol-relative and site-relative ones, URLs through Jetpack's image CDN (`i0.wp.com/<host>/…`), and URLs under the folder WordPress was installed in. It then reads the media library.
2. Each URL is matched to a media library file. Size variants (`photo-1024x683.jpg`), `-scaled` and `-rotated` copies and image-editor copies (`photo-e1589912345678.jpg`) match the file imported from their original attachment, found through the export's attachment URLs (folder and name, so two `logo.png` in different months don't mix). A URL that wasn't an attachment, and theme and plugin files, are **not in the media library**; several media files with the same name are **ambiguous** (fix those in the editor). Attachments not used in content are included too, for redirects.
3. **Import missing files** downloads those files from the old site into the media library with EmDash's own media importer (`POST /_emdash/api/import/wordpress/media`, which blocks private addresses and reuses a file with the same bytes, so running it again adds nothing). It needs the old site online and permission to import.
4. **Rewrite URLs in content** → **Dry run**, then **Rewrite URLs** points every matched URL at its media file (`/_emdash/api/media/file/<key>`) in every entry's Portable Text (HTML blocks, links, text, and other blocks' fields) and text fields. Image and file fields are left to EmDash's rewrite. It runs the converter too.
5. **Add to Redirects** adds a 301 from each old file path to its media file (the Redirects module handles file paths, which EmDash's built-in redirects skip), or **Download JSON** to import on the Redirects page.

Without the export loaded, uploads match by file name alone and unused attachments get no redirect. If the old site is already offline, upload the missing files under **Media** and fix the entries the URL table lists by hand.

### Redirects from WordPress

**Redirects from WordPress** (step 6) builds Redirects module rules from:

- **Old slugs**: each published entry's `_wp_old_slug` values (WordPress redirected them by itself) become a 301 from the old URL to the entry's permalink in the export, both as WordPress built them. An old URL another entry uses now is skipped.
- Redirect plugins. Run on the WordPress server with WP-CLI and paste the output (change `wp_` if your tables use another prefix):

  | Plugin | Command |
  | --- | --- |
  | Redirection | `wp db query "SELECT url, action_data, action_code, action_type, match_type, regex, status FROM wp_redirection_items"` |
  | Rank Math | `wp db query "SELECT sources, url_to, header_code, status FROM wp_rank_math_redirections"` |
  | Yoast SEO Premium | `wp option get wpseo-premium-redirects-base --format=json` |
  | Coywolf SEO | `wp db query "SELECT source, target, type, is_regex FROM wp_coywolf_seo_redirects"` |

Absolute targets on the old site become site paths. Rank Math's exact, starts-with, ends-with, contains and regex sources each become a rule; Rank Math and Yoast patterns (stored without a leading slash) get one. 303 becomes 302, and 404/451 rules become 410 Gone (a 404 rule needs no redirect). Skipped, with the reason listed: disabled rules, rules with conditions (login state, referrer, user agent, …), sources with a query string, and patterns that aren't valid JavaScript regular expressions. A rule from a plugin wins over an old slug with the same source.

Old-slug rules point at the URLs WordPress used. If EmDash serves different URLs, set `urls` first (see [Before you import](#before-you-import)) or fix the targets on the Redirects page. What WordPress also did by itself and isn't carried over: guessing a post for a mistyped URL, `/?p=<id>` links, date-changed URLs (`_wp_old_date`), and archive URLs your theme doesn't serve (`/author/<name>/`, `/<year>/<month>/`, `/feed/`). Add rules for any that still get traffic (the Redirects page has a URL tester).

### Gaps to close by hand

- **Blocks EmDash drops**: the prepare report lists them by block name. Rebuild each (a pack block, an embed, or HTML) in the entries that used it.
- **Image width and height**: imported image blocks have no size. In the theme, get sizes from the media library with `imageDimensions(srcs)` (one query per page), and set `width`/`height` (and `srcset`) on content images.
- **Shortcodes** stay as plain text (`[gallery …]`). Search content for each shortcode's name and replace it with a block.
- **Forms** (`gravity-form` markers, other form plugins): rebuild with the EmDash forms plugin or the theme.
- **Menus, widgets, theme settings**: not content; rebuild them in the theme and EmDash's menus.
- **Theme assets used by the theme itself** (CSS backgrounds, fonts): step 5 only finds those linked from content. Move the rest into the new theme.

### Verifying the move

1. **Convert imported content → Dry run** lists nothing.
2. **Old-site media URLs → Find old URLs** shows 0 not in the media library and 0 ambiguous, and its **Rewrite URLs** dry run lists nothing.
3. Every old URL still works. List WordPress's published URLs before it goes away, then check each on the new site (replace the host names):

   ```bash
   wp post list --post_type=post,page --post_status=publish --field=url > old-urls.txt
   while read -r url; do
     new="${url/https:\/\/old.example.com/https://new.example.com}"
     code=$(curl -s -o /dev/null -w '%{http_code}' "$new")
     [ "$code" = 200 ] || echo "$code $new"
   done < old-urls.txt
   ```

   Anything not 200 needs a redirect or a `urls` fix. Run it with `curl -L` to follow redirects and check where they end up.
4. Check a few old media URLs (a size variant and an attachment) with the URL tester on the Redirects page.
5. Run **Link Manager** (if on) for broken internal links.
6. Spot-check entries: heading anchors (`#links`), Details blocks, bylines, category and page URLs, and the Rich Results Test on an article.

### Coywolf WordPress plugins

For sites that used Coywolf's WordPress plugins. These all run as part of the steps above (their blocks are converted by the same prepare step and converter), plus three extra steps (A–C) at the bottom of the WordPress import page.

**Before importing**, also turn on **Videos** (and Video schema, sitemap, plays and likes as wanted), **Reviews** and **Review schema**, **Custom Blocks** with the Note, Details, Affiliate disclosure, Quote, Testimonial and Podcast links blocks, **Headings & TOC** with the **Table of Contents block**, **File Downloads**, and **Code Blocks**. Set your disclosure wording and podcast links on the Custom Blocks page. Connect Stream on the Videos page (same account), or at least set the customer subdomain. Then paste Video Manager's and Coywolf Files' settings into **A. Player and download card defaults** (`wp option get coywolf_cvm_settings --format=json`, `wp option get coywolf_files_settings --format=json`) so converted blocks keep the site-wide choices.

| WordPress block | Becomes | Notes |
| --- | --- | --- |
| `coywolf-custom-blocks/cloudflare-stream` + the Custom HTML embed before it | Coywolf Video | Name, description, length (hours/minutes/seconds), player options from the iframe URL (autoplay, loop, muted, controls, preload, poster frame), size from the wrapper (padding-top %, max-width). Wrappers whose iframe was stripped on WordPress get their video back. |
| Custom HTML with only a Stream iframe or `<stream>` element | Coywolf Video | Same options; a `<figcaption>` becomes the shown description. Works for any site that embedded Cloudflare Stream this way. |
| `coywolf/video` (Video Manager) | Coywolf Video | Every block option; options the block didn't set take Video Manager's settings (step A; the plugin's defaults otherwise) |
| `coywolf-custom-blocks/review` | Coywolf Review | Item type from the Schema Type field, else Book when it has book details, Software application when it has operating systems or a category, else Product. Book and software details go into the new schema fields. Ratings import exactly (4.7 stays 4.7). |
| `coywolf-seo/table-of-contents` | Table of Contents | Levels, list style (disc → bulleted, decimal → numbered), title, show title, collapsible/collapsed |
| `coywolf/file` (Coywolf Files) | File download | Keeps the WordPress file id; see step B |
| `code` (Code Block Enhancer) | EmDash code block | As above |
| `coywolf-custom-blocks/sidenote`, `editorsnote` | Note | The text exactly as written. Sidenotes are Note-kind with WordPress's title "📌 Sidenote", editor's notes Editor's-note-kind with "📝 Editor's Note", both as H2. |
| `coywolf-custom-blocks/transcript`, `accordion` | Details | Summary (the transcript's default was "Read the audio transcript") and the hidden HTML exactly; transcripts use the Transcript style |
| `coywolf-custom-blocks/blockquote` | Quote | The quote, who said it (with its link) and the source URL from the `cite` field |
| `coywolf-custom-blocks/ftc` / `amazon` | Affiliate disclosure (affiliate / Amazon Associates) | They had no text of their own (the theme printed it), so they use the wording on the Custom Blocks page. Other self-closing disclosure blocks convert when you name them in **More affiliate disclosure blocks** (step 1) or with `--disclosure-block=` (coywolf.com used `genesis-custom-blocks/disclosure`). |
| `coywolf-custom-blocks/testimonial` | Testimonial | Name, title, quote, Social URL (the name's link) and Work URL (the title's link) exactly. The headshot keeps its WordPress URL until step 5 points it at the media library. |
| `coywolf-custom-blocks/podcast-rss` | Podcast links (the site's links) | The WordPress block had no fields: its template printed the show's links. Set them once on the Custom Blocks page. |
| `coywolf-custom-blocks/newsletter` | removed | Rendered nothing on WordPress |

Notes, details, quotes, disclosures, testimonials and podcast links convert only while their Custom Blocks switch is on. Otherwise their markers stay HTML blocks (with WordPress's markup, so the text shows) and convert when you turn the block on and run **Convert imported content** again. Markers from 0.10.0 and 0.11.0, and the `data-wb-block` markers of an earlier wellbeing.io import script (`cloudflare-stream`, `review`), convert too.

**After importing**, besides steps 1–6:

- **Guest authors** (Coywolf Guest Author plugin) are credited in step 3 with the other authors.
- **Coywolf SEO redirects** go in step 6 (or straight into **Redirects → Import**, see [Redirects](#redirects)).
- **B. Coywolf Files downloads**: copy each Coywolf Files object into the bucket bound as `FILES` (or `MEDIA`) under the same key (`coywolf-files/YYYY/MM/<id>-<name>`), paste `wp db query "SELECT file_id, object_key, filename, mime, size, downloads, created FROM wp_coywolf_files"`, and set **Files → Settings → Download URL base** to WordPress's link base (`coywolf-file` by default) so old download links keep working. Download counts carry over.
- **C. Video Manager library**: paste the output of `wp option get coywolf_cvm_descriptions --format=json` (and the same for `coywolf_cvm_posters` and `coywolf_cvm_downloads`) for per-video descriptions, posters and MP4 links. On the Videos page, **Refresh** the library (with the token) and **Rebuild embed index**.
- Run the Headings & TOC, Schema and Videos checks on a few entries (Rich Results Test for a review and a video page).

Without a Stream token, converted videos still play and have VideoObject schema: the name, length, upload date and size come from WordPress and are stored as the video's details until Stream's own data replaces them. Captions, plays from Stream, MP4 links found via the API, and the library listing need the token.

## Development

```bash
npx tsc --noEmit -p .        # typecheck
npm test                     # unit tests: test/ and src/**/*.test.ts (Node 22.15+; runs the TypeScript sources directly)
```

## License

MIT

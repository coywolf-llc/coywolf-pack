# Clean Image URLs

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Resized copies of media-library images at short, cacheable addresses instead of Astro's `/_image?href=…&w=…&h=…` endpoint. Off until you turn on **Clean Image URLs** on the **Features** page (**Coywolf Pack → Features** in the sidebar); the **Clean Image URLs** admin page appears once it's on.

## The media host

A subdomain of the site, such as `media.coywolf.com`, serves the media bucket directly from Cloudflare, which resizes on the fly and picks AVIF or WebP for browsers that accept them. Images never touch the site's Worker.

```
https://media.coywolf.com/<file>               the original file
https://media.coywolf.com/s/<w>x<h>/<file>     cropped to fill (fit: cover)
https://media.coywolf.com/s/<w>/<file>         width only, keeps the ratio
```

`<file>` is the media item's stored file name (`<id>.<ext>`, as in `/_emdash/api/media/file/<id>.<ext>`). Sizes go up to 2560px. Without a media host, `cleanImageUrl()` returns `null` and themes use their usual image code (EmDash's own `/_image` endpoint resizes through the Worker).

**Where the host comes from**:

1. **EmDash's own media setting**: `storage: r2({ binding: "MEDIA", publicUrl: "https://media.coywolf.com" })` in `astro.config.mjs` (EmDash 1.4+). It has to be a plain `https://` address with no path, on a domain of the site's zone (an `r2.dev` address can't resize, so it's never used as the media host; its URLs are still recognized). With it, EmDash's own components (Image, Gallery, Video) print media at the same host, and newer EmDash releases give the site settings' logo, favicon and default social image there too, so one setting covers EmDash and the pack. The Clean Image URLs page shows the host as coming from EmDash's setting, and it's changed in `astro.config.mjs` only.
2. **The host saved on the Clean Image URLs page** (takes effect within a minute, no deploy).
3. **The pack's option**, `coywolfPlugin({ images: { cdn: "https://media.coywolf.com" } })`: the fallback, from before EmDash had `publicUrl`.

`publicUrl` is used when the pack has no host of its own (2 or 3), or the same one. When the pack has a different working host, that one stays in use (`publicUrl` may not have the `/s/` rules), and the Clean Image URLs page says so: make `publicUrl` the same host, or, once **Check** passes on it, remove the pack's own host so `publicUrl` takes over.

**Media URLs in every form.** Wherever the pack takes an image (`cleanImageUrl()`, `originalImageUrl()`, `imageInfo()`, `responsiveImage()`, `croppedImage()`, the og:image and JSON-LD images, the default social image from **Settings → SEO**), it accepts EmDash's `/_emdash/api/media/file/<file>`, the original under EmDash's `publicUrl` (`https://media.coywolf.com/<file>`, the form EmDash prints when it's set, also when `publicUrl` has a path and can't be the media host), and the original on the media host. Stored content keeps EmDash's `/_emdash/api/media/file/<file>` addresses, and those keep working.

**Old Worker-route addresses.** Earlier releases resized images in the Worker for sites without a media host, at `/media/<file id>-<w>x<h>.<format>` (or `-<w>w.<format>`). That duplicated EmDash's own `/_image` endpoint, and none of the sites used it (they all have a media host), so it's gone. Those addresses still answer a 301 to the same size on the media host, so old links keep working; without a media host they're a 404. The `format` option of `cleanImageUrl()` only applied to that route and is ignored now.

## Moving a site to EmDash's publicUrl

A site that sets `images.cdn` (all eight Coywolf sites today) can move the host to EmDash's own setting. Using coywolf.com as the example:

1. **Update the pack first** to a release with this change (it reads `publicUrl` and accepts `https://media.coywolf.com/<file>` URLs from EmDash). An older pack doesn't recognize EmDash's media-host URLs, so images EmDash hands it in that form would lose their clean sizes. Updating in the same commit as step 2 is fine.
2. **In `astro.config.mjs`**, add `publicUrl` to the storage adapter, with the same host the pack uses now:

   ```js
   emdash({
     storage: r2({ binding: "MEDIA", publicUrl: "https://media.coywolf.com" }),
     plugins: [
       coywolfPlugin({
         // images.cdn can go: EmDash's publicUrl is the media host now.
         images: { crops: [[400, 210], [600, 315], [900, 473], [50, 50], [100, 100], [120, 120], [240, 240], [64, 64], [128, 128]] },
       }),
     ],
   });
   ```

   Removing `cdn` is optional: with the same host it changes nothing. If a different host is saved on the Clean Image URLs page, clear it there (that page warns while `publicUrl` and the pack's host differ, and keeps the pack's).
3. **Deploy.** A deploy starts with an empty page cache (Workers Cache is per Worker version), so pages pick up the change at once.
4. **Check.** Open **Clean Image URLs**: it says the host comes from EmDash's media setting, and **Check** passes. On a page, images EmDash renders itself (its `Image` component, for example) now load from `https://media.coywolf.com/<file>` instead of `/_emdash/api/media/file/<file>`; the theme's images were already on the media host.

Nothing else has to change at the same time: the media host's Cloudflare setup (custom domain, rewrite rules, Image Transformations, Smart Tiered Cache) stays as it is, themes that build `/_emdash/api/media/file/<key>` addresses keep working (coywolf.com's `src/lib/site.ts` does), and stored content isn't rewritten. Two things to know:

- **The bucket is public through the host.** This was already true with `images.cdn`: everything in the media bucket can be fetched at `https://media.coywolf.com/<key>`, including large uploads stored there (`files/<id>/<name>`, unless they have their own `FILES` bucket) and EmDash's own JSON backups under `backups/` if they're ever turned on (**Settings → Backups**; the pack's Backups use their own private bucket). Keep private files out of the media bucket.
- **To move back**, remove `publicUrl` (and put `images.cdn` back) and deploy.

## Setting up a media host

The media host needs three things on Cloudflare, in the zone of the site's domain, and works best with a fourth:

1. **Image Transformations** turned on for the zone (Images → Transformations → Enable for zone; same-zone sources only, so leave "Resize images from any origin" off).
2. **An R2 custom domain** on the media bucket (the bucket bound as `MEDIA`): R2 → the bucket → Settings → Custom Domains → Add `media.coywolf.com`, minimum TLS 1.2. Cloudflare adds the DNS record and certificate.
3. **Two URL rewrite rules** (Rules → URL Rewrite, phase `http_request_transform`), named exactly so the setup button recognizes them:

| Name | Filter expression | Path rewrite (dynamic) |
| --- | --- | --- |
| `media.coywolf.com: /s/<W>x<H>/<file> → cropped resize (Coywolf Pack clean image URLs)` | `(http.host eq "media.coywolf.com" and http.request.uri.path wildcard "/s/*x*/*")` | `wildcard_replace(http.request.uri.path, "/s/*x*/*", "/cdn-cgi/image/width=${1},height=${2},fit=cover,format=auto,quality=85/${3}")` |
| `media.coywolf.com: /s/<W>/<file> → resize to width (Coywolf Pack clean image URLs)` | `(http.host eq "media.coywolf.com" and http.request.uri.path wildcard "/s/*/*" and not http.request.uri.path wildcard "/s/*x*/*")` | `wildcard_replace(http.request.uri.path, "/s/*/*", "/cdn-cgi/image/width=${1},format=auto,quality=85/${2}")` |

4. **Smart Tiered Cache** turned on for the zone (Caching → Tiered Cache → Smart Tiered Caching; free on every plan). Each Cloudflare data center has its own cache, so an image nobody has loaded there yet goes back to R2. With Smart Tiered Cache, that data center asks a nearby upper-tier Cloudflare cache first (placed near the R2 bucket), so after one visit anywhere, first loads elsewhere come from Cloudflare's cache. Pages don't need it: Workers Cache is always tiered. The setup only ever turns it on, never off.

Do it by hand with the step-by-step guide on the Clean Image URLs page, or let **Set up media host** on that page do it through the Cloudflare API: enter the media host and the media bucket's name (with the [Cloudflare API token](README.md#the-cloudflare-api-token) saved; the account comes from the token), select **Review setup** to see the plan ("Turn on Image Transformations for coywolf.com, connect media.coywolf.com to the R2 bucket example-media, add 2 URL rewrite rules, turn on Smart Tiered Cache"), then **Apply**. Anything already done is skipped (a token without permission for Smart Tiered Cache still gets the other steps, and that step names the missing permission), the zone's other URL rewrite rules are kept as they are, and only the pack's own two rules (matched by name) are replaced. It finishes with a check. The page checks the media host each time it opens: when it works, Set up media host shows as done with **Run setup again**, and the host field opens with **Change host**.

With a media host set, every page the site serves carries `Link: <https://media.coywolf.com>; rel=preconnect`, so browsers open the connection to the media host (DNS, TCP and TLS) while the page is still arriving, not when they reach the first image.

The Cloudflare API token needs these permissions here:

- Zone → Read (to find the zone)
- Zone Settings → Edit (Image Transformations and Smart Tiered Cache)
- Transform Rules → Edit, and Account Rulesets → Read (the URL rewrite rules)
- Workers R2 Storage → Edit, and DNS → Edit (the custom domain and its DNS record)

Clearing the media host's images also needs **Cache Purge → Purge**, and its cache rule on the Performance page **Cache Rules → Edit**. The token is only sent to `api.cloudflare.com`. If it sees more than one account, enter the account ID under **Advanced**, or set `CF_ACCOUNT_ID`. Before the Cloudflare API token is saved, the page keeps its own fields: a token typed just for the setup, the older saved token, or the `IMAGES_API_TOKEN` Worker secret, and the account ID.

**Check** (on the page) fetches a recent image from the media host, and a 64×64 copy of it twice, and reports whether the host is reachable, the original is served, resizing works (`cf-resized` header or an image type) and the copy is cached.

Then turn the media host on: best with EmDash's own setting in `astro.config.mjs` (see [Moving a site to EmDash's publicUrl](#moving-a-site-to-emdashs-publicurl)),

```js
storage: r2({ binding: "MEDIA", publicUrl: "https://media.coywolf.com" })
```

or on the Clean Image URLs page (takes effect within a minute, no deploy), or with the pack's option:

```js
coywolfPlugin({ images: { cdn: "https://media.coywolf.com" } })
```

EmDash's `publicUrl` is used when the pack has no host of its own or the same one (see above); a host saved on the page wins over the option, and clearing it there falls back to the option. The host must be an `https://` origin with no path.

**Quota.** Cloudflare's Free plan includes 5,000 unique image transformations a month (each new size of each image counts once a month; repeat views come from the cache). Beyond that, transformations need a paid Cloudflare Images plan.

## Open Graph and schema

With Schema & Social's Open Graph extras on:

- Pages without their own image use the site's default OG image (Settings → SEO) at a clean 1200×630 URL with its width, height, type and alt: `https://media.coywolf.com/s/1200x630/<file>` (crawlers that don't ask for WebP get the original format, so the type is the original's). The default image can be EmDash's `/_emdash/api/media/file/<file>` or, with `publicUrl`, `https://media.coywolf.com/<file>`. Without a media host, EmDash's own og:image stays.
- With a media host, a page's own image (featured image or SEO image from the media library) is output as its original on the media host, with its width, height, type and alt. The JSON-LD `primaryImageOfPage` uses the same URL.
- These og:image and twitter:image tags replace EmDash's own (never a second og:image), and clean URLs anywhere in og:image resolve back to their media item.

## In theme code

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

- `cleanImageUrl(src, { width, height? })`: the resized URL on the media host (it picks the format; a `format` option is ignored). `null` when the feature is off, there's no media host, `src` isn't a media-library file, or it's an AVIF original (Cloudflare's resizer can't read AVIF), so fall back to your usual image code. `src` can be EmDash's `/_emdash/api/media/file/<file>` or the original on the media host or under EmDash's `publicUrl`.
- `originalImageUrl(src)` (also exported as `mediaUrl`): the original file on the media host; returns `src` unchanged when the feature is off, no media host is set, or `src` isn't a media-library file.
- `imageDimensions(srcs)`: a `Map` of `src` → `{ width, height }` from the media library, for images whose Portable Text block has no size (WordPress imports don't record one). One query for a whole page, remembered per isolate; works whether or not the feature is on. Use it to build `srcset` and set `width`/`height` on content images.

## Stored image sizes

Stored sizes are made with the media bucket (`MEDIA`) and the Cloudflare Images binding (`IMAGES`, which the Astro Cloudflare adapter already binds). Other binding names: `coywolfPlugin({ images: { bucket: "MYMEDIA", images: "MYIMAGES" } })`.

With a media host, each image is also stored, once, in a few sizes as AVIF and WebP, next to the original in the media bucket, and pages use those files instead of resizing on each visit:

```
https://media.coywolf.com/v1/<id>-<w>.avif|.webp          widths 400, 640, 800, 1200, 1600 (keeps the ratio)
https://media.coywolf.com/v1/<id>-<w>x<h>.avif|.webp      the site's crops (fit: cover, around the image's focal point)
```

- **What's made.** Each width smaller than the original (the original is always the largest candidate; images under 400 pixels have none and render as a plain `<img>`), and, when a page first shows it, each crop in `images.crops` that fits inside the original (never upscaled). JPEG, PNG and WebP originals up to 20 MB; GIFs, SVGs, AVIF originals and larger files keep using `/s/`. WebP is made at quality 85, AVIF at 80; Cloudflare doesn't encode AVIF beyond 1200 pixels on a side, so those sizes are stored as WebP under the `.avif` name too (with their real `Content-Type: image/webp`; a `<source type="image/avif">` only picks the candidate list, and every browser that takes AVIF also decodes WebP). Files are stored with `Cache-Control: public, max-age=31536000, immutable`.
- **Crops** are the exact sizes the theme shows (list thumbnails, avatars at 1x and 2x, the Testimonial block's 64×64 and 128×128 photo). They're made **on first use**: when `croppedImage()` finds an image's widths stored but a listed crop missing, it makes just that crop after the response (one at a time per isolate, at most 6 images queued; a failure waits an hour before it's tried again), merges it into the record in SQL (crops added meanwhile by another isolate are kept), and marks the page as a stopgap so its next render uses it. So avatars and testimonial crops are made only for the images that are shown that way, and list crops only for featured images. A size not in `images.crops` always uses `/s/`.

  ```js
  coywolfPlugin({ images: { cdn: "https://media.coywolf.com", crops: [[400, 210], [600, 315], [900, 473], [50, 50], [100, 100], [64, 64], [128, 128]] } })
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

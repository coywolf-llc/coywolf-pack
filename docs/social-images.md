# Social Images

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

A 1200×630 Open Graph image for each published entry that has no image of its own: the entry's title, your site's name and logo, in your colors. It's made once, when the entry is published (and again when its title or the template changes), stored in your media bucket, and set as the page's `og:image` and `twitter:image`. Glossary terms and marketing pages that share one default image get their own instead.

Feature switch: **Social Images** (`socialImages`), off by default. It needs [Schema & Social](schema.md) on, which sets the tags. The page is **SEO → Social Images**.

## How images are made

The template is an HTML page (`src/social/template.ts`). Cloudflare **Browser Run** (formerly Browser Rendering) opens it in a headless browser and takes a 1200×630 PNG screenshot. The pack reaches Browser Run in one of two ways:

- **A `BROWSER` binding** (no token): add `"browser": { "binding": "BROWSER" }` to the site's `wrangler.jsonc`. Its Quick Actions need a `compatibility_date` of 2026-03-24 or later.
- **The REST API**: the [Cloudflare API token](README.md#the-cloudflare-api-token) with **Browser Run → Edit** (added by hand: Cloudflare's form can't pre-select it). The account comes from the token; if it sees more than one, enter the account ID under **Advanced** on the Social Images page, or set `CF_ACCOUNT_ID`. An older Social Images token (saved on the page, or the `BROWSER_RUN_API_TOKEN` Worker secret) still works until the Cloudflare API token is saved. Calls go to `api.cloudflare.com` through the plugin's allowed hosts, with a 30-second deadline.

**Render a test image** on the page makes one with a sample title and shows it, without storing it.

### Why Browser Run, not a renderer in the Worker

The usual in-Worker approach is Satori (HTML/CSS to SVG, with the Yoga layout engine) plus resvg's WebAssembly build to turn the SVG into a PNG. It was considered and not used:

- **Bundle size.** Satori, Yoga and resvg add about 3 MB to every site's Worker (roughly 1.3 MB compressed), plus the font files they need (each weight 100–300 KB). Workers Free allows 3 MB compressed for the whole Worker, and the pack is in every site's bundle whether the feature is on or not.
- **CPU.** Rasterizing a 1200×630 image takes tens to hundreds of milliseconds of CPU in the request that makes it.
- **Fonts and layout.** Satori supports a subset of CSS and only the fonts you bundle, so the template would need its own font files and layout rules.

Browser Run renders the same HTML with real fonts, adds nothing to the bundle, and costs a second or two of browser time per image, once per entry. Cloudflare Images can resize and overlay images but can't draw text, so it can't make these on its own.

### Limits and cost

Browser Run's own limits, then the pack's (each image takes one Quick Action and about five D1 statements; EmDash runs every due scheduled task in one invocation, which Workers Free limits to 50 D1 queries):

| | Workers Free | Workers Paid |
| --- | --- | --- |
| Browser Run | 10 minutes of browser time a day; one Quick Action every 10 seconds | 10 hours a month included, then $0.09 an hour; 10 requests a second |
| Each publish | its own image, right after the response | the same |
| Hourly job | 4 images, 10 seconds apart (about 100 a day) | up to 30 |
| Generate on the page | 2 images per request, 10 seconds apart (about 6 a minute while the page is open) | 4 per request |

The pack treats a site as Paid only when the Cloudflare usage card (Performance page) has seen the Paid plan; otherwise it paces for Free. At one to two seconds of browser time an image, Free's 10 minutes a day cover a few hundred images, so the hourly job, not browser time, is the limit there: a backlog of 1,000 entries takes about ten days by itself, or a few hours with the page open. When Browser Run says no (429), the run waits out its Retry-After if there's time, else stops, and the rest wait for the next run. Other failures are tried again up to three times, then shown as failed on the page. A setup problem (no token, or a `BROWSER` binding on a Worker whose compatibility date is before 2026-03-24) stops the run once, with the message on the page.

## When images are made

- **On publish or save**: after the response, the entry is read as published (a save of a draft never changes its image) and compared with its record. A changed title gets a new image right away; an unchanged entry costs a few reads and nothing else. A publish fires two hooks (after save and after publish); one check serves both. An entry with its own image (an SEO image or an image field) is skipped.
- **Hourly**: the `social-images` task makes waiting images, oldest first (see above). It's scheduled only while Social Images is on.
- **Generate for existing entries** on the page: queues every published entry without its own image whose image is missing or out of date (a new title, or after a template change), then makes their images while the page is open (the hourly task continues if you leave).
- **Make again** on an image redraws that entry's image now.

An image is redrawn only when what it shows changes: its file name has a hash of the title, the site's name, the logo and the template. The previous image is kept until the one after it is made (pages still in the edge cache may point to it), then deleted. When an entry gets a new image, its page is cleared from the edge cache. The image's alt text is the title it shows. Two renders of one entry at once can't leave an older or failed record over a newer image (records are written by compare-and-set). Deleting an entry deletes its images and record.

## Template

- **Colors**: background, text and accent (hex, like `#0f172a`).
- **Layout**: the title on the left with an accent bar at the side, or centered with an accent bar on top.
- **Logo and site name**: from **Settings → General** (Site title and Logo); each can be hidden. The logo is read from the media bucket and embedded in the page Browser Run renders (up to 512 KB), so the browser doesn't fetch anything.
- **Collections**: which collections get images (all with public pages by default).

The title is set in the system font stack (Browser Run's Chromium), 44–84 px depending on its length, at most four lines.

## Storage and URLs

- Images are in the media bucket (bound as `MEDIA`; another name with `coywolfPlugin({ socialImages: { bucket: "MYMEDIA" } })`) under `coywolf-og/<collection>/<entry id>-<hash>.png`, with a one-year immutable cache lifetime.
- With a [media host](images.md#setting-up-a-media-host): `https://media.example.com/coywolf-og/…png`. Without one: `/_emdash/api/media/file/coywolf-og/…png` on the site (EmDash's media route).
- Each entry's record is one plugin storage document (`socialImages`, id `<collection>:<entry id>`), read with the page's other pack reads (one D1 round trip).
- Backups include the images (the media bucket) and the records (D1).

## Themes that pass a default image

The generated image is used only when the page passes no image: no `image` and no `seo.ogImage` to `EmDashHead`. Any image the theme passes wins (a photo from the body, a file or reference field), since Social Images can't tell it from the entry's own.

Many themes pass a site-wide default share image when an entry has none (as `image`, and sometimes as `seo.ogImage`). List it under **Theme default images** in Social Images' settings (URLs or paths, compared by path, so `/theme/images/share.png` matches `https://example.com/theme/images/share.png?v=2`), and pages that pass only that image get their generated one instead. Saving those settings clears the page cache, as other pack settings saves do.

If the theme prints its own `og:image:width`, `og:image:height` or `og:image:alt` for its default image, print them only when the page has an image of its own; otherwise pages carry both sets (the generated image's come first, inside `EmDashHead`).

## Notes

- The tags include the image's size, type and alt (the title the image shows), with or without Schema & Social's Open Graph extras; `twitter:card` becomes `summary_large_image`. With the Schema.org graph on, the image is the page's primary image there too.
- An entry that gets an image field later keeps it: its record is marked skipped and its generated image is no longer used.

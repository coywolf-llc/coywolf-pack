# Social Images

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

A 1200×630 Open Graph image for each published entry that has no image of its own: the entry's title, your site's name and logo, in your colors. It's made once, when the entry is published (and again when its title or the template changes), stored in your media bucket, and set as the page's `og:image` and `twitter:image`. Glossary terms and marketing pages that share one default image get their own instead.

Feature switch: **Social Images** (`socialImages`), off by default. It needs [Schema & Social](schema.md) on, which sets the tags. The page is **SEO → Social Images**.

## How images are made

The template is an HTML page (`src/social/template.ts`). Cloudflare **Browser Run** (formerly Browser Rendering) opens it in a headless browser and takes a 1200×630 PNG screenshot. The pack reaches Browser Run in one of two ways:

- **A `BROWSER` binding** (no token): add `"browser": { "binding": "BROWSER" }` to the site's `wrangler.jsonc`. Its Quick Actions need a `compatibility_date` of 2026-03-24 or later.
- **The REST API**: a Cloudflare API token with **Account → Browser Run → Edit**, saved on the Social Images page (stored encrypted) or set as the `BROWSER_RUN_API_TOKEN` Worker secret, and the account ID (on the page, or the `CF_ACCOUNT_ID` Worker secret; not needed when the token can see one account). The page has the step-by-step guide and a pre-filled token form. Calls go to `api.cloudflare.com` through the plugin's allowed hosts, with a 30-second deadline.

**Render a test image** on the page makes one with a sample title and shows it, without storing it.

### Why Browser Run, not a renderer in the Worker

The usual in-Worker approach is Satori (HTML/CSS to SVG, with the Yoga layout engine) plus resvg's WebAssembly build to turn the SVG into a PNG. It was considered and not used:

- **Bundle size.** Satori, Yoga and resvg add about 3 MB to every site's Worker (roughly 1.3 MB compressed), plus the font files they need (each weight 100–300 KB). Workers Free allows 3 MB compressed for the whole Worker, and the pack is in every site's bundle whether the feature is on or not.
- **CPU.** Rasterizing a 1200×630 image takes tens to hundreds of milliseconds of CPU in the request that makes it.
- **Fonts and layout.** Satori supports a subset of CSS and only the fonts you bundle, so the template would need its own font files and layout rules.

Browser Run renders the same HTML with real fonts, adds nothing to the bundle, and costs a second or two of browser time per image, once per entry. Cloudflare Images can resize and overlay images but can't draw text, so it can't make these on its own.

### Limits and cost

- **Workers Free:** 10 minutes of browser time a day, and one Quick Action every 10 seconds. That's a few hundred images a day.
- **Workers Paid:** 10 hours of browser time a month included, then $0.09 an hour; up to 10 requests a second.
- When Browser Run says no (429), the batch stops and the rest wait for the next run. Other failures are tried again up to three times, then shown as failed on the page.

## When images are made

- **On publish**: publishing (or saving a published entry) queues it and starts its image right after the response. An entry with its own image (an SEO image or an image field) is skipped.
- **Hourly**: the `social-images` task makes up to 10 waiting images per run (5 minutes at most).
- **Generate for existing entries** on the page: queues every published entry without its own image, then makes their images while the page is open (the hourly task continues if you leave).
- **Make again** on an image redraws it.

An image is redrawn only when what it shows changes: its file name has a hash of the title, the site's name, the logo and the template. The previous image is kept until the one after it is made (pages still in the edge cache may point to it), then deleted. When an entry gets a new image, its page is cleared from the edge cache.

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

## Notes

- The generated image is used only when the page has no image of its own (`page.image` or the SEO image). It replaces the site's default OG image for those pages.
- The tags include the image's size, type and alt (the entry's title), with or without Schema & Social's Open Graph extras; `twitter:card` becomes `summary_large_image`. With the Schema.org graph on, the image is the page's primary image there too.
- Images aren't removed when an entry is unpublished or deleted; they're small, and backups keep them consistent.

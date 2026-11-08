# Migrating from WordPress

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

The **WordPress import** module (**Plugins → WordPress import**, off until you turn it on under **Plugins → Coywolf Pack**) finishes a move from any WordPress site to EmDash. EmDash's own importer (**Settings → Import**) brings over posts, pages, custom post types, categories, tags, authors and media, but it has no plugin hook, and it drops or misses some things every WordPress site has. The module covers them with three parts:

- a **prepare** step that rewrites the export (WXR) before EmDash imports it, so what EmDash would drop survives as marker HTML blocks;
- a **converter** that runs on every save while the module is on (including each entry the importer creates) and turns those markers into native blocks, plus **Convert imported content** for entries already on the site;
- **tools for after the import**: co-author and guest-author bylines, category and page parents, old `/wp-content/` URLs, and redirects.

Sites that used Coywolf's WordPress plugins (Video Manager, Coywolf SEO, Custom Blocks, Coywolf Files, Guest Author) get more: see [Coywolf WordPress plugins](#coywolf-wordpress-plugins).

## What EmDash's importer misses, and what closes the gap

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
| Category parents and page parents (`/{parent}/{child}/` URLs) | Every category is top level; pages lose their parent | Step 4, **Category and page parents**, with `{termpath:category}` and `{pagepath}` in [Content URLs](content-urls.md) |
| `/wp-content/` URLs EmDash's URL rewrite misses: other blocks' fields (a testimonial photo, a video poster or caption track), `-scaled`, `-rotated` and image-editor copies of large images, files that were never media-library attachments, theme and plugin files (since EmDash 1.2.0 its rewrite also covers HTML blocks, embeds, links in text and tables, file and button blocks, covers, and `-1024x683` size variants of attachments) | Still point at the old site, and break when it goes away | Step 5, **Old-site media URLs**: matches, imports, rewrites and redirects them |
| Old slugs (`_wp_old_slug`, which WordPress redirects by itself) and redirect plugins' rules (Redirection, Rank Math, Yoast SEO Premium, Coywolf SEO) | Not in the export | Step 6, **Redirects from WordPress** |
| `/wp-content/uploads/` URLs that other sites and image search link to | 404 | Step 5 adds a redirect for every old file URL it matched |
| Image width and height | Not recorded on imported image blocks | Theme: `imageDimensions(srcs)` from `@coywolf/emdash/astro` (see [In theme code](images.md#in-theme-code)) |
| Shortcodes, widgets, menus, theme settings, forms | Shortcodes stay as plain text; the rest isn't content | Rebuild by hand (see [Gaps to close by hand](#gaps-to-close-by-hand)) |

## Before you import

Set the site up first, so imported content comes over connected:

1. Install EmDash and Coywolf Pack ([Getting started](../README.md#getting-started)) and deploy. Set `EMDASH_ENCRYPTION_KEY` so the site can store API keys.
2. Add API keys and tokens before importing, under **Plugins → Coywolf Pack → Settings** or on each module's page (for example the Stream API token on Videos, the AI Enrichment key, the Cloudflare API token for Clean Image URLs). Modules that read content as it's saved then work on imported entries right away.
3. Turn on, under **Plugins → Coywolf Pack**: **WordPress import**; **Headings & TOC** with **Heading anchors**; **Custom Blocks** with the **Details** block; **Redirects** (and add its middleware, see [Redirects](redirects.md)); **Code Blocks** if the site has code. Coywolf plugin users turn on more (see below).
4. Set `urls` in `coywolfPlugin()` to the permalink structure WordPress used (for example `posts: "/{termpath:category|uncategorized}/{slug}/"` for `/%category%/%postname%/`), so links, sitemaps and redirects use the same URLs. See [Content URLs](content-urls.md).
5. Keep the WordPress site online until you finish: EmDash imports media from it, and step 5 downloads files that weren't in its media library. Back up the EmDash site before converting (see [Backups](backups.md)).

## Step by step

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

## Prepare and convert

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

## Co-authors and guest authors

EmDash's importer credits each post to its WordPress user (`dc:creator`) and nothing else. **Co-authors and guest authors** (step 3) reads, from the export:

- **Co-Authors Plus**: the post's `author` terms (`cap-<login>`), with users' display names from the export's authors and guest authors' profiles from their `guest-author` entries (display name, website, bio, avatar);
- **PublishPress Authors**: the post's `author` terms, with profiles from term meta (`user_url`, `description`, `avatar`);
- **Coywolf Guest Author**: the guest in post meta (`_guest_author`, `_guest_author_url`, `_guest_author_bio`, `_guest_author_avatar_id`), which replaced the byline.

A post whose only author is its own WordPress user is left alone. Then, from your browser with EmDash's own byline and content API, as you:

1. **Dry run** looks up, for each author, a byline with the same name (the importer creates one per WordPress user), the avatar in the media library (by file name; present when the importer imported the attachments), and each imported post (by its WordPress slug) with its current bylines.
2. **Create bylines and credit posts** creates a guest byline (name, website, bio as plain text, avatar) for each author who has none, and sets each post's bylines to its authors in WordPress's order. Posts already credited are skipped. You need permission to manage bylines and edit any entry.

Schema & Social's author and Review schema then name the authors. What stays manual: an avatar that isn't in the media library (upload it, then pick it on the byline under **Bylines**); a post whose slug changed on import ("Not found" in the dry run; credit it in the editor).

## Category and page parents

EmDash's importer creates every category at the top level and drops each page's parent, so WordPress URLs with parent categories (`/news/local/a-post/`) or parent pages (`/about/team/`) are lost. **Category and page parents** (step 4) puts them back, from your browser:

1. It reads the categories (`<wp:category>` with `<wp:category_parent>`) and pages (`<wp:post_parent>`) from the export.
2. **Dry run** lists each category that had a parent in WordPress with its parent on the site now: "Set to …", "Change to …", "Already set", or why it can't be set.
3. **Set category parents** sets them through EmDash's own taxonomy API (`PUT /_emdash/api/taxonomies/category/terms/<slug>`), as you, parents first. You need permission to manage taxonomies.

EmDash pages have no parent, so the step shows a ready-to-paste `pageParents` option for `coywolfPlugin()` instead (use it with `{pagepath}`, see [Content URLs](content-urls.md)). `node scripts/wp-prepare.mjs` prints the same option, plus a `termParents` option you can use until the category parents are set.

## Old-site media URLs

EmDash's importer imports attachments into the media library and rewrites their URLs in image, gallery, column and cover blocks, file and button blocks, embeds and HTML blocks, and links in text and tables (EmDash 1.2.0+), including `-1024x683` size variants of an attachment. **Old-site media URLs** (step 5) handles every other `/wp-content/uploads/`, `/wp-content/themes/` and `/wp-content/plugins/` URL of the old site:

1. **Find old URLs** searches every entry (its latest draft included) for URLs on the old site's host names (filled in from the export; add a CDN host if media was served from one), protocol-relative and site-relative ones, URLs through Jetpack's image CDN (`i0.wp.com/<host>/…`), and URLs under the folder WordPress was installed in. It then reads the media library.
2. Each URL is matched to a media library file. Size variants (`photo-1024x683.jpg`), `-scaled` and `-rotated` copies and image-editor copies (`photo-e1589912345678.jpg`) match the file imported from their original attachment, found through the export's attachment URLs (folder and name, so two `logo.png` in different months don't mix). A URL that wasn't an attachment, and theme and plugin files, are **not in the media library**; several media files with the same name are **ambiguous** (fix those in the editor). Attachments not used in content are included too, for redirects.
3. **Import missing files** downloads those files from the old site into the media library with EmDash's own media importer (`POST /_emdash/api/import/wordpress/media`, which blocks private addresses and reuses a file with the same bytes, so running it again adds nothing). It needs the old site online and permission to import.
4. **Rewrite URLs in content** → **Dry run**, then **Rewrite URLs** points every matched URL at its media file (`/_emdash/api/media/file/<key>`) in every entry's Portable Text (HTML blocks, links, text, and other blocks' fields) and text fields. Image and file fields are left to EmDash's rewrite. It runs the converter too.
5. **Add to Redirects** adds a 301 from each old file path to its media file (the Redirects module handles file paths, which EmDash's built-in redirects skip), or **Download JSON** to import on the Redirects page.

Without the export loaded, uploads match by file name alone and unused attachments get no redirect. If the old site is already offline, upload the missing files under **Media** and fix the entries the URL table lists by hand.

## Redirects from WordPress

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

## Gaps to close by hand

- **Blocks EmDash drops**: the prepare report lists them by block name. Rebuild each (a pack block, an embed, or HTML) in the entries that used it.
- **Image width and height**: imported image blocks have no size. In the theme, get sizes from the media library with `imageDimensions(srcs)` (one query per page), and set `width`/`height` (and `srcset`) on content images.
- **Shortcodes** stay as plain text (`[gallery …]`). Search content for each shortcode's name and replace it with a block.
- **Forms** (`gravity-form` markers, other form plugins): rebuild with the EmDash forms plugin or the theme.
- **Menus, widgets, theme settings**: not content; rebuild them in the theme and EmDash's menus.
- **Theme assets used by the theme itself** (CSS backgrounds, fonts): step 5 only finds those linked from content. Move the rest into the new theme.

## Verifying the move

1. **Convert imported content → Dry run** lists nothing.
2. **Old-site media URLs → Find old URLs** shows 0 not in the media library and 0 ambiguous, and its **Rewrite URLs** dry run lists nothing.
3. Every old URL still works. List WordPress's published URLs before it goes away, then check each on the new site (replace the host names):

   ```bash
   wp post list --post_type=post,page --post_status=publish --field=url > old-urls.txt
   while read -r url; do
     new="${url/https:\/\/old.coywolf.com/https://coywolf.com}"
     code=$(curl -s -o /dev/null -w '%{http_code}' "$new")
     [ "$code" = 200 ] || echo "$code $new"
   done < old-urls.txt
   ```

   Anything not 200 needs a redirect or a `urls` fix. Run it with `curl -L` to follow redirects and check where they end up.
4. Check a few old media URLs (a size variant and an attachment) with the URL tester on the Redirects page.
5. Run **Link Manager** (if on) for broken internal links.
6. Spot-check entries: heading anchors (`#links`), Details blocks, bylines, category and page URLs, and the Rich Results Test on an article.

## Coywolf WordPress plugins

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
- **Coywolf SEO redirects** go in step 6 (or straight into **Redirects → Import**, see [Redirects](redirects.md)).
- **B. Coywolf Files downloads**: copy each Coywolf Files object into the bucket bound as `FILES` (or `MEDIA`) under the same key (`coywolf-files/YYYY/MM/<id>-<name>`), paste `wp db query "SELECT file_id, object_key, filename, mime, size, downloads, created FROM wp_coywolf_files"`, and set **Files → Settings → Download URL base** to WordPress's link base (`coywolf-file` by default) so old download links keep working. Download counts carry over.
- **C. Video Manager library**: paste the output of `wp option get coywolf_cvm_descriptions --format=json` (and the same for `coywolf_cvm_posters` and `coywolf_cvm_downloads`) for per-video descriptions, posters and MP4 links. On the Videos page, **Refresh** the library (with the token) and **Rebuild embed index**.
- Run the Headings & TOC, Schema and Videos checks on a few entries (Rich Results Test for a review and a video page).

Without a Stream token, converted videos still play and have VideoObject schema: the name, length, upload date and size come from WordPress and are stored as the video's details until Stream's own data replaces them. Captions, plays from Stream, MP4 links found via the API, and the library listing need the token.

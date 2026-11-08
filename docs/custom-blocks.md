# Custom Blocks

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

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

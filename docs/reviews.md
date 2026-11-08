# Reviews

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

The review box Coywolf uses on WordPress (Coywolf Custom Blocks' review block): a rating badge with "4.5 out of 5" under it, then **What I liked most** and **Could be better** lists side by side, stacking on narrow screens. It adds Review schema that Google can read for review snippets and product pros and cons.

- **Coywolf Review block** (slash menu → Content): item name, item type (the types Google accepts for reviews: Product, Software application, Book, Course, Movie, Game, Event, Recipe, Local business, Organization, and a few more), brand, item URL, item image (for schema only), book details (author, ISBN, publisher, genre, copyright year) and software details (operating systems, app category) for schema, rating (0–5 in tenths, e.g. 4.7), the two headings (defaults above), pros and cons (one per line), an optional summary or verdict, and the heading level (H2 by default, like WordPress). It's server-rendered plain HTML with no script. Its CSS is about 2 KB, inlined once per page before the first box, so nothing shifts.
- **Ratings** are picked from a menu of 5.0 down to 0.0 in steps of 0.1 (EmDash's number field only takes whole numbers). The badge and caption show the rating as stored ("4.7 out of 5", "5 out of 5"), and Review schema's `ratingValue` is the same number. Reviews saved before 0.11.0 with half steps keep working; saving the entry stores them in the new format (`"4"` becomes `"4.0"`) so the menu shows them.
- **Reviews page** (**Plugins → Coywolf Pack → Reviews**): the badge's accent color (default `#2C8452`; badge text is white), **Custom CSS**, and a live preview of a sample review, wide or at phone width. The preview runs in a sandboxed frame, so your CSS can't restyle the admin.
- **Accessible**: the box is a `<section>` labeled "Review of <item>". The badge number is hidden from screen readers, which read "Rated 4.5 out of 5" instead. The lists are real headings and lists.

| Feature | Default | What it adds |
| --- | --- | --- |
| `reviews` | off | The block on the site, and the Reviews page |
| `reviews.schema` | off | Review JSON-LD for each review, in Schema & Social's graph when it's on, otherwise one standalone script per review (`page:metadata`, ids `coywolf-review-N`) |

## Customizing the look

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

## Review schema

With Schema & Social's graph on, each review joins the page's `@graph` like videos do. The reviews come from the entry's `coywolf-review` blocks (any Portable Text field), followed by any the theme passes as `page.coywolf.reviews`, de-duplicated by item type and name, up to 20.

- **Products** become a top-level `Product` (`<page>#review-N-item`, with name, `brand` as a `Brand`, url and image). The `Review` (`<page>#review-N`) is nested in it as `review`. Google reads pros and cons (`positiveNotes` / `negativeNotes`, each an `ItemList` of `ListItem`s with position and name) only from a Review nested in a Product, and a nested review needs no `itemReviewed`.
- **Other types** become a top-level `Review` with the item in `itemReviewed`. That's the shape Google's review-snippet docs show, and it avoids validating, say, an Event or SoftwareApplication as its own rich result.
- **Pros and cons** are emitted only for Product reviews with at least two statements in all (Google's minimum); they still show in the box either way.
- **Books and software** get their details on the item: a Book's `author` (Person), `isbn`, `publisher` (Organization), `genre` and `copyrightYear`; a SoftwareApplication's `operatingSystem` and `applicationCategory`.
- **Every review** has a `reviewRating` (`Rating`, `ratingValue`, `bestRating` 5, `worstRating` 0, because the scale starts at 0), the Article's author(s) as `author` (else the publisher), the graph's publisher, the Article's `datePublished`, `mainEntityOfPage` → the WebPage, and the summary as `reviewBody`. The item is added to the Article's (or WebPage's) `about`, alongside AI Enrichment's entities.
- **Not emitted**: reviews without an item name or a rating, and "self-serving" reviews, which Google ignores. Those are an Organization or Local business whose URL is on your own site or whose name is the publisher's.

With the graph off, each review is a standalone JSON-LD script in the same shape. The author is the page's byline name (else the site), and the publisher is the site. Some item types need more properties for their own rich results (an Event's date and location, for example). The block doesn't collect those, so validate important pages in Google's Rich Results Test. Google's product snippets focus on one product per page: several Product reviews on one page are all output, but Google may use only one of them.

## Legacy WordPress reviews

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

`reviewFromAttrs` reduces the `<li>` HTML to plain text (tags dropped, entities decoded) and maps the marker attributes to the block's fields. You can also pass `itemType`, `url`, `image` and `summary` attributes, and the WordPress book (`author`, `isbn`, `publisher`, `genre`, `copyright`) and software (`os`, `category`) fields. To turn imported markers into Coywolf Review blocks instead, see [Migrating from WordPress](wordpress-import.md). `<Review>` isn't gated by the feature switch, because a theme that uses it has opted in, but it uses the Reviews page's accent and custom CSS. Schema still needs `reviews.schema`. Remove any review JSON-LD the theme prints itself.

`reviews: false` leaves the module out.

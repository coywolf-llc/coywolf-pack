# Schema & Social

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

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

## Setup

Nothing to configure beyond the Schema page. The module reads the site database (`DB` by default; set `schema: { database: "MY_DB" }` otherwise) to look up image dimensions and alt text, cached per Worker isolate for 10 minutes. Its settings come with the feature switches' query; its Site Details, types and author properties are cached until a pack settings save (here or in another isolate, see [Database reads](internals.md)) or ten minutes. It needs the `content:read`, `schema:read`, `bylines:read` and `media:read` capabilities, which it declares.

### Pass the entry to save reads

A theme that renders an entry already has it (from `getEmDashEntry()`), with its bylines hydrated by EmDash. Pass it on the page context as `coywolf.entry`, and Schema & Social takes the credited bylines (`entry.data.bylines`) and the entry's blocks (for review schema) from it instead of reading them again: two to five fewer queries per page. It's only used when `entry.data.id` is the page's `content.id`. `coywolf.bylines` (just the credits) works too.

```astro
---
const { entry } = await getEmDashEntry("posts", slug);
const page = { ...createPublicPageContext({ Astro, kind: "content", content: { collection: "posts", id: entry.data.id, slug: entry.id }, /* … */ }), coywolf: { entry } };
---
<EmDashHead page={page} />
```

## Notes

- Page types come from the page context your theme passes to `EmDashHead`: an entry page is matched to its collection through `content`, and `pageType: "article"` is what makes a page an article by default. Pages without `content` use the home page or "other pages" types.
- Derived breadcrumbs name parent segments from the URL (`/health-tips/` → "Health tips"); pass `breadcrumbs` in the page context for exact names.
- A content page costs a few extra database reads per render (the entry override, its bylines, and saved author properties); image lookups and settings are cached.
- **Default bylines: link your byline to your user account under Bylines** (Content → Bylines → your byline → user; that also turns off **Guest**). EmDash then credits every post or page you create without picking a byline to your byline: the editor shows it as **Automatic**, and EmDash's reads (`entry.data.bylines`, `getEntriesBylines`) return it like a picked one, so the article's author schema names you with no change here. EmDash stores no credit for it, so `where: { byline }` (and `getEntriesByByline`) don't list those entries: an author page that should has to add the user's own (`where: { author_id }`) entries credited to the byline, as the Coywolf themes' `src/lib/byline-entries.ts` does. To link from the command line: `node scripts/byline-link-user.mjs --url=https://coywolf.com` (a dry run that finds the site's admin and the byline with their name and lists the entries that will start showing it; `--byline=<slug>` and `--user=<id>` pick others, `--apply` saves, `--purge-cache` then clears the page cache). It uses EmDash's admin API with your `npx emdash login` (or `EMDASH_TOKEN`) and sends the byline's bio, avatar and website back with it, since EmDash's byline save clears them when they're left out.

## Main subject

An override's **Main subject** makes the page's WebPage node point at what the page is about with `mainEntity`, and puts that entity in the graph once:

- **A byline**: the Person from the Authors tab, with the same `@id` it has as an article author, plus its **Profile page only** properties. The entry's own credited bylines are listed first.
- **Site publisher**: the publisher Organization (or Person) from Site details.

For an author's profile page, set the page type to **Profile page**, the article type to **None**, and the main subject to the person:

```json
{ "@type": "ProfilePage", "@id": "https://coywolf.com/jon-henshaw/#webpage", "mainEntity": { "@id": "https://coywolf.com/jon-henshaw/#person" }, "dateCreated": "…", "dateModified": "…" },
{ "@type": "Person", "@id": "https://coywolf.com/jon-henshaw/#person", "name": "Jon Henshaw", "birthDate": "1973-09-09", "…": "…" }
```

A ProfilePage also gets `dateCreated` (the entry's publish date) next to `dateModified`. When the main subject is the publisher, or is also credited as the article's author, it's still one node: the copies are merged. `birthPlace`, `homeLocation` and `workLocation` are output as a `Place` and `nationality` as a `Country` (named by the value).

## Videos in the graph

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

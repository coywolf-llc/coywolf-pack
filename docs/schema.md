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
| `schema.custom` | Your own JSON-LD for a page: an entry (set in its override) or an exact path such as a home page in the site's code, each added as its own JSON-LD, checked for errors and Google's rich-result rules. See [Custom markup](#custom-markup). |

The Schema page has:

- **Site details**: whether the publisher is an Organization or a Person (a byline), and the publisher's properties, picked from the same property list as on WordPress (name, legalName, url, logo, sameAs, address, contactPoint, founder, and so on; logo and image can come from the media library). Anything left empty falls back to EmDash's site title, URL and logo.
- **Types**: the WebPage subtype (AboutPage, ContactPage, CollectionPage…) and Article subtype (BlogPosting, NewsArticle, TechArticle… or none) for the home page, other non-entry pages, and each collection. By default, article pages get a BlogPosting, as with EmDash's own JSON-LD, and everything else a WebPage.
- **Authors**: Person properties per byline. Bylines without saved properties use their name, website (or the author page URL), bio and avatar. Tick **Profile page only** on a property (birthDate, birthPlace, email, gender, nationality…) to output it only on the page whose main subject is that person, not on every article they wrote.
- **Overrides**: for a single entry, a different page or article type, its **main subject** (what the page is about: pick a byline for a profile page, or the site publisher for an About or Contact page; see [Main subject](#main-subject)), and its **custom markup** (see [Custom markup](#custom-markup)).
- **Custom**: custom markup for pages that aren't entries, matched by path (like the home page, `/`).
- **Robots & social**: the search URL template (`/?s={search_term_string}` by default; empty for no SearchAction), the author page URL pattern (empty by default: set it to match your site's author pages, e.g. `/author/{slug}/`, so authors get a `url` and `@id` there; without it, authors without a byline website get no `url` and an `@id` on the site root), the breadcrumb home label, the robots directives (a blank max-snippet or max-video-preview means -1, no limit), and an `og:locale` override (derived from the site locale otherwise, e.g. `en` → `en_US`).
- **Preview**: the tags and JSON-LD the module would add to the home page, a path, or an entry, with the custom markup's rich-result warnings. A path that is a published entry's page is previewed as that page (the entry's override and markup win there), and the preview says so.

## Setup

Nothing to configure beyond the Schema page. The module reads the site database (`DB` by default; set `schema: { database: "MY_DB" }` otherwise) to look up image dimensions and alt text, cached per Worker isolate for 10 minutes. Its settings come with the feature switches' query; its Site Details, types, author properties and custom markup path rules are cached until a pack settings save (here or in another isolate, see [Database reads](internals.md)) or ten minutes. It needs the `content:read`, `schema:read`, `bylines:read` and `media:read` capabilities, which it declares.

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

## Custom markup

With `schema.custom` on, you can add JSON-LD of your own to a page, for anything the graph doesn't describe: a Service, a WebApplication, a Product, an Event, FAQs… It's added the way EmDash adds all JSON-LD: each rule is one `page:metadata` contribution, `{ kind: "jsonld", id: "coywolf-custom:<rule id>", graph }`, which EmDash prints in the head as its own `<script type="application/ld+json">`, escaped so nothing in it can close the element (`<` becomes `<`). EmDash keeps the first contribution for an id, so a theme or another plugin that contributes the same id first replaces the rule. The editor shows each rule's id.

A rule is for what EmDash's page context describes:

- **An entry**: in the entry's override on the **Overrides** tab, next to its page type and main subject (id `coywolf-custom:entry:<collection>:<entry id>`). It follows the entry if its slug changes.
- **A path**: on the **Custom** tab, for pages in the site's code that aren't entries (EmDash's `kind: "custom"` pages), like a hardcoded home page (`/`). The path matches exactly: no wildcards or query strings, and a trailing slash doesn't matter (it's saved the site's way). One enabled rule per path.

An entry's own markup (when it's on) wins over a path rule for the same page. Markup that's turned off is kept but not added.

### Writing it

Paste one node, an array of nodes, or `{ "@graph": [ … ] }`. `@context` is optional (only `https://schema.org` is accepted; it's added for you). **Start from a template** inserts a starting point: Service, WebApplication, Product, FAQ page, Event, Organization or Person.

- **Relative ids and URLs** resolve against the page's URL, as in any JSON-LD: on recollect.fyi's home page, `"@id": "#app"` is `https://recollect.fyi/#app` and `"url": "/pricing/"` is `https://recollect.fyi/pricing/`. A root-relative path is the site's origin plus the path exactly as written (nothing is percent-encoded for you, so a `urlTemplate` like `/search/{search_term_string}/` keeps its placeholder). References to the pack's site-level ids (`#website`, `#organization`, `#publisher`, `#person`, `#person-<slug>`) resolve against the site root on every page. In an entry's override, the editor resolves them against the entry's URL, as the page will.
- **Linking to the pack's nodes** (with `schema.graph` on): `{"@id": "#organization"}` (or `#publisher`) is the publisher from Site details, whatever its `@id`; `#website`, `#webpage`, `#primaryimage`, `#breadcrumb` and `#article` are the graph's nodes for the page, `#author` the article's first author, and `#person-<slug>` an author credited on it. They resolve to the graph's real ids. A nested copy of one of them becomes a reference to it.
- **Main entity of the page**: the page's WebPage points at the rule's first node with `mainEntity` (the node gets `<page URL>#<type>` as its `@id` when it has none, like `https://recollect.fyi/#service`). It replaces an override's main subject, whose node then leaves the graph too, unless something else there still points at it (the person is also the article's author, or the subject is the publisher). It needs `schema.graph`: with the graph off there's no WebPage to point from, so it's skipped.

For example, the recollect.fyi home page as a Service from the publisher, with its plans:

```json
{
	"@type": "Service",
	"@id": "#service",
	"name": "Recollect",
	"description": "A minimalist, full-featured notes app that's a joy to use.",
	"serviceType": "Notes app",
	"url": "/",
	"provider": { "@id": "#organization" },
	"availableChannel": { "@type": "ServiceChannel", "serviceUrl": "https://app.recollect.fyi/" },
	"offers": [
		{ "@type": "Offer", "name": "Free", "price": "0", "priceCurrency": "USD" },
		{ "@type": "Offer", "name": "Premium", "price": "24", "priceCurrency": "USD" }
	]
}
```

With **Main entity** on, the page gets the pack's graph (whose WebPage now has `"mainEntity": { "@id": "https://recollect.fyi/#service" }`) and, as its own JSON-LD:

```json
{ "@context": "https://schema.org", "@type": "Service", "@id": "https://recollect.fyi/#service", "name": "Recollect", "…": "…", "url": "https://recollect.fyi/", "provider": { "@id": "https://recollect.fyi/#organization" } }
```

A WebApplication is written the same way (the template has `applicationCategory`, `operatingSystem`, `creator: {"@id": "#organization"}` and an offer). Google shows app rich results only with real ratings or reviews (`aggregateRating` or `review`): don't add ratings you don't have. Without them the markup is still valid schema.org, or describe the app as a Service.

### Checks

A save is refused (the editor shows why before you save, and the save routes check again) for invalid JSON; anything but an object, an array or `@graph`; a node without a `@type`; an `@context` other than schema.org; a `__proto__`, `constructor` or `prototype` key (not schema.org properties, and they could make a copied node look typed); more than 32 KB or 50 nodes; redefining one of the pack's own nodes (`{"@type": "Organization", "@id": "#organization", "name": "…"}`; a reference with only `@id`, and `@type`, is fine); and a path with a query string, `#anchor` or wildcard, or another enabled rule on the same path.

Warnings never stop a save. They follow Google's rich-result rules (in `src/schema/custom-lint.ts`, one table per type):

- Required and recommended properties for SoftwareApplication (and WebApplication, MobileApplication), Product, Offer, AggregateOffer, PriceSpecification, AggregateRating, Rating, Review, FAQPage, Question, Answer, BreadcrumbList, Event, Course, Organization, Person, Service, ImageObject and VideoObject.
- Values: prices are plain numbers (`9.99`, not `$9.99`), currencies ISO 4217 (`USD`), ratings within `worstRating`–`bestRating` (1–5 by default) with a `ratingCount` or `reviewCount` above 0, ISO 8601 dates, URLs, breadcrumb positions, and Google's values for `availability`, `eventStatus`, `eventAttendanceMode` and `applicationCategory`.
- Empty values (`"screenshot": [{}]`), nested objects without a `@type` (an `offers` object without `"@type": "Offer"`), schema.org names in the wrong case (`pricecurrency` for `priceCurrency`), and, with the graph on, a second WebSite or WebPage.

They show in the editor and on the **Preview** tab. Check the live page with Google's Rich Results Test too.

### Storage and routes

- Path rules: plugin storage `schemaDocs`, doc `custom`: `{ "rules": [{ "id", "label", "path", "enabled", "mainEntity", "markup", "updatedAt" }] }`, where `markup` is the JSON-LD as text. They're read with the module's other docs (no extra query) and parsed once per isolate.
- Entry markup: the entry's override (`schemaEntries`, doc `<collection>:<entry id>`), as `"custom": { "markup", "enabled", "mainEntity" }`, read with the override (with the graph off, that's one read per entry page while Custom markup is on).
- `POST /_emdash/api/plugins/coywolf-pack/schema/custom/save` with `{ "rule": { "id"?, "label"?, "path", "enabled"?, "mainEntity"?, "markup" } }` saves a path rule (`markup` as text, or the JSON itself; without an `id`, one is made up; an unknown `id` adds a rule with that id). It answers `{ rule, rules, warnings }`, or 400 with the errors. `schema/custom/delete` with `{ "id" }` removes one. Both write the rules doc only if it's still the version they read (EmDash's `compareAndSet`; read and changed again otherwise, 409 after four tries), so two admins saving at once can't lose each other's rule. `schema/entries/save` takes `"custom": { "markup", "enabled", "mainEntity" }` for an entry (`null` removes it; left out, it's kept). Saves need `plugins:manage`, and clear the page cache like every pack settings save. The reads behind the page (`schema/preview`, which answers `entry: { collection, id }` when a previewed path is an entry's page; `schema/entries/find`; `schema/entries/bylines`, which also answers the entry's `url`; `schema/media`) are read-only routes: they clear nothing (see [Internals](internals.md#database-reads)).

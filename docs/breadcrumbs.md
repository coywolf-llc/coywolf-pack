# Breadcrumb Nav

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

An accessible breadcrumb trail (`<nav aria-label="Breadcrumb">` around an `<ol>`, `aria-current="page"` on the current page, separators in CSS that screen readers skip), as a component for theme layouts and as a **Breadcrumbs** block for content. Off until you turn it on on the **Features** page (**Coywolf Pack → Features** in the sidebar):

| Feature | Default | What it does |
| --- | --- | --- |
| `breadcrumbs` | off | Main switch: the `Breadcrumbs` component, the **Breadcrumbs** block, and the **Breadcrumb Nav** page |

Until 0.6.0 this was the `headings.breadcrumbs` sub-feature of Headings & TOC. Sites keep their state: while `breadcrumbs` has never been saved, it follows the stored `headings.breadcrumbs` switch (on only if Headings & TOC was on too), and the settings fall back to the breadcrumb defaults stored with Headings & TOC until the Breadcrumb Nav page saves its own. The block type (`coywolf-breadcrumbs`), the `Breadcrumbs` export and the stored block data are unchanged, and Breadcrumb Nav no longer depends on Headings & TOC being on.

Site defaults live on **Breadcrumb Nav** (with a live preview): separator (`/`, `›`, `»`, `•`, `→`, `>`, or a custom string of up to 8 characters), home label, and whether the trail starts with the home page and ends with the current page. The page also has a step-by-step guide for adding the component to a theme, with copyable code.

## Setup

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

## Styling

Classes: `.cw-breadcrumbs` (the `<nav>`, plus `.cw-breadcrumbs--sep-<preset>`), `.cw-breadcrumbs__list` (the `<ol>`, a wrapping flex row), `.cw-breadcrumbs__item` (each `<li>`; the separator is its `::before`), `.cw-breadcrumbs__current` (the current page). The separator is the `--cw-bc-sep` custom property (a CSS string). Links use the theme's colors. The component's rules are single-class, so a selector like `.site-header .cw-breadcrumbs a { … }` overrides them regardless of stylesheet order.

## Notes

- Server-rendered with no script; the small global stylesheet (`cw-` classes only) is bundled on pages that import the component, even with the feature off.
- A trail of one crumb (just Home, or just the page) isn't shown.
- The Breadcrumbs block picks up the theme's trail only when the theme renders `<EmDashHead page={page} />` with the page's real `url`; it's matched by path and query string, so locales and variants don't mix.
- The module's `content:beforeSave` hook only writes `_title` on Breadcrumbs blocks (it declares the `content:write` capability EmDash requires for the hook).

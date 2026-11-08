# Headings & TOC

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Ported from Coywolf SEO. Off until you turn it on under **Plugins → Coywolf Pack**:

| Feature | Default | What it does |
| --- | --- | --- |
| `headings` | off | Main switch |
| `headings.anchors` | off | Every H2–H6 gets an id like `jump-pricing`, plus an optional "copy link to section" button on hover and focus |
| `headings.toc` | off | **Table of Contents** block: title (shown or hidden, and its heading level, H2 by default, for always-open tables), heading levels (any of H2–H6), plain/bulleted/numbered (1, 1.1, 1.1.1), always open or collapsible (open or collapsed) |

Site defaults live on **Headings & TOC**: id prefix, copy link, scroll offset for sticky headers (px or rem), and TOC defaults (title, show title, levels, style, display, minimum headings, smooth scrolling). Breadcrumbs moved to their own module, [Breadcrumb Nav](breadcrumbs.md), in 0.6.0.

Anchors are written into the content when it's saved (an `anchor` field on each heading block), so they're unique within the entry and stay the same when a heading is reworded. A Table of Contents block stores the entry's heading list the same way, so the table always matches the anchors. After turning the features on, re-save an entry to stamp it; until then headings get ids from their text when the page renders.

## Setup

EmDash lets plugins add block types but not change how headings render, so the theme passes the pack's heading renderer to `PortableText` (one line, wherever content is rendered):

```astro
---
import { PortableText } from "emdash/ui";
import { portableTextComponents } from "@coywolf/emdash/astro";
---
<PortableText value={entry.data.content} components={portableTextComponents} />
```

If you already pass components, merge them: `components={{ ...portableTextComponents, type: myTypes }}`. With the anchors and TOC features off, headings render exactly as before.

## Notes

- Output is server-rendered. Collapsing uses `<details>`, smooth scrolling is CSS (and is skipped for visitors who prefer reduced motion), and the only script is a small inline one for the copy-link button, sent only when that option is on.
- Markup follows Coywolf SEO's accessibility rules: the TOC is a labeled `<nav>` (its title is never a heading inside `<summary>`).
- The module declares the `content:write` capability (EmDash only registers a `content:beforeSave` hook for plugins that have it; the hook changes nothing but heading anchors and the TOC block's stored data) and `content:read`. Anchors are kept across edits by matching block keys (then heading text) against the stored entry. When an entry has unpublished draft revisions, anchors of headings added in an earlier draft are matched by text.
- Styles use `cw-` classes and the theme's colors, in light and dark mode.
- With the features off, markup is unchanged, but the components' small global stylesheet (`cw-` classes only) is still bundled on pages that import them.

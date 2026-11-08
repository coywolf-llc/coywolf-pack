# Code Blocks

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

A port of Coywolf Code Block Enhancer. It replaces the site renderer for EmDash's built-in code block (the editor's language picker is unchanged) with one that highlights code **on the server** using highlight.js grammars (via lowlight, which EmDash already ships). Visitors download no highlighting script.

- **Themes** (**Plugins → Code Blocks**, with a live preview): Coywolf Auto (light/dark by system), Coywolf Always light, Coywolf Always dark, four light/dark pairs that follow the system setting (GitHub, Atom One, A11y, Tokyo Night), and 19 popular highlight.js themes (GitHub, GitHub Dark, Monokai, Nord, Dracula, Solarized, Visual Studio, Xcode, Night Owl and more). The theme is the `codeBlocksTheme` setting. Every theme meets WCAG AA contrast (4.5:1): highlight.js colors below that against their theme's background (comments in most themes, Rosé Pine's body text) are darkened or lightened, keeping their hue, and line numbers and the language label use muted colors that still pass (the faded text they always had, raised only where that fell under 4.5:1).
- **Language label**, **Copy button** and **Line numbers** are sub-features. The copy button follows the WordPress plugin's accessible pattern: a labeled button, a polite live region that announces "Copied to clipboard", a two-second confirmation, and no animation for visitors who prefer reduced motion. Line numbers are drawn with CSS, so they're never selected or copied. The header shows the language on the left (file names aren't shown) with the copy button on the right.
- **Page weight**: the layout CSS (about 2 KB), the active theme's CSS (1–4 KB) and, with the copy button on, one small inline script (under 1 KB) are inlined once per page by the first code block. Pages without code blocks get nothing, and no external requests are made.

Feature switches: `codeBlocks` (main), `codeBlocks.label`, `codeBlocks.copy`, `codeBlocks.lineNumbers`, all off by default. While `codeBlocks` is off, code blocks render exactly as EmDash's built-in renderer does.

## Setup

Nothing beyond the plugin itself: the block renderer is registered through the plugin's `componentsEntry`, so it applies wherever the site renders Portable Text with EmDash's `<PortableText>`. It reads the theme and switches from the site's D1 database (`DB`), cached for five minutes per Worker isolate (a save on the Code Blocks page applies at once in that isolate; see [Database reads](internals.md)).

## Notes

- Languages: Prism names used by Code Block Enhancer for WordPress work too (`markup` is HTML, `svg` and `mathml` are XML). EmDash's editor list (Astro, Svelte and Vue are highlighted as HTML, MDX as Markdown, TOML as INI) plus highlight.js's common grammars. Unknown languages, blocks over 30,000 characters and blocks with any line over 2,000 characters are shown as plain text (highlight.js slows sharply on long lines). Rendered blocks are cached in memory (200 per Worker isolate), so repeat page views don't re-highlight.
- Theme CSS is generated from highlight.js's own stylesheets (BSD-3-Clause, each theme's original credits kept) by `node scripts/gen-code-themes.mjs`.
- Tests: `node --import ./test/ts-resolve.mjs --test src/codeBlocks/render.test.ts`.

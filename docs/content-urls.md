# Content URLs

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Several modules link to entries: llms.txt, the news sitemap and the RSS feed, per-entry Markdown, the video sitemap, Schema previews, search results, and removed-content redirects. By default they resolve an entry's URL the way EmDash does, from the collection's URL pattern (`{slug}`, `{id}`, and date tokens such as `{year}`). If your theme routes a collection differently, tell the pack with `urls`:

```js
// coywolf.com serves posts under their category path, as WordPress did (/news/seo/<slug>/)
coywolfPlugin({
  urls: { posts: "/{termpath:category|uncategorized}/{slug}/" },
});
```

Patterns take EmDash's tokens plus taxonomy tokens:

- `{term:<taxonomy>}` is the slug of the entry's first term in that taxonomy, in the order EmDash's `getTermsForEntries` returns them (by label).
- `{term:<taxonomy>|<fallback>}` uses `<fallback>` when the entry has no term. Without a fallback, an entry with no term has no URL.
- `{category}` is shorthand for `{term:category|uncategorized}`.
- `{termpath:<taxonomy>}` (and `{termpath:<taxonomy>|<fallback>}`) is the same term with its parent terms in front, root first, like WordPress's `%category%` permalink: `news/seo` for SEO under News, `guides/method-seo/structure` three levels down. A term with no parent is just its slug. Parents come from EmDash's categories (the parent set under **Taxonomies**), read once per request or build. Chains stop at a loop or after 32 levels.
- `{pagepath}` is the entry's slug with its parent pages' slugs in front (`apps/coywolf-seo`). EmDash entries have no parent field, so the parents come from the `pageParents` option (slug → parent slug). An entry with no parent is just its slug.

```js
// coywolf.com: WordPress's /%category%/%postname%/ with the full category path, and nested pages
coywolfPlugin({
  urls: {
    posts: "/{termpath:category|uncategorized}/{slug}/",
    pages: "/{pagepath}/",
  },
  pageParents: { "coywolf-seo": "apps", "coywolf-files": "apps" },
  // Optional: parents for categories that have none in EmDash yet (e.g. right after a WordPress import).
  termParents: { category: { seo: "news", "method-seo": "guides", structure: "method-seo" } },
});
```

`termParents` (taxonomy → term slug → parent slug) is a fallback: it's used only for terms that have no parent in EmDash, so once the parents are restored (see [Migrating from WordPress](wordpress-import.md), "Category and page parents") it can go.

Collections without an override keep EmDash's resolution. The pack also maps paths back to entries (for example, the Markdown source at `/news/seo/some-post/index.html.md` resolves only when `news/seo` is the post's primary category path), so a wrong category doesn't match. With `{termpath:…}` the whole path must match: `/news/seo/some-post/` resolves, `/seo/some-post/` doesn't (the theme should redirect it, as WordPress did). With `{pagepath}`, a page under a parent resolves only at its full path.

Trailing slashes follow Astro's `trailingSlash` setting. With the default (`"ignore"`), an override keeps the pattern's own trailing slash. Set `trailingSlash: "always" | "never"` on `coywolfPlugin()` to force one for every entry URL the pack builds. Override URLs get no locale prefix.

The options are read when the Worker starts (EmDash creates the plugin then), so the middleware and Astro components use them too. Sites can resolve URLs the same way with `entryUrl`, `entryUrls`, and `matchEntryPath` from `@coywolf/emdash/astro`.

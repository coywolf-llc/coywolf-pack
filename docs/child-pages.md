# Child Pages

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Add a page, choose its parent in the page editor, and the page's URL nests under the parent's: **Coywolf Pack** under **Coywolf apps** is `https://coywolf.com/apps/coywolf-pack/`. EmDash has no page hierarchy of its own, so the pack adds a **Parent page** field (EmDash's own reference field, with EmDash's picker) and builds every URL it makes from it: sitemaps, breadcrumbs, the Schema.org graph, search results, feeds, llms.txt and redirects.

Off until you turn it on on the **Features** page (**Coywolf Pack → Features** in the sidebar):

| Feature | Default | What it does |
| --- | --- | --- |
| `childPages` | off | Main switch: nested URLs from the Parent page field, the **Child Pages** page, the editor's **Child pages** panel and the pages list's **Parent** column |

Child Pages needs **Redirect Manager** and its **Slug changes** part on: they add the 301 when a page moves, and Child Pages adds one for every page below it. The Features page says so while either is off.

## What you get

- **A Parent page field** in the page editor, below the page's other fields, with EmDash's picker: search for a page, pick it, publish.
- **Nested URLs**: the parent pages' slugs in front of the page's (`/apps/coywolf-pack/`), as deep as you like.
- **Redirects when pages move**: give a page a new parent or a new slug and Slug changes adds the 301 from its old URL; every published page below it gets one too (at most 200 a change).
- **Breadcrumbs with real titles**: a trail derived from the URL names the parents by their titles (**Home › Coywolf apps › Coywolf Pack**) in the Breadcrumb Nav component and block, and in the schema's BreadcrumbList.
- **A Child pages panel** in the editor: the page's URL, its parent and the pages under it, a parent waiting to be published, and anything to fix.
- **A Parent column** in the pages list.
- **The Child Pages page**: set up the field, see the page tree, and import the parents from the `pageParents` option.

## Set it up

1. Turn on **Redirect Manager** and its **Slug changes** part, if they aren't on yet:
   1. Open **Coywolf Pack → Features**.
   2. Turn on **Redirect Manager**, then **Slug changes** under it.
   3. Click **Save**.
2. Turn on **Child Pages** on the same page, then click **Save**. Nothing changes for visitors yet.
3. Add the Parent page field:
   1. Open **Child Pages** (in the sidebar, under **Content Tools**).
   2. Under **Set up**, click **Set up** next to **Pages**.
   3. Click **Add the field** to confirm. The field shows in the page editor at once, and under **Content Types → Pages** like any other field.
4. Update your theme so it serves the nested URLs (next section). Until it does, a page with a parent has a URL your theme doesn't answer.
5. Choose a parent:
   1. Open a page in the editor.
   2. Under **Parent page**, click **Add reference** and pick the parent page.
   3. Click **Publish**. The page moves to its new URL, and its old URL redirects there.

Plugins can't add fields themselves, so **Set up** asks EmDash's schema API to add it, with your account (you need to be an administrator). It's a plain EmDash reference field named `parent_page` that holds one page.

## Your theme

EmDash's own routing doesn't know about parents, so the theme's catch-all route has to look pages up by their whole path. The pack gives it three helpers from `@coywolf/emdash/astro`:

- `loadPageTree(db?, { collection? })`: every page of a collection ("pages" unless you say otherwise) with its URL, read once per request. `db` is the D1 binding or its name (default `DB`).
- `resolvePagePath(tree, segments, { search })`: the page a path names. It answers `{ page, path }` when the path is the page's URL, `{ redirect }` when it's the flat, one-segment form of a nested page (`/coywolf-pack/` → `/apps/coywolf-pack/`, with the query string kept), and `null` for anything else.
- `nestMenuUrls(menu, tree)`: EmDash's menus with nested page URLs.

The tree has what a page template needs:

| Method | Gives |
| --- | --- |
| `tree.path(slug)` | The page's URL (`/apps/coywolf-pack/`) |
| `tree.trail(slug)` | Its ancestors, root first, each `{ slug, url, id, title }` (a `pageParents` parent that isn't a page, like a category, has no id or title) |
| `tree.children(slug)` | The published pages directly under it, by title |
| `tree.cacheTags(slug)` | The ancestors' entry ids, for the page's cache tags |
| `tree.get(slug)`, `tree.byId(id)` | One page, or null |
| `tree.pages` | Every published page, by title |

### coywolf.com's catch-all route

coywolf.com's `src/pages/[...path].astro` serves pages, posts and category archives. Categories win over pages, and pages over posts. With Child Pages, the page part becomes:

```astro
---
import { loadPageTree, resolvePagePath } from "@coywolf/emdash/astro";
// …
// The page this path names, or the nested URL of a flat one (EmDash's View and preview links).
const tree = entryUrl ? await loadPageTree() : null;
const pageMatch = tree ? resolvePagePath(tree, segments, { search: Astro.url.search }) : null;
const pageLookup = pageMatch && "page" in pageMatch ? checked(getEmDashEntry("pages", pageMatch.page.slug)) : null;
// …
} else if (!paged) {
	if (pageMatch && "redirect" in pageMatch) return Astro.redirect(pageMatch.redirect, 301);
	if (pageLookup && pageMatch && "page" in pageMatch) {
		const { entry, cacheHint } = await pageLookup;
		if (entry) {
			// The parents' ids too: a parent's new slug or new parent clears the pages below it.
			if (Astro.cache?.enabled) Astro.cache.set({ ...cacheHint, tags: [...(cacheHint.tags ?? []), ...tree.cacheTags(entry.id)] });
			view = { kind: "page", entry, path: pageMatch.path };
		}
	}
	// …posts as before
}
---
```

`entry.id` is the page's slug in EmDash's query results, which is what the tree's methods take. The redirect keeps the query string, so EmDash's preview links (`/coywolf-pack/?_preview=…`) still open the preview.

### coywolf.com's page template

`src/components/views/PageView.astro` builds the page's breadcrumbs from the tree, with the parents' titles:

```astro
---
import { Breadcrumbs, loadPageTree } from "@coywolf/emdash/astro";
// …
const ancestors = (await loadPageTree()).trail(page.id).map((a) => ({ name: a.title ?? a.slug, url: a.url }));
const breadcrumbs = [{ name: SITE_NAME, url: "/" }, ...ancestors, { name: page.data.title, url: path }];
---
```

`loadPageTree()` is read once per request, so the route and the template share one read.

### Menus

A menu item that links to a page gets its URL from EmDash, which builds it without the parents (`/coywolf-pack/`). The flat URL still works (it redirects), but nest it to save the redirect:

```astro
---
import { getMenu } from "emdash";
import { loadPageTree, nestMenuUrls } from "@coywolf/emdash/astro";

const menu = nestMenuUrls(await getMenu("primary"), await loadPageTree());
---
```

Pass `{ origin: "https://coywolf.com" }` as a third argument to nest absolute URLs on the site too.

### Sitemaps and other URLs

The pack's own sitemaps, feeds, llms.txt, search results and redirects already use nested URLs. A theme that builds its own sitemap (coywolf.com does) should take page URLs from `tree.path(slug)` or `entryUrls()` (see [Content URLs](content-urls.md)). EmDash's built-in sitemap doesn't know the parents.

## How parents work

- **One parent per page**, from the same collection. A page can't be under two parents.
- **Slugs stay unique per collection**, as in EmDash: two pages can't share a slug, even under different parents (no `/apps/about/` beside `/about/`).
- **Saved like any other field.** On a published page, a new parent waits in the page's draft until you publish, like your other edits. Publishing puts all of the draft's changes live, the parent with them.
- **Only published parents count.** A page whose parent is unpublished, scheduled, in the trash or deleted is at the top level (`/coywolf-pack/`) until the parent is published again, and its nested URL redirects to the top-level one. A page restored from the trash comes back as a draft, so the pages under it nest again when it's published.
- **No loops.** Publishing a parent that would put the page under itself (itself, or a page below it) is refused, with the chain in the message. A loop that gets in another way (through EmDash's API, or while Child Pages was off) is shown at the top level and flagged on the Child Pages page and in the editor panel.
- **Depth**: as deep as you like (the URL resolver follows 32 levels); pages 8 or more levels deep are flagged.
- **The `pageParents` option still works.** A page's Parent page field wins; the option fills in pages without one, and parents that aren't pages (coywolf.com's `huzzah` page under the `newsletter` category).
- **All-digit slugs** are flagged: a theme that reads `/…/page/2/` as an archive's second page could read a page called `2` that way too. Read the trailing number as a page number only when the rest of the path is an archive.
- **Translations** use the parent page in their own language, or else in the default language. URLs the pack builds have no language prefix (see [Content URLs](content-urls.md)).

## Redirects

With Redirect Manager and Slug changes on:

- **A page that moves** (a new parent, a new slug, a parent that's unpublished or published again) gets a 301 from its old URL, made by Slug changes.
- **Every published page below it** gets one too, made by Child Pages: `/apps/coywolf-pack/docs/` → `/tools/coywolf-pack/docs/` when **Coywolf apps** becomes `/tools/`. At most 200 a change; the Child Pages page says when a change had more.
- **Turning Child Pages off** adds a 301 from each nested URL to the URL the page has without its parent (or with its `pageParents` parent). **Turning it on** adds them the other way, and removes the ones that pointed away from the now-nested URLs.

The rules are Slug changes' own (noted `Slug change: <title>`), listed on the Redirect Manager page. Like Slug changes, Child Pages never changes a rule someone else made: when one of yours sends a page's new URL somewhere else (coywolf.com has `/coywolf-seo` → `/apps/coywolf-seo/` from the WordPress move), that page can't be reached at its new URL, and the Child Pages page lists it so you can fix the rule.

## Import parents from configuration

Sites that listed their parents in `pageParents` (coywolf.com and get.essential.support do) can move them into the field, so they can be changed in the editor:

1. Open **Child Pages**.
2. Under **Import parents from configuration**, click **Dry run**. Each page in `pageParents` is listed with what happens:
   - **Set**: the page gets the parent in its field;
   - **Already set**: the field already names that parent;
   - **Skipped**: no page has the slug, the field names another parent, the parent would make a loop, or the page has unpublished changes (setting the parent publishes the page, and those changes with it: publish or discard them first);
   - **Stays in the option**: the parent isn't a page (a category), so keep it in `pageParents`.
3. Check the URL column: a page the option already nested keeps its URL, so no redirects are made.
4. Click **Set parents**, then confirm. Each page is saved with its parent and published, through EmDash's content API with your account.
5. Remove the pages that were set from `pageParents` in `astro.config.mjs` at your next deploy. Keep the ones that **stay in the option**.

## The editor and the pages list

- **Child pages panel** (in the editor's sidebar, for pages): the page's URL (or the URL it gets once published), its parent, the pages under it, a parent waiting to be published (and whether publishing it will be refused), and warnings: a loop, a parent that isn't published or was deleted, a page 8 or more levels deep, an all-digit slug, and Redirect Manager or Slug changes being off.
- **Parent column** (in the pages list): each page's parent; one that doesn't count for the URL (unpublished, or in a loop) is dimmed. EmDash's list can't indent pages or filter by parent: the Child Pages page's tree does that.

Both show to administrators only, while Child Pages is on, in collections with the Parent page field.

## What EmDash still does on its own

EmDash builds a few page URLs itself, without the parents. They still work, because the theme redirects the flat URL to the nested one:

| Where | What happens |
| --- | --- |
| The editor's **View** link | Opens the flat URL, which redirects; the Child pages panel shows the real one |
| The **Preview** link | The flat URL with the preview token, which the redirect keeps |
| Menus | Flat URLs until the theme uses `nestMenuUrls` |
| EmDash's own slug-change redirect | Built from the collection's pattern; Slug changes deletes it when it adds its own |
| `getPublicUrl()` and `resolveEmDashPath()` | Flat; the pack's URL resolver doesn't use them for nested pages |
| EmDash's built-in sitemap | Flat; ship your own (see above) |

EmDash's MCP content tools can't set reference fields yet; its REST API can (`PUT /_emdash/api/content/pages/<id>` with `{ "references": { "parent_page": ["<parent id>"] } }`, then publish).

## Other collections

**Set up** works for any collection with a URL: entries of a collection get parents from the same collection. While Child Pages is on:

- a collection with the field and no `urls` entry nests by its own URL pattern, with `{pagepath}` for `{slug}` (`/docs/{slug}` becomes `/docs/{pagepath}`);
- a `urls` entry with `{pagepath}` (coywolf.com's `pages: "/{pagepath}/"`) follows the field too;
- a `urls` entry without `{pagepath}` (coywolf.com's posts) wins, so the field doesn't nest that collection: add `{pagepath}` where the slug goes.

## Internals

- The field is EmDash's: a reference field (`parent_page`) on a relation from the collection to itself, one parent each. EmDash keeps the published selection in `_emdash_content_references` by translation group; a selection saved on a page with drafts waits in its draft revision's `_references` until it's published. Contract tests check those tables and keys against each EmDash release (`test/emdash-contract.test.mjs`).
- The tree is one query for the collections and their fields, then one batch for the collection's pages and links, shared by everything that renders a page (the theme's `loadPageTree`, breadcrumbs, the schema graph).
- A plugin setting, `childPagesVersion`, changes whenever a page with the field is published, unpublished, trashed, deleted or restored. It's part of the URL configuration's fingerprint, so live search answers cached with old page URLs aren't served again.
- The publish guard is EmDash's `content:beforePublish` hook. A failure of the pack's own (D1 unavailable) never blocks a publish.
- To find the pages below one that moved, the pack keeps each collection's nested URLs (`state:childPages:paths:<collection>`), and the last change's redirects for the Child Pages page (`state:childPages:lastChange`).

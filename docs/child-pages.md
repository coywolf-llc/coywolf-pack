# Child Pages

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Add a page, choose its parent in the page editor, and the page's URL nests under the parent's: **Coywolf Pack** under **Coywolf apps** is `https://coywolf.com/apps/coywolf-pack/`. EmDash has no page hierarchy of its own, so the pack adds a **Parent page** field (EmDash's own reference field, with EmDash's picker) and builds every URL it makes from it:

- sitemaps;
- breadcrumbs;
- the Schema.org graph;
- search results;
- feeds;
- llms.txt;
- redirects.

Off until you turn it on from the **Features** page (**Coywolf Pack → Features** in the sidebar):

| Feature | Default | What it does |
| --- | --- | --- |
| `childPages` | off | Main switch: nested URLs from the Parent page field, the **Child Pages** page, the editor's **Child pages** panel and the pages list's **Parent** column |

Child Pages needs **Redirect Manager** and its **Slug changes** part on: they add the 301 when a page moves, and Child Pages adds one for every page below it. The Features page says so while either is off.

## What you get

- **A Parent page field** in the page editor, below the page's other fields, with EmDash's picker: search for a page, pick it, publish.
- **Nested URLs**: the parent pages' slugs in front of the page's (`/apps/coywolf-pack/`), as deep as you like.
- **Redirects when pages move**: give a page a new parent or a new slug and Slug changes adds the 301 from its old URL; every published page below it gets one too (200 a change; any more follow with the next change).
- **Breadcrumbs with real titles**: a trail derived from the URL names the parents by their titles (**Home › Coywolf apps › Coywolf Pack**) in the Breadcrumb Nav component and block, and in the schema's BreadcrumbList.
- **A Child pages panel** in the editor: the page's URL, its parent and the pages under it, a parent waiting to be published, and anything to fix.
- **A Parent column** in the pages list.
- **The Child Pages page**:
  - set up the field;
  - see the page tree;
  - import the parents from the `pageParents` option;
  - see the latest redirects, and anything in their way.

## Set it up

1. Turn on **Redirect Manager** and its **Slug changes** part, if they aren't on yet:
   1. Open **Coywolf Pack → Features**.
   2. Turn on **Redirect Manager**, then **Slug changes** under it.
   3. Click **Save**.
2. Turn on **Child Pages** on the same page, then click **Save**. Nothing changes for visitors yet.
3. Add the Parent page field:
   1. Open **Child Pages** (in the sidebar, under **Content Tools**).
   2. Under **Set up**, click **Set up** next to **Pages**.
   3. Click **Add the field** to confirm. The row says **Ready**, and the field shows in the page editor at once, and under **Content Types → Pages** like any other field.
4. Update your theme so it serves the nested URLs (next section). Until it does, a page with a parent has a URL your theme doesn't answer.
5. Choose a parent:
   1. Open a page in the editor.
   2. Under **Parent page**, click **Add reference** and pick the parent page.
   3. Click **Publish**. The page moves to its new URL, and its old URL redirects there.

Plugins can't add fields themselves, so **Set up** asks EmDash's schema API to add it, with your account (you need to be an administrator). It's a plain EmDash reference field named `parent_page` that holds one page.

## Your theme

EmDash's own routing doesn't know about parents, so the theme's catch-all route has to look pages up by their whole path. The pack gives it five helpers from `@coywolf/emdash/astro`:

- `loadPageTree(db?, { collection? })`: every page of a collection ("pages" unless you say otherwise) with its URL, read once per request. `db` is the D1 binding or its name (default `DB`).
- `resolvePagePath(tree, segments, { search, preview })`: the page a path names. Its answers:
  - `{ page, path }` when the path is the page's URL;
  - `{ redirect, page }` when it's the flat, one-segment form of a nested page (`/coywolf-pack/` → `/apps/coywolf-pack/`, with the query string kept);
  - `null` for anything else.
- `previewedEntry()`: the entry EmDash accepted this request's `_preview` token for, as `{ collection, id }`, or `null`. `isPreviewRequest()` is true when there is one.
- `nestMenuUrls(menu, tree)`: EmDash's menus with nested page URLs.

**Drafts stay hidden.** `resolvePagePath` only answers for published pages. A draft or scheduled page gets `null` at its nested path and at its flat one, so neither a page nor a redirect tells a visitor that it exists or where it will be. A route that serves EmDash's previews passes `preview: previewedEntry()`: then the path of the one draft the token was issued for resolves, and EmDash's flat preview link redirects to it with its token. Every other draft still gets `null`, so a preview link for one page doesn't show where another draft will live. `getEmDashEntry` still decides whether the draft's content is shown.

`preview` also takes `true` or `false`. `true` reads the previewed entry from the request, so `preview: isPreviewRequest()` hides other drafts too, and a `_preview` parameter that EmDash didn't accept opens nothing either way.

The tree has what a page template needs:

| Method | Gives |
| --- | --- |
| `tree.path(slug)` | The page's URL (`/apps/coywolf-pack/`) |
| `tree.trail(slug)` | Its ancestors, root first, each `{ slug, url, id, title }` (a `pageParents` parent that isn't a page, like a category, has no id or title) |
| `tree.children(slug)` | The published pages directly under it, by title |
| `tree.cacheTags(slug)` | The entry ids of the pages above it in its URL and of every parent page it has chosen, unpublished ones included, for the page's cache tags |
| `tree.get(slug)`, `tree.byId(id)` | One page, or null. A published page first, else one that isn't: check its `published` before showing it |
| `tree.pages` | Every published page, by title |

**What it costs.** `loadPageTree()` is one D1 round trip for each page that isn't served from the cache: one batch of three small statements (the collections and their fields; each page's id, slug, title and status, with no content; the parent links). The route, the page template, the menus, the pack's breadcrumbs and its schema graph share that one read.

### coywolf.com's catch-all route

coywolf.com's `src/pages/[...path].astro` serves pages, posts and category archives. Categories win over pages, and pages over posts. With Child Pages, the page part becomes:

```astro
---
import { loadPageTree, previewedEntry, resolvePagePath } from "@coywolf/emdash/astro";
// …
// Started with the route's other reads and not waited for yet, so it travels with them. Only for a URL that
// could be a page or a post: the home page, search and their numbered pages never load it.
const treeRead = entryUrl ? loadPageTree() : null;
treeRead?.catch(() => {});
const postLookup = entryUrl && segments.length >= 2 ? checked(getEmDashEntry("posts", slug)) : null;
postLookup?.catch(() => {});
const index = await getCategoryIndex();
// …
} else if (!paged) {
	// Not a category archive: the page this path names, or the nested URL of a flat one (EmDash's View and preview links).
	const tree = await treeRead;
	const pageMatch = tree ? resolvePagePath(tree, segments, { search: Astro.url.search, preview: previewedEntry() }) : null;
	if (tree && pageMatch) {
		// The page's own id and its parents': a new slug or parent, or a parent's publish, clears the page and this redirect.
		const tags = [pageMatch.page.id, ...tree.cacheTags(pageMatch.page.slug)];
		if ("redirect" in pageMatch) {
			if (Astro.cache?.enabled) Astro.cache.set({ tags });
			return Astro.redirect(pageMatch.redirect, 301);
		}
		const { entry, cacheHint } = await checked(getEmDashEntry("pages", pageMatch.page.slug));
		if (entry) {
			if (Astro.cache?.enabled) Astro.cache.set({ ...cacheHint, tags: [...(cacheHint.tags ?? []), ...tags] });
			view = { kind: "page", entry, path: pageMatch.path };
		}
	}
	// …posts as before
}
---
```

- **The tree is loaded only when a page lookup is needed.** A category archive answers before the tree is waited for, and the home page and search never start it. A post's URL does load it (pages win over posts, so the route has to know the path isn't a page's), alongside the post's own lookup rather than before it.
- **The page's entry is read only for a path that is a page's.** The old route read `getEmDashEntry("pages", slug)` for every one-segment URL.
- **The redirect keeps the query string**, so EmDash's preview links (`/coywolf-pack/?_preview=…`) still open the preview.
- **A draft stays a 404** at both of its paths unless EmDash accepted the request's preview token and the token is for that page.
- `entry.id` is the page's slug in EmDash's query results, which is what the tree's methods take.

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

A menu item that links to a page gets its URL from EmDash, which builds it without the parents (`/coywolf-pack/`). The flat URL still works (it redirects), but nest it to save the redirect. A layout that does this loads the tree on every page it renders (the one round trip above), archives and posts included:

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
- **Only published parents count.** A page is at the top level (`/coywolf-pack/`), and its nested URL redirects there, while its parent is any of these:
  - unpublished;
  - scheduled;
  - in the trash;
  - deleted.

  It nests again when the parent is published. A page restored from the trash comes back as a draft, so the pages under it nest again when it's published.
- **No loops.** Publishing a parent that would put the page under itself (itself, or a page below it) is refused, with the chain in the message. A loop that gets in another way (through EmDash's API, or while Child Pages was off) is shown at the top level and flagged on the Child Pages page and in the editor panel.
- **Depth**: as deep as you like (the URL resolver follows 32 levels); pages 8 or more levels deep are flagged.
- **The `pageParents` option still works.** A page's Parent page field wins; the option fills in pages without one, and parents that aren't pages (coywolf.com's `huzzah` page under the `newsletter` category).
- **All-digit slugs** are flagged: a theme that reads `/…/page/2/` as an archive's second page could read a page called `2` that way too. Read the trailing number as a page number only when the rest of the path is an archive.
- **Translations** use the parent page in their own language, or else in the default language. URLs the pack builds have no language prefix (see [Content URLs](content-urls.md)), so a translation can have the same URL as the default-language page. For that reason only default-language pages get redirects when they move, as with Slug changes: a translation's move never writes a rule over the default-language page's URL.

## Redirects

With Redirect Manager and Slug changes on:

- **A page that moves** gets a 301 from its old URL, made by Slug changes. A page moves when:
  - it gets a new parent;
  - it gets a new slug;
  - its parent is unpublished, or published again.
- **Every published page below it** gets one too, made by Child Pages: `/apps/coywolf-pack/docs/` → `/tools/coywolf-pack/docs/` when **Coywolf apps** becomes `/tools/`.
- **Turning Child Pages off** adds a 301 from each nested URL to the URL the page has without its parent (or with its `pageParents` parent). **Turning it on** adds them the other way, and removes the ones that pointed away from the now-nested URLs.
- **The cached pages go too.** Child Pages clears the cached page at each moved page's old and new URL, so the redirect answers at once.

The rules are Slug changes' own (noted `Slug change: <title>`), listed on the Redirect Manager page. The **Redirects** section of the Child Pages page lists the latest changes that moved pages, and anything still open.

### More than 200 pages at once

Child Pages adds at most 200 redirects for one change. When more pages move, the rest wait, in a fixed order (by old URL):

1. Open **Child Pages**. Under **Redirects**, the pages that still wait are listed with their old and new URLs.
2. Click **Re-check redirects**. The next 200 are added.
3. Repeat until none are listed.

You don't have to: the next page you publish, unpublish, trash or restore in the collection adds the next 200 as well.

A page whose redirect would loop (see below) doesn't count toward the 200: the next page in the order takes its place, so loops never keep the other pages waiting.

**Re-check redirects** only goes in the list of latest changes when it added a redirect, so clicking it again doesn't push the real changes out of the list.

### Redirects someone else made

Like Slug changes, Child Pages never changes a rule it didn't make. Two kinds get in the way, and both are listed under **Redirects** with the rule to fix:

- **A loop.** A rule at the page's new URL sends it back to the old one. coywolf.com has `/coywolf-seo` → `/apps/coywolf-seo/` from its WordPress move: if **Coywolf SEO** goes back to `/coywolf-seo/` (its parent is unpublished or trashed, or Child Pages is turned off), a 301 from `/apps/coywolf-seo/` would send readers around in circles. Child Pages doesn't add it, and neither does Slug changes for the page that was edited. To fix it:
  1. Open **Redirect Manager**.
  2. Delete the rule named in the message (`/coywolf-seo` → `/apps/coywolf-seo/`).
  3. Open **Child Pages** and click **Re-check redirects**. The 301 from the old URL is added, and the message goes away.
- **A rule that sends the new URL somewhere else.** The 301 from the old URL is added, but the page can't be reached at its new URL until you delete or change that rule on the Redirect Manager page. The message goes away with the next change, or **Re-check redirects**, once the rule is gone or no page is at that URL anymore.

A rule's target counts as a URL on this site when it's a path (`/apps/coywolf-seo/`) or a full URL on the site's own address, with or without `www.` (`https://coywolf.com/apps/coywolf-seo/`). A full URL on another host, a subdomain included (`https://media.coywolf.com/…`), leaves the site, so it can't be part of a loop.

**What the loop check doesn't see:**

- **Pattern rules.** Only exact rules are followed. A regex rule that sends the new URL back to the old one (`^/coywolf-(.+)$` → `/apps/coywolf-$1/`) isn't noticed, and the 301 is added. If you have pattern rules over the URLs of pages that nest, check them yourself after moving a page or turning Child Pages on or off.
- **Long chains.** The way back is followed through up to 10 rules (`/coywolf-seo` → `/a/` → `/b/` → … → `/apps/coywolf-seo/`). A chain of 11 or more isn't seen.
- **Rules on other systems.** A redirect made outside Redirect Manager (a Cloudflare redirect rule, say) is invisible to the pack.

### After turning Child Pages off

The Child Pages page leaves the sidebar while the feature is off, so anything turning it off left undone shows on the **Features** page, under **Child Pages**:

1. Open **Coywolf Pack → Features**.
2. Under **Child Pages**, read the note. It lists:
   - each loop, with the redirect to delete;
   - each page another redirect sends elsewhere, with the redirect to delete or change;
   - how many pages are over the 200 limit.
3. Delete the redirects it names on the **Redirect Manager** page.
4. Back on **Features**, click **Re-check redirects** under **Child Pages**. Repeat until the note is gone.

**If turning it off didn't finish.** When the database can't be read while the switch is saved, the switch is still saved, but some nested URLs have no redirect yet. The note says "Turning Child Pages off didn't finish", with the error:

1. Open **Coywolf Pack → Features**.
2. Under **Child Pages**, click **Re-check redirects**. It works the redirects out again from the pages' parents and adds the missing ones (`/apps/coywolf-pack/` → `/coywolf-pack/`).
3. If the note stays, read what's left in it and repeat.

The same goes for turning it on: the failed change is listed under **Redirects** on the Child Pages page, and **Re-check redirects** there adds the 301s from the flat URLs.

### When a redirect couldn't be worked out

- **A read failed.** If the database can't be read while a page is published, nothing is redirected from that read (never to a flat URL), the failure is logged, and the change is listed under **Redirects** as one that couldn't be worked out. Visitors aren't affected: pages keep rendering with the parents read last. The next change in the collection, or **Re-check redirects**, makes its redirects.
- **The switches couldn't be read.** A page's save reads the feature switches fresh, so a switch turned on or off a moment ago on another server counts. If that read fails, the save uses the switches the server already had, and a warning is logged: the rest of the pack (cache clearing, Slug changes, search) still runs for the save.
- **No earlier URLs to compare with.** Child Pages keeps each collection's nested URLs to tell what moved. If that record is missing when a page with pages under it changes, the change is listed as having no earlier URLs: the pages it moved got no redirect, and tracking starts again from the current URLs. Add those redirects by hand on the Redirect Manager page if the pages had readers.

## Import parents from configuration

Sites that listed their parents in `pageParents` (coywolf.com and get.essential.support do) can move them into the field, so they can be changed in the editor:

1. Open **Child Pages**.
2. Under **Import parents from configuration**, click **Dry run**. Each page in `pageParents` is listed with what happens:
   - **Set**: the page gets the parent in its field.
   - **Already set**: the field already names that parent.
   - **Skipped**, for one of these reasons:
     - no page has the slug;
     - the field names another parent (even when the option's parent isn't a page: the field is what counts once it's set);
     - the parent would make a loop;
     - the page isn't published (a draft, or scheduled): setting the parent would publish it, so set its **Parent page** in the editor instead;
     - the page has unpublished changes: setting the parent would publish them too, so publish or discard them first.
   - **Stays in the option**: the parent isn't a page (a category) and the page's field is empty, so keep it in `pageParents`.
3. Check the URL column: a page the option already nested keeps its URL, so no redirects are made.
4. Click **Set parents**, then confirm. Each page is saved with its parent and published again, one at a time, through EmDash's content API with your account.
5. Remove the pages that were set from `pageParents` in `astro.config.mjs` at your next deploy.
6. Keep the pages that **stay in the option**. On coywolf.com those are the two pages under the `newsletter` category:
   - `huzzah`, which is already in `pageParents`;
   - `check-your-inbox`, which is missing from it today (only the theme's own list has it): add `"check-your-inbox": "newsletter"`, or the pack builds `/check-your-inbox/` for it.

**Each page is republished.** The import publishes every page it sets, as if you had clicked **Publish** on each. Everything that runs when a page is published runs once per page: the pack's own modules (search, the link checker, cache clearing, AI enrichment and the rest), and any other plugin's publish hooks. Drafts, scheduled pages and pages with unpublished changes are never touched.

## The editor and the pages list

- **Child pages panel** (in the editor's sidebar, for pages):
  - the page's URL, or the URL it gets once published;
  - its parent;
  - the pages under it;
  - a parent waiting to be published, and whether publishing it will be refused;
  - warnings:
    - a loop;
    - a parent that isn't published or was deleted;
    - a page 8 or more levels deep;
    - an all-digit slug;
    - Redirect Manager or Slug changes being off.
- **Parent column** (in the pages list): each page's parent; one that doesn't count for the URL (unpublished, or in a loop) is dimmed. EmDash's list can't indent pages or filter by parent: the Child Pages page's tree does that, and says under each flagged page what's wrong with it.

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
- a collection whose own URL pattern has neither `{slug}` nor `{pagepath}` (`/{id}`) can't nest, and **Set up** says so;
- a `urls` entry with `{pagepath}` (coywolf.com's `pages: "/{pagepath}/"`) follows the field too;
- a `urls` entry without `{pagepath}` (coywolf.com's posts) wins, so the field doesn't nest that collection: add `{pagepath}` where the slug goes.

## Internals

- **The field** is EmDash's: a reference field (`parent_page`) on a relation from the collection to itself, one parent each.
  - EmDash keeps the published selection in `_emdash_content_references` by translation group.
  - A selection saved on a page with drafts waits in its draft revision's `_references` until it's published.
  - Contract tests check those tables and keys against each EmDash release (`test/emdash-contract.test.mjs`).
- **The tree** is one D1 batch (the collections and their fields, the collection's pages, its links), shared by everything that renders a page: the theme's `loadPageTree`, breadcrumbs, the schema graph.
- **A read that fails never writes anything.** With Child Pages on, the parent tree (or the switch) may be unreadable for a moment. What happens depends on what the URL is for:
  - **Something is written from it** (Slug changes' and Removed content's redirects, Child Pages' own redirects, its record of URLs and its status, the import, Re-check): there's no URL, and the step is skipped. No 301 is ever written from a live nested page to its flat URL. The next change, or **Re-check redirects**, makes what was skipped.
  - **A page is rendered from it** (your theme's `entryUrl`, `entryUrls`, `matchEntryPath` and `loadPageTree`, the sitemaps, feeds, schema, breadcrumbs, search): the site keeps rendering, with the parents that Worker isolate read last. An isolate that hasn't read any yet uses the flat URLs (which redirect), as if Child Pages were off; `loadPageTree` alone has nothing to answer with then, and throws.
  - **Either way** the failure is logged (`Child Pages: could not read the parent pages`), the response isn't kept in the edge cache, and search doesn't keep what it read.
- **`childPagesVersion`**, a plugin setting, changes whenever published pages may have moved. It's part of the URL configuration's fingerprint, so live search answers cached with old page URLs aren't served again. It changes when a page with the field is:
  - published or unpublished;
  - trashed, deleted or restored;
  - saved with a new slug while it's published (EmDash's REST API writes a slug-only change to the live page, pending edits or not).
- **The publish guard** is EmDash's `content:beforePublish` hook. A failure of the pack's own (D1 unavailable) never blocks a publish. Its message stays under EmDash's 500 characters whatever the titles, because EmDash ignores a refusal with a longer one.
- **After the switch is saved**, other Worker isolates keep the old switch for up to five minutes, and a page one of them renders meanwhile (a 404 at a nested URL, say) could be cached. The Features save clears every cached page at once, and clears what those isolates cached once more when the five minutes are over (the pack's settling purge, by settings generation; see [Performance](performance.md)). Publishing is different, because a redirect outlasts the request: when a page is published, unpublished, trashed, restored or saved in a collection that can nest (Pages, a collection with the Parent page field, or one whose `urls` pattern has `{pagepath}`), the pack reads the switches again first, in whichever isolate handles it. That's one small read per page save; posts and other collections don't pay it.
- **Plugin storage** (KV):
  - `state:childPages:paths:<collection>`: each collection's nested URLs, to find the pages below one that moved. A move that got no redirect yet keeps its old URL here until one is made.
  - `state:childPages:status`: the last 10 changes that moved pages, and each collection's open issues, for the Child Pages page.

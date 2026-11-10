# Content Audit

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

A weekly report on your published entries: what's missing or worth fixing, as facts ("3 images without alt text", "H2 → H4"), never a score. Each finding links to the entry, and each count shows the change since the run before.

Feature switch: **Content Audit** (`audit`), off by default. Its page is **Content Tools → Content Audit**.

## The checks

Each count is the number of entries with that problem. Turn any check off, and set the numbers, in **Content Audit → Settings**.

| Check | What it reports |
| --- | --- |
| No SEO title | No title in the entry's SEO panel, so search results use the entry's own title. |
| Duplicate titles | Two or more entries with the same title (the SEO title, else the entry's title), ignoring case, spacing and end punctuation. |
| Title length | Shorter or longer than the range in Settings (15–60 characters by default). |
| No meta description | No description in the entry's SEO panel. |
| Duplicate descriptions | Two or more entries with the same meta description. |
| Description length | Shorter or longer than the range in Settings (70–160 characters by default). |
| Images without alt text | Images and gallery images in Portable Text with no alt text (the block's or its asset's, as EmDash renders them), and image fields with none (a field holding a bare URL has no alt to check, so it isn't counted). |
| No social image | No image of its own for Open Graph: no SEO image and no image field set. An image made by [Social Images](social-images.md) counts. |
| Thin content | Fewer words than Settings asks (300 by default; 0 turns it off), counting the entry's Portable Text, long text and string fields (not its title). Collections without a Portable Text field aren't checked. |
| Not updated lately | Not updated in longer than Settings allows (12 months by default; 0 turns it off). |
| Heading problems | More than one H1 on the page, and skipped levels (an H2 followed by an H4), each Portable Text field checked on its own. By default the theme is taken to print the title as the H1, so an H1 in the content is a second one; turn that off in Settings if your theme doesn't. |
| Broken internal links | Links to your own pages that [Link Manager](links.md) found broken (Link Manager on, with its checks run). |

SEO checks run only for collections with SEO enabled, and the word count and headings only for collections with a Portable Text field. Entries set to No index are audited too. Collections without public pages (not routable, or hidden) aren't audited; choose collections in Settings to narrow it further.

Where it helps, the page points to the fix: [AI Enrichment](ai.md) writes missing meta descriptions and alt text for media-library images.

## When it runs

- **Weekly**, on its own: Wednesdays at 04:00 UTC (the `audit-weekly` task; away from Sunday midnight, when the weekly, daily and hourly tasks all fall due).
- **Run now** on the page, any time. A run continues while the page is open, and in the background (hourly) if you leave.

A run reads the published entries a page of 50 at a time, with EmDash's content API, and stores the results for each page as one document in plugin storage (`audit_chunks`), saving its progress after every page. EmDash runs every due scheduled task in one invocation, and Workers Free allows 50 D1 queries per invocation for all of them, so a scheduled step stops at 20 statements (about 100 entries) or 60 seconds; when the Cloudflare usage card (Performance page) has seen the Paid plan, 150 (about 1,200 entries). The hourly task (`audit-continue`) then picks it up, so on Free a site with 2,000 entries finishes in about 20 hours. The last step (16 statements at most) finds duplicates across the whole site, reads up to 180 of Link Manager's broken internal links, and writes the report (with the previous run's counts, for the trend); the steps after it delete the run before, a page at a time. A step that fails three times in a row stops the run, with the error on the page. Between runs, the hourly task reads one small row; both tasks are scheduled only while Content Audit is on.

**Export CSV** downloads every finding: entry, collection, check, details and a link to the editor.

## Notes

- Findings are as of the run: an entry fixed since shows until the next run.
- "Duplicate" compares a short hash of the normalized text, so two titles that differ only in case or a trailing period count as the same.
- The report keeps one previous run's counts. Alerts' "Content audit worsened" alert compares the two (see [Alerts & Digest](alerts.md)).

# AI Enrichment

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Ported from Coywolf SEO's AI features, with the same prompts and validation:

- **Entities for schema** (`ai.entities`). The model lists the people, organizations, places, and things a page is about, without identifiers. Each name is looked up on Wikidata (`wbsearchentities`), and only items whose label or alias is that name (ignoring case, accents, and punctuation) count. When several match, the model may only pick one of them. Each chosen item's `instance of` (P31) claims are then checked (one Wikidata Query Service request per entry for all its items): disambiguation pages are dropped, a Person must be human, an Organization or Place can't be a creative work (the album instead of the band), and an Organization can't be a place. The JSON-LD `name` is Wikidata's label. The result is stored per entry as Schema.org `about` (main subjects) and `mentions`, each with `sameAs` links to Wikidata, Wikipedia, and the official website (P856) when there is one. Coywolf's Schema module reads them with `getEntryEntities(ctx | db, collection, id)` from `src/ai/entities.ts`.
- **Output entities on their own** (`ai.entitiesStandalone`). Adds the entities to the page's JSON-LD as a `WebPage` node (same `@id` as EmDash's `mainEntityOfPage`). Only for sites that don't use Coywolf Schema.
- **Meta descriptions** (`ai.descriptions`). Writes a description (under 155 characters, no clickbait) for published entries in SEO-enabled collections that don't have one. By default they're suggestions you edit and apply on the AI page; or have empty descriptions filled automatically. Either way it writes only EmDash's SEO panel field and never replaces a description someone wrote unless you choose **Replace**.
- **Image text** (`ai.imageText`). Writes alt text (and, if you turn it on, captions) for images on upload and in bulk, with accessibility-first prompts. Alt text and captions people wrote are kept unless you turn on overwrite. EmDash media has no title or description fields, so titles are shown on the AI page for reference only.

All four are off by default, under the **AI Enrichment** switch on the Coywolf Pack page.

## How it runs

Saving, publishing, or uploading never waits on AI: hooks only add the entry or image to a queue (after a short wait, so a burst of saves becomes one job, and only when the entry's text actually changed). A scheduled job works through the queue every two minutes (or with each cron tick, if the site's cron runs less often), a few items at a time (**Items per scheduled run**; raise it on a site with a slower cron), and stops for the day at **Max model calls per day** (default 200; an entry costs up to three calls, an image one). Each run also stays under 40 outbound requests (model calls plus Wikidata lookups), so it fits the Workers Free plan's subrequest limit; entries and images take turns, so a backlog of one doesn't hold up the other. Failed items are retried after 5 and 20 minutes, then marked as errors; a retry reuses the model output it already paid for. Deleting an entry removes its analysis. **Run bulk** on the AI page queues every published entry (skipping unchanged ones) or every image without alt text. The AI page also has a connection test, the queue status, suggestions to review, the analyzed entities (with **Export CSV**: one row per entity with its Wikidata, Wikipedia and website links, plus each entry's AI description), and a 30-day usage log with token counts.

## Setup

Pick a provider on **Plugins → AI Enrichment → Settings**:

- **Cloudflare Workers AI** (the default when the binding exists). Add the binding to `wrangler.jsonc`:

  ```jsonc
  "ai": { "binding": "AI" }
  ```

  The default model is `@cf/meta/llama-4-scout-17b-16e-instruct` for both text and images. A different binding name goes in `coywolfPlugin({ ai: { binding: "MY_AI" } })`.
- **Anthropic, OpenAI, or Google Gemini** with your own API key (stored encrypted, so the site needs `EMDASH_ENCRYPTION_KEY`). Defaults (checked October 2026): `claude-sonnet-5-5`, `gpt-6-luna`, `gemini-3.8-flash`. To use another model, such as a cheaper one or a newer one after a default is retired, enter its id in **Text model** and **Image model** on the Settings tab; leave them blank to follow the defaults.

Images are sent to the model at up to 3.5 MB. With a Cloudflare Images binding (`"images": { "binding": "IMAGES" }`, the same one EmDash uses for resizing) larger images are downscaled to 1568 pixels first; without one they're skipped. SVGs are skipped.

Set `ai: false` in `coywolfPlugin()` to leave the module out entirely. The module declares the `network:request` capability (for `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `www.wikidata.org`, and `query.wikidata.org`), plus content read/write (SEO panel only), schema read, and media read, bytes, and metadata write.

## Notes

- Only published entries are analyzed. Change the model or switch features and entries are re-analyzed the next time they're saved (or with **Re-analyze unchanged entries**).
- The daily limit is counted in UTC days. Each call's token usage is in the usage log; costs depend on your provider.
- Wikidata lookups are cached per Worker isolate and made one at a time, with `maxlag=5`. If Wikidata doesn't answer, the item is retried rather than saved unverified; if it asks to slow down (HTTP 429 or maxlag), every entity job waits for its `Retry-After` without counting as a failed attempt (after 10 waits in a row, the next counts as one). When an item lists several official websites, the preferred-rank one is kept, then https over http, then the first alphabetically.

# Internals

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

## Database reads

A page that isn't in the edge cache yet is built by the Worker, and every D1 round trip costs it about 25–30 ms. The pack keeps its share to about one:

- **Settings with the switches.** The feature switches, the settings page renders need (schema, videos player, discovery, code theme, review style…), the deployed version and the settings generation are one query, cached per Worker isolate for five minutes. A save through the pack's admin pages applies at once in the isolate that made it.
- **Settings generation.** Every successful pack admin save writes a new generation (`plugin:coywolf-pack:state:settingsGeneration`). Other isolates see it on their next read of the switches (within five minutes) and drop everything they derived from settings (schema config, player settings, redirect patterns…), which otherwise lasts up to ten minutes. Because those isolates may render pages with the old settings in the meantime, a save that clears the page cache clears it once more about five minutes later (see [Page cache](performance.md#page-cache)). Changes made outside the pack's admin pages (a byline's profile in EmDash) show up within ten minutes.
- **One query per entry.** An entry's Schema override, Videos embed index and AI entities are one query (and its blocks, for review schema, when the theme didn't pass the entry), read once per request however many hooks ask.
- **Batched.** The pack reads D1 through the raw binding (`env.DB`), which EmDash's per-request session (and its `coalesce` option) never sees, so reads the pack starts in the same moment are sent as one `db.batch()`: one round trip. A request's redirect lookup goes in the same batch as the feature switches when those aren't cached; on a page, the entry's data, image dimensions and video details are another.
- **From the theme.** Pass the entry you rendered as `coywolf.entry` on the page context (see [Schema & Social](schema.md#pass-the-entry-to-save-reads)) and the pack doesn't read its bylines or blocks again.

## Shared reads have deadlines

The pack shares work that's under way between the requests of a Worker isolate: the feature switches' read, the redirect patterns, the robots.txt takeover, a cold llms.txt build. On Workers, a request's I/O and timers belong to that request, and a request that's canceled (Cloudflare ends it at 100 seconds, its client leaves, a background task is cut off at 30 seconds) never settles what it started. Before 0.35.16 a later request waited for that forever, and so did every request after it, until the isolate was replaced: pages answered 524 after 100 seconds with 1–10 ms of CPU (coywolf.com, November 7 and 9, 2026). Now (`src/core/single-flight.ts`):

- **Anchored.** A shared read is handed to `waitUntil` as it starts, so a request that answers before the read is done (a request answered early, a client that leaves) still finishes it for the others.
- **Bounded.** A request that finds a read under way checks for its result on its own timers, never waiting on the other request's promise, and at most 2.5 seconds after that read started (10 s for a cold llms.txt or news sitemap build). Then it reads for itself, and its read replaces the stale one; other requests that gave up in the same moment wait for that fresh read (the same way, and at most once more) instead of each reading again. The log says `coywolf-pack: shared read stalled: … didn't settle within 2500 ms; reading again`. With D1 healthy, that costs the request the 2.5 s wait plus a normal read (tens of milliseconds).
- **Failing closed.** Every pack D1 read has a 5-second deadline; a read that times out counts as a failed read (features at their defaults, the page kept out of the edge cache), never a hang. So when D1 itself stops answering, a request fails after about 7.5 seconds at worst (2.5 s waiting for another's read, then its own 5 s read; one that waited on two reads in a row, 10 s), not the 100 s wall. The pack also batches same-tick reads per request (`src/core/d1-batch.ts`); a batch whose flush timer was dropped is taken over by a later read of the same request, but what protects every request is the per-read deadline.
- **Background work too.** Cache warming visits and steps, crops made on first use, video poster copies, download counts, and IndexNow and Bing Webmaster API calls all have deadlines, so one stuck job can't stop the ones after it.

All the deadlines, with why each is what it is, are in `DEADLINES` in `src/core/single-flight.ts`.

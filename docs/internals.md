# Internals

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

## Database reads

A page that isn't in the edge cache yet is built by the Worker, and every D1 round trip costs it about 25–30 ms. The pack keeps its share to about one:

- **Settings with the switches.** The feature switches, the settings page renders need (schema, videos player, discovery, code theme, review style…), the deployed version and the settings generation are one query, cached per Worker isolate for five minutes. A save through the pack's admin pages applies at once in the isolate that made it.
- **Settings generation.** Every successful pack admin save writes a new generation (`plugin:coywolf-pack:state:settingsGeneration`). Other isolates see it on their next read of the switches (within five minutes) and drop everything they derived from settings (schema config, player settings, redirect patterns…), which otherwise lasts up to ten minutes. Because those isolates may render pages with the old settings in the meantime, a save that clears the page cache clears it once more about five minutes later (see [Page cache](performance.md#page-cache)). Changes made outside the pack's admin pages (a byline's profile in EmDash) show up within ten minutes.
- **One query per entry.** An entry's Schema override, Videos embed index and AI entities are one query (and its blocks, for review schema, when the theme didn't pass the entry), read once per request however many hooks ask.
- **Batched.** The pack reads D1 through the raw binding (`env.DB`), which EmDash's per-request session (and its `coalesce` option) never sees, so reads the pack starts in the same moment are sent as one `db.batch()`: one round trip. A request's redirect lookup goes in the same batch as the feature switches when those aren't cached; on a page, the entry's data, image dimensions and video details are another.
- **From the theme.** Pass the entry you rendered as `coywolf.entry` on the page context (see [Schema & Social](schema.md#pass-the-entry-to-save-reads)) and the pack doesn't read its bylines or blocks again.

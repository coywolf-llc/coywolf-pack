# Robots.txt

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Manage `robots.txt` in plain English instead of a text box. The page opens with a one-paragraph summary of the whole file (**Search engines can crawl everything. AI training crawlers are blocked from the whole site.**), then three tabs:

- **Rules**: each rule as a sentence (“Block AI training crawlers (10) from the /private/ section and everything in it”), with an on/off switch, Edit (the same guided dialog), Duplicate and Delete. Order doesn't matter: crawlers follow the most specific matching line, and the file is written most-specific-first so older top-to-bottom crawlers agree. Below the list: a URL tester (**Can GPTBot fetch /2026/my-post/?**) and **What's being served**, the live file with Copy and Download, plus EmDash's original file for reference.
- **Bots**: the crawler directory (about 700 bots) with search and filters for category, purpose, operator, verification status and “used in rules”. Mark a bot verified (source URL and note, stored with the date and your name), rename it (the token never changes), add bots the directory lacks (token checked against `[A-Za-z0-9._-]+`, with a purpose), edit or delete them, and sync from Cloudflare Radar.
- **Settings and history**: keep EmDash's admin private, keep media crawlable, “crawlers named in a rule also keep the rules for all crawlers”, sitemaps, rule-name comments, Extra lines (for experts), the last 20 saved versions with Restore, **Reset to EmDash's original**, and **Export rules** / **Import rules…**: the rules and settings as a JSON file, to keep a copy or move them to another site. An import goes through the same checks as any change (with a confirmation listing the effects), replaces the current rules and settings, and keeps the current version in history.

**Templates** (header) replace the rule list in one click, through the same checks: *Block AI training, allow AI search*, *Allow everything*, *Block everything except search engines*.

## Taking over from EmDash

Turning the feature on takes over seamlessly. The first `/robots.txt` request or the first visit to the page (whichever comes first) converts the robots.txt EmDash was serving (its SEO setting, or its built-in default) into rules: groups become rules (identical lines for several bots become one rule, and known crawler groups are recognized), `Sitemap:` lines become sitemap settings, other lines (Crawl-delay, Content-Signal…) become Extra lines with their `User-agent` lines. The import is checked: for every crawler named in either file plus a few well-known ones and a stand-in for “any other crawler”, and every path the files' lines target, both files must give the same allow/block verdict (Google's matcher). If no combination of settings reproduces the file exactly, the original is kept as Extra lines, so crawlers always see the same rules. The one deliberate change: media in EmDash's library (`/_emdash/api/media/`) is opened to crawlers so images can appear in image search, and the summary under **What's being served** says so. The import is saved with an insert-if-absent, so concurrent first requests can't import twice. Turning the feature off serves EmDash's robots.txt again and keeps your rules for next time.

## Adding a rule

**Add rule** opens a four-step dialog:

1. **What do you want to do?** Keep crawlers out, or let crawlers in.
2. **Which part of your site?** Everything · A section (with “also wherever this folder name appears deeper”) · One page (with “only this exact address”) · A kind of file (PDF, Word, spreadsheets, images, ZIP, video… or other extensions, optionally only inside a section) · Links with tracking or extra parameters (utm_…, ref, fbclid, gclid, session IDs, sort and filters, site search, any `?`, or one you name) · Advanced pattern. Paste any address from your site: it's trimmed to its path, encoded, and read (“We read this as the /recipes/ section”), with a one-click switch when another choice fits better. Your collections' sections are offered as chips. A live box shows addresses the rule **will match** and nearby ones it **won't**, from the real matcher.
3. **Which crawlers?** Everyone · Search engines · AI training · AI search and assistants · SEO tools · Pick specific bots (search, categories with tick-all, verified badges, or a token that isn't listed). Each preset lists its members. Presets are curated by **purpose** from the operator's own documentation (`purposes` in `src/robots/data/verified.json`, with source URLs), never by Radar category, and only include verified tokens; bots that only come from Radar never join a preset, while verified custom bots with a matching purpose do. AI training is GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, meta-externalagent, Bytespider, Amazonbot, MistralAI-Training and Webzio-Extended. Rules made from a preset follow it: when a preset changes, the rule is updated on the next page load, with a one-time note listing crawlers added and removed.
4. **Review**: consequences first (“Search engines can fetch this section. 10 AI training crawlers can't.”), **Except…** for allowed items inside a blocked area, the name and note (prefilled), **Try a URL**, the exact lines under **Show robots.txt lines**, and the checks.

## Checks

Every change is checked in the browser as you type and again on the server before saving. Errors block saving; warnings need “I understand, add it anyway”.

- **Errors**: invalid crawler tokens, exceptions outside the blocked area (or ones that reopen all of it), line breaks, control characters or `#` in a value, patterns not starting with `/` or `*`, values over 2,083 characters, bad extensions or parameter names, an exact duplicate of another rule, the same crawlers both allowed and blocked on the same path, and a failed self-check.
- **Warnings**: a block on a discovery file that's kept readable, an Allow that nothing blocks, a block already covered by a wider block (naming it), a rule for everyone that named crawlers won't follow (with “Also apply it to these crawlers”), naming a crawler that then ignores the rules for all crawlers (RFC 9309 group selection; with the setting off, offers to turn it on), search engines blocked from your pages, CSS/JavaScript/images that renderers need, the media library, the sitemap, opening EmDash's admin, and blocks that the “Keep media crawlable” setting overrides.
- **Notes**: an Allow inside a block (valid; explained), where a more specific rule still decides, a partial duplicate (with **Merge**), unknown or unverified tokens, and case-sensitive paths.
- **Self-check**: after generating the file, every rule's crawlers are tested on addresses the rule targets, and the parsed file must give the verdict the rules say; crawlers the rule doesn't name must get the same verdict with and without it. A failure names the rule, crawler, address and deciding line.

## Automatic lines and the sitemap

**Discovery files stay readable.** Any crawler that your rules would block from `/.well-known/` (security.txt, ai-plugin.json and future machine-discovery manifests), from `/llms.txt` while Discovery's llms.txt feature is on (`/llms-full.txt` holds your full text, so add it yourself if you want it), or from discovery paths you add, gets an `Allow` line for them. The Rules tab lists these as **Automatic** lines with the reason. Turn the allowance off, or add paths, under **Settings and history**. Feature switches are read when the file is generated (middleware and admin preview), the self-check confirms each allowance, and a rule that targets a discovery file gets a warning.

**List the site's sitemap** sits at the top of the Rules tab. It's on for new and imported setups. A saved choice to turn it off is kept (for example when you submit sitemaps in Search Console), with a small note you can dismiss.

## How the file is written

One group per set of crawlers that follow the same lines. With “keep the rules for all crawlers” on (the default), a named crawler's group also gets the general rules, except where its own rules cover the same addresses (so “block GPTBot from the whole site” beats a general Allow). Every crawler not blocked from the whole site gets `Allow: /_emdash/api/media/` and `Disallow: /_emdash/`. We serve the file rather than writing EmDash's **SEO → robots.txt** setting because that setting is capped at 5,000 characters and couldn't keep EmDash's lines in every group.

Extra lines that would block search engines or the whole site are flagged on the page (they don't block saving). If EmDash's robots.txt settings can't be read during the takeover, nothing is imported and EmDash's file keeps being served until a later request succeeds.

Rules saved before 0.7.0 keep working unchanged: the stored config is read with defaults for the new fields, and “keep the rules for all crawlers” is turned on only when that changes no verdict.

Feature switches: **Robots.txt** (`robots`) and **Weekly crawler list from Cloudflare Radar** (`robots.radarSync`). Both default to off.

## Setup

Uses the same `coywolfPack()` middleware as Redirects, and the `DB` binding. A static `public/robots.txt` in the site would be served by Workers static assets before the Worker runs, so remove it. History and bot changes live in plugin storage (`robots_history`, `robots_bot_overrides`), the dismissed sitemap note in KV. The file is kept in the edge cache for a day and cleared after every save (see [Performance](performance.md#robotstxt-and-the-live-search-script-at-the-edge)); its `Cache-Control` header (`public, max-age=3600`) is for browsers and other caches. With route caching on, the Worker renders it only when the edge copy is missing (or for a query-string variant such as `/robots.txt?x=1`); each render reads the rules, the Site URL and EmDash's SEO settings in one query, given up after 5 seconds (EmDash's own file answers instead, kept off the edge). There is no per-isolate copy of the rules, so a save shows on the next render: no isolate still holds the old rules to put back in the edge cache.

## The crawler directory

A robots.txt `User-agent:` line takes a product token (`GPTBot`, `Claude-SearchBot`, `meta-externalagent`), which often isn't the bot's name or full user-agent string. The bundled directory (`src/robots/data/bots.json`) starts from Cloudflare Radar's bot directory and Coywolf SEO's curated tokens, and records for every bot how its token was confirmed:

- **verified, operator docs**: the operator's own documentation names the token (`sourceUrl`, `verifiedAt`). The major AI crawlers and search engines were re-checked on 2026-10-03: OpenAI, Anthropic, Google (including Google-Extended), Bing, Apple (Applebot-Extended), Perplexity, Common Crawl, Amazon, Meta, DuckDuckGo, Yandex, Baidu, Mistral, Webz.io and ImageSift.
- **verified, user agent**: the token appears in the user-agent string Radar publishes for the bot.
- **unverified**: derived from a pattern or name, or a legacy token the operator no longer documents (for example `anthropic-ai`, `Claude-Web`, `FacebookBot`, `cohere-ai`). These still work in robots.txt if the crawler uses them, and are flagged in the picker.

Signed agents that identify only cryptographically (Web Bot Auth) and have no token, such as ChatGPT agent, are left out. Bots that share a token (for example the nine regional Amazon Bedrock AgentCore browsers) are one entry, and hash-like identifiers that aren't product tokens are flagged unverified.

To rebuild the list, run `scripts/build-bots.mjs`. It reads Cloudflare Radar's directory (`RADAR_API_TOKEN`, or a snapshot saved earlier with `--save-snapshot` and passed back with `--radar-snapshot`), Coywolf SEO's curated tokens (`--wp <dir>`, or fetched with `gh api` from coywolf-llc/coywolf-seo), and the hand-verified tokens in `src/robots/data/verified.json`. To verify a token, add it to `verified.json` with the operator's documentation URL and the date you checked it, then rerun:

```bash
RADAR_API_TOKEN=… node scripts/build-bots.mjs
```

## Weekly refresh from Cloudflare Radar

With `robots.radarSync` on and a token set, the `robots-refresh-bots` task runs weekly (and **Refresh from Radar** runs it now). It makes one request, `GET https://api.cloudflare.com/client/v4/radar/bots?limit=1000`, and stores only differences from the bundled list in plugin storage (`robots_bots`), so a quiet week writes nothing. Radar publishes user-agent patterns, not robots.txt tokens, so bots that first appear this way get a token derived from their pattern and stay **unverified** until the bundled list is updated with a source. Bots that leave Radar stay usable and are marked.

It uses the [Cloudflare API token](README.md#the-cloudflare-api-token), which needs **Radar → Read** here (added by hand: Cloudflare's form can't pre-select it). An older Radar token (saved in the setup card on the **Bots** tab, or the `RADAR_API_TOKEN` Worker secret) still works until the Cloudflare API token is saved; `scripts/build-bots.mjs` reads `RADAR_API_TOKEN` as before.

The module declares `network:request` for `api.cloudflare.com` only.

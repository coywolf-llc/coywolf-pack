# Alerts & Digest

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

An email when something on the site needs a look, and, if you want it, a summary once a week. With several sites, nobody has to open each dashboard to find a failed backup.

Feature switches: **Alerts & Digest** (`alerts`) and its part **Weekly digest** (`alerts.digest`), both off by default. The page is **Coywolf Pack → Alerts & Digest**.

## Alerts

Checked every hour. Each alert reads what its module already keeps, so it works only while that module is on, and each can be turned off on the page.

| Alert | When | Reads |
| --- | --- | --- |
| Backup failed | The daily backup job failed, or (with daily backups on) no scheduled backup has succeeded for longer than Backups' "warn after" setting | The backup task's last outcome |
| New broken links | Link Manager's scheduled checks found links that weren't broken at the last check | Link Manager's broken links (the first check after you turn alerts on only records them) |
| Cloudflare bill estimate | The usage card's 30-day estimate is over your threshold (in US dollars; empty turns it off) | The Performance page's last usage reading (read again once a day if nobody opened the page) |
| Coywolf Pack update | A newer version is on npm | The update check's last answer |
| Content audit worsened | The latest [content audit](content-audit.md) found more of any problem than the run before | The audit's report |

Everything new at a check goes out in one email per recipient. An issue is sent to each recipient at most once a day, and one that lasts (the bill over the threshold, an update waiting, backups overdue) only once until it clears. Sends are tracked per recipient and recorded before they go out, so a check that's cut off mid-send doesn't send again the same day. If the provider refuses an email, that recipient's issues are tried again at the next check; if it doesn't answer within 20 seconds, the email is counted as sent but unconfirmed (it may still arrive) and isn't repeated. When nothing is wrong, nothing is sent.

**Check now** runs the hourly check right away. **Send test email** sends a short test to the recipients.

## Weekly digest

Once a week, Mondays at 13:00 UTC (the `alerts-digest` task; away from Sunday midnight, when the weekly, daily and hourly tasks all fall due), while **Weekly digest** is on, and never twice within six days: the last successful backup and any failure, broken and redirecting links (and the change since last week), the content audit's numbers and changes, the Cloudflare bill estimate, a waiting update, and anything other modules add (see [Digest sources](#digest-sources)). Nothing is sent when there's nothing to report. **Preview digest** shows the email as it would go out now, without sending it.

## Recipients

The site's admins (EmDash's Admin role) by default, or a list of up to 10 addresses. Each address gets its own email, so nobody sees the others. Emails are plain text with an HTML version of the same content, and link to the pack's pages in the admin.

## Set up email

Alerts send through EmDash's email provider (`ctx.email`), the one selected under **Settings → Email**. Until one is selected, the Alerts page shows these steps and nothing is sent. On Cloudflare, EmDash's Cloudflare Email plugin sends through the Worker's Send Email binding:

1. In the Cloudflare dashboard, onboard the domain (or a subdomain such as `mail.example.com`, to leave the apex's mail records alone) to **Email Sending**, so Cloudflare adds its sending records.
2. In the site's `wrangler.jsonc`, add the binding:

   ```jsonc
   "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["noreply@example.com"] }]
   ```

3. In `astro.config.mjs`, add the plugin to EmDash's `plugins`:

   ```js
   import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
   // …
   plugins: [cloudflareEmail({ from: { email: "noreply@example.com", name: "Example" } }), coywolfPlugin()],
   ```

4. Deploy. In the admin, activate the Cloudflare Email plugin under **Plugins**, then select it under **Settings → Email**.
5. Send a test from **Settings → Email**, then **Send test email** on the Alerts page.

Any other EmDash email provider plugin (SMTP, for example) works the same way. In `astro dev`, EmDash's console provider logs emails instead of sending them.

## Digest sources

Other modules can add a section to the digest without Alerts depending on them (`src/core/digest.ts`):

```ts
import { registerDigestSource } from "../core/digest.js";

registerDigestSource({
	id: "insights.traffic",
	feature: "insights.traffic",
	read: async (ctx) => {
		const stored = await ctx.kv.get<{ visits: number }>("cache:insights:traffic");
		return stored ? { title: "Traffic", lines: [`${stored.visits.toLocaleString("en-US")} visits in the last 7 days`], page: "/insights" } : null;
	},
});
```

A source is read only while its feature is on, should use what its module already stored (no network calls), and gets 5 seconds. One that returns null, throws or runs out of time is left out, and the rest of the digest still goes.

## Notes

- Capabilities: `email:send` (for `ctx.email`) and `users:read` (to list the admins).
- The hourly check (`alerts-check`) reads a handful of small rows: the alert settings and state, and one or a few per alert that's on (the broken links alert compares up to 2,000 broken links, most recently checked first). Both tasks are scheduled only while their switch is on, so while Alerts & Digest is off they don't run at all.
- The state (what was sent when, the last 20 emails) is one plugin KV row, `alerts:state`.

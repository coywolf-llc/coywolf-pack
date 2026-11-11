# Coywolf Pack 0.37.0 (draft release notes)

One Cloudflare API token for every Cloudflare feature, and a Settings page with four fields instead of twelve.

- **One token.** Save **Cloudflare API token** on the plugin's Settings page, or set the `CLOUDFLARE_API_TOKEN` Worker secret. Cloudflare usage, Insights, Crawler Hints, Cloudflare Checkup (reading and fixes), Set up media host, Videos, Retention on Cloudflare, Social Images, the Radar crawler list and large uploads all use it.
- **One form.** The token's guide opens Cloudflare's token form pre-filled with eight permissions, and lists the eight to add by hand. For the domains policy, Specified Domains → this site's domain is recommended; All Domains lets one token serve every site.
- **A short Settings page.** Cloudflare API token, AI API key, Fathom API key, Google service account key. Empty older tokens are hidden, saved ones sit under **Older tokens (N)**, and the Videos webhook secret is hidden.
- **Remove older tokens** on the Features page, once the new token is saved on Settings. The pack checks the token with Cloudflare first (active, one account). The File Downloads R2 key pair is removed only when you tick it.
- **No D1 Edit.** Restores keep their own token (`BACKUPS_API_TOKEN`), so the token saved in the database can't rewrite it.

## What's new

- Module pages that use the token saved on Settings say "Uses the Cloudflare API token from Settings." and put account overrides under **Advanced**. With only the `CLOUDFLARE_API_TOKEN` Worker secret, they say so and keep their own token field under Advanced, since a token saved there wins.
- Large uploads make R2's S3 keys from the token (its ID and its SHA-256). A complete saved R2 key pair still wins.
- The account is found from the token when it sees one account, and remembered.
- Errors name the token that was used (the Cloudflare API token, or the older token or Worker secret) and the missing permission. A saved token that can't be decrypted gets its own message on every page.

## Before you update

- **Nothing changes until you save the new token,** on a site without the `CLOUDFLARE_API_TOKEN` Worker secret. Older tokens keep working, and the token saved on Settings then ranks above them.
- **A site that already has the `CLOUDFLARE_API_TOKEN` Worker secret** (for example for Clean Image URLs or Backups, which already read it) finds it now also serves every Cloudflare feature without an older token of its own: Cloudflare usage, Insights, Crawler Hints, Cloudflare Checkup, Videos, Social Images, the Radar sync and large uploads. Where it lacks a permission, those pages show a permission error instead of a setup step, and the weekly Radar sync records a failure. Check those pages after updating, or remove the secret if it's there for another reason.

## Install

1. `npm install @coywolf/emdash@0.37.0`, then deploy.
2. Open the plugin's Settings page (`https://coywolf.com/_emdash/admin/plugins-manager/coywolf-pack/settings`), open the Cloudflare API token's guide and create the token with its form (Specified Domains → this site's domain).
3. Paste it into **Cloudflare API token** and select **Save Settings**.
4. Open the pages the older tokens served and check each works.
5. Open **Coywolf Pack → Features** and select **Remove older tokens** on the Cloudflare API token card. Then delete those tokens in Cloudflare, and any older Worker secrets the card lists (`npx wrangler secret delete NAME`).

# Backups

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

- **Database**: a restorable SQL dump of the site's D1 database: users, passkeys, settings, redirects, menus, plugin data, and content. Search indexes rebuild automatically on restore.
- **Media**: a mirror of the R2 media bucket. Replaced or deleted files are kept under a dated folder until retention expires.
- **Private Form Uploads**: when the site has a `FORM_UPLOADS` binding (**Private Form Uploads**), a mirror of that bucket too, under `uploads/`. Set `backups.uploads` to another binding name, or `false` to leave uploads out. Keep the backup bucket private: these are files people sent through forms.
- **Large rows**: D1 rejects statements over 100 KB, but posts can be bigger. Rows that don't fit in one INSERT are written with their long values in pieces, and the restore puts them back together exactly. Plugin caches are left out (they rebuild on demand). Rows are read up to 500 at a time, fewer when they're large: each read is sized from the bytes the previous one returned (about 8 MB), and a read D1 refuses as too large (it rejects results over 50 MB from November 4, 2026) is asked again for fewer rows.
- **Admin**: **Back up now**, **Download** any backup (see below), and a dashboard widget that warns when backups stop. Settings (**Schedule and retention** on the Backups page): daily scheduled backup (default off), retention (default 30 days), staleness warning (default 36 hours). Optionally, Cloudflare deletes old backups instead of the site, with an optional lock (see [Retention on Cloudflare](#retention-on-cloudflare)).
- **Restore** (optional, see below): **Rewind to this backup** (D1 Time Travel, with **Undo rewind**), **Restore to a new database** (import plus per-table row-count check), and **Restore missing media** (media first, then private form uploads, a batch of 200 files per request until done).

Theme code isn't included: it lives in your Git repository.

Backups is part of the pack only when the site passes a `backups` option to `coywolfPlugin()`. Its switch is off on new sites (sites set up before 0.36.0, when it was on by default, keep it on); turn it on on the **Features** page (**Coywolf Pack → Features** in the sidebar).

## Download a backup

Each backup's menu has **Download (.sql.gz)**: the gzipped SQL dump of the whole database, saved as `<name>-<stamp>.sql.gz`. It restores into any D1 database (see **Manual restore**), so you always have your own copy. The page asks the `backups/download-link` route (admins only) for a link that works for ten minutes, and the `coywolfPack()` middleware streams the file from R2 at `/_coywolf-pack/backup/<token>/<file name>`, so dumps of any size download without the Worker holding them in memory. Links are random, unlisted tokens stored in the backup bucket (`downloads/`), sent with `Cache-Control: private, no-store`; expired ones are deleted when the next link is made. Media isn't part of the download: the media mirror stays in the backup bucket (copy it with `rclone` or the R2 dashboard).

## Setup

1. Create a backup bucket and bind it as `BACKUPS` in `wrangler.jsonc`:

   ```bash
   npx wrangler r2 bucket create coywolf-backups
   ```

   ```jsonc
   "r2_buckets": [
     { "binding": "MEDIA", "bucket_name": "coywolf-media" },
     { "binding": "BACKUPS", "bucket_name": "coywolf-backups" }
   ]
   ```

2. Options: `database` (default `"DB"`), `media` (`"MEDIA"`), `backups` (`"BACKUPS"`), `name` (dump file prefix, default `"database"`).
3. Downloads need the `coywolfPack()` middleware (see the Redirects setup).

## Enable restore

Restores use the Cloudflare API, because a Worker can't create databases or time-travel through its D1 binding.

1. Create an API token with **Account → D1 → Edit** (add **Account → Workers R2 Storage → Edit** to use the same token for [Retention on Cloudflare](#retention-on-cloudflare)).
2. Store it as a Worker secret. It isn't a plugin setting, because a rewind rolls plugin settings back too:

   ```bash
   npx wrangler secret put BACKUPS_API_TOKEN
   ```

3. Add the IDs and deploy:

   ```js
   coywolfPlugin({
     backups: { name: "coywolf", restore: { accountId: "<account id>", databaseId: "<D1 database id>" } },
   });
   ```

Rewinds save an undo point to the backup bucket first; undo steps back one rewind at a time.

## Retention on Cloudflare

Optional, off until you set it up. By default the site deletes backups older than **Keep backups for** once a day. **Retention on Cloudflare** on the Backups page hands that to Cloudflare instead: an [R2 lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) on the backup bucket deletes each database backup, and each copy of a replaced or deleted file, that many days after it was made.

- **What it covers.** Three rules, one per prefix that ages out: `d1/`, `media/changed/` and `uploads/changed/`. The mirrors of your live files (`media/current/`, `uploads/current/`), rewind undo points (`restore/undo/`) and download links (`downloads/`) are never in a rule. The bucket's other rules (such as Cloudflare's default that aborts unfinished multipart uploads after 7 days) are kept as they are: the pack only adds, changes or removes its own, named `coywolf-pack-backups-retention:<prefix>`. The `d1/` rule also aborts a dump upload left unfinished for 7 days.
- **Then the site stops deleting.** Once the rule deletes every one of those prefixes at the retention days (or sooner), the daily task skips its own pruning. Backups made by an external job (such as the nightly GitHub Action) age out the same way, without the Worker. The pack looks at the bucket's rules again once a day when it has a token (saved on the page, or a Worker secret); without one, a look from the Backups page counts for a week, after which the site prunes again (it would delete the same backups, so nothing is lost either way). If someone removes the rule in the Cloudflare dashboard, the site notices on its next look and prunes again.
- **Changing Keep backups for** doesn't change the rule by itself. The card then says the rule keeps backups for a different number of days, and **Update the rule to N days** sets it. Until then the site prunes (when the setting is shorter than the rule) or leaves it to the rule (when the rule is shorter).
- **The bucket check.** Before it reads or changes any rule, the pack writes a small file through the site's `BACKUPS` binding (`coywolf-pack/bucket-check/…`) and looks for it in the named bucket through Cloudflare's API, then deletes it. A bucket name that isn't this site's (sites in one account are a typo apart) is refused.

### Set it up

1. Open **Coywolf Pack → Backups** and scroll to **Retention on Cloudflare (optional)**.
2. Enter the **Cloudflare account ID** (already filled in when the site's `backups.restore` option has it) and the **Backup bucket name**: the `bucket_name` of the `BACKUPS` binding in `wrangler.jsonc` (for coywolf.com, `coywolf-staging-backups`).
3. Create a token with the guide under the fields: [Cloudflare's token form, pre-filled](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%5D&name=Coywolf%20Pack%20backups) should show the name **Coywolf Pack backups** and one policy scoped to **Entire Account** with **Workers R2 Storage → Edit** and **D1 → Edit** (the second lets the same token do restores). Create it and copy it (Cloudflare shows it once).
4. Paste it into **Cloudflare API token**. Tick **Remember the token** to keep it, stored encrypted, so the site can look at the rule each day; or leave it unticked to use it just this once. Or skip the field: with the token set as the `BACKUPS_API_TOKEN` Worker secret (`npx wrangler secret put BACKUPS_API_TOKEN`), the page uses it.
5. Select **Check**. The card shows what the bucket does now (**Lifecycle rule: Off** on a new setup).
6. Select **Set the retention rule**. The card then shows **Lifecycle rule: On** and "Cloudflare deletes backups N days after they're made".

To undo it, select **Remove the pack's rules**: the rule and the pack's lock go, the bucket's other rules stay, and the site prunes again from the next day. Or set the rule by hand in the Cloudflare dashboard (**R2 → the bucket → Settings → Object lifecycle rules**, with the step-by-step guide on the page), then select **Check**.

### Bucket lock (optional)

**Also lock backups for N days** adds an [R2 bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/) to the same three prefixes, for the retention days. A locked backup can't be deleted or overwritten until it's that old: not by the site, not by a mistaken script, not by anyone using the site's R2 access. Lock rules win over lifecycle rules, so the lifecycle rule deletes each backup as soon as its lock ends.

The catch, plainly: **you can't delete locked backups early either**, to save space or to remove data you were asked to delete, and the bucket can't be emptied or deleted, until the lock is removed (on this page, or in the Cloudflare dashboard under **R2 → the bucket → Settings → Bucket lock rules**). Removing a lock needs an API token with Workers R2 Storage → Edit, so the lock protects against the site's own access and mistakes, not against someone holding such a token. Turning it on asks you to type LOCK.

With `d1/` locked, a backup writes its manifest once, after the media and uploads mirrors (R2 refuses to overwrite a locked file), instead of right after the dump and again with the mirror counts. A backup cut off in the middle of its mirrors then leaves its dump without a manifest, unlisted; the next run makes a new one. Shortening **Keep backups for** below a lock's days leaves the older backups in place until their lock ends (the site's pruning skips what R2 refuses and tries again the next day); **Update the rule** shortens the lock too (lock rules apply to existing backups as well as new ones).

## Backup layout

```text
d1/<stamp>/<name>.sql.gz         database dump
d1/<stamp>/manifest.json         stamp, size, SHA-256, source, row counts, Time Travel bookmark
media/current/<key>              mirror of the media bucket
media/changed/<stamp>/<key>      media replaced or deleted at that backup
uploads/current/<key>            mirror of the private form uploads bucket
uploads/changed/<stamp>/<key>    uploads replaced or deleted at that backup
restore/undo/<time>.json         undo points for rewinds
downloads/<token>.json           download links (ten minutes each)
```

External jobs (a nightly GitHub Action, for example) can write to the same layout, and the admin lists those backups too.

## Manual restore

Restore a downloaded backup (or one copied from the bucket) into a **new, empty** D1 database and switch the `DB` binding to it. Never import over the live database:

```bash
npx wrangler d1 create coywolf-restore
gunzip -c coywolf.sql.gz > restore.sql
npx wrangler d1 execute coywolf-restore --remote --file restore.sql
```

Keep `EMDASH_ENCRYPTION_KEY` in a password manager. It isn't in backups, and encrypted plugin settings can't be read without it.

## Notes

- `wrangler d1 export` refuses databases with FTS5 tables (EmDash search). The dump writes tables, then search tables and their triggers, then rows with parent tables before child tables (D1 imports large files in batches, so deferred foreign keys aren't enough), then indexes and the remaining triggers.
- Every R2 bucket aborts multipart uploads left unfinished for 7 days, so a dump cut off midway doesn't stay billed (the pack's `d1/` lifecycle rule does the same when it's set).
- Backups run in one Worker request, so they suit small and medium sites. The dump is streamed: rows are read 500 at a time (paged by rowid) and gzipped straight into the backup bucket (as a multipart upload in 5 MB parts once it's bigger than one part), so the Worker never holds the whole dump in memory. The database is saved before the media mirror runs. The mirror copies at most 300 changed files per run, 8 at a time; the rest follow on the next run.
- Integers larger than 2^53 lose precision (D1 returns JavaScript numbers). EmDash stores IDs as text.

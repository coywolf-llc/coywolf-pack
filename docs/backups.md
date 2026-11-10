# Backups

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

- **Database**: a restorable SQL dump of the site's D1 database: users, passkeys, settings, redirects, menus, plugin data, and content. Search indexes rebuild automatically on restore.
- **Media**: a mirror of the R2 media bucket. Replaced or deleted files are kept under a dated folder until retention expires.
- **Private Form Uploads**: when the site has a `FORM_UPLOADS` binding (**Private Form Uploads**), a mirror of that bucket too, under `uploads/`. Set `backups.uploads` to another binding name, or `false` to leave uploads out. Keep the backup bucket private: these are files people sent through forms.
- **Large rows**: D1 rejects statements over 100 KB, but posts can be bigger. Rows that don't fit in one INSERT are written with their long values in pieces, and the restore puts them back together exactly. Plugin caches are left out (they rebuild on demand). Rows are read up to 500 at a time, fewer when they're large: each read is sized from the bytes the previous one returned (about 8 MB), and a read D1 refuses as too large (it rejects results over 50 MB from November 4, 2026) is asked again for fewer rows.
- **Admin**: **Back up now**, **Download** any backup (see below), and a dashboard widget that warns when backups stop. Settings (**Schedule and retention** on the Backups page): daily scheduled backup (default off), retention (default 30 days), staleness warning (default 36 hours).
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

1. Create an API token with one permission, **Account → D1 → Edit**.
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
- Backups run in one Worker request, so they suit small and medium sites. The dump is streamed: rows are read 500 at a time (paged by rowid) and gzipped straight into the backup bucket (as a multipart upload in 5 MB parts once it's bigger than one part), so the Worker never holds the whole dump in memory. The database is saved before the media mirror runs. The mirror copies at most 300 changed files per run, 8 at a time; the rest follow on the next run.
- Integers larger than 2^53 lose precision (D1 returns JavaScript numbers). EmDash stores IDs as text.

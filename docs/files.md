# File Downloads

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

The Coywolf Files plugin for WordPress, on EmDash. Add a **File download** block to any entry and visitors get a download card: a colored file-type badge, the file name, a "PDF · 2.4 MB · Uploaded Mar 4, 2026" line, a Download button, and a Copy link button.

- **Block**: pick a file from the Media Library or from large uploads, then give it a title and description for that placement. Toggles show or hide the icon, description, meta line, Download, and Copy link. The card is server-rendered, scoped (`cw-file`), follows light/dark (or a fixed scheme), and ships one small script for Copy link (clipboard, checkmark, screen-reader announcement).
- **Download URLs**: `/download/<id>/<file name>`, served by the pack middleware. Files stream from R2 with `Content-Disposition: attachment`, the right `Content-Type`, `Content-Length`, `ETag`, conditional requests, and single byte ranges with `If-Range` (resumable downloads; a request for several ranges gets the whole file). Or set a public bucket / CDN URL and downloads redirect there.
- **Files page** (**Plugins → Files**): every file used in a File download block plus every large upload, with type, size, upload date, downloads, and the entries that use it. Search, In use / Unused filters, copy link, delete, and **Export CSV** (every file with its full download URL, size, download count, last download, and the entries that use it). Deleting a large upload removes the object from R2; the page lists the entries that still use it (their blocks then render nothing). Media Library files are deleted in the Media Library.
- **Large uploads**: files of any type and size (EmDash's own uploads stop at 50 MB and images, video, audio, and PDF) go straight from the browser to R2 in 8 MB+ parts, four at a time, with progress, retries, and Cancel. The Worker only signs URLs (AWS Signature V4 with Web Crypto, no AWS SDK).

## Feature switches

| Feature | Default | What it does |
| --- | --- | --- |
| `files` | off | The block, download URLs, and the Files page |
| `files.counts` | off | Count downloads (batched D1 writes after the response) |
| `files.largeUploads` | off | Large uploads to R2, up to 50 GB (needs the settings below) |

## Setup

1. Turn on **File Downloads** on the **Features** page (**Coywolf Pack → Features** in the sidebar). The middleware from the Redirects setup (`coywolfPack()`) serves the download URLs; nothing else to add.
2. Settings (**Files → Settings**): download URL base (default `download`), optional public bucket / CDN URL, card color scheme, accent color, and largest upload (default 5 GB).
3. Bindings: `DB` and `MEDIA`. To keep large uploads in their own bucket, bind it as `FILES` (or pass `files: { uploads: "MYBINDING" }`, and note the middleware looks for `FILES`).

## Large uploads

1. Create an R2 API token (**R2 → Manage API tokens**) with **Object Read & Write** on the bucket. Enter the account ID, access key ID, secret access key (stored encrypted), and bucket name under **Files → Settings → Large uploads**. Until all four are saved, the Files page shows a setup card instead of the uploader. The bucket must be the one bound as `MEDIA` (or `FILES`), since downloads stream through that binding.
2. Add a lifecycle rule to the bucket (**R2 → bucket → Settings → Object lifecycle rules**): **Abort incomplete multipart uploads after 1 day**. The pack also aborts uploads left unfinished for 24 hours in a daily task, but the rule catches anything the task can't reach (for example after the credentials change).
3. On the Files page, **Upload large file**.

The browser sends the file to the site in 6 MiB parts (`files/upload-part`), and the Worker uploads each to R2's multipart upload. Since EmDash 1.3.1, admin pages send `Content-Security-Policy: connect-src 'self'`, which blocks the browser from talking to R2 directly; the bucket needs no CORS policy. Each part must be exactly its expected size and belongs to the upload `files/upload-start` recorded, so a request can't write anywhere else. With 10,000 parts at most, a file can be up to just under 60 GB; the **largest upload** setting goes up to 50 GB.

Only administrators (`plugins:manage`) can upload, and uploads above the **largest upload** setting (default 5 GB, at most 50 GB) are refused. The upload steps (`files/upload-start`, `-part`, `-complete`, `-abort`) clear no cached pages and record no settings change: a file is on no page until an entry uses it (the block's file picker lists only finished uploads). Before 0.35.19 each part cleared every cached page. R2 storage and operations are billed to your Cloudflare account.

Files are stored as `files/<id>/<name>` with their metadata in plugin storage. Files moved from Coywolf Files for WordPress keep their 20-character WordPress id and object key (see [Migrating from WordPress](wordpress-import.md)). The pack calls only `<account>.r2.cloudflarestorage.com`.

## Notes

- Which entries use which file comes from an index updated on every save and delete. **Rebuild usage** rescans all content (needed once if blocks existed while the module was off). Entries moved to the trash stop counting as uses.
- Download counts are kept per isolate for a second and written together, so a burst of downloads costs one D1 batch. Counts made just before an isolate is evicted can be lost. A HEAD request, a 304, or a later range chunk isn't counted.
- Any ready Media Library item can be downloaded through `/download/<its id>/…`, whether or not a block uses it. That's the same exposure as EmDash's own `/_emdash/api/media/file/<key>` URLs: media files are public to anyone with the link.
- Lookups are cached per Worker isolate for 60 seconds, including "not found". A file requested just before its upload finished can keep answering 404 on that isolate for up to a minute.
- With a public bucket / CDN URL, downloads redirect to it, so the file name comes from the object key and the CDN decides the headers.

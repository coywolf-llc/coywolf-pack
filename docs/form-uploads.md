# Private form uploads

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

The EmDash Forms plugin (`@emdash-cms/plugin-forms`) saves a file field's upload in the **media library**, where every file is public to anyone with its URL (`/_emdash/api/media/file/<key>`). With **Private form uploads** on, those files go to a private R2 bucket instead, and only admins can get them back.

- **Where files go**: an R2 bucket with no public access (no r2.dev URL, no custom domain), bound as `FORM_UPLOADS`. Nothing is written to the media library, so there's no public URL to cache.
- **Form uploads page** (**Plugins → Form uploads**): every private file, newest first, with its form and field, size, upload time, and the submission it came with (date and a short preview of the answers). **Download** and **Delete** per file.
- **Downloads**: an admin-only route (`plugins:manage`, EmDash's CSRF header required). The file is always sent as an attachment with a type that can't render (HTML, SVG, XML, scripts and unknown types go out as `application/octet-stream`), with `nosniff`, a sandbox CSP and `no-store`. The page saves the bytes as a file; it never opens them.
- **Cleanup**: deleting a submission in Forms (one, all of a form's, or by the form's retention setting) deletes its files. A daily task also removes files whose submission is gone or never saved, and, if **Delete files after (days)** is set, files older than that (the submission stays).
- **Which forms**: all forms (default) or only the ones checked on the Form uploads page.
- **Files from before**: a **Move to private bucket** button moves files that earlier submissions left in the media library, points each submission at its private copy, and deletes the media library copy.

Everything else about the form is still the Forms plugin's own: spam protection (honeypot, Turnstile), validation, the field's accepted types and size limit (and its 10 MB cap), notifications, webhooks, and the confirmation message. The private bucket takes the same file types the media library would (images, video, audio, PDF); anything else is refused, as before. File names are cleaned up (no paths, control or invisible characters, or characters Windows and macOS refuse; at most 120 characters) before they're stored or saved.

## Feature switches

| Feature | Default | What it does |
| --- | --- | --- |
| `formUploads` | off | Files from selected forms go to the private bucket |

## Setup

1. Create the bucket and leave public access off: `npx wrangler r2 bucket create coywolf-form-uploads`.
2. Bind it in `wrangler.jsonc`:

   ```jsonc
   "r2_buckets": [
     { "binding": "MEDIA", "bucket_name": "coywolf-media" },
     { "binding": "FORM_UPLOADS", "bucket_name": "coywolf-form-uploads" }
   ]
   ```

3. Wrap the Forms plugin in `astro.config.mjs`:

   ```js
   import { coywolfPlugin, privateFormUploads } from "@coywolf/emdash";
   import { formsPlugin } from "@emdash-cms/plugin-forms";

   plugins: [
     coywolfPlugin({ /* … */ }),
     privateFormUploads(formsPlugin({ defaultSpamProtection: "honeypot" })),
   ]
   ```

   Options (second argument): `bucket` (default `"FORM_UPLOADS"`), `mediaBucket` (default `"MEDIA"`, for moving earlier files), `database` (default `"DB"`).
4. Deploy, turn on **Private form uploads** under **Plugins → Coywolf Pack**, and check **Plugins → Form uploads**.

## How it works

`privateFormUploads()` keeps the Forms plugin's id, storage, settings and admin pages, and points its code entry at `@coywolf/emdash/forms`, which runs the Forms plugin's own routes and hooks with one change: the `ctx.media` they get. Its `upload()` writes to the private bucket (when the feature is on and the form is selected) and its `delete()` removes private files; every other call goes to the media library as before. The submission records the file as media id `coywolf-private:<id>`, and the file's details (form, field, name, size, submission) are kept in the Forms plugin's KV. The Form uploads page calls routes added to the Forms plugin at `/_emdash/api/plugins/emdash-forms/coywolf-private-uploads/*`.

## Notes

- With the feature on but no `FORM_UPLOADS` binding, a submission with a file fails ("File uploads are not configured") rather than storing the file publicly. If the switch can't be read, files stay private.
- Turning the feature off sends new files back to the media library and takes Form uploads out of the sidebar. Files already in the private bucket stay private; turn the feature back on to download or delete them.
- The Forms plugin's own admin doesn't show files; use the Form uploads page. Its CSV export and notification emails show the file name, and its webhook payload carries the `coywolf-private:<id>` media id.
- Downloads arrive in 4 MB parts (plugin responses are capped at 8 MB) that the page joins.
- The wrapper relies on the Forms plugin storing files through `ctx.media.upload()` and deleting them through `ctx.media.delete()` (true in 0.2.x). If a Forms update changes that, re-check before updating.

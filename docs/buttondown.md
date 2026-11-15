# Buttondown Drafts

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

When a post with a chosen category is published, the Pack makes one [Buttondown](https://buttondown.com) email draft from it. You review the draft in Buttondown and send it from there. **The Pack never sends, schedules or publishes an email.**

- Feature switch: **Buttondown Drafts** (`buttondown`), off by default. New in 0.43.0.
- Part: **Update drafts** (`buttondown.updates`), off by default. With it on, publishing the post again updates its draft while the draft is untouched in Buttondown.
- The page is **Coywolf Pack → Buttondown Drafts**. The entry editor gets a **Buttondown** section in collections a rule covers.
- The API key is **Buttondown API key** on the plugin's Settings page, like the other keys.

## Set up

1. **Make a key in Buttondown** that can only write drafts:
   - Sign in to Buttondown and switch to the newsletter this site's drafts go to. Each site uses its own newsletter's key.
   - Open [Settings → API keys](https://buttondown.com/keys) and create a key. Name it after the site, for example `Coywolf Pack drafts (coywolf.com)`.
   - Set **Emails and drafts** to **Write**, and every other area to **None** (**Sending** included). Save it.
2. **Save the key** as **Buttondown API key** on the plugin's Settings page (`https://coywolf.com/_emdash/admin/plugins-manager/coywolf-pack/settings`). It's stored encrypted, and no page shows it again. The field's guide has the same steps.
3. **Turn on Buttondown Drafts** on the Features page. Turn on **Update drafts** too if you want republished posts to update their drafts.
4. **Check the key**: on the Buttondown Drafts page, select **Check key**. It should say the key works, can read drafts, and can't read your newsletters or subscribers. The check only reads. The first draft the Pack makes shows the key can write.
5. **Add a rule** under **When to create a draft**: a collection, a taxonomy and its terms. On coywolf.com that's **Posts**, **Categories**, **Coywolf Newsletter**. Save.

From then on, publishing a post with one of the rule's terms (or a child term of one) makes its draft within a few seconds. A scheduled post gets its draft when it goes live, on the site's hourly cron tick.

## Rules

- One rule per collection, up to 10. A rule needs at least one term.
- A post matches when it has one of the rule's terms, or a child term of one (as term feeds count them).
- **Only new posts.** Saving a new or changed rule stamps it with the time (its `since`). Only posts whose publish date is at or after that time get a draft on their own. So republishing an old post, such as "Why Claude has my attention", never makes a draft. That holds on every path, also when the rules couldn't be read at the moment of the publish: the job then checks the date itself before it makes anything. **Create draft now** in the entry editor makes one for any published post that matches.
- The Pack reads the publish date EmDash shows for the post. If you change an old post's publish date to a time after the rule was saved and publish it again, it counts as new and gets a draft. A new post you give a publish date from before the rule gets none on its own.
- Unpublishing keeps a post's first publish date, so a post that was unpublished and published again still counts as new.
- The footer link ("Read it on coywolf.com") is on by default. Turn it off on the page.

## The key

The Pack needs only **Emails and drafts → Write**. With **Sending → None**, a key that leaks can't send or schedule an email.

**Check key** makes four reads and looks only at their status codes. It never parses, keeps or returns the answers. EmDash's fetch does download each answer into the Worker's memory before the Pack can drop it. With a key that's too broad, that includes the newsletter and subscriber lists, which is one more reason to replace such a key.

| Read | Expected | What it means |
| --- | --- | --- |
| `GET /ping` | 200 | The key works |
| The draft list | 200 | It can read drafts. A read can't show that it can write: the first draft the Pack makes shows that |
| `GET /newsletters` | 401 or 403 | It can't read your newsletters (or their keys) |
| `GET /subscribers` | 401 or 403 | It can't read your subscribers |

A 200 on either of the last two shows a red warning: the key can do more than it needs. The page still lets you use it (decision D7). Make a limited key, save it, and delete the broad one in Buttondown.

The key is read only in the Worker. It's never logged, never returned to a page, and scrubbed from every error (a `Token <key>` header included). A newsletter's main key has full access: don't use it here.

## What happens when

"Matches" means the collection has a rule and the post has one of its terms when the event is handled.

| Event | What the Pack does |
| --- | --- |
| First publish, matches | Makes the draft |
| Scheduled post goes live | The same as a first publish |
| First publish, doesn't match | Nothing |
| A post first published before the rule | Nothing on its own. **Create draft now** makes one |
| A draft save of a published post | Nothing: the live post didn't change |
| Republish (or a live edit), Update drafts on | Updates the draft, if Buttondown still says draft and nobody edited it there. An unchanged post makes no call |
| Republish, Update drafts off | Nothing |
| Republish, the email was scheduled or sent | Leaves it alone. It's checked again on the next event |
| Republish, the draft was edited in Buttondown | Leaves it alone. **Refresh draft from post** overwrites it |
| Republish, the draft was deleted in Buttondown | Leaves it deleted. **Create draft now** makes a new one |
| A create is retried, and Buttondown already has the post's email as a draft nobody changed | Uses that draft. No second one |
| A create is retried, and that draft was edited in Buttondown | Keeps it as it is and marks it "Edited in Buttondown" |
| A create is retried, and that email was scheduled or sent | Points at that email and leaves it alone. No second draft |
| The category is removed, then the post is saved or published | Stops watching the post. The draft is left as it is |
| The category is removed after a create got no answer | Stops watching the post and keeps its record. If the category comes back, the next publish finds the draft that create may have made, and makes no second one |
| Unpublish or trash, the draft is untouched | Deletes the draft (decision D2). Publishing again makes a new one |
| Unpublish or trash, the draft was edited in Buttondown | Keeps the draft. The panel says "Kept because you edited it in Buttondown" |
| Unpublish or trash, the email was scheduled or sent | Leaves it alone |
| Unpublish or trash, the draft was never made (Buttondown refused the create) | Stops trying and stops alerting. Publishing again tries again |
| Unpublish or trash, a create got no answer and no retry has found its draft yet | Looks for the draft by the post's key. Deletes it if it's untouched. Keeps it, and names it on the post's record, if it was edited, scheduled or sent |
| Restore from trash | Nothing: EmDash restores the post as a draft. Publish it to make a new draft |
| Permanent delete | Deletes the draft if it's untouched, then stops watching |
| Publish again before a failed delete is retried | The delete is cancelled and the draft is updated instead |
| Publish again after the Pack's delete got no answer | Checks the email, with Update drafts on or off, and also when **Retry** finds the post live again. If it's gone, the delete was the Pack's own, and the post gets a new draft. If it's still there, the Pack keeps using it |
| Publish or save after Buttondown answered a create with no email the Pack can read | No call. The post waits for **Retry** (see [Failures and retries](#failures-and-retries)) |
| Publish or save while Buttondown refuses the saved key | No call with that key. The post waits for another key or **Retry** (see [Failures and retries](#failures-and-retries)) |
| A category added or removed on its own | Nothing at that moment (see [Notes](#notes)). The next publish or save decides |

"Untouched" means Buttondown's own read, right before the change, shows the email as a draft, with the `modification_date` the Pack recorded after its own last write, and the Pack's key in its metadata.

Only Buttondown's own times decide this:

- For a draft the Pack wrote, the `modification_date` Buttondown returned for that write.
- For a draft the Pack finds by its key (a create whose answer was lost), a `modification_date` within a second of its `creation_date`.
- Never the hash in the Pack's metadata. An edit in Buttondown doesn't change that hash, so it can't show that nobody edited the draft.

A draft the Pack finds already changed is recorded with no date of the Pack's own. The Pack then never updates or deletes it, unless you select **Refresh draft from post**.

**Refresh draft from post** is one attempt:

1. The panel reads the draft's status and `modification_date` from Buttondown.
2. You confirm.
3. The Pack writes only if Buttondown still shows that exact `modification_date`, and the email still has the Pack's key for this post in its metadata. If the draft changed in between, or the key was removed or changed in Buttondown, nothing is written and the panel says so.

If the write fails, it is over. No retry, republish or hourly run overwrites the draft because of it. Select **Refresh draft from post** to try again.

**A read that fails is never a "no", and never a default.** The Pack reads these on the site:

- the post, its terms and its URL;
- the rules;
- the collection's fields;
- the site's own URL;
- what some blocks are built from: the affiliate disclosure settings, the podcast settings, and File Downloads' settings and files.

If one of them can't be read, the Pack doesn't treat that as "not published" or "doesn't match", and it doesn't build the email from default values. Nothing is deleted, skipped, stopped or overwritten with a poorer body. The step fails with "The site couldn't read…" and is tried again like a call that got no answer. A post with file cards on a site whose database binding can't be reached fails the same way: its email is never built without the files.

## The email

| Field | Value |
| --- | --- |
| `status` | `draft`, on create only. Never in an update |
| `subject` | The post's title |
| `description` | The excerpt, else the SEO description |
| `canonical_url` | The post's URL |
| `image` | The first image field (the featured image), else the SEO image, resized for email |
| `slug` | The post's slug, when Buttondown takes it (letters, digits, `-` and `_`, up to 100). If Buttondown refuses it, the Pack tries once without it |
| `metadata` | `coywolf_pack`: the Pack's key for the post (`coywolf.com:posts:<entry id>`), and a hash of what it wrote. Other metadata keys stay |

The Pack never sets `publish_date`, `filters`, `email_type`, `archival_mode`, `template` or the other fields. Buttondown's defaults and your own choices stand.

The body:

- Starts with `<!-- buttondown-editor-mode: plaintext -->`, so Buttondown reads it as Markdown. Its own guess isn't reliable.
- Has no frontmatter. Buttondown refuses a body that starts with it.
- Holds each Portable Text field of the collection, in field order, as the Markdown versions in [Discovery](discovery.md) do, with links made absolute.
- Ends with a rule and "Read it on coywolf.com", linking to the post (unless you turn that off). A post with no content gets the link alone.

**Images.** Media-library images are resized to 1200 px on the [media host](images.md#setting-up-a-media-host):

- JPEG, PNG and GIF keep their format.
- WebP and HEIC become JPEG, which every email app shows.
- AVIF and SVG can't be resized (Cloudflare serves an SVG as it is and ignores the resize options), and a site without a media host has nothing to resize with: those use the original file, with a warning.
- An image from another site is used as it is, with a warning when it's WebP, AVIF or SVG.

**Blocks.**

| Block | In the email |
| --- | --- |
| Video | "▶ Watch the video: <title>", linking to the post, with its poster image when the block has one |
| File card | "Download: <title> (<size>)", linking to the file's download URL (else to the post) |
| Note, Details, Affiliate disclosure | A block quote, with the title or summary in bold |
| Quote, Testimonial | A block quote, then who said it |
| Podcast links | The heading, then a list of the services |
| Review | The item, the rating ("4.5 / 5"), the pros and the cons |
| Embed, button | Its label (or URL) as a link |
| Table of contents, breadcrumbs | Left out: they're navigation |
| Anything else | "Part of this post isn't shown in email. Read it on coywolf.com.", linking to the post, and a warning naming the block |

**Warnings** show in the panel and on the page. They don't stop the draft. You see one when:

- a block can't be shown in email;
- an image can't be resized, or is WebP, AVIF or SVG from another site;
- the post contains template code (`{{`, `{%` or `{#`). Buttondown runs Django templating when it sends. Check the preview in Buttondown;
- Buttondown has more than one draft for the post (the Pack uses the oldest; delete the others).

## What the Pack never does

- Send, schedule or publish an email. Its API client has no such call, and a guard in front of every call refuses a `send-draft` or `publish` path, a status other than `draft`, and Buttondown's `X-Buttondown-Live-Dangerously` header.
- Change an email that isn't a draft, or one edited in Buttondown (unless you select **Refresh draft from post**, and then only while it's a draft that still shows the `modification_date` you were shown and still has the Pack's key for the post).
- Make a second email for a post whose email was already scheduled or sent.
- Delete anything but an untouched draft of a post that was unpublished, trashed or deleted. Buttondown's docs say a delete also removes the email from the archive and cancels its scheduled sends, so the Pack reads the email right before every delete and deletes only a draft.
- Call any host but `api.buttondown.com`, read subscribers, or touch automations or other newsletters.
- Log the key, the subject, the body or the description. Logs name the entry, the email id, the state and the status code.

## Failures and retries

| Answer | What happens |
| --- | --- |
| 429 | Waits out a short `Retry-After` (up to 10 seconds) and tries once more. Else the hourly task tries again after `Retry-After`, at least 5 minutes later, for 3 days |
| 5xx, no answer, timeout, a read on the site that failed | Tried again after 5 minutes, 15 minutes, 1 hour, 3 hours, 6 hours, then every 6 hours, for 3 days |
| 401, no key | Not tried again on its own, and not by publishing the post again. Once a different key is saved, the hourly task tries again, and so does the next publish. **Retry** tries now |
| 403 | Tried once more an hour later, because Buttondown also answers 403 when it throttles. Publishing again in that hour makes no call and keeps that retry. Then the same as 401. A 403 that comes after another failure of the same attempt gets no retry of its own: it's the same as 401 at once |
| 400, 422 | Shown with Buttondown's error code and message. **Retry** tries again |
| A 2xx answer to a create with no email the Pack can read | Buttondown may have made the draft, and the Pack can't tell. Not tried again on its own, and not by publishing the post again, so no second draft is made. The alert reports it. Look in Buttondown, then select **Retry** |
| 404 on an update | The draft was deleted in Buttondown: recorded as deleted there |

Saving the same key again doesn't count as a different key. After you fix a key's permissions in Buttondown, select **Retry** on each failed post: the Pack can't see that the key was repaired, so nothing tries it again on its own. The error on the post and on the page says so: "Select Retry after you fix the key in Buttondown." Publishing the post again doesn't try a key Buttondown refused: the retry, when it runs, uses the post as it is then.

**A create the Pack can't read.** If Buttondown answers a create with a 2xx and no email the Pack can read (its answer format changed, say), the draft may exist, and the Pack's own search may not see it either. So the Pack makes no second create on its own. **Retry** looks first and uses the draft if it finds it. If it still can't read Buttondown's answers, each **Retry** or **Create draft now** makes one more draft, so look in Buttondown before you select it.

**Every failure has an end.** Once a draft has been failing for 3 days:

- the Pack stops trying on its own;
- the alert stops;
- the page still lists it as failed, with **Retry**;
- the hourly task removes its record after 180 days without a change.

**A new attempt is a new failure.** You start a new attempt when you:

- publish or save the post again;
- unpublish or trash it;
- select **Retry**;
- save a different key.

If the earlier failure is over by then (nothing more was planned for it, or its 3 days have passed), what fails next is a new failure: it gets its own retries, its own 3 days and its own alert. The same goes when the failing step changes, for example an update that kept failing, then a delete that fails. A failure that's still being retried keeps its start, so publishing again during an outage doesn't put off its alert.

Every create looks in Buttondown first, by the post's key, among the emails made through the API in any status. So a create that reached Buttondown but whose answer was lost is found, not made twice, even if you scheduled or sent it since. The search costs one list call most of the time:

- Buttondown lists the newest emails first, and the Pack reads at most three pages.
- It stops at the first page holding an email made over an hour before the post's record. An email the Pack made for this record can't be older than that, so old emails cost no call, however many there are.

**A write that got no answer.** A create or a delete can reach Buttondown while its answer is lost (no response, a timeout or a 5xx). The record remembers that:

- A create: the next try finds the draft by its key and uses it. If the post is unpublished or trashed first, the Pack looks for the draft the same way and deletes it if it's untouched.
- A delete: if the email is gone on the next look, the Pack counts the delete as its own. The post shows "Deleted", and publishing it again makes a new draft. That holds whoever deleted it: if the Pack's delete didn't land and you deleted the draft yourself before the retry, publishing the post again still makes a new draft. The Pack had read that draft as untouched and was deleting it.
- In every other case, an email that's gone was deleted in Buttondown. The Pack never makes that one again on its own.

A clear "no" from Buttondown (a 4xx or a 429) is never taken for a write that landed.

The hourly task (`buttondown-retry`) runs only while Buttondown Drafts is on. Each run it:

- tries again up to five records that are due;
- finishes a job that was dropped or cut off (every queued job has a time, 5 minutes on, at which the task takes it over);
- finishes a job that ran out of passes (more than three changes to the post while one job ran);
- forgets failed records in collections that have no rule (see below);
- removes records nothing has changed for 180 days: finished ones (left, deleted, stopped, removed) and failures nobody retried.

**When the rules can't be read.** A publish or save then can't tell whether a rule covers the post, so the Pack queues a job for it, in any collection. The job reads the rules again and fails while they still can't be read. Once they read:

- a post in a collection with no rule is forgotten, by its next retry or by the hourly task;
- such a post is never reported by the alert;
- a post a rule does cover gets its draft, if it's new enough for the rule.

With nothing to do, it costs four indexed queries an hour.

**Alerts.** With [Alerts & Digest](alerts.md) on, the **Buttondown draft failed** alert emails you when a draft has been failing for over an hour. At most one email a day while drafts keep failing, and none for a draft that has been failing for over 3 days (the Pack has stopped trying by then). The email says whether the draft couldn't be created, updated or deleted. A failed create or update of a post you have since unpublished, trashed or deleted isn't reported.

## No duplicates, no lost drafts

- Two Worker isolates, or a hook that fires twice: each job claims the post's record first (compare-and-set), and only one claim wins. The other marks the record, and the winner checks once more when it's done.
- A publish fires two hooks (after save and after publish). One job serves both.
- A job that was cut off: its record already has a time for the hourly task, which finishes it. A claim older than 2 minutes is taken over.
- A create whose answer was lost: the retry finds the email by the post's key, whatever its status, and uses it. If the post is unpublished first, the Pack finds the draft the same way and deletes it while it's untouched.
- A delete whose answer was lost: the Pack counts the missing email as its own delete, so the next publish makes a new draft.
- A publish while the post's draft is being deleted: the job checks the post once more when the delete is done, and makes a new draft if the post is live.
- Two gaps are left. Each can only end in a second draft, never a send:
  - A job that runs past its 2-minute claim while the job that takes over doesn't see its just-made draft in Buttondown's list yet. The second draft is shown as a warning on the page and in the panel (with its email id).
  - A create whose answer was lost and that isn't retried until more than three pages of newer API-made emails exist (a refused key, fixed weeks later). The search reads three pages, so the retry can miss the first draft.
- One more needs a change on Buttondown's side: answers the Pack can't read (see [Failures and retries](#failures-and-retries)). Then nothing creates again on its own. A second draft takes an action of yours: **Retry**, **Create draft now**, or unpublishing the post and publishing it again.

## In the admin

The **Buttondown Drafts** page has:

- **Connection**: whether a key is saved, a link to the Settings page, and **Check key**.
- **Turn parts on or off**: the **Update drafts** switch.
- **When to create a draft**: the rules and the footer link.
- **Recent drafts**: the last 20 posts, with their state, warnings and errors, **Open in Buttondown** and **Retry**.

The entry editor's **Buttondown** section (admins only) shows the post's draft in plain words, its warnings and **Open in Buttondown**. It offers:

- **Create draft now**, for a published post that matches and has no draft (or whose draft was deleted). For a post the Pack stopped watching, it checks the draft the post already has and makes no second one;
- **Refresh draft from post**, which reads the draft from Buttondown and asks first: it overwrites changes made in Buttondown, only if the draft hasn't changed again since you were asked, and still refuses an email that isn't a draft;
- **Retry**, after a failure.

**Open in Buttondown** links to `https://buttondown.com/emails/<email id>`.

## Notes

- **Category changes alone do nothing.** EmDash's admin saves a post's categories through a route that fires no plugin hook. Adding the newsletter category to a published post makes its draft on the next publish or save (if it's new enough), or with **Create draft now**.
- **Turning it on** takes effect at once in the isolate that saved, and within five minutes in others, like every switch.
- **Rendering.** Buttondown renders the Markdown when it sends. Tables, nested lists and code blocks look as Buttondown draws them, and the preview can't be read through its API. Preview each draft before sending.
- **Records.** One plugin-storage document per post (`buttondownEmails`, id `<collection>:<entry id>`): the state, the email id, the hash of what was written, Buttondown's `modification_date` after the Pack's last write, when a create or a delete went out unanswered, warnings and the last error. Never the body or the key. A record never holds an order to overwrite: **Refresh draft from post** lives only in the request that asked.
- **Cost of the hooks.** A publish or save in a collection without a rule reads nothing. An unpublish, trash, delete or restore reads the entry's record once, in any collection, because a record can outlive its rule.
- **An update whose answer was lost.** If the Pack's update reached Buttondown but the answer didn't come back, the Pack doesn't know the draft's new `modification_date`. The retry then sees a draft that changed, and marks it "Edited in Buttondown" although the change was the Pack's own. Nothing is lost. Select **Refresh draft from post** to take it back.
- **The site URL.** The post's key holds the site's host. If EmDash can't tell the Pack the site's URL, the job fails and is tried again. It never makes a key from a missing URL.
- **A record that was removed.** After 180 days without a change, a post's record is removed. If the post is published again after that and is new enough for its rule, the Pack makes a new draft and doesn't look for emails older than the new record.
- **Option.** `coywolfPlugin({ buttondown: { database: "DB" } })` names the D1 binding (for the post's terms and File Downloads' files). `buttondown: false` leaves the module out.
- **Cost.** Drafts made through Buttondown's API need no paid add-on (RSS-to-email isn't used). Each image is one Cloudflare image transformation a month, well inside the free 5,000.

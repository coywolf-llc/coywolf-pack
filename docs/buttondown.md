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
4. **Check the key**: on the Buttondown Drafts page, select **Check key**. It should say the key works, can read and write drafts, and can't read your newsletters or subscribers.
5. **Add a rule** under **When to create a draft**: a collection, a taxonomy and its terms. On coywolf.com that's **Posts**, **Categories**, **Coywolf Newsletter**. Save.

From then on, publishing a post with one of the rule's terms (or a child term of one) makes its draft within a few seconds. A scheduled post gets its draft when it goes live, on the site's hourly cron tick.

## Rules

- One rule per collection, up to 10. A rule needs at least one term.
- A post matches when it has one of the rule's terms, or a child term of one (as term feeds count them).
- **Only new posts.** Saving a new or changed rule stamps it with the time (its `since`). Only posts first published at or after that time get a draft on their own. So republishing an old post, such as "Why Claude has my attention", never makes a draft. **Create draft now** in the entry editor makes one for any published post that matches.
- Unpublishing keeps a post's first publish date, so a post that was unpublished and published again still counts as new.
- The footer link ("Read it on coywolf.com") is on by default. Turn it off on the page.

## The key

The Pack needs only **Emails and drafts → Write**. With **Sending → None**, a key that leaks can't send or schedule an email.

**Check key** makes four reads and looks only at their status codes. It never reads the answers' bodies.

| Read | Expected | What it means |
| --- | --- | --- |
| `GET /ping` | 200 | The key works |
| The draft list | 200 | It can read and write drafts |
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
| The category is removed, then the post is saved or published | Stops watching the post. The draft is left as it is |
| Unpublish or trash, the draft is untouched | Deletes the draft (decision D2). Publishing again makes a new one |
| Unpublish or trash, the draft was edited in Buttondown | Keeps the draft. The panel says "Kept because you edited it in Buttondown" |
| Unpublish or trash, the email was scheduled or sent | Leaves it alone |
| Restore from trash | Nothing: EmDash restores the post as a draft. Publish it to make a new draft |
| Permanent delete | Deletes the draft if it's untouched, then stops watching |
| Publish again before a failed delete is retried | The delete is cancelled and the draft is updated instead |
| A category added or removed on its own | Nothing at that moment (see [Notes](#notes)). The next publish or save decides |

"Untouched" means Buttondown's own read, right before the change, shows the email as a draft, with the `modification_date` the Pack recorded after its own last write, and the Pack's key in its metadata.

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
- Ends with a rule and "Read it on coywolf.com", linking to the post (unless you turn that off).

**Images.** Media-library images are resized to 1200 px on the [media host](images.md#setting-up-a-media-host):

- JPEG, PNG and GIF keep their format.
- WebP, HEIC and SVG become JPEG, which every email app shows.
- AVIF can't be resized, and a site without a media host has nothing to resize with: those use the original file, with a warning.
- An image from another site is used as it is, with a warning when it's WebP or AVIF.

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
- an image can't be resized, or is WebP or AVIF from another site;
- the post contains template code (`{{`, `{%` or `{#`). Buttondown runs Django templating when it sends. Check the preview in Buttondown;
- Buttondown has more than one draft for the post (the Pack uses the oldest; delete the others).

## What the Pack never does

- Send, schedule or publish an email. Its API client has no such call, and a guard in front of every call refuses a `send-draft` or `publish` path, a status other than `draft`, and Buttondown's `X-Buttondown-Live-Dangerously` header.
- Change an email that isn't a draft, or one edited in Buttondown (unless you select **Refresh draft from post**, and then only while it's a draft).
- Delete anything but an untouched draft of a post that was unpublished, trashed or deleted. Buttondown's docs say a delete also removes the email from the archive and cancels its scheduled sends, so the Pack reads the email right before every delete and deletes only a draft.
- Call any host but `api.buttondown.com`, read subscribers, or touch automations or other newsletters.
- Log the key, the subject, the body or the description. Logs name the entry, the email id, the state and the status code.

## Failures and retries

| Answer | What happens |
| --- | --- |
| 429 | Waits out a short `Retry-After` (up to 10 seconds) and tries once more. Else the hourly task tries again after `Retry-After`, at least 5 minutes later |
| 5xx, no answer, timeout | Tried again after 5 minutes, 15 minutes, 1 hour, 3 hours, 6 hours, then every 6 hours, for 3 days |
| 401, 403, no key | Not tried again on its own. Once the saved key changes, the hourly task tries again. **Retry** tries now |
| 400, 422 | Shown with Buttondown's error code and message. **Retry** tries again |

Every retry of a create looks in Buttondown first, by the post's key. So a create that reached Buttondown but whose answer was lost is adopted, not made twice.

The hourly task (`buttondown-retry`) runs only while Buttondown Drafts is on. Each run it:

- tries again up to five records that are due;
- finishes a job that was dropped (a record waiting for 5 minutes);
- removes finished records (left, deleted, stopped, removed) older than 180 days.

With nothing to do, it costs four indexed queries an hour.

**Alerts.** With [Alerts & Digest](alerts.md) on, the **Buttondown draft failed** alert emails you when a draft has been failing for over an hour. At most one email a day while drafts keep failing.

## No duplicates, no lost drafts

- Two Worker isolates, or a hook that fires twice: each job claims the post's record first (compare-and-set), and only one claim wins. The other marks the record, and the winner checks once more when it's done.
- A publish fires two hooks (after save and after publish). One job serves both.
- A job that was cut off: its record is already waiting, and the hourly task finishes it. A claim older than 2 minutes is taken over.
- The one gap left: a job that runs past its 2-minute claim while the job that takes over doesn't see its just-made draft in Buttondown's list yet. The result would be a second draft, shown as a warning on the page and in the panel (with its email id). Never a send.

## In the admin

The **Buttondown Drafts** page has:

- **Connection**: whether a key is saved, a link to the Settings page, and **Check key**.
- **Turn parts on or off**: the **Update drafts** switch.
- **When to create a draft**: the rules and the footer link.
- **Recent drafts**: the last 20 posts, with their state, warnings and errors, **Open in Buttondown** and **Retry**.

The entry editor's **Buttondown** section (admins only) shows the post's draft in plain words, its warnings and **Open in Buttondown**. It offers:

- **Create draft now**, for a published post that matches and has no draft (or whose draft was deleted);
- **Refresh draft from post**, which asks first: it overwrites changes made in Buttondown, and still refuses an email that isn't a draft;
- **Retry**, after a failure.

**Open in Buttondown** links to `https://buttondown.com/emails/<email id>`.

## Notes

- **Category changes alone do nothing.** EmDash's admin saves a post's categories through a route that fires no plugin hook. Adding the newsletter category to a published post makes its draft on the next publish or save (if it's new enough), or with **Create draft now**.
- **Turning it on** takes effect at once in the isolate that saved, and within five minutes in others, like every switch.
- **Rendering.** Buttondown renders the Markdown when it sends. Tables, nested lists and code blocks look as Buttondown draws them, and the preview can't be read through its API. Preview each draft before sending.
- **Records.** One plugin-storage document per post (`buttondownEmails`, id `<collection>:<entry id>`): the state, the email id, the hash of what was written, Buttondown's `modification_date` after the Pack's last write, warnings and the last error. Never the body or the key.
- **Option.** `coywolfPlugin({ buttondown: { database: "DB" } })` names the D1 binding (for the post's terms and File Downloads' files). `buttondown: false` leaves the module out.
- **Cost.** Drafts made through Buttondown's API need no paid add-on (RSS-to-email isn't used). Each image is one Cloudflare image transformation a month, well inside the free 5,000.

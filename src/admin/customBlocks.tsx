/**
 * Custom Blocks page: the site's affiliate disclosure wording and podcast
 * links, and live previews of every block (rendered by the same code as the
 * site). Turning blocks on or off happens on the Coywolf Pack page.
 */
import { Banner, Button, Checkbox, Input, InputArea, Select } from "@cloudflare/kumo";
import { FloppyDisk } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { errorText } from "./api.js";
import { PageHeader, Loading } from "./page.js";
import { PreviewSection } from "./preview.js";
import { SaveBar, isDirty } from "./save-bar.js";
import {
	CUSTOM_BLOCKS_CSS,
	DEFAULT_DISCLOSURE,
	DEFAULT_PODCAST,
	type DisclosureSettings,
	MAX_DISCLOSURE_TEXT,
	NOTE_VARIANTS,
	PODCAST_SERVICES,
	type PodcastHeadingTag,
	type PodcastService,
	type PodcastSettings,
	SAMPLE_DETAILS,
	SAMPLE_NOTE,
	SAMPLE_QUOTE,
	SAMPLE_TESTIMONIAL,
	linkUrl,
	normalizeDisclosureSettings,
	normalizePodcastSettings,
	renderDetailsHtml,
	renderDisclosureHtml,
	renderNoteHtml,
	renderPodcastHtml,
	renderQuoteHtml,
	renderTestimonialHtml,
} from "../customBlocks/render.js";
import { safeUrl } from "../customBlocks/rich.js";
import { PartSwitches } from "./feature-switches.js";
import { useSaveResult } from "./toast.js";

const HEADING_ITEMS: Array<{ value: PodcastHeadingTag; label: string }> = [
	{ value: "h2", label: "Heading 2" },
	{ value: "h3", label: "Heading 3" },
	{ value: "h4", label: "Heading 4" },
	{ value: "p", label: "Bold text" },
];

const SAMPLE_PODCAST_LINKS = Object.fromEntries(PODCAST_SERVICES.map(([id]) => [id, "https://example.com/"])) as Record<PodcastService, string>;

const API = "/_emdash/api/plugins/coywolf-pack/customBlocks";

const same = (a: DisclosureSettings, b: DisclosureSettings) =>
	a.affiliateText === b.affiliateText && a.amazonText === b.amazonText && a.linkUrl === b.linkUrl && a.linkText === b.linkText;

export function CustomBlocksPage() {
	const [saved, setSaved] = React.useState<DisclosureSettings | null>(null);
	const [draft, setDraft] = React.useState<DisclosureSettings>(DEFAULT_DISCLOSURE);
	const [podcastSaved, setPodcastSaved] = React.useState<PodcastSettings | null>(null);
	const [podcast, setPodcast] = React.useState<PodcastSettings>(DEFAULT_PODCAST);
	const [error, setError] = React.useState<string | null>(null);
	const result = useSaveResult();
	const [saving, setSaving] = React.useState(false);

	React.useEffect(() => {
		void (async () => {
			try {
				const r = await apiFetch(`${API}/settings`).then((res) =>
					parseApiResponse<{ settings: DisclosureSettings; podcast: PodcastSettings }>(res, "Couldn't load settings"),
				);
				setDraft(r.settings);
				setSaved(r.settings);
				const p = normalizePodcastSettings(r.podcast);
				setPodcast(p);
				setPodcastSaved(p);
			} catch (cause) {
				setError(errorText(cause, "Couldn't load settings"));
			}
		})();
	}, []);

	const disclosureDirty = saved !== null && !same(draft, saved);
	const podcastDirty = isDirty(podcast, podcastSaved);
	const dirty = disclosureDirty || podcastDirty;
	const linkValid = !draft.linkUrl.trim() || Boolean(safeUrl(draft.linkUrl.trim()));
	const tooLong = draft.affiliateText.length > MAX_DISCLOSURE_TEXT || draft.amazonText.length > MAX_DISCLOSURE_TEXT;
	const badPodcastLinks = PODCAST_SERVICES.filter(([id]) => podcast.links[id].trim() && !linkUrl(podcast.links[id])).map(([id]) => id);
	const canSave = linkValid && !tooLong && !badPodcastLinks.length && podcast.heading.length <= 200;
	const set = (patch: Partial<DisclosureSettings>) => setDraft((cur) => ({ ...cur, ...patch }));
	const setPod = (patch: Partial<PodcastSettings>) => setPodcast((cur) => ({ ...cur, ...patch }));
	const setLink = (id: PodcastService, url: string) => setPodcast((cur) => ({ ...cur, links: { ...cur.links, [id]: url } }));

	async function save() {
		if (!saved || !podcastSaved || !canSave) return;
		setSaving(true);
		setError(null);
		result.clear();
		try {
			if (disclosureDirty) {
				const response = await apiFetch(`${API}/settings/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(draft),
				});
				const r = await parseApiResponse<{ settings: DisclosureSettings }>(response, "Couldn't save the disclosure");
				setDraft(r.settings);
				setSaved(r.settings);
			}
			if (podcastDirty) {
				const response = await apiFetch(`${API}/podcast/save`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...podcast, links: Object.fromEntries(PODCAST_SERVICES.map(([id]) => [id, podcast.links[id].trim()])) }),
				});
				const r = await parseApiResponse<{ podcast: PodcastSettings }>(response, "Couldn't save the podcast links");
				setPodcast(r.podcast);
				setPodcastSaved(r.podcast);
			}
			result.saved("Settings saved", "The site picks up changes within a minute.");
		} catch (cause) {
			result.failed(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	}

	// What the site would print with the draft (empty fields fall back to the defaults, as on save).
	const effective = normalizeDisclosureSettings(draft);
	const notes = NOTE_VARIANTS.map(([variant], i) => renderNoteHtml({ ...SAMPLE_NOTE, variant, body: i ? `A ${variant === "editor" ? "note from the editor" : variant}, set apart from the text.` : SAMPLE_NOTE.body }, `cw-note-sample-${variant}`)).join("");
	const disclosures =
		renderDisclosureHtml({ kind: "affiliate", text: "" }, effective) + renderDisclosureHtml({ kind: "amazon", text: "" }, effective);
	const details = renderDetailsHtml(SAMPLE_DETAILS) + renderDetailsHtml({ variant: "transcript", summary: "", body: "<p><abbr title=\"Jon Henshaw\">JH</abbr>: Welcome to the show.</p>\n<p><abbr title=\"Guest\">G</abbr>: Thanks for having me.</p>", open: false });
	const quote = renderQuoteHtml(SAMPLE_QUOTE);
	const testimonial = renderTestimonialHtml(SAMPLE_TESTIMONIAL);
	// What the site would print with the draft; invalid links are left out, as on save.
	const podcastEffective = normalizePodcastSettings(podcast);
	const podcastHasLinks = PODCAST_SERVICES.some(([id]) => podcastEffective.links[id]);
	const podcastHtml = renderPodcastHtml(
		{ source: "site", heading: "", links: podcastEffective.links },
		podcastHasLinks ? podcastEffective : { ...podcastEffective, links: SAMPLE_PODCAST_LINKS },
		"cw-podcast-sample",
	);
	const note = (
		<>
			The previews use this page's fonts and your computer's light or dark setting. On the site the blocks use your theme's fonts and text color.
		</>
	);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Custom Blocks"
				actions={
					<>
						<Button variant="primary" icon={<FloppyDisk />} disabled={!dirty || saving || !canSave} onClick={() => void save()}>
							Save
						</Button>
					</>
				}
				description={
					<>
						Adds Note, Details, Affiliate disclosure, Quote, Testimonial and Podcast links blocks to the editor (turn each one on on the Coywolf Pack page). Their text fields take
						plain text: a blank line starts a new paragraph, <code>[link text](https://…)</code> makes a link and <code>**text**</code> is bold. Simple
						HTML (links, bold, italics, code, lists) works too. The blocks are styled with a little CSS sent only on pages that use them; no script.
					</>
				}
			/>

			<PartSwitches module="customBlocks" />

			{error && <Banner variant="error" role="alert" description={error} />}

			{!saved && !error && (
				<Loading />
			)}

			{saved && (
				<>
					<section aria-labelledby="cw-cb-disclosure" className="grid gap-6 cw-lg-cols-24-fill">
						<div className="space-y-4">
							<div>
								<h2 id="cw-cb-disclosure" className="text-base font-semibold">
									Affiliate disclosure
								</h2>
								<p className="mt-1 text-sm text-kumo-subtle">
									The wording every Affiliate disclosure block shows, unless a block has its own. Put the block before the first affiliate link.
								</p>
							</div>
							<InputArea
								label="Affiliate links"
								rows={3}
								value={draft.affiliateText}
								placeholder={DEFAULT_DISCLOSURE.affiliateText}
								aria-invalid={draft.affiliateText.length > MAX_DISCLOSURE_TEXT || undefined}
								aria-describedby="cw-cb-disclosure-limit"
								onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set({ affiliateText: e.target.value })}
							/>
							<InputArea
								label="Amazon Associates"
								rows={2}
								value={draft.amazonText}
								placeholder={DEFAULT_DISCLOSURE.amazonText}
								aria-invalid={draft.amazonText.length > MAX_DISCLOSURE_TEXT || undefined}
								aria-describedby="cw-cb-disclosure-limit"
								onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set({ amazonText: e.target.value })}
							/>
							<p id="cw-cb-disclosure-limit" className={`text-xs ${tooLong ? "text-kumo-danger" : "text-kumo-subtle"}`}>
								Up to {MAX_DISCLOSURE_TEXT.toLocaleString()} characters each. Amazon requires the words “As an Amazon Associate I earn from qualifying
								purchases.” Empty fields use the wording shown in gray.
							</p>
							<Input
								label="Disclosure page (optional)"
								value={draft.linkUrl}
								placeholder="/disclosures/"
								aria-invalid={!linkValid}
								aria-describedby={linkValid ? undefined : "cw-cb-link-error"}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ linkUrl: e.target.value })}
							/>
							{!linkValid && (
								<p id="cw-cb-link-error" className="text-sm text-kumo-danger" role="alert">
									Use a link like https://example.com/disclosures/ or /disclosures/.
								</p>
							)}
							<Input
								label="Link text"
								value={draft.linkText}
								placeholder={DEFAULT_DISCLOSURE.linkText}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ linkText: e.target.value })}
							/>
						</div>
						<PreviewSection id="cw-cb-disclosure-preview" title="Affiliate disclosure preview" css={CUSTOM_BLOCKS_CSS} html={disclosures} note={note} />
					</section>

					<section aria-labelledby="cw-cb-podcast" className="grid gap-6 border-t border-kumo-line pt-6 cw-lg-cols-24-fill">
						<div className="space-y-4">
							<div>
								<h2 id="cw-cb-podcast" className="text-base font-semibold">
									Podcast links
								</h2>
								<p className="mt-1 text-sm text-kumo-subtle">
									Where people can listen to your podcast. Every Podcast links block shows these, unless a block has its own. Leave a service empty to
									leave it out.
								</p>
							</div>
							<Input
								label="Heading"
								value={podcast.heading}
								placeholder={DEFAULT_PODCAST.heading}
								maxLength={200}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPod({ heading: e.target.value })}
							/>
							<Select
								label="Heading style"
								value={podcast.headingTag}
								onValueChange={(value: string | null) => setPod({ headingTag: (value as PodcastHeadingTag | null) ?? "h2" })}
								items={HEADING_ITEMS}
							/>
							<Checkbox label="Show an icon next to each link" checked={podcast.showIcons} onCheckedChange={(c: boolean) => setPod({ showIcons: c })} />
							{PODCAST_SERVICES.map(([id, label]) => (
								<div key={id}>
									<Input
										label={label}
										value={podcast.links[id]}
										placeholder={id === "rss" ? "https://example.com/podcast.xml" : "https://…"}
										aria-invalid={badPodcastLinks.includes(id)}
										aria-describedby={badPodcastLinks.includes(id) ? `cw-cb-podcast-${id}-error` : undefined}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLink(id, e.target.value)}
									/>
									{badPodcastLinks.includes(id) && (
										<p id={`cw-cb-podcast-${id}-error`} className="mt-1 text-sm text-kumo-danger" role="alert">
											Use a web address like https://example.com/…{id === "rss" ? " or /podcast.xml" : ""}.
										</p>
									)}
								</div>
							))}
						</div>
						<PreviewSection
							id="cw-cb-podcast-preview"
							title="Podcast links preview"
							css={CUSTOM_BLOCKS_CSS}
							html={podcastHtml}
							note={podcastHasLinks ? note : <>No links yet, so the preview shows every service. On the site, a block with no links shows nothing.</>}
						/>
					</section>

					<section aria-labelledby="cw-cb-blocks" className="space-y-6 border-t border-kumo-line pt-6">
						<div>
							<h2 id="cw-cb-blocks" className="text-base font-semibold">
								The other blocks
							</h2>
							<p className="mt-1 text-sm text-kumo-subtle">
								They have no site settings. To restyle them, set the <code>--cw-note-accent</code> custom property or target the{" "}
								<code>.cw-note</code>, <code>.cw-details</code>, <code>.cw-quote</code>, <code>.cw-testimonial</code> and <code>.cw-podcast</code>{" "}
								classes in your theme's CSS.
							</p>
						</div>
						<div className="grid gap-6 lg:grid-cols-2">
							<PreviewSection id="cw-cb-note-preview" title="Note block preview" css={CUSTOM_BLOCKS_CSS} html={notes} />
							<div className="space-y-6">
								<PreviewSection id="cw-cb-details-preview" title="Details block preview" css={CUSTOM_BLOCKS_CSS} html={details} />
								<PreviewSection id="cw-cb-quote-preview" title="Quote block preview" css={CUSTOM_BLOCKS_CSS} html={quote} />
								<PreviewSection id="cw-cb-testimonial-preview" title="Testimonial block preview" css={CUSTOM_BLOCKS_CSS} html={testimonial} note={note} />
							</div>
						</div>
					</section>
				</>
			)}

			<SaveBar error={result.error} dirty={dirty} saving={saving} canSave={canSave} onSave={() => void save()} onDiscard={() => {
					if (saved) setDraft(saved);
					if (podcastSaved) setPodcast(podcastSaved);
				}} />
		</div>
	);
}

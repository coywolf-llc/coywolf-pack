/**
 * Headings & TOC settings: site defaults for heading anchors and the Table
 * of Contents block. Blocks can override most of them. (Breadcrumbs have
 * their own page, Breadcrumb Nav.)
 */
import { Banner, Checkbox, Input, Select } from "@cloudflare/kumo";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { errorText } from "./api.js";
import { PageHeader, Loading } from "./page.js";
import { SAMPLE_TOC_HEADINGS, TOC_CSS, renderTocHtml } from "../headings/render.js";
import { buildTocTree, countToc } from "../headings/toc.js";
import { PreviewSection } from "./preview.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { PartSwitches } from "./feature-switches.js";
import { useSaveResult } from "./toast.js";

const API = "/_emdash/api/plugins/coywolf-pack/headings";

interface Settings {
	prefix: string;
	copyLink: boolean;
	scrollOffset: number;
	scrollUnit: "px" | "rem";
	toc: {
		title: string;
		levels: number[];
		listStyle: "none" | "bulleted" | "numbered";
		display: "open" | "collapsible" | "collapsed";
		minHeadings: number;
		smoothScroll: boolean;
		showTitle: boolean;
	};
}

/** The TOC block with these defaults, on a sample article's headings. */
function TocPreview({ toc }: { toc: Settings["toc"] }) {
	const tree = buildTocTree(SAMPLE_TOC_HEADINGS, toc.levels);
	const count = countToc(tree);
	const hidden = count < toc.minHeadings;
	const html = hidden
		? ""
		: renderTocHtml(tree, { title: toc.title.trim() || "Table of contents", showTitle: toc.showTitle, listStyle: toc.listStyle, display: toc.display, smooth: false, titleId: "cw-toc-preview" });
	return (
		<PreviewSection
			id="cw-toc-preview-title"
			title="Table of Contents preview"
			css={TOC_CSS}
			html={html}
			empty={
				count === 0
					? "Pick at least one heading level to list."
					: `Hidden: the sample lists ${count} heading${count === 1 ? "" : "s"}, fewer than the minimum of ${toc.minHeadings}.`
			}
			note="A sample article's headings with these defaults. On the site the table uses your theme's fonts and link colors."
		/>
	);
}

function Section(props: { title: string; description: string; children: React.ReactNode }) {
	const id = `cw-headings-${props.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={id}>
			<div className="border-b border-kumo-line p-4">
				<h2 id={id} className="text-base font-semibold">
					{props.title}
				</h2>
				<p className="mt-1 text-sm text-kumo-subtle">{props.description}</p>
			</div>
			<div className="space-y-4 p-4">{props.children}</div>
		</section>
	);
}

export function HeadingsPage() {
	const [settings, setSettings] = React.useState<Settings | null>(null);
	const [saved, setSaved] = React.useState<Settings | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const result = useSaveResult();
	const [saving, setSaving] = React.useState(false);

	React.useEffect(() => {
		void (async () => {
			try {
				const response = await apiFetch(`${API}/settings`);
				const loaded = (await parseApiResponse<{ settings: Settings }>(response, "Couldn't load settings")).settings;
				setSettings(loaded);
				setSaved(loaded);
			} catch (cause) {
				setError(errorText(cause, "Couldn't load settings"));
			}
		})();
	}, []);

	const set = (patch: Partial<Settings>) => setSettings((s) => (s ? { ...s, ...patch } : s));
	const setToc = (patch: Partial<Settings["toc"]>) => setSettings((s) => (s ? { ...s, toc: { ...s.toc, ...patch } } : s));

	const dirty = isDirty(settings, saved);

	async function save() {
		if (!settings) return;
		setSaving(true);
		result.clear();
		try {
			const response = await apiFetch(`${API}/settings/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings }),
			});
			const next = (await parseApiResponse<{ settings: Settings }>(response, "Couldn't save")).settings;
			setSettings(next);
			setSaved(next);
			result.saved("Settings saved", "Pages pick them up within a minute.");
		} catch (cause) {
			result.failed(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-6">
			<PageHeader
				title="Headings & TOC"
				description={
					<>
					Defaults for heading anchors and the Table of Contents block. Turn each one on under Plugins → Coywolf Pack. Anchors
					are saved with the content, so they stay the same when a heading is reworded.
					</>
				}
			/>

			<PartSwitches module="headings" />

			{error && <Banner variant="error" role="alert" description={error} />}

			{!settings && !error && (
				<Loading />
			)}

			{settings && (
				<form
					id="cw-headings-form"
					className="space-y-6"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<Section title="Heading anchors" description="Ids added to H2–H6 headings so readers can link to a section.">
						<Input
							label="Id prefix"
							description='Generated ids look like "jump-pricing". Changing the prefix affects new headings only; existing anchors stay put.'
							value={settings.prefix}
							pattern="[A-Za-z][A-Za-z0-9_\-]{0,19}|"
							maxLength={20}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ prefix: e.target.value })}
						/>
						<Checkbox
							label='Show a "copy link to section" button when hovering or focusing a heading'
							checked={settings.copyLink}
							onCheckedChange={(checked: boolean) => set({ copyLink: checked })}
						/>
						<div className="flex flex-wrap items-end gap-3">
							<Input
								label="Scroll offset"
								description="Space kept above a heading you jump to, for sticky headers. 0 for none."
								type="number"
								min={0}
								max={500}
								value={String(settings.scrollOffset)}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ scrollOffset: Number(e.target.value) || 0 })}
							/>
							<Select
								label="Unit"
								value={settings.scrollUnit}
								onValueChange={(value: string | null) => set({ scrollUnit: value === "rem" ? "rem" : "px" })}
								items={[
									{ value: "px", label: "px" },
									{ value: "rem", label: "rem" },
								]}
							/>
						</div>
					</Section>

					<Section title="Table of Contents" description="Defaults for Table of Contents blocks. Each block can override the title (or hide it), levels, list style, and display. Uncheck H3–H6 to list only H2 headings.">
						<Input
							label="Title"
							value={settings.toc.title}
							maxLength={100}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToc({ title: e.target.value })}
						/>
						<Checkbox
							label="Show the title (a collapsible table always shows it, since it's the toggle)"
							checked={settings.toc.showTitle}
							onCheckedChange={(checked: boolean) => setToc({ showTitle: checked })}
						/>
						<fieldset style={{ minWidth: 0 }}>
							<legend className="mb-2 text-sm font-medium">Heading levels</legend>
							<div className="flex flex-wrap gap-4">
								{[2, 3, 4, 5, 6].map((level) => (
									<Checkbox
										key={level}
										label={`H${level}`}
										checked={settings.toc.levels.includes(level)}
										onCheckedChange={(checked: boolean) =>
											setToc({
												levels: checked
													? [...settings.toc.levels, level].sort((a, b) => a - b)
													: settings.toc.levels.filter((l) => l !== level),
											})
										}
									/>
								))}
							</div>
						</fieldset>
						<Select
							label="List style"
							value={settings.toc.listStyle}
							onValueChange={(value: string | null) => setToc({ listStyle: (value ?? "none") as Settings["toc"]["listStyle"] })}
							items={[
								{ value: "none", label: "Plain" },
								{ value: "bulleted", label: "Bulleted" },
								{ value: "numbered", label: "Numbered (1, 1.1, 1.1.1)" },
							]}
						/>
						<Select
							label="Display"
							value={settings.toc.display}
							onValueChange={(value: string | null) => setToc({ display: (value ?? "open") as Settings["toc"]["display"] })}
							items={[
								{ value: "open", label: "Always open" },
								{ value: "collapsible", label: "Collapsible, open" },
								{ value: "collapsed", label: "Collapsible, collapsed" },
							]}
						/>
						<Input
							label="Minimum headings"
							description="Hide the table when it would list fewer headings than this."
							type="number"
							min={1}
							max={10}
							value={String(settings.toc.minHeadings)}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToc({ minHeadings: Number(e.target.value) || 1 })}
						/>
						<Checkbox
							label="Smooth scrolling (skipped for visitors who prefer reduced motion)"
							checked={settings.toc.smoothScroll}
							onCheckedChange={(checked: boolean) => setToc({ smoothScroll: checked })}
						/>
						<TocPreview toc={settings.toc} />
					</Section>

				</form>
			)}

			<SaveBar error={result.error} form="cw-headings-form" dirty={dirty} saving={saving} onDiscard={() => setSettings(saved)} />
		</div>
	);
}

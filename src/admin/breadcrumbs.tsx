/**
 * Breadcrumb Nav: site defaults for the Breadcrumbs block and theme
 * component, with a live preview, plus a step-by-step guide for adding the
 * component to an Astro theme.
 */
import { Banner, Button, Checkbox, Input, Select } from "@cloudflare/kumo";
import { Check, Copy } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { errorText } from "./api.js";
import { FeaturesLink, Loading, PageHeader } from "./page.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { useSaveResult } from "./toast.js";

const API = "/_emdash/api/plugins/coywolf-pack/breadcrumbs";

interface Settings {
	separator: string;
	customSeparator: string;
	homeLabel: string;
	showHome: boolean;
	showCurrent: boolean;
}

const SEPARATORS: Record<string, string> = {
	slash: "/",
	chevron: "›",
	guillemet: "»",
	bullet: "•",
	arrow: "→",
	gt: ">",
};
const SEPARATOR_ITEMS = [
	{ value: "slash", label: "/  Slash" },
	{ value: "chevron", label: "›  Chevron" },
	{ value: "guillemet", label: "»  Guillemet" },
	{ value: "bullet", label: "•  Bullet" },
	{ value: "arrow", label: "→  Arrow" },
	{ value: "gt", label: ">  Greater-than" },
];

function Section(props: { title: string; description: React.ReactNode; children: React.ReactNode; collapsed?: boolean }) {
	const id = `cw-breadcrumbs-${props.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
	if (props.collapsed)
		// Native <details>: the browser's own disclosure triangle and keyboard support; closed until opened.
		return (
			<details className="rounded-lg border border-kumo-line">
				<summary className="cursor-pointer p-4" style={{ display: "list-item" }}>
					<h2 id={id} className="text-base font-semibold" style={{ display: "inline" }}>
						{props.title}
					</h2>
					<span className="mt-1 block text-sm text-kumo-subtle">{props.description}</span>
				</summary>
				<div className="space-y-4 border-t border-kumo-line p-4">{props.children}</div>
			</details>
		);
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

/** A trail the way the component renders it, with the current settings. */
function Preview({ settings }: { settings: Settings }) {
	const separator = settings.customSeparator || SEPARATORS[settings.separator] || "/";
	const trail = [
		...(settings.showHome ? [{ name: settings.homeLabel.trim() || "Home", current: false }] : []),
		{ name: "Recipes", current: false },
		...(settings.showCurrent ? [{ name: "Overnight oats", current: true }] : []),
	];
	return (
		<div>
			<p className="mb-2 text-sm font-medium">Preview</p>
			<div className="rounded-md border border-kumo-line bg-kumo-tint px-4 py-3 text-sm" aria-live="polite">
				{trail.length < 2 ? (
					<span className="text-kumo-subtle">No trail: a single crumb isn't shown.</span>
				) : (
					<ol className="m-0 flex list-none flex-wrap items-center p-0" aria-label="Breadcrumb preview">
						{trail.map((crumb, i) => (
							<li key={crumb.name + i} className="inline-flex items-center">
								{i > 0 && (
									<span className="px-2 opacity-60" aria-hidden="true">
										{separator}
									</span>
								)}
								{crumb.current ? <span className="font-semibold">{crumb.name}</span> : <span className="text-kumo-link underline">{crumb.name}</span>}
							</li>
						))}
					</ol>
				)}
			</div>
		</div>
	);
}

/** A code sample with a Copy button. */
function Code({ code, label }: { code: string; label: string }) {
	const [status, setStatus] = React.useState<"" | "copied" | "failed">("");
	const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	React.useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
	}, []);
	async function copy() {
		try {
			await navigator.clipboard.writeText(code);
			setStatus("copied");
		} catch {
			setStatus("failed");
		}
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setStatus(""), 2000);
	}
	return (
		<div className="relative min-w-0">
			<pre className="overflow-x-auto rounded-md border border-kumo-line bg-kumo-tint p-3 cw-pe-24 text-xs leading-5" aria-label={label}>
				<code>{code}</code>
			</pre>
			<div className="absolute end-2 top-2 flex items-center gap-2">
				<span className="sr-only" aria-live="polite">
					{status === "copied" ? `${label} copied` : status === "failed" ? "Couldn't copy. Select the code and copy it instead." : ""}
				</span>
				<Button variant="secondary" size="sm" icon={status === "copied" ? <Check /> : <Copy />} onClick={() => void copy()} aria-label={`Copy ${label}`}>
					{status === "copied" ? "Copied" : status === "failed" ? "Failed" : "Copy"}
				</Button>
			</div>
		</div>
	);
}

function Step(props: { n: number; title: string; children: React.ReactNode }) {
	return (
		<li className="space-y-3">
			<h3 className="text-sm font-semibold">
				<span className="me-2 inline-flex size-6 items-center justify-center rounded-full border border-kumo-line text-xs" aria-hidden="true">
					{props.n}
				</span>
				{props.title}
			</h3>
			<div className="space-y-3 text-sm">{props.children}</div>
		</li>
	);
}

const C = (props: { children: React.ReactNode }) => <code className="rounded bg-kumo-tint px-1 py-0.5 text-xs">{props.children}</code>;

const IMPORT_CODE = `import { Breadcrumbs } from "@coywolf/emdash/astro";`;

const LAYOUT_CODE = `---
// src/layouts/Base.astro
import { EmDashHead } from "emdash/ui";
import { createPublicPageContext } from "emdash/page";
import { Breadcrumbs } from "@coywolf/emdash/astro";

const { title, breadcrumbs } = Astro.props;

const page = createPublicPageContext({
  Astro,
  kind: "custom",
  title,
  pageTitle: title,
  breadcrumbs, // optional: see step 3
});
---
<html lang="en">
  <head>
    <EmDashHead page={page} />
  </head>
  <body>
    <header><!-- site header --></header>
    <Breadcrumbs page={page} />
    <main><slot /></main>
  </body>
</html>`;

const TRAIL_CODE = `---
// A post page, e.g. src/pages/[category]/[slug].astro,
// after loading the entry and its category the way your theme does.
import { createPublicPageContext } from "emdash/page";

const page = createPublicPageContext({
  Astro,
  kind: "content",
  content: { collection: "posts", id: entry.id, slug: entry.slug },
  title: \`\${entry.data.title} | My Site\`,
  pageTitle: entry.data.title,
  // Root first, current page last.
  breadcrumbs: [
    { name: "Home", url: "/" },
    { name: category.label, url: \`/\${category.slug}/\` },
    { name: entry.data.title, url: Astro.url.pathname },
  ],
});
---
<!-- Renders: Home › Breakfast › Overnight oats -->`;

const LAYOUT_PROP_CODE = `<Base
  title={entry.data.title}
  breadcrumbs={[
    { name: "Home", url: "/" },
    { name: category.label, url: \`/\${category.slug}/\` },
    { name: entry.data.title, url: Astro.url.pathname },
  ]}
>`;

const HIDE_CODE = `// Home page (or any page that shouldn't show a trail)
const page = createPublicPageContext({ Astro, kind: "custom", breadcrumbs: [] });`;

const PROPS_CODE = `<Breadcrumbs page={page} separator="chevron" showHome={false} class="site-crumbs" />

<!-- Or a trail of your own, without a page context: -->
<Breadcrumbs
  items={[{ name: "Docs", url: "/docs/" }, { name: "Install", url: "/docs/install/" }]}
  separator="|"
  label="You are here"
/>`;

const MARKUP_CODE = `<nav class="cw-breadcrumbs cw-breadcrumbs--sep-chevron" aria-label="Breadcrumb">
  <ol class="cw-breadcrumbs__list">
    <li class="cw-breadcrumbs__item"><a href="/">Home</a></li>
    <li class="cw-breadcrumbs__item"><a href="/breakfast/">Breakfast</a></li>
    <li class="cw-breadcrumbs__item">
      <span class="cw-breadcrumbs__current" aria-current="page">Overnight oats</span>
    </li>
  </ol>
</nav>`;

const CSS_CODE = `/* In your theme's stylesheet. Prefix with a parent (or use the class prop)
   so these win over the component's single-class rules in any order. */
.site-header .cw-breadcrumbs {
  font-size: 0.8125rem;
  margin-block: 1rem;
}
.site-header .cw-breadcrumbs a {
  color: inherit;
  text-decoration: none;
}
.site-header .cw-breadcrumbs a:hover {
  text-decoration: underline;
}
.site-header .cw-breadcrumbs__current {
  font-weight: 400;
  opacity: 0.8;
}
/* Separator from CSS (the separator setting or prop is simpler;
   a custom separator is set inline and wins over this) */
.site-header .cw-breadcrumbs {
  --cw-bc-sep: "\\2014";
}`;

const PROPS: { name: string; type: string; description: React.ReactNode }[] = [
	{
		name: "page",
		type: "PublicPageContext",
		description: (
			<>
				The context you pass to <C>{"<EmDashHead page={page} />"}</C>. Its <C>breadcrumbs</C> is the trail and its <C>pageTitle</C> (or{" "}
				<C>title</C>) names the current page when the trail is derived from the URL.
			</>
		),
	},
	{ name: "items", type: "{ name, url }[]", description: <>An explicit trail, root first. Wins over <C>page</C>. <C>[]</C> renders nothing.</> },
	{
		name: "separator",
		type: "string",
		description: (
			<>
				A preset (<C>slash</C>, <C>chevron</C>, <C>guillemet</C>, <C>bullet</C>, <C>arrow</C>, <C>gt</C>) or any string up to 8 characters. Default: the
				Separator setting.
			</>
		),
	},
	{ name: "homeLabel", type: "string", description: <>Name of the Home crumb the component adds (to derived trails, or when a trail doesn't start at <C>/</C>). Default: the Home label setting.</> },
	{ name: "showHome", type: "boolean", description: "Start the trail with the home page. Default: the setting." },
	{ name: "showCurrent", type: "boolean", description: "End the trail with the current page. Default: the setting." },
	{ name: "class", type: "string", description: <>Extra classes on the <C>{"<nav>"}</C>.</> },
	{ name: "label", type: "string", description: <>The nav's accessible name (<C>aria-label</C>). Default: “Breadcrumb”.</> },
	{ name: "title", type: "string", description: <>Current page title for a derived trail when neither <C>items</C> nor <C>page</C> gives one.</> },
];

const CLASSES: { name: string; description: React.ReactNode }[] = [
	{ name: ".cw-breadcrumbs", description: <>The <C>{"<nav>"}</C>. Sets <C>font-size: 0.875em</C> and <C>line-height: 1.4</C>.</> },
	{ name: ".cw-breadcrumbs--sep-<preset>", description: <>Added for a preset separator, e.g. <C>.cw-breadcrumbs--sep-chevron</C>.</> },
	{ name: ".cw-breadcrumbs__list", description: <>The <C>{"<ol>"}</C>: a wrapping flex row with no list styling.</> },
	{ name: ".cw-breadcrumbs__item", description: <>Each <C>{"<li>"}</C>. The separator is its <C>::before</C> (0.5em padding each side, 60% opacity), hidden from screen readers.</> },
	{ name: ".cw-breadcrumbs__current", description: <>The current page: a <C>{"<span aria-current=\"page\">"}</C>, semibold. Ancestors are plain <C>{"<a>"}</C> links in your theme's link color.</> },
	{ name: "--cw-bc-sep", description: <>Custom property holding the separator as a CSS string, e.g. <C>{'"›"'}</C>. Custom separators set it inline.</> },
];

export function BreadcrumbsPage() {
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
				title="Breadcrumb Nav"
				description={
					<>
					An accessible breadcrumb trail for your pages, as a component in your theme's layout or as a Breadcrumbs block in content.
					These defaults apply to both; the component's props and each block can override them.
					</>
				}
			/>

			{error && <Banner variant="error" role="alert" description={error} />}

			{!settings && !error && (
				<Loading />
			)}

			{settings && (
				<form
					id="cw-breadcrumbs-form"
					className="space-y-6"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<Section title="Settings" description="How trails look by default.">
						<Preview settings={settings} />
						<Select
							label="Separator"
							value={settings.separator}
							onValueChange={(value: string | null) => set({ separator: value ?? "slash" })}
							items={SEPARATOR_ITEMS}
						/>
						<Input
							label="Custom separator"
							description="Up to 8 characters, e.g. | or ::. Overrides the separator above when set."
							value={settings.customSeparator}
							maxLength={8}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ customSeparator: e.target.value })}
						/>
						<Input
							label="Home label"
							description="Name of the first crumb when the trail starts with the home page."
							value={settings.homeLabel}
							maxLength={60}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ homeLabel: e.target.value })}
						/>
						<fieldset className="min-w-0">
							<legend className="mb-2 text-sm font-medium">Trail</legend>
							<div className="flex flex-col items-start gap-3">
								<Checkbox
									label="Start the trail with the home page"
									checked={settings.showHome}
									onCheckedChange={(checked: boolean) => set({ showHome: checked })}
								/>
								<Checkbox
									label="End the trail with the current page"
									checked={settings.showCurrent}
									onCheckedChange={(checked: boolean) => set({ showCurrent: checked })}
								/>
							</div>
						</fieldset>
					</Section>
				</form>
			)}

			<Section
				collapsed
				title="Add the breadcrumb nav to your Astro theme"
				description={
					<>
						Put the Breadcrumbs component in a layout once and every page that uses the layout gets a trail. Nothing renders while Breadcrumb Nav is turned
						off on <FeaturesLink />.
					</>
				}
			>
				<ol className="grid gap-8">
					<Step n={1} title="Import the component">
						<p>In the layout (or page) where the trail should appear:</p>
						<Code label="Import" code={IMPORT_CODE} />
					</Step>

					<Step n={2} title="Place it in your layout">
						<p>
							Pass it the same <C>page</C> object you give <C>{"<EmDashHead page={page} />"}</C> (the <C>PublicPageContext</C> from{" "}
							<C>createPublicPageContext</C>). Put it where the trail should show, usually just above the main content.
						</p>
						<Code label="Layout example" code={LAYOUT_CODE} />
						<p className="text-kumo-subtle">
							Without a trail of your own, the component derives one from the URL: Home, one crumb per path segment with a readable
							name (<C>/healthy-recipes/</C> becomes “Healthy recipes”), then the page title from <C>pageTitle</C>.
						</p>
					</Step>

					<Step n={3} title="Pass an explicit trail (recommended)">
						<p>
							Derived ancestors link to whatever the path segments are, which may not be real pages. Give each page its real trail with{" "}
							<C>breadcrumbs</C>: <C>{"{ name, url }"}</C> items, root first, current page last.
						</p>
						<Code label="Post page example" code={TRAIL_CODE} />
						<p>If your layout builds the context, pass the trail to it as a prop instead:</p>
						<Code label="Layout prop example" code={LAYOUT_PROP_CODE} />
						<ul className="list-disc space-y-1 ps-5">
							<li>
								<C>breadcrumbs: []</C> hides the trail on that page (the home page, a landing page):
							</li>
						</ul>
						<Code label="Hide example" code={HIDE_CODE} />
						<ul className="list-disc space-y-1 ps-5">
							<li>Leave <C>breadcrumbs</C> out to derive the trail from the URL.</li>
							<li>URLs can be root-relative (<C>/breakfast/</C>) or absolute.</li>
							<li>“Start with the home page” and “End with the current page” trim or add those crumbs when the trail renders.</li>
						</ul>
					</Step>

					<Step n={4} title="Adjust it with props (optional)">
						<p>Props override the settings above for that one placement.</p>
						<div className="overflow-x-auto">
							<table className="w-full text-start text-sm">
								<thead className="text-kumo-subtle">
									<tr>
										<th scope="col" className="py-1 cw-pe-4 font-medium">Prop</th>
										<th scope="col" className="py-1 cw-pe-4 font-medium">Type</th>
										<th scope="col" className="py-1 font-medium">What it does</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-kumo-line">
									{PROPS.map((p) => (
										<tr key={p.name} className="align-top">
											<td className="whitespace-nowrap py-2 cw-pe-4"><C>{p.name}</C></td>
											<td className="whitespace-nowrap py-2 cw-pe-4 text-kumo-subtle">{p.type}</td>
											<td className="py-2">{p.description}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<p>
							The trail comes from, in order: <C>items</C>, <C>page.breadcrumbs</C>, the trail the theme gave <C>EmDashHead</C> for the
							same URL, then the URL path.
						</p>
						<Code label="Props example" code={PROPS_CODE} />
					</Step>

					<Step n={5} title="Style it (optional)">
						<p>
							The component outputs this markup (separators are CSS, so screen readers skip them) with a small global stylesheet that
							inherits your theme's colors and font:
						</p>
						<Code label="Markup" code={MARKUP_CODE} />
						<div className="overflow-x-auto">
							<table className="w-full text-start text-sm">
								<thead className="text-kumo-subtle">
									<tr>
										<th scope="col" className="py-1 cw-pe-4 font-medium">Class or property</th>
										<th scope="col" className="py-1 font-medium">What it is</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-kumo-line">
									{CLASSES.map((c) => (
										<tr key={c.name} className="align-top">
											<td className="whitespace-nowrap py-2 cw-pe-4"><C>{c.name}</C></td>
											<td className="py-2">{c.description}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<Code label="CSS override example" code={CSS_CODE} />
					</Step>

					<Step n={6} title="Get matching breadcrumb schema">
						<p>
							With Schema &amp; Social's <strong>Breadcrumb schema</strong> feature on, the page's <C>BreadcrumbList</C> is built from the
							same <C>page.breadcrumbs</C>, so passing the trail once (step 3) keeps the visible nav and the structured data in agreement.
						</p>
						<ul className="list-disc space-y-1 ps-5">
							<li>The schema uses the trail as given (relative URLs made absolute), so include Home first and the current page last.</li>
							<li><C>breadcrumbs: []</C> removes both the nav and the BreadcrumbList on that page.</li>
							<li>
								Without a trail, both derive from the URL. The schema's home label is set on the Schema page; keep it the same as the
								Home label here.
							</li>
						</ul>
					</Step>

					<Step n={7} title="Or insert a Breadcrumbs block in content">
						<p>
							No theme changes needed: in the editor, add a <strong>Breadcrumbs</strong> block (Sections) where the trail should
							appear. Each block can override the separator, home label, and whether the current page shows.
						</p>
						<p className="text-kumo-subtle">
							The block uses the trail the theme gave <C>EmDashHead</C> for the page (when the theme passes its real URL), otherwise
							one derived from the URL, with the entry's title (saved with the block) as the last crumb.
						</p>
					</Step>
				</ol>
			</Section>

			<SaveBar error={result.error} form="cw-breadcrumbs-form" dirty={dirty} saving={saving} onDiscard={() => setSettings(saved)} />
		</div>
	);
}

/**
 * The Performance page's Speculation Rules card: the module's switch (it has
 * no page of its own, so the switch is here as well as on the Features page),
 * when to prefetch, optional prerendering, and paths never to fetch ahead.
 * Saving clears the cached pages (every one carries the rules).
 */
import { Badge, Banner, Button, InputArea, Select, Switch } from "@cloudflare/kumo";
import * as React from "react";

import { PACK_API, apiGet, apiPost, errorText } from "./api.js";
import { DocsLink, PackLink } from "./page.js";
import { useToast } from "./toast.js";

type Eagerness = "conservative" | "moderate" | "eager";
type Prerender = "off" | "conservative" | "moderate";

interface Settings {
	eagerness: Eagerness;
	prerender: Prerender;
	exclude: string[];
}

interface State {
	enabled: boolean;
	settings: Settings;
	defaults: Settings;
	downloadBase: string | null;
	rules: unknown;
}

const get = apiGet(`${PACK_API}/speculation`, { fallback: "Couldn't load Speculation Rules" });
const post = apiPost(`${PACK_API}/speculation`, { fallback: "Couldn't save" });
const saveFeature = apiPost(`${PACK_API}/features`, { fallback: "Couldn't save the switch" });

const EAGERNESS: Array<{ value: Eagerness; label: string }> = [
	{ value: "moderate", label: "When a visitor hovers over a link (recommended)" },
	{ value: "conservative", label: "When a visitor presses a link" },
	{ value: "eager", label: "Soon after a link is seen (the most requests)" },
];

const PRERENDER: Array<{ value: Prerender; label: string }> = [
	{ value: "off", label: "Off (recommended)" },
	{ value: "conservative", label: "When a visitor presses a link" },
	{ value: "moderate", label: "When a visitor hovers over a link" },
];

const lines = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

export function SpeculationCard() {
	const toast = useToast();
	const [state, setState] = React.useState<State | null>(null);
	const [draft, setDraft] = React.useState<{ eagerness: Eagerness; prerender: Prerender; exclude: string } | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState<"switch" | "save" | null>(null);

	const load = React.useCallback(async () => {
		try {
			const next = await get<State>("settings");
			setState(next);
			setDraft({ eagerness: next.settings.eagerness, prerender: next.settings.prerender, exclude: next.settings.exclude.join("\n") });
			setError(null);
		} catch (cause) {
			setError(errorText(cause, "Couldn't load Speculation Rules"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const toggle = async (on: boolean) => {
		setBusy("switch");
		try {
			await saveFeature("save", { features: { speculation: on } });
			await load();
			toast.success(on ? "Speculation Rules is on" : "Speculation Rules is off", on ? "Cached pages were cleared; each gets the rules as it's cached again." : undefined);
		} catch (cause) {
			toast.error("Couldn't change Speculation Rules", errorText(cause, "Couldn't save the switch"));
		} finally {
			setBusy(null);
		}
	};

	const save = async () => {
		if (!draft) return;
		setBusy("save");
		try {
			await post("save", { eagerness: draft.eagerness, prerender: draft.prerender, exclude: lines(draft.exclude) });
			await load();
			toast.success("Speculation Rules saved", "Cached pages were cleared, so new visits get the new rules.");
		} catch (cause) {
			toast.error("Couldn't save", errorText(cause, "Couldn't save"));
		} finally {
			setBusy(null);
		}
	};

	const saved = state?.settings;
	const dirty = Boolean(
		saved && draft && (saved.eagerness !== draft.eagerness || saved.prerender !== draft.prerender || saved.exclude.join("\n") !== lines(draft.exclude).join("\n")),
	);
	const on = Boolean(state?.enabled);

	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby="cw-speculation-title">
			<div className={`flex flex-wrap items-start justify-between gap-4 p-4${on || error ? " border-b border-kumo-line" : ""}`}>
				<div className="min-w-0 max-w-2xl">
					<h2 id="cw-speculation-title" className="flex items-center gap-2 text-base font-semibold">
						Speculation Rules
						{state && <Badge variant={on ? "primary" : "secondary"}>{on ? "On" : "Off"}</Badge>}
					</h2>
					<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
						Browsers that support it (Chrome, Edge and other Chromium browsers) fetch a page as soon as a visitor is about to open it, so the next page appears almost
						at once. Prefetched pages come from Cloudflare's edge cache like any visit. Cloudflare's Speed Brain can't do this here: it skips pages served by a
						Worker (see <PackLink page="/cloudflare">Cloudflare Checkup</PackLink>).
					</p>
				</div>
				<Switch
					className="shrink-0"
					aria-label={`Speculation Rules: ${on ? "on" : "off"}`}
					checked={on}
					disabled={!state || busy !== null}
					transitioning={busy === "switch"}
					onCheckedChange={(next) => void toggle(next)}
				/>
			</div>
			{error && (
				<div className="p-4">
					<Banner variant="error" role="alert" description={error} />
				</div>
			)}
			{on && draft && state && (
				<div className="grid gap-4 p-4">
					<Banner
						variant="default"
						description={
							<>
								If your theme already has its own <code>&lt;script type="speculationrules"&gt;</code> (in <code>src/layouts/Base.astro</code>), remove it, or
								pages carry two rule sets. See <DocsLink doc="performance#speculation-rules">the Performance docs</DocsLink>.
							</>
						}
					/>
					<div className="grid gap-4 sm:grid-cols-2">
						<Select
							label="Prefetch a page"
							value={draft.eagerness}
							onValueChange={(value: string | null) => value && setDraft((d) => (d ? { ...d, eagerness: value as Eagerness } : d))}
							items={EAGERNESS}
						/>
						<Select
							label="Prerender a page"
							value={draft.prerender}
							onValueChange={(value: string | null) => value && setDraft((d) => (d ? { ...d, prerender: value as Prerender } : d))}
							items={PRERENDER}
						/>
					</div>
					<p className="max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
						Prefetching downloads the page only. Prerendering also builds it in the background, scripts included, so it shows instantly, but it uses more data and
						runs the page's scripts before the visitor arrives. Fathom's script waits until a prerendered page is actually shown before it counts a view (checked
						November 2026); check any other analytics or scripts on your pages before turning prerendering on.
					</p>
					<InputArea
						label="Never fetch these paths ahead"
						description={`One per line, such as /visit/* for affiliate links (* matches anything). Always left out: EmDash's admin, URLs with a query string, links to files (PDFs, images, feeds), nofollow and sponsored links, download links${state.downloadBase ? `, /${state.downloadBase}/* (File Downloads)` : ""}, and anything with the no-prefetch class (no-prerender: prefetched, never prerendered).`}
						rows={3}
						value={draft.exclude}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft((d) => (d ? { ...d, exclude: e.target.value } : d))}
					/>
					<details className="rounded-md border border-kumo-line text-sm">
						<summary className="cursor-pointer px-3 py-2 font-medium" style={{ display: "list-item" }}>
							The rule set on every page (as saved)
						</summary>
						<pre className="overflow-x-auto border-t border-kumo-line px-3 py-3 text-xs">{JSON.stringify(state.rules, null, 2)}</pre>
					</details>
					<div className="flex flex-wrap gap-2">
						<Button variant="primary" disabled={!dirty || busy !== null} onClick={() => void save()}>
							{busy === "save" ? "Saving…" : "Save"}
						</Button>
						{dirty && (
							<Button
								variant="secondary"
								disabled={busy !== null}
								onClick={() => setDraft({ eagerness: state.settings.eagerness, prerender: state.settings.prerender, exclude: state.settings.exclude.join("\n") })}
							>
								Discard
							</Button>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

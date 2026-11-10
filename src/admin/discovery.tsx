/**
 * Discovery admin page: Crawler Hints (read from Cloudflare), and the news sitemap, the RSS
 * feed, and llms.txt settings and status.
 */
import { Badge, Banner, Button, Checkbox, Input, InputArea } from "@cloudflare/kumo";
import { ArrowClockwise, ArrowSquareOut } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { apiPost, errorText } from "./api.js";
import { PageHeader, Loading } from "./page.js";
import { FEATURES_CHANGED, PartSwitch, useParts } from "./feature-switches.js";
import { CredentialGuide } from "./guides.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { useSaveResult } from "./toast.js";

const API = "/_emdash/api/plugins/coywolf-pack/discovery";

const post = apiPost(API);

interface Settings {
	news: { collections: string[]; publicationName: string; language: string };
	feed: { collections: string[]; items: number; termFeeds: boolean };
	llms: { summary: string; intro: string; collections: string[]; maxEntries: number; markdown: boolean; license: string };
}

interface Status {
	features: { news: boolean; llms: boolean; feed: boolean };
	settings: Settings;
	collections: { slug: string; label: string; hidden: boolean; hasSeo: boolean }[];
	urls: { news: string; llms: string; feed: string };
	cache: { llms: { count: number; builtAt: string } | null; news: { count: number; builtAt: string } | null };
}

/** Crawler Hints as read from Cloudflare (src/discovery/crawler-hints.ts). */
interface CrawlerHints {
	enabled: boolean | null;
	host: string;
	zone: { id: string; name: string; accountId: string | null } | null;
	dashboardUrl: string;
	problem?: { kind: "no-token" | "bad-token" | "no-zone" | "no-access" | "error"; message: string };
	checkedAt: string;
}

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/** A part of Discovery (News sitemap, RSS feed, llms.txt), with its on/off switch next to the title. */
function Section(props: { title: string; part: string; parts: ReturnType<typeof useParts>; description: string; children: React.ReactNode; actions?: React.ReactNode }) {
	const { parts } = props;
	// Off: only the title, switch and description; its details and settings show once it's on. Until the switches have
	// loaded nothing below shows either (no flash of settings that then disappear), unless they couldn't be loaded.
	const open = parts.parts ? parts.isOn(props.part) : Boolean(parts.error);
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={`discovery-${props.title}`}>
			<div className={`flex flex-wrap items-start justify-between gap-4 p-4${open ? " border-b border-kumo-line" : ""}`}>
				<div className="min-w-0">
					<h2 id={`discovery-${props.title}`} className="flex items-center gap-2 text-base font-semibold">
						{props.title}
						<PartSwitch
							part={parts.parts?.find((p) => p.id === props.part)}
							mainOn={Boolean(parts.main?.enabled)}
							saving={parts.saving}
							onToggle={(id, on) => void parts.toggle(id, on)}
						/>
					</h2>
					<p className="mt-1 text-sm text-kumo-subtle">{props.description}</p>
				</div>
				{open && props.actions && <div className="flex flex-wrap gap-2">{props.actions}</div>}
			</div>
			{open && <div className="space-y-4 p-4">{props.children}</div>}
		</section>
	);
}

function ExternalLink(props: { href: string }) {
	return (
		<a className="inline-flex items-center gap-1 break-all text-sm text-kumo-link underline" href={props.href} target="_blank" rel="noreferrer">
			{props.href}
			<ArrowSquareOut aria-hidden="true" className="shrink-0" />
		</a>
	);
}

function CollectionPicker(props: {
	legend: string;
	hint: string;
	collections: Status["collections"];
	value: string[];
	onChange: (value: string[]) => void;
}) {
	return (
		<fieldset style={{ minWidth: 0 }}>
			<legend className="text-sm font-medium">{props.legend}</legend>
			<p className="mt-0.5 text-sm text-kumo-subtle">{props.hint}</p>
			<div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
				{props.collections.map((c) => (
					<Checkbox
						key={c.slug}
						label={c.label}
						checked={props.value.includes(c.slug)}
						onCheckedChange={(checked: boolean) =>
							props.onChange(checked ? [...props.value, c.slug] : props.value.filter((s) => s !== c.slug))
						}
					/>
				))}
			</div>
		</fieldset>
	);
}

const when = (iso: string | undefined) => (iso ? dateTime.format(new Date(iso)) : "never");

/**
 * Crawler Hints: Cloudflare's own IndexNow integration, a setting of the site's zone. Read with the read-only
 * Cloudflare API token; Cloudflare doesn't let API tokens change it, so the switch is a link to the dashboard.
 * Without a token, or with one that can't read the zone, it says what to add (and nothing when it can read it).
 */
function CrawlerHintsCard() {
	const [data, setData] = React.useState<CrawlerHints>();
	const [error, setError] = React.useState<string>();
	const [loading, setLoading] = React.useState(true);

	const load = React.useCallback(async () => {
		setLoading(true);
		setError(undefined);
		try {
			setData(await parseApiResponse<CrawlerHints>(await apiFetch(`${API}/crawler-hints`), "Couldn't read Crawler Hints"));
		} catch (cause) {
			setError(errorText(cause, "Couldn't read Crawler Hints"));
		} finally {
			setLoading(false);
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const on = data?.enabled === true;
	const off = data?.enabled === false;
	const zone = data?.zone?.name;
	const needsToken = data?.problem && (data.problem.kind === "no-token" || data.problem.kind === "bad-token" || data.problem.kind === "no-zone");
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby="discovery-crawler-hints" aria-busy={loading}>
			<div className={`flex flex-wrap items-start justify-between gap-4 p-4${data?.problem || error ? " border-b border-kumo-line" : ""}`}>
				<div className="min-w-0 max-w-2xl">
					<h2 id="discovery-crawler-hints" className="flex items-center gap-2 text-base font-semibold">
						Crawler Hints
						{on && <Badge variant="primary">On</Badge>}
						{off && <Badge variant="secondary">Off</Badge>}
					</h2>
					<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
						Cloudflare tells Bing, Yandex, Seznam, Naver and the other IndexNow engines when a page has likely changed: whenever it fetches a fresh copy into its cache.
						It's a setting of the site's Cloudflare zone{zone ? ` (${zone}, every hostname in it)` : ""}, sent from Cloudflare's own systems, so it isn't throttled
						the way IndexNow pings from Workers are. Only the Cloudflare dashboard can switch it.
					</p>
					{off && <p className="mt-2 text-sm leading-5 text-pretty">It's off: search engines aren't told about changes. Turn it on in Cloudflare (Caching → Configuration → Crawler Hints).</p>}
					<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
						<a className="inline-flex items-center gap-1 font-medium text-kumo-link underline" href={data?.dashboardUrl ?? "https://dash.cloudflare.com/?to=/:account/:zone/caching/configuration"} target="_blank" rel="noreferrer">
							{off ? "Turn on in Cloudflare" : "Open in Cloudflare"}
							<ArrowSquareOut aria-hidden="true" className="shrink-0" />
						</a>
						{data && !data.zone && <span className="text-kumo-subtle">The dashboard asks for your account and the site's domain first.</span>}
					</div>
				</div>
				<Button className="shrink-0" variant="secondary" icon={<ArrowClockwise />} disabled={loading} onClick={() => void load()}>
					{loading ? "Checking…" : "Check again"}
				</Button>
			</div>
			<p className="sr-only" role="status">
				{loading ? "Checking Crawler Hints…" : on ? "Crawler Hints is on." : off ? "Crawler Hints is off." : ""}
			</p>
			{(error || data?.problem) && (
				<div className="space-y-3 p-4">
					<Banner variant={data?.problem?.kind === "error" || error ? "error" : "default"} description={error ?? data?.problem?.message} />
					{needsToken && (
						<div className="sm:max-w-md">
							<CredentialGuide id="crawler-hints-token" />
						</div>
					)}
				</div>
			)}
		</section>
	);
}

export function DiscoveryPage() {
	const [status, setStatus] = React.useState<Status>();
	const [draft, setDraft] = React.useState<Settings>();
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const result = useSaveResult();
	const [busy, setBusy] = React.useState<string | null>(null);
	const parts = useParts("discovery");

	/** The status only (the draft is kept). */
	const refresh = React.useCallback(
		() =>
			apiFetch(`${API}/status`)
				.then((response) => parseApiResponse<Status>(response, "Couldn't load Discovery"))
				.then(setStatus)
				.catch(() => undefined),
		[],
	);

	const load = React.useCallback(async () => {
		try {
			const data = await parseApiResponse<Status>(await apiFetch(`${API}/status`), "Couldn't load Discovery");
			setStatus(data);
			setDraft(data.settings);
		} catch (cause) {
			setError(errorText(cause, "Couldn't load Discovery"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	// A part switched on this page: its status (stored copies) may have changed. The draft is kept.
	React.useEffect(() => {
		const reload = () => void refresh();
		window.addEventListener(FEATURES_CHANGED, reload);
		return () => window.removeEventListener(FEATURES_CHANGED, reload);
	}, [refresh]);

	async function run(name: string, task: () => Promise<string>) {
		setBusy(name);
		setError(undefined);
		setNotice(undefined);
		try {
			setNotice(await task());
			await load();
		} catch (cause) {
			setError(errorText(cause, "Something went wrong"));
		} finally {
			setBusy(null);
		}
	}

	const save = async () => {
		setBusy("save");
		result.clear();
		try {
			await post("save", draft);
			result.saved("Settings saved", "llms.txt and the news sitemap rebuild in the background within a few seconds.");
			await load();
		} catch (cause) {
			result.failed(errorText(cause, "Couldn't save"));
		} finally {
			setBusy(null);
		}
	};
	const rebuild = () =>
		run("rebuild", async () => {
			const out = await post<{ llms?: number; news?: number }>("rebuild", {});
			const parts = [out.llms !== undefined && `llms.txt lists ${out.llms} entries`, out.news !== undefined && `the news sitemap lists ${out.news}`].filter(Boolean);
			return parts.length ? `Rebuilt: ${parts.join(", ")}.` : "Nothing to rebuild: llms.txt and the news sitemap are off.";
		});
	if (!status || !draft) {
		return (
			<div className="space-y-6">
				<Header />
				{error ? (
					<Banner variant="error" role="alert" description={error} />
				) : (
					<Loading />
				)}
			</div>
		);
	}

	const set = <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>) =>
		setDraft((d) => (d ? { ...d, [section]: { ...d[section], ...patch } } : d));
	const anyOn = parts.parts ? parts.parts.some((p) => parts.isOn(p.id)) : status.features.news || status.features.feed || status.features.llms;
	// Crawler Hints is read once Discovery is on (its route answers only then), or when the switches couldn't be loaded.
	const mainOn = parts.main ? parts.main.enabled : Boolean(parts.error);

	return (
		<div className="space-y-6">
			<Header />

			{!anyOn && (
				<Banner
					variant="default"
					description="Discovery's parts are all off. Turn on the ones you want with the switch next to each title. You can change their settings first."
				/>
			)}
			<div aria-live="polite">
				{error && <Banner variant="error" role="alert" description={error} />}
				{notice && <Banner variant="default" description={notice} />}
			</div>

			{mainOn && <CrawlerHintsCard />}

			<form
				id="cw-discovery-form"
				className="space-y-6"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<Section
					title="News sitemap"
					part="discovery.newsSitemap"
					parts={parts}
					description="A Google News sitemap of entries published in the last 48 hours. Submit it in Google Search Console, and optionally add a Sitemap: line for it to your robots.txt (Settings → SEO)."
				>
					<ExternalLink href={status.urls.news} />
					<p className="text-sm text-kumo-subtle">
						{status.cache.news ? `${status.cache.news.count} entries as of ${when(status.cache.news.builtAt)}.` : "Not built yet."}
					</p>
					<CollectionPicker
						legend="Collections"
						hint="Entries from these collections are listed."
						collections={status.collections}
						value={draft.news.collections}
						onChange={(collections) => set("news", { collections })}
					/>
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="Publication name"
							description="Must match the name Google News knows you by. Empty uses the site title."
							value={draft.news.publicationName}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("news", { publicationName: e.target.value })}
						/>
						<Input
							label="Language"
							description="ISO 639 code, such as en or fr. Empty uses the site locale."
							value={draft.news.language}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("news", { language: e.target.value })}
						/>
					</div>
				</Section>

				<Section
					title="RSS feed"
					part="discovery.feed"
					parts={parts}
					description="An RSS feed of the newest entries at /feed/, linked from the head of every page so feed readers, podcast and news apps, and bots find it. With category URLs (such as /news/seo/your-post/), each category also has a feed at its address + feed/, including its subcategories. Entries set to noindex aren't listed."
				>
					<ExternalLink href={status.urls.feed} />
					<CollectionPicker
						legend="Collections"
						hint="Entries from these collections are listed, newest first."
						collections={status.collections}
						value={draft.feed.collections}
						onChange={(collections) => set("feed", { collections })}
					/>
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="Entries in each feed"
							type="number"
							min={1}
							max={100}
							description="1 to 100."
							value={String(draft.feed.items)}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("feed", { items: Math.max(1, Math.min(100, Math.round(Number(e.target.value)) || 1)) })}
						/>
					</div>
					<Checkbox
						label="Category feeds"
						checked={draft.feed.termFeeds}
						onCheckedChange={(checked: boolean) => set("feed", { termFeeds: checked })}
					/>
				</Section>

				<Section
					title="llms.txt and Markdown"
					part="discovery.llms"
					parts={parts}
					description="An llms.txt index (llmstxt.org) linking your entries, and a Markdown version of each entry at its URL + index.html.md."
					actions={
						<Button type="button" variant="secondary" icon={<ArrowClockwise />} disabled={busy !== null} onClick={() => void rebuild()}>
							{busy === "rebuild" ? "Rebuilding…" : "Rebuild now"}
						</Button>
					}
				>
					<ExternalLink href={status.urls.llms} />
					<p className="text-sm text-kumo-subtle">
						{status.cache.llms ? `${status.cache.llms.count} entries as of ${when(status.cache.llms.builtAt)}.` : "Not built yet."}
					</p>
					<Input
						label="Summary"
						description="The one-line summary under the site name. Empty uses the site tagline."
						value={draft.llms.summary}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("llms", { summary: e.target.value })}
					/>
					<InputArea
						label="Introduction"
						description="Optional Markdown shown before the lists, such as what the site covers and which pages matter most."
						rows={4}
						value={draft.llms.intro}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set("llms", { intro: e.target.value })}
					/>
					<CollectionPicker
						legend="Collections"
						hint="Leave all unchecked to list every visible collection with public URLs."
						collections={status.collections}
						value={draft.llms.collections}
						onChange={(collections) => set("llms", { collections })}
					/>
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="Maximum entries"
							type="number"
							min={1}
							max={5000}
							description="The first 100 per collection are listed by collection; the rest go under Optional."
							value={String(draft.llms.maxEntries)}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("llms", { maxEntries: Math.max(1, Math.min(5000, Number(e.target.value) || 1)) })}
						/>
						<Input
							label="Content license (optional)"
							description="Noted in each Markdown file's frontmatter, such as CC BY 4.0."
							value={draft.llms.license}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("llms", { license: e.target.value })}
						/>
					</div>
					<Checkbox
						label="Serve Markdown versions of entries and link to them from llms.txt"
						checked={draft.llms.markdown}
						onCheckedChange={(checked: boolean) => set("llms", { markdown: checked })}
					/>
				</Section>

			</form>

			<SaveBar
				error={result.error}
				form="cw-discovery-form"
				dirty={isDirty(draft, status.settings)}
				saving={busy === "save"}
				canSave={busy === null}
				onDiscard={() => setDraft(status.settings)}
			/>
		</div>
	);
}

function Header() {
	return (
		<PageHeader
			title="Discovery"
			description={
				<>
				Help search engines, feed readers and AI agents find your content: Cloudflare's Crawler Hints, a Google News sitemap, an RSS feed, and llms.txt with Markdown
				versions of your entries.
				</>
			}
		/>
	);
}

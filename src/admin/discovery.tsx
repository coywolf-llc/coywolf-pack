/**
 * Discovery admin page: IndexNow, the news sitemap, the RSS feed, and llms.txt settings
 * and status.
 */
import { Badge, Banner, Button, Checkbox, Input, InputArea, Loader, Select } from "@cloudflare/kumo";
import { ArrowClockwise, ArrowSquareOut, CheckCircle, Key, PaperPlaneTilt } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { FEATURES_CHANGED, PartSwitch, useParts } from "./feature-switches.js";
import { CredentialGuide } from "./guides.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SecretField } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/discovery";

interface Settings {
	indexnow: { endpoint: "api.indexnow.org" | "www.bing.com"; collections: string[] };
	news: { collections: string[]; publicationName: string; language: string };
	feed: { collections: string[]; items: number; termFeeds: boolean };
	llms: { summary: string; intro: string; collections: string[]; maxEntries: number; markdown: boolean; license: string };
}

interface PingLogEntry {
	at: string;
	endpoint: string;
	count: number;
	urls: string[];
	status: number;
	ok: boolean;
	error?: string;
	trigger: "content" | "manual" | "queue";
	/** Bing Webmaster API: URLs the site's daily quota still allows, when known. */
	quotaLeft?: number;
	/** Bing Webmaster API: these URLs wait in the queue for the next submission. */
	queued?: boolean;
}

interface BingQuota {
	daily: number;
	monthly: number;
	checkedAt: string;
}

type QuotaCheck = { ok: true; quota: BingQuota } | { ok: false; status: number; error: string };

interface Status {
	/** EmDash's staging mode: the site is hidden from search engines, so IndexNow sends nothing. */
	staging?: boolean;
	features: { indexnow: boolean; news: boolean; llms: boolean; feed: boolean };
	settings: Settings;
	collections: { slug: string; label: string; hidden: boolean; hasSeo: boolean }[];
	key: string | null;
	/** Whether a Bing Webmaster API key is saved (the key itself never comes back), the quota last read, and how many URLs wait in the queue. */
	bing?: { keySaved: boolean; quota: BingQuota | null; pending?: number; docs: string };
	urls: { keyFile: string | null; news: string; llms: string; feed: string };
	log: PingLogEntry[];
	cache: { llms: { count: number; builtAt: string } | null; news: { count: number; builtAt: string } | null };
}

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, "The request failed");
}

/** A part of Discovery (IndexNow, News sitemap, RSS feed, llms.txt), with its on/off switch next to the title. */
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

/** Where a log entry went: Bing's URL Submission API, or an IndexNow endpoint. */
const endpointLabel = (endpoint: string) => (endpoint === "bing-api" ? "Bing Webmaster API" : `IndexNow (${endpoint})`);

const quotaText = (quota: BingQuota) => `${quota.daily} URL submission${quota.daily === 1 ? "" : "s"} left today, ${quota.monthly} this month`;

const checkText = (check: QuotaCheck) =>
	check.ok ? `Bing accepts the key: ${quotaText(check.quota)}.` : `Bing didn't accept the check${check.status ? ` (HTTP ${check.status})` : ""}: ${check.error}`;

const BING_DOCS = "https://learn.microsoft.com/en-us/bingwebmaster/getting-access";

/**
 * The Bing Webmaster API key: saved encrypted on the server, never shown again (only "saved"), with Check key
 * (the site's quota) and Remove. It sits inside the settings form, so Enter here saves the key, not the form.
 */
function BingKey(props: { bing: NonNullable<Status["bing"]>; disabled: boolean; onChanged: () => Promise<void> }) {
	const [value, setValue] = React.useState("");
	const [pending, setPending] = React.useState<"save" | "clear" | "check">();
	const [result, setResult] = React.useState<{ ok: boolean; text: string }>();
	const saved = props.bing.keySaved;
	const busy = props.disabled || pending !== undefined;

	async function act(kind: "save" | "clear" | "check", task: () => Promise<{ ok: boolean; text: string }>) {
		setPending(kind);
		setResult(undefined);
		try {
			setResult(await task());
			await props.onChanged();
		} catch (cause) {
			setResult({ ok: false, text: errorText(cause, "Something went wrong") });
		} finally {
			setPending(undefined);
		}
	}
	const save = () => {
		const key = value.trim();
		if (!key || busy) return;
		void act("save", async () => {
			const out = await post<{ keySaved: boolean; check: QuotaCheck | null; message?: string }>("bing-key", { key });
			// A key Bing rejects for good isn't kept (keySaved false); keep the typed key so it can be corrected.
			if (out.keySaved) setValue("");
			const fallback = out.check ? `Key saved. ${checkText(out.check)}` : "Key saved.";
			return { ok: out.keySaved && (out.check?.ok ?? true), text: out.message ?? fallback };
		});
	};
	const remove = () => {
		if (!window.confirm("Remove the Bing Webmaster API key? Changed URLs then go to IndexNow only.")) return;
		void act("clear", async () => {
			await post("bing-key", { clear: true });
			return { ok: true, text: "Key removed. Changed URLs go to IndexNow only." };
		});
	};
	const check = () =>
		void act("check", async () => {
			const out = await post<QuotaCheck>("bing-check", {});
			return { ok: out.ok, text: checkText(out) };
		});

	return (
		<div className="space-y-3">
			<div>
				<h3 className="text-sm font-medium">Bing Webmaster API key</h3>
				<p className="mt-1 text-sm text-kumo-subtle">
					Bing throttles IndexNow pings sent from Cloudflare Workers' shared IP addresses (HTTP 429), so with your Bing Webmaster Tools API key, changed URLs also go
					straight to Bing's URL Submission API, within the site's daily quota. IndexNow still goes out for the other engines. Get the key in Bing Webmaster Tools →
					Settings → API access → API key; see{" "}
					<a className="text-kumo-link underline" href={props.bing.docs || BING_DOCS} target="_blank" rel="noreferrer">
						Microsoft's guide
					</a>
					.
				</p>
			</div>
			<div
				className="sm:max-w-md"
				onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
					if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229 || !(e.target instanceof HTMLInputElement)) return;
					e.preventDefault();
					save();
				}}
			>
				<SecretField
					label="Bing Webmaster API key"
					saved={saved}
					value={value}
					onChange={setValue}
					description="Bing Webmaster Tools → Settings → API access → API key. Stored encrypted; the site must be verified in the same account."
					disabled={busy}
				/>
			</div>
			<div className="sm:max-w-md">
				<CredentialGuide id="bing" />
			</div>
			<div className="flex flex-wrap gap-2">
				<Button type="button" variant="primary" icon={<Key />} disabled={busy || !value.trim()} onClick={save}>
					{pending === "save" ? "Saving…" : saved ? "Replace key" : "Save key"}
				</Button>
				{saved && (
					<>
						<Button type="button" variant="secondary" icon={<CheckCircle />} disabled={busy} onClick={check}>
							{pending === "check" ? "Checking…" : "Check key"}
						</Button>
						<Button type="button" variant="ghost" disabled={busy} onClick={remove}>
							{pending === "clear" ? "Removing…" : "Remove key"}
						</Button>
					</>
				)}
			</div>
			<div aria-live="polite">
				{result ? (
					<Banner variant={result.ok ? "default" : "error"} description={result.text} />
				) : (
					saved && (
						<div className="space-y-1 text-sm text-kumo-subtle">
							{props.bing.quota && (
								<p>
									Bing's quota for this site: {quotaText(props.bing.quota)} (read {when(props.bing.quota.checkedAt)}, counted down as URLs are sent).
								</p>
							)}
							{(props.bing.pending ?? 0) > 0 && (
								<p>
									{props.bing.pending} URL{props.bing.pending === 1 ? "" : "s"} waiting for Bing (over the quota, or Bing couldn't be reached): sent first with the next
									submission, and once a day.
								</p>
							)}
						</div>
					)
				)}
			</div>
		</div>
	);
}

export function DiscoveryPage() {
	const [status, setStatus] = React.useState<Status>();
	const [draft, setDraft] = React.useState<Settings>();
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
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

	// A part switched on this page: its status (key file, stored copies) may have changed. The draft is kept.
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

	const save = () =>
		run("save", async () => {
			await post("save", draft);
			return "Settings saved. llms.txt and the news sitemap rebuild in the background within a few seconds.";
		});
	const rebuild = () =>
		run("rebuild", async () => {
			const out = await post<{ llms?: number; news?: number }>("rebuild", {});
			const parts = [out.llms !== undefined && `llms.txt lists ${out.llms} entries`, out.news !== undefined && `the news sitemap lists ${out.news}`].filter(Boolean);
			return parts.length ? `Rebuilt: ${parts.join(", ")}.` : "Nothing to rebuild: llms.txt and the news sitemap are off.";
		});
	const submitHome = () =>
		run("submit", async () => {
			const out = await post<PingLogEntry & { entries?: PingLogEntry[] }>("submit", {});
			const results = (out.entries ?? [out]).map((e) =>
				e.ok ? `${endpointLabel(e.endpoint)}: OK (HTTP ${e.status}).` : `${endpointLabel(e.endpoint)}: failed (${e.error ?? `HTTP ${e.status}`}).`,
			);
			return `Submitted the home page. ${results.join(" ")}`;
		});
	const regenerate = () => {
		if (!window.confirm("Create a new IndexNow key? The old key file stops working.")) return;
		void run("key", async () => {
			await post("regenerate-key", {});
			return "New IndexNow key created.";
		});
	};

	if (!status || !draft) {
		return (
			<div className="space-y-6">
				<Header />
				{error ? (
					<Banner variant="error" role="alert" description={error} />
				) : (
					<div className="flex justify-center py-12">
						<Loader />
					</div>
				)}
			</div>
		);
	}

	const set = <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>) =>
		setDraft((d) => (d ? { ...d, [section]: { ...d[section], ...patch } } : d));
	const anyOn = parts.parts ? parts.parts.some((p) => parts.isOn(p.id)) : status.features.indexnow || status.features.news || status.features.feed || status.features.llms;

	return (
		<div className="space-y-6">
			<Header />

			{!anyOn && (
				<Banner
					variant="default"
					description="Discovery's parts are all off. Turn on the ones you want with the switch next to each title. You can change their settings first."
				/>
			)}
			{status.staging && (
				<Banner
					variant="default"
					description="This site is in staging (Settings → General → Site Status), hidden from search engines, so IndexNow sends nothing until it goes live. The other parts keep working."
				/>
			)}
			<div aria-live="polite">
				{error && <Banner variant="error" role="alert" description={error} />}
				{notice && <Banner variant="default" description={notice} />}
			</div>

			<form
				id="cw-discovery-form"
				className="space-y-6"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<Section
					title="IndexNow"
					part="discovery.indexnow"
					parts={parts}
					description="When an entry is published, updated, unpublished, or deleted, its URL is sent to IndexNow so Bing, Yandex, Seznam, Naver and other participating engines can recrawl it within minutes. Changes made within a few seconds of each other go out together. Entries set to noindex aren't submitted."
					actions={
						<>
							<Button type="button" variant="secondary" icon={<PaperPlaneTilt />} disabled={!(parts.parts ? parts.isOn("discovery.indexnow") : status.features.indexnow) || busy !== null} onClick={() => void submitHome()}>
								{busy === "submit" ? "Submitting…" : "Submit home page"}
							</Button>
							<Button type="button" variant="secondary" icon={<Key />} disabled={busy !== null} onClick={regenerate}>
								New key
							</Button>
						</>
					}
				>
					<div className="text-sm">
						<div className="font-medium">Key file</div>
						{status.urls.keyFile ? (
							<ExternalLink href={status.urls.keyFile} />
						) : (
							<p className="text-kumo-subtle">A key is created when IndexNow is turned on.</p>
						)}
					</div>
					<Select
						label="Endpoint"
						value={draft.indexnow.endpoint}
						onValueChange={(value: string | null) => set("indexnow", { endpoint: value === "www.bing.com" ? "www.bing.com" : "api.indexnow.org" })}
						items={[
							{ value: "api.indexnow.org", label: "api.indexnow.org (shared with all IndexNow engines)" },
							{ value: "www.bing.com", label: "www.bing.com" },
						]}
					/>
					{status.bing && <BingKey bing={status.bing} disabled={busy !== null} onChanged={refresh} />}
					<CollectionPicker
						legend="Collections"
						hint="Leave all unchecked to submit every collection with public URLs."
						collections={status.collections}
						value={draft.indexnow.collections}
						onChange={(collections) => set("indexnow", { collections })}
					/>
					<div>
						<h3 className="text-sm font-medium">Recent submissions</h3>
						{status.log.length === 0 ? (
							<p className="mt-1 text-sm text-kumo-subtle">None yet.</p>
						) : (
							<div className="mt-2 overflow-x-auto">
								<table className="w-full text-left text-sm">
									<thead className="text-kumo-subtle">
										<tr>
											<th scope="col" className="py-1 pr-4 font-medium">When</th>
											<th scope="col" className="py-1 pr-4 font-medium">Sent to</th>
											<th scope="col" className="py-1 pr-4 font-medium">Result</th>
											<th scope="col" className="py-1 pr-4 font-medium">URLs</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-kumo-line">
										{status.log.map((entry, i) => (
											// One submission logs an entry per endpoint, at the same moment and with the same URLs.
											<tr key={`${entry.at}-${entry.endpoint}-${i}`} className="align-top">
												<td className="whitespace-nowrap py-2 pr-4">{when(entry.at)}</td>
												<td className="whitespace-nowrap py-2 pr-4">{endpointLabel(entry.endpoint)}</td>
												<td className="py-2 pr-4">
													<Badge variant={entry.ok ? "primary" : entry.queued ? "secondary" : "destructive"}>
													{entry.ok ? `OK ${entry.status}` : entry.queued ? "Queued" : entry.status ? `Error ${entry.status}` : "Error"}
												</Badge>
													{entry.error && <div className="mt-1 max-w-xs break-words text-kumo-subtle">{entry.error}</div>}
													{entry.quotaLeft !== undefined && <div className="mt-1 text-kumo-subtle">{entry.quotaLeft} left today</div>}
												</td>
												<td className="py-2 pr-4">
													<div className="break-all">{entry.urls[0]}</div>
													{entry.count > 1 && <div className="text-kumo-subtle">and {entry.count - 1} more</div>}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				</Section>

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
		<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
			<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Discovery</h1>
			<p className="text-sm leading-5 text-pretty text-kumo-subtle">
				Help search engines, feed readers and AI agents find your content: IndexNow pings, a Google News sitemap, an RSS feed, and llms.txt with Markdown versions of
				your entries.
			</p>
		</header>
	);
}

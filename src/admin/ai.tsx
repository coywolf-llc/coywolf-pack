/**
 * AI Enrichment admin page: provider settings and Test, queue and bulk runs,
 * review of meta-description and image-text suggestions, entities, and the
 * usage log.
 */
import { Badge, Banner, Button, Checkbox, Input, InputArea, Select, Tabs } from "@cloudflare/kumo";
import { ArrowClockwise, Check, DownloadSimple, Play, Sparkle, Stop, X } from "@phosphor-icons/react";
import * as React from "react";

import { apiGet, apiPost, errorText } from "./api.js";
import { PageHeader, Loading } from "./page.js";
import { entitiesToCsv } from "../ai/export.js";
import { saveFile, siteSlug, today } from "./download.js";
import { CredentialGuide } from "./guides.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { PartSwitches } from "./feature-switches.js";

const API = "/_emdash/api/plugins/coywolf-pack/ai";

const post = apiPost(API, { body: {} });
const get = apiGet(API);

type ProviderId = "workers-ai" | "anthropic" | "openai" | "gemini";

interface Settings {
	provider: ProviderId;
	textModel: string;
	visionModel: string;
	apiKeySet: boolean;
	maxCallsPerDay: number;
	jobsPerTick: number;
	collections: string[];
	debounceMinutes: number;
	descriptionsMode: "suggest" | "apply";
	imageMode: "apply" | "suggest";
	imageCaption: boolean;
	imageOverwrite: boolean;
	imageInstructions: string;
	bindingAvailable: boolean;
	imagesBindingAvailable: boolean;
}

interface Bulk {
	kind: "entries" | "media";
	force: boolean;
	collections: string[];
	queued: number;
	skipped: number;
	started: string;
	finished?: string;
}

interface Status {
	settings: Settings;
	providers: Array<{ id: ProviderId; label: string; textModel: string; visionModel: string }>;
	features: { ai: boolean; entities: boolean; descriptions: boolean; imageText: boolean; entitiesStandalone: boolean };
	queue: { entries: number; media: number };
	bulk: { entries: Bulk | null; media: Bulk | null };
	callsToday: number;
	running: boolean;
	collections: string[];
}

interface Entity {
	name: string;
	type: string;
	description: string;
	qid: string;
	wikipedia: string;
	website: string;
	primary: boolean;
}

interface EntryRecord {
	collection: string;
	entryId: string;
	title: string;
	status: "ok" | "error";
	error: string;
	entities: Entity[];
	description: string;
	descriptionStatus: "none" | "suggested" | "applied" | "dismissed";
	updated: string;
}

interface MediaRecord {
	mediaId: string;
	filename: string;
	url: string;
	suggestion: { alt: string; caption: string; title: string } | null;
	status: "suggested" | "applied" | "skipped" | "error" | "dismissed";
	written: string[];
	error: string;
	updated: string;
}

interface UsageRow {
	time: string;
	feature: string;
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	ok: boolean;
	error?: string;
	ref?: string;
}

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function Section(props: { title: string; description?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
	return (
		<section className="rounded-lg border border-kumo-line">
			<div className="flex items-start justify-between gap-4 border-b border-kumo-line p-4">
				<div className="min-w-0">
					<h2 className="text-base font-semibold">{props.title}</h2>
					{props.description && <p className="mt-1 text-sm text-kumo-subtle">{props.description}</p>}
				</div>
				{props.actions && <div className="flex shrink-0 gap-2">{props.actions}</div>}
			</div>
			<div className="p-4">{props.children}</div>
		</section>
	);
}

// ── Overview ─────────────────────────────────────────────────────

function BulkRow(props: { kind: "entries" | "media"; label: string; enabled: boolean; bulk: Bulk | null; onChanged: (notice: string) => void; onError: (e: string) => void }) {
	const [force, setForce] = React.useState(false);
	const [pending, setPending] = React.useState(false);
	const active = props.bulk && !props.bulk.finished;
	const run = async (path: string, body: unknown, notice: string) => {
		setPending(true);
		try {
			await post(path, body);
			props.onChanged(notice);
		} catch (cause) {
			props.onError(errorText(cause, "The request failed"));
		} finally {
			setPending(false);
		}
	};
	return (
		<div className="flex flex-col gap-3 border-b border-kumo-line py-3 last:border-0 sm:flex-row sm:items-center">
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">{props.label}</div>
				<div className="mt-0.5 text-sm text-kumo-subtle">
					{!props.enabled
						? "Turn the feature on under Plugins → Coywolf Pack first."
						: props.bulk
							? `${props.bulk.finished ? "Scanned" : "Scanning"}: ${props.bulk.queued} queued, ${props.bulk.skipped} already done or not needed${props.bulk.finished ? ` (finished ${dateTime.format(new Date(props.bulk.finished))})` : "…"}`
							: "No bulk run yet."}
				</div>
			</div>
			<Checkbox
				label={props.kind === "media" ? "Include images that already have text" : "Re-analyze unchanged entries"}
				checked={force}
				disabled={!props.enabled || pending}
				onCheckedChange={(checked: boolean) => setForce(checked)}
			/>
			{active ? (
				<Button variant="secondary" icon={<Stop />} disabled={pending} onClick={() => void run("bulk/cancel", { kind: props.kind }, "Bulk run stopped and its queued items removed.")}>
					Stop
				</Button>
			) : (
				<Button variant="primary" icon={<Play />} disabled={!props.enabled || pending} onClick={() => void run("bulk", { kind: props.kind, force }, "Bulk run started. Items are processed with each scheduled run.")}>
					Run bulk
				</Button>
			)}
		</div>
	);
}

function Overview(props: { status: Status; reload: () => Promise<void>; setNotice: (s: string) => void; setError: (s: string) => void }) {
	const { status } = props;
	const [running, setRunning] = React.useState(false);
	const limit = status.settings.maxCallsPerDay;
	const runNow = async () => {
		setRunning(true);
		try {
			const r = await post<{ processed: number; skipped: number; failed: number; stoppedForLimit: boolean; busy?: boolean }>("run");
			props.setNotice(
				r.busy
					? "The scheduled run is working on the queue right now."
					: r.stoppedForLimit
						? "Stopped: today's call limit is reached."
						: `Processed ${r.processed}, skipped ${r.skipped}, failed ${r.failed}.`,
			);
			await props.reload();
		} catch (cause) {
			props.setError(errorText(cause, "Run failed"));
		} finally {
			setRunning(false);
		}
	};
	return (
		<div className="space-y-6">
			<Section
				title="Queue"
				description="Saves, publishes, and uploads add items here. Scheduled runs work through them in the background (every two minutes, or less often if the site's cron runs less often), so saving is never slowed down."
				actions={
					<Button variant="secondary" icon={<Play />} disabled={running || !status.features.ai} onClick={() => void runNow()}>
						{running ? "Running…" : "Run one now"}
					</Button>
				}
			>
				<dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
					<div>
						<dt className="text-kumo-subtle">Entries waiting</dt>
						<dd className="text-lg font-semibold tabular-nums">{status.queue.entries}</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">Images waiting</dt>
						<dd className="text-lg font-semibold tabular-nums">{status.queue.media}</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">Model calls today</dt>
						<dd className="text-lg font-semibold tabular-nums">
							{status.callsToday} / {limit}
						</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">Working now</dt>
						<dd className="text-lg font-semibold">{status.running ? "Yes" : "No"}</dd>
					</div>
				</dl>
				{status.callsToday >= limit && <Banner className="mt-4" variant="default" title="Today's call limit is reached. Work resumes after midnight UTC." />}
			</Section>
			<Section title="Bulk runs" description={`Collections: ${status.collections.join(", ") || "none found"}.`}>
				<BulkRow
					kind="entries"
					label="Entities and meta descriptions for published entries"
					enabled={status.features.entities || status.features.descriptions}
					bulk={status.bulk.entries}
					onChanged={(n) => {
						props.setNotice(n);
						void props.reload();
					}}
					onError={props.setError}
				/>
				<BulkRow
					kind="media"
					label="Image text for the media library"
					enabled={status.features.imageText}
					bulk={status.bulk.media}
					onChanged={(n) => {
						props.setNotice(n);
						void props.reload();
					}}
					onError={props.setError}
				/>
			</Section>
		</div>
	);
}

// ── Settings ─────────────────────────────────────────────────────

function SettingsPanel(props: { status: Status; reload: () => Promise<void>; setNotice: (s: string) => void; setError: (s: string) => void }) {
	const { status } = props;
	// The draft as the saved settings fill it (model names blank when they're the provider's defaults).
	const savedDraft = React.useMemo(() => {
		const s = status.settings;
		const savedProvider = status.providers.find((p) => p.id === s.provider) ?? status.providers[0];
		return {
			aiProvider: s.provider,
			aiModel: s.textModel !== savedProvider.textModel ? s.textModel : "",
			aiVisionModel: s.visionModel !== savedProvider.visionModel ? s.visionModel : "",
			aiApiKey: "",
			aiMaxCallsPerDay: s.maxCallsPerDay,
			aiJobsPerTick: s.jobsPerTick,
			aiCollections: s.collections.join(", "),
			aiDebounceMinutes: s.debounceMinutes,
			aiDescriptionsMode: s.descriptionsMode,
			aiImageMode: s.imageMode,
			aiImageCaption: s.imageCaption,
			aiImageOverwrite: s.imageOverwrite,
			aiImageInstructions: s.imageInstructions,
		};
	}, [status.settings, status.providers]);
	const [draft, setDraft] = React.useState(savedDraft);
	// After a save, take the reloaded settings as the new draft (the server normalizes some fields).
	const justSaved = React.useRef(false);
	React.useEffect(() => {
		if (!justSaved.current) return;
		justSaved.current = false;
		setDraft(savedDraft);
	}, [savedDraft]);
	const dirty = isDirty(draft, savedDraft);
	const provider = status.providers.find((p) => p.id === draft.aiProvider) ?? status.providers[0];
	const sameProvider = draft.aiProvider === status.settings.provider;
	React.useEffect(() => {
		// Show the saved model names when they differ from the provider's defaults.
		setDraft((d) => ({
			...d,
			aiModel: sameProvider && status.settings.textModel !== provider.textModel ? status.settings.textModel : "",
			aiVisionModel: sameProvider && status.settings.visionModel !== provider.visionModel ? status.settings.visionModel : "",
		}));
	}, [sameProvider, provider, status.settings.textModel, status.settings.visionModel]);
	const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
	const [pending, setPending] = React.useState(false);
	// Model pickers: once the saved provider has a key (or the Workers AI binding), list its models.
	const canList = sameProvider && (draft.aiProvider === "workers-ai" ? status.settings.bindingAvailable : status.settings.apiKeySet);
	const [models, setModels] = React.useState<{ id: string; label: string }[] | null>(null);
	const [modelsError, setModelsError] = React.useState<string>();
	React.useEffect(() => {
		if (!canList) {
			setModels(null);
			return;
		}
		let live = true;
		get<{ models: { id: string; label: string }[]; error?: string }>("models")
			.then((r) => {
				if (!live) return;
				setModels(r.models.length ? r.models : null);
				setModelsError(r.error);
			})
			.catch((cause) => live && setModelsError(errorText(cause, "Couldn't list models")));
		return () => {
			live = false;
		};
	}, [canList, draft.aiProvider, status.settings.apiKeySet]);
	/** The model in use for a field: the draft value, else the saved value, else the provider default. */
	const currentModel = (draftValue: string, saved: string, fallback: string) => draftValue || (sameProvider ? saved : "") || fallback;
	const modelItems = (current: string, fallback: string) => {
		const list = models ?? [];
		const items = list.map((m) => ({ value: m.id, label: m.id === fallback ? `${m.label} — default` : m.label }));
		if (!list.some((m) => m.id === current)) items.unshift({ value: current, label: current === fallback ? `${current} — default` : `${current} (current)` });
		return items;
	};
	const [test, setTest] = React.useState<string>();

	const save = async () => {
		setPending(true);
		try {
			const { aiApiKey, ...rest } = draft;
			await post("settings", aiApiKey.trim() ? { ...rest, aiApiKey } : rest);
			set({ aiApiKey: "" });
			props.setNotice("AI settings saved.");
			justSaved.current = true;
			await props.reload();
		} catch (cause) {
			props.setError(errorText(cause, "Could not save settings"));
		} finally {
			setPending(false);
		}
	};
	const runTest = async () => {
		setTest("Testing…");
		try {
			const r = await post<{ ok: boolean; reply?: string; error?: string; model?: string; ms?: number }>("test");
			setTest(r.ok ? `Connected to ${r.model} (${r.ms} ms). Reply: “${r.reply}”` : `Failed${r.model ? ` (${r.model})` : ""}: ${r.error}`);
		} catch (cause) {
			setTest(errorText(cause, "Test failed"));
		}
	};
	const needsKey = draft.aiProvider !== "workers-ai";
	const num = (v: string, fallback: number) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : fallback);

	return (
		<>
			<form
				id="cw-ai-settings-form"
				className="space-y-6"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<Section
					title="Provider"
					description="Save before testing. The test makes one small call that counts toward today's limit."
					actions={
						<Button type="button" variant="secondary" disabled={!status.features.ai} onClick={() => void runTest()}>
							Test connection
						</Button>
					}
				>
					<div className="grid gap-4 sm:grid-cols-2">
						<Select
							label="Provider"
							value={draft.aiProvider}
							onValueChange={(value: string | null) => set({ aiProvider: (value ?? "workers-ai") as ProviderId })}
							items={status.providers.map((p) => ({ value: p.id, label: p.label }))}
						/>
						{needsKey ? (
							<Input
								type="password"
								autoComplete="off"
								label={status.settings.apiKeySet && sameProvider ? "API key (saved)" : "API key"}
								placeholder={status.settings.apiKeySet && sameProvider ? "••••••••••••••••••••••••" : undefined}
								description={status.settings.apiKeySet && sameProvider ? "Type a new key to replace the saved one." : undefined}
								value={draft.aiApiKey}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ aiApiKey: e.target.value })}
							/>
						) : (
							<p className="self-end text-sm text-kumo-subtle">
								{status.settings.bindingAvailable ? "The Workers AI binding is connected." : "Add an \"ai\" binding to wrangler.jsonc (see docs/ai.md in the Coywolf Pack repository) to use Workers AI."}
							</p>
						)}
						<div style={{ gridColumn: "1 / -1" }}>
							<CredentialGuide id={draft.aiProvider} />
						</div>
						{models ? (
							<>
								<Select
									label="Text model"
									value={currentModel(draft.aiModel, status.settings.textModel, provider.textModel)}
									onValueChange={(value: string | null) => set({ aiModel: !value || value === provider.textModel ? "" : value })}
									items={modelItems(currentModel(draft.aiModel, status.settings.textModel, provider.textModel), provider.textModel)}
								/>
								<Select
									label="Image model"
									value={currentModel(draft.aiVisionModel, status.settings.visionModel, provider.visionModel)}
									onValueChange={(value: string | null) => set({ aiVisionModel: !value || value === provider.visionModel ? "" : value })}
									items={modelItems(currentModel(draft.aiVisionModel, status.settings.visionModel, provider.visionModel), provider.visionModel)}
								/>
							</>
						) : (
							<>
								<Input label={`Text model (default ${provider.textModel})`} value={draft.aiModel} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ aiModel: e.target.value })} />
								<Input label={`Image model (default ${provider.visionModel})`} value={draft.aiVisionModel} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ aiVisionModel: e.target.value })} />
							</>
						)}
					</div>
					{!models && canList && modelsError && (
						<p className="mt-2 text-sm text-kumo-subtle">Couldn't list this provider's models ({modelsError}); type a model id instead.</p>
					)}
					{!canList && draft.aiProvider !== "workers-ai" && (
						<p className="mt-2 text-sm text-kumo-subtle">Save an API key to pick from this provider's models.</p>
					)}
					{test && (
						<p className="mt-3 text-sm text-kumo-subtle" role="status" aria-live="polite">
							{test}
						</p>
					)}
				</Section>

				<Section title="Limits and scope">
					<div className="grid gap-4 sm:grid-cols-2">
						<Input type="number" min={1} label="Max model calls per day" value={String(draft.aiMaxCallsPerDay)} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ aiMaxCallsPerDay: num(e.target.value, 200) })} />
						<Input type="number" min={1} max={20} label="Items per scheduled run" value={String(draft.aiJobsPerTick)} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ aiJobsPerTick: num(e.target.value, 3) })} />
						<Input label="Collections (comma-separated; blank = all public)" value={draft.aiCollections} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ aiCollections: e.target.value })} />
						<Input type="number" min={0} max={120} label="Wait after a save (minutes)" value={String(draft.aiDebounceMinutes)} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ aiDebounceMinutes: num(e.target.value, 2) })} />
					</div>
				</Section>

				<Section title="Meta descriptions and image text">
					<div className="grid gap-4 sm:grid-cols-2">
						<Select
							label="Meta descriptions"
							value={draft.aiDescriptionsMode}
							onValueChange={(value: string | null) => set({ aiDescriptionsMode: value === "apply" ? "apply" : "suggest" })}
							items={[
								{ value: "suggest", label: "Suggest for review" },
								{ value: "apply", label: "Fill empty descriptions automatically" },
							]}
						/>
						<Select
							label="Image text"
							value={draft.aiImageMode}
							onValueChange={(value: string | null) => set({ aiImageMode: value === "suggest" ? "suggest" : "apply" })}
							items={[
								{ value: "apply", label: "Fill empty alt text automatically" },
								{ value: "suggest", label: "Suggest for review" },
							]}
						/>
					</div>
					<div className="mt-4 space-y-2">
						<Checkbox label="Also write captions" checked={draft.aiImageCaption} onCheckedChange={(c: boolean) => set({ aiImageCaption: c })} />
						<Checkbox label="Overwrite alt text and captions people already wrote" checked={draft.aiImageOverwrite} onCheckedChange={(c: boolean) => set({ aiImageOverwrite: c })} />
					</div>
					<div className="mt-4">
						<InputArea label="Extra instructions for image text (optional)" rows={3} value={draft.aiImageInstructions} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set({ aiImageInstructions: e.target.value })} />
					</div>
					{!status.settings.imagesBindingAvailable && (
						<p className="mt-3 text-sm text-kumo-subtle">Images over 3.5 MB are skipped unless the site has an Images binding to downscale them.</p>
					)}
				</Section>
			</form>
			<SaveBar form="cw-ai-settings-form" dirty={dirty} saving={pending} onDiscard={() => setDraft(savedDraft)} />
		</>
	);
}

// ── Review lists ─────────────────────────────────────────────────

function useList<T>(path: string, filter: string) {
	const [items, setItems] = React.useState<T[]>();
	const [error, setError] = React.useState<string>();
	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			setItems((await post<{ items: T[] }>(path, { filter })).items);
		} catch (cause) {
			setError(errorText(cause, "Could not load"));
		}
	}, [path, filter]);
	React.useEffect(() => {
		void load();
	}, [load]);
	return { items, error, load };
}

function DescriptionRow(props: { entry: EntryRecord; onDone: (notice: string) => void; onError: (e: string) => void }) {
	const { entry } = props;
	const [text, setText] = React.useState(entry.description);
	const [pending, setPending] = React.useState(false);
	const act = async (path: string, body: unknown, notice: string) => {
		setPending(true);
		try {
			await post(path, body);
			props.onDone(notice);
		} catch (cause) {
			props.onError(errorText(cause, "The request failed"));
		} finally {
			setPending(false);
		}
	};
	const ref = { collection: entry.collection, id: entry.entryId };
	return (
		<li className="space-y-2 py-3">
			<div className="flex items-center gap-2 text-sm">
				<span className="font-medium">{entry.title || entry.entryId}</span>
				<Badge variant="outline">{entry.collection}</Badge>
				<Badge variant={entry.descriptionStatus === "applied" ? "secondary" : "outline"}>{entry.descriptionStatus}</Badge>
			</div>
			<InputArea
				label={`Meta description (${[...text].length}/155)`}
				rows={2}
				value={text}
				disabled={pending}
				onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
			/>
			<div className="flex gap-2">
				<Button variant="primary" icon={<Check />} disabled={pending || !text.trim()} onClick={() => void act("description/apply", { ...ref, description: text }, "Meta description saved to the SEO panel.")}>
					Apply
				</Button>
				<Button variant="secondary" disabled={pending || !text.trim()} onClick={() => void act("description/apply", { ...ref, description: text, replace: true }, "Meta description replaced.")}>
					Replace existing
				</Button>
				<Button variant="ghost" icon={<X />} disabled={pending} onClick={() => void act("description/dismiss", ref, "Suggestion dismissed.")}>
					Dismiss
				</Button>
			</div>
		</li>
	);
}

function DescriptionsPanel(props: { setNotice: (s: string) => void; setError: (s: string) => void }) {
	const { items, error, load } = useList<EntryRecord>("entries", "suggested");
	return (
		<Section title="Meta description suggestions" description="Edit if needed, then apply. Apply only fills an empty description; Replace overwrites one." actions={<Button variant="ghost" shape="square" icon={<ArrowClockwise />} aria-label="Reload" onClick={() => void load()} />}>
			{error && <Banner variant="error" role="alert" description={error} />}
			{!items && !error ? (
				<Loading className="" />
			) : items?.length ? (
				<ul className="divide-y divide-kumo-line">
					{items.map((entry) => (
						<DescriptionRow
							key={`${entry.collection}:${entry.entryId}`}
							entry={entry}
							onDone={(n) => {
								props.setNotice(n);
								void load();
							}}
							onError={props.setError}
						/>
					))}
				</ul>
			) : (
				<p className="text-sm text-kumo-subtle">No suggestions waiting.</p>
			)}
		</Section>
	);
}

function MediaRow(props: { item: MediaRecord; onDone: (notice: string) => void; onError: (e: string) => void }) {
	const { item } = props;
	const [alt, setAlt] = React.useState(item.suggestion?.alt ?? "");
	const [caption, setCaption] = React.useState(item.suggestion?.caption ?? "");
	const [pending, setPending] = React.useState(false);
	const act = async (path: string, body: unknown, notice: string) => {
		setPending(true);
		try {
			await post(path, body);
			props.onDone(notice);
		} catch (cause) {
			props.onError(errorText(cause, "The request failed"));
		} finally {
			setPending(false);
		}
	};
	return (
		<li className="flex flex-col gap-3 py-3 sm:flex-row">
			<img src={item.url} alt="" className="h-24 w-32 shrink-0 rounded object-cover" loading="lazy" />
			<div className="min-w-0 flex-1 space-y-2">
				<div className="flex items-center gap-2 text-sm">
					<span className="truncate font-medium">{item.filename}</span>
					<Badge variant={item.status === "applied" ? "secondary" : "outline"}>{item.status}</Badge>
					{item.written.length > 0 && <span className="text-xs text-kumo-subtle">wrote {item.written.join(", ")}</span>}
				</div>
				{item.error && <p className="text-sm text-kumo-subtle">{item.error}</p>}
				{item.suggestion && (
					<>
						<Input label="Alt text" value={alt} disabled={pending} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAlt(e.target.value)} />
						<Input label="Caption" value={caption} disabled={pending} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCaption(e.target.value)} />
					</>
				)}
				<div className="flex flex-wrap gap-2">
					{item.suggestion && (
						<>
							<Button variant="primary" icon={<Check />} disabled={pending} onClick={() => void act("media/apply", { mediaId: item.mediaId, alt }, "Alt text saved where it was empty.")}>
								Apply alt text
							</Button>
							<Button variant="secondary" disabled={pending} onClick={() => void act("media/apply", { mediaId: item.mediaId, alt, caption, replace: true }, "Alt text and caption saved.")}>
								Replace alt and caption
							</Button>
						</>
					)}
					<Button variant="secondary" icon={<Sparkle />} disabled={pending} onClick={() => void act("media/generate", { mediaId: item.mediaId }, "Queued for new image text.")}>
						Regenerate
					</Button>
					{item.status === "suggested" && (
						<Button variant="ghost" icon={<X />} disabled={pending} onClick={() => void act("media/dismiss", { mediaId: item.mediaId }, "Suggestion dismissed.")}>
							Dismiss
						</Button>
					)}
				</div>
			</div>
		</li>
	);
}

function ImagesPanel(props: { setNotice: (s: string) => void; setError: (s: string) => void }) {
	const [filter, setFilter] = React.useState("suggested");
	const { items, error, load } = useList<MediaRecord>("media", filter);
	return (
		<Section
			title="Image text"
			description="Alt text is written only where it's empty unless you choose Replace. EmDash media has alt text and captions; titles are shown for reference."
			actions={
				<div className="w-44">
					<Select
						aria-label="Show"
						value={filter}
						onValueChange={(v: string | null) => setFilter(v ?? "suggested")}
						items={[
							{ value: "suggested", label: "Suggestions" },
							{ value: "applied", label: "Applied" },
							{ value: "skipped", label: "Skipped" },
							{ value: "error", label: "Errors" },
						]}
					/>
				</div>
			}
		>
			{error && <Banner variant="error" role="alert" description={error} />}
			{!items && !error ? (
				<Loading className="" />
			) : items?.length ? (
				<ul className="divide-y divide-kumo-line">
					{items.map((item) => (
						<MediaRow
							key={item.mediaId}
							item={item}
							onDone={(n) => {
								props.setNotice(n);
								void load();
							}}
							onError={props.setError}
						/>
					))}
				</ul>
			) : (
				<p className="text-sm text-kumo-subtle">Nothing here yet.</p>
			)}
		</Section>
	);
}

function EntitiesPanel(props: { setNotice: (s: string) => void; setError: (s: string) => void }) {
	const [filter, setFilter] = React.useState("all");
	const { items, error, load } = useList<EntryRecord>("entries", filter);
	const [exporting, setExporting] = React.useState(false);
	/** Every analyzed entry (all pages, whatever the filter), as CSV. */
	const exportCsv = async () => {
		setExporting(true);
		try {
			const all: EntryRecord[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < 1000; page++) {
				const result = await post<{ items: EntryRecord[]; cursor?: string; hasMore: boolean }>("entries", { filter: "all", ...(cursor ? { cursor } : {}) });
				all.push(...result.items);
				if (!result.hasMore || !result.cursor) break;
				cursor = result.cursor;
			}
			saveFile(entitiesToCsv(all), `ai-entities-${siteSlug() || "site"}-${today()}.csv`, "text/csv");
			props.setNotice(`Exported ${all.length.toLocaleString()} analyzed ${all.length === 1 ? "entry" : "entries"}.`);
		} catch (cause) {
			props.setError(errorText(cause, "Export failed"));
		} finally {
			setExporting(false);
		}
	};
	const reanalyze = async (entry: EntryRecord) => {
		try {
			await post("entry/reanalyze", { collection: entry.collection, id: entry.entryId });
			props.setNotice(`Queued ${entry.title || entry.entryId} for a fresh analysis.`);
		} catch (cause) {
			props.setError(errorText(cause, "Could not queue"));
		}
	};
	return (
		<Section
			title="Analyzed entries"
			description="Primary subjects become Schema.org about; passing references become mentions. Each links to Wikidata and, when there is one, Wikipedia and the official website."
			actions={
				<div className="flex gap-2">
					<div className="w-36">
						<Select
							aria-label="Show"
							value={filter}
							onValueChange={(v: string | null) => setFilter(v ?? "all")}
							items={[
								{ value: "all", label: "All" },
								{ value: "error", label: "Errors" },
							]}
						/>
					</div>
					<Button variant="secondary" icon={<DownloadSimple />} disabled={exporting || !items?.length} onClick={() => void exportCsv()}>
						{exporting ? "Exporting…" : "Export CSV"}
					</Button>
					<Button variant="ghost" shape="square" icon={<ArrowClockwise />} aria-label="Reload" onClick={() => void load()} />
				</div>
			}
		>
			{error && <Banner variant="error" role="alert" description={error} />}
			{!items && !error ? (
				<Loading className="" />
			) : items?.length ? (
				<ul className="divide-y divide-kumo-line">
					{items.map((entry) => (
						<li key={`${entry.collection}:${entry.entryId}`} className="py-3 text-sm">
							<div className="flex items-center gap-2">
								<span className="font-medium">{entry.title || entry.entryId}</span>
								<Badge variant="outline">{entry.collection}</Badge>
								<span className="text-xs text-kumo-subtle">{dateTime.format(new Date(entry.updated))}</span>
								<Button className="ms-auto" variant="ghost" size="sm" icon={<ArrowClockwise />} onClick={() => void reanalyze(entry)}>
									Re-analyze
								</Button>
							</div>
							{entry.status === "error" && <p className="mt-1 text-kumo-subtle">Failed: {entry.error}</p>}
							{entry.entities.length > 0 ? (
								<div className="mt-2 flex flex-wrap gap-1.5">
									{entry.entities.map((e) => (
										<a key={e.qid} href={`https://www.wikidata.org/wiki/${e.qid}`} target="_blank" rel="noreferrer" title={`${e.type} · ${e.qid}`}>
											<Badge variant={e.primary ? "secondary" : "outline"}>
												{e.name}
												{e.primary ? " (about)" : ""}
											</Badge>
										</a>
									))}
								</div>
							) : (
								entry.status === "ok" && <p className="mt-1 text-kumo-subtle">No verifiable entities.</p>
							)}
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-kumo-subtle">No entries analyzed yet.</p>
			)}
		</Section>
	);
}

function UsagePanel() {
	const [rows, setRows] = React.useState<UsageRow[]>();
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		get<{ items: UsageRow[] }>("usage")
			.then((d) => setRows(d.items))
			.catch((cause) => setError(errorText(cause, "Could not load the usage log")));
	}, []);
	const totals = (rows ?? []).reduce((t, r) => ({ input: t.input + r.inputTokens, output: t.output + r.outputTokens }), { input: 0, output: 0 });
	return (
		<Section title="Usage log" description={`The latest 100 model calls (kept 30 days). Tokens shown: ${totals.input.toLocaleString()} in, ${totals.output.toLocaleString()} out.`}>
			{error && <Banner variant="error" role="alert" description={error} />}
			{!rows && !error ? (
				<Loading className="" />
			) : rows?.length ? (
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead className="text-start text-kumo-subtle">
							<tr>
								<th className="py-1 pe-3 font-medium">Time</th>
								<th className="py-1 pe-3 font-medium">Feature</th>
								<th className="py-1 pe-3 font-medium">Model</th>
								<th className="py-1 pe-3 text-end font-medium">In</th>
								<th className="py-1 pe-3 text-end font-medium">Out</th>
								<th className="py-1 font-medium">Result</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={`${r.time}${r.ref ?? ""}`} className="border-t border-kumo-line">
									<td className="py-1 pe-3 whitespace-nowrap">{dateTime.format(new Date(r.time))}</td>
									<td className="py-1 pe-3">{r.feature}</td>
									<td className="py-1 pe-3 font-mono text-xs">{r.model}</td>
									<td className="py-1 pe-3 text-end tabular-nums">{r.inputTokens.toLocaleString()}</td>
									<td className="py-1 pe-3 text-end tabular-nums">{r.outputTokens.toLocaleString()}</td>
									<td className="py-1">
										{r.ok ? (
											"OK"
										) : (
											<>
												<span title={r.error}>Failed</span>
												{r.error && <span className="block max-w-xs text-xs break-words text-kumo-subtle">{r.error}</span>}
											</>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="text-sm text-kumo-subtle">No calls yet.</p>
			)}
		</Section>
	);
}

// ── Page ─────────────────────────────────────────────────────────

export function AiPage() {
	const [status, setStatus] = React.useState<Status>();
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const [tab, setTab] = React.useState("overview");

	const load = React.useCallback(async () => {
		try {
			setStatus(await get<Status>("status"));
		} catch (cause) {
			setError(errorText(cause, "Could not load AI Enrichment"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const say = (n: string) => {
		setError(undefined);
		setNotice(n);
	};

	return (
		<div className="space-y-6">
			<PageHeader
				title="AI Enrichment"
				description={
					<>
					Entities for Schema.org verified against Wikidata, meta descriptions, and image alt text. Everything runs in the background after saves and uploads, within your daily call limit.
					</>
				}
			/>

			<PartSwitches module="ai" />

			<div aria-live="polite">
				{notice && <Banner variant="default" role="status" title={notice} />}
				{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			</div>

			{status && !status.features.ai && <Banner variant="default" title="AI Enrichment is off. Turn it and its features on under Plugins → Coywolf Pack." />}

			{!status && !error ? (
				<Loading />
			) : status ? (
				<>
					<Tabs
						value={tab}
						onValueChange={setTab}
						tabs={[
							{ value: "overview", label: "Overview" },
							{ value: "settings", label: "Settings" },
							{ value: "descriptions", label: "Descriptions" },
							{ value: "images", label: "Images" },
							{ value: "entities", label: "Entities" },
							{ value: "usage", label: "Usage" },
						]}
					/>
					{tab === "overview" && <Overview status={status} reload={load} setNotice={say} setError={setError} />}
					{tab === "settings" && <SettingsPanel status={status} reload={load} setNotice={say} setError={setError} />}
					{tab === "descriptions" && <DescriptionsPanel setNotice={say} setError={setError} />}
					{tab === "images" && <ImagesPanel setNotice={say} setError={setError} />}
					{tab === "entities" && <EntitiesPanel setNotice={say} setError={setError} />}
					{tab === "usage" && <UsagePanel />}
				</>
			) : null}
		</div>
	);
}

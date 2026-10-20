/**
 * Videos admin page: the Cloudflare Stream library with plays, likes and
 * where each video is used; editing, captions, uploads (straight from the
 * browser to Stream), index rebuild and the Stream webhook.
 */
import { Badge, Banner, Button, Checkbox, Dialog, DropdownMenu, Input, InputArea, Loader, Select, Tabs } from "@cloudflare/kumo";
import {
	ArrowClockwise,
	ClosedCaptioning,
	Copy,
	DotsThree,
	PencilSimple,
	Plug,
	Trash,
	UploadSimple,
	VideoCamera,
} from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import type { VideoDisplay } from "../videos/render.js";
import { CredentialGuide } from "./guides.js";
import { DisplaySettings, fromDisplayDraft, toDisplayDraft } from "./videos-display.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SecretField, SettingsSection, SetupCard } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/videos";

interface Usage {
	title: string | null;
	url: string | null;
	collection: string;
	status: string;
}

interface Video {
	uid: string;
	name: string;
	description: string;
	duration: number;
	created: string | null;
	width: number;
	height: number;
	state: string;
	ready: boolean;
	size: number;
	allowedOrigins: string[];
	thumbnail: string;
	plays: number;
	likes: number;
	usedIn: Usage[];
	captions: Array<{ language: string; label?: string }>;
	tags?: string[];
	creator?: string;
}

/** Embedded videos that are no longer in Stream (deleted in its dashboard). */
interface Orphan {
	uid: string;
	usedIn: Usage[];
}

interface StorageUsage {
	videos: number;
	minutes: number;
	limit: number;
}

type Filter = "all" | "plays" | "likes" | "used" | "unused";

interface Status {
	configured: boolean;
	host: string | null;
	features: Record<string, boolean>;
	webhook: { subscribed: boolean; url: string };
	sitemapUrl: string;
}

interface VideosSettings {
	accountId: string;
	tokenSet: boolean;
	customerSubdomain: string;
	accentColor: string;
	backgroundColor: string;
	lightEmbed: boolean;
	display: VideoDisplay;
	defaultTags: string;
	envAccountId: boolean;
	envToken: boolean;
}

interface Meta {
	uid: string;
	name?: string;
	description?: string;
	posterTime?: number;
	posterImage?: string;
	allowedOrigins?: string[];
	downloadUrl?: string;
	downloadStatus?: string;
}

interface Caption {
	language: string;
	label?: string;
	generated?: boolean;
	status?: string;
}

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const numberFormat = new Intl.NumberFormat("en-US");

function clock(seconds: number): string {
	if (!seconds) return "";
	const total = Math.round(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, "The request failed");
}

// ── Edit ─────────────────────────────────────────────────────────

function EditDialog(props: { video: Video | null; onClose: () => void; onSaved: (message: string) => void }) {
	const [meta, setMeta] = React.useState<Meta>();
	const [download, setDownload] = React.useState<{ status?: string; url?: string; percent?: number } | null>(null);
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [posterTime, setPosterTime] = React.useState("");
	const [posterImage, setPosterImage] = React.useState("");
	const [origins, setOrigins] = React.useState("");
	const [tags, setTags] = React.useState("");
	const [creator, setCreator] = React.useState("");
	const [downloads, setDownloads] = React.useState(false);
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();

	React.useEffect(() => {
		const video = props.video;
		setMeta(undefined);
		setError(undefined);
		if (!video) return;
		setName(video.name);
		setDescription(video.description);
		setOrigins(video.allowedOrigins.join(", "));
		setTags((video.tags ?? []).join(", "));
		setCreator(video.creator ?? "");
		post<{ meta: Meta | null; download: typeof download }>("detail", { uid: video.uid })
			.then((d) => {
				const m = d.meta ?? { uid: video.uid };
				setMeta(m);
				setDownload(d.download);
				setDescription(m.description ?? "");
				setPosterTime(m.posterTime !== undefined ? String(m.posterTime) : "");
				setPosterImage(m.posterImage ?? "");
				setOrigins((m.allowedOrigins ?? video.allowedOrigins).join(", "));
				setDownloads(Boolean(d.download));
			})
			.catch((cause) => setError(errorText(cause, "Could not load the video")));
	}, [props.video]);

	const save = async () => {
		if (!props.video) return;
		setPending(true);
		setError(undefined);
		try {
			const time = posterTime.trim() === "" ? null : Number(posterTime);
			if (time !== null && (!Number.isFinite(time) || time < 0)) throw new Error("The poster frame must be a number of seconds.");
			await post("update", {
				uid: props.video.uid,
				name,
				description,
				posterTime: time,
				posterImage: posterImage.trim() || null,
				allowedOrigins: origins
					.split(/[\s,]+/)
					.map((o) => o.trim())
					.filter(Boolean),
				tags,
				creator: creator.trim(),
				...(downloads !== Boolean(download) ? { downloads } : {}),
			});
			props.onSaved(`Saved ${name || props.video.uid}.`);
		} catch (cause) {
			setError(errorText(cause, "Could not save the video"));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog.Root open={props.video !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Edit video</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					The name is saved to Cloudflare Stream. The description and poster are used by blocks that don't set their own,
					and by schema and the video sitemap.
				</Dialog.Description>
				{!meta && !error ? (
					<div className="py-8 text-center">
						<Loader />
					</div>
				) : (
					<form
						className="mt-4 space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							void save();
						}}
					>
						<Input label="Name" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} required />
						<InputArea
							label="Description"
							rows={4}
							value={description}
							onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
						/>
						<div className="grid gap-4 sm:grid-cols-2">
							<Input
								label="Poster frame (seconds)"
								inputMode="decimal"
								placeholder="0"
								value={posterTime}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPosterTime(e.target.value)}
							/>
							<Input
								label="Poster image URL (optional)"
								placeholder="https://…"
								value={posterImage}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPosterImage(e.target.value)}
							/>
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<Input
								label="Tags"
								placeholder="tutorial, product"
								description="Comma-separated. Search the library with #tag."
								value={tags}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTags(e.target.value)}
							/>
							<Input
								label="Creator (optional)"
								description="Stream's creator ID, such as a user or team, for your own records."
								value={creator}
								maxLength={64}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreator(e.target.value)}
							/>
						</div>
						<Input
							label="Allowed origins (empty allows any site)"
							placeholder="example.com, *.example.com"
							value={origins}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOrigins(e.target.value)}
						/>
						<Checkbox
							label="Downloadable MP4 (used as the schema contentUrl)"
							checked={downloads}
							onCheckedChange={(checked: boolean) => setDownloads(checked)}
						/>
						{download && (
							<p className="text-sm text-kumo-subtle" aria-live="polite">
								MP4: {download.status === "ready" ? "ready" : `${download.status ?? "pending"}${download.percent ? ` (${Math.round(download.percent)}%)` : ""}`}
							</p>
						)}
						{error && <Banner variant="error" role="alert" description={error} />}
						<div className="flex justify-end gap-2">
							<Button type="button" variant="secondary" disabled={pending} onClick={props.onClose}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" disabled={pending}>
								{pending ? "Saving…" : "Save"}
							</Button>
						</div>
					</form>
				)}
				{error && !meta && <Banner variant="error" role="alert" className="mt-4" description={error} />}
			</Dialog>
		</Dialog.Root>
	);
}

// ── Captions ─────────────────────────────────────────────────────

function CaptionsDialog(props: { video: Video | null; onClose: () => void }) {
	const [captions, setCaptions] = React.useState<Caption[]>();
	const [lang, setLang] = React.useState("en");
	const [file, setFile] = React.useState<File | null>(null);
	const [busy, setBusy] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	const uid = props.video?.uid;

	React.useEffect(() => {
		setCaptions(undefined);
		setError(undefined);
		if (!uid) return;
		post<{ captions: Caption[] }>("captions/list", { uid })
			.then((d) => setCaptions(d.captions))
			.catch((cause) => setError(errorText(cause, "Could not load captions")));
	}, [uid]);

	const run = async (label: string, path: string, body: Record<string, unknown>) => {
		if (!uid) return;
		setBusy(label);
		setError(undefined);
		try {
			const d = await post<{ captions?: Caption[] }>(path, { uid, ...body });
			if (d.captions) setCaptions(d.captions);
		} catch (cause) {
			setError(errorText(cause, `${label} failed`));
		} finally {
			setBusy(undefined);
		}
	};

	const upload = async () => {
		if (!file) return;
		if (file.size > 1_500_000) {
			setError("Caption files must be under 1.5 MB.");
			return;
		}
		await run("Upload", "captions/upload", { lang: lang.trim(), vtt: await file.text() });
		setFile(null);
	};

	return (
		<Dialog.Root open={props.video !== null} onOpenChange={(open) => !open && !busy && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Captions{props.video ? `: ${props.video.name}` : ""}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Upload a WebVTT file or have Stream generate captions from the audio. Ready tracks are copied to the site for
					the caption files and transcript in schema.
				</Dialog.Description>
				<div className="mt-4 space-y-4">
					{!captions && !error ? (
						<div className="py-6 text-center">
							<Loader />
						</div>
					) : captions && captions.length === 0 ? (
						<p className="text-sm text-kumo-subtle">No captions yet.</p>
					) : (
						<ul className="divide-y rounded-lg border">
							{(captions ?? []).map((c) => (
								<li key={c.language} className="flex items-center gap-3 px-3 py-2 text-sm">
									<span className="font-mono">{c.language}</span>
									<span className="flex-1 truncate">{c.label}</span>
									{c.generated && <Badge variant="outline">generated</Badge>}
									<Badge variant={c.status === "ready" ? "secondary" : "outline"}>{c.status ?? "ready"}</Badge>
									<Button
										variant="ghost"
										shape="square"
										icon={<Trash aria-hidden="true" />}
										aria-label={`Delete ${c.language} captions`}
										disabled={Boolean(busy)}
										onClick={() => {
											if (window.confirm(`Delete the ${c.language} captions?`)) void run("Delete", "captions/delete", { lang: c.language });
										}}
									/>
								</li>
							))}
						</ul>
					)}
					<div className="grid gap-3 cw-sm-cols-8-fill sm:items-end">
						<Input label="Language" value={lang} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLang(e.target.value)} />
						<div>
							<label className="mb-1.5 block text-sm font-medium" htmlFor="cw-vtt-file">
								WebVTT file
							</label>
							<input
								id="cw-vtt-file"
								type="file"
								accept=".vtt,text/vtt"
								className="block w-full text-sm"
								onChange={(e) => setFile(e.target.files?.[0] ?? null)}
							/>
						</div>
					</div>
					<div className="flex flex-wrap justify-end gap-2">
						<Button variant="secondary" disabled={Boolean(busy)} onClick={() => void run("Refresh", "captions/refresh", {}).then(() => run("Reload", "captions/list", {}))}>
							Copy to site
						</Button>
						<Button variant="secondary" disabled={Boolean(busy) || !lang.trim()} onClick={() => void run("Generate", "captions/generate", { lang: lang.trim() })}>
							Generate {lang.trim() || "…"}
						</Button>
						<Button variant="primary" icon={<UploadSimple />} disabled={Boolean(busy) || !file || !lang.trim()} onClick={() => void upload()}>
							Upload
						</Button>
					</div>
					<p className="text-sm text-kumo-subtle" aria-live="polite">
						{busy ? `${busy}…` : ""}
					</p>
					{error && <Banner variant="error" role="alert" description={error} />}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Upload ───────────────────────────────────────────────────────

/**
 * Sends the file through the site in pieces (videos/upload-chunk), which forwards each to
 * Stream. EmDash's admin Content-Security-Policy (connect-src 'self') blocks the browser
 * from uploading to Stream directly. A piece that fails on the network is retried.
 */
async function uploadThroughSite(uid: string, chunkBytes: number, file: File, onProgress: (pct: number) => void): Promise<void> {
	let offset = 0;
	while (offset < file.size) {
		const piece = file.slice(offset, offset + chunkBytes);
		let response: Response | null = null;
		for (let attempt = 1; ; attempt++) {
			try {
				response = await apiFetch(`${API}/upload-chunk`, {
					method: "POST",
					headers: { "Content-Type": "application/octet-stream", "x-cw-upload-uid": uid, "x-cw-upload-offset": String(offset) },
					body: piece,
				});
				break;
			} catch (cause) {
				if (attempt >= 3) throw new Error("The upload was interrupted. Check your connection and try again.", { cause });
				await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
			}
		}
		const result = await parseApiResponse<{ offset: number; done: boolean }>(response, "Stream refused part of the upload");
		offset = result.offset;
		onProgress((offset / file.size) * 100);
	}
}

function UploadDialog(props: { open: boolean; onClose: () => void; onUploaded: (name: string) => void }) {
	const [file, setFile] = React.useState<File | null>(null);
	const [name, setName] = React.useState("");
	const [tags, setTags] = React.useState("");
	const [progress, setProgress] = React.useState<number | null>(null);
	const [error, setError] = React.useState<string>();

	const start = async () => {
		if (!file) return;
		setError(undefined);
		setProgress(0);
		try {
			// Stream turns any file into a "video" (a still image becomes a one-frame clip).
			if (!file.type.startsWith("video/")) throw new Error("Choose a video file (MP4, MOV, WebM…), not an image or other file.");
			const target = await post<{ uid: string; chunkBytes: number }>("upload", {
				name: name.trim() || file.name,
				size: file.size,
				type: file.type,
				...(tags.trim() ? { tags } : {}),
			});
			await uploadThroughSite(target.uid, target.chunkBytes, file, setProgress);
			const label = name.trim() || file.name;
			setFile(null);
			setName("");
			setProgress(null);
			props.onUploaded(label);
		} catch (cause) {
			setError(errorText(cause, "Upload failed"));
			setProgress(null);
		}
	};
	const uploading = progress !== null;

	return (
		<Dialog.Root open={props.open} onOpenChange={(open) => !open && !uploading && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Upload a video</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					The file goes to Cloudflare Stream through this site, a few megabytes at a time. Keep this dialog open until the upload finishes;
					Stream then processes the video for a few minutes.
				</Dialog.Description>
				<div className="mt-4 space-y-4">
					<div>
						<label className="mb-1.5 block text-sm font-medium" htmlFor="cw-video-file">
							Video file
						</label>
						<input
							id="cw-video-file"
							type="file"
							accept="video/*"
							className="block w-full text-sm"
							disabled={uploading}
							onChange={(e) => {
								const f = e.target.files?.[0] ?? null;
								setFile(f);
								if (f && !name) setName(f.name.replace(/\.[^.]+$/, ""));
							}}
						/>
					</div>
					<Input label="Name" value={name} disabled={uploading} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
					<Input
						label="Tags (optional)"
						placeholder="tutorial, product"
						description="Comma-separated. Empty uses the default tags from Settings → Uploads."
						value={tags}
						disabled={uploading}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTags(e.target.value)}
					/>
					{uploading && (
						<div>
							<progress className="w-full" max={100} value={progress ?? 0} aria-label="Upload progress" />
						</div>
					)}
					<p className="text-sm text-kumo-subtle" aria-live="polite">
						{uploading ? `Uploading… ${Math.round(progress ?? 0)}%` : ""}
					</p>
					{error && <Banner variant="error" role="alert" description={error} />}
					<div className="flex justify-end gap-2">
						<Button variant="secondary" disabled={uploading} onClick={props.onClose}>
							Cancel
						</Button>
						<Button variant="primary" icon={<UploadSimple />} disabled={uploading || !file} onClick={() => void start()}>
							Upload
						</Button>
					</div>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Delete ───────────────────────────────────────────────────────

function DeleteDialog(props: { video: Video | null; onClose: () => void; onDeleted: (message: string) => void }) {
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const video = props.video;
	React.useEffect(() => setError(undefined), [video]);
	const used = video?.usedIn ?? [];
	const remove = async () => {
		if (!video) return;
		setPending(true);
		setError(undefined);
		try {
			await post("delete", { uid: video.uid, force: used.length > 0 });
			props.onDeleted(`Deleted ${video.name}.`);
		} catch (cause) {
			setError(errorText(cause, "Could not delete the video"));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog.Root open={video !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Delete {video?.name ?? "video"}?</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					This permanently deletes the video from Cloudflare Stream, with its captions and download, and removes its plays, likes and details from
					this site. It can't be undone.
				</Dialog.Description>
				{used.length > 0 && (
					<Banner
						className="mt-4"
						variant="error"
						title={`Used in ${used.length} ${used.length === 1 ? "entry" : "entries"}`}
						description={
							<>
								These will show nothing where the video was until you remove its block:
								<ul className="mt-1 list-disc ps-5">
									{used.slice(0, 10).map((u, i) => (
										<li key={i}>
											{u.title ?? "(untitled)"} ({u.collection}, {u.status})
										</li>
									))}
									{used.length > 10 && <li>and {used.length - 10} more</li>}
								</ul>
							</>
						}
					/>
				)}
				{error && <Banner variant="error" role="alert" className="mt-4" description={error} />}
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="secondary" disabled={pending} onClick={props.onClose}>
						Cancel
					</Button>
					<Button variant="destructive" icon={<Trash />} disabled={pending} onClick={() => void remove()}>
						{pending ? "Deleting…" : used.length ? "Delete anyway" : "Delete"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Settings ─────────────────────────────────────────────────────

async function loadSettings(): Promise<VideosSettings> {
	return parseApiResponse<VideosSettings>(await apiFetch(`${API}/settings`), "Could not load the Videos settings");
}

/** Account ID and token: the setup card before Stream is connected. */
function ConnectForm(props: { onConnected: () => void }) {
	const [settings, setSettings] = React.useState<VideosSettings>();
	const [accountId, setAccountId] = React.useState("");
	const [token, setToken] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		loadSettings()
			.then((s) => {
				setSettings(s);
				setAccountId(s.accountId);
			})
			.catch((cause) => setError(errorText(cause, "Could not load the Videos settings")));
	}, []);
	const save = async () => {
		setPending(true);
		setError(undefined);
		try {
			await post("settings/save", { accountId: accountId.trim(), ...(token.trim() ? { token: token.trim() } : {}) });
			setToken("");
			props.onConnected();
		} catch (cause) {
			setError(errorText(cause, "Could not save"));
		} finally {
			setPending(false);
		}
	};
	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<Input
					label="Cloudflare account ID"
					description={settings?.envAccountId ? "Empty uses the CF_ACCOUNT_ID Worker variable." : "Dashboard → any domain → Account ID (32 characters)."}
					value={accountId}
					disabled={pending}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAccountId(e.target.value)}
				/>
				<SecretField
					label="Stream API token"
					saved={settings?.tokenSet ?? false}
					value={token}
					onChange={setToken}
					description={settings?.envToken ? "Empty uses the CF_STREAM_TOKEN Worker secret." : "An API token with Account → Stream → Edit. Stored encrypted."}
					disabled={pending}
				/>
			</div>
			<CredentialGuide id="stream" />
			{error && <Banner variant="error" role="alert" description={error} />}
			<Button type="submit" variant="primary" disabled={pending || (!accountId.trim() && !token.trim())}>
				{pending ? "Connecting…" : "Connect"}
			</Button>
		</form>
	);
}

function SettingsPanel(props: { onSaved: (message: string) => void }) {
	const [saved, setSaved] = React.useState<VideosSettings>();
	const toDraft = (s: VideosSettings) => ({
		accountId: s.accountId,
		token: "",
		customerSubdomain: s.customerSubdomain,
		accentColor: s.accentColor,
		backgroundColor: s.backgroundColor,
		lightEmbed: s.lightEmbed,
		display: toDisplayDraft(s.display),
		defaultTags: s.defaultTags,
	});
	const [draft, setDraft] = React.useState<ReturnType<typeof toDraft>>();
	const [pending, setPending] = React.useState<"save" | "clear">();
	const [error, setError] = React.useState<string>();
	const apply = (s: VideosSettings) => {
		setSaved(s);
		setDraft(toDraft(s));
	};
	React.useEffect(() => {
		loadSettings()
			.then(apply)
			.catch((cause) => setError(errorText(cause, "Could not load the Videos settings")));
	}, []);
	const set = (patch: Partial<NonNullable<typeof draft>>) => setDraft((d) => (d ? { ...d, ...patch } : d));
	const save = async (clearToken = false) => {
		if (!draft) return;
		setPending(clearToken ? "clear" : "save");
		setError(undefined);
		try {
			const { token, display, ...rest } = draft;
			apply(
				await post<VideosSettings>("settings/save", {
					...rest,
					display: fromDisplayDraft(display),
					...(clearToken ? { clearToken: true } : token.trim() ? { token: token.trim() } : {}),
				}),
			);
			props.onSaved(clearToken ? "Stream API token removed." : "Videos settings saved.");
		} catch (cause) {
			setError(errorText(cause, "Could not save the settings"));
		} finally {
			setPending(undefined);
		}
	};
	if (!saved || !draft)
		return error ? (
			<Banner variant="error" role="alert" title="Could not load the settings" description={error} />
		) : (
			<div className="py-12 text-center">
				<Loader />
			</div>
		);
	const text = (key: "accountId" | "customerSubdomain" | "accentColor" | "defaultTags") => ({
		value: draft[key],
		disabled: Boolean(pending),
		onChange: (e: React.ChangeEvent<HTMLInputElement>) => set({ [key]: e.target.value }),
	});
	const dirty = isDirty(draft, toDraft(saved));
	return (
		<>
			<form
				id="cw-videos-settings-form"
				className="space-y-6"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<SettingsSection
					id="videos-connection"
					title="Cloudflare Stream connection"
					description="The account that holds your Stream library and an API token with Account → Stream → Edit. Empty fields fall back to the CF_ACCOUNT_ID and CF_STREAM_TOKEN Worker variables."
				>
					<div className="grid gap-4 sm:grid-cols-2">
						<Input label="Cloudflare account ID" description={saved.envAccountId ? "CF_ACCOUNT_ID is set; it's used when this is empty." : undefined} {...text("accountId")} />
						<SecretField
							label="Stream API token"
							saved={saved.tokenSet}
							value={draft.token}
							onChange={(value) => set({ token: value })}
							description={saved.envToken ? "CF_STREAM_TOKEN is set; it's used when no token is saved here." : "Stored encrypted."}
							onClear={() => void save(true)}
							clearing={pending === "clear"}
							disabled={Boolean(pending)}
						/>
					</div>
					<CredentialGuide id="stream" />
				</SettingsSection>
				<SettingsSection id="videos-player" title="Player" description="How the Coywolf Video block's player looks and where it loads from.">
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							label="Stream customer subdomain"
							placeholder="customer-abc123.cloudflarestream.com"
							description="Stream → any video → Embed. Learned from the library automatically when empty."
							{...text("customerSubdomain")}
						/>
						<Input label="Accent color" placeholder="#f6821f" description="Stream's play button and progress bar. Empty uses Stream's default." {...text("accentColor")} />
					</div>
					<Checkbox
						label="Load the player only when it's needed (faster pages)"
						checked={draft.lightEmbed}
						disabled={Boolean(pending)}
						onCheckedChange={(checked: boolean) => set({ lightEmbed: checked })}
					/>
					<p className="text-sm leading-5 text-pretty text-kumo-subtle">
						Pages show the video's poster, sized for the screen, and load Stream's player (about 350 KB) when someone presses play.
						Autoplaying videos start on the visitor's first scroll or tap once they're on screen. On mobile, a video near the top of a
						page otherwise loads with it and can hold back the page's first paint by several seconds. Turn this off to load the
						player with the page.
					</p>
				</SettingsSection>
				<DisplaySettings
					draft={draft.display}
					background={draft.backgroundColor}
					disabled={Boolean(pending)}
					onChange={(patch) => set({ display: { ...draft.display, ...patch } })}
					onBackground={(value) => set({ backgroundColor: value })}
				/>
				<SettingsSection id="videos-uploads" title="Uploads">
					<Input
						label="Default tags"
						placeholder="tutorial, product"
						description="Added to every video you upload here (you can change them in the upload dialog). Comma-separated; tags are kept in Stream's video metadata, like Video Manager's."
						{...text("defaultTags")}
					/>
				</SettingsSection>
				{error && <Banner variant="error" role="alert" description={error} />}
			</form>
			<SaveBar
				form="cw-videos-settings-form"
				dirty={dirty}
				saving={pending === "save"}
				canSave={!pending}
				onDiscard={() => apply(saved)}
			/>
		</>
	);
}

// ── Page ─────────────────────────────────────────────────────────

export function VideosPage() {
	const [status, setStatus] = React.useState<Status>();
	const [videos, setVideos] = React.useState<Video[]>();
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const [query, setQuery] = React.useState("");
	const [editing, setEditing] = React.useState<Video | null>(null);
	const [captioning, setCaptioning] = React.useState<Video | null>(null);
	const [deleting, setDeleting] = React.useState<Video | null>(null);
	const [filter, setFilter] = React.useState<Filter>("all");
	const [orphans, setOrphans] = React.useState<Orphan[]>([]);
	const [storage, setStorage] = React.useState<StorageUsage | null>(null);
	const [uploading, setUploading] = React.useState(false);
	const [busy, setBusy] = React.useState<string>();
	const [tab, setTab] = React.useState("library");

	const load = React.useCallback(async (refresh = false) => {
		setError(undefined);
		try {
			const s = await parseApiResponse<Status>(await apiFetch(`${API}/status`), "Could not load the Videos status");
			setStatus(s);
			if (!s.configured) {
				setVideos([]);
				return;
			}
			const data = await post<{ items: Video[]; orphans?: Orphan[] }>("list", { refresh });
			setVideos(data.items);
			setOrphans(data.orphans ?? []);
			// Optional: a token without storage access still lists the library.
			post<StorageUsage>("storage")
				.then(setStorage)
				.catch(() => setStorage(null));
		} catch (cause) {
			setError(errorText(cause, "Could not load videos"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const action = async (label: string, fn: () => Promise<string>) => {
		setBusy(label);
		setError(undefined);
		setNotice(undefined);
		try {
			setNotice(await fn());
		} catch (cause) {
			setError(errorText(cause, `${label} failed`));
		} finally {
			setBusy(undefined);
		}
	};

	const test = () => action("Test connection", async () => (await post<{ message: string }>("test")).message);

	const reindex = () =>
		action("Rebuild index", async () => {
			let state: unknown = null;
			let found = 0;
			let scanned = 0;
			let removed = 0;
			for (let i = 0; i < 500; i++) {
				const r = await post<{ done: boolean; state: unknown; found: number; scanned: number; removed: number; progress: string }>("reindex", { state });
				removed += r.removed;
				found += r.found;
				scanned += r.scanned;
				setBusy(`Rebuilding the index (${r.progress})`);
				if (r.done) break;
				state = r.state;
			}
			await load();
			return `Scanned ${numberFormat.format(scanned)} entries and found ${numberFormat.format(found)} embedded ${found === 1 ? "video" : "videos"}${removed ? `, and removed ${numberFormat.format(removed)} deleted ${removed === 1 ? "entry" : "entries"} from the index` : ""}.`;
		});

	const webhook = (subscribe: boolean) =>
		action(subscribe ? "Subscribe" : "Unsubscribe", async () => {
			await post(subscribe ? "webhook/subscribe" : "webhook/unsubscribe");
			await load();
			return subscribe ? "Stream will notify this site when videos finish processing." : "Stream webhook removed.";
		});

	// "#tag" words filter by tag (all must match); the rest searches names, descriptions and IDs.
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const tagWords = words.filter((w) => w.startsWith("#") && w.length > 1).map((w) => w.slice(1));
	const q = words.filter((w) => !w.startsWith("#")).join(" ");
	const matchesFilter = (v: Video) =>
		filter === "plays" ? v.plays > 0 : filter === "likes" ? v.likes > 0 : filter === "used" ? v.usedIn.length > 0 : filter === "unused" ? v.usedIn.length === 0 : true;
	const visible = (videos ?? []).filter((v) => {
		const tags = (v.tags ?? []).map((t) => t.toLowerCase());
		if (!tagWords.every((t) => tags.includes(t))) return false;
		if (q && !(v.name.toLowerCase().includes(q) || v.uid.includes(q) || v.description.toLowerCase().includes(q))) return false;
		return matchesFilter(v);
	});
	const f = status?.features ?? {};

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Videos</h1>
					<div className="flex shrink-0 justify-end gap-2">
						{tab === "library" && status?.configured && (
							<>
								<Button variant="secondary" icon={<ArrowClockwise />} disabled={Boolean(busy)} onClick={() => void load(true)}>
									Refresh
								</Button>
								<Button variant="primary" icon={<UploadSimple />} onClick={() => setUploading(true)}>
									Upload
								</Button>
							</>
						)}
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Your Cloudflare Stream library. Add videos to posts with the <strong>Coywolf Video</strong> block; plays,
						likes and the posts each video appears in show here.
					</p>
				</div>
				{tab === "library" && status?.configured && (
					<div className="flex flex-wrap items-end gap-4">
						<div className="w-full sm:w-72">
							<Input
								label="Search"
								placeholder="Name, description, video ID or #tag"
								value={query}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
							/>
						</div>
						<div className="w-full sm:w-48">
							<Select
								label="Show"
								value={filter}
								onValueChange={(value: string | null) => setFilter((value as Filter | null) ?? "all")}
								items={[
									{ value: "all", label: "All videos" },
									...(f.engagement
										? [
												{ value: "plays", label: "With plays" },
												{ value: "likes", label: "With likes" },
											]
										: []),
									{ value: "used", label: "Used in content" },
									{ value: "unused", label: "Not used" },
								]}
							/>
						</div>
						{storage && (
							<p className="text-sm text-kumo-subtle sm:ms-auto">
								{numberFormat.format(storage.videos)} {storage.videos === 1 ? "video" : "videos"} · {numberFormat.format(storage.minutes)}
								{storage.limit ? ` of ${numberFormat.format(storage.limit)}` : ""} minutes stored
							</p>
						)}
					</div>
				)}
			</header>

			<div aria-live="polite">
				{busy && <p className="text-sm text-kumo-subtle">{busy}…</p>}
				{notice && <Banner variant="default" role="status" title={notice} />}
			</div>
			{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			{tab === "library" && orphans.length > 0 && (
				<Banner
					variant="error"
					title={`${orphans.length} embedded ${orphans.length === 1 ? "video is" : "videos are"} no longer in Cloudflare Stream`}
					description={
						<>
							Deleted in Stream's dashboard, so these entries show nothing where the video was. Remove the blocks (or upload the video again and
							choose it in the block), then rebuild the embed index under Tools.
							<ul className="mt-1 list-disc ps-5">
								{orphans.slice(0, 10).map((o) => (
									<li key={o.uid}>
										<span className="font-mono">{o.uid}</span>: {o.usedIn.map((u) => u.title ?? "(untitled)").join(", ")}
									</li>
								))}
								{orphans.length > 10 && <li>and {orphans.length - 10} more</li>}
							</ul>
						</>
					}
				/>
			)}

			{status && (
				<Tabs
					value={tab}
					onValueChange={setTab}
					tabs={[
						{ value: "library", label: "Library" },
						{ value: "settings", label: "Settings" },
					]}
				/>
			)}

			{tab === "settings" && (
				<SettingsPanel
					onSaved={(message) => {
						setNotice(message);
						void load(true);
					}}
				/>
			)}

			{tab === "library" && status && !status.configured && (
				<SetupCard
					title="Add a Stream API token to manage videos"
					description="Connect your Cloudflare Stream account to see the library, upload videos, manage captions and subscribe to the Stream webhook. Or set the CF_ACCOUNT_ID and CF_STREAM_TOKEN Worker variables and reload this page."
				>
					<ConnectForm
						onConnected={() => {
							setNotice("Connected to Cloudflare Stream.");
							void load(true);
						}}
					/>
				</SetupCard>
			)}

			{tab !== "library" ? null : !videos && !error ? (
				<div className="py-12 text-center text-kumo-subtle">
					<Loader />
				</div>
			) : videos && status?.configured && videos.length === 0 ? (
				<div className="py-10 text-center text-kumo-subtle">
					<VideoCamera size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
					<p className="text-base font-medium">No videos yet</p>
					<p className="mt-1 text-sm">Upload one to get started.</p>
				</div>
			) : videos && videos.length > 0 ? (
				<div className="rounded-lg border">
					<div className="flex items-center gap-4 border-b bg-kumo-tint/50 px-4 py-2 text-sm font-medium text-kumo-subtle">
						<div className="w-24 shrink-0" />
						<div className="min-w-0 flex-1">Video</div>
						<div className="w-16 text-end">Length</div>
						<div className="w-32 cw-lg-block">Uploaded</div>
						{f.engagement && <div className="hidden w-16 text-end md:block">Plays</div>}
						{f.engagement && <div className="hidden w-14 text-end md:block">Likes</div>}
						<div className="w-16 text-end">Used in</div>
						<div className="w-10" />
					</div>
					{visible.map((v) => (
						<div key={v.uid} className="flex items-center gap-4 border-b px-4 py-2 text-sm last:border-0">
							<div className="w-24 shrink-0">
								<img src={v.thumbnail} alt="" loading="lazy" width={96} height={54} className="aspect-video w-24 rounded bg-kumo-tint object-cover" />
							</div>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium" title={v.name}>
									{v.name}
								</div>
								<div className="mt-0.5 flex items-center gap-1 truncate text-xs text-kumo-subtle">
									<span className="font-mono">{v.uid}</span>
									{!v.ready && <Badge variant="outline">{v.state}</Badge>}
									{v.captions.length > 0 && <Badge variant="outline">CC</Badge>}
								</div>
								{(v.tags ?? []).length > 0 && (
									<div className="mt-1 flex flex-wrap gap-1">
										{(v.tags ?? []).map((t) => (
											<button
												key={t}
												type="button"
												className="rounded text-xs text-kumo-subtle underline-offset-2 hover:underline"
												aria-label={`Show videos tagged ${t}`}
												onClick={() => setQuery(`#${t}`)}
											>
												#{t}
											</button>
										))}
									</div>
								)}
							</div>
							<div className="w-16 text-end tabular-nums">{clock(v.duration)}</div>
							<div className="w-32 text-xs text-kumo-subtle cw-lg-block">{v.created ? dateFormat.format(new Date(v.created)) : ""}</div>
							{f.engagement && <div className="hidden w-16 text-end tabular-nums md:block">{numberFormat.format(v.plays)}</div>}
							{f.engagement && <div className="hidden w-14 text-end tabular-nums md:block">{numberFormat.format(v.likes)}</div>}
							<div
								className="w-16 text-end tabular-nums"
								title={v.usedIn.map((u) => `${u.title ?? "(untitled)"} (${u.collection}, ${u.status})`).join("\n") || "Not used"}
							>
								{v.usedIn.length}
							</div>
							<div className="flex w-10 justify-end">
								<DropdownMenu>
									<DropdownMenu.Trigger
										render={
											<Button type="button" variant="ghost" shape="square" icon={<DotsThree aria-hidden="true" />} aria-label={`Actions for ${v.name}`} />
										}
									/>
									<DropdownMenu.Content className="p-1">
										<DropdownMenu.Item
											className="py-1 data-highlighted:bg-kumo-fill"
											icon={<PencilSimple className="me-1.5 size-3.5" aria-hidden="true" />}
											onClick={() => setEditing(v)}
										>
											Edit
										</DropdownMenu.Item>
										{f.captions && (
											<DropdownMenu.Item
												className="py-1 data-highlighted:bg-kumo-fill"
												icon={<ClosedCaptioning className="me-1.5 size-3.5" aria-hidden="true" />}
												onClick={() => setCaptioning(v)}
											>
												Captions
											</DropdownMenu.Item>
										)}
										<DropdownMenu.Item
											className="py-1 data-highlighted:bg-kumo-fill"
											icon={<Copy className="me-1.5 size-3.5" aria-hidden="true" />}
											onClick={() => {
												void navigator.clipboard.writeText(v.uid);
												setNotice(`Copied the ID of ${v.name}.`);
											}}
										>
											Copy video ID
										</DropdownMenu.Item>
										<DropdownMenu.Item
											className="py-1 text-kumo-danger data-highlighted:bg-kumo-fill"
											icon={<Trash className="me-1.5 size-3.5" aria-hidden="true" />}
											onClick={() => setDeleting(v)}
										>
											Delete
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu>
							</div>
						</div>
					))}
					{visible.length === 0 && <p className="px-4 py-6 text-center text-sm text-kumo-subtle">No videos match.</p>}
				</div>
			) : null}

			{tab === "library" && status?.configured && (
				<section className="space-y-3 border-t border-kumo-line pt-4" aria-labelledby="cw-videos-tools">
					<h2 id="cw-videos-tools" className="text-base font-semibold">
						Tools
					</h2>
					<div className="flex flex-wrap gap-2">
						<Button variant="secondary" icon={<Plug />} disabled={Boolean(busy)} onClick={() => void test()}>
							Test connection
						</Button>
						<Button variant="secondary" disabled={Boolean(busy)} onClick={() => void reindex()}>
							Rebuild embed index
						</Button>
						{f.webhook &&
							(status.webhook.subscribed ? (
								<Button variant="secondary" disabled={Boolean(busy)} onClick={() => void webhook(false)}>
									Unsubscribe Stream webhook
								</Button>
							) : (
								<Button variant="secondary" disabled={Boolean(busy)} onClick={() => void webhook(true)}>
									Subscribe Stream webhook
								</Button>
							))}
					</div>
					<ul className="space-y-1 text-sm text-kumo-subtle">
						<li>Player host: {status.host ?? "not known yet (refresh the library, or set the customer subdomain under Settings)"}</li>
						{f.sitemap && (
							<li>
								Video sitemap:{" "}
								<a className="underline" href={status.sitemapUrl} target="_blank" rel="noreferrer">
									{status.sitemapUrl}
								</a>{" "}
								(add it to your robots.txt or Search Console)
							</li>
						)}
						{f.webhook && <li>Webhook: {status.webhook.subscribed ? `subscribed (${status.webhook.url})` : "not subscribed"}</li>}
					</ul>
				</section>
			)}

			<EditDialog
				video={editing}
				onClose={() => setEditing(null)}
				onSaved={(message) => {
					setEditing(null);
					setNotice(message);
					void load(true);
				}}
			/>
			<CaptionsDialog video={captioning} onClose={() => setCaptioning(null)} />
			<DeleteDialog
				video={deleting}
				onClose={() => setDeleting(null)}
				onDeleted={(message) => {
					setDeleting(null);
					setNotice(message);
					void load(true);
				}}
			/>
			<UploadDialog
				open={uploading}
				onClose={() => setUploading(false)}
				onUploaded={(name) => {
					setUploading(false);
					setNotice(`Uploaded ${name}. Stream is processing it.`);
					void load(true);
				}}
			/>
		</div>
	);
}

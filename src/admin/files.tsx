/**
 * Files page: download files used by File download blocks and large uploads,
 * with downloads, where each is used, a large-file uploader (through the site to
 * R2), and delete.
 */
import { Badge, Banner, Button, Dialog, DropdownMenu, Input, Loader, Meter, Select, Tabs } from "@cloudflare/kumo";
import { ArrowsClockwise, CloudArrowUp, DotsThree, DownloadSimple, FileArrowDown, LinkSimple, Trash, X } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { FILE_CSS, SAMPLE_FILE, renderFileCardHtml } from "../files/card.js";
import { filesToCsv } from "../files/export.js";
import { formatSize, iconFor } from "../files/format.js";
import { saveFile, siteSlug, today } from "./download.js";
import { CredentialGuide } from "./guides.js";
import { PreviewSection } from "./preview.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SecretField, SettingsSection, SetupCard } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/files";
const CONCURRENCY = 4;

interface Usage {
	collection: string;
	id: string;
	title: string;
}

interface FileItem {
	id: string;
	source: "upload" | "media" | "missing";
	status: "ready" | "uploading";
	name: string;
	type: string;
	ext: string;
	size: number;
	uploadedAt: string | null;
	url: string | null;
	downloads: number;
	lastDownload: string | null;
	usedIn: Usage[];
}

interface ListResponse {
	items: FileItem[];
	base: string;
	countsEnabled: boolean;
	largeUploadsEnabled: boolean;
	r2Configured: boolean;
}

interface FilesSettings {
	filesBase: string;
	filesPublicBaseUrl: string;
	filesScheme: "auto" | "light" | "dark";
	filesAccent: string;
	filesMaxUploadGb: number;
	filesR2AccountId: string;
	filesR2AccessKeyId: string;
	filesR2Bucket: string;
	r2SecretSet: boolean;
}

type Filter = "all" | "used" | "unused";

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const formatDate = (iso: string | null) => (iso ? dateFormat.format(new Date(iso)) : "");

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	return parseApiResponse<T>(response, "The request failed");
}

function TypeBadge({ ext }: { ext: string }) {
	const icon = iconFor(ext);
	return (
		<svg width="28" height="34" viewBox="0 0 40 48" fill="none" aria-hidden="true" focusable="false" className="shrink-0">
			<path
				d="M10 3 h14 l10 10 v28 a4 4 0 0 1 -4 4 H10 a4 4 0 0 1 -4 -4 V7 a4 4 0 0 1 4 -4 z"
				className="fill-kumo-base cw-stroke-line"
				strokeWidth="1.5"
			/>
			<path d="M24 3 L24 13 L34 13" className="cw-fill-tint cw-stroke-line" strokeWidth="1.5" strokeLinejoin="round" />
			<rect x="2" y="26" width="27" height="15" rx="3.5" fill={icon.color} />
			<text x="15.5" y="36.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff">
				{icon.label}
			</text>
		</svg>
	);
}

// ── Large upload (multipart, through the site) ───────────────────

interface UploadProgress {
	name: string;
	loaded: number;
	total: number;
}

/**
 * One part, sent to files/upload-part, which uploads it to R2. EmDash's admin
 * Content-Security-Policy (connect-src 'self', since EmDash 1.3.1) blocks the browser
 * from sending parts to R2 itself.
 */
function sendPart(id: string, partNumber: number, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", `${API}/upload-part`);
		xhr.setRequestHeader("X-EmDash-Request", "1");
		xhr.setRequestHeader("Content-Type", "application/octet-stream");
		xhr.setRequestHeader("x-cw-upload-id", id);
		xhr.setRequestHeader("x-cw-part-number", String(partNumber));
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () => {
			let body: { success?: boolean; data?: { etag?: string }; error?: { message?: string } } | null = null;
			try {
				body = JSON.parse(xhr.responseText);
			} catch {
				// Not JSON: report the status below.
			}
			if (xhr.status >= 200 && xhr.status < 300 && body?.data?.etag) return resolve(body.data.etag);
			reject(new Error(body?.error?.message || `The site couldn't store a part (HTTP ${xhr.status}).`));
		};
		xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
		xhr.onabort = () => reject(new DOMException("Upload canceled", "AbortError"));
		signal.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(body);
	});
}

async function uploadLarge(file: File, onProgress: (p: UploadProgress) => void, signal: AbortSignal): Promise<{ id: string; url: string }> {
	const start = await post<{ id: string; partSize: number; partCount: number }>("upload-start", { name: file.name, size: file.size, type: file.type }, signal);
	const { id, partSize, partCount } = start;
	try {
		const loaded = new Array<number>(partCount + 1).fill(0);
		const report = () => onProgress({ name: file.name, loaded: loaded.reduce((a, b) => a + b, 0), total: file.size });
		const etags: Array<{ partNumber: number; etag: string }> = [];

		let next = 1;
		async function worker() {
			while (next <= partCount) {
				const partNumber = next++;
				const blob = file.slice((partNumber - 1) * partSize, Math.min(file.size, partNumber * partSize));
				for (let attempt = 1; ; attempt++) {
					try {
						const etag = await sendPart(
							id,
							partNumber,
							blob,
							(n) => {
								loaded[partNumber] = n;
								report();
							},
							signal,
						);
						loaded[partNumber] = blob.size;
						report();
						etags.push({ partNumber, etag });
						break;
					} catch (error) {
						if (signal.aborted || attempt >= 3) throw error;
						loaded[partNumber] = 0;
						await new Promise((r) => setTimeout(r, 1000 * attempt));
					}
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, partCount) }, worker));
		return await post<{ id: string; url: string }>("upload-complete", { id, parts: etags }, signal);
	} catch (error) {
		await post("upload-abort", { id }).catch(() => undefined);
		throw error;
	}
}

// ── Dialogs ──────────────────────────────────────────────────────

function UsageList({ usedIn }: { usedIn: Usage[] }) {
	return (
		<ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto ps-5 text-sm">
			{usedIn.map((u) => (
				<li key={`${u.collection}:${u.id}`}>
					<a className="text-kumo-link underline" href={`/_emdash/admin/content/${encodeURIComponent(u.collection)}/${encodeURIComponent(u.id)}`}>
						{u.title}
					</a>{" "}
					<span className="text-kumo-subtle">({u.collection})</span>
				</li>
			))}
		</ul>
	);
}

function DeleteDialog(props: { file: FileItem | null; onClose: () => void; onDeleted: (file: FileItem) => void }) {
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => setError(undefined), [props.file]);
	const file = props.file;
	const run = async () => {
		if (!file) return;
		setPending(true);
		setError(undefined);
		try {
			await post("delete", { id: file.id });
			props.onDeleted(file);
		} catch (cause) {
			setError(errorText(cause, "Delete failed"));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog.Root open={file !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{file?.status === "uploading" ? "Discard incomplete upload?" : `Delete ${file?.name}?`}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					The file is removed from the R2 bucket and can't be recovered. Its download link stops working.
				</Dialog.Description>
				{file && file.usedIn.length > 0 && (
					<Banner
						className="mt-4"
						variant="alert"
						title={`Used in ${file.usedIn.length} ${file.usedIn.length === 1 ? "entry" : "entries"}`}
						description={
							<>
								Their File download blocks will render nothing until you remove or replace them:
								<UsageList usedIn={file.usedIn} />
							</>
						}
					/>
				)}
				{error && <Banner className="mt-3" variant="error" role="alert" description={error} />}
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="secondary" disabled={pending} onClick={props.onClose}>
						Cancel
					</Button>
					<Button variant="destructive" disabled={pending} onClick={() => void run()}>
						{pending ? "Deleting…" : "Delete file"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Settings ─────────────────────────────────────────────────────

type SettingsDraft = Omit<FilesSettings, "filesMaxUploadGb" | "r2SecretSet"> & { filesMaxUploadGb: string; filesR2SecretAccessKey: string };

function SettingsPanel(props: { largeUploadsEnabled: boolean; onSaved: (message: string) => void }) {
	const [saved, setSaved] = React.useState<FilesSettings>();
	const [draft, setDraft] = React.useState<SettingsDraft>();
	const [error, setError] = React.useState<string>();
	const [pending, setPending] = React.useState<"save" | "clear">();

	const toDraft = (s: FilesSettings): SettingsDraft => {
		const { r2SecretSet: _set, filesMaxUploadGb, ...rest } = s;
		return { ...rest, filesMaxUploadGb: String(filesMaxUploadGb), filesR2SecretAccessKey: "" };
	};
	const apply = (s: FilesSettings) => {
		setSaved(s);
		setDraft(toDraft(s));
	};
	React.useEffect(() => {
		apiFetch(`${API}/settings`)
			.then((response) => parseApiResponse<FilesSettings>(response, "Could not load the settings"))
			.then(apply)
			.catch((cause) => setError(errorText(cause, "Could not load the settings")));
	}, []);

	const set = (patch: Partial<SettingsDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
	const save = async (clearR2Secret = false) => {
		if (!draft) return;
		setPending(clearR2Secret ? "clear" : "save");
		setError(undefined);
		try {
			const { filesR2SecretAccessKey, filesMaxUploadGb, ...rest } = draft;
			const result = await post<FilesSettings>("settings/save", {
				...rest,
				filesMaxUploadGb: Number(filesMaxUploadGb),
				...(clearR2Secret ? { clearR2Secret: true } : filesR2SecretAccessKey.trim() ? { filesR2SecretAccessKey: filesR2SecretAccessKey.trim() } : {}),
			});
			apply(result);
			props.onSaved(clearR2Secret ? "R2 secret access key removed." : "File Downloads settings saved.");
		} catch (cause) {
			setError(errorText(cause, "Could not save the settings"));
		} finally {
			setPending(undefined);
		}
	};

	if (!draft || !saved)
		return error ? (
			<Banner variant="error" role="alert" title="Could not load the settings" description={error} />
		) : (
			<div className="py-12 text-center">
				<Loader />
			</div>
		);

	const field = (key: "filesBase" | "filesPublicBaseUrl" | "filesAccent" | "filesR2AccountId" | "filesR2AccessKeyId" | "filesR2Bucket") => ({
		value: draft[key],
		onChange: (e: React.ChangeEvent<HTMLInputElement>) => set({ [key]: e.target.value }),
	});

	const dirty = isDirty(draft, toDraft(saved));

	return (
		<>
			<form
				id="cw-files-settings-form"
				className="space-y-6"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<SettingsSection id="files-links" title="Download links" description="Where download links point. Changing the base changes every download link on the site.">
					<div className="grid gap-4 sm:grid-cols-2">
						<Input label="Download URL base" placeholder="download" description={`Links look like /${draft.filesBase || "download"}/<id>/<file name>. One path segment.`} {...field("filesBase")} />
						<Input
							label="Public bucket or CDN URL (optional)"
							placeholder="https://files.example.com"
							description="Redirect downloads to this URL plus the object key instead of streaming them through the Worker. Use only when media and large uploads share that bucket."
							{...field("filesPublicBaseUrl")}
						/>
					</div>
				</SettingsSection>

				<SettingsSection id="files-card" title="Download card" description="How the File download block looks on the site.">
					<div className="grid gap-4 sm:grid-cols-2">
						<Select
							label="Color scheme"
							value={draft.filesScheme}
							onValueChange={(value: string | null) => set({ filesScheme: value === "light" || value === "dark" ? value : "auto" })}
							items={[
								{ value: "auto", label: "Auto (follow the visitor's system setting)" },
								{ value: "light", label: "Light" },
								{ value: "dark", label: "Dark" },
							]}
						/>
						<Input label="Accent color (optional)" placeholder="#007392" description="Hex color for the download button and focus ring. Empty uses the default." {...field("filesAccent")} />
					</div>
					<PreviewSection
						id="files-card-preview"
						title="Download card preview"
						css={FILE_CSS}
						html={renderFileCardHtml(SAMPLE_FILE, { scheme: draft.filesScheme, accent: draft.filesAccent })}
						note="A sample file with every part of the block shown. Auto follows your computer's light or dark setting here, and each visitor's on the site."
					/>
				</SettingsSection>

				<SettingsSection
					id="files-r2"
					title="Large uploads"
					description={
						<>
							Files over 50 MB, or of any type, upload straight from the browser to R2 through its S3 API. Create an R2 API token with Object Read &amp; Write
							on the bucket. R2 storage and operations are billed to your account.
							{!props.largeUploadsEnabled && " Turn on Large uploads under Plugins → Coywolf Pack to use them."}
						</>
					}
				>
					<div className="grid gap-4 sm:grid-cols-2">
						<Input label="R2 account ID" description="Your Cloudflare account ID (32 characters)." {...field("filesR2AccountId")} />
						<Input label="R2 bucket name" placeholder="mysite-media" description="The bucket bound as MEDIA, unless you set a separate uploads binding." {...field("filesR2Bucket")} />
						<Input label="R2 access key ID" autoComplete="off" {...field("filesR2AccessKeyId")} />
						<SecretField
							label="R2 secret access key"
							saved={saved.r2SecretSet}
							value={draft.filesR2SecretAccessKey}
							onChange={(value) => set({ filesR2SecretAccessKey: value })}
							description="Stored encrypted."
							onClear={() => void save(true)}
							clearing={pending === "clear"}
							disabled={Boolean(pending)}
						/>
						<Input
							type="number"
							min={1}
							max={50}
							label="Largest upload (GB)"
							description="Larger uploads are refused. Default 5."
							value={draft.filesMaxUploadGb}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ filesMaxUploadGb: e.target.value })}
						/>
					</div>
					<CredentialGuide id="r2" />
				</SettingsSection>

				{error && <Banner variant="error" role="alert" description={error} />}
			</form>
			<SaveBar
				form="cw-files-settings-form"
				dirty={dirty}
				saving={pending === "save"}
				canSave={!pending}
				onDiscard={() => apply(saved)}
			/>
		</>
	);
}

// ── Page ─────────────────────────────────────────────────────────

export function FilesPage() {
	const [data, setData] = React.useState<ListResponse>();
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const [query, setQuery] = React.useState("");
	const [filter, setFilter] = React.useState<Filter>("all");
	const [deleting, setDeleting] = React.useState<FileItem | null>(null);
	const [busy, setBusy] = React.useState<string>();
	const [progress, setProgress] = React.useState<UploadProgress | null>(null);
	const [tab, setTab] = React.useState("files");
	const abortRef = React.useRef<AbortController | null>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);

	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			setData(await parseApiResponse<ListResponse>(await apiFetch(`${API}/list`), "Could not load files"));
		} catch (cause) {
			setError(errorText(cause, "Could not load files"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	// Stop an upload in progress if the page is left.
	React.useEffect(() => () => abortRef.current?.abort(), []);

	const upload = async (file: File) => {
		const controller = new AbortController();
		abortRef.current = controller;
		setError(undefined);
		setNotice(undefined);
		setProgress({ name: file.name, loaded: 0, total: file.size });
		try {
			await uploadLarge(file, setProgress, controller.signal);
			setNotice(`Uploaded ${file.name}. Add it to an entry with the File download block.`);
			await load();
		} catch (cause) {
			if (controller.signal.aborted) setNotice(`Canceled the upload of ${file.name}.`);
			else setError(errorText(cause, "Upload failed"));
		} finally {
			abortRef.current = null;
			setProgress(null);
		}
	};

	const reindex = async () => {
		setBusy("reindex");
		setError(undefined);
		setNotice("Rebuilding the usage index…");
		try {
			let next: unknown;
			let scanned = 0;
			for (let i = 0; i < 1000; i++) {
				const result = await post<{ done: boolean; scanned: number; next?: unknown }>("reindex", next ? { next } : {});
				scanned += result.scanned;
				if (result.done) break;
				next = result.next;
			}
			setNotice(`Usage index rebuilt from ${scanned.toLocaleString()} ${scanned === 1 ? "entry" : "entries"}.`);
			await load();
		} catch (cause) {
			setNotice(undefined);
			setError(errorText(cause, "Could not rebuild the usage index"));
		} finally {
			setBusy(undefined);
		}
	};

	/** All files (not just the filtered ones), newest first. */
	const exportCsv = () => {
		if (!data) return;
		const files = [...data.items].sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""));
		saveFile(filesToCsv(files, window.location.origin), `files-${siteSlug() || "site"}-${today()}.csv`, "text/csv");
		setNotice(`Exported ${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"}.`);
	};

	const copy = async (file: FileItem) => {
		if (!file.url) return;
		try {
			await navigator.clipboard.writeText(new URL(file.url, window.location.origin).href);
			setNotice(`Copied the download link for ${file.name}.`);
		} catch {
			setError("Could not copy the link.");
		}
	};

	const q = query.trim().toLowerCase();
	const visible = (data?.items ?? [])
		.filter((f) => (filter === "used" ? f.usedIn.length > 0 : filter === "unused" ? f.usedIn.length === 0 : true))
		.filter((f) => !q || f.name.toLowerCase().includes(q) || f.ext.includes(q) || f.usedIn.some((u) => u.title.toLowerCase().includes(q)))
		.sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""));
	const pct = progress && progress.total ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Files</h1>
					<div className="flex shrink-0 flex-wrap justify-end gap-2">
						{tab === "files" && (
							<Button variant="secondary" icon={<DownloadSimple />} disabled={!data?.items.length} title="Download the list of files, with download counts and where each is used, as a CSV file" onClick={exportCsv}>
								Export CSV
							</Button>
						)}
						{tab === "files" && (
							<Button variant="secondary" icon={<ArrowsClockwise />} disabled={!!busy} onClick={() => void reindex()}>
								{busy === "reindex" ? "Rebuilding…" : "Rebuild usage"}
							</Button>
						)}
						{tab === "files" && data?.largeUploadsEnabled && data.r2Configured && (
							<>
								<Button variant="primary" icon={<CloudArrowUp />} disabled={!!progress} onClick={() => inputRef.current?.click()}>
									Upload large file
								</Button>
								<input
									ref={inputRef}
									type="file"
									className="sr-only"
									tabIndex={-1}
									aria-hidden="true"
									onChange={(e) => {
										const file = e.target.files?.[0];
										e.target.value = "";
										if (file) void upload(file);
									}}
								/>
							</>
						)}
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Files offered for download with the File download block: Media Library files used in blocks, and large uploads.
						{data ? (
							<>
								{" "}
								Download links look like <code>/{data.base}/&lt;id&gt;/&lt;file name&gt;</code>.
							</>
						) : null}
						{data && !data.largeUploadsEnabled ? " Turn on Large uploads (Plugins → Coywolf Pack) to upload files over 50 MB or of any type." : ""}
					</p>
				</div>
				{tab === "files" && (
				<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
					<div className="sm:w-72">
						<Input
							label="Search"
							placeholder="File names, types, entries"
							value={query}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
						/>
					</div>
					<div className="sm:w-44">
						<Select
							label="Show"
							value={filter}
							onValueChange={(value: string | null) => setFilter((value as Filter) ?? "all")}
							items={[
								{ value: "all", label: "All files" },
								{ value: "used", label: "In use" },
								{ value: "unused", label: "Unused" },
							]}
						/>
					</div>
				</div>
				)}
			</header>

			<Tabs
				value={tab}
				onValueChange={setTab}
				tabs={[
					{ value: "files", label: "Files" },
					{ value: "settings", label: "Settings" },
				]}
			/>

			<div aria-live="polite" className="space-y-3">
				{progress && (
					<div className="flex items-end gap-3 rounded-lg border border-kumo-line p-4">
						<div className="min-w-0 flex-1">
							<Meter label={`Uploading ${progress.name}`} value={pct} customValue={`${formatSize(progress.loaded)} of ${formatSize(progress.total)} (${pct}%)`} />
						</div>
						<Button variant="secondary" icon={<X />} onClick={() => abortRef.current?.abort()}>
							Cancel
						</Button>
					</div>
				)}
				{notice && <Banner variant="default" role="status" title={notice} />}
			</div>
			{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}

			{tab === "settings" ? (
				<SettingsPanel
					largeUploadsEnabled={data?.largeUploadsEnabled ?? false}
					onSaved={(message) => {
						setError(undefined);
						setNotice(message);
						void load();
					}}
				/>
			) : null}

			{tab === "files" && data?.largeUploadsEnabled && !data.r2Configured && (
				<SetupCard
					title="Add R2 credentials to upload large files"
					description="Large uploads go straight from the browser to your R2 bucket, so they need an R2 API token: the account ID, access key ID, secret access key and bucket name."
				>
					<CredentialGuide id="r2" />
					<Button variant="secondary" onClick={() => setTab("settings")}>
						Open Settings
					</Button>
				</SetupCard>
			)}

			{tab !== "files" ? null : !data && !error ? (
				<div className="py-12 text-center text-kumo-subtle">
					<Loader />
				</div>
			) : data && data.items.length === 0 ? (
				<div className="py-10 text-center text-kumo-subtle">
					<FileArrowDown size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
					<p className="text-base font-medium">No download files yet</p>
					<p className="mt-1 text-sm">Add a File download block to an entry, or upload a large file.</p>
				</div>
			) : data ? (
				<div className="rounded-lg border" role="table" aria-label="Download files">
					<div role="row" className="flex items-center gap-4 border-b bg-kumo-tint/50 px-4 py-2 text-sm font-medium text-kumo-subtle">
						<div role="columnheader" className="min-w-0 flex-1">
							File
						</div>
						<div role="columnheader" className="hidden w-20 text-end sm:block">
							Size
						</div>
						<div role="columnheader" className="w-32 cw-lg-block">
							Uploaded
						</div>
						{data.countsEnabled && (
							<div role="columnheader" className="hidden w-24 text-end md:block">
								Downloads
							</div>
						)}
						<div role="columnheader" className="w-20 text-end">
							Used in
						</div>
						<div role="columnheader" className="w-10">
							<span className="sr-only">Actions</span>
						</div>
					</div>
					{visible.map((file) => (
						<div role="row" key={file.id} className={`flex items-center gap-4 border-b px-4 py-2 text-sm last:border-0 ${file.status === "uploading" ? "opacity-60" : ""}`}>
							<div role="cell" className="flex min-w-0 flex-1 items-center gap-3">
								<TypeBadge ext={file.ext} />
								<div className="min-w-0">
									<div className="truncate font-medium" title={file.name}>
										{file.name}
									</div>
									<div className="mt-0.5 flex items-center gap-1 text-xs text-kumo-subtle">
										{file.source === "upload" && file.status === "ready" && <Badge variant="outline">Large upload</Badge>}
										{file.source === "media" && <Badge variant="outline">Media Library</Badge>}
										{file.status === "uploading" && <Badge variant="secondary">Incomplete upload</Badge>}
										{file.source === "missing" && <Badge variant="destructive">Missing</Badge>}
										<span className="truncate">{file.type}</span>
									</div>
								</div>
							</div>
							<div role="cell" className="hidden w-20 text-end tabular-nums sm:block">
								{file.size ? formatSize(file.size) : "—"}
							</div>
							<div role="cell" className="w-32 text-xs text-kumo-subtle cw-lg-block">
								{formatDate(file.uploadedAt) || "—"}
							</div>
							{data.countsEnabled && (
								<div role="cell" className="hidden w-24 text-end tabular-nums md:block" title={file.lastDownload ? `Last download ${formatDate(file.lastDownload)}` : undefined}>
									{file.downloads.toLocaleString()}
									{file.lastDownload && (
										<span className="block text-xs text-kumo-subtle">
											<span className="sr-only">Last download </span>
											{formatDate(file.lastDownload)}
										</span>
									)}
								</div>
							)}
							<div role="cell" className="w-20 text-end">
								{file.usedIn.length ? (
									<DropdownMenu>
										<DropdownMenu.Trigger
											render={
												<Button type="button" variant="ghost" size="sm" aria-label={`${file.name} is used in ${file.usedIn.length} entries`}>
													{file.usedIn.length}
												</Button>
											}
										/>
										<DropdownMenu.Content className="max-h-80 overflow-y-auto p-1">
											{file.usedIn.map((u) => (
												<DropdownMenu.Item
													key={`${u.collection}:${u.id}`}
													className="py-1 data-highlighted:bg-kumo-fill"
													onClick={() => {
														window.location.href = `/_emdash/admin/content/${encodeURIComponent(u.collection)}/${encodeURIComponent(u.id)}`;
													}}
												>
													{u.title} <span className="ms-1 text-kumo-subtle">({u.collection})</span>
												</DropdownMenu.Item>
											))}
										</DropdownMenu.Content>
									</DropdownMenu>
								) : (
									<span className="text-kumo-subtle">Unused</span>
								)}
							</div>
							<div role="cell" className="flex w-10 justify-end">
								<DropdownMenu>
									<DropdownMenu.Trigger
										render={<Button type="button" variant="ghost" shape="square" icon={<DotsThree aria-hidden="true" />} aria-label={`Actions for ${file.name}`} />}
									/>
									<DropdownMenu.Content className="p-1">
										{file.url && (
											<>
												<DropdownMenu.Item
													className="py-1 data-highlighted:bg-kumo-fill"
													icon={<LinkSimple className="me-1.5 size-3.5" aria-hidden="true" />}
													onClick={() => void copy(file)}
												>
													Copy download link
												</DropdownMenu.Item>
												<DropdownMenu.Item
													className="py-1 data-highlighted:bg-kumo-fill"
													icon={<FileArrowDown className="me-1.5 size-3.5" aria-hidden="true" />}
													onClick={() => window.open(file.url!, "_blank", "noopener")}
												>
													Download
												</DropdownMenu.Item>
											</>
										)}
										{file.source === "upload" && (
											<>
												{file.url && <DropdownMenu.Separator className="my-0.5" />}
												<DropdownMenu.Item
													className="py-1 data-highlighted:bg-kumo-fill"
													icon={<Trash className="me-1.5 size-3.5" aria-hidden="true" />}
													onClick={() => setDeleting(file)}
												>
													{file.status === "uploading" ? "Discard" : "Delete"}
												</DropdownMenu.Item>
											</>
										)}
										{file.source === "media" && (
											<DropdownMenu.Item
												className="py-1 data-highlighted:bg-kumo-fill"
												onClick={() => {
													window.location.href = "/_emdash/admin/media";
												}}
											>
												Manage in Media Library
											</DropdownMenu.Item>
										)}
									</DropdownMenu.Content>
								</DropdownMenu>
							</div>
						</div>
					))}
					{visible.length === 0 && <p className="px-4 py-6 text-center text-sm text-kumo-subtle">No files match.</p>}
				</div>
			) : null}

			<DeleteDialog
				file={deleting}
				onClose={() => setDeleting(null)}
				onDeleted={(file) => {
					setDeleting(null);
					setNotice(`Deleted ${file.name}.`);
					void load();
				}}
			/>
		</div>
	);
}

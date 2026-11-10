/**
 * Form uploads page: files sent through Forms plugin forms, kept in a private
 * bucket. Lists them with the submission they came with, downloads them
 * (admins only, always saved as a file), deletes them, and sets which forms
 * keep files private. Turning the feature on or off happens on the Coywolf
 * Pack page.
 *
 * The routes live on the Forms plugin, which privateFormUploads() wraps
 * (see src/formUploads/wrap.ts).
 */
import { Badge, Banner, Button, Checkbox, Dialog, Input, Select } from "@cloudflare/kumo";
import { ArrowClockwise, DownloadSimple, Trash } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { apiPost, errorText } from "./api.js";
import { PageHeader, Loading } from "./page.js";
import { formatBytes, totalFromContentRange, type FormUploadsConfig, type UploadEntry } from "../formUploads/lib.js";
import { saveFile } from "./download.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SettingsSection, SetupCard, wholeNumber } from "./settings-ui.js";

const API = "/_emdash/api/plugins/emdash-forms/coywolf-private-uploads";

const post = apiPost(API);

interface FormInfo {
	id: string;
	slug: string;
	name: string;
	fileFields: number;
}

interface Status {
	wrapped: true;
	enabled: boolean;
	bucketBound: boolean;
	mediaBucketBound: boolean;
	config: FormUploadsConfig;
	forms: FormInfo[];
	mediaLibraryFiles: number;
}

interface Item extends UploadEntry {
	submission: { id: string; createdAt: string; status: string; preview: string } | null;
}

const SCOPE_ITEMS = [
	{ value: "all", label: "All forms" },
	{ value: "selected", label: "Only the forms checked below" },
];

async function errorFrom(response: Response, fallback: string): Promise<Error> {
	try {
		const body = (await response.json()) as { error?: { message?: string } };
		return new Error(body.error?.message || fallback);
	} catch {
		return new Error(fallback);
	}
}

/** Fetch a file in 4 MB parts (plugin responses are capped at 8 MB) and save it. */
async function download(item: UploadEntry): Promise<void> {
	const parts: ArrayBuffer[] = [];
	let total: number | null = null;
	let received = 0;
	let type = "application/octet-stream";
	for (let part = 0; part < 100; part++) {
		const response = await apiFetch(`${API}/download?id=${encodeURIComponent(item.id)}&part=${part}`);
		if (!response.ok) throw await errorFrom(response, "Couldn't download the file");
		type = response.headers.get("Content-Type") ?? type;
		total ??= totalFromContentRange(response.headers.get("Content-Range"));
		const bytes = await response.arrayBuffer();
		parts.push(bytes);
		received += bytes.byteLength;
		if (total === null || received >= total || bytes.byteLength === 0) break;
	}
	// Saved, never opened: the blob is a download, whatever the file claims to be.
	saveFile(new Blob(parts, { type }), item.filename);
}

const dateTime = (iso: string) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function DeleteDialog(props: { item: Item | null; onClose: () => void; onDeleted: (item: Item) => void }) {
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => setError(undefined), [props.item]);
	const item = props.item;
	const run = async () => {
		if (!item) return;
		setPending(true);
		setError(undefined);
		try {
			await post("delete", { id: item.id }, "Delete failed");
			props.onDeleted(item);
		} catch (cause) {
			setError(errorText(cause, "Delete failed"));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog.Root open={item !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Delete {item?.filename}?</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					The file is removed from the private bucket and can't be recovered. The submission stays, and still shows the file name.
				</Dialog.Description>
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

function UploadsTable(props: { items: Item[]; onDelete: (item: Item) => void }) {
	const [busy, setBusy] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	if (props.items.length === 0) return <p className="text-sm text-kumo-subtle">No private uploads yet.</p>;
	return (
		<div className="space-y-3">
			{error && <Banner variant="error" role="alert" description={error} />}
			<div className="overflow-x-auto">
				<table className="w-full text-start text-sm">
					<thead className="text-kumo-subtle">
						<tr className="border-b border-kumo-line">
							<th className="py-2 cw-pe-4 font-medium">File</th>
							<th className="py-2 cw-pe-4 font-medium">Form</th>
							<th className="py-2 cw-pe-4 font-medium">Submission</th>
							<th className="py-2 font-medium">
								<span className="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{props.items.map((item) => (
							<tr key={item.id} className="border-b border-kumo-line align-top">
								<td className="py-3 cw-pe-4" style={{ minWidth: 200, maxWidth: 320 }}>
									<div className="font-medium" style={{ overflowWrap: "anywhere" }}>
										{item.filename}
									</div>
									<div className="text-kumo-subtle">
										{formatBytes(item.size)} · {item.contentType || "unknown type"}
									</div>
									<div className="text-kumo-subtle">Uploaded {dateTime(item.uploadedAt)}</div>
									{item.source === "media-library" && <Badge variant="secondary">Moved from the media library</Badge>}
								</td>
								<td className="py-3 cw-pe-4" style={{ minWidth: 140 }}>
									<div>{item.formName || item.formSlug || "Unknown form"}</div>
									{item.fieldLabel && <div className="text-kumo-subtle">{item.fieldLabel}</div>}
								</td>
								<td className="py-3 cw-pe-4" style={{ minWidth: 200, maxWidth: 360 }}>
									{item.submission ? (
										<>
											<div>
												{dateTime(item.submission.createdAt)} {item.submission.status === "new" && <Badge>New</Badge>}
											</div>
											{item.submission.preview && (
												<div className="text-kumo-subtle" style={{ overflowWrap: "anywhere" }}>
													{item.submission.preview}
												</div>
											)}
										</>
									) : (
										<span className="text-kumo-subtle">{item.submissionId ? "Submission deleted" : "Not linked to a submission yet"}</span>
									)}
								</td>
								<td className="py-3">
									<div className="flex justify-end gap-2">
										<Button
											variant="secondary"
											size="sm"
											icon={<DownloadSimple />}
											disabled={busy === item.id}
											aria-label={`Download ${item.filename}`}
											onClick={() => {
												setBusy(item.id);
												setError(null);
												download(item)
													.catch((cause) => setError(errorText(cause, "Couldn't download the file")))
													.finally(() => setBusy(null));
											}}
										>
											{busy === item.id ? "Downloading…" : "Download"}
										</Button>
										<Button variant="ghost" size="sm" icon={<Trash />} aria-label={`Delete ${item.filename}`} onClick={() => props.onDelete(item)}>
											Delete
										</Button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function MoveEarlierUploads(props: { count: number; onDone: () => void }) {
	const [running, setRunning] = React.useState(false);
	const [progress, setProgress] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const run = async () => {
		setRunning(true);
		setError(null);
		let moved = 0;
		const failed: string[] = [];
		try {
			for (let round = 0; round < 200; round++) {
				const result = await post<{ moved: number; failed: Array<{ filename: string; reason: string }>; remaining: number }>(
					"migrate",
					{ limit: 20 },
					"Couldn't move the files",
				);
				moved += result.moved;
				failed.push(...result.failed.map((f) => `${f.filename}: ${f.reason}`));
				setProgress(`Moved ${moved} so far…`);
				if (result.moved === 0 || result.remaining === 0) break;
			}
			setProgress(`Moved ${moved} ${moved === 1 ? "file" : "files"}.`);
			if (failed.length) setError(`Couldn't move ${failed.length}: ${failed.slice(0, 5).join("; ")}${failed.length > 5 ? "…" : ""}`);
			props.onDone();
		} catch (cause) {
			setError(errorText(cause, "Couldn't move the files"));
		} finally {
			setRunning(false);
		}
	};
	return (
		<SettingsSection
			id="cw-form-uploads-move"
			title="Files from before"
			description={`${props.count} ${props.count === 1 ? "file" : "files"} sent before private uploads were on ${props.count === 1 ? "is" : "are"} still in the public media library. Move them to the private bucket: each submission is pointed at its private copy, and the media library copy is deleted.`}
			actions={
				<Button variant="secondary" disabled={running} onClick={() => void run()}>
					{running ? "Moving…" : "Move to private bucket"}
				</Button>
			}
		>
			{progress && (
				<p className="text-sm" role="status">
					{progress}
				</p>
			)}
			{error && <Banner variant="error" role="alert" description={error} />}
			<p className="text-sm text-kumo-subtle">
				Files are moved only for the forms selected above. A copy a browser or CDN already cached can linger until it expires.
			</p>
		</SettingsSection>
	);
}

export function FormUploadsPage() {
	const [status, setStatus] = React.useState<Status | null>(null);
	const [missing, setMissing] = React.useState(false);
	const [items, setItems] = React.useState<Item[] | null>(null);
	const [draft, setDraft] = React.useState<FormUploadsConfig | null>(null);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [message, setMessage] = React.useState("");
	const [deleting, setDeleting] = React.useState<Item | null>(null);

	const load = React.useCallback(async () => {
		setError(null);
		try {
			const response = await apiFetch(`${API}/status`);
			if (response.status === 404) {
				setMissing(true);
				return;
			}
			const next = await parseApiResponse<Status>(response, "Couldn't load the settings");
			setStatus(next);
			setDraft((cur) => cur ?? next.config);
			const list = await apiFetch(`${API}/list`).then((r) => parseApiResponse<{ items: Item[] }>(r, "Couldn't load the uploads"));
			setItems(list.items);
		} catch (cause) {
			setError(errorText(cause, "Couldn't load private uploads"));
		}
	}, []);

	React.useEffect(() => {
		void load();
	}, [load]);

	const dirty = isDirty(draft, status?.config);
	const set = (patch: Partial<FormUploadsConfig>) => setDraft((cur) => (cur ? { ...cur, ...patch } : cur));

	async function save(event?: React.FormEvent) {
		event?.preventDefault();
		if (!draft) return;
		setSaving(true);
		setError(null);
		try {
			const config = await post<FormUploadsConfig>("settings", draft, "Couldn't save");
			setDraft(config);
			setStatus((cur) => (cur ? { ...cur, config } : cur));
			setMessage("Saved.");
		} catch (cause) {
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	}

	const header = (
		<PageHeader
			title="Private Form Uploads"
			actions={
				<>
					<Button variant="secondary" icon={<ArrowClockwise />} onClick={() => void load()} aria-label="Refresh the list">
						Refresh
					</Button>
				</>
			}
			description={
				<>
					Files people send with your forms are kept in a private storage bucket, not the public media library. Only admins can download them,
					here. Deleting a submission in Forms deletes its files too.
				</>
			}
		/>
	);

	if (missing) {
		return (
			<div className="space-y-6">
				{header}
				<SetupCard
					title="Set up private form uploads"
					description={
						<>
							Wrap the Forms plugin in astro.config.mjs with <code>privateFormUploads(formsPlugin())</code> (imported from @coywolf/emdash), add an R2
							bucket binding named FORM_UPLOADS in wrangler.jsonc (a bucket with no public access), and deploy. See docs/form-uploads.md in the Coywolf Pack repository.
						</>
					}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{header}
			{error && <Banner variant="error" role="alert" description={error} />}
			<p className="sr-only" role="status" aria-live="polite">
				{message}
			</p>

			{!status && !error && (
				<Loading />
			)}

			{status && !status.bucketBound && (
				<SetupCard
					title="Add the private bucket"
					description="Create an R2 bucket with no public access, bind it as FORM_UPLOADS in wrangler.jsonc, and deploy. Until then, forms with files show an error instead of storing files publicly."
				/>
			)}
			{status && !status.enabled && (
				<Banner
					variant="alert"
					title="Private form uploads is off"
					description="New files go to the public media library. Turn on Private form uploads on the Coywolf Pack page. Files already here stay private."
				/>
			)}

			{status && draft && (
				<form id="cw-form-uploads-form" className="space-y-6" onSubmit={(e) => void save(e)}>
					<SettingsSection id="cw-form-uploads-settings" title="Which forms" description="Files from these forms go to the private bucket.">
						<Select
							label="Keep files private for"
							value={draft.scope}
							onValueChange={(value: string | null) => set({ scope: value === "selected" ? "selected" : "all" })}
							items={SCOPE_ITEMS}
						/>
						{draft.scope === "selected" && (
							<div className="space-y-2">
								{status.forms.length === 0 && <p className="text-sm text-kumo-subtle">No forms yet.</p>}
								{status.forms.map((form) => (
									<Checkbox
										key={form.id}
										label={`${form.name} (${form.slug})${form.fileFields ? "" : " · no file fields"}`}
										checked={draft.forms.includes(form.id) || draft.forms.includes(form.slug)}
										onCheckedChange={(checked: boolean) =>
											set({ forms: checked ? [...draft.forms.filter((f) => f !== form.slug), form.id] : draft.forms.filter((f) => f !== form.id && f !== form.slug) })
										}
									/>
								))}
							</div>
						)}
						<div style={{ maxWidth: 240 }}>
							<Input
								label="Delete files after (days)"
								description="0 keeps each file until its submission is deleted. The submission itself stays either way."
								type="number"
								min={0}
								max={3650}
								value={String(draft.retentionDays)}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ retentionDays: Math.max(0, Math.min(3650, wholeNumber(e.target.value, 0))) })}
							/>
						</div>
					</SettingsSection>
				</form>
			)}

			{status && status.mediaLibraryFiles > 0 && status.enabled && status.bucketBound && (
				<MoveEarlierUploads count={status.mediaLibraryFiles} onDone={() => void load()} />
			)}

			{status && (
				<SettingsSection id="cw-form-uploads-list" title="Private uploads" description="Newest first. Downloads are saved as files and never open in the browser.">
					{items === null ? <Loading className="" /> : <UploadsTable items={items} onDelete={setDeleting} />}
				</SettingsSection>
			)}

			<DeleteDialog
				item={deleting}
				onClose={() => setDeleting(null)}
				onDeleted={(item) => {
					setDeleting(null);
					setItems((cur) => (cur ? cur.filter((i) => i.id !== item.id) : cur));
					setMessage(`Deleted ${item.filename}.`);
				}}
			/>

			{status && draft && <SaveBar form="cw-form-uploads-form" dirty={dirty} saving={saving} onDiscard={() => setDraft(status.config)} />}
		</div>
	);
}

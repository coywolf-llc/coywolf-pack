/**
 * Backups admin page and dashboard widget. Layout and components follow the
 * EmDash admin's own list pages (Redirects, Bylines): Kumo controls, a bordered
 * row list, and confirmation dialogs.
 */
import { Badge, Banner, Button, Dialog, DropdownMenu, Input, Loader, Switch } from "@cloudflare/kumo";
import {
	ArrowCounterClockwise,
	ClockCounterClockwise,
	Database,
	DotsThree,
	DownloadSimple,
	ImagesSquare,
	Plus,
} from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { SaveBar } from "./save-bar.js";
import { SettingsSection } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/backups";

interface Backup {
	stamp: string;
	createdAt: string;
	file: string;
	bytes: number;
	source?: string;
	tables?: number;
	rows?: number;
	media?: { copied: number; preserved: number; total: number; pending?: number };
	uploads?: { copied: number; preserved: number; total: number; pending?: number };
}

interface UndoPoint {
	bookmark: string;
	rewoundAt: string;
	rewoundTo: string;
}

interface ListResponse {
	items: Backup[];
	scheduled: boolean;
	retentionDays: number;
	staleAfterHours: number;
	restore: { enabled: true } | { enabled: false; reason: string };
	undo: UndoPoint | null;
}

interface NewDatabaseResult {
	databaseId: string;
	databaseName: string;
	tables: number;
	rows: number;
	mismatches: Record<string, [number, number | null]>;
}

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const formatDate = (iso: string) => dateFormat.format(new Date(iso));

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(iso: string): string {
	const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
	if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
	if (hours < 48) return `${Math.round(hours)} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

function sourceLabel(source?: string): string {
	if (source === "admin") return "Manual";
	if (source === "scheduled") return "Scheduled";
	return "Nightly job";
}

async function post<T>(path: string, body?: unknown): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
	return parseApiResponse<T>(response, "The request failed");
}

function useBackups() {
	const [data, setData] = React.useState<ListResponse>();
	const [error, setError] = React.useState<string>();
	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			setData(await parseApiResponse<ListResponse>(await apiFetch(`${API}/list`), "Could not load backups"));
		} catch (cause) {
			setError(errorText(cause, "Could not load backups"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);
	return { data, error, load };
}

function isStale(data: ListResponse): boolean {
	const latest = data.items[0];
	return !latest || (Date.now() - new Date(latest.createdAt).getTime()) / 3_600_000 > data.staleAfterHours;
}

/**
 * Download a backup's database dump. The server makes a short-lived link that
 * streams the file from R2 (so any size works), served by the Coywolf Pack
 * site middleware; the browser saves it like any other download.
 */
async function download(backup: Backup) {
	const link = await post<{ url: string; filename: string }>("download-link", { stamp: backup.stamp, file: backup.file });
	const check = await fetch(link.url, { method: "HEAD", credentials: "same-origin" }).catch(() => null);
	if (!check?.ok) {
		throw new Error(
			"The download link didn't answer. Make sure coywolfPack() from @coywolf/emdash/middleware is in the site's src/middleware.ts (see Getting started in the Coywolf Pack README).",
		);
	}
	const a = document.createElement("a");
	a.href = link.url;
	a.download = link.filename;
	a.style.display = "none";
	document.body.appendChild(a);
	a.click();
	a.remove();
}

/** Destructive confirmation that requires typing a word, styled like the admin's ConfirmDialog. */
function TypedConfirmDialog(props: {
	open: boolean;
	title: string;
	word: string;
	confirmLabel: string;
	pendingLabel: string;
	pending: boolean;
	error?: string;
	onClose: () => void;
	onConfirm: () => void;
	children: React.ReactNode;
}) {
	const [typed, setTyped] = React.useState("");
	React.useEffect(() => {
		if (props.open) setTyped("");
	}, [props.open]);
	return (
		<Dialog.Root
			role="alertdialog"
			open={props.open}
			onOpenChange={(next) => !next && !props.pending && props.onClose()}
		>
			<Dialog className="p-6" size="sm">
				<Dialog.Title className="text-lg font-semibold">{props.title}</Dialog.Title>
				<Dialog.Description className="mt-2 space-y-2 text-sm text-kumo-subtle">{props.children}</Dialog.Description>
				<div className="mt-4">
					<Input
						label={`Type ${props.word} to confirm`}
						value={typed}
						autoComplete="off"
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value)}
					/>
				</div>
				{props.error && (
					<Banner variant="error" role="alert" className="mt-3" description={props.error} />
				)}
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="secondary" disabled={props.pending} onClick={props.onClose}>
						Cancel
					</Button>
					<Button variant="destructive" disabled={props.pending || typed !== props.word} onClick={props.onConfirm}>
						{props.pending ? props.pendingLabel : props.confirmLabel}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

/** Schedule and retention (stored as plugin settings; not on the generic Settings page). */
function ScheduleSettings(props: { data: ListResponse; onSaved: () => Promise<void> }) {
	const initial = React.useCallback(
		() => ({ scheduled: props.data.scheduled, retentionDays: String(props.data.retentionDays), staleAfterHours: String(props.data.staleAfterHours) }),
		[props.data.scheduled, props.data.retentionDays, props.data.staleAfterHours],
	);
	const [draft, setDraft] = React.useState(initial);
	React.useEffect(() => setDraft(initial()), [initial]);
	const [pending, setPending] = React.useState(false);
	const [status, setStatus] = React.useState<{ error: boolean; text: string }>();
	const dirty =
		draft.scheduled !== props.data.scheduled ||
		draft.retentionDays !== String(props.data.retentionDays) ||
		draft.staleAfterHours !== String(props.data.staleAfterHours);

	const save = async () => {
		setPending(true);
		setStatus(undefined);
		try {
			await post("settings/save", {
				scheduled: draft.scheduled,
				retentionDays: Number(draft.retentionDays),
				staleAfterHours: Number(draft.staleAfterHours),
			});
			await props.onSaved();
			setStatus({ error: false, text: "Backup settings saved." });
		} catch (cause) {
			setStatus({ error: true, text: errorText(cause, "Could not save the backup settings") });
		} finally {
			setPending(false);
		}
	};

	return (
		<>
			<form
				id="cw-backups-settings-form"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<SettingsSection
					id="backups-schedule"
					title="Schedule and retention"
					description="How often the site backs itself up, how long backups are kept, and when to warn that backups have stopped."
				>
					<Switch className="shrink-0"
						label="Back up once a day from the site itself"
						checked={draft.scheduled}
						onCheckedChange={(checked: boolean) => setDraft((d) => ({ ...d, scheduled: checked }))}
					/>
					<p className="-mt-2 text-sm text-kumo-subtle">Leave this off if an external job (such as a GitHub Action) already backs up the site.</p>
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							type="number"
							min={1}
							max={365}
							label="Keep backups for (days)"
							description="Older database backups and replaced media and upload copies are deleted daily. The mirrors themselves are kept."
							value={draft.retentionDays}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, retentionDays: e.target.value }))}
						/>
						<Input
							type="number"
							min={1}
							max={720}
							label="Warn when the newest backup is older than (hours)"
							description="Shown on this page and the dashboard widget."
							value={draft.staleAfterHours}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, staleAfterHours: e.target.value }))}
						/>
					</div>
					<div aria-live="polite">
						{status && (status.error ? <Banner variant="error" role="alert" description={status.text} /> : <p className="text-sm text-kumo-subtle">{status.text}</p>)}
					</div>
				</SettingsSection>
			</form>
			<SaveBar form="cw-backups-settings-form" dirty={dirty} saving={pending} onDiscard={() => setDraft(initial())} />
		</>
	);
}

type Action =
	| { kind: "rewind"; backup: Backup }
	| { kind: "restore-new"; backup: Backup }
	| { kind: "undo"; undo: UndoPoint };

export function BackupsPage() {
	const { data, error, load } = useBackups();
	const [running, setRunning] = React.useState(false);
	const [notice, setNotice] = React.useState<{ variant: "default" | "error"; title: string; description?: React.ReactNode }>();
	const [action, setAction] = React.useState<Action>();
	const [pending, setPending] = React.useState(false);
	const [actionError, setActionError] = React.useState<string>();
	const [mediaPending, setMediaPending] = React.useState(false);

	const runBackup = async () => {
		setRunning(true);
		setNotice(undefined);
		try {
			const result = await post<Backup>("run");
			setNotice({ variant: "default", title: `Backup saved (${formatBytes(result.bytes)}).` });
			await load();
		} catch (cause) {
			setNotice({ variant: "error", title: "Backup failed", description: errorText(cause, "") });
		} finally {
			setRunning(false);
		}
	};

	const restoreMedia = async () => {
		setMediaPending(true);
		setNotice(undefined);
		try {
			// The server copies a batch per request; keep asking until nothing is left.
			let restored = 0;
			for (;;) {
				const result = await post<{ restored: number; checked: number; pending?: number }>("restore-media");
				restored += result.restored;
				if (!result.pending || !result.restored) break;
				setNotice({ variant: "default", title: `Restoring files: ${restored} copied so far…` });
			}
			setNotice({
				variant: "default",
				title: restored ? `Restored ${restored} missing ${restored === 1 ? "file" : "files"}.` : "No files were missing.",
			});
		} catch (cause) {
			setNotice({ variant: "error", title: "Media restore failed", description: errorText(cause, "") });
		} finally {
			setMediaPending(false);
		}
	};

	const confirmAction = async () => {
		if (!action) return;
		setPending(true);
		setActionError(undefined);
		try {
			if (action.kind === "rewind") {
				await post("rewind", { stamp: action.backup.stamp, confirm: "REWIND" });
				setNotice({
					variant: "default",
					title: `The database was rewound to ${formatDate(action.backup.createdAt)}.`,
					description: "Reload any open admin tabs. Use Undo rewind below if this was a mistake.",
				});
			} else if (action.kind === "undo") {
				await post("undo", { confirm: "UNDO" });
				setNotice({ variant: "default", title: "The rewind was undone." });
			} else {
				const result = await post<NewDatabaseResult>("restore-new", { stamp: action.backup.stamp, confirm: "RESTORE" });
				const mismatched = Object.keys(result.mismatches);
				setNotice({
					variant: mismatched.length ? "error" : "default",
					title: mismatched.length
						? `Restored to ${result.databaseName}, but ${mismatched.length} tables don't match the backup.`
						: `Restored and verified ${result.rows.toLocaleString()} rows in ${result.tables} tables.`,
					description: (
						<div className="space-y-2">
							<p>
								The site still runs on its current database. To switch, set the <code>DB</code> binding in{" "}
								<code>wrangler.jsonc</code> and deploy:
							</p>
							<pre className="overflow-x-auto rounded-md bg-kumo-tint p-3 text-xs">
								{`"database_name": "${result.databaseName}",\n"database_id": "${result.databaseId}"`}
							</pre>
							<p>Keep the old database until you've checked the site.</p>
						</div>
					),
				});
			}
			setAction(undefined);
			await load();
		} catch (cause) {
			setActionError(errorText(cause, "The restore failed"));
		} finally {
			setPending(false);
		}
	};

	const latest = data?.items[0];
	const restoreEnabled = data?.restore.enabled ?? false;

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Backups</h1>
					<div className="flex shrink-0 justify-end gap-2">
						<Button variant="primary" icon={<Plus />} onClick={() => void runBackup()} disabled={running}>
							{running ? "Backing up…" : "Back up now"}
						</Button>
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Each backup is a full copy of the database (content, users, settings, menus, redirects) plus a mirror of the
						media library and of private form uploads{data ? `, kept for ${data.retentionDays} days` : ""}. Theme code lives in your Git repository. Download
						any backup to keep your own copy: it's a standard SQL file that restores into any D1 database.
					</p>
				</div>
			</header>

			{notice && (
				<Banner
					variant={notice.variant === "error" ? "error" : "default"}
					role={notice.variant === "error" ? "alert" : "status"}
					title={notice.title}
					description={notice.description}
				/>
			)}
			{error && <Banner variant="error" role="alert" title="Could not load backups" description={error} />}
			{data && isStale(data) && (
				<Banner
					variant="alert"
					role="alert"
					title={latest ? `The newest backup is from ${ago(latest.createdAt)}.` : "There are no backups yet."}
					description={
						data.scheduled
							? "Scheduled backups may not be running. Check the site's logs."
							: "Turn on daily scheduled backups under Schedule and retention below, or check your external backup job."
					}
				/>
			)}
			{data?.undo && (
				<Banner
					variant="default"
					title={`The database was rewound to ${formatDate(new Date(`${data.undo.rewoundTo.slice(0, 13)}:${data.undo.rewoundTo.slice(13, 15)}:00Z`).toISOString())} on ${formatDate(data.undo.rewoundAt)}.`}
					description={
						<Button
							variant="secondary"
							size="sm"
							className="mt-2"
							icon={<ArrowCounterClockwise />}
							disabled={!restoreEnabled}
							onClick={() => setAction({ kind: "undo", undo: data.undo! })}
						>
							Undo rewind
						</Button>
					}
				/>
			)}
			{data && !data.restore.enabled && (
				<Banner variant="default" title="Restore isn't set up yet." description={`${data.restore.reason} See docs/backups.md in the Coywolf Pack repository.`} />
			)}

			{!data && !error ? (
				<div className="py-12 text-center text-kumo-subtle">
					<Loader />
				</div>
			) : data && data.items.length === 0 ? (
				<div className="py-10 text-center text-kumo-subtle">
					<Database size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
					<p className="text-base font-medium">No backups yet</p>
					<p className="mt-1 text-sm">Back up now, or turn on daily backups under Schedule and retention below.</p>
				</div>
			) : data ? (
				<div className="rounded-lg border">
					<div className="flex items-center gap-4 border-b bg-kumo-tint/50 px-4 py-2 text-sm font-medium text-kumo-subtle">
						<div className="flex-1">Backup</div>
						<div className="hidden w-32 sm:block">Type</div>
						<div className="w-20 text-end">Size</div>
						<div className="hidden flex-1 md:block">Contents</div>
						<div className="w-10" />
					</div>
					{data.items.map((backup) => (
						<div key={backup.stamp} className="flex items-center gap-4 border-b px-4 py-2 text-sm last:border-0">
							<div className="min-w-0 flex-1">
								<div className="truncate">{formatDate(backup.createdAt)}</div>
								<div className="text-xs text-kumo-subtle">{ago(backup.createdAt)}</div>
							</div>
							<div className="hidden w-32 sm:block">
								<Badge variant={backup.source === "admin" ? "secondary" : "outline"}>{sourceLabel(backup.source)}</Badge>
							</div>
							<div className="w-20 text-end tabular-nums">{formatBytes(backup.bytes)}</div>
							<div className="hidden min-w-0 flex-1 truncate text-kumo-subtle md:block">
								{backup.rows !== undefined ? `${backup.rows.toLocaleString()} rows, ${backup.tables} tables` : "Full database"}
								{backup.media ? ` · ${backup.media.total} media files${backup.media.pending ? ` (${backup.media.pending} still copying)` : ""}` : ""}
								{backup.uploads ? ` · ${backup.uploads.total} form uploads${backup.uploads.pending ? ` (${backup.uploads.pending} still copying)` : ""}` : ""}
							</div>
							<div className="flex w-10 justify-end">
								<DropdownMenu>
									<DropdownMenu.Trigger
										render={
											<Button
												type="button"
												variant="ghost"
												shape="square"
												icon={<DotsThree aria-hidden="true" />}
												aria-label={`Actions for the ${formatDate(backup.createdAt)} backup`}
											/>
										}
									/>
									<DropdownMenu.Content className="p-1">
										<DropdownMenu.Item
											className="py-1 data-highlighted:bg-kumo-fill"
											icon={<DownloadSimple className="me-1.5 size-3.5" aria-hidden="true" />}
											onClick={() =>
												void download(backup).catch((cause) =>
													setNotice({ variant: "error", title: "Download failed", description: errorText(cause, "") }),
												)
											}
										>
											Download (.sql.gz)
										</DropdownMenu.Item>
										<DropdownMenu.Separator className="my-0.5" />
										<DropdownMenu.Item
											className="py-1 data-highlighted:bg-kumo-fill"
											disabled={!restoreEnabled}
											icon={<ClockCounterClockwise className="me-1.5 size-3.5" aria-hidden="true" />}
											onClick={() => {
												setActionError(undefined);
												setAction({ kind: "rewind", backup });
											}}
										>
											Rewind to this backup…
										</DropdownMenu.Item>
										<DropdownMenu.Item
											className="py-1 data-highlighted:bg-kumo-fill"
											disabled={!restoreEnabled}
											icon={<Database className="me-1.5 size-3.5" aria-hidden="true" />}
											onClick={() => {
												setActionError(undefined);
												setAction({ kind: "restore-new", backup });
											}}
										>
											Restore to a new database…
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu>
							</div>
						</div>
					))}
				</div>
			) : null}

			{data && data.items.length > 0 && (
				<section className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
					<div>
						<h2 className="text-base font-semibold">Media library</h2>
						<p className="text-sm text-kumo-subtle">
							Copy back any media files and private form uploads that are missing. Existing files are never overwritten.
						</p>
					</div>
					<Button variant="secondary" icon={<ImagesSquare />} disabled={mediaPending} onClick={() => void restoreMedia()}>
						{mediaPending ? "Restoring…" : "Restore missing media"}
					</Button>
				</section>
			)}

			{data && <ScheduleSettings data={data} onSaved={load} />}

			<TypedConfirmDialog
				open={action?.kind === "rewind"}
				title="Rewind the database?"
				word="REWIND"
				confirmLabel="Rewind database"
				pendingLabel="Rewinding…"
				pending={pending}
				error={actionError}
				onClose={() => setAction(undefined)}
				onConfirm={() => void confirmAction()}
			>
				{action?.kind === "rewind" && (
					<>
						<p>
							Everything in the database returns to {formatDate(action.backup.createdAt)}: content, users, settings,
							menus, and redirects. Changes made since then are undone.
						</p>
						<p>
							An undo point is saved first, so you can reverse this. Media files aren't changed. Anyone who signed in
							after that time may need to sign in again.
						</p>
					</>
				)}
			</TypedConfirmDialog>

			<TypedConfirmDialog
				open={action?.kind === "restore-new"}
				title="Restore to a new database?"
				word="RESTORE"
				confirmLabel="Create and restore"
				pendingLabel="Restoring…"
				pending={pending}
				error={actionError}
				onClose={() => setAction(undefined)}
				onConfirm={() => void confirmAction()}
			>
				{action?.kind === "restore-new" && (
					<>
						<p>
							This creates a new D1 database from the {formatDate(action.backup.createdAt)} backup and checks it row by
							row. The live site isn't touched.
						</p>
						<p>Use this when the database is gone or the backup is older than Time Travel's 30-day window.</p>
					</>
				)}
			</TypedConfirmDialog>

			<TypedConfirmDialog
				open={action?.kind === "undo"}
				title="Undo the rewind?"
				word="UNDO"
				confirmLabel="Undo rewind"
				pendingLabel="Undoing…"
				pending={pending}
				error={actionError}
				onClose={() => setAction(undefined)}
				onConfirm={() => void confirmAction()}
			>
				<p>The database returns to the moment just before the rewind. Changes made since the rewind are undone.</p>
			</TypedConfirmDialog>
		</div>
	);
}

export function BackupStatusWidget() {
	const { data, error } = useBackups();
	if (error) return <p className="text-sm text-kumo-danger">{error}</p>;
	if (!data) return <Loader />;
	const latest = data.items[0];
	if (!latest) return <p className="text-sm text-kumo-danger">No backups yet.</p>;
	return (
		<div className="space-y-1 text-sm">
			<p className={isStale(data) ? "font-medium text-kumo-danger" : "font-medium"}>Last backup {ago(latest.createdAt)}</p>
			<p className="text-kumo-subtle">
				{sourceLabel(latest.source)} · {data.items.length} kept
			</p>
		</div>
	);
}


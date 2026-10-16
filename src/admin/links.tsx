/**
 * Link Manager admin page and dashboard widget.
 */
import { Badge, Banner, Button, Checkbox, Dialog, DropdownMenu, Input, Loader, Select, Switch } from "@cloudflare/kumo";
import {
	ArrowClockwise,
	ArrowSquareOut,
	CaretDown,
	CaretRight,
	DotsThree,
	DownloadSimple,
	EyeSlash,
	GearSix,
	LinkBreak,
	LinkSimple,
	MagnifyingGlass,
	PencilSimple,
	Prohibit,
} from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { linksToCsv } from "../links/export.js";
import { saveFile, siteSlug, today } from "./download.js";

const API = "/_emdash/api/plugins/coywolf-pack/links";
const ADMIN = "/_emdash/admin";

type LinkStatus = "unchecked" | "ok" | "redirect" | "broken" | "blocked" | "error";
type StatusFilter = "all" | "ignored" | LinkStatus;
type BadgeVariant = "secondary" | "error" | "warning" | "success" | "info" | "outline";

interface Usage {
	collection: string;
	entryId: string;
	title: string;
	status: string;
	kinds: string[];
	anchors: string[];
	count: number;
}

interface LinkRow {
	id: string;
	url: string;
	resolved: string | null;
	host: string;
	internal: boolean;
	ignored: boolean;
	status: LinkStatus;
	code: number | null;
	finalUrl: string | null;
	chain: Array<{ url: string; code: number }>;
	note: string;
	checkedAt: string | null;
	refs: number;
	usedIn: Usage[];
}

interface IgnoreRule {
	id: string;
	type: "domain" | "url" | "wildcard" | "regex";
	value: string;
}

interface ScanState {
	status: "idle" | "running";
	startedAt: string | null;
	finishedAt: string | null;
	processed: number;
	error?: string;
}

interface ListResponse {
	items: LinkRow[];
	total: number;
	pageSize: number;
	nextCursor: string | null;
	counts: Record<string, number>;
	scan: ScanState;
	checking: boolean;
	siteUrlKnown: boolean;
	ignores: IgnoreRule[];
}

interface EditResult {
	entries: number;
	links: number;
	published: number;
	staged: number;
	scheduled: number;
	skipped: number;
	conflicts: number;
	failed: Array<{ entry: string; error: string }>;
	remaining: number;
	next: string | null;
}

const STATUS: Record<LinkStatus, { label: string; variant: BadgeVariant }> = {
	broken: { label: "Broken", variant: "error" },
	error: { label: "Error", variant: "error" },
	blocked: { label: "Blocked", variant: "warning" },
	redirect: { label: "Redirect", variant: "info" },
	unchecked: { label: "Not checked", variant: "outline" },
	ok: { label: "OK", variant: "success" },
};
const FILTERS: Array<{ id: StatusFilter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "broken", label: "Broken" },
	{ id: "error", label: "Error" },
	{ id: "blocked", label: "Blocked" },
	{ id: "redirect", label: "Redirect" },
	{ id: "unchecked", label: "Not checked" },
	{ id: "ok", label: "OK" },
	{ id: "ignored", label: "Ignored" },
];
type Frequency = "daily" | "weekly" | "monthly";
const FREQUENCY_OPTIONS = [
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "monthly", label: "Monthly" },
];

const RULE_TYPES = [
	{ value: "domain", label: "Domain (and its subdomains)" },
	{ value: "url", label: "Exact URL" },
	{ value: "wildcard", label: "Wildcard (* matches anything)" },
	{ value: "regex", label: "Regular expression" },
];

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, "The request failed");
}

/** Run a batched edit route until every affected entry is done. */
async function runEdit(path: "replace" | "unlink", body: Record<string, unknown>, onProgress: (done: number) => void): Promise<EditResult> {
	const total: EditResult = { entries: 0, links: 0, published: 0, staged: 0, scheduled: 0, skipped: 0, conflicts: 0, failed: [], remaining: 0, next: null };
	let after: string | null = null;
	for (let i = 0; i < 500; i++) {
		const step: EditResult = await post<EditResult>(path, { ...body, after });
		total.entries += step.entries;
		total.links += step.links;
		total.published += step.published;
		total.staged += step.staged;
		total.scheduled += step.scheduled;
		total.conflicts += step.conflicts;
		total.skipped += step.skipped;
		total.failed.push(...step.failed);
		onProgress(total.entries);
		if (!step.remaining || !step.next) break;
		after = step.next;
	}
	return total;
}

function editSummary(verb: string, r: EditResult): string {
	const parts = [`${verb} ${plural(r.links, "link")} in ${plural(r.entries, "entry", "entries")}.`];
	if (r.staged) parts.push(`${plural(r.staged, "entry", "entries")} had unpublished changes or a schedule, so the fix is saved in the draft; publish to make it live.`);
	if (r.scheduled) parts.push(`${plural(r.scheduled, "entry", "entries")} ${r.scheduled === 1 ? "is" : "are"} scheduled.`);
	if (r.conflicts) parts.push(`${plural(r.conflicts, "entry", "entries")} changed while this ran and ${r.conflicts === 1 ? "was" : "were"} left alone; run it again to retry.`);
	if (r.skipped) parts.push(`${plural(r.skipped, "embed")} can't be unlinked and ${r.skipped === 1 ? "was" : "were"} left as is.`);
	if (r.failed.length > r.conflicts) parts.push(`${plural(r.failed.length, "entry", "entries")} failed: ${r.failed[0].error}`);
	return parts.join(" ");
}

function useDebounced<T>(value: T, ms = 300): T {
	const [debounced, setDebounced] = React.useState(value);
	React.useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return debounced;
}

function StatusBadge({ row }: { row: LinkRow }) {
	const s = STATUS[row.status];
	return (
		<span title={row.note || undefined}>
			<Badge variant={s.variant}>
				{s.label}
				{row.code && row.status !== "ok" ? ` ${row.code}` : ""}
			</Badge>
		</span>
	);
}

function UsageList({ row }: { row: LinkRow }) {
	return (
		<ul className="mt-2 space-y-1 border-s-2 border-kumo-line ps-3 text-xs">
			{row.usedIn.map((u) => (
				<li key={`${u.collection}/${u.entryId}`} className="flex flex-wrap items-center gap-x-2">
					<a className="font-medium text-kumo-link hover:underline" href={`${ADMIN}/content/${encodeURIComponent(u.collection)}/${encodeURIComponent(u.entryId)}`}>
						{u.title}
					</a>
					<span className="text-kumo-subtle">
						{u.collection}
						{u.status && u.status !== "published" ? ` · ${u.status}` : ""}
						{u.count > 1 ? ` · ${u.count}×` : ""}
						{u.kinds.some((k) => k !== "text") ? ` · ${u.kinds.join(", ")}` : ""}
					</span>
					{u.anchors.length > 0 && <span className="truncate text-kumo-subtle">“{u.anchors.join("”, “")}”</span>}
				</li>
			))}
			{row.usedIn.length === 0 && <li className="text-kumo-subtle">Not used in any entry.</li>}
		</ul>
	);
}

function ReplaceDialog(props: { rows: LinkRow[] | null; onClose: () => void; onDone: (message: string) => void }) {
	const [to, setTo] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [progress, setProgress] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		const only = props.rows?.length === 1 ? props.rows[0] : undefined;
		setTo(only ? (only.finalUrl ?? only.url) : "");
		setError(undefined);
		setProgress(undefined);
	}, [props.rows]);
	const rows = props.rows ?? [];
	const entries = new Set(rows.flatMap((r) => r.usedIn.map((u) => `${u.collection}/${u.entryId}`))).size;

	const run = async () => {
		setPending(true);
		setError(undefined);
		try {
			const result = await runEdit("replace", { ids: rows.map((r) => r.id), to: to.trim() }, (n) => setProgress(`Updated ${plural(n, "entry", "entries")}…`));
			props.onDone(editSummary("Replaced", result));
		} catch (cause) {
			setError(errorText(cause, "Replace failed"));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog.Root open={props.rows !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{rows.length === 1 ? "Change link" : `Replace ${rows.length} links`}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Every entry that links to {rows.length === 1 ? <code className="break-all">{rows[0]?.url}</code> : "the selected URLs"} will link to the new URL
					instead ({plural(entries, "entry", "entries")} on this page's count). Published entries are republished. Link text and other formatting stay the
					same.
				</Dialog.Description>
				<form
					className="mt-4 space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						void run();
					}}
				>
					<Input
						label="New URL"
						placeholder="https://example.com/new-page or /new-path/"
						value={to}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
						required
					/>
					{rows.length === 1 && rows[0]?.finalUrl && (
						<p className="text-xs text-kumo-subtle">Prefilled with where the link redirects to now.</p>
					)}
					<p aria-live="polite" className="text-sm text-kumo-subtle">
						{progress}
					</p>
					{error && <Banner variant="error" role="alert" description={error} />}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" disabled={pending} onClick={props.onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={pending || !to.trim()}>
							{pending ? "Replacing…" : "Replace"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

function UnlinkDialog(props: { rows: LinkRow[] | null; onClose: () => void; onDone: (message: string) => void }) {
	const [pending, setPending] = React.useState(false);
	const [progress, setProgress] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		setError(undefined);
		setProgress(undefined);
	}, [props.rows]);
	const rows = props.rows ?? [];
	const run = async () => {
		setPending(true);
		setError(undefined);
		try {
			const result = await runEdit("unlink", { ids: rows.map((r) => r.id) }, (n) => setProgress(`Updated ${plural(n, "entry", "entries")}…`));
			props.onDone(editSummary("Removed", result));
		} catch (cause) {
			setError(errorText(cause, "Unlink failed"));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog.Root open={props.rows !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="base">
				<Dialog.Title className="text-lg font-semibold">{rows.length === 1 ? "Remove this link?" : `Remove ${rows.length} links?`}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					The link is removed and its text kept. Linked images and buttons lose their link. Embeds and iframes are left alone. Published entries are
					republished.
				</Dialog.Description>
				<p aria-live="polite" className="mt-3 text-sm text-kumo-subtle">
					{progress}
				</p>
				{error && <Banner variant="error" role="alert" className="mt-3" description={error} />}
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="secondary" disabled={pending} onClick={props.onClose}>
						Cancel
					</Button>
					<Button variant="destructive" disabled={pending} onClick={() => void run()}>
						{pending ? "Removing…" : "Remove links"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

interface LinksSettings {
	checkBudget: number;
	checkInternal: boolean;
	userAgent: string;
	frequency: Frequency;
}

/** Link checking settings (plugin settings edited here, not on the generic Settings page). */
function SettingsDialog(props: { open: boolean; onClose: () => void; onSaved: (message: string) => void }) {
	const [draft, setDraft] = React.useState<{ checkBudget: string; checkInternal: boolean; userAgent: string; frequency: Frequency }>();
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		if (!props.open) return;
		setDraft(undefined);
		setError(undefined);
		apiFetch(`${API}/settings`)
			.then((response) => parseApiResponse<LinksSettings>(response, "Could not load the settings"))
			.then((s) => setDraft({ checkBudget: String(s.checkBudget), checkInternal: s.checkInternal, userAgent: s.userAgent, frequency: s.frequency }))
			.catch((cause) => setError(errorText(cause, "Could not load the settings")));
	}, [props.open]);
	const save = async () => {
		if (!draft) return;
		setPending(true);
		setError(undefined);
		try {
			await post("settings/save", {
				checkBudget: Number(draft.checkBudget),
				checkInternal: draft.checkInternal,
				userAgent: draft.userAgent,
				frequency: draft.frequency,
			});
			props.onSaved("Link checking settings saved.");
		} catch (cause) {
			setError(errorText(cause, "Could not save the settings"));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog.Root open={props.open} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Link checking settings</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Nothing runs in the background until Scheduled link checking is on under Plugins → Coywolf Pack. Then a scheduled run scans your content
					and checks the links that are due (broken links daily, the rest weekly), continuing hourly until it's done.
				</Dialog.Description>
				{!draft && !error ? (
					<div className="py-8 text-center">
						<Loader />
					</div>
				) : draft ? (
					<form
						className="mt-4 space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							void save();
						}}
					>
						<Select
							label="How often"
							description="How often a scheduled run starts. Weekly by default."
							value={draft.frequency}
							onValueChange={(v: string | null) => setDraft({ ...draft, frequency: (v ?? "weekly") as Frequency })}
							items={FREQUENCY_OPTIONS}
						/>
						<Input
							type="number"
							min={10}
							max={900}
							label="Subrequests per check run"
							description="A link takes 1–2 HTTP requests (plus 1 per redirect) and 1 database write. Workers allow 50 subrequests per invocation on the Free plan and 1,000 on Paid, shared with other scheduled jobs. Default 40."
							value={draft.checkBudget}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, checkBudget: e.target.value })}
						/>
						<Switch
							label="Check links to this site"
							checked={draft.checkInternal}
							onCheckedChange={(checked: boolean) => setDraft({ ...draft, checkInternal: checked })}
						/>
						<p className="-mt-2 text-sm text-kumo-subtle">Internal links are always listed; this also requests them to see if they work.</p>
						<Input
							label="User-Agent override (optional)"
							description="Leave empty to present a current desktop Chrome, which avoids most false “Blocked” results."
							value={draft.userAgent}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, userAgent: e.target.value })}
						/>
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
				) : null}
				{error && !draft && <Banner variant="error" role="alert" className="mt-4" description={error} />}
			</Dialog>
		</Dialog.Root>
	);
}

function IgnoreRulesDialog(props: { open: boolean; rules: IgnoreRule[]; onClose: () => void; onChanged: (message: string) => void }) {
	const [type, setType] = React.useState<IgnoreRule["type"]>("domain");
	const [value, setValue] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const save = async (body: { add?: Array<Omit<IgnoreRule, "id">>; remove?: string[] }, message: string) => {
		setPending(true);
		setError(undefined);
		try {
			await post("ignore", body);
			setValue("");
			props.onChanged(message);
		} catch (cause) {
			setError(errorText(cause, "Could not save the rule"));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog.Root open={props.open} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Ignore rules</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Ignored links aren't checked or counted. They stay listed under Ignored.
				</Dialog.Description>
				<form
					className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"
					onSubmit={(e) => {
						e.preventDefault();
						void save({ add: [{ type, value }] }, "Ignore rule added.");
					}}
				>
					<div className="sm:w-64">
						<Select
							label="Type"
							value={type}
							onValueChange={(v: string | null) => setType((v ?? "domain") as IgnoreRule["type"])}
							items={RULE_TYPES}
						/>
					</div>
					<div className="flex-1">
						<Input
							label="Value"
							placeholder={type === "domain" ? "linkedin.com" : type === "regex" ? "^https://example\\.com/(tag|category)/" : "https://example.com/*"}
							value={value}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
						/>
					</div>
					<Button type="submit" variant="primary" disabled={pending || !value.trim()}>
						Add rule
					</Button>
				</form>
				{error && <Banner variant="error" role="alert" className="mt-3" description={error} />}
				<ul className="mt-4 max-h-80 divide-y divide-kumo-line cw-overflow-auto rounded-lg border">
					{props.rules.map((rule) => (
						<li key={rule.id} className="flex items-center gap-3 px-3 py-2 text-sm">
							<Badge variant="secondary">{rule.type}</Badge>
							<code className="min-w-0 flex-1 truncate text-xs" title={rule.value}>
								{rule.value}
							</code>
							<Button
								variant="ghost"
								size="sm"
								disabled={pending}
								aria-label={`Remove ignore rule ${rule.value}`}
								onClick={() => void save({ remove: [rule.id] }, "Ignore rule removed.")}
							>
								Remove
							</Button>
						</li>
					))}
					{props.rules.length === 0 && <li className="px-3 py-6 text-center text-sm text-kumo-subtle">No ignore rules yet.</li>}
				</ul>
				<div className="mt-6 flex justify-end">
					<Button variant="secondary" disabled={pending} onClick={props.onClose}>
						Done
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

export function LinksPage() {
	const [data, setData] = React.useState<ListResponse>();
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const [status, setStatus] = React.useState<StatusFilter>("all");
	const [scope, setScope] = React.useState<"all" | "internal" | "external">("all");
	const [host, setHost] = React.useState("");
	const [query, setQuery] = React.useState("");
	/** Cursors of the pages before the current one, and the current one. */
	const [cursors, setCursors] = React.useState<Array<string | null>>([null]);
	const cursor = cursors[cursors.length - 1];
	const [selected, setSelected] = React.useState<Set<string>>(new Set());
	const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
	const [replacing, setReplacing] = React.useState<LinkRow[] | null>(null);
	const [unlinking, setUnlinking] = React.useState<LinkRow[] | null>(null);
	const [rulesOpen, setRulesOpen] = React.useState(false);
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	const [busy, setBusy] = React.useState<string>();
	const scanning = React.useRef(false);

	const deferredQuery = useDebounced(query);
	const deferredHost = useDebounced(host);

	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			const result = await post<ListResponse>("list", { status, scope, host: deferredHost || undefined, q: deferredQuery || undefined, cursor });
			setData(result);
			setSelected((prev) => new Set([...prev].filter((id) => result.items.some((r) => r.id === id))));
		} catch (cause) {
			setError(errorText(cause, "Could not load links"));
		}
	}, [status, scope, deferredHost, deferredQuery, cursor]);
	React.useEffect(() => {
		void load();
	}, [load]);
	React.useEffect(() => setCursors([null]), [status, scope, deferredHost, deferredQuery]);

	/** Keep a running scan moving while the page is open (otherwise it continues the next time the page is open, or in a scheduled run). */
	const scan = React.useCallback(
		async (restart: boolean) => {
			if (scanning.current) return;
			scanning.current = true;
			setError(undefined);
			try {
				let state = await post<ScanState & { busy?: boolean }>("scan", { restart });
				while (state.status === "running" && !state.error) {
					setData((d) => (d ? { ...d, scan: state } : d));
					// Another step (the scheduled job) holds the scan: wait instead of spinning.
					if (state.busy) await new Promise((resolve) => setTimeout(resolve, 5000));
					state = await post<ScanState & { busy?: boolean }>("scan", {});
				}
				if (state.error) {
					setData((d) => (d ? { ...d, scan: state } : d));
					return;
				}
				setNotice(`Scan finished: ${plural(state.processed, "entry", "entries")} indexed.`);
				await load();
			} catch (cause) {
				setError(errorText(cause, "Scan failed"));
			} finally {
				scanning.current = false;
				setData((d) => (d ? { ...d } : d));
			}
		},
		[load],
	);
	React.useEffect(() => {
		if (data?.scan.status === "running" && !scanning.current) void scan(false);
	}, [data?.scan.status, scan]);

	const recheck = async (ids?: string[]) => {
		setBusy(ids ? "Checking selected links…" : "Checking links that are due…");
		setError(undefined);
		try {
			const run = await post<{ checked: number; exhausted: boolean }>("recheck", ids ? { ids } : {});
			setNotice(
				`Checked ${plural(run.checked, "link")}.${run.exhausted ? " The rest will be checked by the next scheduled run, or press Check now again." : ""}`,
			);
			await load();
		} catch (cause) {
			setError(errorText(cause, "Check failed"));
		} finally {
			setBusy(undefined);
		}
	};

	const ignore = async (rows: LinkRow[], by: "url" | "domain") => {
		const add = [...new Set(rows.map((r) => (by === "domain" ? r.host : (r.resolved ?? r.url))))].filter(Boolean).map((value) => ({ type: by, value }));
		try {
			const result = await post<{ changed: number }>("ignore", { add });
			setNotice(`Ignoring ${plural(result.changed, "link")}.`);
			await load();
		} catch (cause) {
			setError(errorText(cause, "Could not ignore"));
		}
	};

	/** Every link that matches the current filters (all pages), as CSV. */
	const exportCsv = async () => {
		setBusy("Exporting links…");
		setError(undefined);
		try {
			const rows: LinkRow[] = [];
			let next: string | null = null;
			for (let page = 0; page < 1000; page++) {
				const result: ListResponse = await post<ListResponse>("list", { status, scope, host: deferredHost || undefined, q: deferredQuery || undefined, cursor: next });
				rows.push(...result.items);
				next = result.nextCursor;
				if (!next) break;
			}
			const filtered = status !== "all" || scope !== "all" || deferredHost || deferredQuery;
			saveFile(linksToCsv(rows), `links-${status === "all" ? "" : `${status}-`}${siteSlug() || "site"}-${today()}.csv`, "text/csv");
			setNotice(`Exported ${plural(rows.length, "link")}${filtered ? " matching the current filters" : ""}.`);
		} catch (cause) {
			setError(errorText(cause, "Export failed"));
		} finally {
			setBusy(undefined);
		}
	};

	const items = data?.items ?? [];
	const selectedRows = items.filter((r) => selected.has(r.id));
	const allSelected = items.length > 0 && selectedRows.length === items.length;
	const pageNumber = cursors.length;
	const scanState = data?.scan;
	const neverScanned = scanState && !scanState.finishedAt && scanState.status !== "running";

	const toggle = (set: Set<string>, id: string) => {
		const next = new Set(set);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	};

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Link Manager</h1>
					<div className="flex shrink-0 flex-wrap justify-end gap-2">
						<Button variant="secondary" icon={<GearSix />} onClick={() => setSettingsOpen(true)}>
							Settings
						</Button>
						<Button variant="secondary" icon={<Prohibit />} onClick={() => setRulesOpen(true)}>
							Ignore rules
						</Button>
						<Button
							variant="secondary"
							icon={<DownloadSimple />}
							disabled={!data?.total || Boolean(busy)}
							title="Download the links matching the current filters as a CSV file"
							onClick={() => void exportCsv()}
						>
							Export CSV
						</Button>
						<Button variant="secondary" icon={<MagnifyingGlass />} disabled={scanState?.status === "running"} onClick={() => void scan(true)}>
							Scan content
						</Button>
						<Button
							variant="primary"
							icon={<ArrowClockwise />}
							disabled={!data?.checking || Boolean(busy)}
							title={data?.checking ? undefined : "Turn on Scheduled link checking under Plugins → Coywolf Pack"}
							onClick={() => void recheck()}
						>
							Check now
						</Button>
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Every link in your content, where it's used, and whether it still works. Blocked means the destination refused a server (a bot wall such
						as LinkedIn's 999 or Cloudflare's challenge): the link is probably fine.
						{!data?.checking && " Turn on Scheduled link checking under Plugins → Coywolf Pack to check links (weekly by default; change it in Settings)."}
					</p>
				</div>
				<div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
					{FILTERS.map((f) => (
						<Button key={f.id} size="sm" variant={status === f.id ? "primary" : "ghost"} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>
							{f.label}
							{data ? ` (${(data.counts[f.id] ?? 0).toLocaleString()})` : ""}
						</Button>
					))}
				</div>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
					<div className="sm:w-72">
						<Input
							label="Search"
							placeholder="Start of a URL or domain"
							value={query}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
						/>
					</div>
					<div className="sm:w-64">
						<Input
							label="Domain"
							placeholder="example.com"
							value={host}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHost(e.target.value)}
						/>
					</div>
					<div className="sm:w-44">
						<Select
							label="Links"
							value={scope}
							onValueChange={(v: string | null) => setScope((v ?? "all") as typeof scope)}
							items={[
								{ value: "all", label: "Internal and external" },
								{ value: "internal", label: "Internal" },
								{ value: "external", label: "External" },
							]}
						/>
					</div>
				</div>
			</header>

			<div aria-live="polite" className="space-y-3">
				{scanState?.status === "running" && (
					<Banner variant="default" title="Scanning content…" description={`${plural(scanState.processed, "entry", "entries")} indexed so far.`} />
				)}
				{neverScanned && (
					<Banner variant="default" title="Your content hasn't been scanned yet" description="Scan content to build the link list. New and edited entries are added as they're saved." />
				)}
				{data && !data.siteUrlKnown && (
					<Banner
						variant="error"
						title="Set your site URL"
						description="Link Manager needs the site URL (Settings → General, or site in astro.config) to tell internal links from external ones. Nothing is indexed until it's set."
					/>
				)}
				{scanState?.error && <Banner variant="error" title="The last scan stopped" description={scanState.error} />}
				{busy && <Banner variant="default" title={busy} />}
				{notice && <Banner variant="default" role="status" title={notice} />}
				{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			</div>

			{selectedRows.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 rounded-lg border bg-kumo-tint/50 px-4 py-2 text-sm" role="toolbar" aria-label="Bulk actions">
					<span className="me-2 font-medium">{selectedRows.length} selected</span>
					<Button size="sm" variant="secondary" icon={<PencilSimple />} onClick={() => setReplacing(selectedRows)}>
						Replace…
					</Button>
					<Button size="sm" variant="secondary" icon={<LinkBreak />} onClick={() => setUnlinking(selectedRows)}>
						Unlink…
					</Button>
					<Button size="sm" variant="secondary" icon={<EyeSlash />} onClick={() => void ignore(selectedRows, "url")}>
						Ignore
					</Button>
					<Button size="sm" variant="secondary" icon={<ArrowClockwise />} disabled={!data?.checking || Boolean(busy)} onClick={() => void recheck(selectedRows.map((r) => r.id))}>
						Recheck
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
						Clear
					</Button>
				</div>
			)}

			{!data && !error ? (
				<div className="py-12 text-center text-kumo-subtle">
					<Loader />
				</div>
			) : data && data.total === 0 ? (
				<div className="py-10 text-center text-kumo-subtle">
					<LinkSimple size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
					<p className="text-base font-medium">No links match</p>
					<p className="mt-1 text-sm">{data.counts.all + data.counts.ignored === 0 ? "Scan your content to find links." : "Try another filter."}</p>
				</div>
			) : data ? (
				<div className="rounded-lg border">
					<div className="flex items-center gap-3 border-b bg-kumo-tint/50 px-4 py-2 text-sm font-medium text-kumo-subtle">
						<div className="w-5">
							<Checkbox
								aria-label="Select all links on this page"
								checked={allSelected}
								indeterminate={selectedRows.length > 0 && !allSelected}
								onCheckedChange={(checked: boolean) => setSelected(checked ? new Set(items.map((r) => r.id)) : new Set())}
							/>
						</div>
						<div className="min-w-0 flex-1">URL</div>
						<div className="w-32">Status</div>
						<div className="w-24">Used in</div>
						<div className="w-36 cw-lg-block">Checked</div>
						<div className="w-10" />
					</div>
					{items.map((row) => {
						const open = expanded.has(row.id);
						return (
							<div key={row.id} className={`border-b px-4 py-2 text-sm last:border-0 ${row.ignored ? "opacity-60" : ""}`}>
								<div className="flex items-center gap-3">
									<div className="w-5">
										<Checkbox
											aria-label={`Select ${row.url}`}
											checked={selected.has(row.id)}
											onCheckedChange={() => setSelected((s) => toggle(s, row.id))}
										/>
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1.5">
											<a
												className="truncate font-mono text-xs hover:underline"
												href={row.resolved ?? row.url}
												target="_blank"
												rel="noopener noreferrer"
												title={row.url}
											>
												{row.url}
											</a>
											<ArrowSquareOut className="shrink-0 text-kumo-subtle" size={12} aria-hidden="true" />
											{row.internal && <Badge variant="outline">internal</Badge>}
										</div>
										{row.finalUrl && (
											<div className="mt-0.5 truncate text-xs text-kumo-subtle" title={row.chain.map((h) => `${h.code} ${h.url}`).join("\n")}>
												→ {row.finalUrl}
											</div>
										)}
										{row.note && row.status !== "ok" && row.status !== "redirect" && <div className="mt-0.5 truncate text-xs text-kumo-subtle">{row.note}</div>}
									</div>
									<div className="w-32">
										<StatusBadge row={row} />
									</div>
									<div className="w-24">
										<button
											type="button"
											className="inline-flex items-center gap-1 rounded text-kumo-link hover:underline focus-visible:outline focus-visible:outline-2"
											aria-expanded={open}
											onClick={() => setExpanded((s) => toggle(s, row.id))}
										>
											{open ? <CaretDown size={12} aria-hidden="true" /> : <CaretRight size={12} aria-hidden="true" />}
											{plural(row.refs, "entry", "entries")}
										</button>
									</div>
									<div className="w-36 text-xs text-kumo-subtle cw-lg-block">{row.checkedAt ? dateFormat.format(new Date(row.checkedAt)) : "Never"}</div>
									<div className="flex w-10 justify-end">
										<DropdownMenu>
											<DropdownMenu.Trigger
												render={<Button type="button" variant="ghost" shape="square" icon={<DotsThree aria-hidden="true" />} aria-label={`Actions for ${row.url}`} />}
											/>
											<DropdownMenu.Content className="p-1">
												<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<PencilSimple className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => setReplacing([row])}>
													Change URL…
												</DropdownMenu.Item>
												<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<LinkBreak className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => setUnlinking([row])}>
													Unlink…
												</DropdownMenu.Item>
												{data.checking && (
													<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<ArrowClockwise className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => void recheck([row.id])}>
														Recheck
													</DropdownMenu.Item>
												)}
												<DropdownMenu.Separator className="my-0.5" />
												<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<EyeSlash className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => void ignore([row], "url")}>
													Ignore this URL
												</DropdownMenu.Item>
												{row.host && (
													<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<Prohibit className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => void ignore([row], "domain")}>
														Ignore {row.host}
													</DropdownMenu.Item>
												)}
											</DropdownMenu.Content>
										</DropdownMenu>
									</div>
								</div>
								{open && <UsageList row={row} />}
							</div>
						);
					})}
				</div>
			) : null}

			{data && (cursors.length > 1 || data.nextCursor) && (
				<nav className="flex items-center justify-between text-sm" aria-label="Pagination">
					<span className="text-kumo-subtle">
						Page {pageNumber} of {Math.max(1, Math.ceil(data.total / data.pageSize))} · {plural(data.total, "link")}
					</span>
					<div className="flex gap-2">
						<Button size="sm" variant="secondary" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
							Previous
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={!data.nextCursor}
							onClick={() => setCursors((c) => (data.nextCursor ? [...c, data.nextCursor] : c))}
						>
							Next
						</Button>
					</div>
				</nav>
			)}

			<ReplaceDialog
				rows={replacing}
				onClose={() => setReplacing(null)}
				onDone={(message) => {
					setReplacing(null);
					setSelected(new Set());
					setNotice(message);
					void load();
				}}
			/>
			<UnlinkDialog
				rows={unlinking}
				onClose={() => setUnlinking(null)}
				onDone={(message) => {
					setUnlinking(null);
					setSelected(new Set());
					setNotice(message);
					void load();
				}}
			/>
			<SettingsDialog
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				onSaved={(message) => {
					setSettingsOpen(false);
					setNotice(message);
				}}
			/>
			<IgnoreRulesDialog
				open={rulesOpen}
				rules={data?.ignores ?? []}
				onClose={() => setRulesOpen(false)}
				onChanged={(message) => {
					setNotice(message);
					void load();
				}}
			/>
		</div>
	);
}

export function LinksWidget() {
	const [data, setData] = React.useState<{ counts: Record<LinkStatus, number>; scan: ScanState }>();
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		apiFetch(`${API}/summary`)
			.then((r) => parseApiResponse<{ counts: Record<LinkStatus, number>; scan: ScanState }>(r, "Could not load links"))
			.then(setData)
			.catch((cause) => setError(errorText(cause, "Could not load links")));
	}, []);
	if (error) return <p className="text-sm text-kumo-subtle">{error}</p>;
	if (!data) return <Loader />;
	const problems = data.counts.broken + data.counts.error;
	const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
	return (
		<div className="space-y-1 text-sm">
			<p className={problems ? "font-medium text-kumo-danger" : "font-medium"}>{problems ? `${plural(problems, "broken link")}` : "No broken links"}</p>
			<p className="text-kumo-subtle">
				{plural(total, "link")} · {data.counts.blocked.toLocaleString()} blocked · {data.counts.redirect.toLocaleString()} redirected
				{data.counts.unchecked ? ` · ${data.counts.unchecked.toLocaleString()} not checked` : ""}
			</p>
			<a className="text-kumo-link hover:underline" href={`${ADMIN}/plugins/coywolf-pack/links`}>
				Open Link Manager
			</a>
		</div>
	);
}

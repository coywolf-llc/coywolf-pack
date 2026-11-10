/**
 * Content Audit page: the latest report (counts per check, with the change
 * since the run before), each check's findings with links to the entries,
 * Run now, and the audit's settings.
 */
import { Badge, Banner, Button, Checkbox, Dialog, Input, Switch } from "@cloudflare/kumo";
import { ArrowClockwise, DownloadSimple, GearSix, ListChecks } from "@phosphor-icons/react";
import * as React from "react";

import type { AuditSettings, CheckId } from "../audit/checks.js";
import { toCsv } from "../core/csv.js";
import { PACK_API, apiPost, errorText } from "./api.js";
import { saveFile, siteSlug, today } from "./download.js";
import { DocsLink, Loading, PackLink, PageHeader } from "./page.js";
import { useToast } from "./toast.js";

const post = apiPost(`${PACK_API}/audit`, { body: {} });
const ADMIN = "/_emdash/admin";
const PAGE_SIZE = 50;

interface Report {
	runId: string;
	startedAt: string;
	finishedAt: string;
	entries: number;
	entriesWithIssues: number;
	counts: Record<CheckId, number>;
	off: CheckId[];
	linksChecked: boolean;
	previous: { runId: string; finishedAt: string; entries: number; counts: Record<CheckId, number> } | null;
}

interface RunState {
	status: "idle" | "running";
	startedAt: string | null;
	finishedAt: string | null;
	processed: number;
	collections: string[];
	index: number;
	phase: "entries" | "finish";
	error?: string;
	busy?: boolean;
}

interface Status {
	report: Report | null;
	trend: Partial<Record<CheckId, number>>;
	run: RunState;
	settings: AuditSettings;
	collections: Array<{ slug: string; label: string }>;
	checks: Array<{ id: CheckId; label: string; description: string }>;
	links: boolean;
	ai: boolean;
}

interface Finding {
	collection: string;
	id: string;
	title: string;
	updatedAt: string | null;
	check: CheckId;
	detail: string;
}

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const editorHref = (collection: string, id: string) => `${ADMIN}/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;

/** "+3" in the danger color (more problems), "−2" in the success color, nothing for no change. */
function Trend({ delta }: { delta: number | undefined }) {
	if (!delta) return null;
	const worse = delta > 0;
	return (
		<span className={`text-xs font-medium ${worse ? "text-kumo-danger" : "text-kumo-success"}`} title="Change since the run before">
			{worse ? `+${delta}` : `−${-delta}`} since last run
		</span>
	);
}

function SettingsDialog(props: { open: boolean; status: Status | undefined; onClose: () => void; onSaved: () => void }) {
	const [draft, setDraft] = React.useState<AuditSettings>();
	const [numbers, setNumbers] = React.useState<Record<string, string>>({});
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		if (!props.open || !props.status) return;
		const s = props.status.settings;
		setDraft(s);
		setNumbers({ titleMin: String(s.titleMin), titleMax: String(s.titleMax), descriptionMin: String(s.descriptionMin), descriptionMax: String(s.descriptionMax), thinWords: String(s.thinWords), staleMonths: String(s.staleMonths) });
		setError(undefined);
	}, [props.open, props.status]);
	if (!props.status) return null;
	const { checks, collections } = props.status;
	const num = (key: string, fallback: number) => {
		const n = Number.parseInt(numbers[key] ?? "", 10);
		return Number.isFinite(n) ? n : fallback;
	};
	const save = async () => {
		if (!draft) return;
		setPending(true);
		setError(undefined);
		try {
			await post("settings/save", {
				...draft,
				titleMin: num("titleMin", draft.titleMin),
				titleMax: num("titleMax", draft.titleMax),
				descriptionMin: num("descriptionMin", draft.descriptionMin),
				descriptionMax: num("descriptionMax", draft.descriptionMax),
				thinWords: num("thinWords", draft.thinWords),
				staleMonths: num("staleMonths", draft.staleMonths),
			});
			props.onSaved();
		} catch (cause) {
			setError(errorText(cause, "Couldn't save the settings"));
		} finally {
			setPending(false);
		}
	};
	const numberField = (key: string, label: string, description?: string) => (
		<Input type="number" min={0} label={label} description={description} value={numbers[key] ?? ""} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNumbers((n) => ({ ...n, [key]: e.target.value }))} />
	);
	return (
		<Dialog.Root open={props.open} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Audit settings</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">Changes apply from the next run.</Dialog.Description>
				{draft && (
					<form
						className="mt-4 space-y-5 cw-dialog-scroll"
						onSubmit={(e) => {
							e.preventDefault();
							void save();
						}}
					>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">Collections</legend>
							<p className="text-xs text-kumo-subtle">None checked audits every collection with public pages.</p>
							{collections.map((c) => (
								<div key={c.slug}>
									<Checkbox
										label={c.label}
										checked={draft.collections.includes(c.slug)}
										onCheckedChange={(on: boolean) => setDraft({ ...draft, collections: on ? [...draft.collections, c.slug] : draft.collections.filter((x) => x !== c.slug) })}
									/>
								</div>
							))}
						</fieldset>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">Checks</legend>
							{checks.map((c) => (
								<div key={c.id}>
									<Checkbox
										label={c.label}
										checked={!draft.off.includes(c.id)}
										onCheckedChange={(on: boolean) => setDraft({ ...draft, off: on ? draft.off.filter((x) => x !== c.id) : [...draft.off, c.id] })}
									/>
								</div>
							))}
						</fieldset>
						<div className="grid gap-3 sm:grid-cols-2">
							{numberField("titleMin", "Shortest title (characters)")}
							{numberField("titleMax", "Longest title (characters)", "Search results show about 60.")}
							{numberField("descriptionMin", "Shortest description (characters)")}
							{numberField("descriptionMax", "Longest description (characters)", "Search results show about 160.")}
							{numberField("thinWords", "Thin below (words)", "0 turns the check off.")}
							{numberField("staleMonths", "Stale after (months)", "0 turns the check off.")}
						</div>
						<Switch label="The theme shows the entry's title as the page's H1" checked={draft.titleIsH1} onCheckedChange={(on: boolean) => setDraft({ ...draft, titleIsH1: on })} />
						<p className="-mt-3 text-xs text-kumo-subtle">Then an H1 in the content is a second one, and the first heading in the content should be an H2.</p>
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
			</Dialog>
		</Dialog.Root>
	);
}

export function ContentAuditPage() {
	const [status, setStatus] = React.useState<Status>();
	const [error, setError] = React.useState<string>();
	const [check, setCheck] = React.useState<CheckId | null>(null);
	const [findings, setFindings] = React.useState<{ items: Finding[]; total: number; offset: number } | null>(null);
	const [offset, setOffset] = React.useState(0);
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	const [running, setRunning] = React.useState(false);
	const toast = useToast();
	const runningRef = React.useRef(false);

	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			const next = await post<Status>("status", {}, "Couldn't load the audit");
			setStatus(next);
			return next;
		} catch (cause) {
			setError(errorText(cause, "Couldn't load the audit"));
			return undefined;
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const report = status?.report ?? null;
	const visibleChecks = (status?.checks ?? []).filter((c) => !report?.off.includes(c.id) && (c.id !== "brokenLinks" || status?.links));
	const selected = check ?? visibleChecks.find((c) => (report?.counts[c.id] ?? 0) > 0)?.id ?? null;

	React.useEffect(() => setOffset(0), [selected, report?.runId]);
	React.useEffect(() => {
		if (!report || !selected) {
			setFindings(null);
			return;
		}
		let live = true;
		post<{ items: Finding[]; total: number; offset: number }>("findings", { check: selected, offset, limit: PAGE_SIZE })
			.then((r) => live && setFindings(r))
			.catch((cause) => live && setError(errorText(cause, "Couldn't load the findings")));
		return () => {
			live = false;
		};
	}, [report, selected, offset]);

	/** Run (or continue) the audit while the page is open: one step per request. */
	const run = React.useCallback(
		async (start: boolean) => {
			if (runningRef.current) return;
			runningRef.current = true;
			setRunning(true);
			setError(undefined);
			try {
				let state = await post<RunState>("run", { start });
				while (state.status === "running" && !state.error) {
					setStatus((s) => (s ? { ...s, run: state } : s));
					if (state.busy) await new Promise((resolve) => setTimeout(resolve, 5000));
					state = await post<RunState>("run", {});
				}
				const next = await load();
				if (state.error) setError(state.error);
				else if (next?.report) toast.success("Audit finished", `${plural(next.report.entriesWithIssues, "entry", "entries")} of ${next.report.entries.toLocaleString("en-US")} have something to fix.`);
			} catch (cause) {
				setError(errorText(cause, "The audit stopped"));
			} finally {
				runningRef.current = false;
				setRunning(false);
			}
		},
		[load, toast],
	);
	// A run under way (scheduled, or started earlier): keep it moving while the page is open.
	React.useEffect(() => {
		if (status?.run.status === "running" && !runningRef.current) void run(false);
	}, [status?.run.status, run]);

	const exportCsv = async () => {
		try {
			const all = await post<{ items: Finding[] }>("findings", { limit: 10_000 });
			const labels = new Map((status?.checks ?? []).map((c) => [c.id, c.label]));
			const rows = [["Entry", "Collection", "Check", "Detail", "Updated", "Editor"], ...all.items.map((f) => [f.title, f.collection, labels.get(f.check) ?? f.check, f.detail, f.updatedAt ?? "", `${location.origin}${editorHref(f.collection, f.id)}`])];
			saveFile(toCsv(rows, { guard: true }), `content-audit-${siteSlug() || "site"}-${today()}.csv`, "text/csv");
		} catch (cause) {
			setError(errorText(cause, "Export failed"));
		}
	};

	const runState = status?.run;
	const selectedInfo = status?.checks.find((c) => c.id === selected);
	const aiHint = status?.ai && (selected === "descriptionMissing" || selected === "altMissing");

	return (
		<div className="space-y-6">
			<PageHeader
				title="Content Audit"
				actions={
					<>
						<Button variant="secondary" icon={<GearSix />} disabled={!status} onClick={() => setSettingsOpen(true)}>
							Settings
						</Button>
						<Button variant="secondary" icon={<DownloadSimple />} disabled={!report?.entriesWithIssues} onClick={() => void exportCsv()}>
							Export CSV
						</Button>
						<Button variant="primary" icon={<ArrowClockwise />} disabled={running || runState?.status === "running"} onClick={() => void run(true)}>
							{running || runState?.status === "running" ? "Running…" : "Run now"}
						</Button>
					</>
				}
				description={
					<>
						What's missing or worth fixing in your published entries, checked every week (or when you select Run now). Each count is the number of entries
						with that problem. <DocsLink doc="content-audit">How each check works</DocsLink>
					</>
				}
			/>

			<div aria-live="polite" className="space-y-3">
				{runState?.status === "running" && (
					<Banner
						variant="default"
						title={runState.phase === "finish" ? "Finishing the audit…" : "Auditing your content…"}
						description={`${plural(runState.processed, "entry", "entries")} checked so far${runState.collections.length ? ` (collection ${Math.min(runState.index + 1, runState.collections.length)} of ${runState.collections.length})` : ""}. It continues in the background if you leave this page.`}
					/>
				)}
				{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			</div>

			{!status && !error ? (
				<Loading label="Loading the audit…" />
			) : status && !report ? (
				runState?.status !== "running" && (
					<div className="py-10 text-center text-kumo-subtle">
						<ListChecks size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
						<p className="text-base font-medium">No audit yet</p>
						<p className="mt-1 text-sm">Select Run now for the first report. After that it runs every week.</p>
					</div>
				)
			) : report ? (
				<>
					<p className="text-sm text-kumo-subtle" role="status">
						{plural(report.entriesWithIssues, "entry", "entries")} of {report.entries.toLocaleString("en-US")} have something to fix · last run {dateTime.format(new Date(report.finishedAt))}
						{report.previous ? ` · compared with ${dateTime.format(new Date(report.previous.finishedAt))}` : ""}
					</p>
					<div className="grid gap-3 sm:grid-cols-2 cw-lg-cols-6" role="group" aria-label="Checks">
						{visibleChecks.map((c) => {
							const n = report.counts[c.id] ?? 0;
							const active = c.id === selected;
							return (
								<button
									key={c.id}
									type="button"
									aria-pressed={active}
									title={c.description}
									onClick={() => setCheck(c.id)}
									className={`rounded-lg border px-3 py-2 text-start focus-visible:outline focus-visible:outline-2 ${active ? "border-kumo-brand bg-kumo-tint" : "border-kumo-line hover:bg-kumo-tint"}`}
								>
									<span className="block text-xs text-kumo-subtle">{c.label}</span>
									<span className="block text-xl font-semibold">{n.toLocaleString("en-US")}</span>
									<Trend delta={status?.trend[c.id]} />
								</button>
							);
						})}
					</div>

					{selectedInfo && (
						<section aria-labelledby="cw-audit-findings" className="space-y-3">
							<div>
								<h2 id="cw-audit-findings" className="text-base font-semibold">
									{selectedInfo.label}
								</h2>
								<p className="mt-1 text-sm text-kumo-subtle">{selectedInfo.description}</p>
								{selected === "brokenLinks" && !report.linksChecked && <p className="mt-1 text-sm text-kumo-subtle">Link Manager's data wasn't there for this run. Turn on Link Manager and scan your content.</p>}
								{aiHint && (
									<p className="mt-1 text-sm">
										<PackLink page="/ai">AI Enrichment</PackLink> can write {selected === "altMissing" ? "alt text for media-library images" : "meta descriptions"} for you.
									</p>
								)}
							</div>
							{!findings ? (
								<Loading className="py-6 text-center" />
							) : findings.total === 0 ? (
								<p className="rounded-lg border border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle">Nothing to fix here.</p>
							) : (
								<div className="rounded-lg border">
									<table className="w-full text-sm">
										<thead className="border-b bg-kumo-tint/50 text-kumo-subtle">
											<tr>
												<th scope="col" className="px-4 py-2 text-start font-medium">
													Entry
												</th>
												<th scope="col" className="px-4 py-2 text-start font-medium">
													Details
												</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-kumo-line">
											{findings.items.map((f) => (
												<tr key={`${f.check}|${f.collection}/${f.id}`} className="align-top">
													<td className="px-4 py-2">
														<a className="font-medium text-kumo-link hover:underline" href={editorHref(f.collection, f.id)}>
															{f.title}
														</a>
														<span className="ms-2 text-xs text-kumo-subtle">{f.collection}</span>
													</td>
													<td className="px-4 py-2 text-kumo-subtle">{f.detail}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
							{findings && findings.total > PAGE_SIZE && (
								<nav className="flex items-center justify-between text-sm" aria-label="Pagination">
									<span className="text-kumo-subtle">
										{(offset + 1).toLocaleString("en-US")}–{Math.min(offset + PAGE_SIZE, findings.total).toLocaleString("en-US")} of {plural(findings.total, "entry", "entries")}
									</span>
									<div className="flex gap-2">
										<Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>
											Previous
										</Button>
										<Button size="sm" variant="secondary" disabled={offset + PAGE_SIZE >= findings.total} onClick={() => setOffset((o) => o + PAGE_SIZE)}>
											Next
										</Button>
									</div>
								</nav>
							)}
						</section>
					)}
					{report.off.length > 0 && (
						<p className="text-xs text-kumo-subtle">
							Off in Settings: {report.off.map((id) => status?.checks.find((c) => c.id === id)?.label ?? id).join(", ")}. <Badge variant="outline">{plural(report.off.length, "check")}</Badge>
						</p>
					)}
				</>
			) : null}

			<SettingsDialog
				open={settingsOpen}
				status={status}
				onClose={() => setSettingsOpen(false)}
				onSaved={() => {
					setSettingsOpen(false);
					toast.success("Audit settings saved", "They apply from the next run.");
					void load();
				}}
			/>
		</div>
	);
}

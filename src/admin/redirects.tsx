/**
 * Redirects admin page, styled like the EmDash admin's own Redirects page.
 */
import { Badge, Banner, Button, Checkbox, Dialog, DropdownMenu, Input, InputArea, Select } from "@cloudflare/kumo";
import { ArrowRight, ArrowsSplit, DotsThree, DownloadSimple, FileArrowUp, PencilSimple, Plus, Trash, UploadSimple } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { useConfirm } from "./confirm-dialog.js";
import { apiPost, errorText } from "./api.js";
import { PageHeader, Loading } from "./page.js";
import { parseRedirectsImport, redirectsToCsv, redirectsToJson } from "../redirects/transfer.js";
import type { RedirectRule } from "../redirects/rules.js";
import { saveFile, siteSlug, today } from "./download.js";
import { RemovedContentPanel } from "./redirects-removed.js";
import { PartSwitches } from "./feature-switches.js";

const API = "/_emdash/api/plugins/coywolf-pack/redirects";

const post = apiPost(API);

interface Rule {
	id: string;
	source: string;
	target: string;
	type: number;
	isRegex: boolean;
	enabled: boolean;
	hits: number;
	lastHit: string | null;
	note: string | null;
}

type RuleDraft = Partial<Omit<Rule, "hits" | "lastHit">>;

const TYPES = [301, 302, 307, 308, 410];
const TYPE_LABELS: Record<number, string> = {
	301: "301 Permanent",
	302: "302 Temporary",
	307: "307 Temporary (keep method)",
	308: "308 Permanent (keep method)",
	410: "410 Gone",
};

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** Download every rule (not just the filtered ones) in a format Import reads back. */
async function exportRules(format: "csv" | "json"): Promise<number> {
	const { items } = await parseApiResponse<{ items: RedirectRule[] }>(await apiFetch(`${API}/list`), "Could not load redirects");
	const name = `redirects-${siteSlug() || "site"}-${today()}`;
	if (format === "csv") saveFile(redirectsToCsv(items), `${name}.csv`, "text/csv");
	else saveFile(redirectsToJson(items), `${name}.json`, "application/json");
	return items.length;
}

function RuleDialog(props: { rule: RuleDraft | null; onClose: () => void; onSaved: () => void }) {
	const [draft, setDraft] = React.useState<RuleDraft>({});
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		setDraft(props.rule ?? {});
		setError(undefined);
	}, [props.rule]);
	const set = (patch: RuleDraft) => setDraft((d) => ({ ...d, ...patch }));
	const type = draft.type ?? 301;

	const save = async () => {
		setPending(true);
		setError(undefined);
		try {
			await post("save", { ...draft, type });
			props.onSaved();
		} catch (cause) {
			setError(errorText(cause, "Could not save the redirect"));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog.Root open={props.rule !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{draft.id ? "Edit redirect" : "New redirect"}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Paths match with or without a trailing slash. The visitor's query string is kept unless the destination has
					one.
				</Dialog.Description>
				<form
					className="mt-4 space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<Input
						label={draft.isRegex ? "Pattern (regular expression)" : "Source path"}
						placeholder={draft.isRegex ? "^/old-section/(.*)$" : "/visit/partner"}
						value={draft.source ?? ""}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ source: e.target.value })}
						required
					/>
					<Checkbox
						label="Regular expression (use $1–$9 in the destination for captured groups)"
						checked={draft.isRegex ?? false}
						onCheckedChange={(checked: boolean) => set({ isRegex: checked })}
					/>
					{type !== 410 && (
						<Input
							label="Destination"
							placeholder="https://example.com/page or /new-path/"
							value={draft.target ?? ""}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ target: e.target.value })}
							required
						/>
					)}
					<Select
						label="Type"
						value={String(type)}
						onValueChange={(value: string | null) => set({ type: Number(value ?? 301) })}
						items={TYPES.map((t) => ({ value: String(t), label: TYPE_LABELS[t] }))}
					/>
					<Input
						label="Note (optional)"
						value={draft.note ?? ""}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ note: e.target.value })}
					/>
					<Checkbox
						label="Enabled"
						checked={draft.enabled ?? true}
						onCheckedChange={(checked: boolean) => set({ enabled: checked })}
					/>
					{error && <Banner variant="error" role="alert" description={error} />}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" disabled={pending} onClick={props.onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={pending}>
							{pending ? "Saving…" : "Save redirect"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

function ImportDialog(props: { open: boolean; onClose: () => void; onImported: (count: number) => void }) {
	const [text, setText] = React.useState("");
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const fileRef = React.useRef<HTMLInputElement>(null);
	const run = async () => {
		setPending(true);
		setError(undefined);
		try {
			const rules = parseRedirectsImport(text);
			if (!rules.length) throw new Error("Paste or choose at least one rule.");
			const result = await post<{ imported: number }>("import", { rules });
			setText("");
			props.onImported(result.imported);
		} catch (cause) {
			setError(errorText(cause, "Import failed"));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog.Root open={props.open} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Import redirects</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Paste or choose a file: an Export from this page (CSV or JSON), a JSON array, or rows of{" "}
					<code>source, target, type, is_regex</code> separated by tabs or commas (a header row is optional). A Coywolf SEO
					export from WordPress works as is. Existing rules with the same source are updated.
				</Dialog.Description>
				<div className="mt-4">
					<InputArea
						label="Rules"
						rows={10}
						value={text}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
						className="font-mono text-xs"
					/>
				</div>
				{error && <Banner variant="error" role="alert" className="mt-3 whitespace-pre-wrap" description={error} />}
				<div className="mt-6 flex flex-wrap justify-end gap-2">
					<Button className="me-auto" variant="secondary" icon={<FileArrowUp />} disabled={pending} onClick={() => fileRef.current?.click()}>
						Choose file…
					</Button>
					<input
						ref={fileRef}
						type="file"
						accept=".csv,.tsv,.txt,.json,text/csv,text/plain,application/json"
						className="sr-only"
						tabIndex={-1}
						aria-hidden="true"
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (file) void file.text().then(setText, () => setError("Could not read that file."));
						}}
					/>
					<Button variant="secondary" disabled={pending} onClick={props.onClose}>
						Cancel
					</Button>
					<Button variant="primary" disabled={pending || !text.trim()} onClick={() => void run()}>
						{pending ? "Importing…" : "Import"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

export function RedirectsPage() {
	const [confirm, confirmDialog] = useConfirm();
	const [rules, setRules] = React.useState<Rule[]>();
	const [error, setError] = React.useState<string>();
	const [query, setQuery] = React.useState("");
	const [editing, setEditing] = React.useState<RuleDraft | null>(null);
	const [importing, setImporting] = React.useState(false);
	const [notice, setNotice] = React.useState<string>();
	const [testUrl, setTestUrl] = React.useState("");
	const [testResult, setTestResult] = React.useState<string>();

	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			const data = await parseApiResponse<{ items: Rule[] }>(await apiFetch(`${API}/list`), "Could not load redirects");
			setRules(data.items);
		} catch (cause) {
			setError(errorText(cause, "Could not load redirects"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const remove = async (rule: Rule) => {
		if (!(await confirm({ title: "Delete this redirect?", description: `${rule.source} stops redirecting.`, confirmLabel: "Delete" }))) return;
		try {
			await post("delete", { id: rule.id });
			setNotice(`Deleted ${rule.source}.`);
			await load();
		} catch (cause) {
			setError(errorText(cause, "Delete failed"));
		}
	};

	const runExport = async (format: "csv" | "json") => {
		try {
			const count = await exportRules(format);
			setNotice(`Exported ${count} ${count === 1 ? "redirect" : "redirects"}. Import the file on any site to bring them back.`);
		} catch (cause) {
			setError(errorText(cause, "Export failed"));
		}
	};

	const test = async () => {
		try {
			const result = await post<{ matched: boolean; rule?: Rule; location?: string }>("test", { url: testUrl });
			setTestResult(
				result.matched && result.rule
					? result.rule.type === 410
						? `410 Gone (rule ${result.rule.source})`
						: `${result.rule.type} → ${result.location} (rule ${result.rule.source})`
					: "No Coywolf redirect matches. EmDash's built-in Redirects or the page itself will handle it.",
			);
		} catch (cause) {
			setTestResult(errorText(cause, "Test failed"));
		}
	};

	const q = query.trim().toLowerCase();
	const visible = (rules ?? []).filter(
		(r) => !q || r.source.toLowerCase().includes(q) || r.target.toLowerCase().includes(q) || r.note?.toLowerCase().includes(q),
	);

	return (
		<div className="space-y-6">
			{confirmDialog}
			<PageHeader
				title="Redirect Manager"
				actions={
					<>
						<Button variant="secondary" icon={<UploadSimple />} onClick={() => setImporting(true)}>
							Import
						</Button>
						<DropdownMenu>
							<DropdownMenu.Trigger
								render={
									<Button variant="secondary" icon={<DownloadSimple />} disabled={!rules?.length}>
										Export
									</Button>
								}
							/>
							<DropdownMenu.Content className="p-1">
								<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" onClick={() => void runExport("csv")}>
									CSV (spreadsheets)
								</DropdownMenu.Item>
								<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" onClick={() => void runExport("json")}>
									JSON
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu>
						<Button variant="primary" icon={<Plus />} onClick={() => setEditing({})}>
							New redirect
						</Button>
					</>
				}
				description={
					<>
						For redirects EmDash's built-in Redirects can't handle: external destinations (affiliate links, moved
						articles) and file paths such as old <code>/wp-content/</code> URLs. Changes apply within a minute.
					</>
				}
			>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
					<div className="sm:w-72">
						<Input
							label="Filter"
							placeholder="Search sources, destinations, notes"
							value={query}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
						/>
					</div>
					<form
						className="flex flex-1 items-end gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							void test();
						}}
					>
						<div className="flex-1">
							<Input
								label="Test a URL"
								placeholder="/visit/partner"
								value={testUrl}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTestUrl(e.target.value)}
							/>
						</div>
						<Button type="submit" variant="secondary" disabled={!testUrl.trim()}>
							Test
						</Button>
					</form>
				</div>
				{testResult && <p className="text-sm text-kumo-subtle">{testResult}</p>}
			</PageHeader>

			<PartSwitches module="redirects" />

			{notice && <Banner variant="default" role="status" title={notice} />}
			{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			<RemovedContentPanel onRuleCreated={() => void load()} />

			{!rules && !error ? (
				<Loading className="py-12 text-center text-kumo-subtle" />
			) : rules && rules.length === 0 ? (
				<div className="py-10 text-center text-kumo-subtle">
					<ArrowsSplit size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
					<p className="text-base font-medium">No redirects yet</p>
					<p className="mt-1 text-sm">Create one, or import rules from WordPress.</p>
				</div>
			) : rules ? (
				<div className="rounded-lg border">
					<div className="flex items-center gap-4 border-b bg-kumo-tint/50 px-4 py-2 text-sm font-medium text-kumo-subtle">
						<div className="min-w-0 flex-1">Source</div>
						<div className="w-6" />
						<div className="min-w-0 flex-1">Destination</div>
						<div className="w-14 text-center">Code</div>
						<div className="hidden w-16 text-end md:block" title="Requests the site's Worker answered; repeats served from the edge cache aren't counted">
							Hits
						</div>
						<div className="w-32 cw-lg-block">Last hit</div>
						<div className="w-10" />
					</div>
					{visible.map((rule) => (
						<div
							key={rule.id}
							className={`flex items-center gap-4 border-b px-4 py-2 text-sm last:border-0 ${rule.enabled ? "" : "opacity-50"}`}
						>
							<div className="min-w-0 flex-1">
								<div className="truncate font-mono text-xs" title={rule.source}>
									{rule.source}
								</div>
								{(rule.isRegex || rule.note) && (
									<div className="mt-0.5 flex items-center gap-1 truncate text-xs text-kumo-subtle">
										{rule.isRegex && <Badge variant="outline">regex</Badge>}
										{rule.note}
									</div>
								)}
							</div>
							<ArrowRight className="w-6 shrink-0 text-kumo-subtle" aria-hidden="true" />
							<div className="min-w-0 flex-1 truncate font-mono text-xs" title={rule.target}>
								{rule.type === 410 ? <span className="text-kumo-subtle">Gone</span> : rule.target}
							</div>
							<div className="w-14 text-center">
								<Badge variant="secondary">{rule.type}</Badge>
							</div>
							<div className="hidden w-16 text-end tabular-nums md:block">{rule.hits.toLocaleString()}</div>
							<div className="w-32 text-xs text-kumo-subtle cw-lg-block">
								{rule.lastHit ? dateFormat.format(new Date(rule.lastHit)) : "Never"}
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
												aria-label={`Actions for ${rule.source}`}
											/>
										}
									/>
									<DropdownMenu.Content className="p-1">
										<DropdownMenu.Item
											className="py-1 data-highlighted:bg-kumo-fill"
											icon={PencilSimple}
											onClick={() => setEditing(rule)}
										>
											Edit
										</DropdownMenu.Item>
										<DropdownMenu.Separator className="my-0.5" />
										<DropdownMenu.Item variant="danger"
											className="py-1"
											icon={Trash}
											onClick={() => void remove(rule)}
										>
											Delete
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu>
							</div>
						</div>
					))}
					{visible.length === 0 && <p className="px-4 py-6 text-center text-sm text-kumo-subtle">No redirects match.</p>}
				</div>
			) : null}
			{rules && rules.length > 0 && (
				<p className="text-sm text-kumo-subtle">
					Hits count requests the site's Worker answered. With the page cache on, redirects are cached at the edge (and cleared when you
					change them), so repeats served from the cache aren't counted.
				</p>
			)}

			<RuleDialog
				rule={editing}
				onClose={() => setEditing(null)}
				onSaved={() => {
					setEditing(null);
					setNotice("Redirect saved.");
					void load();
				}}
			/>
			<ImportDialog
				open={importing}
				onClose={() => setImporting(false)}
				onImported={(count) => {
					setImporting(false);
					setNotice(`Imported ${count} ${count === 1 ? "redirect" : "redirects"}.`);
					void load();
				}}
			/>
		</div>
	);
}

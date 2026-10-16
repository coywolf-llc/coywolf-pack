/**
 * Robots.txt admin page: a plain-English summary of the whole file, then
 * tabs for Rules (list, URL tester, what's being served), Bots (the crawler
 * directory) and Settings & history. Rules are added and edited in a guided
 * dialog (./robots-wizard.tsx); every change is checked in the browser and
 * again on the server (including the self-check) before it's saved.
 */
import { Badge, Banner, Button, Checkbox, Dialog, DropdownMenu, Input, InputArea, Loader, Switch, Tabs } from "@cloudflare/kumo";
import { CheckCircle, Copy, DotsThree, DownloadSimple, FileArrowUp, Info, PencilSimple, Plus, Robot, Sparkle, Trash, Warning, X, XCircle } from "@phosphor-icons/react";
import * as React from "react";

import type { BotEntry } from "../robots/bots.js";
import { describeRule, summarize } from "../robots/explain.js";
import { evaluate } from "../robots/rep.js";
import { EMDASH_AI_TRAINING_CRAWLERS, type RobotsConfig, type RobotsRule, TEMPLATES, directives, resolveAgents } from "../robots/rules.js";
import { exportRobotsRules, readRobotsImport } from "../robots/transfer.js";
import { type Finding, analyzeConfigChange, checkConfig } from "../robots/validate.js";
import { BotsTab } from "./robots-bots.js";
import { dateTimeFormat, errorText, get, newId, post, tokenIndex, useCopy } from "./robots-shared.js";
import { saveFile, siteSlug, today } from "./download.js";
import { RuleWizard } from "./robots-wizard.js";
import { SaveBar, isDirty } from "./save-bar.js";

interface SyncState {
	at: string;
	ok: boolean;
	total?: number;
	added?: number;
	updated?: number;
	delisted?: number;
	error?: string;
}

interface HistoryItem {
	id: string;
	at: string;
	by?: string;
	label: string;
	rules: number;
}

interface PageData {
	config: RobotsConfig;
	siteUrl: string;
	preview: string;
	emdash: { text: string; custom: boolean };
	history: HistoryItem[];
	sitemapNoteDismissed: boolean;
	warnings: Finding[];
	groupChanges: Array<{ ruleId: string; ruleName: string; group: string; added: string[]; removed: string[] }>;
	sections: Array<{ label: string; path: string }>;
	radar: { tokenConfigured: boolean; tokenSource: "settings" | "env" | null; state: SyncState | null; baselineDate: string };
}

interface Confirm {
	title: string;
	body: string;
	findings?: Finding[];
	confirmLabel: string;
	destructive?: boolean;
	onConfirm: () => Promise<void>;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ConfirmDialog(props: { confirm: Confirm | null; onClose: () => void }) {
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => setError(undefined), [props.confirm]);
	const c = props.confirm;
	if (!c) return null;
	return (
		<Dialog.Root open onOpenChange={(open) => !open && !busy && props.onClose()}>
			<Dialog className="max-h-[90vh] overflow-y-auto p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{c.title}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">{c.body}</Dialog.Description>
				{c.findings && c.findings.length > 0 && (
					<ul className="mt-3 space-y-1.5">
						{c.findings.map((f, i) => (
							<li key={`${f.code}-${i}`} className="flex items-start gap-2 text-sm">
								<Warning className="mt-0.5 shrink-0 text-kumo-warning" aria-hidden="true" />
								<span>{f.message}</span>
							</li>
						))}
					</ul>
				)}
				{error && (
					<div className="mt-3">
						<Banner variant="error" role="alert" description={error} />
					</div>
				)}
				<div className="mt-5 flex justify-end gap-2">
					<Button type="button" variant="secondary" disabled={busy} onClick={props.onClose}>
						Cancel
					</Button>
					<Button
						type="button"
						variant={c.destructive ? "destructive" : "primary"}
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							setError(undefined);
							try {
								await c.onConfirm();
								props.onClose();
							} catch (cause) {
								setError(errorText(cause, "That didn't work"));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy ? "Working…" : c.confirmLabel}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

function Tester(props: { robotsTxt: string; bots: BotEntry[]; siteUrl: string }) {
	const [agent, setAgent] = React.useState("Googlebot");
	const [url, setUrl] = React.useState("/");
	const tokens = React.useMemo(() => [...new Set(props.bots.map((b) => b.token))].sort((a, b) => a.localeCompare(b)), [props.bots]);
	const token = agent.trim();
	const verdict = token && url.trim() ? evaluate(props.robotsTxt, [token], url.trim(), { encodePath: true }) : null;
	const lines = props.robotsTxt.split("\n");
	return (
		<section className="space-y-3 rounded-lg border p-4" aria-labelledby="robots-tester">
			<h2 id="robots-tester" className="text-base font-semibold">
				Can a crawler fetch a URL?
			</h2>
			<p className="text-sm text-kumo-subtle">Tests the robots.txt being served, the way Google reads it.</p>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<div className="sm:w-64">
					<Input label="Crawler token" list="cw-robots-tokens" value={agent} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAgent(e.target.value)} />
					<datalist id="cw-robots-tokens">
						{tokens.map((t) => (
							<option key={t} value={t} />
						))}
					</datalist>
				</div>
				<div className="flex-1">
					<Input label="URL or path" placeholder={`${props.siteUrl || "https://example.com"}/some/page/`} value={url} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)} />
				</div>
			</div>
			<div aria-live="polite" className="text-sm">
				{verdict && (
					<p className="flex items-start gap-2">
						{verdict.allowed ? <CheckCircle className="mt-0.5 shrink-0 text-kumo-success" aria-hidden="true" /> : <XCircle className="mt-0.5 shrink-0 text-kumo-danger" aria-hidden="true" />}
						<span>
							<strong>{verdict.allowed ? "Allowed" : "Blocked"}</strong> for <code>{token}</code> at <code>{verdict.path}</code>.{" "}
							{verdict.matchedDirective === "none"
								? verdict.scope === "specific"
									? `${token} has its own rules and none of them match, so it may fetch it.`
									: "No rule matches, so it may fetch it."
								: `Decided by line ${verdict.matchedLine}: ${lines[verdict.matchedLine - 1]?.trim()} (${verdict.scope === "specific" ? `${token}'s own group` : "the rules for all crawlers"}).`}
						</span>
					</p>
				)}
			</div>
		</section>
	);
}

function ServedFile(props: { text: string; emdash: PageData["emdash"]; config: RobotsConfig; siteUrl: string }) {
	const [status, copy] = useCopy();
	const rows = props.text.split("\n").length;
	return (
		<section className="space-y-3" aria-labelledby="robots-served">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 id="robots-served" className="text-base font-semibold">
					What's being served
				</h2>
				<div className="flex items-center gap-2">
					<span className="text-xs text-kumo-subtle" role="status" aria-live="polite">
						{status}
					</span>
					<Button variant="secondary" icon={<Copy />} onClick={() => copy(props.text)}>
						Copy
					</Button>
					<Button variant="secondary" icon={<DownloadSimple />} onClick={() => saveFile(props.text, "robots.txt")}>
						Download
					</Button>
					{props.siteUrl && (
						<a className="text-sm underline" href={`${props.siteUrl}/robots.txt`} target="_blank" rel="noreferrer noopener">
							Open /robots.txt
						</a>
					)}
				</div>
			</div>
			{props.config.importNotes && props.config.importNotes.length > 0 && (
				<div className="rounded-lg border border-kumo-line bg-kumo-tint/30 p-3 text-sm">
					<p className="font-medium">
						{props.config.importedAt ? `Set up from EmDash's robots.txt on ${dateTimeFormat.format(new Date(props.config.importedAt))}` : "What's new"}
					</p>
					<ul className="mt-1 list-disc space-y-0.5 ps-5 text-kumo-subtle">
						{props.config.importNotes.map((n) => (
							<li key={n}>{n}</li>
						))}
					</ul>
				</div>
			)}
			<textarea readOnly aria-label="robots.txt being served" className="w-full resize-none rounded-lg border bg-kumo-tint/40 p-3 font-mono text-xs" rows={rows} value={props.text} />
			<p className="text-xs text-kumo-subtle">Turn the Robots.txt Rules feature off (on Plugins → Coywolf Pack) to serve EmDash's own robots.txt again. Your rules are kept for next time.</p>
			<details className="rounded-lg border border-kumo-line px-3 py-2">
				<summary className="cursor-pointer text-sm font-medium">EmDash's original robots.txt (for reference)</summary>
				<p className="mt-2 text-xs text-kumo-subtle">
					{props.emdash.custom ? "From EmDash's SEO settings." : "EmDash's built-in default."} This is what EmDash serves when this feature is off.
				</p>
				<pre className="mt-1 overflow-x-auto font-mono text-xs">{props.emdash.text}</pre>
			</details>
		</section>
	);
}

/** "List the site's sitemap", up top, with a gentle dismissible note when it's off. */
function SitemapOption(props: { config: RobotsConfig; siteUrl: string; busy: boolean; noteDismissed: boolean; onChange: (on: boolean) => void; onDismiss: () => void }) {
	return (
		<section className="space-y-2 rounded-lg border border-kumo-line p-4" aria-labelledby="robots-sitemap">
			<h2 id="robots-sitemap" className="sr-only">
				Sitemap
			</h2>
			<Checkbox
				label={`List the site's sitemap (${props.siteUrl || "your site"}/sitemap.xml)`}
				checked={props.config.includeSitemap}
				disabled={props.busy}
				onCheckedChange={(on: boolean) => props.onChange(on)}
			/>
			<p className="cw-ps-6 text-xs text-kumo-subtle">A Sitemap line tells every search engine where your sitemap is. Turn it off if you'd rather submit sitemaps yourself, for example in Google Search Console.</p>
			{!props.config.includeSitemap && !props.noteDismissed && (
				<div className="flex items-start gap-2 rounded bg-kumo-tint/40 px-3 py-2 text-sm" role="note">
					<Info className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
					<span className="flex-1">
						Your sitemap isn't listed in robots.txt. That's fine if you submit it in Search Console; other search engines may find it more slowly.{" "}
						<button type="button" className="font-medium underline" disabled={props.busy} onClick={() => props.onChange(true)}>
							List it
						</button>
					</span>
					<Button type="button" variant="ghost" shape="square" size="sm" aria-label="Don't show this note again" onClick={props.onDismiss}>
						<X aria-hidden="true" />
					</Button>
				</div>
			)}
		</section>
	);
}

/** AI training: EmDash's own Settings > SEO switch, whose lines this robots.txt includes while it's on. */
function AiTraining(props: { config: RobotsConfig }) {
	const on = props.config.automatic?.aiTraining === true;
	const own = props.config.rules.filter((r) => r.enabled && r.group === "ai_training" && r.directive === "disallow");
	// A site-wide Allow for one of EmDash's crawlers wins over its Disallow: / (the more specific of equal-length lines is Allow).
	const named = new Set(EMDASH_AI_TRAINING_CRAWLERS.map((t) => t.toLowerCase()));
	const allowed = props.config.rules.filter((r) => r.enabled && r.directive === "allow" && r.kind === "entire_site" && r.agents.some((a) => named.has(a.toLowerCase())));
	return (
		<section className="space-y-2 rounded-lg border border-kumo-line p-4" aria-labelledby="robots-ai-training">
			<h2 id="robots-ai-training" className="flex items-center gap-2 text-base font-semibold">
				AI training <Badge variant={on ? "primary" : "secondary"}>{on ? "Disallowed" : "Not set"}</Badge>
			</h2>
			<p className="text-sm text-kumo-subtle">
				{on
					? `EmDash's "Disallow AI training" is on, so this robots.txt asks AI training crawlers to stay away: a Content-Signal line (search=yes, ai-train=no) and Disallow: / for ${EMDASH_AI_TRAINING_CRAWLERS.join(", ")}.`
					: `To ask AI training crawlers to stay away, turn on "Disallow AI training" in EmDash's SEO settings. This robots.txt includes its lines while it's on.`}{" "}
				To block them outright, use your Cloudflare zone's AI bot policies (Training: Block); robots.txt only asks.
			</p>
			{on && own.length > 0 && (
				<p className="text-sm">
					{own.length === 1 ? `Your rule “${own[0].name}” repeats` : `${own.length} of your rules repeat`} what EmDash's setting adds. You can delete {own.length === 1 ? "it" : "them"} unless {own.length === 1 ? "it names" : "they name"} crawlers you want to keep blocked.
				</p>
			)}
			{on && allowed.length > 0 && (
				<p className="text-sm">
					{allowed.map((r) => `“${r.name}”`).join(", ")} {allowed.length === 1 ? "lets" : "let"} some of these crawlers in anyway: an Allow for the whole site wins over EmDash's Disallow.
				</p>
			)}
			<a className="text-sm font-medium text-kumo-link underline" href="/_emdash/admin/settings/seo">
				Open SEO settings
			</a>
		</section>
	);
}

/** Lines added automatically so crawlers can always read discovery files (/.well-known/, llms.txt…). */
function AutomaticLines(props: { config: RobotsConfig }) {
	const resolved = resolveAgents(props.config);
	const byValue = new Map<string, string[]>();
	for (const [k, entry] of resolved) {
		for (const l of entry.lines.filter((x) => x.auto)) byValue.set(l.value, [...(byValue.get(l.value) ?? []), k === "*" ? "all other crawlers" : entry.token]);
	}
	if (!byValue.size) return null;
	return (
		<section className="space-y-2 rounded-lg border border-kumo-line p-4" aria-labelledby="robots-auto">
			<h2 id="robots-auto" className="flex items-center gap-2 text-base font-semibold">
				Automatic <Badge variant="secondary">{byValue.size}</Badge>
			</h2>
			<p className="text-sm text-kumo-subtle">
				Added so crawlers you've blocked can still read your discovery files ({[...byValue.keys()].join(", ")}), which tell AI agents and other tools about your site
				{props.config.automatic?.llms ? "; llms.txt is included because Discovery's llms.txt is on" : ""}. Change this under Settings and history.
			</p>
			<ul className="space-y-1 text-xs">
				{[...byValue].map(([value, who]) => (
					<li key={value}>
						<code>Allow: {value}</code> <span className="text-kumo-subtle">for {who.length > 4 ? `${who.slice(0, 3).join(", ")} and ${who.length - 3} more` : who.join(", ")}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function RulesList(props: {
	config: RobotsConfig;
	bots: BotEntry[];
	busy: boolean;
	onEdit: (rule: RobotsRule) => void;
	onToggle: (rule: RobotsRule, on: boolean) => void;
	onDelete: (rule: RobotsRule) => void;
	onDuplicate: (rule: RobotsRule) => void;
	onAdd: () => void;
}) {
	const byToken = tokenIndex(props.bots);
	const nameOf = (t: string) => byToken.get(t.toLowerCase())?.name ?? t;
	if (!props.config.rules.length) {
		return (
			<div className="rounded-lg border py-10 text-center text-kumo-subtle">
				<Robot size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
				<p className="text-base font-medium">No rules</p>
				<p className="mt-1 text-sm">Every crawler can crawl everything{props.config.emdashLines ? " except EmDash's admin" : ""}.</p>
				<div className="mt-3">
					<Button variant="primary" icon={<Plus />} onClick={props.onAdd}>
						Add a rule
					</Button>
				</div>
			</div>
		);
	}
	return (
		<ul className="rounded-lg border">
			{props.config.rules.map((rule) => {
				const sentence = capital(describeRule(rule, nameOf));
				const lines = (() => {
					try {
						return directives(rule);
					} catch {
						return [];
					}
				})();
				const unverified = rule.agents.filter((a) => byToken.get(a.toLowerCase())?.status === "unverified");
				return (
					<li key={rule.id} className={`flex items-start gap-3 border-b px-4 py-3 text-sm last:border-0 ${rule.enabled ? "" : "opacity-60"}`}>
						<Switch size="sm" aria-label={`${rule.name}: ${rule.enabled ? "on" : "off"}`} checked={rule.enabled} disabled={props.busy} onCheckedChange={(on) => props.onToggle(rule, on)} />
						<div className="min-w-0 flex-1">
							<div className="font-medium">{rule.name || sentence}</div>
							{rule.name && rule.name !== sentence && <div className="text-xs">{sentence}</div>}
							{rule.description && <div className="text-xs text-kumo-subtle">{rule.description}</div>}
							<div className="mt-1 flex flex-wrap items-center gap-1">
								<Badge variant={rule.directive === "allow" && rule.kind !== "allow_exception" ? "secondary" : "outline"}>{rule.directive === "allow" && rule.kind !== "allow_exception" ? "Allow" : "Block"}</Badge>
								{rule.agents.includes("*") ? <Badge variant="secondary">all crawlers</Badge> : <Badge variant="secondary">{rule.agents.length} crawler{rule.agents.length === 1 ? "" : "s"}</Badge>}
								{unverified.length > 0 && (
									<span title={`Unverified tokens: ${unverified.join(", ")}`}>
										<Badge variant="warning">{unverified.length} unverified</Badge>
									</span>
								)}
								{!rule.enabled && <Badge variant="outline">off</Badge>}
							</div>
							<details className="mt-1">
								<summary className="cursor-pointer text-xs text-kumo-subtle">robots.txt lines</summary>
								<code className="block text-xs text-kumo-subtle">
									{lines.map((d) => `${d.directive}: ${d.value}`).join(" · ")} — for {rule.agents.includes("*") ? "*" : rule.agents.slice(0, 6).join(", ")}
									{rule.agents.length > 6 ? ` +${rule.agents.length - 6} more` : ""}
								</code>
							</details>
						</div>
						<DropdownMenu>
							<DropdownMenu.Trigger render={<Button type="button" variant="ghost" shape="square" icon={<DotsThree aria-hidden="true" />} aria-label={`Actions for ${rule.name}`} />} />
							<DropdownMenu.Content className="p-1">
								<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<PencilSimple className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => props.onEdit(rule)}>
									Edit
								</DropdownMenu.Item>
								<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<Plus className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => props.onDuplicate(rule)}>
									Duplicate and edit
								</DropdownMenu.Item>
								<DropdownMenu.Separator className="my-0.5" />
								<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<Trash className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => props.onDelete(rule)}>
									Delete
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu>
					</li>
				);
			})}
		</ul>
	);
}

function SettingsTab(props: {
	data: PageData;
	config: RobotsConfig;
	onSave: (config: RobotsConfig, label: string) => Promise<void>;
	onRestore: (item: HistoryItem) => void;
	onReset: () => void;
	onImport: (config: RobotsConfig, filename: string) => void;
}) {
	const fileRef = React.useRef<HTMLInputElement>(null);
	const [fileError, setFileError] = React.useState<string>();
	const [draft, setDraft] = React.useState(props.config);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => setDraft(props.config), [props.config]);
	const dirty = isDirty(draft, props.config);
	const update = (p: Partial<RobotsConfig>) => setDraft((d) => ({ ...d, ...p }));
	const problem = dirty ? checkConfig(draft, props.data.siteUrl || undefined) : null;
	const risks = dirty ? analyzeConfigChange(props.config, draft, props.data.siteUrl || undefined) : [];
	const [ack, setAck] = React.useState(false);
	React.useEffect(() => setAck(false), [draft]);
	const canSave = !problem && (risks.length === 0 || ack);
	const save = async () => {
		if (!dirty || !canSave) return;
		setSaving(true);
		setError(undefined);
		try {
			await props.onSave(draft, "Changed settings");
		} catch (cause) {
			setError(errorText(cause, "Could not save"));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-6">
			<section className="space-y-3" aria-labelledby="robots-settings">
				<h2 id="robots-settings" className="text-base font-semibold">
					Settings
				</h2>
				<Checkbox
					label={`Keep EmDash's admin private (Disallow: /_emdash/ for every crawler)`}
					checked={draft.emdashLines}
					onCheckedChange={(on: boolean) => update({ emdashLines: on })}
				/>
				<Checkbox
					label="Keep media crawlable (Allow: /_emdash/api/media/, so your images can appear in image search)"
					checked={draft.allowMedia}
					onCheckedChange={(on: boolean) => update({ allowMedia: on })}
				/>
				<Checkbox
					label="Crawlers named in a rule also keep the rules for all crawlers (recommended)"
					checked={draft.inheritGeneral}
					onCheckedChange={(on: boolean) => update({ inheritGeneral: on })}
				/>
				<p className="-mt-2 cw-ps-6 text-xs text-kumo-subtle">
					In robots.txt, a crawler that's named anywhere ignores every rule for “all crawlers” (RFC 9309). With this on, Coywolf Pack copies those rules into its group, except where its own
					rules say otherwise.
				</p>
				<Checkbox
					label="Keep discovery files readable for every crawler (/.well-known/, and llms.txt while Discovery's llms.txt is on)"
					checked={draft.discoveryAllowances}
					onCheckedChange={(on: boolean) => update({ discoveryAllowances: on })}
				/>
				{draft.discoveryAllowances && (
					<InputArea
						label="More discovery paths to keep readable (one per line)"
						rows={2}
						placeholder="/agents.json"
						value={draft.discoveryPaths.join("\n")}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => update({ discoveryPaths: e.target.value.split("\n") })}
						className="font-mono text-xs"
					/>
				)}
				<Checkbox label="Write rule names as comments" checked={draft.comments} onCheckedChange={(on: boolean) => update({ comments: on })} />
				<InputArea
					label="More sitemaps (one URL or path per line)"
					rows={3}
					value={draft.sitemaps.join("\n")}
					onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => update({ sitemaps: e.target.value.split("\n") })}
					className="font-mono text-xs"
				/>
				<InputArea
					label="Extra lines (added as written, e.g. Content-Signal or Crawl-delay; for experts)"
					rows={5}
					value={draft.extra}
					onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => update({ extra: e.target.value })}
					className="font-mono text-xs"
				/>
				<div aria-live="polite" className="space-y-2">
					{problem && <Banner variant="error" role="alert" description={problem} />}
					{!problem && risks.length > 0 && (
						<>
							<ul className="space-y-1">
								{risks.map((f, i) => (
									<li key={`${f.code}-${i}`} className="flex items-start gap-2 text-sm">
										<Warning className="mt-0.5 shrink-0 text-kumo-warning" aria-hidden="true" />
										{f.message}
									</li>
								))}
							</ul>
							<Checkbox label="I understand. Save anyway." checked={ack} onCheckedChange={(on: boolean) => setAck(on)} />
						</>
					)}
				</div>
				{error && <Banner variant="error" role="alert" description={error} />}
			</section>

			<section className="space-y-2" aria-labelledby="robots-transfer">
				<h2 id="robots-transfer" className="text-base font-semibold">
					Export and import
				</h2>
				<p className="text-sm text-kumo-subtle">
					Save your rules and settings as a file to keep a copy or move them to another site. Importing a file replaces the current rules and settings; the current version stays in Version
					history.
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="secondary"
						icon={<DownloadSimple />}
						onClick={() => saveFile(exportRobotsRules(props.config, props.data.siteUrl || undefined), `robots-rules-${siteSlug() || "site"}-${today()}.json`, "application/json")}
					>
						Export rules
					</Button>
					<Button variant="secondary" icon={<FileArrowUp />} onClick={() => fileRef.current?.click()}>
						Import rules…
					</Button>
					<input
						ref={fileRef}
						type="file"
						accept=".json,application/json"
						className="sr-only"
						tabIndex={-1}
						aria-hidden="true"
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (!file) return;
							setFileError(undefined);
							file
								.text()
								.then((text) => props.onImport(readRobotsImport(text), file.name))
								.catch((cause) => setFileError(errorText(cause, "Could not read that file.")));
						}}
					/>
				</div>
				{fileError && <Banner variant="error" role="alert" description={fileError} />}
			</section>

			<section className="space-y-2" aria-labelledby="robots-history">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 id="robots-history" className="text-base font-semibold">
						Version history
					</h2>
					<Button variant="secondary" onClick={props.onReset}>
						Reset to EmDash's original
					</Button>
				</div>
				<p className="text-sm text-kumo-subtle">The last 20 saved versions. Restoring one saves it as a new version, so you can always go back.</p>
				{props.data.history.length === 0 ? (
					<p className="text-sm text-kumo-subtle">No versions yet.</p>
				) : (
					<ul className="rounded-lg border">
						{props.data.history.map((h, i) => (
							<li key={h.id} className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm last:border-0">
								<div className="min-w-0 flex-1">
									<div className="font-medium">
										{h.label} {i === 0 && <Badge variant="secondary">current</Badge>}
									</div>
									<div className="text-xs text-kumo-subtle">
										{dateTimeFormat.format(new Date(h.at))}
										{h.by ? ` · ${h.by}` : ""} · {h.rules} rule{h.rules === 1 ? "" : "s"}
									</div>
								</div>
								{i > 0 && (
									<Button variant="secondary" size="sm" onClick={() => props.onRestore(h)}>
										Restore
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
			</section>

			<SaveBar
				dirty={dirty}
				saving={saving}
				canSave={canSave}
				detail={problem ? "Fix the problem above to save" : !canSave ? "Confirm the warnings above to save" : undefined}
				onSave={() => void save()}
				onDiscard={() => setDraft(props.config)}
			/>
		</div>
	);
}

export function RobotsPage() {
	const [data, setData] = React.useState<PageData>();
	const [bots, setBots] = React.useState<BotEntry[]>([]);
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const [tab, setTab] = React.useState("rules");
	const [busy, setBusy] = React.useState(false);
	const [wizard, setWizard] = React.useState<{ rule: RobotsRule | null; id: string } | null>(null);
	const [confirm, setConfirm] = React.useState<Confirm | null>(null);

	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			const [page, directory] = await Promise.all([get<PageData>("get", "Could not load robots.txt rules"), get<{ bots: BotEntry[] }>("bots", "Could not load the crawler directory")]);
			setData(page);
			setBots(directory.bots);
		} catch (cause) {
			setError(errorText(cause, "Could not load robots.txt rules"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const config = data?.config;
	const summary = React.useMemo(() => (config && data ? summarize(config, data.siteUrl, bots) : []), [config, data, bots]);

	/** Save a whole config (the server re-checks it), then refresh history. */
	const persist = async (next: RobotsConfig, label: string, message?: string) => {
		setBusy(true);
		try {
			const result = await post<{ config: RobotsConfig; preview: string; warnings: Finding[] }>("save", { config: next, label });
			const page = await get<PageData>("get", "Could not reload");
			setData({ ...page, config: result.config, preview: result.preview, warnings: result.warnings ?? [] });
			setNotice(message ?? "Saved. /robots.txt now serves this version (other Worker instances pick it up within a minute).");
			setError(undefined);
		} finally {
			setBusy(false);
		}
	};

	if (!data || !config) {
		return error ? (
			<Banner variant="error" role="alert" title="Something went wrong" description={error} />
		) : (
			<div className="py-12 text-center text-kumo-subtle">
				<Loader />
			</div>
		);
	}

	const withRule = (rule: RobotsRule, patch?: Partial<RobotsConfig>): RobotsConfig => ({
		...config,
		...patch,
		rules: config.rules.some((r) => r.id === rule.id) ? config.rules.map((r) => (r.id === rule.id ? rule : r)) : [...config.rules, rule],
	});

	const applyTemplate = (id: string) => {
		const t = TEMPLATES.find((x) => x.id === id);
		if (!t) return;
		const next: RobotsConfig = { ...config, rules: t.rules(bots).map((r) => ({ ...r, id: newId() })) };
		const problem = checkConfig(next, data.siteUrl || undefined);
		setConfirm({
			title: `Use “${t.name}”?`,
			body: `${t.description} This replaces your ${config.rules.length} rule${config.rules.length === 1 ? "" : "s"}; the current version stays in Version history.${problem ? ` It can't be used: ${problem}` : ""}`,
			findings: analyzeConfigChange(config, next, data.siteUrl || undefined),
			confirmLabel: "Use this template",
			onConfirm: async () => {
				if (problem) throw new Error(problem);
				await persist(next, `Template: ${t.name}`, `Applied “${t.name}”.`);
			},
		});
	};

	const addCustomBot = (token: string) => {
		if (bots.some((b) => b.token.toLowerCase() === token.toLowerCase())) return;
		void post<{ bots: BotEntry[] }>("bot", { action: "save-custom", name: token, token, category: "OTHER" })
			.then((r) => setBots(r.bots))
			.catch(() => undefined);
	};

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Robots.txt</h1>
					<div className="flex shrink-0 justify-end gap-2">
						<DropdownMenu>
							<DropdownMenu.Trigger render={<Button variant="secondary" icon={<Sparkle />}>Templates</Button>} />
							<DropdownMenu.Content className="max-w-sm p-1">
								{TEMPLATES.map((t) => (
									<DropdownMenu.Item key={t.id} className="flex-col items-start py-1.5 data-highlighted:bg-kumo-fill" onClick={() => applyTemplate(t.id)}>
										<span className="font-medium">{t.name}</span>
										<span className="text-xs text-kumo-subtle">{t.description}</span>
									</DropdownMenu.Item>
								))}
							</DropdownMenu.Content>
						</DropdownMenu>
						<Button variant="primary" icon={<Plus />} onClick={() => setWizard({ rule: null, id: newId() })}>
							Add rule
						</Button>
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Decide which crawlers can visit which parts of your site, in plain English. Every change is checked before it's saved, and the file below is what crawlers get.
					</p>
				</div>
			</header>

			{data.groupChanges.length > 0 && (
				<Banner
					variant="default"
					title="Crawler presets were updated"
					description={
						<span>
							Presets now include only crawlers whose operators document that purpose, with verified tokens. Rules made from a preset were updated:{" "}
							{data.groupChanges.map((c) => `“${c.ruleName}”: ${c.added.length ? `added ${c.added.join(", ")}` : ""}${c.added.length && c.removed.length ? "; " : ""}${c.removed.length ? `removed ${c.removed.join(", ")}` : ""}`).join(". ")}. The previous
							version is in Version history.
						</span>
					}
				/>
			)}
			{data.warnings.length > 0 && (
				<Banner
					variant="alert"
					title="Check your Extra lines"
					description={
						<ul className="list-disc ps-5">
							{data.warnings.map((w, i) => (
								<li key={`${w.code}-${i}`}>{w.message}</li>
							))}
						</ul>
					}
				/>
			)}
			<div aria-live="polite">{notice && <Banner variant="default" role="status" title={notice} />}</div>
			{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}

			<Tabs
				value={tab}
				onValueChange={setTab}
				tabs={[
					{ value: "rules", label: `Rules (${config.rules.length})` },
					{ value: "bots", label: "Bots" },
					{ value: "settings", label: "Settings and history" },
				]}
			/>

			{tab === "rules" && (
				<div className="space-y-6">
					<section aria-labelledby="robots-summary" className="rounded-lg border border-kumo-line p-4">
						<h2 id="robots-summary" className="text-base font-semibold">
							Rules summary
						</h2>
						<ul className="mt-2 space-y-1 text-sm">
							{summary.map((s) => (
								<li key={s.who} className="flex items-start gap-2">
									{s.tone === "open" ? (
										<CheckCircle className="mt-0.5 shrink-0 text-kumo-success" aria-hidden="true" />
									) : s.tone === "closed" ? (
										<XCircle className="mt-0.5 shrink-0 text-kumo-danger" aria-hidden="true" />
									) : (
										<Warning className="mt-0.5 shrink-0 text-kumo-warning" aria-hidden="true" />
									)}
									<span>
										<strong>{s.who}</strong> {s.text}.
									</span>
								</li>
							))}
						</ul>
						{config.emdashLines && <p className="mt-2 text-xs text-kumo-subtle">EmDash's admin and API always stay private.</p>}
					</section>
					<SitemapOption
						config={config}
						siteUrl={data.siteUrl}
						busy={busy}
						noteDismissed={data.sitemapNoteDismissed}
						onChange={(on) => void persist({ ...config, includeSitemap: on }, on ? "Listed the sitemap" : "Stopped listing the sitemap", on ? "The sitemap is listed in robots.txt." : "The sitemap is no longer listed.").catch((cause) => setError(errorText(cause, "Could not save")))}
						onDismiss={() => {
							setData((d) => (d ? { ...d, sitemapNoteDismissed: true } : d));
							void post("dismiss-sitemap-note", {}).catch(() => undefined);
						}}
					/>
					<section className="space-y-2" aria-labelledby="robots-rules">
						<h2 id="robots-rules" className="sr-only">
							Rules
						</h2>
						<RulesList
							config={config}
							bots={bots}
							busy={busy}
							onAdd={() => setWizard({ rule: null, id: newId() })}
							onEdit={(rule) => setWizard({ rule, id: rule.id })}
							onDuplicate={(rule) => setWizard({ rule: { ...rule, id: newId(), name: `${rule.name} (copy)` }, id: "" })}
							onToggle={(rule, on) => {
								const next = withRule({ ...rule, enabled: on });
								void persist(next, `${on ? "Turned on" : "Turned off"}: ${rule.name}`, `“${rule.name}” is ${on ? "on" : "off"}.`).catch((cause) => setError(errorText(cause, "Could not save")));
							}}
							onDelete={(rule) =>
								setConfirm({
									title: `Delete “${rule.name}”?`,
									body: "Crawlers stop following it as soon as it's deleted. You can restore it from Version history.",
									findings: analyzeConfigChange(config, { ...config, rules: config.rules.filter((r) => r.id !== rule.id) }, data.siteUrl || undefined),
									confirmLabel: "Delete rule",
									destructive: true,
									onConfirm: () => persist({ ...config, rules: config.rules.filter((r) => r.id !== rule.id) }, `Deleted: ${rule.name}`, `Deleted “${rule.name}”.`),
								})
							}
						/>
						{config.rules.length > 1 && (
							<p className="text-xs text-kumo-subtle">
								Order doesn't matter: crawlers follow the most specific matching line, whatever its position. Coywolf Pack writes the most specific lines first anyway, so older crawlers that read top to
								bottom agree.
							</p>
						)}
					</section>
					<AutomaticLines config={config} />
					<AiTraining config={config} />
					<Tester robotsTxt={data.preview} bots={bots} siteUrl={data.siteUrl} />
					<ServedFile text={data.preview} emdash={data.emdash} config={config} siteUrl={data.siteUrl} />
				</div>
			)}

			{tab === "bots" && (
				<BotsTab
					bots={bots}
					rules={config.rules}
					radar={data.radar}
					onBots={setBots}
					onRadar={(r) => setData((d) => (d ? { ...d, radar: { ...d.radar, ...r } } : d))}
					onReload={load}
				/>
			)}

			{tab === "settings" && (
				<SettingsTab
					data={data}
					config={config}
					onSave={(next, label) => persist(next, label)}
					onRestore={(item) =>
						setConfirm({
							title: "Restore this version?",
							body: `“${item.label}” from ${dateTimeFormat.format(new Date(item.at))} (${item.rules} rule${item.rules === 1 ? "" : "s"}) replaces the current rules and settings. The current version stays in history.`,
							confirmLabel: "Restore",
							onConfirm: async () => {
								setBusy(true);
								try {
									await post("restore", { id: item.id });
									await load();
									setNotice("Restored. /robots.txt now serves that version.");
								} finally {
									setBusy(false);
								}
							},
						})
					}
					onImport={(next, filename) => {
						const problem = checkConfig(next, data.siteUrl || undefined);
						setConfirm({
							title: "Import these rules?",
							body: `${filename} has ${next.rules.length} rule${next.rules.length === 1 ? "" : "s"}. They replace your ${config.rules.length} rule${config.rules.length === 1 ? "" : "s"} and the settings above; the current version stays in Version history.${problem ? ` It can't be used: ${problem}` : ""}`,
							findings: analyzeConfigChange(config, next, data.siteUrl || undefined),
							confirmLabel: "Import",
							onConfirm: async () => {
								if (problem) throw new Error(problem);
								await persist(next, `Imported from ${filename}`.slice(0, 200), "Imported. /robots.txt now serves the imported rules.");
							},
						});
					}}
					onReset={() =>
						setConfirm({
							title: "Reset to EmDash's original?",
							body: "Replaces your rules with ones converted from EmDash's own robots.txt (shown under What's being served), plus the media rule. The current version stays in history.",
							confirmLabel: "Reset",
							destructive: true,
							onConfirm: async () => {
								await post("reset", {});
								await load();
								setNotice("Reset to EmDash's original robots.txt.");
							},
						})
					}
				/>
			)}

			{wizard && (
				<RuleWizard
					initial={wizard}
					config={config}
					bots={bots}
					siteUrl={data.siteUrl}
					sections={data.sections}
					onClose={() => setWizard(null)}
					onSave={async (rule, patch) => {
						const isNew = !config.rules.some((r) => r.id === rule.id);
						await persist(withRule(rule, patch), `${isNew ? "Added" : "Edited"}: ${rule.name}`, `${isNew ? "Added" : "Saved"} “${rule.name}”.`);
						setWizard(null);
					}}
					onEditRule={(id) => {
						const other = config.rules.find((r) => r.id === id);
						setWizard(other ? { rule: other, id: other.id } : null);
					}}
					onMerge={async (id, agents) => {
						const other = config.rules.find((r) => r.id === id);
						if (!other) return;
						const merged = { ...other, agents: [...new Set([...other.agents, ...agents])], group: undefined };
						await persist(withRule(merged), `Edited: ${other.name}`, `Added the crawlers to “${other.name}”.`);
						setWizard(null);
					}}
					onAddCustomBot={addCustomBot}
				/>
			)}
			<ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
		</div>
	);
}

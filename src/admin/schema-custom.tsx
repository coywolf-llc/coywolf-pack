/**
 * Custom markup on the Schema page: the JSON-LD editor (shared with an
 * entry's override on the Overrides tab) and the Custom tab's path rules.
 * The editor runs the same checks a save does (src/schema/custom.ts), so
 * errors and Google's rich-result warnings show while typing, and previews
 * the contribution as EmDash will print it.
 */
import { Badge, Banner, Button, Dialog, Input, InputArea, Select, Switch } from "@cloudflare/kumo";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import * as React from "react";

import { useConfirm } from "./confirm-dialog.js";
import { apiPost, errorText } from "./api.js";
import {
	type CustomMarkup,
	type LintWarning,
	type PathRule,
	type TrailingSlash,
	checkMarkup,
	customOutput,
	normalizeRulePath,
	pathContributionId,
	pathRuleConflicts,
	scriptJson,
} from "../schema/custom.js";
import { MARKUP_TEMPLATES, templateText } from "../schema/custom-templates.js";

const API = "/_emdash/api/plugins/coywolf-pack/schema";

const post = apiPost(API);

/** What the Schema page's config says about custom markup. */
export interface CustomSite {
	rules: PathRule[];
	origin: string;
	trailingSlash: TrailingSlash;
	publisherId: string;
}

/** The checks a save runs, for markup on a page at `pageUrl`. */
export function useMarkupCheck(value: CustomMarkup, site: CustomSite, graphOn: boolean, pageUrl: string) {
	return React.useMemo(
		() => checkMarkup(value.markup, { origin: site.origin, base: pageUrl, reserved: [site.publisherId], graph: graphOn }),
		[value.markup, site.origin, site.publisherId, graphOn, pageUrl],
	);
}

export function WarningList(props: { warnings: LintWarning[] }) {
	if (!props.warnings.length) return null;
	const problems = props.warnings.filter((w) => !w.note);
	const notes = props.warnings.filter((w) => w.note);
	return (
		<div className="space-y-2">
			<h3 className="text-sm font-medium">
				Rich-result checks{problems.length ? ` (${problems.length} to look at)` : ""}
			</h3>
			<ul className="space-y-1 text-sm">
				{[...problems, ...notes].map((w) => (
					<li key={`${w.at}\n${w.message}`} className={w.note ? "text-kumo-subtle" : undefined}>
						<span className="font-mono text-xs">{w.at}</span>: {w.message}
					</li>
				))}
			</ul>
			<p className="text-xs text-kumo-subtle">Warnings don't stop a save. Check the live page with Google's Rich Results Test too.</p>
		</div>
	);
}

/**
 * The JSON-LD editor: a template picker, the markup, its switches, the
 * checks, and the contribution as it will print (`contributionId`, with the
 * pack's ids for #website, #organization and #webpage when the graph is on).
 */
export function MarkupEditor(props: {
	value: CustomMarkup;
	onChange: (value: CustomMarkup) => void;
	site: CustomSite;
	graphOn: boolean;
	/** The page the markup is for (relative @ids resolve against it). */
	pageUrl: string;
	contributionId: string;
}) {
	const [confirm, confirmDialog] = useConfirm();
	const { value, onChange } = props;
	const [template, setTemplate] = React.useState("Service");
	const check = useMarkupCheck(value, props.site, props.graphOn, props.pageUrl);
	const preview = React.useMemo(() => {
		if (check.errors.length || !check.nodes.length) return null;
		const graph = props.graphOn ? [{ "@id": `${props.site.origin}/#website` }, { "@id": props.site.publisherId }, { "@id": `${props.pageUrl}#webpage` }] : null;
		const output = customOutput({ contributionId: props.contributionId, label: "", nodes: check.nodes, mainEntity: !!value.mainEntity }, { pageUrl: props.pageUrl, graph, publisherId: props.site.publisherId });
		return output ? `<script type="application/ld+json">\n${scriptJson(output.contribution.graph, "\t")}\n</script>` : null;
	}, [check, props.graphOn, props.site, props.pageUrl, props.contributionId, value.mainEntity]);

	const insert = async () => {
		if (value.markup.trim() && !(await confirm({ title: "Replace the markup with the template?", description: "What's in the editor now is replaced.", confirmLabel: "Replace" }))) return;
		onChange({ ...value, markup: templateText(template) });
	};

	return (
		<div className="space-y-4">
			{confirmDialog}
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<div className="sm:w-64">
					<Select
						label="Start from a template"
						value={template}
						onValueChange={(v: string | null) => setTemplate(v ?? "Service")}
						items={Object.entries(MARKUP_TEMPLATES).map(([key, t]) => ({ value: key, label: t.label }))}
					/>
				</div>
				<Button variant="secondary" onClick={insert}>
					Insert
				</Button>
			</div>
			<p className="text-xs text-kumo-subtle">{MARKUP_TEMPLATES[template]?.hint}</p>
			<InputArea
				label="JSON-LD"
				rows={16}
				className="font-mono text-xs"
				spellCheck={false}
				value={value.markup}
				placeholder='{ "@type": "Service", "name": "…", "provider": { "@id": "#organization" } }'
				aria-invalid={check.errors.length > 0 || undefined}
				description={`One node, an array of nodes, or { "@graph": [ … ] }. @context is optional. Link to the pack's nodes with {"@id": "#organization"}, "#website" or "#webpage".`}
				onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ ...value, markup: e.target.value })}
			/>
			<Switch label="Add it to the page" checked={value.enabled} onCheckedChange={(checked: boolean) => onChange({ ...value, enabled: checked })} />
			<div className="space-y-1">
				<Switch
					label="Main entity of the page"
					checked={!!value.mainEntity}
					onCheckedChange={(checked: boolean) => onChange({ ...value, mainEntity: checked })}
				/>
				<p className="text-xs text-kumo-subtle">
					{props.graphOn
						? "The page's WebPage points at the first node with mainEntity (it gets an @id if it has none). It replaces a main subject set on the Overrides tab."
						: "Needs the Schema.org graph: while it's off, there's no WebPage to point from, so this is skipped."}
				</p>
			</div>
			{check.errors.length > 0 && value.markup.trim() && (
				<Banner
					variant="error"
					role="alert"
					title="Fix these to save"
					description={
						<ul className="space-y-1">
							{check.errors.map((e) => (
								<li key={e}>{e}</li>
							))}
						</ul>
					}
				/>
			)}
			<WarningList warnings={check.warnings} />
			{preview && (
				<div>
					<h3 className="mb-1 text-sm font-medium">On the page</h3>
					{/* Wrapped: a long line would widen the dialog (Kumo sizes it to its content) to the whole window. */}
					<pre className="max-h-[28rem] cw-overflow-auto cw-pre-wrap rounded bg-kumo-tint p-3 text-xs">{preview}</pre>
					<p className="mt-1 text-xs text-kumo-subtle">
						EmDash adds it to the page head as its own JSON-LD (id {props.contributionId}). The Preview tab shows a page's full output.
					</p>
				</div>
			)}
		</div>
	);
}

// ── Path rules (the Custom tab) ──────────────────────────────────

type Draft = Omit<PathRule, "id"> & { id?: string };

const EMPTY_RULE: Draft = { label: "", path: "/", markup: "", enabled: true, mainEntity: false };

function RuleDialog(props: {
	draft: Draft | null;
	rules: PathRule[];
	site: CustomSite;
	graphOn: boolean;
	customOn: boolean;
	onClose: () => void;
	onSaved: (rules: PathRule[]) => void;
}) {
	const [draft, setDraft] = React.useState<Draft | null>(props.draft);
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState<string>();
	React.useEffect(() => {
		setDraft(props.draft);
		setError(undefined);
	}, [props.draft]);

	const normalized = draft ? normalizeRulePath(draft.path, props.site.trailingSlash) : null;
	const path = normalized && "path" in normalized ? normalized.path : null;
	const pageUrl = `${props.site.origin}${path ?? "/"}`;
	const check = useMarkupCheck(draft ?? EMPTY_RULE, props.site, props.graphOn, pageUrl);
	const conflicts =
		draft && path ? pathRuleConflicts([...props.rules.filter((r) => r.id !== draft.id), { id: draft.id ?? "new", label: draft.label || path, path, enabled: draft.enabled }]) : [];
	const canSave = Boolean(draft && path && !check.errors.length && !conflicts.length && props.customOn && !pending);

	const save = async () => {
		if (!draft || !path) return;
		setPending(true);
		setError(undefined);
		try {
			const result = await post<{ rules: PathRule[] }>("custom/save", { rule: { ...draft, path } });
			props.onSaved(result.rules);
		} catch (cause) {
			setError(errorText(cause, "Could not save the rule"));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog.Root open={props.draft !== null} onOpenChange={(open) => !open && !pending && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{draft?.id ? "Edit custom markup" : "New custom markup"}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">JSON-LD for one page on this site, matched by its path.</Dialog.Description>
				{draft && (
					// Kumo's dialog doesn't scroll: the editor is taller than many screens.
					<div className="cw-dialog-scroll mt-4 space-y-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<Input label="Name" placeholder="Recollect app" value={draft.label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, label: e.target.value })} />
							<div>
								<Input label="Path" placeholder="/" value={draft.path} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, path: e.target.value })} />
								<p className="mt-1 text-xs text-kumo-subtle">
									{normalized && "error" in normalized
										? normalized.error
										: path === "/"
											? "The home page."
											: `Exactly ${path}, without a query string. For an entry, add markup to its override instead (it follows the entry if its slug changes).`}
								</p>
							</div>
						</div>
						{conflicts.map((c) => (
							<Banner key={c} variant="error" role="alert" description={c} />
						))}
						<MarkupEditor
							value={draft}
							onChange={(value) => setDraft({ ...draft, ...value })}
							site={props.site}
							graphOn={props.graphOn}
							pageUrl={pageUrl}
							contributionId={pathContributionId(draft.id ?? "<new>")}
						/>
						{error && <Banner variant="error" role="alert" description={error} />}
						<div className="flex justify-end gap-2">
							<Button variant="secondary" disabled={pending} onClick={props.onClose}>
								Cancel
							</Button>
							<Button variant="primary" disabled={!canSave} onClick={() => void save()}>
								{pending ? "Saving…" : "Save markup"}
							</Button>
						</div>
					</div>
				)}
			</Dialog>
		</Dialog.Root>
	);
}

export function CustomTab(props: { site: CustomSite; graphOn: boolean; customOn: boolean; onSaved: (rules: PathRule[]) => void }) {
	const [confirm, confirmDialog] = useConfirm();
	const [editing, setEditing] = React.useState<Draft | null>(null);
	const [notice, setNotice] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	const rules = props.site.rules;

	const remove = async (rule: PathRule) => {
		if (!(await confirm({ title: `Remove the custom markup “${rule.label}”?`, description: "Its pages stop getting this markup.", confirmLabel: "Remove" }))) return;
		setError(undefined);
		try {
			const result = await post<{ rules: PathRule[] }>("custom/delete", { id: rule.id });
			props.onSaved(result.rules);
			setNotice("Custom markup removed.");
		} catch (cause) {
			setError(errorText(cause, "Could not remove the markup"));
		}
	};

	return (
		<section className="space-y-4 rounded-lg border border-kumo-line p-4">
			{confirmDialog}
			<div>
				<h2 className="text-base font-semibold">Custom markup</h2>
				<p className="mt-1 text-sm text-kumo-subtle">
					Your own JSON-LD for a page that isn't an entry, like a home page in your site's code. Each one is added to its page as its own
					JSON-LD, next to the pack's graph. For an entry, add markup in its override on the Overrides tab.
				</p>
			</div>
			{!props.customOn && (
				<Banner variant="default" role="status" description="Turn on Custom markup (above, or on the Coywolf Pack page) to save markup and add it to pages." />
			)}
			<div className="flex justify-end">
				<Button variant="primary" icon={<Plus aria-hidden="true" />} disabled={!props.customOn} onClick={() => setEditing({ ...EMPTY_RULE })}>
					New custom markup
				</Button>
			</div>
			<div aria-live="polite">{notice && <Banner variant="default" role="status" title={notice} />}</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			{rules.length === 0 ? (
				<p className="py-6 text-center text-sm text-kumo-subtle">No custom markup yet.</p>
			) : (
				<div className="rounded-lg border">
					{rules.map((rule) => (
						<div key={rule.id} className="flex items-center gap-4 border-b px-4 py-2 text-sm last:border-0">
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{rule.label || rule.path}</div>
								<div className="truncate text-xs text-kumo-subtle">
									<span className="font-mono">{rule.path}</span> · {pathContributionId(rule.id)}
								</div>
							</div>
							<div className="hidden gap-1 sm:flex">
								{!rule.enabled && <Badge variant="outline">Off</Badge>}
								{rule.mainEntity && <Badge variant="secondary">Main entity</Badge>}
							</div>
							<Button
								variant="ghost"
								shape="square"
								icon={<PencilSimple aria-hidden="true" />}
								aria-label={`Edit ${rule.label || rule.path}`}
								onClick={() => setEditing(rule)}
							/>
							<Button
								variant="ghost"
								shape="square"
								icon={<Trash aria-hidden="true" />}
								aria-label={`Remove ${rule.label || rule.path}`}
								onClick={() => void remove(rule)}
							/>
						</div>
					))}
				</div>
			)}
			<RuleDialog
				draft={editing}
				rules={rules}
				site={props.site}
				graphOn={props.graphOn}
				customOn={props.customOn}
				onClose={() => setEditing(null)}
				onSaved={(next) => {
					setEditing(null);
					setNotice("Custom markup saved.");
					props.onSaved(next);
				}}
			/>
		</section>
	);
}

/**
 * The Add/Edit rule dialog: a guided, four-step flow for people who don't
 * know robots.txt.
 *
 *   1. What do you want to do?   Keep crawlers out / Let crawlers in
 *   2. Which part of your site?  Everything · A section · One page · A kind of file ·
 *                                Links with tracking or extra parameters · (Advanced pattern)
 *   3. Which crawlers?           Everyone · Search engines · AI training · AI search and
 *                                assistants · SEO tools · Pick specific bots
 *   4. Review                    Consequences in plain English, "Except…", name, the
 *                                exact lines, Try a URL, checks and the self-check
 *
 * Every step shows a live summary. Checks run on each change against the
 * real matcher; errors block saving, warnings need "Add it anyway".
 */
import { Badge, Banner, Button, Checkbox, Dialog, Input, InputArea } from "@cloudflare/kumo";
import { CheckCircle, Info, Plus, Trash, Warning, XCircle } from "@phosphor-icons/react";
import * as React from "react";

import type { BotEntry } from "../robots/bots.js";
import { describeRule, listPhrase } from "../robots/explain.js";
import { type Area, type Draft, FILE_TYPES, blankDraft, PARAMS, type Who, draftToRule, inferInput, matchExamples, ruleToDraft } from "../robots/guided.js";
import { evaluateParsed, matchRaw, parse } from "../robots/rep.js";
import { CRAWLER_GROUPS, PROBE_AGENT, type RobotsConfig, type RobotsRule, directives, generate, groupTokens, normalizePathInput } from "../robots/rules.js";
import { type Finding, analyzeRule, selfCheck } from "../robots/validate.js";
import { BotPicker } from "./robots-bots.js";

const STEPS = ["What to do", "Which part", "Which crawlers", "Review"];

const AREAS: Array<{ id: Area; label: string; example: string }> = [
	{ id: "everything", label: "Everything", example: "Every page and file on the site" },
	{ id: "section", label: "A section", example: "/recipes/ and everything in it, like /recipes/oats/" },
	{ id: "page", label: "One page", example: "Just /thank-you/" },
	{ id: "files", label: "A kind of file", example: "PDFs, Word documents, images…" },
	{ id: "params", label: "Links with tracking or extra parameters", example: "Like /post/?utm_source=newsletter" },
	{ id: "advanced", label: "Advanced: write a pattern", example: "For experts: * means anything, $ means “ends here”" },
];

const WHO: Array<{ id: Who; label: string; hint: string }> = [
	{ id: "everyone", label: "Everyone", hint: "Every crawler (User-agent: *)." },
	...CRAWLER_GROUPS.map((g) => ({ id: g.id as Who, label: g.label, hint: g.description })),
	{ id: "specific", label: "Pick specific bots", hint: "Choose crawlers from the directory, or add one that isn't listed." },
];

const THING: Record<Area, string> = {
	everything: "your site",
	section: "this section",
	page: "this page",
	files: "these files",
	params: "these links",
	advanced: "these addresses",
};

const PROMPTS: Record<Area, string> = {
	everything: "",
	section: "Enter a section address to see what it matches.",
	page: "Enter a page address to see what it matches.",
	files: "Pick a kind of file to see what it matches.",
	params: "Pick a parameter to see what it matches.",
	advanced: "Write a pattern to see what it matches.",
};

/** A preset's members, so people can see exactly who's included. */
function GroupMembers(props: { tokens: string[]; bots: BotEntry[] }) {
	const byToken = new Map(props.bots.map((b) => [b.token.toLowerCase(), b]));
	return (
		<details className="text-xs">
			<summary className="cursor-pointer text-kumo-subtle">
				{props.tokens.length} crawler{props.tokens.length === 1 ? "" : "s"}: show who's included
			</summary>
			<ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
				{props.tokens.map((t) => {
					const b = byToken.get(t.toLowerCase());
					return (
						<li key={t}>
							{b?.name ?? t} <code className="text-kumo-subtle">{t}</code>
							{b?.operator ? <span className="text-kumo-subtle"> · {b.operator}</span> : null}
						</li>
					);
				})}
			</ul>
		</details>
	);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface WizardProps {
	/** The rule being edited, or a new draft id. */
	initial: { rule: RobotsRule | null; id: string } | null;
	config: RobotsConfig;
	bots: BotEntry[];
	siteUrl: string;
	sections: Array<{ label: string; path: string }>;
	onClose: () => void;
	onSave: (rule: RobotsRule, patch?: Partial<RobotsConfig>) => Promise<void>;
	onEditRule: (ruleId: string) => void;
	onMerge: (ruleId: string, agents: string[]) => Promise<void>;
	onAddCustomBot: (token: string) => void;
}

function FindingRow(props: { finding: Finding; onFix?: () => void }) {
	const f = props.finding;
	const Icon = f.severity === "error" ? XCircle : f.severity === "warning" ? Warning : Info;
	const color = f.severity === "error" ? "text-kumo-danger" : f.severity === "warning" ? "text-kumo-warning" : "text-kumo-subtle";
	return (
		<li className="flex items-start gap-2 text-sm">
			<Icon className={`mt-0.5 shrink-0 ${color}`} aria-hidden="true" />
			<span className="min-w-0 flex-1">
				<span className="sr-only">{f.severity === "error" ? "Error: " : f.severity === "warning" ? "Warning: " : "Note: "}</span>
				{f.message}
				{f.fix && props.onFix && (
					<>
						{" "}
						<button type="button" className="font-medium underline" onClick={props.onFix}>
							{f.fix.label}
						</button>
					</>
				)}
			</span>
		</li>
	);
}

function Choice(props: { name: string; value: string; checked: boolean; onSelect: () => void; label: string; hint: string; children?: React.ReactNode }) {
	const id = `cw-${props.name}-${props.value}`;
	return (
		<div className={`rounded-lg border px-3 py-2 ${props.checked ? "border-kumo-brand bg-kumo-tint/40" : "border-kumo-line"}`}>
			<label htmlFor={id} className="flex cursor-pointer items-start gap-2">
				<input id={id} type="radio" name={props.name} value={props.value} className="mt-1" checked={props.checked} onChange={props.onSelect} />
				<span>
					<span className="block text-sm font-medium">{props.label}</span>
					<span className="block text-xs text-kumo-subtle">{props.hint}</span>
				</span>
			</label>
			{props.checked && props.children && <div className="mt-3 space-y-3 cw-ps-6">{props.children}</div>}
		</div>
	);
}

function Chip(props: { on: boolean; onToggle: () => void; children: React.ReactNode }) {
	return (
		<button type="button" aria-pressed={props.on} onClick={props.onToggle} className={`rounded-full border px-3 py-1 text-sm ${props.on ? "border-kumo-brand bg-kumo-tint font-medium" : "border-kumo-line hover:bg-kumo-tint/50"}`}>
			{props.on && <CheckCircle className="me-1 inline" aria-hidden="true" />}
			{props.children}
		</button>
	);
}

export function RuleWizard(props: WizardProps) {
	const startAtReview = Boolean(props.initial?.rule);
	const isEdit = Boolean(props.initial?.rule && props.config.rules.some((r) => r.id === props.initial?.rule?.id));
	const start = React.useMemo(() => {
		if (!props.initial) return null;
		if (props.initial.rule) return ruleToDraft(props.initial.rule);
		return blankDraft(props.initial.id);
	}, [props.initial]);
	const [draft, setDraft] = React.useState<Draft | null>(start);
	const [step, setStep] = React.useState(startAtReview ? 3 : 0);
	const [ack, setAck] = React.useState(false);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const [patch, setPatch] = React.useState<Partial<RobotsConfig>>({});
	const [tryUrl, setTryUrl] = React.useState("");
	const headingRef = React.useRef<HTMLHeadingElement>(null);
	React.useEffect(() => {
		setDraft(start);
		setStep(startAtReview ? 3 : 0);
		setAck(false);
		setError(undefined);
		setPatch({});
		setTryUrl("");
	}, [start, startAtReview]);
	React.useEffect(() => {
		headingRef.current?.focus();
	}, [step]);

	const config = { ...props.config, ...patch };
	const rule = React.useMemo(() => {
		if (!draft) return null;
		const r = draftToRule(draft, props.bots, props.siteUrl);
		const sentence = capital(describeRule({ ...r }, nameOf(props.bots)));
		return { ...r, name: draft.nameTouched && draft.name.trim() ? draft.name.trim() : sentence, description: draft.descriptionTouched ? draft.description.trim() || undefined : undefined };
	}, [draft, props.bots, props.siteUrl]);

	const findings = React.useMemo(() => {
		if (!rule) return [];
		const list = analyzeRule(config, rule, { siteUrl: props.siteUrl, bots: props.bots });
		if (!list.some((f) => f.severity === "error")) {
			const after = { ...config, rules: config.rules.some((r) => r.id === rule.id) ? config.rules.map((r) => (r.id === rule.id ? rule : r)) : [...config.rules, rule] };
			const check = selfCheck(after, props.siteUrl || undefined, 1);
			if (!check.ok) list.push({ code: "self-check", severity: "error", message: `Self-check: ${check.failures[0].reason} This rule can't be saved until that's fixed.` });
		}
		return list;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rule, props.config, patch, props.siteUrl, props.bots]);

	const dirty = JSON.stringify(draft) !== JSON.stringify(start);
	const close = () => {
		if (dirty && !window.confirm(isEdit ? "Discard your changes to this rule?" : "Discard this new rule?")) return;
		props.onClose();
	};

	if (!draft || !rule) return null;
	const set = (p: Partial<Draft>) => {
		setDraft((d) => (d ? { ...d, ...p } : d));
		setAck(false);
		setError(undefined);
	};

	const targetErrors = findings.filter((f) => f.severity === "error" && !["bad-token", "duplicate", "contradiction", "self-check"].includes(f.code));
	const errors = findings.filter((f) => f.severity === "error");
	const warnings = findings.filter((f) => f.severity === "warning");
	const infos = findings.filter((f) => f.severity === "info");
	const agentsChosen = rule.agents.length > 0;
	const canNext = step === 0 || (step === 1 && targetErrors.length === 0 && targetFilled(draft)) || (step === 2 && agentsChosen);
	const canSave = errors.length === 0 && targetFilled(draft) && agentsChosen && (warnings.length === 0 || ack);

	const applyFix = async (f: Finding) => {
		const a = f.fix?.action;
		if (!a) return;
		if (a.type === "addAgents") {
			const current = rule.agents;
			set({ who: "specific", agents: [...new Set([...current, ...a.agents])] });
		} else if (a.type === "turnOnInherit") setPatch((p) => ({ ...p, inheritGeneral: true }));
		else if (a.type === "editRule") {
			if (!dirty || window.confirm("Leave this rule and edit the other one? This rule won't be saved.")) props.onEditRule(a.ruleId);
		} else if (a.type === "mergeInto") {
			setSaving(true);
			try {
				await props.onMerge(a.ruleId, rule.agents);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "Could not merge");
			} finally {
				setSaving(false);
			}
		}
	};

	const save = async () => {
		if (!canSave) return;
		setSaving(true);
		setError(undefined);
		try {
			await props.onSave(rule, Object.keys(patch).length ? patch : undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save the rule");
		} finally {
			setSaving(false);
		}
	};

	const examples = matchExamples(rule);
	const lines = (() => {
		try {
			return directives(rule);
		} catch {
			return [];
		}
	})();

	return (
		<Dialog.Root open onOpenChange={(open) => !open && close()}>
			<Dialog className="flex max-h-[90vh] flex-col p-0" size="xl">
				<div className="border-b border-kumo-line px-6 pt-5 pb-3">
					<Dialog.Title className="text-lg font-semibold">{isEdit ? "Edit rule" : "Add a rule"}</Dialog.Title>
					<Dialog.Description className="sr-only">A guided form in four steps: what to do, which part of the site, which crawlers, and review.</Dialog.Description>
					<ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Steps">
						{STEPS.map((s, i) => (
							<li key={s} aria-current={i === step ? "step" : undefined} className={i === step ? "font-semibold" : "text-kumo-subtle"}>
								{i < step ? (
									<button type="button" className="underline" onClick={() => setStep(i)}>
										{i + 1}. {s}
									</button>
								) : (
									`${i + 1}. ${s}`
								)}
							</li>
						))}
					</ol>
				</div>

				<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
					{step === 0 && (
						<fieldset className="space-y-2">
							<legend>
								<h3 ref={headingRef} tabIndex={-1} className="mb-2 text-base font-semibold outline-none">
									What do you want to do?
								</h3>
							</legend>
							<Choice name="action" value="block" checked={draft.action === "block"} onSelect={() => set({ action: "block" })} label="Keep crawlers out" hint="Stop crawlers from fetching part (or all) of your site, like a members area, drafts, or PDFs." />
							<Choice name="action" value="allow" checked={draft.action === "allow"} onSelect={() => set({ action: "allow" })} label="Let crawlers in" hint="Open up something that another rule blocks, for example one folder for AI crawlers that are otherwise blocked." />
						</fieldset>
					)}

					{step === 1 && <AreaStep draft={draft} set={set} siteUrl={props.siteUrl} sections={props.sections} errors={targetErrors} headingRef={headingRef} />}

					{step === 2 && (
						<fieldset className="space-y-2">
							<legend>
								<h3 ref={headingRef} tabIndex={-1} className="mb-2 text-base font-semibold outline-none">
									Which crawlers?
								</h3>
							</legend>
							{WHO.map((w) => {
								const group = CRAWLER_GROUPS.find((g) => g.id === w.id);
								const count = group ? groupTokens(group, props.bots).length : 0;
								return (
									<Choice key={w.id} name="who" value={w.id} checked={draft.who === w.id} onSelect={() => set({ who: w.id, agents: w.id === "specific" && !draft.agents.length ? [] : draft.agents })} label={group ? `${w.label} (${count})` : w.label} hint={w.hint}>
										{w.id === "specific" ? (
											<BotPicker bots={props.bots} selected={draft.agents} onChange={(agents) => set({ agents })} onAddCustom={props.onAddCustomBot} />
										) : group ? (
											<GroupMembers tokens={groupTokens(group, props.bots)} bots={props.bots} />
										) : null}
									</Choice>
								);
							})}
						</fieldset>
					)}

					{step === 3 && (
						<ReviewStep
							draft={draft}
							rule={rule}
							set={set}
							config={config}
							bots={props.bots}
							siteUrl={props.siteUrl}
							lines={lines}
							headingRef={headingRef}
							tryUrl={tryUrl}
							setTryUrl={setTryUrl}
						/>
					)}

					{step >= 1 && (
						<section className="space-y-2 rounded-lg border border-kumo-line bg-kumo-tint/30 p-3" aria-label="This rule so far" aria-live="polite">
							{targetFilled(draft) && targetErrors.length === 0 ? (
								<p className="text-sm font-medium">{capital(describeRule(rule, nameOf(props.bots)))}.</p>
							) : (
								<p className="text-sm text-kumo-subtle">{PROMPTS[draft.area]}</p>
							)}
							{targetFilled(draft) && targetErrors.length === 0 && (examples.matches.length > 0 || examples.misses.length > 0) && (
								<div className="grid gap-2 text-xs sm:grid-cols-2">
									<div>
										<p className="text-kumo-subtle">Will match</p>
										<ul className="font-mono">{examples.matches.map((m) => <li key={m}>{m}</li>)}</ul>
									</div>
									<div>
										<p className="text-kumo-subtle">Won't match</p>
										<ul className="font-mono">{examples.misses.map((m) => <li key={m}>{m}</li>)}</ul>
									</div>
								</div>
							)}
							{step === 3 && findings.length > 0 && (
								<ul className="space-y-1.5 pt-1">
									{[...errors, ...warnings, ...infos].map((f, i) => (
										<FindingRow key={`${f.code}-${i}`} finding={f} onFix={f.fix ? () => void applyFix(f) : undefined} />
									))}
								</ul>
							)}
							{step === 3 && errors.length === 0 && (
								<p className="flex items-center gap-1.5 text-xs text-kumo-subtle">
									<CheckCircle className="text-kumo-success" aria-hidden="true" /> Self-check passed: the generated robots.txt does exactly what this rule says.
								</p>
							)}
							{step < 3 && findings.some((f) => f.severity !== "info") && (
								<p className="text-xs text-kumo-subtle">
									{errors.length + warnings.length} thing{errors.length + warnings.length === 1 ? "" : "s"} to check on the Review step.
								</p>
							)}
						</section>
					)}
					{patch.inheritGeneral && <Banner variant="default" title="Saving this rule also turns on “Named crawlers keep the rules for all crawlers”." />}
					{step === 3 && warnings.length > 0 && errors.length === 0 && (
						<Checkbox label={`I understand the warning${warnings.length === 1 ? "" : "s"} above. ${isEdit ? "Save" : "Add"} it anyway.`} checked={ack} onCheckedChange={(on: boolean) => setAck(on)} />
					)}
					{error && <Banner variant="error" role="alert" description={error} />}
				</div>

				<div className="flex flex-wrap items-center justify-end gap-2 border-t border-kumo-line px-6 py-3">
					<Button type="button" variant="ghost" onClick={close}>
						Cancel
					</Button>
					{step > 0 && (
						<Button type="button" variant="secondary" onClick={() => setStep((s) => s - 1)}>
							Back
						</Button>
					)}
					{step < 3 ? (
						<Button type="button" variant="primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
							Next
						</Button>
					) : (
						<Button type="button" variant="primary" disabled={!canSave || saving} onClick={() => void save()}>
							{saving ? "Saving…" : isEdit ? "Save changes" : "Add rule"}
						</Button>
					)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

const nameOf = (bots: BotEntry[]) => {
	const map = new Map(bots.map((b) => [b.token.toLowerCase(), b.name]));
	return (token: string) => map.get(token.toLowerCase()) ?? token;
};

function targetFilled(d: Draft): boolean {
	switch (d.area) {
		case "section":
			return Boolean(d.section.trim());
		case "page":
			return Boolean(d.page.trim());
		case "files":
			return d.fileTypes.length > 0 || Boolean(d.otherExt.trim());
		case "params":
			return d.anyQuery || d.params.length > 0 || Boolean(d.otherParam.trim());
		case "advanced":
			return Boolean(d.pattern.trim());
		default:
			return true;
	}
}

function AreaStep(props: {
	draft: Draft;
	set: (p: Partial<Draft>) => void;
	siteUrl: string;
	sections: Array<{ label: string; path: string }>;
	errors: Finding[];
	headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
	const { draft, set } = props;
	const sectionPaths = props.sections.map((s) => s.path);
	const reading = (value: string) => {
		const r = inferInput(value, props.siteUrl, sectionPaths);
		return r;
	};
	const firstError = props.errors[0]?.message;
	const Suggest = (p: { value: string }) => {
		const r = reading(p.value);
		if (!r) return null;
		const label = AREAS.find((a) => a.id === r.area)?.label;
		return (
			<div className="space-y-1 text-xs text-kumo-subtle" aria-live="polite">
				{r.notes.map((n) => (
					<p key={n}>{n}</p>
				))}
				{r.area !== draft.area ? (
					<p>
						{r.message}{" "}
						<button
							type="button"
							className="font-medium underline"
							onClick={() => {
								const patch: Partial<Draft> = { area: r.area };
								if (r.area === "section") patch.section = r.value;
								if (r.area === "page") patch.page = r.value;
								if (r.area === "advanced") patch.pattern = r.value;
								if (r.area === "params") patch.otherParam = r.value;
								if (r.area === "files") patch.otherExt = r.value;
								set(patch);
							}}
						>
							Switch to “{label}”
						</button>
					</p>
				) : (
					<p>{r.message}</p>
				)}
			</div>
		);
	};
	const advancedExplain = (() => {
		const v = draft.pattern.trim();
		if (!v) return null;
		const norm = normalizePathInput(v, props.siteUrl).value;
		const parts: string[] = [];
		parts.push(norm.startsWith("*") ? "Starts anywhere" : `Addresses starting with ${norm.split("*")[0].replace(/\$$/, "")}`);
		if (norm.includes("*")) parts.push("* stands for any characters");
		parts.push(norm.endsWith("$") ? "and they must end exactly there" : "followed by anything");
		return `${parts.join(", ")}.`;
	})();

	return (
		<fieldset className="space-y-2">
			<legend>
				<h3 ref={props.headingRef} tabIndex={-1} className="mb-2 text-base font-semibold outline-none">
					Which part of your site?
				</h3>
			</legend>
			{AREAS.map((a) => (
				<Choice key={a.id} name="area" value={a.id} checked={draft.area === a.id} onSelect={() => set({ area: a.id })} label={a.label} hint={a.example}>
					{a.id === "section" && (
						<>
							<Input
								label="Section address"
								labelTooltip="Paste any address from your site, or type a folder like /recipes/. Everything inside it is included."
								placeholder={`/recipes/ or ${props.siteUrl || "https://example.com"}/recipes/`}
								value={draft.section}
								error={draft.section.trim() ? firstError : undefined}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ section: e.target.value })}
							/>
							{props.sections.length > 0 && (
								<div className="flex flex-wrap items-center gap-1.5 text-xs">
									<span className="text-kumo-subtle">Your sections:</span>
									{props.sections.map((s) => (
										<Chip key={s.path} on={normalizePathInput(draft.section).value.replace(/\/?$/, "/") === s.path} onToggle={() => set({ section: s.path })}>
											{s.label} <span className="font-mono">{s.path}</span>
										</Chip>
									))}
								</div>
							)}
							{draft.section.trim() && <Suggest value={draft.section} />}
							<Checkbox
								label="Also wherever a folder with this name appears deeper in the site (like /en/recipes/)"
								checked={draft.anyDepth}
								onCheckedChange={(on: boolean) => set({ anyDepth: on })}
							/>
						</>
					)}
					{a.id === "page" && (
						<>
							<Input
								label="Page address"
								placeholder={`/thank-you/ or ${props.siteUrl || "https://example.com"}/thank-you/`}
								value={draft.page}
								error={draft.page.trim() ? firstError : undefined}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ page: e.target.value })}
							/>
							{draft.page.trim() && <Suggest value={draft.page} />}
							<Checkbox
								label="Only this exact address (not addresses that continue it, like /thank-you/more or ?page=2)"
								checked={draft.exact}
								onCheckedChange={(on: boolean) => set({ exact: on })}
							/>
						</>
					)}
					{a.id === "files" && (
						<>
							<div className="flex flex-wrap gap-1.5" role="group" aria-label="File types">
								{FILE_TYPES.map((f) => (
									<Chip key={f.id} on={draft.fileTypes.includes(f.id)} onToggle={() => set({ fileTypes: draft.fileTypes.includes(f.id) ? draft.fileTypes.filter((x) => x !== f.id) : [...draft.fileTypes, f.id] })}>
										{f.label}
									</Chip>
								))}
							</div>
							<Input label="Other extensions (optional)" placeholder="key, epub" value={draft.otherExt} error={firstError} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ otherExt: e.target.value })} />
							<Input
								label="Only inside a section (optional)"
								placeholder="/downloads/"
								description="Leave empty for files anywhere on the site."
								value={draft.filesIn}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ filesIn: e.target.value })}
							/>
						</>
					)}
					{a.id === "params" && (
						<>
							<Checkbox label="Any address with a ? (every query string)" checked={draft.anyQuery} onCheckedChange={(on: boolean) => set({ anyQuery: on })} />
							{!draft.anyQuery && (
								<>
									<div className="flex flex-wrap gap-1.5" role="group" aria-label="Common parameters">
										{PARAMS.map((p) => (
											<Chip key={p.id} on={draft.params.includes(p.id)} onToggle={() => set({ params: draft.params.includes(p.id) ? draft.params.filter((x) => x !== p.id) : [...draft.params, p.id] })}>
												{p.label}
											</Chip>
										))}
									</div>
									<Input
										label="A parameter I name (optional)"
										labelTooltip="The part between ? (or &) and =. In /shop?color=red it's color. End with * to cover every name that starts with it."
										placeholder="color, campaign_*"
										value={draft.otherParam}
										error={firstError}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ otherParam: e.target.value })}
									/>
								</>
							)}
						</>
					)}
					{a.id === "advanced" && (
						<>
							<Input
								label="Pattern"
								labelTooltip="Starts with / (a path) or * (anything). * matches any characters; $ at the end means the address must end there. Examples: /tag-* (addresses starting with /tag-), /*preview= (any address containing preview=), /private (also /private-notes), /*/print/ (a print folder below the top level)."
								placeholder="/tag-*"
								value={draft.pattern}
								error={draft.pattern.trim() ? firstError : undefined}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ pattern: e.target.value })}
							/>
							{advancedExplain && <p className="text-xs text-kumo-subtle">{advancedExplain}</p>}
							<p className="text-xs text-kumo-subtle">
								Examples: <code>/tag-*</code> starts with /tag- · <code>/*preview=</code> contains preview= · <code>/private</code> starts with /private (also /private-notes) ·{" "}
								<code>/search$</code> exactly /search
							</p>
						</>
					)}
				</Choice>
			))}
		</fieldset>
	);
}

function ReviewStep(props: {
	draft: Draft;
	rule: RobotsRule;
	set: (p: Partial<Draft>) => void;
	config: RobotsConfig;
	bots: BotEntry[];
	siteUrl: string;
	lines: ReturnType<typeof directives>;
	headingRef: React.RefObject<HTMLHeadingElement | null>;
	tryUrl: string;
	setTryUrl: (v: string) => void;
}) {
	const { draft, rule, set } = props;
	const after = { ...props.config, rules: props.config.rules.some((r) => r.id === rule.id) ? props.config.rules.map((r) => (r.id === rule.id ? rule : r)) : [...props.config.rules, rule] };
	const text = generate(after, { siteUrl: props.siteUrl });
	const parsed = parse(text).directives;
	const sample = matchExamples(rule).matches[0] ?? "/";
	const thing = THING[draft.area];
	const consequences: string[] = [];
	const chosen = new Set(rule.agents.map((a) => a.toLowerCase()));
	for (const g of CRAWLER_GROUPS) {
		const tokens = groupTokens(g, props.bots);
		const blocked = tokens.filter((t) => !evaluateParsed(parsed, [t], sample).allowed).length;
		const name = g.phrase;
		const involved = rule.agents.includes("*") || tokens.some((t) => chosen.has(t.toLowerCase()));
		if (!involved && blocked === 0) continue;
		if (blocked === 0) consequences.push(`${capital(name)} can fetch ${thing}.`);
		else if (blocked === tokens.length) consequences.push(`${tokens.length} ${name} can't fetch ${thing}.`);
		else consequences.push(`${blocked} of ${tokens.length} ${name} can't fetch ${thing}.`);
	}
	const other = evaluateParsed(parsed, [PROBE_AGENT], sample).allowed;
	consequences.push(`Every other crawler ${other ? "can" : "can't"} fetch ${thing}.`);
	const specific = rule.agents.filter((a) => a !== "*" && !CRAWLER_GROUPS.some((g) => groupTokens(g, props.bots).some((t) => t.toLowerCase() === a.toLowerCase())));
	if (specific.length) {
		const blocked = specific.filter((t) => !evaluateParsed(parsed, [t], sample).allowed);
		consequences.unshift(blocked.length ? `${listPhrase(blocked)} can't fetch ${thing}.` : `${listPhrase(specific)} can fetch ${thing}.`);
	}

	const blockLine = props.lines.find((l) => l.directive === "Disallow");
	const exceptionProblem = (value: string) => {
		if (!value.trim() || !blockLine) return undefined;
		const v = normalizePathInput(value, props.siteUrl).value;
		const probe = v.replace(/\$$/, "").replace(/\*/g, "x");
		return matchRaw(blockLine.value, probe) ? undefined : `That isn't inside ${blockLine.value}, so it's already allowed.`;
	};

	const tryVerdict = (() => {
		const u = props.tryUrl.trim();
		if (!u) return null;
		const agents = rule.agents.includes("*") ? [PROBE_AGENT, ...rule.agents.filter((a) => a !== "*")] : rule.agents;
		const yes: string[] = [];
		const no: string[] = [];
		for (const a of agents.slice(0, 200)) (evaluateParsed(parsed, [a], u, { encodePath: true }).allowed ? yes : no).push(a === PROBE_AGENT ? "other crawlers" : a);
		return { yes, no, path: evaluateParsed(parsed, [agents[0]], u, { encodePath: true }).path };
	})();

	return (
		<div className="space-y-4">
			<h3 ref={props.headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
				Review
			</h3>
			<section aria-label="What this rule means">
				<ul className="space-y-1 text-sm">
					{consequences.map((c) => (
						<li key={c}>{c}</li>
					))}
				</ul>
				<p className="mt-1 text-xs text-kumo-subtle">Tested on {sample}, with all your other rules applied.</p>
			</section>

			{draft.action === "block" && (draft.area === "section" || draft.area === "everything" || draft.area === "advanced") && (
				<section className="space-y-2" aria-labelledby="cw-except">
					<h4 id="cw-except" className="text-sm font-medium">
						Except…
					</h4>
					<p className="text-xs text-kumo-subtle">Pages, folders or files inside the blocked area that crawlers may still fetch.</p>
					{draft.except.map((e, i) => (
						<div key={i} className="flex items-end gap-2">
							<div className="flex-1">
								<Input
									label={`Exception ${i + 1}`}
									placeholder={blockLine ? `${blockLine.value === "/" ? "/" : blockLine.value}welcome/` : "/members/welcome/"}
									value={e}
									error={exceptionProblem(e)}
									onChange={(ev: React.ChangeEvent<HTMLInputElement>) => set({ except: draft.except.map((x, j) => (j === i ? ev.target.value : x)) })}
								/>
							</div>
							<Button type="button" variant="ghost" shape="square" icon={<Trash aria-hidden="true" />} aria-label={`Remove exception ${i + 1}`} onClick={() => set({ except: draft.except.filter((_, j) => j !== i) })} />
						</div>
					))}
					<Button type="button" variant="secondary" icon={<Plus />} onClick={() => set({ except: [...draft.except, ""] })}>
						Add an exception
					</Button>
				</section>
			)}

			<section className="grid gap-3 sm:grid-cols-2">
				<Input label="Rule name" value={draft.nameTouched ? draft.name : rule.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ name: e.target.value, nameTouched: true })} description="Shown in your rules list and as a comment in robots.txt." />
				<InputArea label="Note (optional)" rows={2} value={draft.description} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set({ description: e.target.value, descriptionTouched: true })} />
			</section>

			<section className="space-y-2" aria-labelledby="cw-try">
				<h4 id="cw-try" className="text-sm font-medium">
					Try a URL
				</h4>
				<Input label="Address or path" placeholder={`${props.siteUrl || "https://example.com"}${sample}`} value={props.tryUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.setTryUrl(e.target.value)} />
				<div aria-live="polite" className="text-sm">
					{tryVerdict && (
						<p>
							<code>{tryVerdict.path}</code>:{" "}
							{tryVerdict.no.length === 0 ? (
								<span><CheckCircle className="inline text-kumo-success" aria-hidden="true" /> allowed for the chosen crawlers.</span>
							) : tryVerdict.yes.length === 0 ? (
								<span><XCircle className="inline text-kumo-danger" aria-hidden="true" /> blocked for the chosen crawlers.</span>
							) : (
								<span>
									blocked for {listPhrase(tryVerdict.no)}; allowed for {listPhrase(tryVerdict.yes)}.
								</span>
							)}
						</p>
					)}
				</div>
			</section>

			<details className="rounded-lg border border-kumo-line px-3 py-2">
				<summary className="cursor-pointer text-sm font-medium">Show robots.txt lines</summary>
				<p className="mt-2 text-xs text-kumo-subtle">
					This rule writes these lines for {rule.agents.includes("*") ? "every crawler (User-agent: *)" : `${rule.agents.length} crawler${rule.agents.length === 1 ? "" : "s"}`}. Crawlers with identical rules share one
					group in the file.
				</p>
				<pre className="mt-1 overflow-x-auto font-mono text-xs">
					{[...rule.agents.slice(0, 12).map((a) => `User-agent: ${a}`), ...(rule.agents.length > 12 ? [`# …and ${rule.agents.length - 12} more`] : []), ...props.lines.map((l) => `${l.directive}: ${l.value}`)].join("\n")}
				</pre>
				{rule.agents.length > 0 && (
					<p className="mt-1 text-xs">
						<Badge variant="secondary">{rule.agents.length}</Badge> crawler{rule.agents.length === 1 ? "" : "s"}
					</p>
				)}
			</details>
		</div>
	);
}

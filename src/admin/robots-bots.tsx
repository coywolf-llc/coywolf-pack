/**
 * Robots.txt → Bots tab (the crawler directory: filters, verify, rename,
 * add custom bots, Radar sync) and the searchable bot picker used by the
 * rule dialog.
 */
import { Badge, Banner, Button, Dialog, DropdownMenu, Input, InputArea, Select } from "@cloudflare/kumo";
import { ArrowsClockwise, CaretDown, CaretRight, DotsThree, MagnifyingGlass, Plus, XCircle } from "@phosphor-icons/react";
import * as React from "react";

import { type BotEntry, type BotPurpose, CATEGORY_LABELS, PURPOSE_LABELS, categoryLabel } from "../robots/bots.js";
import type { RobotsRule } from "../robots/rules.js";
import { isValidToken } from "../robots/rules.js";
import { EVIDENCE_LABELS, StatusBadge, TriCheckbox, UnverifiedIcon, dateFormat, errorText, post, tokenIndex } from "./robots-shared.js";
import { CredentialGuide } from "./guides.js";
import { SecretField, SetupCard } from "./settings-ui.js";

const catName = (c: string) => CATEGORY_LABELS[c] ?? categoryLabel(c);

/** Unique-by-token bots, verified first. */
function uniqueBots(bots: BotEntry[]): BotEntry[] {
	return [...tokenIndex(bots).values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/**
 * Pick individual crawlers: search, then categories as an accordion with a
 * tick-all checkbox each, plus "a token that isn't listed".
 */
export function BotPicker(props: { bots: BotEntry[]; selected: string[]; onChange: (agents: string[]) => void; onAddCustom?: (token: string) => void }) {
	const [query, setQuery] = React.useState("");
	const [open, setOpen] = React.useState<Set<string>>(new Set());
	const [custom, setCustom] = React.useState("");
	const selected = new Set(props.selected.map((a) => a.toLowerCase()));
	const set = (tokens: string[], on: boolean) => {
		const lower = new Set(tokens.map((t) => t.toLowerCase()));
		const rest = props.selected.filter((a) => !lower.has(a.toLowerCase()));
		props.onChange(on ? [...rest, ...tokens] : rest);
	};
	const q = query.trim().toLowerCase();
	const all = uniqueBots(props.bots).filter((b) => !q || `${b.name} ${b.token} ${b.operator}`.toLowerCase().includes(q));
	const categories = [...new Set(all.map((b) => b.category))].sort((a, b) => catName(a).localeCompare(catName(b)));
	const byToken = tokenIndex(props.bots);
	const customOk = custom.trim() && isValidToken(custom.trim()) && custom.trim() !== "*";
	const customBad = Boolean(custom.trim()) && !customOk;
	const customErrorId = `${React.useId()}-custom-error`;

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-1" aria-live="polite" aria-label="Picked crawlers">
				{props.selected.length === 0 && <span className="text-sm text-kumo-subtle">No crawlers picked yet.</span>}
				{props.selected.map((agent) => {
					const bot = byToken.get(agent.toLowerCase());
					return (
						<button
							key={agent}
							type="button"
							className="inline-flex items-center gap-1 rounded border border-kumo-line px-1.5 py-0.5 text-xs hover:bg-kumo-tint"
							onClick={() => set([agent], false)}
							aria-label={`Remove ${bot?.name ?? agent}`}
						>
							{agent === "*" ? "Everyone (*)" : (bot?.name ?? agent)}
							{bot?.status === "unverified" && <UnverifiedIcon />}
							<XCircle aria-hidden="true" />
						</button>
					);
				})}
			</div>
			<div className="relative">
				<Input
					label="Search crawlers"
					placeholder="Name, token or company, e.g. GPTBot or OpenAI"
					value={query}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
				/>
				<MagnifyingGlass className="pointer-events-none absolute right-3 cw-field-icon text-kumo-subtle" aria-hidden="true" />
			</div>
			<div className="max-h-80 overflow-y-auto rounded border border-kumo-line">
				{categories.map((cat) => {
					const list = all.filter((b) => b.category === cat);
					const on = list.filter((b) => selected.has(b.token.toLowerCase())).length;
					const expanded = Boolean(q) || open.has(cat);
					const panelId = `cw-bots-${cat}`;
					return (
						<div key={cat} className="border-b border-kumo-line last:border-0">
							<div className="flex items-center gap-2 px-3 py-2">
								<TriCheckbox
									checked={on > 0 && on === list.length}
									indeterminate={on > 0 && on < list.length}
									onChange={(v) => set(list.map((b) => b.token), v)}
									label={`All ${catName(cat)} crawlers`}
								/>
								<button
									type="button"
									className="flex flex-1 items-center gap-1 text-left text-sm font-medium"
									aria-expanded={expanded}
									aria-controls={panelId}
									onClick={() => setOpen((s) => (s.has(cat) ? new Set([...s].filter((x) => x !== cat)) : new Set([...s, cat])))}
								>
									{expanded ? <CaretDown aria-hidden="true" /> : <CaretRight aria-hidden="true" />}
									{catName(cat)} <span className="font-normal text-kumo-subtle">({on ? `${on} of ` : ""}{list.length})</span>
								</button>
							</div>
							{expanded && (
								<ul id={panelId} className="pb-2">
									{list.slice(0, 200).map((bot) => (
										<li key={bot.slug}>
											<label className="flex cursor-pointer items-start gap-2 ps-9 pe-9 py-1 text-sm hover:bg-kumo-tint/50">
												<input type="checkbox" className="mt-1" checked={selected.has(bot.token.toLowerCase())} onChange={(e) => set([bot.token], e.target.checked)} />
												<span className="min-w-0 flex-1">
													<span className="flex flex-wrap items-center gap-1.5">
														<span>{bot.name}</span>
														<code className="text-xs text-kumo-subtle">{bot.token}</code>
														<StatusBadge bot={bot} />
													</span>
													{bot.operator && <span className="block text-xs text-kumo-subtle">{bot.operator}</span>}
												</span>
											</label>
										</li>
									))}
								</ul>
							)}
						</div>
					);
				})}
				{categories.length === 0 && <p className="px-3 py-4 text-center text-sm text-kumo-subtle">No crawlers match “{query}”.</p>}
			</div>
			<div className="flex items-end gap-2">
				<div className="flex-1">
					<Input
						label="A crawler that isn't listed (its robots.txt token)"
						placeholder="ExampleBot"
						value={custom}
						aria-invalid={customBad || undefined}
						aria-describedby={customBad ? customErrorId : undefined}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustom(e.target.value)}
						onKeyDown={(e: React.KeyboardEvent) => {
							// The Enter that confirms an input-method candidate isn't "add".
							if (e.nativeEvent.isComposing || e.keyCode === 229) return;
							if (e.key === "Enter" && customOk) {
								e.preventDefault();
								set([custom.trim()], true);
								props.onAddCustom?.(custom.trim());
								setCustom("");
							}
						}}
					/>
				</div>
				<Button
					type="button"
					variant="secondary"
					disabled={!customOk}
					onClick={() => {
						set([custom.trim()], true);
						props.onAddCustom?.(custom.trim());
						setCustom("");
					}}
				>
					Add bot
				</Button>
			</div>
			{customBad && (
				<p id={customErrorId} className="text-sm text-kumo-danger">
					Tokens use letters, digits, dot, dash and underscore, with no spaces.
				</p>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */

type StatusFilter = "all" | "operator-docs" | "user-agent" | "manual" | "unverified" | "custom";

interface RadarInfo {
	tokenConfigured: boolean;
	tokenSource: "settings" | "env" | null;
	state: { at: string; ok: boolean; total?: number; added?: number; updated?: number; error?: string } | null;
	baselineDate: string;
}

function statusOf(b: BotEntry): StatusFilter {
	if (b.origin === "custom" && b.status !== "verified") return "custom";
	if (b.status !== "verified") return "unverified";
	return b.evidence === "manual" ? "manual" : b.evidence === "user-agent" ? "user-agent" : "operator-docs";
}

type BotDialog = { kind: "verify"; bot: BotEntry } | { kind: "rename"; bot: BotEntry } | { kind: "custom"; bot?: BotEntry } | null;

export function BotsTab(props: {
	bots: BotEntry[];
	rules: RobotsRule[];
	radar: RadarInfo;
	onBots: (bots: BotEntry[]) => void;
	onRadar: (radar: Partial<RadarInfo>) => void;
	onReload: () => Promise<void>;
}) {
	const [query, setQuery] = React.useState("");
	const [category, setCategory] = React.useState("all");
	const [operator, setOperator] = React.useState("all");
	const [status, setStatus] = React.useState<StatusFilter>("all");
	const [usedOnly, setUsedOnly] = React.useState(false);
	const [purpose, setPurpose] = React.useState("all");
	const [limit, setLimit] = React.useState(100);
	const [dialog, setDialog] = React.useState<BotDialog>(null);
	const [message, setMessage] = React.useState<string>();
	const [error, setError] = React.useState<string>();

	const usage = React.useMemo(() => {
		const map = new Map<string, RobotsRule[]>();
		for (const r of props.rules) for (const a of r.agents) map.set(a.toLowerCase(), [...(map.get(a.toLowerCase()) ?? []), r]);
		return map;
	}, [props.rules]);
	const categories = [...new Set(props.bots.map((b) => b.category))].sort((a, b) => catName(a).localeCompare(catName(b)));
	const operators = [...new Set(props.bots.map((b) => b.operator).filter(Boolean))].sort((a, b) => a.localeCompare(b));
	const q = query.trim().toLowerCase();
	const visible = props.bots.filter(
		(b) =>
			(category === "all" || b.category === category) &&
			(operator === "all" || b.operator === operator) &&
			(purpose === "all" || (purpose === "none" ? !b.purpose : b.purpose === purpose)) &&
			(status === "all" || statusOf(b) === status) &&
			(!usedOnly || usage.has(b.token.toLowerCase())) &&
			(!q || `${b.name} ${b.token} ${b.operator} ${b.description}`.toLowerCase().includes(q)),
	);

	const act = async (body: Record<string, unknown>, done: string) => {
		setError(undefined);
		try {
			const result = await post<{ bots: BotEntry[] }>("bot", body);
			props.onBots(result.bots);
			setMessage(done);
			setDialog(null);
		} catch (cause) {
			setError(errorText(cause, "That didn't work"));
			throw cause;
		}
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<p className="max-w-2xl text-sm text-kumo-subtle">
					{props.bots.length} crawlers from Cloudflare Radar's bot directory and operators' documentation. A crawler only follows a rule if it uses that exact
					token, so verified tokens (checked against the operator's documentation or published user-agent) are safest.
				</p>
				<Button variant="secondary" icon={<Plus />} onClick={() => setDialog({ kind: "custom" })}>
					Add bot
				</Button>
			</div>
			<div aria-live="polite">{message && <Banner variant="default" role="status" title={message} />}</div>
			{error && !dialog && <Banner variant="error" role="alert" description={error} />}

			<div className="grid gap-2 sm:grid-cols-2 cw-lg-cols-6">
				<div className="lg:col-span-2">
					<Input label="Search" placeholder="Name, token, company or description" value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} />
				</div>
				<Select
					label="Category"
					value={category}
					onValueChange={(v: string | null) => setCategory(v ?? "all")}
					items={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c, label: catName(c) }))]}
				/>
				<Select
					label="Operator"
					value={operator}
					onValueChange={(v: string | null) => setOperator(v ?? "all")}
					items={[{ value: "all", label: "All operators" }, ...operators.map((o) => ({ value: o, label: o }))]}
				/>
				<Select
					label="Purpose"
					value={purpose}
					onValueChange={(v: string | null) => setPurpose(v ?? "all")}
					items={[{ value: "all", label: "Any purpose" }, ...Object.entries(PURPOSE_LABELS).map(([value, label]) => ({ value, label })), { value: "none", label: "Not documented" }]}
				/>
				<Select
					label="Status"
					value={status}
					onValueChange={(v: string | null) => setStatus((v ?? "all") as StatusFilter)}
					items={[
						{ value: "all", label: "Any status" },
						{ value: "operator-docs", label: "Verified: operator docs" },
						{ value: "user-agent", label: "Verified: user-agent" },
						{ value: "manual", label: "Verified on this site" },
						{ value: "unverified", label: "Unverified" },
						{ value: "custom", label: "Added by you" },
					]}
				/>
			</div>
			<label className="flex items-center gap-2 text-sm">
				<input type="checkbox" checked={usedOnly} onChange={(e) => setUsedOnly(e.target.checked)} />
				Only crawlers used in rules
			</label>

			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full text-left text-sm">
					<caption className="sr-only">Crawler directory</caption>
					<thead className="border-b bg-kumo-tint/40 text-xs text-kumo-subtle">
						<tr>
							<th scope="col" className="px-3 py-2 font-medium">Name</th>
							<th scope="col" className="px-3 py-2 font-medium">Token</th>
							<th scope="col" className="cw-md-table-cell px-3 py-2 font-medium">Operator</th>
							<th scope="col" className="cw-md-table-cell px-3 py-2 font-medium">Category and purpose</th>
							<th scope="col" className="px-3 py-2 font-medium">Status</th>
							<th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">Rules</th>
							<th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{visible.slice(0, limit).map((bot) => {
							const used = usage.get(bot.token.toLowerCase()) ?? [];
							return (
								<tr key={bot.slug} className="border-b last:border-0 align-top">
									<td className="px-3 py-2">
										<div className="font-medium">{bot.name}</div>
										{bot.originalName && <div className="text-xs text-kumo-subtle">Listed as {bot.originalName}</div>}
										{bot.delisted && <Badge variant="outline">left Radar</Badge>}
									</td>
									<td className="px-3 py-2"><code className="text-xs">{bot.token}</code></td>
									<td className="cw-md-table-cell px-3 py-2">{bot.operator || "—"}</td>
									<td className="cw-md-table-cell px-3 py-2">
										{catName(bot.category)}
										<div className="text-xs text-kumo-subtle">{bot.purpose ? PURPOSE_LABELS[bot.purpose] : "Purpose not documented"}</div>
									</td>
									<td className="px-3 py-2">
										<StatusBadge bot={bot} evidence={false} />
										<div className="text-xs text-kumo-subtle">
											{EVIDENCE_LABELS[bot.evidence] ?? ""}
											{bot.verifiedAt ? ` · ${dateFormat.format(new Date(bot.verifiedAt.length === 10 ? `${bot.verifiedAt}T12:00:00Z` : bot.verifiedAt))}` : ""}
											{bot.verifiedBy ? ` · ${bot.verifiedBy}` : ""}
										</div>
										{bot.sourceUrl && /^https?:\/\//i.test(bot.sourceUrl) && (
											<a className="text-xs underline" href={bot.sourceUrl} target="_blank" rel="noreferrer noopener">
												Source<span className="sr-only"> for {bot.name}</span>
											</a>
										)}
									</td>
									<td className="hidden px-3 py-2 text-xs lg:table-cell">{used.length ? used.map((r) => r.name).join(", ") : "—"}</td>
									<td className="px-3 py-2 text-right">
										<DropdownMenu>
											<DropdownMenu.Trigger render={<Button type="button" variant="ghost" shape="square" icon={<DotsThree aria-hidden="true" />} aria-label={`Actions for ${bot.name}`} />} />
											<DropdownMenu.Content className="p-1">
												{bot.status !== "verified" && (
													<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" onClick={() => setDialog({ kind: "verify", bot })}>
														Mark verified…
													</DropdownMenu.Item>
												)}
												{bot.evidence === "manual" && (
													<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" onClick={() => void act({ action: "unverify", slug: bot.slug }, `${bot.name} is no longer marked verified.`).catch(() => undefined)}>
														Remove my verification
													</DropdownMenu.Item>
												)}
												{bot.origin === "custom" ? (
													<>
														<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" onClick={() => setDialog({ kind: "custom", bot })}>
															Edit…
														</DropdownMenu.Item>
														<DropdownMenu.Item
															className="py-1 data-highlighted:bg-kumo-fill"
															onClick={() => {
																const inUse = used.length ? ` It's used in ${used.length} rule${used.length === 1 ? "" : "s"}, which keep the token.` : "";
																if (window.confirm(`Delete ${bot.name}?${inUse}`)) void act({ action: "delete", slug: bot.slug }, `${bot.name} deleted.`).catch(() => undefined);
															}}
														>
															Delete
														</DropdownMenu.Item>
													</>
												) : (
													<>
														<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" onClick={() => setDialog({ kind: "rename", bot })}>
															Rename…
														</DropdownMenu.Item>
														{(bot.originalName || bot.evidence === "manual") && (
															<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" onClick={() => void act({ action: "reset", slug: bot.slug }, `${bot.name}: your changes were undone.`).catch(() => undefined)}>
																Undo my changes
															</DropdownMenu.Item>
														)}
													</>
												)}
											</DropdownMenu.Content>
										</DropdownMenu>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
				{visible.length === 0 && <p className="px-3 py-6 text-center text-sm text-kumo-subtle">No crawlers match these filters.</p>}
			</div>
			{visible.length > limit && (
				<Button variant="secondary" onClick={() => setLimit((l) => l + 200)}>
					Show more ({visible.length - limit} left)
				</Button>
			)}

			<RadarCard radar={props.radar} onRadar={props.onRadar} onReload={props.onReload} />

			{dialog && (
				<BotDialogView
					dialog={dialog}
					bots={props.bots}
					error={error}
					onClose={() => {
						setDialog(null);
						setError(undefined);
					}}
					onSubmit={act}
				/>
			)}
		</div>
	);
}

function BotDialogView(props: { dialog: NonNullable<BotDialog>; bots: BotEntry[]; error?: string; onClose: () => void; onSubmit: (body: Record<string, unknown>, done: string) => Promise<void> }) {
	const d = props.dialog;
	const bot = d.bot;
	const [name, setName] = React.useState(bot?.name ?? "");
	const [token, setToken] = React.useState(bot?.token ?? "");
	const [category, setCategory] = React.useState(bot?.category ?? "AI_CRAWLER");
	const [purpose, setPurpose] = React.useState<BotPurpose>(bot?.purpose ?? "other");
	const [operator, setOperator] = React.useState(bot?.operator ?? "");
	const [sourceUrl, setSourceUrl] = React.useState(d.kind === "verify" ? "" : (bot?.sourceUrl ?? ""));
	const [notes, setNotes] = React.useState(d.kind === "custom" ? (bot?.description ?? "") : "");
	const [busy, setBusy] = React.useState(false);
	const urlOk = (u: string) => /^https?:\/\/\S+\.\S+/.test(u.trim());
	const tokenProblem =
		d.kind !== "custom"
			? null
			: !token.trim()
				? "Enter the crawler's robots.txt token."
				: !isValidToken(token.trim()) || token.trim() === "*"
					? "Tokens use letters, digits, dot, dash and underscore, with no spaces (like ExampleBot)."
					: !bot && props.bots.some((b) => b.token.toLowerCase() === token.trim().toLowerCase())
						? `${token.trim()} is already in the directory.`
						: null;
	const problem =
		d.kind === "verify"
			? !urlOk(sourceUrl) ? "Enter the web address of the page that documents this token." : null
			: d.kind === "rename"
				? !name.trim() ? "Enter a name." : null
				: tokenProblem ?? (!name.trim() ? "Enter a name." : sourceUrl.trim() && !urlOk(sourceUrl) ? "The source must be a web address (https://…)." : null);
	const title = d.kind === "verify" ? `Verify ${bot?.name}` : d.kind === "rename" ? `Rename ${bot?.name}` : bot ? `Edit ${bot.name}` : "Add a bot";
	const submit = async () => {
		if (problem) return;
		setBusy(true);
		try {
			if (d.kind === "verify") await props.onSubmit({ action: "verify", slug: bot?.slug, sourceUrl: sourceUrl.trim(), note: notes.trim() || undefined }, `${bot?.name} marked verified.`);
			else if (d.kind === "rename") await props.onSubmit({ action: "rename", slug: bot?.slug, name: name.trim() }, `Renamed to ${name.trim()}. Its token is still ${bot?.token}.`);
			else
				await props.onSubmit(
					{ action: "save-custom", slug: bot?.slug, name: name.trim(), token: token.trim(), category, purpose, operator: operator.trim() || undefined, sourceUrl: sourceUrl.trim(), notes: notes.trim() || undefined },
					bot ? `${name.trim()} saved.` : `${name.trim()} added. Pick it in any rule.`,
				);
		} catch {
			// Shown in the dialog.
		} finally {
			setBusy(false);
		}
	};
	const categories = [...new Set([...Object.keys(CATEGORY_LABELS), ...props.bots.map((b) => b.category)])].sort((a, b) => catName(a).localeCompare(catName(b)));

	return (
		<Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
			<Dialog className="max-h-[90vh] overflow-y-auto p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					{d.kind === "verify"
						? `Confirm that ${bot?.token} is the token ${bot?.operator || "the operator"} documents for robots.txt. We store the source, your note, the date and your name.`
						: d.kind === "rename"
							? `Changes the name shown in this admin only. The robots.txt token stays ${bot?.token}.`
							: "Add a crawler the directory doesn't list. Use the exact token the operator documents for robots.txt."}
				</Dialog.Description>
				<form
					className="mt-4 space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					{(d.kind === "rename" || d.kind === "custom") && <Input label="Name" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />}
					{d.kind === "custom" && (
						<>
							<Input label="robots.txt token" placeholder="ExampleBot" value={token} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value)} />
							<Select label="Category" value={category} onValueChange={(v: string | null) => setCategory(v ?? "OTHER")} items={categories.map((c) => ({ value: c, label: catName(c) }))} />
							<Select
								label="Purpose"
								labelTooltip="What the operator says it's for. Verified bots with a preset's purpose join that preset (for example, AI training)."
								value={purpose}
								onValueChange={(v: string | null) => setPurpose((v ?? "other") as BotPurpose)}
								items={Object.entries(PURPOSE_LABELS).map(([value, label]) => ({ value, label }))}
							/>
							<Input label="Operator (optional)" placeholder="Example Inc." value={operator} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOperator(e.target.value)} />
						</>
					)}
					{(d.kind === "verify" || d.kind === "custom") && (
						<Input
							label={d.kind === "verify" ? "Source (the page that documents the token)" : "Source (optional)"}
							placeholder="https://example.com/docs/crawler"
							value={sourceUrl}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSourceUrl(e.target.value)}
						/>
					)}
					{(d.kind === "verify" || d.kind === "custom") && (
						<InputArea label={d.kind === "verify" ? "Note (optional)" : "Notes (optional)"} rows={2} value={notes} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)} />
					)}
					<p className="min-h-5 text-sm text-kumo-subtle" aria-live="polite">
						{problem && (name || token || sourceUrl) ? problem : ""}
					</p>
					{props.error && <Banner variant="error" role="alert" description={props.error} />}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" onClick={props.onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={Boolean(problem) || busy}>
							{busy ? "Saving…" : d.kind === "verify" ? "Mark verified" : d.kind === "rename" ? "Rename" : bot ? "Save" : "Add bot"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

function RadarCard(props: { radar: RadarInfo; onRadar: (r: Partial<RadarInfo>) => void; onReload: () => Promise<void> }) {
	const [editing, setEditing] = React.useState(false);
	const [syncing, setSyncing] = React.useState(false);
	const [message, setMessage] = React.useState<string>();
	const [error, setError] = React.useState<string>();
	const r = props.radar;
	const refresh = async () => {
		setSyncing(true);
		setError(undefined);
		try {
			const state = await post<NonNullable<RadarInfo["state"]>>("refresh", {});
			if (!state.ok) throw new Error(state.error ?? "Radar sync failed");
			setMessage(`Refreshed from Cloudflare Radar: ${state.total} bots, ${state.added} new, ${state.updated} updated.`);
			await props.onReload();
		} catch (cause) {
			const m = errorText(cause, "Radar sync failed");
			setError(/turned off/i.test(m) ? "Turn on “Weekly crawler list from Cloudflare Radar” on Plugins → Coywolf Pack first." : m);
		} finally {
			setSyncing(false);
		}
	};
	const changed = (source: RadarInfo["tokenSource"], m: string) => {
		props.onRadar({ tokenSource: source, tokenConfigured: Boolean(source) });
		setEditing(false);
		setMessage(m);
	};
	return (
		<section className="space-y-2 rounded-lg border p-4" aria-labelledby="robots-radar">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<h2 id="robots-radar" className="text-base font-semibold">
					Cloudflare Radar sync
				</h2>
				{r.tokenConfigured && (
					<div className="flex flex-wrap gap-2">
						{r.tokenSource === "settings" && !editing && (
							<Button variant="ghost" onClick={() => setEditing(true)}>
								Change token
							</Button>
						)}
						<Button variant="secondary" icon={<ArrowsClockwise />} disabled={syncing} onClick={() => void refresh()}>
							{syncing ? "Refreshing…" : "Refresh from Radar"}
						</Button>
					</div>
				)}
			</div>
			<p className="text-sm text-kumo-subtle">Bundled list from {dateFormat.format(new Date(`${r.baselineDate}T12:00:00Z`))}.</p>
			<div aria-live="polite">{message && <p className="text-sm">{message}</p>}</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			{r.tokenConfigured ? (
				<>
					<p className="text-sm text-kumo-subtle">
						{r.state
							? r.state.ok
								? `Last sync ${dateFormat.format(new Date(r.state.at))}: ${r.state.total} bots, ${r.state.added} new.`
								: `Last sync failed ${dateFormat.format(new Date(r.state.at))}: ${r.state.error}`
							: "Token set; no sync has run yet."}{" "}
						{r.tokenSource === "env" && "Using the RADAR_API_TOKEN Worker secret."} Turn on “Weekly crawler list from Cloudflare Radar” on Plugins → Coywolf Pack to refresh it every week.
					</p>
					{editing && <RadarTokenForm source={r.tokenSource} onChanged={changed} onCancel={() => setEditing(false)} />}
				</>
			) : (
				<SetupCard
					title="Add a Cloudflare Radar API token to keep this list current"
					description="Optional. With a token, Refresh from Radar updates the crawler list now, and the weekly sync (on Plugins → Coywolf Pack) keeps it current. Or set the RADAR_API_TOKEN Worker secret."
				>
					<RadarTokenForm source={r.tokenSource} onChanged={changed} />
				</SetupCard>
			)}
		</section>
	);
}

function RadarTokenForm(props: { source: RadarInfo["tokenSource"]; onChanged: (source: RadarInfo["tokenSource"], message: string) => void; onCancel?: () => void }) {
	const [token, setToken] = React.useState("");
	const [pending, setPending] = React.useState<"save" | "clear">();
	const [error, setError] = React.useState<string>();
	const send = async (body: { token?: string; clear?: boolean }) => {
		setPending(body.clear ? "clear" : "save");
		setError(undefined);
		try {
			const result = await post<{ tokenSource: RadarInfo["tokenSource"] }>("radar-token", body);
			setToken("");
			props.onChanged(result.tokenSource, body.clear ? "Radar token removed." : "Radar token saved.");
		} catch (cause) {
			setError(errorText(cause, "Could not save the token"));
		} finally {
			setPending(undefined);
		}
	};
	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (token.trim()) void send({ token: token.trim() });
			}}
		>
			<div className="sm:max-w-md">
				<SecretField
					label="Cloudflare Radar API token"
					saved={props.source === "settings"}
					value={token}
					onChange={setToken}
					description="Create a Custom Token with Account → Radar → Read. Stored encrypted."
					onClear={() => void send({ clear: true })}
					clearing={pending === "clear"}
					disabled={Boolean(pending)}
				/>
			</div>
			<div className="sm:max-w-md">
				<CredentialGuide id="radar" />
			</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			<div className="flex gap-2">
				<Button type="submit" variant="primary" disabled={Boolean(pending) || !token.trim()}>
					{pending === "save" ? "Saving…" : "Save token"}
				</Button>
				{props.onCancel && (
					<Button type="button" variant="secondary" disabled={Boolean(pending)} onClick={props.onCancel}>
						Cancel
					</Button>
				)}
			</div>
		</form>
	);
}

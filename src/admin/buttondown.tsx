/**
 * Buttondown Drafts page: whether a key is saved (the key itself goes on the
 * plugin's Settings page, like the other keys) and what it can reach, the
 * Updates part, the rules that say which posts get a draft, and the last 20
 * drafts with their state, warnings and errors.
 */
import { Badge, Banner, Button, Checkbox, Select } from "@cloudflare/kumo";
import { ArrowClockwise, ArrowSquareOut, Key, Plus, Trash } from "@phosphor-icons/react";
import * as React from "react";

import { PACK_API, apiPost, errorText } from "./api.js";
import { type RecordView, STATE_BADGE, badgeLabel } from "./buttondown-core.js";
import { PartSwitches } from "./feature-switches.js";
import { AdminLink, DocsLink, Loading, PageHeader, WarningBadge, WarningText } from "./page.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SETTINGS_PAGE_PATH, SettingsSection, SetupCard } from "./settings-ui.js";
import { useSaveResult, useToast } from "./toast.js";

const post = apiPost(`${PACK_API}/buttondown`, { body: {} });

interface Rule {
	collection: string;
	taxonomy: string;
	terms: string[];
	since?: string;
}

interface Status {
	settings: { rules: Rule[]; footerLink: boolean };
	keySaved: boolean;
	keyUnreadable: boolean;
	updatesOn: boolean;
	siteHost: string;
	collections: Array<{ slug: string; label: string; taxonomies: Array<{ name: string; label: string; hierarchical: boolean; terms: Array<{ slug: string; label: string; depth: number }> }> }>;
	/** EmDash's taxonomies couldn't be read: the pickers show none. */
	taxonomiesFailed?: boolean;
	recent: RecordView[];
}

interface KeyCheck {
	keySaved: boolean;
	keyUnreadable: boolean;
	check: { ping: number; emails: number; newsletters: number; subscribers: number } | null;
	tooBroad?: boolean;
}

interface Draft {
	rules: Array<{ collection: string; taxonomy: string; terms: string[] }>;
	footerLink: boolean;
}

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const when = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? dateTime.format(new Date(iso)) : "");
const toDraft = (s: Status["settings"]): Draft => ({ rules: s.rules.map((r) => ({ collection: r.collection, taxonomy: r.taxonomy, terms: [...r.terms] })), footerLink: s.footerLink });

export function StateBadge(props: { record: Pick<RecordView, "state" | "remoteStatus"> }) {
	return <Badge variant={STATE_BADGE[props.record.state]?.variant ?? "outline"}>{badgeLabel(props.record)}</Badge>;
}

/** The key check's four answers, each with what it means. */
function KeyCheckResults(props: { result: KeyCheck }) {
	const c = props.result.check;
	if (!c) return null;
	const refused = (s: number) => s === 401 || s === 403;
	const lines: Array<{ ok: boolean; text: string }> = [
		{ ok: c.ping === 200, text: c.ping === 200 ? "The key works." : c.ping ? `Buttondown refused the key (${c.ping}).` : "Buttondown didn't answer. Try again in a minute." },
		{ ok: c.emails === 200, text: c.emails === 200 ? "It can read and write drafts." : `It can't read drafts (${c.emails || "no answer"}). Give it Emails and drafts → Write.` },
		{ ok: refused(c.newsletters), text: refused(c.newsletters) ? "It can't read your newsletters or their keys." : c.newsletters === 200 ? "It can read your newsletters, and with them every newsletter's API key." : `Newsletters answered ${c.newsletters || "nothing"}.` },
		{ ok: refused(c.subscribers), text: refused(c.subscribers) ? "It can't read your subscribers." : c.subscribers === 200 ? "It can read your subscribers." : `Subscribers answered ${c.subscribers || "nothing"}.` },
	];
	return (
		<div className="space-y-3" role="status">
			<ul role="list" className="space-y-1.5">
				{lines.map((line) => (
					<li key={line.text} className="flex items-start gap-2 text-sm">
						{line.ok ? <Badge variant="outline">OK</Badge> : <WarningBadge>Check</WarningBadge>}
						<span className="min-w-0">{line.text}</span>
					</li>
				))}
			</ul>
			{props.result.tooBroad && <Banner variant="error" role="alert" description="This key can do more than it needs. Make a key with only Emails and drafts → Write (every other area None), save it on the Settings page, and delete this one in Buttondown." />}
		</div>
	);
}

function Connection(props: { status: Status }) {
	const { status } = props;
	const [checking, setChecking] = React.useState(false);
	const [result, setResult] = React.useState<KeyCheck | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const check = async () => {
		setChecking(true);
		setError(null);
		try {
			setResult(await post<KeyCheck>("key/check", {}, "Couldn't check the key"));
		} catch (cause) {
			setError(errorText(cause, "Couldn't check the key"));
		} finally {
			setChecking(false);
		}
	};
	const settingsLink = (
		<AdminLink to={SETTINGS_PAGE_PATH} className="text-kumo-link underline">
			the plugin's Settings page
		</AdminLink>
	);
	if (!status.keySaved) {
		return (
			<SetupCard
				title={status.keyUnreadable ? "The saved key can't be read" : "Add a Buttondown API key"}
				description={
					status.keyUnreadable ? (
						<>The saved Buttondown API key can't be decrypted: EMDASH_ENCRYPTION_KEY is missing or has changed. Save the key again on {settingsLink}.</>
					) : (
						<>
							Paste it as Buttondown API key on {settingsLink}, where its step-by-step guide is. Use a key with only Emails and drafts → Write, from the newsletter this site's drafts go to.
						</>
					)
				}
			/>
		);
	}
	return (
		<SettingsSection
			id="cw-bd-connection"
			title="Connection"
			description={<>A Buttondown API key is saved on {settingsLink}. Check what it can reach: the Pack needs only Emails and drafts.</>}
			actions={
				<Button type="button" variant="secondary" icon={<Key aria-hidden="true" />} disabled={checking} onClick={() => void check()}>
					{checking ? "Checking…" : "Check key"}
				</Button>
			}
		>
			{error ? <Banner variant="error" role="alert" description={error} /> : result ? <KeyCheckResults result={result} /> : <p className="text-sm text-kumo-subtle">Check key makes four small reads (their answers' bodies are never read). Nothing is written.</p>}
		</SettingsSection>
	);
}

/** One rule: the collection, a taxonomy of it, and the terms (any of them, or a child term). */
function RuleEditor(props: { index: number; rule: Draft["rules"][number]; status: Status; taken: string[]; since?: string; onChange: (rule: Draft["rules"][number]) => void; onRemove: () => void }) {
	const { rule, status } = props;
	const collection = status.collections.find((c) => c.slug === rule.collection);
	const taxonomy = collection?.taxonomies.find((t) => t.name === rule.taxonomy);
	const legend = `cw-bd-rule-${props.index}-terms`;
	return (
		<li className="space-y-3 rounded-md border border-kumo-line p-4">
			<div className="grid gap-4 sm:grid-cols-2">
				<Select
					label="Collection"
					value={rule.collection || null}
					placeholder="Choose a collection"
					onValueChange={(value: string | null) => {
						const next = status.collections.find((c) => c.slug === value);
						props.onChange({ collection: value ?? "", taxonomy: next?.taxonomies.length === 1 ? next.taxonomies[0].name : "", terms: [] });
					}}
					items={status.collections.filter((c) => c.slug === rule.collection || !props.taken.includes(c.slug)).map((c) => ({ value: c.slug, label: c.label }))}
				/>
				<Select
					label="Taxonomy"
					value={rule.taxonomy || null}
					placeholder={collection?.taxonomies.length ? "Choose a taxonomy" : "No taxonomies"}
					disabled={!collection?.taxonomies.length}
					onValueChange={(value: string | null) => props.onChange({ ...rule, taxonomy: value ?? "", terms: [] })}
					items={(collection?.taxonomies ?? []).map((t) => ({ value: t.name, label: t.label }))}
				/>
			</div>
			{taxonomy && (
				<fieldset className="space-y-2" aria-describedby={`${legend}-hint`}>
					<legend className="text-sm font-medium">Terms</legend>
					<p id={`${legend}-hint`} className="text-sm text-kumo-subtle">
						A post with any of these{taxonomy.hierarchical ? ", or a child of one," : ""} gets a draft when it's published.
					</p>
					{taxonomy.terms.length ? (
						<ul role="list" className="max-h-64 cw-overflow-auto space-y-1.5 rounded-md border border-kumo-line p-3">
							{taxonomy.terms.map((term) => (
								<li key={term.slug} style={{ paddingInlineStart: `${term.depth * 1.25}rem` }}>
									<Checkbox
										label={term.label}
										checked={rule.terms.includes(term.slug)}
										onCheckedChange={(on: boolean) => props.onChange({ ...rule, terms: on ? [...rule.terms, term.slug] : rule.terms.filter((t) => t !== term.slug) })}
									/>
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-kumo-subtle">This taxonomy has no terms yet.</p>
					)}
				</fieldset>
			)}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-xs text-kumo-subtle">
					{props.since
						? `Saved ${when(props.since)}. Posts first published before then get a draft only with Create draft now (in the entry editor).`
						: "New: once saved, only posts first published from then on get a draft on their own."}
				</p>
				<Button type="button" size="sm" variant="ghost" icon={<Trash aria-hidden="true" />} aria-label={`Remove the ${collection ? `${collection.label} ` : "new "}rule`} onClick={props.onRemove}>
					Remove rule
				</Button>
			</div>
		</li>
	);
}

function RecentDrafts(props: { recent: RecordView[]; onRetry: (r: RecordView) => void; retrying: string | null }) {
	if (!props.recent.length) return <p className="px-4 py-6 text-center text-sm text-kumo-subtle">No drafts yet. They appear here as matching posts are published.</p>;
	return (
		<ul role="list" className="divide-y divide-kumo-line">
			{props.recent.map((r) => {
				const key = `${r.collection}:${r.entryId}`;
				return (
					<li key={key} className="space-y-1.5 px-4 py-3">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<StateBadge record={r} />
							<AdminLink to={`/content/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.entryId)}`} className="min-w-0 font-medium text-kumo-link underline">
								{r.title || r.entryId}
							</AdminLink>
							<span className="text-sm text-kumo-subtle">{when(r.updatedAt)}</span>
						</div>
						<p className="text-sm">{r.text}</p>
						{r.warnings.length > 0 && (
							<ul role="list" className="space-y-1">
								{r.warnings.map((w) => (
									<li key={w} className="text-sm">
										<WarningText>{w}</WarningText>
									</li>
								))}
							</ul>
						)}
						{r.state === "error" && r.nextRetryAt && <p className="text-xs text-kumo-subtle">Tried again on its own after {when(r.nextRetryAt)}.</p>}
						<div className="flex flex-wrap gap-2">
							{r.appUrl && (
								<a href={r.appUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm text-kumo-link underline">
									Open in Buttondown
									<ArrowSquareOut aria-hidden="true" />
									<span className="sr-only">(opens in a new tab)</span>
								</a>
							)}
							{r.state === "error" && (
								<Button type="button" size="sm" variant="secondary" icon={<ArrowClockwise aria-hidden="true" />} disabled={props.retrying !== null} onClick={() => props.onRetry(r)}>
									{props.retrying === key ? "Retrying…" : "Retry"}
								</Button>
							)}
						</div>
					</li>
				);
			})}
		</ul>
	);
}

export function ButtondownPage() {
	const [status, setStatus] = React.useState<Status>();
	const [draft, setDraft] = React.useState<Draft>();
	const [saved, setSaved] = React.useState<Draft>();
	const [error, setError] = React.useState<string>();
	const [saving, setSaving] = React.useState(false);
	const [retrying, setRetrying] = React.useState<string | null>(null);
	const result = useSaveResult();
	const toast = useToast();

	const load = React.useCallback(async (keepDraft = false) => {
		try {
			const next = await post<Status>("status", {}, "Couldn't load Buttondown Drafts");
			setStatus(next);
			if (!keepDraft) {
				setDraft(toDraft(next.settings));
				setSaved(toDraft(next.settings));
			}
		} catch (cause) {
			setError(errorText(cause, "Couldn't load Buttondown Drafts"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const incomplete = draft?.rules.find((r) => !r.collection || !r.taxonomy || !r.terms.length);
	const save = async () => {
		if (!draft) return;
		if (incomplete) {
			result.failed("Choose a collection, a taxonomy and at least one term for each rule, or remove it.");
			return;
		}
		setSaving(true);
		result.clear();
		try {
			const { settings } = await post<{ settings: Status["settings"] }>("settings/save", draft, "Couldn't save");
			setDraft(toDraft(settings));
			setSaved(toDraft(settings));
			setStatus((s) => (s ? { ...s, settings } : s));
			result.saved("Buttondown Drafts settings saved");
		} catch (cause) {
			result.failed(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	};

	const retry = async (r: RecordView) => {
		const key = `${r.collection}:${r.entryId}`;
		setRetrying(key);
		try {
			const { record } = await post<{ record: RecordView | null }>("retry", { collection: r.collection, id: r.entryId }, "Couldn't retry");
			if (record?.state === "error") toast.error("Still failing", record.lastError?.message ?? record.text);
			else toast.success("Done", record?.text ?? "Retried.");
			void load(true);
		} catch (cause) {
			toast.error("Couldn't retry", errorText(cause, "The request failed"));
		} finally {
			setRetrying(null);
		}
	};

	const dirty = isDirty(draft, saved);
	const sinceOf = (collection: string) => status?.settings.rules.find((r) => r.collection === collection && saved?.rules.some((s) => s.collection === collection && s.taxonomy === r.taxonomy && [...s.terms].sort().join() === [...r.terms].sort().join()))?.since;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Buttondown Drafts"
				description={
					<>
						When a post with a chosen category is published, the Pack makes one email draft from it in Buttondown. It never sends, schedules or publishes an email: you review each draft and send it from Buttondown. <DocsLink doc="buttondown">How it works</DocsLink>
					</>
				}
			/>

			{error && <Banner variant="error" role="alert" description={error} />}
			{!status && !error && <Loading />}
			{status && <Connection status={status} />}
			{status && <PartSwitches module="buttondown" />}

			{status && draft && (
				<form
					id="cw-buttondown-form"
					className="space-y-6"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<SettingsSection
						id="cw-bd-rules"
						title="When to create a draft"
						description="One rule per collection. Only posts first published after a rule is saved get a draft on their own, so republishing an old post never makes one."
						actions={
							<Button
								type="button"
								variant="secondary"
								icon={<Plus aria-hidden="true" />}
								disabled={draft.rules.length >= 10 || draft.rules.length >= status.collections.length}
								onClick={() => setDraft({ ...draft, rules: [...draft.rules, { collection: "", taxonomy: "", terms: [] }] })}
							>
								Add a rule
							</Button>
						}
					>
						{status.taxonomiesFailed && <Banner variant="error" role="alert" description="EmDash's categories and tags couldn't be read just now, so the pickers are empty. Saved rules still apply. Reload the page to try again." />}
						{draft.rules.length ? (
							<ul role="list" className="space-y-4">
								{draft.rules.map((rule, i) => (
									<RuleEditor
										key={i}
										index={i}
										rule={rule}
										status={status}
										taken={draft.rules.filter((_, j) => j !== i).map((r) => r.collection)}
										since={rule.collection ? sinceOf(rule.collection) : undefined}
										onChange={(next) => setDraft({ ...draft, rules: draft.rules.map((r, j) => (j === i ? next : r)) })}
										onRemove={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}
									/>
								))}
							</ul>
						) : (
							<p className="text-sm text-kumo-subtle">No rules yet, so no drafts are made. Add one: for example Posts, Categories, Newsletter.</p>
						)}
						<Checkbox
							label={`Add “Read it on ${status.siteHost}” at the bottom of each email, linking to the post`}
							checked={draft.footerLink}
							onCheckedChange={(on: boolean) => setDraft({ ...draft, footerLink: on })}
						/>
					</SettingsSection>
				</form>
			)}

			{status && (
				<section className="rounded-lg border border-kumo-line" aria-labelledby="cw-bd-recent">
					<div className="flex items-start justify-between gap-4 border-b border-kumo-line p-4">
						<div className="min-w-0">
							<h2 id="cw-bd-recent" className="text-base font-semibold">
								Recent drafts
							</h2>
							<p className="mt-1 text-sm text-kumo-subtle">The last 20 posts the Pack made or checked a draft for. A failed one is tried again every hour for three days; one Buttondown refused waits for Retry.</p>
						</div>
						<Button type="button" variant="ghost" icon={<ArrowClockwise aria-hidden="true" />} onClick={() => void load(true)}>
							Refresh
						</Button>
					</div>
					<RecentDrafts recent={status.recent} retrying={retrying} onRetry={(r) => void retry(r)} />
				</section>
			)}

			{draft && <SaveBar dirty={dirty} saving={saving} canSave={!incomplete} form="cw-buttondown-form" error={result.error} onDiscard={() => saved && setDraft(saved)} />}
		</div>
	);
}

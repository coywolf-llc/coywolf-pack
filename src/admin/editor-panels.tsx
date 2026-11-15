/**
 * The pack's sections in EmDash's entry editor sidebar (contentEditorPanels)
 * and its column in the content lists (contentListColumns), EmDash 1.4+:
 *
 * - Child pages: the page's URL, its parent and children, a parent waiting
 *   to be published, and what to watch out for (loops, a parent that isn't
 *   published, Slug changes off).
 * - Schema & Social: the entry's page and article types (its own or its
 *   collection's), main subject and custom markup, with a link to edit them.
 * - AI suggestions: the entry's AI description and entities (AI Enrichment).
 * - Link status: the entry's links, worst first (Link Manager).
 * - Buttondown: the entry's email draft (its state, warnings and link), with
 *   Create draft now and Refresh draft from post. Only in collections a
 *   Buttondown rule covers (EmDash's isVisible check).
 * - Parent column: each listed entry's parent page (Child Pages), and Links
 *   column: each listed entry's broken and blocked links; each read for the
 *   whole page in one request.
 *
 * Each shows only while its module is on (src/admin/extensions.ts; the Child
 * Pages ones only in collections with the Parent page field) and to admins
 * only (the routes need plugins:manage). They never change the entry: changes are
 * made on the module pages (the Buttondown panel's buttons change only the email draft
 * in Buttondown), so nothing here races the editor's own save.
 */
import { Badge, Button } from "@cloudflare/kumo";
import { ArrowClockwise, ArrowSquareOut, ArrowsClockwise, Copy, EnvelopeSimple } from "@phosphor-icons/react";
import * as React from "react";

import { PACK_API, apiPost, errorText } from "./api.js";
import { STATE_BADGE, type RecordView, badgeLabel, buttondownEntry, buttondownPanelVisible, timeAgo } from "./buttondown-core.js";
import { useConfirm } from "./confirm-dialog.js";
import { EDITOR_PANELS, LIST_COLUMNS, extensionShows } from "./extensions.js";
import { AdminLink, PackLink, WarningBadge } from "./page.js";
import { packPagePath } from "./router.js";

/** What EmDash hands a panel (its ContentEditorPanelContext; entry is the saved item). */
interface PanelProps {
	collection: string;
	entry: { id: string; updatedAt?: string; slug?: string | null };
	locale?: string;
}

/** What EmDash hands a column cell (its ContentListColumnCellContext). */
interface CellProps {
	collection: string;
	item: { id: string };
	visibleItems: readonly { id: string }[];
	locale?: string;
}

const schemaPost = apiPost(`${PACK_API}/schema`);
const aiPost = apiPost(`${PACK_API}/ai`);
const linksPost = apiPost(`${PACK_API}/links`);
const childPagesPost = apiPost(`${PACK_API}/childPages`);
const buttondownPost = apiPost(`${PACK_API}/buttondown`);

/** Load `fetcher` for an entry (again when it's saved), with a loading and an error state. */
function useEntryData<T>(fetcher: () => Promise<T>, deps: React.DependencyList) {
	const [state, setState] = React.useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
	const [version, setVersion] = React.useState(0);
	React.useEffect(() => {
		let live = true;
		setState((s) => ({ ...s, loading: true, error: undefined }));
		fetcher()
			.then((data) => live && setState({ data, loading: false }))
			.catch((cause) => live && setState({ error: errorText(cause, "Couldn't load this"), loading: false }));
		return () => {
			live = false;
		};
	}, [...deps, version]);
	return { ...state, reload: () => setVersion((v) => v + 1) };
}

function Muted(props: { children: React.ReactNode }) {
	return <p className="text-xs leading-4 text-kumo-subtle">{props.children}</p>;
}

function Row(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="min-w-0">
			<dt className="text-xs text-kumo-subtle">{props.label}</dt>
			<dd className="min-w-0 break-words text-sm">{props.children}</dd>
		</div>
	);
}

// ── Schema & Social ──────────────────────────────────────────────

interface SchemaEntry {
	override: { pageType?: string; articleType?: string; mainSubject?: string; custom?: { enabled: boolean; mainEntity?: boolean } } | null;
	collectionTypes: { pageType?: string; articleType?: string };
	labels: Record<string, string>;
	mainSubject: string | null;
	customTypes: string[];
	features: { graph: boolean; custom: boolean };
}

export function SchemaPanel(props: PanelProps) {
	const { collection, entry } = props;
	const { data, error, loading } = useEntryData(() => schemaPost<SchemaEntry>("entry", { collection, entryId: entry.id }, "Couldn't read the schema override"), [collection, entry.id, entry.updatedAt]);
	if (loading && !data) return <Muted>Loading…</Muted>;
	if (error || !data) return <Muted>{error ?? "Couldn't read the schema override."}</Muted>;
	// The entry's own type, else its collection's (Types tab), else the graph's default (which depends on the page).
	const type = (key: "pageType" | "articleType") => {
		const own = data.override?.[key];
		const value = own ?? data.collectionTypes[key];
		if (!value) return <span className="text-kumo-subtle">Default</span>;
		return (
			<>
				{data.labels[value] ?? value}
				{!own && <span className="text-kumo-subtle"> (from the collection)</span>}
			</>
		);
	};
	const custom = data.override?.custom;
	return (
		<div className="space-y-3">
			{!data.features.graph && <Muted>The Schema.org graph is off, so these types aren't output.</Muted>}
			<dl className="space-y-2">
				<Row label="Page type">{type("pageType")}</Row>
				<Row label="Article type">{type("articleType")}</Row>
				<Row label="About (main subject)">{data.mainSubject ?? <span className="text-kumo-subtle">Not set</span>}</Row>
				<Row label="Custom markup">
					{custom ? (
						<>
							{data.customTypes.length ? data.customTypes.join(", ") : "JSON-LD"}
							{!custom.enabled ? " (off)" : !data.features.custom ? " (Custom markup is off)" : ""}
						</>
					) : (
						<span className="text-kumo-subtle">None</span>
					)}
				</Row>
			</dl>
			<AdminLink to={`${packPagePath("/schema")}?entry=${encodeURIComponent(`${collection}:${entry.id}`)}`} className="text-sm text-kumo-link underline">
				{data.override ? "Edit the override" : "Override for this entry"}
			</AdminLink>
		</div>
	);
}

// ── AI suggestions ───────────────────────────────────────────────

interface AiEntry {
	record: {
		status: "ok" | "error";
		error: string;
		entities: Array<{ name: string; type: string; primary: boolean; wikipedia?: string }>;
		description: string;
		descriptionStatus: "none" | "suggested" | "applied" | "dismissed";
		updated: string;
	} | null;
	covered: boolean;
	features: { entities: boolean; descriptions: boolean };
}

export function AiPanel(props: PanelProps) {
	const { collection, entry } = props;
	const { data, error, loading, reload } = useEntryData(() => aiPost<AiEntry>("entry", { collection, id: entry.id }, "Couldn't read the AI suggestions"), [collection, entry.id, entry.updatedAt]);
	const [pending, setPending] = React.useState<"reanalyze" | "dismiss">();
	const [notice, setNotice] = React.useState<string>();
	const [copied, setCopied] = React.useState(false);
	if (loading && !data) return <Muted>Loading…</Muted>;
	if (error || !data) return <Muted>{error ?? "Couldn't read the AI suggestions."}</Muted>;
	if (!data.features.entities && !data.features.descriptions) {
		return (
			<Muted>
				Entities and descriptions are off. Turn them on on the <PackLink page="/ai">AI Enrichment page</PackLink>.
			</Muted>
		);
	}
	if (!data.covered) {
		return (
			<Muted>
				AI Enrichment doesn't analyze this collection. Change that on the <PackLink page="/ai">AI Enrichment page</PackLink>.
			</Muted>
		);
	}
	const record = data.record;
	const run = async (kind: "reanalyze" | "dismiss") => {
		setPending(kind);
		setNotice(undefined);
		try {
			if (kind === "reanalyze") {
				await aiPost("entry/reanalyze", { collection, id: entry.id }, "Couldn't queue the entry");
				setNotice("Queued. The suggestions update within a few minutes.");
			} else {
				await aiPost("description/dismiss", { collection, id: entry.id }, "Couldn't dismiss it");
				reload();
			}
		} catch (cause) {
			setNotice(errorText(cause, "That didn't work"));
		} finally {
			setPending(undefined);
		}
	};
	const copy = async () => {
		if (!record?.description) return;
		try {
			await navigator.clipboard.writeText(record.description);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			setNotice("Couldn't copy. Select the text and copy it instead.");
		}
	};
	return (
		<div className="space-y-3">
			{!record ? (
				<Muted>Not analyzed yet. Entries are analyzed a few minutes after they're saved.</Muted>
			) : record.status === "error" ? (
				<Muted>The last analysis failed: {record.error || "unknown error"}</Muted>
			) : (
				<>
					{data.features.descriptions && record.description && record.descriptionStatus !== "dismissed" && (
						<div className="space-y-1.5">
							<div className="flex items-center gap-2">
								<span className="text-xs text-kumo-subtle">Description</span>
								{record.descriptionStatus === "applied" && <Badge variant="secondary">Applied</Badge>}
							</div>
							<p className="text-sm">{record.description}</p>
							{record.descriptionStatus === "suggested" && (
								<>
									<div className="flex flex-wrap gap-1.5">
										<Button type="button" size="sm" variant="secondary" icon={<Copy aria-hidden="true" />} onClick={() => void copy()}>
											{copied ? "Copied" : "Copy"}
										</Button>
										<Button type="button" size="sm" variant="ghost" disabled={pending !== undefined} onClick={() => void run("dismiss")}>
											Dismiss
										</Button>
									</div>
									<Muted>Paste it into the SEO section's description, or apply it from the AI Enrichment page.</Muted>
								</>
							)}
						</div>
					)}
					{data.features.entities && (
						<div className="space-y-1.5">
							<span className="text-xs text-kumo-subtle">Entities</span>
							{record.entities.length ? (
								<ul className="flex flex-wrap gap-1.5">
									{record.entities.slice(0, 12).map((e) => (
										<li key={`${e.type}:${e.name}`}>
											<Badge variant={e.primary ? "primary" : "outline"}>{e.name}</Badge>
										</li>
									))}
								</ul>
							) : (
								<Muted>None found.</Muted>
							)}
						</div>
					)}
				</>
			)}
			<div aria-live="polite">{notice && <Muted>{notice}</Muted>}</div>
			<Button type="button" size="sm" variant="ghost" icon={<ArrowsClockwise aria-hidden="true" />} disabled={pending !== undefined} onClick={() => void run("reanalyze")}>
				{pending === "reanalyze" ? "Queuing…" : "Analyze again"}
			</Button>
		</div>
	);
}

// ── Link status ──────────────────────────────────────────────────

type LinkStatus = "unchecked" | "ok" | "redirect" | "broken" | "blocked" | "error";

interface LinkSummary {
	total: number;
	broken: number;
	error: number;
	blocked: number;
	redirect: number;
	unchecked: number;
}

interface EntryLinks {
	items: Array<{ url: string; status: LinkStatus; code: number | null; note: string; internal: boolean; ignored: boolean; anchors: string[] }>;
	total: number;
	summary: LinkSummary | null;
	checking: boolean;
}

const STATUS: Record<LinkStatus, { label: string; variant: "primary" | "secondary" | "outline" | "destructive" | "warning" }> = {
	broken: { label: "Broken", variant: "destructive" },
	error: { label: "Error", variant: "destructive" },
	blocked: { label: "Blocked", variant: "warning" },
	redirect: { label: "Redirect", variant: "secondary" },
	unchecked: { label: "Not checked", variant: "outline" },
	ok: { label: "OK", variant: "outline" },
};

const SHOWN_LINKS = 8;

export function LinksPanel(props: PanelProps) {
	const { collection, entry } = props;
	const { data, error, loading } = useEntryData(() => linksPost<EntryLinks>("entry", { collection, entryId: entry.id }, "Couldn't read the links"), [collection, entry.id, entry.updatedAt]);
	if (loading && !data) return <Muted>Loading…</Muted>;
	if (error || !data) return <Muted>{error ?? "Couldn't read the links."}</Muted>;
	const shown = data.items.filter((i) => !i.ignored);
	if (!shown.length) return <Muted>No links found in this entry (it's indexed when it's saved).</Muted>;
	const problems = (data.summary?.broken ?? 0) + (data.summary?.error ?? 0);
	return (
		<div className="space-y-3">
			<p className="text-sm">
				{shown.length} {shown.length === 1 ? "link" : "links"}
				{problems ? `, ${problems} broken` : ""}
				{data.summary?.blocked ? `, ${data.summary.blocked} blocked` : ""}
				{!data.checking && <span className="text-kumo-subtle"> (scheduled checking is off)</span>}
			</p>
			<ul className="space-y-2">
				{shown.slice(0, SHOWN_LINKS).map((link) => (
					<li key={link.url} className="min-w-0 space-y-0.5">
						<div className="flex min-w-0 items-center gap-1.5">
							<Badge variant={STATUS[link.status].variant}>{STATUS[link.status].label}</Badge>
							{link.code ? <span className="text-xs tabular-nums text-kumo-subtle">{link.code}</span> : null}
						</div>
						<a href={link.url.startsWith("/") || /^https?:/i.test(link.url) ? link.url : undefined} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-kumo-link underline" title={link.url}>
							{link.url}
						</a>
					</li>
				))}
			</ul>
			{shown.length > SHOWN_LINKS && <Muted>And {shown.length - SHOWN_LINKS} more.</Muted>}
			<PackLink page="/links" className="text-sm text-kumo-link underline">
				Open Link Manager
			</PackLink>
		</div>
	);
}

// ── Child pages ──────────────────────────────────────────────────

interface PageSummary {
	id: string;
	title: string;
	slug: string | null;
	url: string | null;
	status: string;
}

interface ChildPagesEntry {
	enabled: boolean;
	redirects: boolean;
	slugChanges: boolean;
	field: boolean;
	found: boolean;
	nested: boolean;
	url?: string | null;
	published?: boolean;
	digitSlug?: boolean;
	parent?: PageSummary | null;
	pendingParent?: { parent: PageSummary | null; loop: boolean } | null;
	ancestors?: PageSummary[];
	children?: Array<PageSummary & { nested: boolean }>;
	warnings?: string[];
}

const SHOWN_CHILDREN = 10;

/** What each warning from childPages/entry means for the editor. */
export const PAGE_WARNINGS: Record<string, string> = {
	loop: "This page is in a loop of parent pages (it's its own ancestor), so its URL is at the top level. Choose another parent page.",
	parentUnpublished: "Its parent page isn't published, so this page's URL is at the top level until the parent is published.",
	parentMissing: "Its parent page was deleted. Choose another parent page, or none.",
	deep: "This page is 8 or more levels deep. Long URLs are harder to read and share.",
	digitSlug: "The slug is only digits, which a theme can mistake for a page number (/page/2/). Use a slug with letters.",
};

/** A link to edit an entry in the admin. */
function EntryLink(props: { collection: string; page: PageSummary }) {
	return (
		<AdminLink to={`/content/${encodeURIComponent(props.collection)}/${encodeURIComponent(props.page.id)}`} className="text-kumo-link underline">
			{props.page.title}
		</AdminLink>
	);
}

export function ChildPagesPanel(props: PanelProps) {
	const { collection, entry } = props;
	const { data, error, loading } = useEntryData(() => childPagesPost<ChildPagesEntry>("entry", { collection, id: entry.id }, "Couldn't read the page's parents"), [collection, entry.id, entry.updatedAt]);
	if (loading && !data) return <Muted>Loading…</Muted>;
	if (error || !data) return <Muted>{error ?? "Couldn't read the page's parents."}</Muted>;
	if (!data.field || !data.found) return <Muted>Save the page to see its place in the page tree.</Muted>;
	const warnings = [...(data.warnings ?? [])];
	const children = data.children ?? [];
	const pending = data.pendingParent;
	return (
		<div className="space-y-3">
			<dl className="space-y-2">
				<Row label={data.published ? "URL" : "URL once published"}>
					{data.url ? (
						data.published ? (
							<a href={data.url} target="_blank" rel="noreferrer noopener" className="break-all text-kumo-link underline">
								{data.url}
							</a>
						) : (
							<span className="break-all">{data.url}</span>
						)
					) : (
						<span className="text-kumo-subtle">None</span>
					)}
				</Row>
				<Row label="Parent page">{data.parent ? <EntryLink collection={collection} page={data.parent} /> : <span className="text-kumo-subtle">None (top level)</span>}</Row>
				{pending && (
					<Row label="When you publish">
						{pending.parent ? (
							<>
								Parent page: <EntryLink collection={collection} page={pending.parent} />
							</>
						) : (
							"No parent page (top level)"
						)}
						{pending.loop && <span className="block text-kumo-danger">That parent would put this page under itself, so publishing is refused. Choose another parent page.</span>}
					</Row>
				)}
				{(data.ancestors?.length ?? 0) > 0 && <Row label="Under">{data.ancestors?.map((a) => a.title).join(" › ")}</Row>}
				<Row label="Pages under this one">
					{children.length ? (
						<ul role="list" className="mt-0.5 space-y-2">
							{children.slice(0, SHOWN_CHILDREN).map((child) => (
								<li key={child.id} className="min-w-0 leading-snug">
									<EntryLink collection={collection} page={child} />
									{child.status !== "published" && <span className="text-kumo-subtle"> ({child.status})</span>}
								</li>
							))}
							{children.length > SHOWN_CHILDREN && <li className="text-kumo-subtle">And {children.length - SHOWN_CHILDREN} more.</li>}
						</ul>
					) : (
						<span className="text-kumo-subtle">None</span>
					)}
				</Row>
			</dl>
			{warnings.length > 0 && (
				<ul role="list" className="space-y-1.5">
					{warnings.map((w) => (
						<li key={w} className="flex items-start gap-1.5 text-sm">
							<WarningBadge>Check</WarningBadge>
							<span>{PAGE_WARNINGS[w] ?? w}</span>
						</li>
					))}
				</ul>
			)}
			{data.enabled && (!data.redirects || !data.slugChanges) && (
				<Muted>
					{!data.redirects ? "Redirect Manager is off" : "Slug changes (Redirect Manager) is off"}, so if this page or its parent moves, the old URL won't redirect. Turn it on from{" "}
					<PackLink page="/features">the Features page</PackLink>.
				</Muted>
			)}
			<PackLink page="/child-pages" className="text-sm text-kumo-link underline">
				Open Child Pages
			</PackLink>
		</div>
	);
}

// ── Buttondown ───────────────────────────────────────────────────

export function ButtondownPanel(props: PanelProps) {
	const { collection, entry } = props;
	const [fresh, setFresh] = React.useState(0);
	const { data, error, loading } = useEntryData(() => buttondownEntry(collection, entry.id, entry.updatedAt ?? "", { fresh: fresh > 0 }), [collection, entry.id, entry.updatedAt, fresh]);
	const [pending, setPending] = React.useState<"create" | "refresh" | "retry">();
	const [notice, setNotice] = React.useState<string>();
	const [confirm, confirmDialog] = useConfirm();
	if (loading && !data) return <Muted>Loading…</Muted>;
	if (error || !data) return <Muted>{error ?? "Couldn't read the Buttondown draft."}</Muted>;
	if (!data.covered) return <Muted>No Buttondown rule covers this collection. Add one on the <PackLink page="/buttondown">Buttondown Drafts page</PackLink>.</Muted>;
	const record: RecordView | null = data.record ?? null;
	const run = async (action: "create" | "refresh" | "retry") => {
		if (action === "refresh") {
			const ok = await confirm({
				title: "Refresh the draft from the post?",
				description: "This writes the post as it's published now over the draft in Buttondown, including any changes made there. It still won't touch an email that isn't a draft.",
				confirmLabel: "Refresh draft",
			});
			if (!ok) return;
		}
		setPending(action);
		setNotice(undefined);
		try {
			const result = await buttondownPost<{ record: RecordView | null }>(action === "retry" ? "retry" : "sync", action === "retry" ? { collection, id: entry.id } : { collection, id: entry.id, action }, "That didn't work");
			setNotice(result.record?.state === "error" ? `Didn't work: ${result.record.lastError?.message ?? result.record.text}` : (result.record?.text ?? "Done."));
		} catch (cause) {
			setNotice(errorText(cause, "That didn't work"));
		} finally {
			setPending(undefined);
			setFresh((n) => n + 1);
		}
	};
	return (
		<div className="space-y-3">
			{record ? (
				<div className="space-y-1.5">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant={STATE_BADGE[record.state]?.variant ?? "outline"}>{badgeLabel(record)}</Badge>
						<span className="text-xs text-kumo-subtle">{timeAgo(record.updatedAt)}</span>
					</div>
					<p className="text-sm">{record.text}</p>
				</div>
			) : (
				<Muted>{data.published ? (data.matches ? "No draft yet. It was published before the rule was saved: Create draft now makes one." : "This post doesn't have one of the rule's terms, so it gets no draft.") : "Publish the post to make its draft in Buttondown."}</Muted>
			)}
			{record && record.warnings.length > 0 && (
				<ul role="list" className="space-y-1.5">
					{record.warnings.map((w) => (
						<li key={w} className="flex items-start gap-1.5 text-sm">
							<WarningBadge>Check</WarningBadge>
							<span>{w}</span>
						</li>
					))}
				</ul>
			)}
			{!data.keySaved && <Muted>No Buttondown API key saved yet: add it on the plugin's Settings page.</Muted>}
			{record?.appUrl && (
				<a href={record.appUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm text-kumo-link underline">
					Open in Buttondown
					<ArrowSquareOut aria-hidden="true" />
					<span className="sr-only">(opens in a new tab)</span>
				</a>
			)}
			<div aria-live="polite">{notice && <Muted>{notice}</Muted>}</div>
			{(data.canCreate || data.canRefresh || data.canRetry) && (
				<div className="flex flex-wrap gap-1.5">
					{data.canCreate && (
						<Button type="button" size="sm" variant="secondary" icon={<EnvelopeSimple aria-hidden="true" />} disabled={pending !== undefined} onClick={() => void run("create")}>
							{pending === "create" ? "Creating…" : "Create draft now"}
						</Button>
					)}
					{data.canRefresh && (
						<Button type="button" size="sm" variant="ghost" icon={<ArrowsClockwise aria-hidden="true" />} disabled={pending !== undefined} onClick={() => void run("refresh")}>
							{pending === "refresh" ? "Refreshing…" : "Refresh draft from post"}
						</Button>
					)}
					{data.canRetry && (
						<Button type="button" size="sm" variant="ghost" icon={<ArrowClockwise aria-hidden="true" />} disabled={pending !== undefined} onClick={() => void run("retry")}>
							{pending === "retry" ? "Retrying…" : "Retry"}
						</Button>
					)}
				</div>
			)}
			{confirmDialog}
		</div>
	);
}

// ── Links column ─────────────────────────────────────────────────

type PageLinks = Record<string, LinkSummary | null>;

/**
 * The link problems of one list page, requested once for all its rows: every cell asks with the same
 * collection and ids in the same render, so the first starts the request and the rest share it. Kept
 * for a minute (a list re-rendering doesn't ask again). Not React Query: the pack's copy of it isn't
 * always EmDash's (Vite pre-bundles EmDash's admin in dev), and a second copy has no client.
 */
const pageRequests = new Map<string, { at: number; promise: Promise<PageLinks> }>();
const PAGE_LINKS_MS = 60_000;

export function pageLinks(collection: string, ids: string[], now = Date.now()): Promise<PageLinks> {
	const key = `${collection}\n${ids.join(",")}`;
	const hit = pageRequests.get(key);
	if (hit && now - hit.at < PAGE_LINKS_MS) return hit.promise;
	if (pageRequests.size > 50) pageRequests.clear();
	const promise = linksPost<{ entries: PageLinks }>("entries/status", { collection, ids }, "Couldn't read link status").then((r) => r.entries);
	promise.catch(() => pageRequests.delete(key));
	pageRequests.set(key, { at: now, promise });
	return promise;
}

export function LinksCell(props: CellProps) {
	const ids = props.visibleItems.map((i) => i.id);
	const key = `${props.collection}\n${ids.join(",")}`;
	const [state, setState] = React.useState<{ key: string; entries?: PageLinks; failed?: boolean }>();
	React.useEffect(() => {
		let live = true;
		pageLinks(props.collection, ids)
			.then((entries) => live && setState({ key, entries }))
			.catch(() => live && setState({ key, failed: true }));
		return () => {
			live = false;
		};
		// The ids are in `key`.
	}, [key]);
	if (!state || state.key !== key) return <span className="text-kumo-subtle" aria-label="Loading">…</span>;
	const summary = state.entries?.[props.item.id];
	if (!summary) {
		return (
			<span className="text-kumo-subtle">
				<span aria-hidden="true">-</span>
				<span className="sr-only">{state.failed ? "Link status unavailable" : "No links"}</span>
			</span>
		);
	}
	const broken = summary.broken + summary.error;
	if (broken) return <Badge variant="destructive">{broken} broken</Badge>;
	if (summary.blocked) return <Badge variant="warning">{summary.blocked} blocked</Badge>;
	return <span className="text-kumo-subtle">{summary.total} OK</span>;
}

// ── Parent column ────────────────────────────────────────────────

type PageParents = Record<string, { id: string; title: string; counts: boolean } | null>;

const parentRequests = new Map<string, { at: number; promise: Promise<PageParents> }>();

/** The parents of one list page, requested once for all its rows (like pageLinks), kept for a minute. */
export function pageParents(collection: string, ids: string[], now = Date.now()): Promise<PageParents> {
	const key = `${collection}\n${ids.join(",")}`;
	const hit = parentRequests.get(key);
	if (hit && now - hit.at < PAGE_LINKS_MS) return hit.promise;
	if (parentRequests.size > 50) parentRequests.clear();
	const promise = childPagesPost<{ entries: PageParents }>("parents", { collection, ids }, "Couldn't read the parent pages").then((r) => r.entries);
	promise.catch(() => parentRequests.delete(key));
	parentRequests.set(key, { at: now, promise });
	return promise;
}

export function ParentCell(props: CellProps) {
	const ids = props.visibleItems.map((i) => i.id);
	const key = `${props.collection}\n${ids.join(",")}`;
	const [state, setState] = React.useState<{ key: string; entries?: PageParents; failed?: boolean }>();
	React.useEffect(() => {
		let live = true;
		pageParents(props.collection, ids)
			.then((entries) => live && setState({ key, entries }))
			.catch(() => live && setState({ key, failed: true }));
		return () => {
			live = false;
		};
		// The ids are in `key`.
	}, [key]);
	if (!state || state.key !== key) return <span className="text-kumo-subtle" aria-label="Loading">…</span>;
	const parent = state.entries?.[props.item.id];
	if (!parent) {
		return (
			<span className="text-kumo-subtle">
				<span aria-hidden="true">-</span>
				<span className="sr-only">{state.failed ? "Parent page unavailable" : "No parent page"}</span>
			</span>
		);
	}
	return (
		<span className={parent.counts ? undefined : "text-kumo-subtle"} title={parent.counts ? undefined : "Not in the URL: the parent isn't published, or the pages form a loop"}>
			{parent.title}
			{!parent.counts && <span className="sr-only"> (not in the URL)</span>}
		</span>
	);
}

// ── What EmDash reads from the admin module ──────────────────────

const PANEL_COMPONENTS: Record<(typeof EDITOR_PANELS)[number]["id"], React.ComponentType<PanelProps>> = { childPages: ChildPagesPanel, schema: SchemaPanel, ai: AiPanel, links: LinksPanel, buttondown: ButtondownPanel };
/** Panels that show only when their check says so (EmDash 1.5 isVisible): Buttondown, in collections a rule covers. */
const PANEL_VISIBLE: Partial<Record<(typeof EDITOR_PANELS)[number]["id"], (context: PanelProps) => Promise<boolean>>> = { buttondown: buttondownPanelVisible };
const COLUMN_CELLS: Record<(typeof LIST_COLUMNS)[number]["id"], React.ComponentType<CellProps>> = { parent: ParentCell, links: LinksCell };

export const contentEditorPanels = EDITOR_PANELS.map(({ page, ...panel }) => ({ ...panel, component: PANEL_COMPONENTS[panel.id], collections: (collection: string) => extensionShows(panel.id, page, collection), ...(PANEL_VISIBLE[panel.id] ? { isVisible: PANEL_VISIBLE[panel.id] } : {}) }));

export const contentListColumns = LIST_COLUMNS.map(({ page, ...column }) => ({ ...column, cell: COLUMN_CELLS[column.id], collections: (collection: string) => extensionShows(column.id, page, collection) }));

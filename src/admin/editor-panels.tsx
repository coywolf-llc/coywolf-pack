/**
 * The pack's sections in EmDash's entry editor sidebar (contentEditorPanels)
 * and its column in the content lists (contentListColumns), EmDash 1.4+:
 *
 * - Schema & Social: the entry's page and article types (its own or its
 *   collection's), main subject and custom markup, with a link to edit them.
 * - AI suggestions: the entry's AI description and entities (AI Enrichment).
 * - Link status: the entry's links, worst first (Link Manager).
 * - Links column: each listed entry's broken and blocked links, read for the
 *   whole page in one request.
 *
 * Each shows only while its module is on (src/admin/extensions.ts) and to
 * admins only (the routes need plugins:manage). They only read: changes are
 * made on the module pages, so nothing here races the editor's own save.
 */
import { Badge, Button } from "@cloudflare/kumo";
import { ArrowsClockwise, Copy } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { PACK_API, apiPost, errorText } from "./api.js";
import { EDITOR_PANELS, LIST_COLUMNS, packPageOn } from "./extensions.js";
import { AdminLink, PackLink } from "./page.js";
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
	const type = (key: "pageType" | "articleType", fallback: string) => {
		const own = data.override?.[key];
		const value = own ?? data.collectionTypes[key];
		const label = value ? (data.labels[value] ?? value) : fallback;
		return (
			<>
				{label}
				{!own && <span className="text-kumo-subtle"> (from the collection)</span>}
			</>
		);
	};
	const custom = data.override?.custom;
	return (
		<div className="space-y-3">
			{!data.features.graph && <Muted>The Schema.org graph is off, so these types aren't output.</Muted>}
			<dl className="space-y-2">
				<Row label="Page type">{type("pageType", "Web Page")}</Row>
				<Row label="Article type">{type("articleType", "Article")}</Row>
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

// ── Links column ─────────────────────────────────────────────────

/** One request for every row on the page: the cells share the query key (React Query dedupes them). */
export function LinksCell(props: CellProps) {
	const ids = props.visibleItems.map((i) => i.id);
	const query = useQuery({
		queryKey: ["coywolf-pack", "links-column", props.collection, ids],
		queryFn: () => linksPost<{ entries: Record<string, LinkSummary | null> }>("entries/status", { collection: props.collection, ids }, "Couldn't read link status"),
		staleTime: 60_000,
	});
	const summary = query.data?.entries[props.item.id];
	if (query.isLoading) return <span className="text-kumo-subtle" aria-label="Loading">…</span>;
	if (!summary) {
		return (
			<span className="text-kumo-subtle">
				<span aria-hidden="true">-</span>
				<span className="sr-only">No links</span>
			</span>
		);
	}
	const broken = summary.broken + summary.error;
	if (broken) return <Badge variant="destructive">{broken} broken</Badge>;
	if (summary.blocked) return <Badge variant="warning">{summary.blocked} blocked</Badge>;
	return <span className="text-kumo-subtle">{summary.total} OK</span>;
}

// ── What EmDash reads from the admin module ──────────────────────

const PANEL_COMPONENTS: Record<(typeof EDITOR_PANELS)[number]["id"], React.ComponentType<PanelProps>> = { schema: SchemaPanel, ai: AiPanel, links: LinksPanel };

export const contentEditorPanels = EDITOR_PANELS.map(({ page, ...panel }) => ({ ...panel, component: PANEL_COMPONENTS[panel.id], collections: () => packPageOn(page) }));

export const contentListColumns = LIST_COLUMNS.map(({ page, ...column }) => ({ ...column, cell: LinksCell, collections: () => packPageOn(page) }));

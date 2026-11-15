/**
 * Child Pages: set up the "Parent page" field, see the page tree, and import
 * the parents a site listed in its `pageParents` option.
 *
 * Set up and the import go through EmDash's own APIs with the signed-in
 * admin's session (plugins can't add fields; the content API stages and
 * publishes the field like the editor does), the way WordPress Migration sets
 * category parents. The pack's routes only read (src/childPages/pack.ts).
 */
import { Badge, Banner, Button, Select } from "@cloudflare/kumo";
import { ArrowsClockwise, MagnifyingGlass, Plus, TreeStructure } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { PACK_API, apiPost, errorText } from "./api.js";
import { changeReason, changeText, plural, treeCollection, type ChangeStatus, type CollectionStatus, type LoopRef, type MoveRef, type RuleRef, type Shadow } from "./childPages-core.js";
import { useConfirm } from "./confirm-dialog.js";
import { PAGE_WARNINGS } from "./editor-panels.js";
import { useManifestRefresh } from "./manifest.js";
import { AdminLink, DocsLink, FeaturesLink, Loading, PackLink, PageHeader, WarningBadge, softDisabled } from "./page.js";
import { useToast } from "./toast.js";

const post = apiPost(`${PACK_API}/childPages`);
const EMDASH = "/_emdash/api";
const FIELD = "parent_page";

async function send<T>(url: string, method: "POST" | "PUT", body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return parseApiResponse<T>(response, fallback);
}

/** What's unresolved for a collection after its latest change. */
interface OpenIssues {
	collection: string;
	label: string;
	waiting: MoveRef[];
	waitingCount: number;
	loops: LoopRef[];
	shadowed: Shadow[];
}

interface Status {
	enabled: boolean;
	redirects: boolean;
	slugChanges: boolean;
	pageParents: number;
	collections: CollectionStatus[];
	/** The latest changes that moved pages, newest first (every collection's). */
	changes: ChangeStatus[];
	open: OpenIssues[];
}

interface TreePage {
	id: string;
	title: string;
	slug: string | null;
	url: string | null;
	status: string;
	/** The page this one is under in the URL tree. */
	parentId: string | null;
	/** The page its Parent page field names (even when it doesn't count). */
	chosenParentId: string | null;
	depth: number;
	pendingChanges: boolean;
	warnings: string[];
}

interface ImportRow {
	slug: string;
	parentSlug: string;
	action: "set" | "done" | "skip" | "keep";
	reason?: string;
	entryId?: string;
	title?: string;
	parentId?: string;
	parentTitle?: string;
	url?: string | null;
	urlAfter?: string | null;
	/** After Import: what happened. */
	result?: string;
}

function Section(props: { title: string; description: React.ReactNode; children?: React.ReactNode }) {
	const id = `cw-child-pages-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={id}>
			<div className={props.children ? "border-b border-kumo-line p-4" : "p-4"}>
				<h2 id={id} className="text-base font-semibold">
					{props.title}
				</h2>
				<div className="mt-1 text-sm text-kumo-subtle">{props.description}</div>
			</div>
			{props.children && <div className="space-y-4 p-4">{props.children}</div>}
		</section>
	);
}

const Code = ({ children }: { children: string }) => <code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-xs break-all">{children}</code>;

/** A URL that wraps after its slashes (inside a word only when one segment is wider than the line). */
function Url({ children }: { children: string }) {
	const parts = children.split("/");
	return (
		<span className="font-mono text-xs cw-wrap-anywhere">
			{parts.map((part, i) => (
				<React.Fragment key={i}>
					{part}
					{i < parts.length - 1 && (
						<>
							/<wbr />
						</>
					)}
				</React.Fragment>
			))}
		</span>
	);
}

const editPath = (collection: string, id: string) => `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;

// ── Set up ───────────────────────────────────────────────────────

function SetUp(props: { status: Status; onChanged: () => void }) {
	const { status } = props;
	const [confirm, confirmDialog] = useConfirm();
	const [busy, setBusy] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string>();
	const refreshManifest = useManifestRefresh();
	const toast = useToast();
	// Pages first: the collection most sites nest.
	const collections = [...status.collections].sort((a, b) => Number(b.collection === "pages") - Number(a.collection === "pages") || a.label.localeCompare(b.label));

	const setUp = async (c: CollectionStatus) => {
		if (busy !== null || c.conflict) return;
		const ok = await confirm({
			title: `Add a Parent page field to ${c.label}?`,
			description: `Every entry in ${c.label} gets a “Parent page” field in the editor, to choose another entry in ${c.label} as its parent. Nothing else changes until a parent is chosen and published.`,
			confirmLabel: "Add the field",
			variant: "primary",
		});
		if (!ok) return;
		setBusy(c.collection);
		setError(undefined);
		try {
			await send(
				`${EMDASH}/schema/collections/${encodeURIComponent(c.collection)}/fields`,
				"POST",
				{ slug: FIELD, label: "Parent page", type: "reference", required: false, validation: { targetCollection: c.collection } },
				"Couldn't add the field",
			);
			// The editor reads its fields from the admin's manifest.
			refreshManifest();
			toast.success(`Parent page added to ${c.label}`);
			props.onChanged();
		} catch (cause) {
			setError(errorText(cause, "Couldn't add the field"));
		} finally {
			setBusy(null);
		}
	};

	return (
		<Section
			title="Set up"
			description={
				<>
					Adds a <strong>Parent page</strong> field to a collection, with EmDash's own picker in the editor. Plugins can't add fields, so this uses EmDash's
					content type settings with your account (the field shows under <AdminLink to="/content-types">Content Types</AdminLink> too). Pages usually need it.
				</>
			}
		>
			{confirmDialog}
			{error && <Banner variant="error" role="alert" description={error} />}
			<ul role="list" className="divide-y divide-kumo-line rounded-md border border-kumo-line">
				{collections.map((c) => (
					<li key={c.collection} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
						<div className="min-w-0">
							<p className="text-sm font-medium">{c.label}</p>
							<p className="text-xs text-kumo-subtle">
								{c.field
									? c.nests === "configured"
										? "Parent page field added. URLs nest by the urls option's {pagepath}."
										: c.nests === "field"
											? "Parent page field added. URLs nest by it."
											: c.nests === "override"
												? "Parent page field added, but its urls option has no {pagepath}, so URLs don't nest."
												: c.nests === "pattern"
													? "Parent page field added, but its URL pattern has neither {slug} nor {pagepath}, so URLs can't nest."
													: "Parent page field added."
									: c.conflict
										? `It already has a field named parent_page (${c.conflict}), so the Parent page field can't be added.`
										: c.nests === "configured"
											? "No Parent page field. URLs nest only by the pageParents option."
											: "No Parent page field."}
							</p>
						</div>
						{c.field ? (
							<Badge variant="secondary">Ready</Badge>
						) : (
							<Button
								type="button"
								size="sm"
								variant={c.collection === "pages" ? "primary" : "secondary"}
								icon={<Plus aria-hidden="true" />}
								aria-label={busy === c.collection ? `Adding the Parent page field to ${c.label}…` : `Set up ${c.label}`}
								{...softDisabled(busy !== null || Boolean(c.conflict))}
								onClick={() => void setUp(c)}
							>
								{busy === c.collection ? "Adding…" : "Set up"}
							</Button>
						)}
					</li>
				))}
			</ul>
		</Section>
	);
}

// ── The tree ─────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, "secondary" | "outline" | "warning"> = { published: "secondary", draft: "outline", scheduled: "outline" };
const STATUS_LABEL: Record<string, string> = { published: "Published", draft: "Draft", scheduled: "Scheduled", archived: "Archived" };

function TreeList(props: { collection: string; pages: TreePage[]; parent: string | null; depth: number }) {
	const level = props.pages.filter((p) => (p.parentId ?? null) === props.parent);
	if (!level.length || props.depth > 32) return null;
	return (
		<ul role="list" className={props.depth ? "ms-4 space-y-1 border-s border-kumo-line ps-3" : "space-y-1"}>
			{level
				.sort((a, b) => a.title.localeCompare(b.title))
				.map((page) => (
					<li key={page.id} className="min-w-0">
						<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5">
							<AdminLink to={editPath(props.collection, page.id)} className="text-sm font-medium text-kumo-link underline">
								{page.title}
							</AdminLink>
							{page.url && <span className="break-all font-mono text-xs text-kumo-subtle">{page.url}</span>}
							{page.status !== "published" && <Badge variant={STATUS_BADGE[page.status] ?? "outline"}>{STATUS_LABEL[page.status] ?? page.status}</Badge>}
							{page.pendingChanges && <Badge variant="outline">Unpublished changes</Badge>}
							{page.warnings.map((w) => (
								<WarningBadge key={w}>{WARNING_LABELS[w] ?? w}</WarningBadge>
							))}
						</div>
						{/* What each warning means, as text on the page (a title attribute reaches neither keyboards nor touch screens). */}
						{page.warnings.length > 0 && (
							<ul role="list" className="mb-1 space-y-0.5 text-xs text-kumo-subtle">
								{page.warnings.map((w) => (
									<li key={w}>{PAGE_WARNINGS[w] ?? w}</li>
								))}
							</ul>
						)}
						<TreeList collection={props.collection} pages={props.pages} parent={page.id} depth={props.depth + 1} />
					</li>
				))}
		</ul>
	);
}

const WARNING_LABELS: Record<string, string> = {
	loop: "Loop",
	parentUnpublished: "Parent not published",
	parentMissing: "Parent deleted",
	deep: "8+ levels deep",
	digitSlug: "All-digit slug",
};

function Tree(props: { collections: CollectionStatus[]; reloadKey: number }) {
	const withField = props.collections.filter((c) => c.field);
	const [chosen, setChosen] = React.useState<string | null>(null);
	// From the collections as they are now, not as they were when the page loaded: Set up can add the first field later.
	const collection = treeCollection(props.collections, chosen);
	const [state, setState] = React.useState<{ collection?: string; pages?: TreePage[]; nested?: boolean; error?: string; loading: boolean }>({ loading: true });

	React.useEffect(() => {
		if (!collection) {
			// No collection has the field: nothing to read, so nothing is loading.
			setState({ loading: false });
			return;
		}
		let live = true;
		// Another collection's pages aren't shown while this one's load.
		setState((s) => (s.collection === collection ? { ...s, loading: true, error: undefined } : { loading: true }));
		post<{ pages: TreePage[]; nested: boolean }>("tree", { collection }, "Couldn't read the page tree")
			.then((r) => live && setState({ collection, pages: r.pages, nested: r.nested, loading: false }))
			.catch((cause) => live && setState({ error: errorText(cause, "Couldn't read the page tree"), loading: false }));
		return () => {
			live = false;
		};
	}, [collection, props.reloadKey]);

	if (!collection) {
		return (
			<Section title="Page tree" description="Pages by their URLs, as visitors and search engines see them.">
				<p className="text-sm text-kumo-subtle">No collection has a Parent page field yet. Add it under Set up, and its pages are listed here.</p>
			</Section>
		);
	}
	const pages = state.pages ?? [];
	const warned = pages.filter((p) => p.warnings.length).length;
	return (
		<Section
			title="Page tree"
			description={
				<>
					Pages by their URLs, as visitors and search engines see them. Choose a page's parent in the page editor (<strong>Parent page</strong>), then publish
					it. A parent that isn't published, or a loop, leaves a page at the top level until it's fixed.
				</>
			}
		>
			{withField.length > 1 && (
				<Select
					label="Collection"
					value={collection}
					onValueChange={(value: string | null) => value && setChosen(value)}
					items={withField.map((c) => ({ value: c.collection, label: c.label }))}
				/>
			)}
			{state.error && <Banner variant="error" role="alert" description={state.error} />}
			{state.loading && !state.pages ? (
				<Loading label="Loading the page tree…" />
			) : state.error && !state.pages ? null : (
				<>
					<p className="text-sm text-kumo-subtle">
						{plural(pages.length, "page", "pages")}
						{warned ? `, ${plural(warned, "needs", "need")} a look` : ""}.
					</p>
					{pages.length ? <TreeList collection={collection} pages={pages} parent={null} depth={0} /> : <p className="text-sm text-kumo-subtle">No pages yet.</p>}
				</>
			)}
		</Section>
	);
}

// ── Import parents from configuration ───────────────────────────

const ACTION_LABEL: Record<ImportRow["action"], string> = { set: "Set", done: "Already set", skip: "Skipped", keep: "Stays in the option" };
const REASON_TEXT: Record<string, string> = {
	noPage: "No page has this slug.",
	parentNotPage: "The parent isn't a page here (a category, say): keep it in pageParents.",
	otherParent: "Its Parent page is already set to another page.",
	notPublished: "It isn't published (a draft, or scheduled), and setting the parent would publish it. Set its Parent page in the editor instead.",
	pendingChanges: "It has unpublished changes, which publishing would put live. Publish or discard them, then run this again.",
	loop: "That parent would make a loop.",
	parentUnpublished: "The parent isn't published: the URL nests once it is.",
};

function ImportParents(props: { status: Status; onChanged: () => void }) {
	const withField = props.status.collections.filter((c) => c.field);
	const collection = withField.find((c) => c.collection === "pages")?.collection ?? withField[0]?.collection;
	const [rows, setRows] = React.useState<ImportRow[] | null>(null);
	const [running, setRunning] = React.useState<false | "dry" | "apply">(false);
	const [error, setError] = React.useState<string>();
	const [confirm, confirmDialog] = useConfirm();

	if (!props.status.pageParents) return null;

	const dryRun = async () => {
		if (!collection || running) return;
		setRunning("dry");
		setError(undefined);
		try {
			const plan = await post<{ field: boolean; rows: ImportRow[] }>("import/plan", { collection }, "The dry run failed");
			setRows(plan.rows);
		} catch (cause) {
			setError(errorText(cause, "The dry run failed"));
		} finally {
			setRunning(false);
		}
	};

	const toSet = rows?.filter((r) => r.action === "set" && !r.result) ?? [];

	const apply = async () => {
		if (!collection || !rows || !toSet.length || running) return;
		const ok = await confirm({
			title: `Set ${plural(toSet.length, "parent page", "parent pages")}?`,
			description:
				"Each page listed as “Set” gets its Parent page from the pageParents option and is published again, one at a time, as if you had clicked Publish on each (so anything that runs when a page is published runs for each). Their URLs stay the same when the option already nested them.",
			confirmLabel: "Set parents",
			variant: "primary",
		});
		if (!ok) return;
		setRunning("apply");
		setError(undefined);
		const next = rows.map((r) => ({ ...r }));
		for (const row of next) {
			if (row.action !== "set" || row.result || !row.entryId || !row.parentId) continue;
			const base = `${EMDASH}/content/${encodeURIComponent(collection)}/${encodeURIComponent(row.entryId)}`;
			try {
				// Staged in the page's draft, then published: the way the editor saves a reference field.
				await send(base, "PUT", { references: { [FIELD]: [row.parentId] } }, "Couldn't set the parent page");
				await send(`${base}/publish`, "POST", {}, "Couldn't publish the page");
				row.action = "done";
				row.result = "Parent set and published";
			} catch (cause) {
				row.result = `Failed: ${errorText(cause, "unknown error")}`;
			}
			setRows(next.map((r) => ({ ...r })));
		}
		setRows(next);
		setRunning(false);
		props.onChanged();
	};

	return (
		<Section
			title="Import parents from configuration"
			description={
				<>
					<p>
						Moves the parents listed in <Code>pageParents</Code> (in <Code>coywolfPlugin()</Code>, {plural(props.status.pageParents, "page", "pages")}) into each
						page's Parent page field, so they can be changed in the editor. Run the dry run first. Setting the parent publishes the page again, so these are
						skipped:
					</p>
					<ul className="mt-1 list-disc space-y-0.5 ps-5">
						<li>drafts;</li>
						<li>scheduled pages;</li>
						<li>pages with unpublished changes.</li>
					</ul>
					<p className="mt-1">
						Parents that aren't pages (a category) stay in the option. Afterward, the pages that were set can come out of <Code>pageParents</Code>.
					</p>
				</>
			}
		>
			{confirmDialog}
			{!collection ? (
				<p className="text-sm text-kumo-subtle">Set up the Parent page field first.</p>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					<Button type="button" variant="secondary" icon={<MagnifyingGlass aria-hidden="true" />} {...softDisabled(Boolean(running))} onClick={() => void dryRun()}>
						{running === "dry" ? "Checking…" : "Dry run"}
					</Button>
					<Button type="button" variant="primary" icon={<TreeStructure aria-hidden="true" />} {...softDisabled(Boolean(running) || !toSet.length)} onClick={() => void apply()}>
						{running === "apply" ? "Setting parents…" : toSet.length ? `Set ${plural(toSet.length, "parent", "parents")}` : "Set parents"}
					</Button>
				</div>
			)}
			{error && <Banner variant="error" role="alert" description={error} />}
			{rows && (
				<div className="text-sm">
					{/* A list, not a table: each row stacks on a narrow screen (nothing to scroll sideways), and every value keeps its label. */}
					<div className="pb-1 font-medium text-kumo-subtle cw-rows-head" aria-hidden="true">
						<div>Page</div>
						<div>Parent</div>
						<div>What happens</div>
						<div>URL</div>
					</div>
					<ul role="list" aria-label="What the import does for each page in pageParents">
						{rows.map((row) => (
							<li key={row.slug} className="border-t border-kumo-line py-2 cw-rows-item">
								<div className="min-w-0 break-words">
									<span className="text-xs text-kumo-subtle cw-md-sr-only">Page: </span>
									{row.entryId && collection ? <AdminLink to={editPath(collection, row.entryId)}>{row.title ?? row.slug}</AdminLink> : <Code>{row.slug}</Code>}
								</div>
								<div className="min-w-0 break-words">
									<span className="text-xs text-kumo-subtle cw-md-sr-only">Parent: </span>
									{row.parentTitle ?? <Code>{row.parentSlug}</Code>}
								</div>
								<div className="min-w-0">
									<span className="sr-only">What happens: </span>
									{row.action === "skip" ? <WarningBadge>{ACTION_LABEL[row.action]}</WarningBadge> : <Badge variant={row.action === "set" ? "primary" : "outline"}>{ACTION_LABEL[row.action]}</Badge>}
									{(row.result || row.reason) && <span className="mt-0.5 block text-xs text-kumo-subtle">{row.result ?? REASON_TEXT[row.reason ?? ""] ?? row.reason}</span>}
								</div>
								<div className="min-w-0">
									{row.url && (
										<>
											<span className="text-xs text-kumo-subtle cw-md-sr-only">URL: </span>
											<Url>{row.url}</Url>
											{row.urlAfter && row.urlAfter !== row.url && (
												<span className="block">
													<span aria-hidden="true">→ </span>
													<span className="sr-only">becomes </span>
													<Url>{row.urlAfter}</Url>
												</span>
											)}
										</>
									)}
								</div>
							</li>
						))}
					</ul>
				</div>
			)}
		</Section>
	);
}

// ── Redirects ────────────────────────────────────────────────────

const Rule = ({ rule }: { rule: RuleRef }) => (
	<>
		<Code>{rule.source}</Code> → <Code>{rule.target}</Code>
	</>
);

function Redirects(props: { status: Status; onChanged: () => void }) {
	const { changes, open } = props.status;
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const toast = useToast();
	const recheck = async () => {
		if (busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await post("recheck", undefined, "Couldn't re-check the redirects");
			toast.success("Redirects re-checked");
		} catch (cause) {
			setError(errorText(cause, "Couldn't re-check the redirects"));
		} finally {
			setBusy(false);
			props.onChanged();
		}
	};
	const several = new Set(props.status.collections.filter((c) => c.field).map((c) => c.collection)).size > 1;
	return (
		<Section
			title="Redirects"
			description={
				<>
					When a page moves, Slug changes adds the 301 from its old URL and Child Pages adds one for every published page below it (at most 200 a change). The
					rules are listed on <PackLink page="/redirects">Redirect Manager</PackLink>. <strong>Re-check redirects</strong> adds the ones that still wait and looks at
					the problems below again.
				</>
			}
		>
			<Button type="button" variant="secondary" icon={<ArrowsClockwise aria-hidden="true" />} {...softDisabled(busy)} onClick={() => void recheck()}>
				{busy ? "Re-checking…" : "Re-check redirects"}
			</Button>
			{error && <Banner variant="error" role="alert" description={error} />}
			{open.map((issues) => (
				<div key={issues.collection} className="space-y-3 rounded-md border border-kumo-line p-3 text-sm" role="status">
					{several && <h3 className="font-medium">{issues.label}</h3>}
					{issues.loops.length > 0 && (
						<div>
							<p>
								<strong>{plural(issues.loops.length, "redirect wasn't", "redirects weren't")} added</strong>, because a redirect someone else made sends the page's new
								URL back to its old one (a loop). Delete {issues.loops.length === 1 ? "that redirect" : "those redirects"} on{" "}
								<PackLink page="/redirects">Redirect Manager</PackLink>, then click Re-check redirects:
							</p>
							<ul role="list" className="mt-1 list-disc space-y-1 ps-5">
								{issues.loops.map((loop) => (
									<li key={loop.entryId}>
										Delete <Rule rule={loop.rule} />. It sends <Code>{loop.to}</Code> (the new URL of “{loop.title}”) back to <Code>{loop.from}</Code>, so the page
										can't be reached.
									</li>
								))}
							</ul>
						</div>
					)}
					{issues.shadowed.length > 0 && (
						<div>
							<p>
								<strong>
									Another redirect sends {plural(issues.shadowed.length, "page's new URL", "pages' new URLs")} elsewhere
								</strong>
								, so {issues.shadowed.length === 1 ? "that page can't" : "those pages can't"} be reached there. Delete or change{" "}
								{issues.shadowed.length === 1 ? "it" : "them"} on <PackLink page="/redirects">Redirect Manager</PackLink>:
							</p>
							<ul role="list" className="mt-1 list-disc space-y-1 ps-5">
								{issues.shadowed.map((shadow) => (
									<li key={shadow.url}>
										<Rule rule={shadow.rule} /> (the page is at <Code>{shadow.url}</Code>)
									</li>
								))}
							</ul>
						</div>
					)}
					{issues.waitingCount > 0 && (
						<div>
							<p>
								<strong>{plural(issues.waitingCount, "page still waits", "pages still wait")} for a redirect</strong> from {issues.waitingCount === 1 ? "its" : "their"}{" "}
								old URL: more than 200 pages moved at once. Click Re-check redirects to add {issues.waitingCount > 200 ? "the next 200" : "them"}.
							</p>
							<ul role="list" className="mt-1 list-disc space-y-1 ps-5">
								{issues.waiting.map((move) => (
									<li key={move.entryId}>
										<Code>{move.from}</Code> → <Code>{move.to}</Code>
									</li>
								))}
								{issues.waitingCount > issues.waiting.length && <li>And {(issues.waitingCount - issues.waiting.length).toLocaleString()} more.</li>}
							</ul>
						</div>
					)}
				</div>
			))}
			{changes.length > 0 ? (
				<div>
					<h3 className="text-sm font-medium">Latest changes that moved pages</h3>
					<ul role="list" className="mt-1 space-y-1 text-sm text-kumo-subtle">
						{changes.map((change) => (
							<li key={`${change.at}${change.collection}`}>
								{new Date(change.at).toLocaleString()}
								{several ? `, ${change.label}` : ""}: {changeReason(change)}. {changeText(change)}
							</li>
						))}
					</ul>
				</div>
			) : (
				!open.length && <p className="text-sm text-kumo-subtle">No pages have moved yet.</p>
			)}
		</Section>
	);
}

// ── The page ─────────────────────────────────────────────────────

export function ChildPagesPage() {
	const [status, setStatus] = React.useState<Status | null>(null);
	const [error, setError] = React.useState<string>();
	const [reloadKey, setReloadKey] = React.useState(0);

	const load = React.useCallback(() => {
		post<Status>("status", undefined, "Couldn't read Child Pages")
			.then((s) => {
				setStatus(s);
				setError(undefined);
			})
			.catch((cause) => setError(errorText(cause, "Couldn't read Child Pages")));
	}, []);
	React.useEffect(load, [load]);
	const changed = () => {
		load();
		setReloadKey((k) => k + 1);
	};

	return (
		<div className="space-y-6">
			<PageHeader
				title="Child Pages"
				description={
					<>
						Choose a parent page in the page editor, and the page's URL nests under it (<Code>/apps/coywolf-pack/</Code>), with breadcrumbs that use the
						parents' titles and a 301 whenever a page moves. Your theme serves the nested URLs with <Code>loadPageTree</Code> and <Code>resolvePagePath</Code>{" "}
						(see <DocsLink doc="child-pages">Child Pages</DocsLink>).
					</>
				}
				actions={
					<Button type="button" variant="ghost" icon={<ArrowsClockwise aria-hidden="true" />} onClick={changed}>
						Refresh
					</Button>
				}
			/>
			{error && <Banner variant="error" role="alert" description={error} />}
			{!status && !error && <Loading />}
			{status && (
				<>
					{status.enabled && (!status.redirects || !status.slugChanges) && (
						<Banner
							variant="alert"
							description={
								<>
									{!status.redirects ? "Redirect Manager is off" : "Slug changes (part of Redirect Manager) is off"}, so pages that move get no 301 from their
									old URLs. Turn on {!status.redirects ? "Redirect Manager and its Slug changes part" : "Slug changes"} on <FeaturesLink />.
								</>
							}
						/>
					)}
					<SetUp status={status} onChanged={changed} />
					<Tree collections={status.collections} reloadKey={reloadKey} />
					<ImportParents status={status} onChanged={changed} />
					<Redirects status={status} onChanged={changed} />
				</>
			)}
		</div>
	);
}

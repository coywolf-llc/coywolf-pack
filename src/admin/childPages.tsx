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
import { useConfirm } from "./confirm-dialog.js";
import { PAGE_WARNINGS } from "./editor-panels.js";
import { useManifestRefresh } from "./manifest.js";
import { AdminLink, DocsLink, FeaturesLink, Loading, PackLink, PageHeader } from "./page.js";
import { useToast } from "./toast.js";

const post = apiPost(`${PACK_API}/childPages`);
const EMDASH = "/_emdash/api";
const FIELD = "parent_page";

async function send<T>(url: string, method: "POST" | "PUT", body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return parseApiResponse<T>(response, fallback);
}

interface CollectionStatus {
	collection: string;
	label: string;
	field: boolean;
	conflict: string | null;
	urlPattern: string | null;
	nests: "configured" | "field" | "override" | null;
}

interface ChangeStatus {
	at: string;
	collection: string;
	reason: string;
	moved: number;
	written: number;
	skipped: number;
	redirectsOff: boolean;
	shadowed?: string[];
}

interface Status {
	enabled: boolean;
	redirects: boolean;
	slugChanges: boolean;
	pageParents: number;
	collections: CollectionStatus[];
	lastChange: ChangeStatus | null;
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

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

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
												: "Parent page field added. URLs nest once Child Pages is on."
									: c.conflict
										? `It already has a field named parent_page (${c.conflict}), so the Parent page field can't be added.`
										: c.nests === "configured"
											? "No Parent page field. URLs nest only by the pageParents option."
											: "No Parent page field."}
							</p>
						</div>
						{c.field ? (
							<Badge variant="secondary">Set up</Badge>
						) : (
							<Button type="button" size="sm" variant={c.collection === "pages" ? "primary" : "secondary"} icon={<Plus aria-hidden="true" />} disabled={busy !== null || Boolean(c.conflict)} onClick={() => void setUp(c)}>
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
							{page.status !== "published" && <Badge variant={STATUS_BADGE[page.status] ?? "outline"}>{page.status}</Badge>}
							{page.pendingChanges && <Badge variant="outline">Unpublished changes</Badge>}
							{page.warnings.map((w) => (
								<Badge key={w} variant="warning">
									<span title={PAGE_WARNINGS[w]}>{WARNING_LABELS[w] ?? w}</span>
								</Badge>
							))}
						</div>
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
	const [collection, setCollection] = React.useState(withField.find((c) => c.collection === "pages")?.collection ?? withField[0]?.collection ?? "");
	const [state, setState] = React.useState<{ pages?: TreePage[]; nested?: boolean; error?: string; loading: boolean }>({ loading: true });

	React.useEffect(() => {
		if (!collection) return;
		let live = true;
		setState((s) => ({ ...s, loading: true, error: undefined }));
		post<{ pages: TreePage[]; nested: boolean }>("tree", { collection }, "Couldn't read the page tree")
			.then((r) => live && setState({ pages: r.pages, nested: r.nested, loading: false }))
			.catch((cause) => live && setState({ error: errorText(cause, "Couldn't read the page tree"), loading: false }));
		return () => {
			live = false;
		};
	}, [collection, props.reloadKey]);

	if (!withField.length) return null;
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
					onValueChange={(value: string | null) => value && setCollection(value)}
					items={withField.map((c) => ({ value: c.collection, label: c.label }))}
				/>
			)}
			{state.error && <Banner variant="error" role="alert" description={state.error} />}
			{state.loading && !state.pages ? (
				<Loading label="Loading the page tree…" />
			) : (
				<>
					<p className="text-sm text-kumo-subtle">
						{plural(pages.length, "page", "pages")}
						{warned ? `, ${plural(warned, "needs", "need")} a look` : ""}.
						{state.nested === false && " Child Pages is off: these URLs ignore the Parent page field."}
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
		if (!collection) return;
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
		if (!collection || !rows || !toSet.length) return;
		const ok = await confirm({
			title: `Set ${plural(toSet.length, "parent page", "parent pages")}?`,
			description: "Each page listed as “Set” gets its Parent page from the pageParents option and is published again. Their URLs stay the same when the option already nested them.",
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
					Moves the parents listed in <Code>pageParents</Code> (in <Code>coywolfPlugin()</Code>, {plural(props.status.pageParents, "page", "pages")}) into each page's
					Parent page field, so they can be changed in the editor. Run the dry run first. Pages with unpublished changes are skipped, because setting the parent
					publishes the page. Parents that aren't pages (a category) stay in the option. Afterward, the pages that were set can come out of{" "}
					<Code>pageParents</Code>.
				</>
			}
		>
			{confirmDialog}
			{!collection ? (
				<p className="text-sm text-kumo-subtle">Set up the Parent page field first.</p>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="secondary" icon={<MagnifyingGlass aria-hidden="true" />} disabled={Boolean(running)} onClick={() => void dryRun()}>
						{running === "dry" ? "Checking…" : "Dry run"}
					</Button>
					<Button variant="primary" icon={<TreeStructure aria-hidden="true" />} disabled={Boolean(running) || !toSet.length} onClick={() => void apply()}>
						{running === "apply" ? "Setting parents…" : toSet.length ? `Set ${plural(toSet.length, "parent", "parents")}` : "Set parents"}
					</Button>
				</div>
			)}
			{error && <Banner variant="error" role="alert" description={error} />}
			{rows && (
				<div className="overflow-x-auto">
					<table className="w-full text-start text-sm">
						<caption className="sr-only">What the import does for each page in pageParents</caption>
						<thead className="text-kumo-subtle">
							<tr>
								<th scope="col" className="py-1 pe-3 text-start font-medium">
									Page
								</th>
								<th scope="col" className="py-1 pe-3 text-start font-medium">
									Parent
								</th>
								<th scope="col" className="py-1 pe-3 text-start font-medium">
									What happens
								</th>
								<th scope="col" className="py-1 text-start font-medium">
									URL
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.slug} className="border-t border-kumo-line align-top">
									<td className="py-1.5 pe-3">{row.entryId && collection ? <AdminLink to={editPath(collection, row.entryId)}>{row.title ?? row.slug}</AdminLink> : <Code>{row.slug}</Code>}</td>
									<td className="py-1.5 pe-3">{row.parentTitle ?? <Code>{row.parentSlug}</Code>}</td>
									<td className="py-1.5 pe-3">
										<Badge variant={row.action === "set" ? "primary" : row.action === "skip" ? "warning" : "outline"}>{ACTION_LABEL[row.action]}</Badge>
										{(row.result || row.reason) && <span className="mt-0.5 block text-xs text-kumo-subtle">{row.result ?? REASON_TEXT[row.reason ?? ""] ?? row.reason}</span>}
									</td>
									<td className="py-1.5 font-mono text-xs break-all">
										{row.url ?? ""}
										{row.urlAfter && row.urlAfter !== row.url && <span className="block">→ {row.urlAfter}</span>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
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

	const last = status?.lastChange;
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
					{!status.enabled && (
						<Banner
							variant="default"
							description={
								<>
									Child Pages is off: you can set up the field and choose parents, but URLs don't use them until it's turned on on <FeaturesLink />.
								</>
							}
						/>
					)}
					{status.enabled && (!status.redirects || !status.slugChanges) && (
						<Banner
							variant="alert"
							description={
								<>
									{!status.redirects ? "Redirect Manager is off" : "Slug changes (part of Redirect Manager) is off"}, so pages that move get no 301 from their
									old URLs. Turn {!status.redirects ? "Redirect Manager and its Slug changes part" : "Slug changes"} on on <FeaturesLink />.
								</>
							}
						/>
					)}
					<SetUp status={status} onChanged={changed} />
					<Tree collections={status.collections} reloadKey={reloadKey} />
					<ImportParents status={status} onChanged={changed} />
					{last && (
						<p className="text-sm text-kumo-subtle">
							Last change: {last.reason.toLowerCase()} ({new Date(last.at).toLocaleString()}). {plural(last.moved, "other page", "other pages")} moved
							{last.redirectsOff ? ", with no redirects (Redirect Manager or Slug changes is off)" : `; ${plural(last.written, "redirect", "redirects")} added`}
							{last.skipped ? `; ${plural(last.skipped, "page", "pages")} over the limit got none` : ""}. See them on <PackLink page="/redirects">Redirect Manager</PackLink>.
						</p>
					)}
					{last?.shadowed?.length ? (
						<Banner
							variant="alert"
							description={
								<>
									Another redirect still sends {plural(last.shadowed.length, "page's new URL", "pages' new URLs")} elsewhere, so{" "}
									{last.shadowed.length === 1 ? "that page can't" : "those pages can't"} be reached there. Remove or change {last.shadowed.length === 1 ? "it" : "them"} on{" "}
									<PackLink page="/redirects">Redirect Manager</PackLink>:
									<ul role="list" className="mt-1 space-y-0.5">
										{last.shadowed.map((url) => (
											<li key={url}>
												<Code>{url}</Code>
											</li>
										))}
									</ul>
								</>
							}
						/>
					) : null}
				</>
			)}
		</div>
	);
}

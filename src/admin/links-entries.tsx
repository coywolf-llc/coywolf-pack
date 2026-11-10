/**
 * Link Manager's Entries view (the "Inbound links and orphans" part): every
 * published entry with how many entries link to it, orphans first, and for
 * each orphan the entries that share its categories or tags, where a link
 * to it would fit. Plus the view switch between Links and Entries.
 */
import { Badge, Banner, Button, Input, Select, Tabs } from "@cloudflare/kumo";
import { ArrowSquareOut, DownloadSimple, LinkSimple, Lightbulb } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { toCsv } from "../core/csv.js";
import { PACK_API, apiPost, errorText } from "./api.js";
import { saveFile, siteSlug, today } from "./download.js";
import { FEATURES_CHANGED } from "./feature-switches.js";
import { Loading, PageHeader } from "./page.js";
import { LinksPage } from "./links.js";

const post = apiPost(`${PACK_API}/links`);
const ADMIN = "/_emdash/admin";
const PAGE_SIZE = 50;
const VIEW_KEY = "coywolf-pack:links-view";

interface Entry {
	collection: string;
	id: string;
	title: string;
	path: string | null;
	inbound: number;
	noIndex: boolean;
	publishedAt: string | null;
	updatedAt: string | null;
}

interface EntriesResponse {
	siteUrlKnown: boolean;
	scannedAt: string | null;
	scanning?: boolean;
	entries: Entry[];
	matched: number;
	unmatched: number;
	builtAt: string;
}

type Show = "all" | "orphans" | "linked";
type Sort = "fewest" | "most" | "title" | "updated";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const formatDate = (value: string | null) => {
	if (!value) return "";
	const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
	return Number.isFinite(parsed) ? dateFormat.format(new Date(parsed)) : "";
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const editorHref = (collection: string, id: string) => `${ADMIN}/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
const isOrphan = (e: Entry) => e.inbound === 0 && !e.noIndex && Boolean(e.path);

/** The related entries for one orphan: where to add a link to it from. */
function Suggestions(props: { entry: Entry; related: Array<{ id: string; shared: number }> | undefined; titles: Map<string, Entry> }) {
	if (!props.related) return <p className="text-xs text-kumo-subtle">Looking for related entries…</p>;
	if (!props.related.length)
		return <p className="text-xs text-kumo-subtle">No other entry shares a category or tag with it. Link to it from an entry on the same subject, or from a page that lists entries like it.</p>;
	return (
		<div className="text-xs">
			<p className="text-kumo-subtle">Add a link to it from one of these (they share its categories or tags):</p>
			<ul className="mt-1 space-y-1">
				{props.related.map((r) => {
					const other = props.titles.get(`${props.entry.collection}/${r.id}`);
					return (
						<li key={r.id} className="flex flex-wrap items-center gap-x-2">
							<a className="font-medium text-kumo-link hover:underline" href={editorHref(props.entry.collection, r.id)}>
								{other?.title ?? r.id}
							</a>
							<span className="text-kumo-subtle">
								shares {plural(r.shared, "term")}
								{other ? ` · ${plural(other.inbound, "inbound link")}` : ""}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export function LinkedEntriesView(props: { views?: React.ReactNode }) {
	const [data, setData] = React.useState<EntriesResponse>();
	const [error, setError] = React.useState<string>();
	const [show, setShow] = React.useState<Show>("orphans");
	const [sort, setSort] = React.useState<Sort>("fewest");
	const [collection, setCollection] = React.useState("all");
	const [query, setQuery] = React.useState("");
	const [page, setPage] = React.useState(0);
	const [related, setRelated] = React.useState<Record<string, Array<{ id: string; shared: number }>>>({});
	const [loading, setLoading] = React.useState(false);

	const load = React.useCallback(async () => {
		setLoading(true);
		setError(undefined);
		try {
			setData(await post<EntriesResponse>("entries", {}, "Couldn't count inbound links"));
			setRelated({});
		} catch (cause) {
			setError(errorText(cause, "Couldn't count inbound links"));
		} finally {
			setLoading(false);
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);
	React.useEffect(() => setPage(0), [show, sort, collection, query]);

	const entries = data?.entries ?? [];
	const titles = React.useMemo(() => new Map(entries.map((e) => [`${e.collection}/${e.id}`, e])), [entries]);
	const collections = React.useMemo(() => [...new Set(entries.map((e) => e.collection))].sort(), [entries]);
	const orphans = entries.filter(isOrphan).length;

	const filtered = React.useMemo(() => {
		const q = query.trim().toLowerCase();
		const list = entries.filter((e) => {
			if (collection !== "all" && e.collection !== collection) return false;
			if (show === "orphans" && !isOrphan(e)) return false;
			if (show === "linked" && e.inbound === 0) return false;
			return !q || e.title.toLowerCase().includes(q) || (e.path ?? "").toLowerCase().includes(q);
		});
		const byTitle = (a: Entry, b: Entry) => a.title.localeCompare(b.title, "en-US");
		const updated = (e: Entry) => Date.parse(e.updatedAt ?? "") || 0;
		return list.sort(sort === "most" ? (a, b) => b.inbound - a.inbound || byTitle(a, b) : sort === "title" ? byTitle : sort === "updated" ? (a, b) => updated(b) - updated(a) : (a, b) => a.inbound - b.inbound || byTitle(a, b));
	}, [entries, show, sort, collection, query]);

	const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	// Related entries for the orphans on this page: one request (one D1 batch) per page.
	const visibleOrphans = visible.filter(isOrphan).filter((e) => !related[`${e.collection}/${e.id}`]);
	const wantKey = visibleOrphans.map((e) => `${e.collection}/${e.id}`).join("|");
	React.useEffect(() => {
		if (!wantKey) return;
		let live = true;
		const ask = visibleOrphans.map((e) => ({ collection: e.collection, id: e.id }));
		post<{ related: Record<string, Array<{ id: string; shared: number }>> }>("related", { entries: ask })
			.then((result) => live && setRelated((r) => ({ ...r, ...result.related })))
			.catch(() => live && setRelated((r) => ({ ...r, ...Object.fromEntries(ask.map((e) => [`${e.collection}/${e.id}`, []])) })));
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [wantKey]);

	const exportCsv = () => {
		const rows = [["Title", "Collection", "Path", "Inbound links", "Orphan", "No index", "Updated", "Editor"], ...filtered.map((e) => [e.title, e.collection, e.path ?? "", e.inbound, isOrphan(e) ? "yes" : "no", e.noIndex ? "yes" : "no", e.updatedAt ?? "", `${location.origin}${editorHref(e.collection, e.id)}`])];
		saveFile(toCsv(rows, { guard: true }), `inbound-links-${show}-${siteSlug() || "site"}-${today()}.csv`, "text/csv");
	};

	return (
		<div className="space-y-6">
			<PageHeader
				title="Link Manager"
				actions={
					<>
						<Button variant="secondary" icon={<DownloadSimple />} disabled={!filtered.length} onClick={exportCsv}>
							Export CSV
						</Button>
						<Button variant="secondary" disabled={loading} onClick={() => void load()}>
							{loading ? "Counting…" : "Count again"}
						</Button>
					</>
				}
				description={
					<>
						How many of your entries link to each published entry. <strong>Orphans</strong> are published entries (not set to No index) that no other
						entry links to, so readers and search engines find them only through menus, lists or search. Links in your theme (navigation, footers,
						category pages) aren't counted, only links in content.
					</>
				}
			>
				{props.views}
				<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
					<div className="sm:w-48">
						<Select
							label="Show"
							value={show}
							onValueChange={(v: string | null) => setShow((v ?? "orphans") as Show)}
							items={[
								{ value: "orphans", label: "Orphans" },
								{ value: "linked", label: "Linked entries" },
								{ value: "all", label: "All entries" },
							]}
						/>
					</div>
					<div className="sm:w-48">
						<Select
							label="Collection"
							value={collection}
							onValueChange={(v: string | null) => setCollection(v ?? "all")}
							items={[{ value: "all", label: "All collections" }, ...collections.map((c) => ({ value: c, label: c }))]}
						/>
					</div>
					<div className="sm:w-64">
						<Select
							label="Sort by"
							value={sort}
							onValueChange={(v: string | null) => setSort((v ?? "fewest") as Sort)}
							items={[
								{ value: "fewest", label: "Fewest inbound links" },
								{ value: "most", label: "Most inbound links" },
								{ value: "title", label: "Title" },
								{ value: "updated", label: "Recently updated" },
							]}
						/>
					</div>
					<div className="sm:w-64">
						<Input label="Search" placeholder="Title or path" value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} />
					</div>
				</div>
			</PageHeader>

			<div aria-live="polite" className="space-y-3">
				{data && !data.siteUrlKnown && (
					<Banner variant="error" title="Set your site URL" description="Link Manager needs the site URL (Settings → General, or site in astro.config) to tell internal links from external ones." />
				)}
				{data?.siteUrlKnown && !data.scannedAt && (
					<Banner variant="default" title="Your content hasn't been scanned yet" description="Counts come from Link Manager's index. Open Links (above) and select Scan content, then count again." />
				)}
				{data?.scanning && <Banner variant="default" title="A scan is under way" description="Counts may change when it finishes." />}
				{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			</div>

			{data && data.entries.length > 0 && (
				<p className="text-sm text-kumo-subtle" role="status">
					{plural(data.entries.length, "published entry", "published entries")} · {plural(orphans, "orphan")} · {plural(data.matched, "internal link")} matched to an entry
					{data.unmatched ? ` (${plural(data.unmatched, "other internal link")}, such as to the home page or a category, ${data.unmatched === 1 ? "isn't" : "aren't"} an entry)` : ""}
					{data.scannedAt ? ` · index from ${formatDate(data.scannedAt)}` : ""}
				</p>
			)}

			{!data && !error ? (
				<Loading label="Counting inbound links…" />
			) : data && filtered.length === 0 ? (
				<div className="py-10 text-center text-kumo-subtle">
					<LinkSimple size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
					<p className="text-base font-medium">{show === "orphans" && entries.length ? "No orphans" : "No entries match"}</p>
					<p className="mt-1 text-sm">{show === "orphans" && entries.length ? "Every published entry is linked from at least one other entry." : "Try another filter."}</p>
				</div>
			) : data ? (
				<div className="rounded-lg border">
					<table className="w-full text-sm">
						<thead className="border-b bg-kumo-tint/50 text-start text-kumo-subtle">
							<tr>
								<th scope="col" className="px-4 py-2 text-start font-medium">
									Entry
								</th>
								<th scope="col" className="px-4 py-2 text-end font-medium">
									Inbound links
								</th>
								<th scope="col" className="cw-md-table-cell px-4 py-2 text-start font-medium">
									Updated
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-kumo-line">
							{visible.map((e) => {
								const key = `${e.collection}/${e.id}`;
								return (
									<tr key={key} className="align-top">
										<td className="px-4 py-2">
											<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
												<a className="font-medium text-kumo-link hover:underline" href={editorHref(e.collection, e.id)}>
													{e.title}
												</a>
												<span className="text-xs text-kumo-subtle">{e.collection}</span>
												{e.noIndex && <Badge variant="outline">No index</Badge>}
											</div>
											{e.path && (
												<a className="mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-kumo-subtle hover:underline" href={e.path} target="_blank" rel="noopener noreferrer">
													{e.path}
													<ArrowSquareOut size={12} aria-hidden="true" />
												</a>
											)}
											{!e.path && <p className="mt-0.5 text-xs text-kumo-subtle">No public URL</p>}
											{isOrphan(e) && (
												<div className="mt-2 flex gap-2 rounded-md border border-kumo-line px-3 py-2">
													<Lightbulb size={16} className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
													<Suggestions entry={e} related={related[key]} titles={titles} />
												</div>
											)}
										</td>
										<td className="px-4 py-2 text-end">{isOrphan(e) ? <Badge variant="warning">Orphan</Badge> : <span className="font-medium">{e.inbound.toLocaleString("en-US")}</span>}</td>
										<td className="cw-md-table-cell whitespace-nowrap px-4 py-2 text-kumo-subtle">{formatDate(e.updatedAt)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			) : null}

			{data && pages > 1 && (
				<nav className="flex items-center justify-between text-sm" aria-label="Pagination">
					<span className="text-kumo-subtle">
						Page {page + 1} of {pages} · {plural(filtered.length, "entry", "entries")}
					</span>
					<div className="flex gap-2">
						<Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
							Previous
						</Button>
						<Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
							Next
						</Button>
					</div>
				</nav>
			)}
		</div>
	);
}

// ── The page: Links or Entries ───────────────────────────────────

type View = "links" | "entries";

function storedView(): View {
	try {
		return sessionStorage.getItem(VIEW_KEY) === "entries" ? "entries" : "links";
	} catch {
		return "links";
	}
}

/** Link Manager: the Links view, plus Entries while "Inbound links and orphans" is on. */
export function LinkManagerPage() {
	const [view, setView] = React.useState<View>(storedView);
	const [entriesOn, setEntriesOn] = React.useState(false);

	React.useEffect(() => {
		let live = true;
		apiFetch(`${PACK_API}/features/list`)
			.then((r) => parseApiResponse<{ modules: Array<{ id: string; features: Array<{ id: string; enabled: boolean }> }> }>(r, "Couldn't load the feature switches"))
			.then(({ modules }) => {
				const links = modules.find((m) => m.id === "links")?.features ?? [];
				if (live) setEntriesOn(Boolean(links.find((f) => f.id === "links")?.enabled && links.find((f) => f.id === "links.inbound")?.enabled));
			})
			.catch(() => undefined);
		const changed = (event: Event) => {
			const features = (event as CustomEvent<Record<string, boolean>>).detail;
			if (features && "links.inbound" in features) setEntriesOn(Boolean(features["links.inbound"] && features.links !== false));
		};
		window.addEventListener(FEATURES_CHANGED, changed);
		return () => {
			live = false;
			window.removeEventListener(FEATURES_CHANGED, changed);
		};
	}, []);

	const choose = (next: View) => {
		setView(next);
		try {
			sessionStorage.setItem(VIEW_KEY, next);
		} catch {
			// Private mode: the choice lasts until the page is left.
		}
	};

	const views = entriesOn ? (
		<Tabs
			value={view}
			onValueChange={(v: string) => choose(v === "entries" ? "entries" : "links")}
			tabs={[
				{ value: "links", label: "Links" },
				{ value: "entries", label: "Entries" },
			]}
		/>
	) : null;
	return entriesOn && view === "entries" ? <LinkedEntriesView views={views} /> : <LinksPage views={views} />;
}

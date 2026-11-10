/**
 * Insights page (Coywolf Pack → Insights): one card per report, each with its
 * part's switch next to its title. Off: the title, switch and description
 * only. On: its settings (when it has any), the report, a Refresh button, or
 * the steps that are missing. Reports come from the insights/* routes
 * (src/insights/pack.ts), kept in plugin KV for an hour (Search Console six).
 */
import { Badge, Banner, Button, Input, InputArea } from "@cloudflare/kumo";
import { ArrowsClockwise, ArrowSquareOut, Trash } from "@phosphor-icons/react";
import * as React from "react";

import { PACK_API, apiGet, apiPost, errorText } from "./api.js";
import { useConfirm } from "./confirm-dialog.js";
import { FEATURES_CHANGED, PartSwitch, useParts } from "./feature-switches.js";
import { CredentialGuide, type GuideId } from "./guides.js";
import { DocsLink, FeaturesLink, Loading, PackLink, PageHeader } from "./page.js";
import { redirectPrefillHref } from "./redirect-prefill.js";
import { useUnsavedChanges } from "./save-bar.js";
import { useToast } from "./toast.js";
import { type EdgeReport, type PathCount, redirectable } from "../insights/edge-core.js";
import type { FathomPage, FathomReport } from "../insights/fathom-core.js";
import type { GscReport, GscRow } from "../insights/gsc-core.js";
import type { ReportState } from "../insights/report-cache.js";
import type { SearchQueryCount, SearchReport } from "../insights/search.js";
import { type Metric, type Rating, type Vitals, type VitalsReport, rate } from "../insights/vitals-core.js";
import { categoryLabel } from "../robots/bots.js";

const API = `${PACK_API}/insights`;
const get = apiGet(API);
const post = apiPost(API);

interface Status {
	beaconToken: string;
	fathomSiteId: string;
	fathomKeySaved: boolean;
	fathomKeyUnreadable: boolean;
	searchConsoleProperty: string;
	googleEmail: string | null;
	googleKeyUnreadable: boolean;
	cloudflareToken: boolean;
	searchOn: boolean;
	mediaHost: string | null;
}

// ── Formatting ───────────────────────────────────────────────────

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const num = (n: number) => (n < 10_000 ? Math.round(n).toLocaleString("en-US") : compact.format(n));
const pct = (part: number, of: number) => {
	const p = of > 0 ? (part / of) * 100 : 0;
	return p === 0 ? "0%" : p < 0.1 ? "<0.1%" : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
};
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const RATING_LABEL: Record<Rating, string> = { good: "Good", "needs-improvement": "Needs improvement", poor: "Poor" };
const RATING_BADGE: Record<Rating, "primary" | "secondary" | "destructive"> = { good: "primary", "needs-improvement": "secondary", poor: "destructive" };

function metricText(metric: Metric, v: Vitals): string {
	const value = metric === "lcp" ? v.lcpMs : metric === "inp" ? v.inpMs : v.cls;
	if (value === null) return "—";
	if (metric === "cls") return value.toFixed(2);
	return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

/** A value with its rating as words (never color alone). */
function Rated(props: { metric: Metric; v: Vitals }) {
	const value = props.metric === "lcp" ? props.v.lcpMs : props.metric === "inp" ? props.v.inpMs : props.v.cls;
	const rating = rate(props.metric, value);
	return (
		<span className="inline-flex flex-wrap items-center gap-2">
			<span className="tabular-nums">{metricText(props.metric, props.v)}</span>
			{rating && <Badge variant={RATING_BADGE[rating]}>{RATING_LABEL[rating]}</Badge>}
		</span>
	);
}

// ── Shared pieces ────────────────────────────────────────────────

/** A report from its route: loaded while `on`, again with Refresh. */
function useReport<T>(route: string, on: boolean, query = "") {
	const [data, setData] = React.useState<ReportState<T>>();
	const [error, setError] = React.useState<string>();
	const [loading, setLoading] = React.useState(false);
	const load = React.useCallback(
		async (refresh = false) => {
			setLoading(true);
			setError(undefined);
			try {
				const params = [query, refresh ? "refresh=1" : ""].filter(Boolean).join("&");
				setData(await get<ReportState<T>>(`${route}${params ? `?${params}` : ""}`, "Couldn't load the report"));
			} catch (cause) {
				setError(errorText(cause, "Couldn't load the report"));
			} finally {
				setLoading(false);
			}
		},
		[route, query],
	);
	React.useEffect(() => {
		if (on) void load();
	}, [on, load]);
	return { data, error, loading, load };
}

function Th(props: { children: React.ReactNode; end?: boolean }) {
	return (
		<th scope="col" className={`py-1 cw-pe-4 font-medium${props.end ? " text-end" : ""}`}>
			{props.children}
		</th>
	);
}

function Table(props: { caption: string; head: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-start text-sm">
				<caption className="sr-only">{props.caption}</caption>
				<thead className="text-kumo-subtle">
					<tr>{props.head}</tr>
				</thead>
				<tbody className="divide-y divide-kumo-line">{props.children}</tbody>
			</table>
		</div>
	);
}

/** A path that may be long: wraps anywhere, readable in full. */
const Path = (props: { children: React.ReactNode }) => <span className="break-all font-mono text-xs">{props.children}</span>;

/** One report's card, with its part's switch next to the title (like Discovery's sections). */
function Card(props: {
	id: string;
	title: string;
	part: string;
	parts: ReturnType<typeof useParts>;
	description: React.ReactNode;
	actions?: React.ReactNode;
	busy?: boolean;
	children: React.ReactNode;
}) {
	const { parts } = props;
	const open = parts.parts ? parts.isOn(props.part) : false;
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={`insights-${props.id}`} aria-busy={props.busy || undefined}>
			<div className={`flex flex-wrap items-start justify-between gap-4 p-4${open ? " border-b border-kumo-line" : ""}`}>
				<div className="min-w-0 max-w-2xl">
					<h2 id={`insights-${props.id}`} className="flex items-center gap-2 text-base font-semibold">
						{props.title}
						<PartSwitch part={parts.parts?.find((p) => p.id === props.part)} mainOn={Boolean(parts.main?.enabled)} saving={parts.saving} onToggle={(id, on) => void parts.toggle(id, on)} />
					</h2>
					<div className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">{props.description}</div>
				</div>
				{open && props.actions && <div className="flex shrink-0 flex-wrap gap-2">{props.actions}</div>}
			</div>
			{open && <div className="space-y-5 p-4">{props.children}</div>}
		</section>
	);
}

function RefreshButton(props: { loading: boolean; onClick: () => void }) {
	return (
		<Button variant="secondary" icon={<ArrowsClockwise />} disabled={props.loading} onClick={props.onClick}>
			{props.loading ? "Refreshing…" : "Refresh"}
		</Button>
	);
}

/** Loading, a failure, missing setup (with its guide), or the report. */
function ReportBody<T>(props: { report: ReturnType<typeof useReport<T>>; guide: GuideId; kept: string; children: (report: T) => React.ReactNode }) {
	const { data, error } = props.report;
	if (error) return <Banner variant="error" role="alert" description={error} />;
	if (!data) return <Loading className="flex justify-center py-6" />;
	if (data.state !== "ready") {
		return (
			<div className="space-y-3">
				<Banner variant={data.state === "error" ? "error" : "default"} description={data.state === "error" ? data.message : data.reason} />
				<div className="max-w-2xl">
					<CredentialGuide id={props.guide} />
				</div>
			</div>
		);
	}
	return (
		<>
			{props.children(data.report)}
			<p className="text-xs text-kumo-subtle">
				Updated {when(data.at)}. {props.kept}
			</p>
			{data.notes.length > 0 && <Banner variant="default" description={data.notes.join(" ")} />}
		</>
	);
}

// ── Edge errors and crawlers ─────────────────────────────────────

function pathLabel(row: PathCount, host: string) {
	return row.host === host ? row.path : `${row.host}${row.path}`;
}

function EdgeCard(props: { parts: ReturnType<typeof useParts> }) {
	const on = props.parts.isOn("insights.edge");
	const report = useReport<EdgeReport>("edge", on);
	return (
		<Card
			id="edge"
			title="Edge errors and crawlers"
			part="insights.edge"
			parts={props.parts}
			busy={report.loading}
			description="What Cloudflare answered for the site in the last 30 days: missing paths (files, images and the media host included, which EmDash's own 404 log never sees), server errors, and requests per crawler. From Cloudflare's sampled analytics, so counts are estimates."
			actions={report.data?.state === "ready" ? <RefreshButton loading={report.loading} onClick={() => void report.load(true)} /> : undefined}
		>
			<ReportBody report={report} guide="insights-token" kept="Kept for an hour.">
				{(r) => {
					const notFound = r.statuses.filter((s) => s.status === 404 || s.status === 410).reduce((sum, s) => sum + s.count, 0);
					return (
						<>
							<p className="text-sm">
								Last {r.days} days: about {num(r.requests)} requests to {r.host}
								{r.mediaHost ? ` and ${r.mediaHost}` : ""}, {num(notFound)} not found or gone, and {num(r.serverErrors.count)} server errors ({pct(r.serverErrors.count, r.requests)}).
							</p>
							<div className="space-y-2">
								<h3 className="text-sm font-medium">Not found (404) and gone (410)</h3>
								{r.notFound.length === 0 ? (
									<p className="text-sm text-kumo-subtle">No missing paths in the last {r.days} days.</p>
								) : (
									<Table
										caption="Paths that answered 404 or 410, most requested first"
										head={
											<>
												<Th>Path</Th>
												<Th>Status</Th>
												<Th end>Requests</Th>
												<Th>
													<span className="sr-only">Action</span>
												</Th>
											</>
										}
									>
										{r.notFound.map((row) => (
											<tr key={`${row.host}${row.path}${row.status}`}>
												<td className="py-2 cw-pe-4">
													<Path>{pathLabel(row, r.host)}</Path>
												</td>
												<td className="py-2 cw-pe-4">{row.status}</td>
												<td className="py-2 cw-pe-4 text-end tabular-nums">{num(row.count)}</td>
												<td className="py-2 cw-pe-4 whitespace-nowrap">
													{redirectable(row) ? (
														<a className="text-kumo-link underline" href={redirectPrefillHref(row.path)}>
															Create redirect<span className="sr-only"> for {row.path}</span>
														</a>
													) : row.media ? (
														<span className="text-kumo-subtle">Cloudflare rule</span>
													) : null}
												</td>
											</tr>
										))}
									</Table>
								)}
								{r.notFound.some((row) => row.media) && (
									<p className="text-xs text-kumo-subtle">
										{r.mediaHost} is served by R2 without the Worker, so the Redirect Manager can't redirect it: use a Cloudflare redirect rule for those (the site's domain → Rules → Redirect Rules).
									</p>
								)}
							</div>

							<div className="space-y-2">
								<h3 className="text-sm font-medium">Server errors (5xx)</h3>
								{r.serverErrors.count === 0 ? (
									<p className="text-sm text-kumo-subtle">None in the last {r.days} days.</p>
								) : (
									<>
										<p className="text-sm text-kumo-subtle">
											By status:{" "}
											{r.statuses
												.filter((s) => s.status >= 500)
												.map((s) => `${s.status} (${num(s.count)})`)
												.join(", ")}
											. 52x statuses come from Cloudflare when the Worker didn't answer in time or at all.
										</p>
										<Table caption="Paths that answered with a server error, most first" head={<><Th>Path</Th><Th>Status</Th><Th end>Requests</Th></>}>
											{r.serverErrors.paths.map((row) => (
												<tr key={`${row.host}${row.path}${row.status}`}>
													<td className="py-2 cw-pe-4">
														<Path>{pathLabel(row, r.host)}</Path>
													</td>
													<td className="py-2 cw-pe-4">{row.status}</td>
													<td className="py-2 cw-pe-4 text-end tabular-nums">{num(row.count)}</td>
												</tr>
											))}
										</Table>
									</>
								)}
							</div>

							<div className="space-y-2">
								<h3 className="text-sm font-medium">Crawlers</h3>
								{r.crawlers.length === 0 ? (
									<p className="text-sm text-kumo-subtle">No known crawlers among the most common user agents.</p>
								) : (
									<Table caption="Requests per crawler" head={<><Th>Crawler</Th><Th>Kind</Th><Th end>Requests</Th></>}>
										{r.crawlers.map((c) => (
											<tr key={c.name}>
												<th scope="row" className="py-2 cw-pe-4 font-normal">
													{c.name}
												</th>
												<td className="py-2 cw-pe-4">{categoryLabel(c.category)}</td>
												<td className="py-2 cw-pe-4 text-end tabular-nums">{num(c.count)}</td>
											</tr>
										))}
									</Table>
								)}
								<p className="text-xs text-kumo-subtle">
									Named from the user agent, using the crawler directory of <PackLink page="/robots">Robots.txt</PackLink> (a user agent can claim to be anyone).
									{r.otherBots > 0 ? ` Another ${num(r.otherBots)} requests came from bots the directory doesn't know.` : ""}
								</p>
								{r.verifiedCategories && r.verifiedCategories.length > 0 && (
									<p className="text-sm">
										Bots Cloudflare verified:{" "}
										{r.verifiedCategories.map((v) => `${v.category} (${num(v.count)})`).join(", ")}.
									</p>
								)}
							</div>
						</>
					);
				}}
			</ReportBody>
		</Card>
	);
}

// ── Core Web Vitals and the beacon ───────────────────────────────

function VitalsCard(props: { parts: ReturnType<typeof useParts>; status: Status; tokenDraft: string; setTokenDraft: (v: string) => void; saveToken: () => Promise<void>; saving: boolean }) {
	const on = props.parts.isOn("insights.vitals");
	const beaconPart = props.parts.parts?.find((p) => p.id === "insights.beacon");
	const report = useReport<VitalsReport>("vitals", on);
	const tokenDirty = props.tokenDraft.trim().toLowerCase() !== props.status.beaconToken;
	return (
		<Card
			id="vitals"
			title="Core Web Vitals"
			part="insights.vitals"
			parts={props.parts}
			busy={report.loading}
			description="How fast the site is for real visitors: Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift at the 75th percentile, from Cloudflare Web Analytics."
			actions={report.data?.state === "ready" ? <RefreshButton loading={report.loading} onClick={() => void report.load(true)} /> : undefined}
		>
			<div className="space-y-3 rounded-md border border-kumo-line p-3">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0 max-w-xl">
						<h3 className="flex items-center gap-2 text-sm font-medium">
							Web Analytics beacon
							<PartSwitch part={beaconPart} mainOn={Boolean(props.parts.main?.enabled)} saving={props.parts.saving} onToggle={(id, value) => void props.parts.toggle(id, value)} />
						</h3>
						<p className="mt-0.5 text-sm text-kumo-subtle">
							Adds Cloudflare's beacon to every public page with this token. No cookies or localStorage, no fingerprinting, no query strings. Pages that already have the beacon don't get a second one. The token is
							public (every page carries it), so it's stored as a plain setting.
						</p>
					</div>
				</div>
				<form
					className="flex flex-wrap items-end gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						void props.saveToken();
					}}
				>
					<div className="min-w-0 grow sm:max-w-md">
						<Input
							label="Web Analytics token"
							placeholder="32 letters and digits"
							autoComplete="off"
							spellCheck={false}
							value={props.tokenDraft}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.setTokenDraft(e.target.value)}
						/>
					</div>
					<Button type="submit" variant="secondary" disabled={!tokenDirty || props.saving}>
						{props.saving ? "Saving…" : "Save token"}
					</Button>
				</form>
				{beaconPart?.enabled && !props.status.beaconToken && <Banner variant="default" description="The beacon part is on, but no token is saved yet: pages get no beacon until there is one." />}
				<div className="max-w-2xl">
					<CredentialGuide id="web-analytics" />
				</div>
			</div>
			<ReportBody report={report} guide="insights-token" kept="Kept for an hour.">
				{(r) => (
					<>
						{r.month.count === 0 ? (
							<p className="text-sm text-kumo-subtle">No measurements in the last 30 days yet. They show after the first visits with the beacon.</p>
						) : (
							<Table caption="Core Web Vitals at the 75th percentile" head={<><Th>Metric (75th percentile)</Th><Th>Last 7 days</Th><Th>Last 30 days</Th></>}>
								{(
									[
										["lcp", "Largest Contentful Paint"],
										["inp", "Interaction to Next Paint"],
										["cls", "Cumulative Layout Shift"],
									] as Array<[Metric, string]>
								).map(([metric, label]) => (
									<tr key={metric}>
										<th scope="row" className="py-2 cw-pe-4 font-normal">
											{label}
										</th>
										<td className="py-2 cw-pe-4">
											<Rated metric={metric} v={r.week} />
										</td>
										<td className="py-2 cw-pe-4">
											<Rated metric={metric} v={r.month} />
										</td>
									</tr>
								))}
								<tr>
									<th scope="row" className="py-2 cw-pe-4 font-normal text-kumo-subtle">
										Page views measured
									</th>
									<td className="py-2 cw-pe-4 tabular-nums text-kumo-subtle">{num(r.week.count)}</td>
									<td className="py-2 cw-pe-4 tabular-nums text-kumo-subtle">{num(r.month.count)}</td>
								</tr>
							</Table>
						)}
						{r.slowPages.length > 0 && (
							<div className="space-y-2">
								<h3 className="text-sm font-medium">Slowest of the most visited pages (last 30 days)</h3>
								<Table caption="The slowest pages by Largest Contentful Paint" head={<><Th>Page</Th><Th>LCP</Th><Th>INP</Th><Th>CLS</Th><Th end>Views</Th></>}>
									{r.slowPages.map((p) => (
										<tr key={p.path}>
											<td className="py-2 cw-pe-4">
												<Path>{p.path}</Path>
											</td>
											<td className="py-2 cw-pe-4">
												<Rated metric="lcp" v={p} />
											</td>
											<td className="py-2 cw-pe-4">{metricText("inp", p)}</td>
											<td className="py-2 cw-pe-4">{metricText("cls", p)}</td>
											<td className="py-2 cw-pe-4 text-end tabular-nums">{num(p.count)}</td>
										</tr>
									))}
								</Table>
							</div>
						)}
						<p className="text-xs text-kumo-subtle">
							Good is up to 2.5 s for LCP, 200 ms for INP and 0.1 for CLS; poor is over 4 s, 500 ms and 0.25. CLS is measured in Chromium browsers only.
							{r.autoInstall ? " Cloudflare's automatic setup is on for this site too; the pack's beacon skips pages that already have Cloudflare's." : ""}
						</p>
					</>
				)}
			</ReportBody>
		</Card>
	);
}

// ── Fathom ───────────────────────────────────────────────────────

function PagesTable(props: { caption: string; pages: FathomPage[] }) {
	if (!props.pages.length) return <p className="text-sm text-kumo-subtle">No pageviews.</p>;
	return (
		<Table caption={props.caption} head={<><Th>Page</Th><Th end>Pageviews</Th><Th end>Unique</Th></>}>
			{props.pages.map((p) => (
				<tr key={p.path}>
					<td className="py-2 cw-pe-4">
						<Path>{p.path}</Path>
					</td>
					<td className="py-2 cw-pe-4 text-end tabular-nums">{num(p.pageviews)}</td>
					<td className="py-2 cw-pe-4 text-end tabular-nums">{num(p.uniques)}</td>
				</tr>
			))}
		</Table>
	);
}

interface ProviderDraft {
	fathomSiteId: string;
	fathomApiKey: string;
	searchConsoleProperty: string;
	googleKey: string;
}

function FathomCard(props: { parts: ReturnType<typeof useParts>; status: Status; draft: ProviderDraft; set: (patch: Partial<ProviderDraft>) => void; save: (extra?: Record<string, unknown>) => Promise<void>; saving: boolean; version: number }) {
	const on = props.parts.isOn("insights.fathom");
	const report = useReport<FathomReport>("fathom", on, `v=${props.version}`);
	const dirty = props.draft.fathomSiteId.trim().toUpperCase() !== props.status.fathomSiteId || Boolean(props.draft.fathomApiKey.trim());
	return (
		<Card
			id="fathom"
			title="Traffic (Fathom)"
			part="insights.fathom"
			parts={props.parts}
			busy={report.loading}
			description="Visitors, pageviews and the most viewed pages for the last 7 and 30 days, from the site's Fathom Analytics account."
			actions={report.data?.state === "ready" ? <RefreshButton loading={report.loading} onClick={() => void report.load(true)} /> : undefined}
		>
			<form
				className="grid gap-3 sm:grid-cols-2"
				onSubmit={(e) => {
					e.preventDefault();
					void props.save();
				}}
			>
				<Input label="Fathom site ID" placeholder="ABCDEFGH" autoComplete="off" spellCheck={false} value={props.draft.fathomSiteId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.set({ fathomSiteId: e.target.value })} />
				<Input
					type="password"
					autoComplete="off"
					label={props.status.fathomKeySaved ? "Fathom API key (saved)" : "Fathom API key"}
					placeholder={props.status.fathomKeySaved ? "••••••••••••••••••••" : "Read-only key"}
					value={props.draft.fathomApiKey}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.set({ fathomApiKey: e.target.value })}
				/>
				<div>
					<Button type="submit" variant="secondary" disabled={!dirty || props.saving}>
						{props.saving ? "Saving…" : "Save"}
					</Button>
				</div>
			</form>
			{props.status.fathomKeySaved && (
				<p className="text-xs text-kumo-subtle">
					The key is stored encrypted and never shown again. Type a new one to replace it, or{" "}
					<button type="button" className="text-kumo-link underline" disabled={props.saving} onClick={() => void props.save({ clearFathomApiKey: true })}>
						remove it
					</button>
					.
				</p>
			)}
			<ReportBody report={report} guide="fathom" kept="Kept for an hour (each Fathom API request counts toward the plan's pageviews).">
				{(r) => (
					<>
						<Table caption="Visitors and pageviews" head={<><Th>Fathom site {r.siteId}</Th><Th end>Last 7 days</Th><Th end>Last 30 days</Th></>}>
							<tr>
								<th scope="row" className="py-2 cw-pe-4 font-normal">
									Visitors
								</th>
								<td className="py-2 cw-pe-4 text-end tabular-nums">{num(r.week.visitors)}</td>
								<td className="py-2 cw-pe-4 text-end tabular-nums">{num(r.month.visitors)}</td>
							</tr>
							<tr>
								<th scope="row" className="py-2 cw-pe-4 font-normal">
									Pageviews
								</th>
								<td className="py-2 cw-pe-4 text-end tabular-nums">{num(r.week.pageviews)}</td>
								<td className="py-2 cw-pe-4 text-end tabular-nums">{num(r.month.pageviews)}</td>
							</tr>
						</Table>
						<div className="grid gap-5 lg:grid-cols-2">
							<div className="space-y-2">
								<h3 className="text-sm font-medium">Top pages, last 7 days</h3>
								<PagesTable caption="Most viewed pages in the last 7 days" pages={r.weekPages} />
							</div>
							<div className="space-y-2">
								<h3 className="text-sm font-medium">Top pages, last 30 days</h3>
								<PagesTable caption="Most viewed pages in the last 30 days" pages={r.monthPages} />
							</div>
						</div>
						<p className="text-xs text-kumo-subtle">Days are counted in the site's time zone in Fathom ({r.timeZone}), as on Fathom's dashboard.</p>
					</>
				)}
			</ReportBody>
		</Card>
	);
}

// ── Google Search Console ────────────────────────────────────────

function GscTable(props: { caption: string; label: string; rows: GscRow[]; origin?: string }) {
	if (!props.rows.length) return <p className="text-sm text-kumo-subtle">Nothing yet.</p>;
	return (
		<Table caption={props.caption} head={<><Th>{props.label}</Th><Th end>Clicks</Th><Th end>Impressions</Th><Th end>CTR</Th><Th end>Position</Th></>}>
			{props.rows.map((row) => (
				<tr key={row.key}>
					<td className="py-2 cw-pe-4">{props.origin ? <Path>{row.key.startsWith(props.origin) ? row.key.slice(props.origin.length) || "/" : row.key}</Path> : <span className="break-words">{row.key}</span>}</td>
					<td className="py-2 cw-pe-4 text-end tabular-nums">{num(row.clicks)}</td>
					<td className="py-2 cw-pe-4 text-end tabular-nums">{num(row.impressions)}</td>
					<td className="py-2 cw-pe-4 text-end tabular-nums">{pct(row.ctr, 1)}</td>
					<td className="py-2 cw-pe-4 text-end tabular-nums">{row.position.toFixed(1)}</td>
				</tr>
			))}
		</Table>
	);
}

function SearchConsoleCard(props: { parts: ReturnType<typeof useParts>; status: Status; draft: ProviderDraft; set: (patch: Partial<ProviderDraft>) => void; save: (extra?: Record<string, unknown>) => Promise<void>; saving: boolean; version: number }) {
	const on = props.parts.isOn("insights.searchConsole");
	const report = useReport<GscReport>("search-console", on, `v=${props.version}`);
	const dirty = props.draft.searchConsoleProperty.trim() !== props.status.searchConsoleProperty || Boolean(props.draft.googleKey.trim());
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	return (
		<Card
			id="search-console"
			title="Google Search Console"
			part="insights.searchConsole"
			parts={props.parts}
			busy={report.loading}
			description="How the site does in Google Search over the last 28 days: clicks, impressions, click-through rate, average position, and the top queries and pages."
			actions={report.data?.state === "ready" ? <RefreshButton loading={report.loading} onClick={() => void report.load(true)} /> : undefined}
		>
			<form
				className="grid gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					void props.save();
				}}
			>
				<div className="sm:max-w-md">
					<Input
						label="Property"
						description="Empty: the property the service account can see for this site. Or sc-domain:example.com, or a URL prefix ending in /."
						placeholder="sc-domain:example.com"
						autoComplete="off"
						spellCheck={false}
						value={props.draft.searchConsoleProperty}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.set({ searchConsoleProperty: e.target.value })}
					/>
				</div>
				<InputArea
					label={props.status.googleEmail ? `Service account key (saved: ${props.status.googleEmail})` : "Service account key"}
					description="Paste the whole JSON key file. It's stored encrypted; only the service account's email is shown afterward."
					placeholder={props.status.googleEmail ? "Paste a new key to replace the saved one" : '{ "type": "service_account", … }'}
					rows={3}
					spellCheck={false}
					autoComplete="off"
					value={props.draft.googleKey}
					onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => props.set({ googleKey: e.target.value })}
				/>
				<div className="flex flex-wrap items-center gap-3">
					<Button type="submit" variant="secondary" disabled={!dirty || props.saving}>
						{props.saving ? "Saving…" : "Save"}
					</Button>
					{props.status.googleEmail && (
						<button type="button" className="text-sm text-kumo-link underline" disabled={props.saving} onClick={() => void props.save({ clearGoogleKey: true })}>
							Remove the saved key
						</button>
					)}
				</div>
			</form>
			{props.status.googleEmail && (
				<p className="text-xs text-kumo-subtle">
					Add <code className="rounded bg-kumo-tint px-1">{props.status.googleEmail}</code> as a user on the site's property in Search Console (Settings → Users and permissions), with Restricted permission.
				</p>
			)}
			<ReportBody report={report} guide="search-console" kept="Kept for six hours.">
				{(r) => (
					<>
						<p className="text-sm text-kumo-subtle">
							{r.property}, {day(r.startDate)} to {day(r.endDate)} (Pacific Time){r.incompleteFrom ? `; from ${day(r.incompleteFrom)} the numbers may still change` : ""}.
						</p>
						<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
							{[
								["Clicks", num(r.totals.clicks)],
								["Impressions", num(r.totals.impressions)],
								["Click-through rate", pct(r.totals.ctr, 1)],
								["Average position", r.totals.position ? r.totals.position.toFixed(1) : "—"],
							].map(([label, value]) => (
								<div key={label} className="rounded-md border border-kumo-line p-3">
									<dt className="text-xs text-kumo-subtle">{label}</dt>
									<dd className="text-lg font-semibold tabular-nums">{value}</dd>
								</div>
							))}
						</dl>
						<div className="space-y-2">
							<h3 className="text-sm font-medium">Top queries</h3>
							<GscTable caption="Top search queries by clicks" label="Query" rows={r.queries} />
						</div>
						<div className="space-y-2">
							<h3 className="text-sm font-medium">Top pages</h3>
							<GscTable caption="Top pages by clicks" label="Page" rows={r.pages} origin={origin} />
						</div>
					</>
				)}
			</ReportBody>
		</Card>
	);
}

// ── Search insights ──────────────────────────────────────────────

function QueryTable(props: { caption: string; rows: SearchQueryCount[] }) {
	return (
		<Table caption={props.caption} head={<><Th>Search</Th><Th end>Times</Th><Th end>No results</Th></>}>
			{props.rows.map((row) => (
				<tr key={row.q}>
					<td className="py-2 cw-pe-4 break-words">{row.q}</td>
					<td className="py-2 cw-pe-4 text-end tabular-nums">{num(row.searches)}</td>
					<td className="py-2 cw-pe-4 text-end tabular-nums">{num(row.noResults)}</td>
				</tr>
			))}
		</Table>
	);
}

function SearchCard(props: { parts: ReturnType<typeof useParts>; status: Status }) {
	const on = props.parts.isOn("insights.search");
	const [days, setDays] = React.useState<30 | 90>(30);
	const report = useReport<SearchReport>("searches", on, `days=${days}`);
	const [confirm, confirmDialog] = useConfirm();
	const toast = useToast();
	const [clearing, setClearing] = React.useState(false);
	const clear = async () => {
		if (!(await confirm({ title: "Delete the search counts?", description: "Every counted search is deleted now. Counting goes on while Search insights is on.", confirmLabel: "Delete" }))) return;
		setClearing(true);
		try {
			const { deleted } = await post<{ deleted: number }>("searches/clear", undefined, "Couldn't delete the search counts");
			toast.success("Search counts deleted", `${num(deleted)} ${deleted === 1 ? "row" : "rows"}.`);
			await report.load();
		} catch (cause) {
			toast.error("Couldn't delete the search counts", errorText(cause, "Something went wrong"));
		} finally {
			setClearing(false);
		}
	};
	return (
		<Card
			id="search"
			title="Search insights"
			part="insights.search"
			parts={props.parts}
			busy={report.loading}
			description="What visitors search for on the site, and the searches that found nothing: the cheapest list of missing content a site has."
			actions={
				<>
					<div role="group" aria-label="Period" className="inline-flex gap-1">
						{([30, 90] as const).map((d) => (
							<Button key={d} variant={days === d ? "primary" : "secondary"} aria-pressed={days === d} onClick={() => setDays(d)}>
								{d} days
							</Button>
						))}
					</div>
					<Button variant="secondary" icon={<Trash />} disabled={clearing} onClick={() => void clear()}>
						{clearing ? "Deleting…" : "Delete search data"}
					</Button>
				</>
			}
		>
			{confirmDialog}
			{!props.status.searchOn && (
				<Banner
					variant="default"
					description={
						<>
							Search is off, so nothing is counted. Turn it on on <FeaturesLink />.
						</>
					}
				/>
			)}
			{report.error && <Banner variant="error" role="alert" description={report.error} />}
			{!report.data && !report.error && <Loading className="flex justify-center py-6" />}
			{report.data?.state === "error" && <Banner variant="error" description={report.data.message} />}
			{report.data?.state === "ready" &&
				(() => {
					const r = report.data.report;
					return (
						<>
							<p className="text-sm">
								{r.searches === 0
									? `No searches counted in the last ${r.days} days yet.`
									: `Last ${r.days} days: ${num(r.searches)} searches counted, ${num(r.noResults)} of them found nothing (${pct(r.noResults, r.searches)}).`}
								{r.since && r.searches > 0 ? ` Counting since ${day(r.since)}.` : ""}
							</p>
							<div className="grid gap-5 lg:grid-cols-2">
								<div className="space-y-2">
									<h3 className="text-sm font-medium">Top searches</h3>
									{r.top.length ? <QueryTable caption="The most frequent searches" rows={r.top} /> : <p className="text-sm text-kumo-subtle">None searched {r.minShown} times on {r.minDays} different days yet.</p>}
								</div>
								<div className="space-y-2">
									<h3 className="text-sm font-medium">Searches with no results</h3>
									{r.zero.length ? <QueryTable caption="Searches that found nothing, most often first" rows={r.zero} /> : <p className="text-sm text-kumo-subtle">None searched {r.minShown} times on {r.minDays} different days.</p>}
								</div>
							</div>
						</>
					);
				})()}
			<p className="text-xs text-kumo-subtle">
				Counts searches the site answered: the search page's, and the ones a visitor settled on in live results (they stopped typing for a moment or opened a result; a search typed, left for a moment and then submitted counts twice). Search pages Cloudflare answers from its edge cache never reach the site, and clicks on results aren't counted. Only the query text and daily counts are stored, never who searched. Queries that look like an email, a phone or card number, or a key are dropped, but names and short codes can't be told from ordinary words. A search is listed only once it's been searched 3 times on 2 different days, which keeps out one-off searches (the counts can't tell visitors apart). Counts older than 90 days are deleted every day.
			</p>
		</Card>
	);
}

// ── The page ─────────────────────────────────────────────────────

const emptyDraft = (s: Status): ProviderDraft => ({ fathomSiteId: s.fathomSiteId, fathomApiKey: "", searchConsoleProperty: s.searchConsoleProperty, googleKey: "" });

export function InsightsPage() {
	const parts = useParts("insights");
	const toast = useToast();
	const [status, setStatus] = React.useState<Status>();
	const [error, setError] = React.useState<string>();
	const [draft, setDraft] = React.useState<ProviderDraft>({ fathomSiteId: "", fathomApiKey: "", searchConsoleProperty: "", googleKey: "" });
	const [token, setToken] = React.useState("");
	const [saving, setSaving] = React.useState<"providers" | "beacon" | null>(null);
	/** Bumped after a provider save, so the cards read again with the new settings. */
	const [version, setVersion] = React.useState(0);

	const apply = React.useCallback((next: Status) => {
		setStatus(next);
		setDraft(emptyDraft(next));
		setToken(next.beaconToken);
	}, []);

	React.useEffect(() => {
		get<Status>("status", "Couldn't load Insights").then(apply, (cause) => setError(errorText(cause, "Couldn't load Insights")));
	}, [apply]);
	// A part switched on elsewhere on the page: nothing to reload here (each card loads when its part turns on).
	React.useEffect(() => {
		const refresh = () => void get<Status>("status").then(setStatus, () => undefined);
		window.addEventListener(FEATURES_CHANGED, refresh);
		return () => window.removeEventListener(FEATURES_CHANGED, refresh);
	}, []);

	const providersDirty = Boolean(status) && (draft.fathomSiteId.trim().toUpperCase() !== status?.fathomSiteId || draft.searchConsoleProperty.trim() !== status?.searchConsoleProperty || Boolean(draft.fathomApiKey.trim() || draft.googleKey.trim()));
	const tokenDirty = Boolean(status) && token.trim().toLowerCase() !== status?.beaconToken;

	const saveProviders = async (extra: Record<string, unknown> = {}) => {
		if (!status) return;
		setSaving("providers");
		try {
			const body: Record<string, unknown> = { ...extra };
			if (draft.fathomSiteId.trim().toUpperCase() !== status.fathomSiteId) body.fathomSiteId = draft.fathomSiteId;
			if (draft.fathomApiKey.trim()) body.fathomApiKey = draft.fathomApiKey;
			if (draft.searchConsoleProperty.trim() !== status.searchConsoleProperty) body.searchConsoleProperty = draft.searchConsoleProperty;
			if (draft.googleKey.trim()) body.googleKey = draft.googleKey;
			apply(await post<Status>("settings/save", body, "Couldn't save"));
			setVersion((v) => v + 1);
			toast.success("Saved");
		} catch (cause) {
			toast.error("Couldn't save", errorText(cause, "Something went wrong"));
		} finally {
			setSaving(null);
		}
	};

	const saveToken = async () => {
		setSaving("beacon");
		try {
			const next = await post<Status>("beacon/save", { token }, "Couldn't save the token");
			setStatus(next);
			setToken(next.beaconToken);
			toast.success(next.beaconToken ? "Token saved" : "Token removed", next.beaconToken ? "Cached pages were cleared, so they get the beacon while its part is on." : undefined);
		} catch (cause) {
			toast.error("Couldn't save the token", errorText(cause, "Something went wrong"));
		} finally {
			setSaving(null);
		}
	};

	const leaveDialog = useUnsavedChanges(providersDirty || tokenDirty, () => {
		if (providersDirty) void saveProviders();
		if (tokenDirty) void saveToken();
	});

	const anyOn = parts.parts?.some((p) => p.enabled);
	return (
		<div className="space-y-6">
			<PageHeader
				title="Insights"
				description={
					<>
						Reports from Cloudflare, Fathom, Google Search Console and the site's own search, each with its own switch. Every report reads only, with a key or token you add here or on the plugin's Settings page, and is kept for a while so the providers' limits are never hit. See{" "}
						<DocsLink doc="insights">the Insights docs</DocsLink>.
					</>
				}
			/>
			{parts.error && <Banner variant="error" role="alert" description={parts.error} />}
			{error && <Banner variant="error" role="alert" description={error} />}
			{parts.parts && !anyOn && <Banner variant="default" description="Every report is off. Turn on the ones you want with the switch next to each title." />}
			{!status || !parts.parts ? (
				<Loading label="Loading Insights…" />
			) : (
				<>
					{!status.cloudflareToken && (parts.isOn("insights.edge") || parts.isOn("insights.vitals")) && (
						<Banner
							variant="default"
							description={
								<>
									The Cloudflare reports use the read-only token from the <PackLink page="/performance">Performance page</PackLink>'s usage card, with two zone permissions added. The steps are in each card.
								</>
							}
						/>
					)}
					<EdgeCard parts={parts} />
					<VitalsCard parts={parts} status={status} tokenDraft={token} setTokenDraft={setToken} saveToken={saveToken} saving={saving === "beacon"} />
					<FathomCard parts={parts} status={status} draft={draft} set={(patch) => setDraft((d) => ({ ...d, ...patch }))} save={saveProviders} saving={saving === "providers"} version={version} />
					<SearchConsoleCard parts={parts} status={status} draft={draft} set={(patch) => setDraft((d) => ({ ...d, ...patch }))} save={saveProviders} saving={saving === "providers"} version={version} />
					<SearchCard parts={parts} status={status} />
					<p className="text-xs text-kumo-subtle">
						External services: <ExternalNote />
					</p>
				</>
			)}
			{leaveDialog}
		</div>
	);
}

function ExternalNote() {
	return (
		<>
			Cloudflare's API (api.cloudflare.com), Fathom's (api.usefathom.com) and Google's (oauth2.googleapis.com, www.googleapis.com), only from this page and only for reports that are on.{" "}
			<a className="inline-flex items-center gap-1 text-kumo-link underline" href="https://developers.cloudflare.com/web-analytics/" target="_blank" rel="noreferrer">
				About Web Analytics
				<ArrowSquareOut aria-hidden="true" />
			</a>
		</>
	);
}

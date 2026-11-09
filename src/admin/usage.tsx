/**
 * Cloudflare usage: a card on the Performance page and a dashboard widget.
 * This site's D1 and Workers usage, the account's against its plan, the
 * estimated bill, and the cache warmer's share (an estimate from sampled
 * Workers Logs). Data from cache/usage (kept an hour; Refresh reads again).
 */
import { Banner, Button, Loader } from "@cloudflare/kumo";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { FREE, PAID } from "../pageCache/usage-core.js";
import type { UsageResult } from "../pageCache/usage.js";
import { errorText } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/cache/usage";
const ADMIN = "/_emdash/admin";

type Report = Extract<UsageResult, { configured: true }>;
type Totals = Report["periods"]["day"]["site"];

function useUsage() {
	const [data, setData] = React.useState<UsageResult>();
	const [error, setError] = React.useState<string>();
	const [loading, setLoading] = React.useState(false);
	const load = React.useCallback(async (refresh = false) => {
		setLoading(true);
		setError(undefined);
		try {
			setData(await parseApiResponse<UsageResult>(await apiFetch(`${API}${refresh ? "?refresh=1" : ""}`), "Couldn't load usage"));
		} catch (cause) {
			setError(errorText(cause, "Couldn't load usage"));
		} finally {
			setLoading(false);
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);
	return { data, error, loading, load };
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const num = (n: number) => (n < 10_000 ? Math.round(n).toLocaleString("en-US") : compact.format(n));
const cpu = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 3_600_000 ? `${num(ms / 1000)} s` : `${(ms / 3_600_000).toFixed(1)} h`);
const bytes = (b: number | null) => (b === null ? "—" : b < 1e6 ? `${Math.round(b / 1e3)} KB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(2)} GB`);
const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (used: number, of: number) => {
	const p = of > 0 ? (used / of) * 100 : 0;
	return p === 0 ? "0%" : p < 0.1 ? "<0.1%" : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
};

/** The account against the plan: Paid compares the last 30 days with the monthly allowance; Free, the last 24 hours with the daily limits. */
function allowances(r: Report) {
	if (r.plan === "free") {
		const a = r.periods.day.account;
		return {
			window: "today (UTC), against Workers Free's daily limits, which reset at 00:00 UTC",
			rows: [
				{ label: "Workers requests", used: a.workers.requests, of: FREE.daily.requests, show: num },
				{ label: "D1 rows read", used: a.d1.rowsRead, of: FREE.daily.rowsRead, show: num },
				{ label: "D1 rows written", used: a.d1.rowsWritten, of: FREE.daily.rowsWritten, show: num },
				{ label: "D1 storage", used: r.storage.accountBytes, of: FREE.storageBytes, show: (b: number) => bytes(b) },
			],
		};
	}
	const a = r.periods.month.account;
	const m = PAID.monthly;
	return {
		window: "the last 30 days (UTC dates, including today), against what Workers Paid includes each month",
		rows: [
			{ label: "Workers requests", used: a.workers.requests, of: m.requests, show: num },
			{ label: "Workers CPU time", used: a.workers.cpuMs, of: m.cpuMs, show: cpu },
			{ label: "D1 rows read", used: a.d1.rowsRead, of: m.rowsRead, show: num },
			{ label: "D1 rows written", used: a.d1.rowsWritten, of: m.rowsWritten, show: num },
			{ label: "D1 storage", used: r.storage.accountBytes, of: m.storageBytes, show: (b: number) => bytes(b) },
		],
	};
}

const planName = (r: Report) => (r.plan === "free" ? "Workers Free" : r.plan === "paid" ? "Workers Paid" : "Workers Paid (assumed)");

function billText(r: Report): string {
	if (r.plan === "free") return "Workers Free costs nothing; requests over the daily limits fail instead of being billed.";
	const extra = Object.entries(r.bill.overage).filter(([, v]) => v > 0);
	const names: Record<string, string> = { requests: "requests", cpu: "CPU time", rowsRead: "D1 rows read", rowsWritten: "D1 rows written", storage: "D1 storage" };
	return extra.length
		? `About ${money(r.bill.total)} a month: the ${money(r.bill.base)} base plus ${extra.map(([k, v]) => `${money(v)} for ${names[k]}`).join(", ")}.`
		: `About ${money(r.bill.total)} a month: the ${money(r.bill.base)} Workers Paid base, with nothing over the included amounts.`;
}

const SITE_ROWS: Array<{ label: string; value: (t: Totals) => string }> = [
	{ label: "Workers requests", value: (t) => num(t.workers.requests) },
	{ label: "Workers CPU time", value: (t) => cpu(t.workers.cpuMs) },
	{ label: "D1 rows read", value: (t) => num(t.d1.rowsRead) },
	{ label: "D1 rows written", value: (t) => num(t.d1.rowsWritten) },
	{ label: "D1 queries", value: (t) => num(t.d1.readQueries + t.d1.writeQueries) },
];

function Setup(props: { reason: string }) {
	return (
		<div className="space-y-3 text-sm">
			<p className="text-kumo-subtle">{props.reason}</p>
			<ol className="space-y-1" style={{ listStyle: "decimal", paddingInlineStart: "1.25rem" }}>
				<li>Cloudflare dashboard → Manage Account → Account API Tokens → Create Token → Create Custom Token.</li>
				<li>Add Account → Account Analytics → Read.</li>
				<li>Add Workers → Metadata Read-Only, for All Workers (finds this site's Worker and database, and reads Workers Logs for the cache-warming estimate).</li>
				<li>Add Account → Account Settings → Read (detects your plan).</li>
				<li>Optional: add Zone → Zone → Read (all zones, or this site's), so the Discovery page can show whether Crawler Hints is on.</li>
				<li>Create the token and copy it (it's shown once).</li>
				<li>
					Set it as the <code>USAGE_API_TOKEN</code> Worker secret (one token works for every site in the account), or paste it in Cloudflare usage on the plugin's Settings page.
				</li>
			</ol>
		</div>
	);
}

/** The Performance page card. */
export function UsageCard() {
	const { data, error, loading, load } = useUsage();
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby="cw-usage-title">
			<div className="flex flex-wrap items-start justify-between gap-4 border-b border-kumo-line p-4">
				<div className="min-w-0 max-w-2xl">
					<h2 id="cw-usage-title" className="text-base font-semibold">
						Cloudflare usage
					</h2>
					<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
						What this site uses on Cloudflare (Workers and its D1 database), and the whole account against its plan. Read from Cloudflare's analytics and kept for an hour.
					</p>
				</div>
				{data?.configured && (
					<Button className="shrink-0" variant="secondary" icon={<ArrowsClockwise />} disabled={loading} onClick={() => void load(true)}>
						{loading ? "Refreshing…" : "Refresh"}
					</Button>
				)}
			</div>
			<div className="space-y-6 p-4">
				<p className="sr-only" role="status">
					{loading ? "Loading Cloudflare usage…" : data?.configured ? `Cloudflare usage updated ${new Date(data.at).toLocaleString()}.` : ""}
				</p>
				{error && <Banner variant="error" role="alert" description={error} />}
				{!data && !error && (
					<div className="flex justify-center py-6">
						<Loader />
					</div>
				)}
				{data && !data.configured && <Setup reason={data.reason} />}
				{data?.configured && <Details r={data} />}
			</div>
		</section>
	);
}

function Details(props: { r: Report }) {
	const { r } = props;
	const plan = allowances(r);
	return (
		<>
			<div className="space-y-1">
				<p className="text-base font-semibold">{billText(r)}</p>
				<p className="text-sm text-kumo-subtle">
					{planName(r)}
					{r.planSource === "usage" ? " (worked out from usage over Free's limits)" : ""}. Updated {new Date(r.at).toLocaleString()}. An estimate for 30 days at this rate; Cloudflare's invoice is the final word.
				</p>
			</div>

			<div>
				<h3 className="text-sm font-medium">The account</h3>
				<p className="text-sm text-kumo-subtle">All Workers and databases in the account, {plan.window}.</p>
				<div className="mt-2 overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-kumo-subtle">
							<tr>
								<th scope="col" className="py-1 pr-4 font-medium">
									Usage
								</th>
								<th scope="col" className="py-1 pr-4 font-medium">
									Used
								</th>
								<th scope="col" className="py-1 pr-4 font-medium">
									Included
								</th>
								<th scope="col" className="py-1 pr-4 font-medium">
									Share
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-kumo-line">
							{plan.rows.map((row) => (
								<tr key={row.label}>
									<th scope="row" className="py-2 pr-4 font-normal">
										{row.label}
									</th>
									<td className="py-2 pr-4">{row.show(row.used)}</td>
									<td className="py-2 pr-4">{row.show(row.of)}</td>
									<td className="py-2 pr-4">
										<span className="inline-flex items-center gap-2">
											<meter min={0} max={1} low={0.5} high={0.8} optimum={0} value={Math.min(1, row.of ? row.used / row.of : 0)} aria-label={`${row.label}: ${pct(row.used, row.of)} of the allowance`} />
											{pct(row.used, row.of)}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			<div>
				<h3 className="text-sm font-medium">This site</h3>
				<p className="text-sm text-kumo-subtle">
					{r.worker ? `Worker ${r.worker}` : "This site's Worker wasn't found"}
					{r.databaseId ? `, D1 database ${bytes(r.storage.siteBytes)}` : ""}.
				</p>
				{r.worker && (
					<div className="mt-2 overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead className="text-kumo-subtle">
								<tr>
									<th scope="col" className="py-1 pr-4 font-medium">
										Usage
									</th>
									<th scope="col" className="py-1 pr-4 font-medium">
										Today (UTC)
									</th>
									<th scope="col" className="py-1 pr-4 font-medium">
										Last 7 days
									</th>
									<th scope="col" className="py-1 pr-4 font-medium">
										Last 30 days
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-kumo-line">
								{SITE_ROWS.filter((row) => r.databaseId || !row.label.startsWith("D1")).map((row) => (
									<tr key={row.label}>
										<th scope="row" className="py-2 pr-4 font-normal">
											{row.label}
										</th>
										<td className="py-2 pr-4">{row.value(r.periods.day.site)}</td>
										<td className="py-2 pr-4">{row.value(r.periods.week.site)}</td>
										<td className="py-2 pr-4">{row.value(r.periods.month.site)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>

			{r.warming && (
				<div>
					<h3 className="text-sm font-medium">Cache warming (estimate)</h3>
					<p className="text-sm text-kumo-subtle">
						{r.warming.visits
							? `Last ${r.warming.days} days: about ${num(r.warming.visits)} warming visits, ${pct(r.warming.requestShare, 1)} of this site's requests and ${pct(r.warming.cpuShare, 1)} of its CPU time (${cpu(r.warming.cpuMs)}), and about ${num(r.warming.rowsRead)} D1 rows read. Estimated from sampled Workers Logs; D1 rows are this site's total times the warmer's share of requests.`
							: `No warming visits in the last ${r.warming.days} days.`}
					</p>
				</div>
			)}

			{r.notes.length > 0 && <Banner variant="default" description={r.notes.join(" ")} />}
		</>
	);
}

/** The dashboard widget: the bill and the account's three biggest shares. */
export function UsageWidget() {
	const { data, error } = useUsage();
	if (error) return <p className="text-sm text-kumo-subtle">{error}</p>;
	if (!data) return <Loader />;
	const link = (
		<a className="text-kumo-link hover:underline" href={`${ADMIN}/plugins/coywolf-pack/performance`}>
			{data.configured ? "Open Performance" : "Set it up on Performance"}
		</a>
	);
	if (!data.configured) {
		return (
			<div className="space-y-1 text-sm">
				<p className="text-kumo-subtle">Add a read-only Cloudflare API token to see usage and the estimated bill.</p>
				{link}
			</div>
		);
	}
	const top = [...allowances(data).rows].sort((a, b) => b.used / (b.of || 1) - a.used / (a.of || 1)).slice(0, 3);
	return (
		<div className="space-y-1 text-sm">
			<p className="font-medium">{data.plan === "free" ? "Workers Free" : `About ${money(data.bill.total)} a month`}</p>
			<ul className="text-kumo-subtle">
				{top.map((row) => (
					<li key={row.label}>
						{row.label}: {pct(row.used, row.of)} of the {data.plan === "free" ? "daily limit" : "monthly allowance"}
					</li>
				))}
			</ul>
			{data.warming && data.warming.visits > 0 && <p className="text-kumo-subtle">Cache warming: about {pct(data.warming.requestShare, 1)} of this site's requests (estimate)</p>}
			{link}
		</div>
	);
}

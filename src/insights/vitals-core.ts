/**
 * Core Web Vitals (pure part): the beacon loader, the Web Analytics site
 * lookup, the RUM query and what its answer becomes.
 *
 * Cloudflare Web Analytics measures real visitors with a small beacon
 * (static.cloudflareinsights.com/beacon.min.js). It sets no cookies and uses
 * no localStorage, doesn't fingerprint visitors by IP address or user agent,
 * and doesn't log query strings (developers.cloudflare.com/web-analytics/).
 * The numbers are read back from the account's
 * rumWebVitalsEventsAdaptiveGroups dataset, filtered by the site's tag; times
 * come in microseconds, and a negative value means nothing was measured (no
 * interaction on the page, say).
 *
 * No imports, so `node --test` can load this file.
 */

export const VITALS_DATASET = "rumWebVitalsEventsAdaptiveGroups";
export const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

/** Good and poor thresholds at the 75th percentile (web.dev): at or under the first is good, over the second is poor. */
export const THRESHOLDS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] } as const;
export type Metric = keyof typeof THRESHOLDS;
export type Rating = "good" | "needs-improvement" | "poor";

export function rate(metric: Metric, value: number | null): Rating | null {
	if (value === null || !Number.isFinite(value)) return null;
	const [good, poor] = THRESHOLDS[metric];
	return value <= good ? "good" : value <= poor ? "needs-improvement" : "poor";
}

/** A Web Analytics site token: 32 hex characters (the `token` in the beacon's data-cf-beacon). */
export const isBeaconToken = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/i.test(value.trim());

/**
 * The script the beacon part adds at the end of every public page. Once the
 * page has been parsed, it adds Cloudflare's documented snippet, a classic
 * deferred script with `data-cf-beacon='{"token":"…"}'`, unless the page
 * already has a beacon (from the theme, or Cloudflare's automatic setup,
 * which inserts its own before </body>), so a page never reports twice. An
 * inserted script never blocks rendering.
 *
 * Classic, not a module: the beacon finds its settings with
 * `document.currentScript || document.querySelector("script[data-cf-beacon]")`,
 * and currentScript is null in a module, so the attribute must be there.
 */
export function beaconLoader(token: string): string {
	if (!isBeaconToken(token)) throw new Error("Not a Web Analytics token");
	const settings = JSON.stringify({ token: token.trim().toLowerCase() });
	return `(()=>{const add=()=>{if(document.querySelector('script[src*="cloudflareinsights.com/beacon.min.js"],script[data-cf-beacon]'))return;const s=document.createElement("script");s.defer=true;s.src=${JSON.stringify(BEACON_SRC)};s.setAttribute("data-cf-beacon",${JSON.stringify(settings)});document.body.appendChild(s)};document.readyState==="loading"?document.addEventListener("DOMContentLoaded",add,{once:true}):add()})();`;
}

// ── The Web Analytics site ───────────────────────────────────────

export interface RumSite {
	tag: string;
	token: string;
	/** Cloudflare adds the beacon to the zone's pages itself (automatic setup). */
	autoInstall: boolean;
	zoneName: string | null;
	hosts: string[];
}

/** GET /accounts/{id}/rum/site_info/list (Account Settings → Read): the account's Web Analytics sites. */
export function parseSites(result: unknown): RumSite[] {
	const list = Array.isArray(result) ? result : [];
	// any: Cloudflare's site objects.
	return list.flatMap((s: any) => {
		const tag = typeof s?.site_tag === "string" ? s.site_tag : null;
		if (!tag) return [];
		const hosts = [s.host, ...(Array.isArray(s.rules) ? s.rules.map((r: any) => r?.host) : [])].filter((h): h is string => typeof h === "string" && h.length > 0).map((h) => h.toLowerCase());
		return [{ tag, token: typeof s.site_token === "string" ? s.site_token : "", autoInstall: s.auto_install === true, zoneName: typeof s.ruleset?.zone_name === "string" ? s.ruleset.zone_name.toLowerCase() : null, hosts: [...new Set(hosts)] }];
	});
}

/** This site's entry: the one with the saved beacon token, else the one for its host or zone. */
export function matchSite(sites: RumSite[], options: { token?: string | null; host: string; zoneNames: string[] }): RumSite | null {
	const token = options.token?.trim().toLowerCase();
	if (token) {
		const byToken = sites.find((s) => s.token.toLowerCase() === token);
		if (byToken) return byToken;
	}
	const host = options.host.toLowerCase();
	return (
		sites.find((s) => s.hosts.includes(host)) ??
		sites.find((s) => s.zoneName !== null && options.zoneNames.includes(s.zoneName)) ??
		sites.find((s) => s.hosts.some((h) => options.zoneNames.includes(h))) ??
		null
	);
}

// ── The numbers ──────────────────────────────────────────────────

const QUANTILES = "count quantiles { largestContentfulPaintP75 interactionToNextPaintP75 cumulativeLayoutShiftP75 }";

/** Real visitors only (`bot: 0` leaves out what Cloudflare knows to be bots): the last 7 and 30 days, and the 30 days' most visited pages. */
export function vitalsQuery(options: { botFilter: boolean } = { botFilter: true }): string {
	const filter = (from: string) => `{ siteTag: $site, datetime_geq: ${from}, datetime_leq: $end${options.botFilter ? ", bot: 0" : ""} }`;
	return `query PackInsightsVitals($account: String!, $site: String!, $week: Time!, $month: Time!, $end: Time!) {
	viewer { accounts(filter: { accountTag: $account }) {
		week: ${VITALS_DATASET}(limit: 1, filter: ${filter("$week")}) { ${QUANTILES} }
		month: ${VITALS_DATASET}(limit: 1, filter: ${filter("$month")}) { ${QUANTILES} }
		pages: ${VITALS_DATASET}(limit: 50, orderBy: [count_DESC], filter: ${filter("$month")}) { dimensions { requestPath } ${QUANTILES} }
	} }
}`;
}

export interface Vitals {
	/** Page views measured. */
	count: number;
	lcpMs: number | null;
	inpMs: number | null;
	cls: number | null;
}

const numeric = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);

/** One group's p75s: LCP and INP in milliseconds, CLS as a score; null where nothing was measured. */
export function toVitals(row: unknown): Vitals {
	// any: GraphQL row.
	const r = (row ?? {}) as any;
	const q = r.quantiles ?? {};
	const ms = (v: unknown) => {
		const n = numeric(v);
		return n === null || n < 0 ? null : Math.round(n / 1000);
	};
	const cls = numeric(q.cumulativeLayoutShiftP75);
	return { count: numeric(r.count) ?? 0, lcpMs: ms(q.largestContentfulPaintP75), inpMs: ms(q.interactionToNextPaintP75), cls: cls === null || cls < 0 ? null : Math.round(cls * 1000) / 1000 };
}

export interface VitalsReport {
	siteTag: string;
	autoInstall: boolean | null;
	week: Vitals;
	month: Vitals;
	/** The slowest of the most visited pages (by LCP, with at least `minViews` measured views). */
	slowPages: Array<Vitals & { path: string }>;
}

export function parseVitals(account: Record<string, unknown> | null | undefined, options: { siteTag: string; autoInstall: boolean | null; minViews?: number }): VitalsReport {
	const a = account ?? {};
	const first = (key: string) => (Array.isArray(a[key]) ? (a[key] as unknown[])[0] : undefined);
	const minViews = options.minViews ?? 5;
	const pages = (Array.isArray(a.pages) ? (a.pages as unknown[]) : [])
		// any: GraphQL row.
		.map((row: any) => ({ path: String(row?.dimensions?.requestPath ?? ""), ...toVitals(row) }))
		.filter((p) => p.path && p.count >= minViews && p.lcpMs !== null)
		.sort((x, y) => (y.lcpMs ?? 0) - (x.lcpMs ?? 0) || y.count - x.count)
		.slice(0, 10);
	return { siteTag: options.siteTag, autoInstall: options.autoInstall, week: toVitals(first("week")), month: toVitals(first("month")), slowPages: pages };
}

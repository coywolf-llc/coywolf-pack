/**
 * Cloudflare usage for the Performance page and the dashboard widget: this
 * site's D1 and Workers usage, the account's against its plan, the estimated
 * bill, and an estimate of the cache warmer's share. Read with the Cloudflare
 * API token (src/core/cloudflare-token.ts: saved on the plugin's Settings page,
 * else the older Cloudflare usage token or USAGE_API_TOKEN, else the
 * CLOUDFLARE_API_TOKEN Worker secret) and kept for an hour in plugin KV, since
 * the analytics API is rate limited.
 *
 * Nothing is configured per site: the site's Worker is the one whose current
 * deployment runs this version (CF_VERSION_METADATA), and its D1 database is
 * the one bound as DB in that Worker's settings.
 */
import type { PluginContext } from "emdash";

import { cloudflareApi, contextFetch } from "../core/cloudflare-api.js";
import { UNREADABLE_TOKEN_MESSAGE, cloudflareAccountId, cloudflareToken, noAccountMessage, noTokenMessage } from "../core/cloudflare-token.js";
import { DEADLINES, sharedRead, sharedSlot } from "../core/single-flight.js";
import { afterResponse, workerEnv } from "../shared.js";
import { versionId } from "./lib.js";
import {
	type Bill,
	type Plan,
	type UsageTotals,
	type WarmingEstimate,
	estimateBill,
	estimateWarming,
	foldTotals,
	planFromDailyPeaks,
	planFromEntitlements,
} from "./usage-core.js";
import { WARMER_AGENT } from "./warm.js";

/** The older read-only token's setting (src/core/cloudflare-token.ts reads it after the Cloudflare API token). */
export const USAGE_TOKEN_SETTING = "usageApiToken";
/** The last reading (read by Alerts for the bill estimate, without asking Cloudflare). */
export const USAGE_CACHE_KEY = "cache:usage";
const CACHE_KEY = USAGE_CACHE_KEY;
const TARGET_KEY = "state:usage:target";
/** After a failed read, wait this long before asking Cloudflare again (rate limits). */
const FAILED_KEY = "state:usage:failed";
const RETRY_AFTER_MS = 5 * 60_000;
/** How long a reading is kept; Refresh reads again, at most once a minute. */
const TTL_MS = 60 * 60_000;
const REFRESH_MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const WARM_DAYS = 7;

export interface UsageReport {
	at: string;
	plan: Plan | null;
	planSource: "entitlements" | "usage" | null;
	worker: string | null;
	databaseId: string | null;
	/** Today, the last 7 days and the last 30 days, as UTC dates including today (D1 counts by date, and Free's limits reset at 00:00 UTC). */
	periods: Record<"day" | "week" | "month", { site: UsageTotals; account: UsageTotals }>;
	storage: { siteBytes: number | null; accountBytes: number };
	bill: Bill;
	warming: WarmingEstimate | null;
	/** Parts that couldn't be read (the rest still shows). */
	notes: string[];
}

export type UsageResult = { configured: false; reason: string } | ({ configured: true } & UsageReport);

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

class UsageError extends Error {}

/** One reading through the shared client (src/core/cloudflare-api.ts); its errors are UsageErrors, as before. */
async function api<T>(doFetch: Fetch, token: string, path: string, init: { method?: string; body?: string } = {}): Promise<T> {
	try {
		return (await cloudflareApi<T>(path, { token, fetch: doFetch, method: init.method ?? "GET", body: init.body, graphql: path === "/graphql" })).result;
	} catch (error) {
		// Its messages had no closing period before the shared client.
		throw new UsageError((error instanceof Error ? error.message : String(error)).replace(/\.$/, ""));
	}
}

/**
 * The token every read-only Cloudflare feature uses (usage, Insights, Crawler Hints, the checkup's reading):
 * the Cloudflare API token, else the older Cloudflare usage token or USAGE_API_TOKEN, else CLOUDFLARE_API_TOKEN.
 */
export async function cloudflareReadToken(ctx: Pick<PluginContext, "settings">, env: Record<string, unknown>): Promise<string | null> {
	return (await readCloudflareToken(ctx, env)).token;
}

/** The same, where it came from, and whether a saved token couldn't be read (decrypted: EMDASH_ENCRYPTION_KEY missing or changed). */
export async function readCloudflareToken(ctx: Pick<PluginContext, "settings">, env: Record<string, unknown>) {
	return cloudflareToken(ctx, env, "read");
}

/** What the usage card needs of the token, for the message when there's none. */
const USAGE_NEEDS = "Account Analytics → Read, Account Settings → Read and Workers → Metadata Read-Only";

async function access(ctx: PluginContext, env: Record<string, unknown>): Promise<{ token: string; doFetch: Fetch } | { reason: string }> {
	const { token, unreadable } = await readCloudflareToken(ctx, env);
	if (!token) return { reason: unreadable ? UNREADABLE_TOKEN_MESSAGE : `${noTokenMessage(USAGE_NEEDS)} The steps are below.` };
	return { token, doFetch: contextFetch(ctx) as Fetch };
}

interface Target {
	version: string | null;
	accountId: string;
	worker: string | null;
	databaseId: string | null;
}

/** The account, this site's Worker and its D1 database: found once per deployed version and remembered. */
async function findTarget(ctx: PluginContext, env: Record<string, unknown>, a: { token: string; doFetch: Fetch }, notes: string[]): Promise<Target> {
	const version = versionId(env) ?? null;
	// The account: CF_ACCOUNT_ID, Clean Image URLs' account ID, or the token's only account (src/core/cloudflare-token.ts).
	const accountId = await cloudflareAccountId(ctx, env, { token: a.token, fetch: a.doFetch });
	if (!accountId) throw new UsageError(noAccountMessage().replace(/\.$/, ""));
	const known = await ctx.kv.get<Target>(TARGET_KEY);
	// Remembered per deployed version, found or not (a Worker that wasn't found isn't searched for again until the next deploy).
	if (known && known.version === version && known.accountId === accountId) return known;

	const target: Target = { version, accountId, worker: null, databaseId: null };
	try {
		const scripts = await api<Array<{ id: string; modified_on?: string }>>(a.doFetch, a.token, `/accounts/${accountId}/workers/scripts`);
		// The Worker deployed most recently first: usually this one.
		scripts.sort((x, y) => Date.parse(y.modified_on ?? "") - Date.parse(x.modified_on ?? ""));
		for (const script of version ? scripts.slice(0, 50) : []) {
			const deployments = await api<{ deployments?: Array<{ versions?: Array<{ version_id?: string }> }> }>(a.doFetch, a.token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script.id)}/deployments`).catch(() => null);
			if (deployments?.deployments?.[0]?.versions?.some((v) => v.version_id === version)) {
				target.worker = script.id;
				break;
			}
		}
		if (!target.worker) notes.push(version ? "Couldn't find this site's Worker among the account's Workers." : "This Worker has no CF_VERSION_METADATA binding, so its own usage can't be told apart.");
		if (target.worker) {
			const settings = await api<{ bindings?: Array<{ type?: string; name?: string; id?: string; database_id?: string }> }>(a.doFetch, a.token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(target.worker)}/settings`);
			const d1 = settings.bindings?.find((b) => b.type === "d1" && b.name === "DB") ?? settings.bindings?.find((b) => b.type === "d1");
			target.databaseId = d1?.database_id ?? d1?.id ?? null;
		}
	} catch (error) {
		notes.push(`Couldn't find this site's Worker (the Cloudflare API token needs Workers → Metadata Read-Only, or Account → Workers Scripts → Read on a personal token): ${String(error instanceof Error ? error.message : error)}`);
	}
	if (target.worker || version) await ctx.kv.set(TARGET_KEY, target);
	return target;
}

const USAGE_QUERY = `query Usage($a: String!, $d1: Date!, $d7: Date!, $d30: Date!, $today: Date!, $t1: Time!, $t7: Time!, $t30: Time!, $now: Time!) {
	viewer { accounts(filter: { accountTag: $a }) {
		d1Day: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $d1, date_leq: $today }) { sum { readQueries writeQueries rowsRead rowsWritten } dimensions { databaseId } }
		d1Week: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $d7, date_leq: $today }) { sum { readQueries writeQueries rowsRead rowsWritten } dimensions { databaseId } }
		d1Month: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $d30, date_leq: $today }) { sum { readQueries writeQueries rowsRead rowsWritten } dimensions { databaseId } }
		d1Daily: d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $d30, date_leq: $today }) { sum { rowsRead rowsWritten } dimensions { date } }
		wDay: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $t1, datetime_leq: $now }) { sum { requests errors cpuTimeUs } dimensions { scriptName } }
		wWeek: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $t7, datetime_leq: $now }) { sum { requests errors cpuTimeUs } dimensions { scriptName } }
		wMonth: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $t30, datetime_leq: $now }) { sum { requests errors cpuTimeUs } dimensions { scriptName } }
		wDaily: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $t30, datetime_leq: $now }) { sum { requests } dimensions { date } }
		storage: d1StorageAdaptiveGroups(limit: 1000, filter: { date_geq: $d1, date_leq: $today }) { max { databaseSizeBytes } dimensions { databaseId } }
	} }
}`;

type Rows<T> = T[] | undefined;

async function readUsage(ctx: PluginContext, a: { token: string; doFetch: Fetch }, target: Target, notes: string[]): Promise<Omit<UsageReport, "at" | "notes">> {
	const now = new Date();
	const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	const time = (ms: number) => new Date(ms).toISOString();
	const n = now.getTime();
	// Whole UTC dates for both datasets, so D1 (counted by date) and Workers cover the same time.
	const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const body = await api<{ data?: { viewer?: { accounts?: Array<Record<string, Rows<Record<string, unknown>>>> } }; errors?: Array<{ message?: string }> | null }>(a.doFetch, a.token, "/graphql", {
		method: "POST",
		body: JSON.stringify({
			query: USAGE_QUERY,
			variables: { a: target.accountId, d1: date(startOfToday), d7: date(startOfToday - 6 * DAY_MS), d30: date(startOfToday - 29 * DAY_MS), today: date(startOfToday), t1: time(startOfToday), t7: time(startOfToday - 6 * DAY_MS), t30: time(startOfToday - 29 * DAY_MS), now: time(n) },
		}),
	});
	if (body.errors?.length) throw new UsageError(`Cloudflare analytics: ${body.errors.map((e) => e.message).join("; ")}. The Cloudflare API token needs Account → Account Analytics → Read.`);
	const acc = body.data?.viewer?.accounts?.[0] ?? {};
	// any: GraphQL rows.
	const rows = (key: string) => (acc[key] ?? []) as any[];
	const site = { databaseId: target.databaseId, worker: target.worker };
	const periods = {
		day: foldTotals(rows("d1Day"), rows("wDay"), site),
		week: foldTotals(rows("d1Week"), rows("wWeek"), site),
		month: foldTotals(rows("d1Month"), rows("wMonth"), site),
	};
	const sizes = rows("storage") as Array<{ dimensions?: { databaseId?: string }; max?: { databaseSizeBytes?: number } }>;
	const accountBytes = sizes.reduce((s, r) => s + (r.max?.databaseSizeBytes ?? 0), 0);
	const siteBytes = target.databaseId ? (sizes.find((r) => r.dimensions?.databaseId === target.databaseId)?.max?.databaseSizeBytes ?? null) : null;

	// The plan: the account's entitlements, or a day over Free's limits.
	let plan: Plan | null = null;
	let planSource: UsageReport["planSource"] = null;
	const entitlements = await api<unknown>(a.doFetch, a.token, `/accounts/${target.accountId}/entitlements`).catch(() => null);
	plan = planFromEntitlements(entitlements);
	if (plan) planSource = "entitlements";
	else {
		const peak = (list: Array<{ sum?: Record<string, number> }>, field: string) => Math.max(0, ...list.map((r) => r.sum?.[field] ?? 0));
		plan = planFromDailyPeaks({ requests: peak(rows("wDaily"), "requests"), rowsRead: peak(rows("d1Daily"), "rowsRead"), rowsWritten: peak(rows("d1Daily"), "rowsWritten") });
		if (plan) planSource = "usage";
		else notes.push("Couldn't read the account's plan (the Cloudflare API token needs Account → Account Settings → Read); the bill assumes Workers Paid.");
	}

	// The cache warmer's share, from Workers Logs (sampled, so an estimate).
	let warming: WarmingEstimate | null = null;
	if (target.worker) {
		try {
			const result = await api<{ calculations?: Array<{ alias?: string; aggregates?: Array<{ value?: number }> }> }>(a.doFetch, a.token, `/accounts/${target.accountId}/workers/observability/telemetry/query`, {
				method: "POST",
				body: JSON.stringify({
					queryId: "coywolf-pack-usage-warming",
					view: "calculations",
					timeframe: { from: startOfToday - (WARM_DAYS - 1) * DAY_MS, to: n },
					parameters: {
						datasets: ["cloudflare-workers"],
						filters: [
							{ key: "$metadata.service", operation: "eq", type: "string", value: target.worker },
							{ key: "$workers.event.request.headers.user-agent", operation: "eq", type: "string", value: WARMER_AGENT },
							// Invocations only, not console.log lines from the same requests.
							{ key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker-event" },
						],
						calculations: [
							{ operator: "count", alias: "visits" },
							{ operator: "sum", key: "$workers.cpuTimeMs", keyType: "number", alias: "cpu" },
						],
					},
				}),
			});
			const value = (alias: string) => Number(result.calculations?.find((c) => c.alias === alias)?.aggregates?.[0]?.value ?? 0) || 0;
			warming = estimateWarming({ visits: Math.round(value("visits")), cpuMs: Math.round(value("cpu")) }, periods.week.site, WARM_DAYS);
		} catch (error) {
			notes.push(`Couldn't estimate cache warming from Workers Logs (the Cloudflare API token needs Workers → Metadata Read-Only, or Account → Workers Observability → Edit on a personal token, and the Worker needs Workers Logs on): ${String(error instanceof Error ? error.message : error)}`);
		}
	}

	return { plan, planSource, worker: target.worker, databaseId: target.databaseId, periods, storage: { siteBytes, accountBytes }, bill: estimateBill(periods.month.account, accountBytes), warming };
}

/** A reading under way: concurrent page loads share it, for a bounded time (DEADLINES.usageWaitMs, src/core/single-flight.ts). */
const reading = sharedSlot<UsageResult>();

/**
 * The last reading (under an hour old), or a new one. `refresh` reads again unless the last one is under a minute old.
 * `bindings` replaces the Worker's env (tests).
 */
export async function usageReport(ctx: PluginContext, refresh = false, bindings?: Record<string, unknown>): Promise<UsageResult> {
	const cached = await ctx.kv.get<UsageReport>(CACHE_KEY);
	const age = cached ? Date.now() - Date.parse(cached.at) : Number.POSITIVE_INFINITY;
	if (cached && age < (refresh ? REFRESH_MIN_MS : TTL_MS)) return { configured: true, ...cached };
	const read = () => sharedRead(reading, () => readNow(ctx, cached, bindings), { waitMs: DEADLINES.usageWaitMs, anchor: afterResponse, label: "the Cloudflare usage reading" });
	if (reading.flight) return read();
	const failed = await ctx.kv.get<{ at: string; message: string }>(FAILED_KEY);
	if (failed && Date.now() - Date.parse(failed.at) < RETRY_AFTER_MS) {
		const wait = `Couldn't read usage: ${failed.message} Trying again after ${new Date(Date.parse(failed.at) + RETRY_AFTER_MS).toISOString().slice(11, 16)} UTC.`;
		return cached ? { configured: true, ...cached, notes: [...cached.notes, wait] } : { configured: false, reason: wait };
	}
	return read();
}

/** A new reading (stored in KV), or the last good one with what went wrong. */
async function readNow(ctx: PluginContext, cached: UsageReport | null | undefined, bindings?: Record<string, unknown>): Promise<UsageResult> {
	const env = bindings ?? (await workerEnv().catch(() => ({}) as Record<string, unknown>));
	const a = await access(ctx, env);
	if ("reason" in a) return { configured: false, reason: a.reason };
	const notes: string[] = [];
	try {
		const target = await findTarget(ctx, env, a, notes);
		const report: UsageReport = { at: new Date().toISOString(), ...(await readUsage(ctx, a, target, notes)), notes };
		await ctx.kv.set(CACHE_KEY, report);
		await ctx.kv.delete?.(FAILED_KEY);
		return { configured: true, ...report };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.log.warn("Cloudflare usage: read failed", { error: message });
		await ctx.kv.set(FAILED_KEY, { at: new Date().toISOString(), message });
		// The last good reading, if any, with what went wrong.
		if (cached) return { configured: true, ...cached, notes: [...cached.notes, `Couldn't refresh: ${message}`] };
		return { configured: false, reason: message };
	}
}


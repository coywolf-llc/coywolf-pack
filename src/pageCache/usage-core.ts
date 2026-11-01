/**
 * Cloudflare usage (pure part): plan allowances and prices, plan detection,
 * the estimated bill, and the cache-warming estimate. No imports, so
 * `node --test` can load this file.
 *
 * Prices and allowances are Cloudflare's published Workers and D1 pricing
 * (Workers Paid, Standard usage model). The account's allowances are shared
 * by every Worker and database in it, so the bill is worked out from the
 * account's totals, not this site's.
 */

export type Plan = "paid" | "free";

export interface D1Usage {
	rowsRead: number;
	rowsWritten: number;
	readQueries: number;
	writeQueries: number;
}

export interface WorkersUsage {
	requests: number;
	cpuMs: number;
	errors: number;
}

export interface UsageTotals {
	d1: D1Usage;
	workers: WorkersUsage;
}

export const EMPTY_TOTALS: UsageTotals = {
	d1: { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 },
	workers: { requests: 0, cpuMs: 0, errors: 0 },
};

/** Workers Paid: what the $5 a month includes, and the price of each unit over it. */
export const PAID = {
	base: 5,
	monthly: { requests: 10_000_000, cpuMs: 30_000_000, rowsRead: 25_000_000_000, rowsWritten: 50_000_000, storageBytes: 5e9 },
	/** Per million (storage: per GB-month). */
	price: { requests: 0.3, cpuMs: 0.02, rowsRead: 0.001, rowsWritten: 1, storageGb: 0.75 },
} as const;

/** Workers Free: daily limits (requests and D1 rows reset every day at 00:00 UTC); 10 ms CPU per request; 5 GB of D1 storage. */
export const FREE = {
	daily: { requests: 100_000, rowsRead: 5_000_000, rowsWritten: 100_000 },
	cpuMsPerRequest: 10,
	storageBytes: 5e9,
} as const;

interface Entitlement {
	id?: string;
	feature?: { key?: string };
	allocation?: { value?: unknown };
}

/**
 * The Workers plan from the account's entitlements: D1's per-database size
 * limit is 10 GB on Workers Paid and 500 MB on Free. Null when the list
 * doesn't say (the key is missing, or the token can't read it).
 */
export function planFromEntitlements(entitlements: unknown): Plan | null {
	const list = Array.isArray(entitlements) ? (entitlements as Entitlement[]) : [];
	const perDb = list.find((e) => (e.feature?.key ?? e.id) === "d1.max_storage_per_db_mb");
	const mb = Number(perDb?.allocation?.value);
	if (!Number.isFinite(mb) || mb <= 0) return null;
	return mb > 500 ? "paid" : "free";
}

/** Without the entitlements: a day over Free's limits means the account is on Paid (Free would have stopped it). Null when it can't tell. */
export function planFromDailyPeaks(peaks: { requests: number; rowsRead: number; rowsWritten: number }): Plan | null {
	return peaks.requests > FREE.daily.requests || peaks.rowsRead > FREE.daily.rowsRead || peaks.rowsWritten > FREE.daily.rowsWritten ? "paid" : null;
}

const over = (used: number, included: number) => Math.max(0, used - included);
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Bill {
	base: number;
	overage: { requests: number; cpu: number; rowsRead: number; rowsWritten: number; storage: number };
	total: number;
}

/**
 * The estimated bill for 30 days at this rate on Workers Paid: $5 plus anything
 * over the included amounts. A billing month isn't exactly these 30 days, so
 * it's an estimate.
 */
export function estimateBill(account: UsageTotals, storageBytes: number): Bill {
	const m = PAID.monthly;
	const p = PAID.price;
	const overage = {
		requests: round2((over(account.workers.requests, m.requests) / 1e6) * p.requests),
		cpu: round2((over(account.workers.cpuMs, m.cpuMs) / 1e6) * p.cpuMs),
		rowsRead: round2((over(account.d1.rowsRead, m.rowsRead) / 1e6) * p.rowsRead),
		rowsWritten: round2((over(account.d1.rowsWritten, m.rowsWritten) / 1e6) * p.rowsWritten),
		storage: round2((over(storageBytes, m.storageBytes) / 1e9) * p.storageGb),
	};
	const total = round2(PAID.base + Object.values(overage).reduce((a, b) => a + b, 0));
	return { base: PAID.base, overage, total };
}

export interface WarmingEstimate {
	/** Cache warmer visits in the window (from sampled Workers Logs). */
	visits: number;
	cpuMs: number;
	/** Share of the site's requests and CPU time in the same window (0–1). */
	requestShare: number;
	cpuShare: number;
	/** The site's D1 rows read in the window times the warmer's share of requests. */
	rowsRead: number;
	days: number;
}

/** The warmer's share of the site's work over the same days. Logs are sampled, so it's an estimate. */
export function estimateWarming(warm: { visits: number; cpuMs: number }, site: UsageTotals, days: number): WarmingEstimate {
	const requestShare = site.workers.requests > 0 ? Math.min(1, warm.visits / site.workers.requests) : 0;
	const cpuShare = site.workers.cpuMs > 0 ? Math.min(1, warm.cpuMs / site.workers.cpuMs) : 0;
	return { visits: warm.visits, cpuMs: warm.cpuMs, requestShare, cpuShare, rowsRead: Math.round(site.d1.rowsRead * requestShare), days };
}

/** GraphQL rows (grouped by database or Worker) folded into one site's totals and the account's. */
export function foldTotals(
	d1Rows: Array<{ dimensions?: { databaseId?: string }; sum?: Partial<D1Usage> }>,
	workerRows: Array<{ dimensions?: { scriptName?: string }; sum?: { requests?: number; errors?: number; cpuTimeUs?: number } }>,
	site: { databaseId: string | null; worker: string | null },
): { site: UsageTotals; account: UsageTotals } {
	const blank = (): UsageTotals => ({ d1: { ...EMPTY_TOTALS.d1 }, workers: { ...EMPTY_TOTALS.workers } });
	const out = { site: blank(), account: blank() };
	for (const row of d1Rows) {
		const s = row.sum ?? {};
		const targets = [out.account, ...(site.databaseId && row.dimensions?.databaseId === site.databaseId ? [out.site] : [])];
		for (const t of targets) {
			t.d1.rowsRead += s.rowsRead ?? 0;
			t.d1.rowsWritten += s.rowsWritten ?? 0;
			t.d1.readQueries += s.readQueries ?? 0;
			t.d1.writeQueries += s.writeQueries ?? 0;
		}
	}
	for (const row of workerRows) {
		const s = row.sum ?? {};
		const targets = [out.account, ...(site.worker && row.dimensions?.scriptName === site.worker ? [out.site] : [])];
		for (const t of targets) {
			t.workers.requests += s.requests ?? 0;
			t.workers.errors += s.errors ?? 0;
			t.workers.cpuMs += (s.cpuTimeUs ?? 0) / 1000;
		}
	}
	for (const t of [out.site, out.account]) t.workers.cpuMs = Math.round(t.workers.cpuMs);
	return out;
}

/**
 * The site's Workers plan, as the Cloudflare usage card last read it (no
 * request of its own): background jobs size their steps by it. Workers Free
 * allows 50 D1 queries per invocation, and EmDash runs every due scheduled
 * task in one invocation, so each job keeps a Free-sized step unless the plan
 * is known to be Paid (which allows 1,000).
 */
import { USAGE_CACHE_KEY } from "../pageCache/usage.js";

export type WorkersPlan = "paid" | "free" | null;

export async function knownPlan(kv: { get<T>(key: string): Promise<T | null | undefined> }): Promise<WorkersPlan> {
	const usage = await kv.get<{ plan?: unknown }>(USAGE_CACHE_KEY).catch(() => null);
	return usage?.plan === "paid" || usage?.plan === "free" ? usage.plan : null;
}

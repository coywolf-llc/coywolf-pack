/**
 * Page cache purges made while the Worker runs its scheduled (Cron Trigger)
 * handler.
 *
 * A Workers Cache purge made there (cache.purge() from cloudflare:workers, or
 * ctx.cache.purge()) answers { success: true } and clears nothing. Tested on
 * November 25, 2026 with a throwaway Worker: purges by tag, by path prefix and
 * both left the pages cached, while the same purges made in a fetch invocation
 * of the same Worker (a request, or the Worker calling itself from the cron)
 * cleared them at once. EmDash runs plugins' scheduled tasks
 * (src/core/compose.ts) and its scheduled publishing (which runs the pack's
 * content hooks) from that handler, so every purge they made was lost without
 * a word: on coywolf.com a post the hourly run had linked kept its cached copy
 * from before the run.
 *
 * So a purge made during a scheduled run goes through the Worker's own default
 * entrypoint, called by RPC:
 * - stripTrackingParams (src/worker.ts) makes the site's default export a
 *   WorkerEntrypoint class, runs the site's scheduled handler inside a store
 *   (AsyncLocalStorage) holding the invocation's ctx, and has one RPC method,
 *   PURGE_METHOD, that purges (answerPurgeCall);
 * - purgeOutcome (src/pageCache/lib.ts) sees the store and calls that method
 *   through ctx.exports.default (purgeThroughEntrypoint);
 * - the pack's cache provider (src/cache-provider.ts) sends EmDash's own purges
 *   from the scheduled run through purgeOutcome too.
 * Why RPC and not a fetch call: every site sets "placement" (a region hint),
 * which sends each fetch to the default entrypoint, the Worker's call to
 * itself included, to the placed location, and that call arrives there without
 * the ctx.props it was made with (0.51.1 sent the scope in ctx.props, and on
 * the sites every such call was answered as a page: 301, then 404). Placement
 * doesn't move RPC calls, and a purge clears only the cache of the entrypoint
 * that makes it, so it has to be the default entrypoint (the one that caches
 * the pages), not a separate one. Both tested on November 25, 2026 with
 * throwaway Workers with the sites' placement. Only the Worker's own code (and
 * service bindings to it, which only the account sets up) can call the method.
 *
 * No runtime imports: src/worker.ts creates the store (it imports
 * node:async_hooks and cloudflare:workers) and keeps it on globalThis, so
 * this file and lib.ts load anywhere (astro.config.mjs loads the pack in
 * Node), and a second copy of the pack's modules in the same Worker finds the
 * same store.
 */
import type { PurgeScope } from "../pageCache/lib.js";

/** What a scheduled run's store holds: that invocation's ctx and env. */
export interface ScheduledRun {
	ctx: unknown;
	env: unknown;
}

/** The part of AsyncLocalStorage this uses. */
export interface RunStorage {
	run<R>(store: ScheduledRun, fn: () => R): R;
	getStore(): ScheduledRun | undefined;
}

export type PurgeOutcome = "purged" | "refused" | "unavailable";

const RUNS = Symbol.for("coywolf-pack.scheduledRuns");
/** The RPC method of the Worker's default entrypoint (stripTrackingParams' class) that purges for a scheduled run. */
export const PURGE_METHOD = "coywolfPackPurge";
/** How long a purge from a scheduled run waits for the Worker's answer (callers allow 10 s: DEADLINES.purgeMs). */
export const LOOPBACK_TIMEOUT_MS = 8_000;

/** The store for scheduled runs, created once per isolate (by the first stripTrackingParams call). */
export function installScheduledRuns(create: () => RunStorage): RunStorage {
	const global = globalThis as Record<symbol, unknown>;
	const existing = global[RUNS] as RunStorage | undefined;
	if (existing && typeof existing.run === "function" && typeof existing.getStore === "function") return existing;
	const storage = create();
	global[RUNS] = storage;
	return storage;
}

/** The scheduled run this code is part of, or undefined outside one (requests, Node, tests). */
export function scheduledRun(): ScheduledRun | undefined {
	const storage = (globalThis as Record<symbol, unknown>)[RUNS] as RunStorage | undefined;
	return typeof storage?.getStore === "function" ? storage.getStore() : undefined;
}

/**
 * A scope Workers Cache takes: exactly { purgeEverything: true }, or path
 * prefixes (starting with "/") and/or tags, non-empty strings, at least one in
 * all. Checked by the receiving side (answerPurgeCall).
 */
export function isPurgeScope(value: unknown): value is PurgeScope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	if (keys.length === 1 && keys[0] === "purgeEverything") return (value as { purgeEverything?: unknown }).purgeEverything === true;
	if (!keys.length || keys.some((key) => key !== "tags" && key !== "pathPrefixes")) return false;
	const { tags, pathPrefixes } = value as { tags?: unknown; pathPrefixes?: unknown };
	const strings = (list: unknown, path: boolean): list is string[] =>
		Array.isArray(list) && list.every((item) => typeof item === "string" && item.length > 0 && (!path || item.startsWith("/")));
	if (tags !== undefined && !strings(tags, false)) return false;
	if (pathPrefixes !== undefined && !strings(pathPrefixes, true)) return false;
	return ((tags as string[] | undefined)?.length ?? 0) + ((pathPrefixes as string[] | undefined)?.length ?? 0) > 0;
}

type PurgeCall = (scope: PurgeScope) => Promise<unknown>;

/**
 * The Worker's own default entrypoint, which takes the purge by RPC: ctx.exports.default, else the
 * cloudflare:workers exports. (An RPC stub answers any method name, so whether the method is there only shows
 * when it's called.)
 */
async function ownDefault(run: ScheduledRun): Promise<Record<string, unknown> | undefined> {
	const isBinding = (value: unknown): value is Record<string, unknown> => (typeof value === "function" || typeof value === "object") && value !== null;
	const fromCtx = (run.ctx as { exports?: { default?: unknown } } | undefined)?.exports?.default;
	if (isBinding(fromCtx)) return fromCtx;
	try {
		const workers = (await import("cloudflare:workers")) as unknown as { exports?: { default?: unknown } };
		if (isBinding(workers.exports?.default)) return workers.exports.default;
	} catch {
		// Not on Workers.
	}
	return undefined;
}

const OUTCOMES = new Set<string>(["purged", "refused", "unavailable"]);
/** Whether this isolate already logged that the Worker can't call itself (said once: every purge of every run would repeat it). */
let noLoopbackLogged = false;

/**
 * Purge from a scheduled run: through the Worker's own default entrypoint, by
 * RPC (PURGE_METHOD, answered by answerPurgeCall). The scope goes as given.
 * "refused" (logged) when there's no ctx.exports (a compatibility date before
 * 2025-11-17 without enable_ctx_exports), the call fails (a default export
 * that isn't stripTrackingParams' class has no such method), answers with
 * anything but one of the three outcomes, or takes longer than `timeoutMs`:
 * callers that keep refused purges for later (settleLater) then retry them
 * from a request. A purge made here directly would report success and clear
 * nothing, so it's never tried. Never throws.
 */
export async function purgeThroughEntrypoint(run: ScheduledRun, scope: PurgeScope, timeoutMs = LOOPBACK_TIMEOUT_MS): Promise<PurgeOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const own = await ownDefault(run);
		if (!own) {
			if (!noLoopbackLogged) {
				noLoopbackLogged = true;
				console.error("coywolf-pack: page cache purges from the scheduled run can't be made: the Worker can't call itself (ctx.exports needs a compatibility date of 2025-11-17 or later); they're refused");
			}
			return "refused";
		}
		const answer = (async () => {
			// Called as a method of the binding (an RPC stub's methods need it as `this`).
			const outcome = await (own as Record<string, PurgeCall>)[PURGE_METHOD](scope);
			if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) throw new Error(`the Worker answered ${JSON.stringify(outcome) ?? String(outcome)}`);
			return outcome as PurgeOutcome;
		})();
		// Settled after a timeout: nothing waits for it anymore. (An answer that comes after the timeout has purged
		// anyway; it's still reported refused, so a caller that keeps refused purges clears that scope once more.)
		answer.catch(() => undefined);
		const late = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`no answer from the Worker in ${timeoutMs} ms`)), timeoutMs);
		});
		return await Promise.race([answer, late]);
	} catch (error) {
		console.error("coywolf-pack: page cache purge from the scheduled run failed", scope, String(error));
		return "refused";
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * The default entrypoint's answer to purgeThroughEntrypoint (stripTrackingParams' PURGE_METHOD): `purge` (the
 * direct purge) runs here, in the default entrypoint's own invocation, where Workers Cache takes it. A scope it
 * wouldn't take is refused. Never throws.
 */
export async function answerPurgeCall(scope: unknown, purge: (scope: PurgeScope) => Promise<PurgeOutcome>): Promise<PurgeOutcome> {
	if (!isPurgeScope(scope)) {
		console.error("coywolf-pack: page cache purge call refused: not a purge scope", JSON.stringify(scope) ?? String(scope));
		return "refused";
	}
	try {
		return await purge(scope);
	} catch (error) {
		console.error("coywolf-pack: page cache purge for the scheduled run failed", String(error));
		return "refused";
	}
}

let warned = false;

/**
 * Called as a pack scheduled task starts (src/core/compose.ts): once per
 * isolate, says so when the task runs outside a scheduled-run store on a
 * Worker with Workers Cache, so its purges may clear nothing. (EmDash's
 * local dev runs scheduled tasks from a request, where purges do work.)
 * `wrapped`: whether the Worker uses stripTrackingParams. Never throws.
 */
export async function warnOutsideScheduledRun(wrapped: boolean): Promise<void> {
	if (warned || scheduledRun()) return;
	try {
		const workers = (await import("cloudflare:workers")) as unknown as { cache?: { purge?: unknown } };
		if (!workers.cache?.purge) return; // No Workers Cache: nothing to purge.
	} catch {
		return; // Not on Workers.
	}
	if (warned) return;
	warned = true;
	console.warn(
		wrapped
			? "coywolf-pack: a scheduled task ran outside the Worker's scheduled run (is the scheduled handler inside stripTrackingParams in src/worker.ts?): page cache purges it makes may clear nothing (docs/performance.md#purges-from-scheduled-runs)"
			: "coywolf-pack: the Worker isn't wrapped with stripTrackingParams (src/worker.ts), so page cache purges made by scheduled tasks may clear nothing (docs/performance.md#purges-from-scheduled-runs)",
	);
}

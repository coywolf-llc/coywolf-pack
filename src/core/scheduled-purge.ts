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
 * So a purge made during a scheduled run goes through a fetch invocation of
 * the same Worker:
 * - stripTrackingParams (src/worker.ts) runs the site's scheduled handler inside
 *   a store (AsyncLocalStorage) holding the invocation's ctx;
 * - purgeOutcome (src/pageCache/lib.ts) sees the store and calls the Worker's
 *   own default export through ctx.exports, with the scope in ctx.props
 *   (purgeThroughFetch);
 * - the wrapper's fetch answers that call by purging, before the site's handler
 *   runs (internalPurge, answerInternalPurge).
 * Only the Worker's own code can set ctx.props (requests from the internet
 * always have {}), so nothing outside the Worker can make it purge. ctx.props
 * doesn't partition the cache either: a purge made with it clears visitors'
 * pages (tested the same day).
 *
 * No runtime imports: src/worker.ts creates the store (it imports
 * node:async_hooks) and keeps it on globalThis, so this file and lib.ts load
 * anywhere (astro.config.mjs loads the pack in Node), and a second copy of the
 * pack's modules in the same Worker finds the same store.
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
/** The ctx.props key that carries a purge scope to the Worker's own fetch (and marks the call as the pack's). */
export const PURGE_PROP = "coywolf-pack:purge";
/** The loopback's URL: nothing reads its host or path (the prop alone marks the call), but logs show it. */
export const PURGE_URL = "https://coywolf-pack.internal/page-cache/purge";
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
 * all. Checked on the receiving side of the loopback.
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

type Loopback = (options: { props: Record<string, unknown> }) => { fetch(request: Request): Promise<Response> };

/** The Worker's own default export as a loopback that takes props: ctx.exports.default, else the cloudflare:workers export. */
async function ownDefault(run: ScheduledRun): Promise<Loopback | undefined> {
	const fromCtx = (run.ctx as { exports?: { default?: unknown } } | undefined)?.exports?.default;
	if (typeof fromCtx === "function") return fromCtx as Loopback;
	try {
		const workers = (await import("cloudflare:workers")) as unknown as { exports?: { default?: unknown } };
		if (typeof workers.exports?.default === "function") return workers.exports.default as Loopback;
	} catch {
		// Not on Workers.
	}
	return undefined;
}

const OUTCOMES = new Set<string>(["purged", "refused", "unavailable"]);
/** Whether this isolate already logged that the Worker can't call itself (said once: every purge of every run would repeat it). */
let noLoopbackLogged = false;

/**
 * Purge from a scheduled run: through a fetch invocation of the same Worker
 * (its default export, called with the scope in ctx.props). The scope goes as
 * given. "refused" (logged) when there's no loopback (a compatibility date
 * before 2025-11-17 without enable_ctx_exports), the call fails, answers with
 * anything but one of the three outcomes, or takes longer than `timeoutMs`:
 * callers that keep refused purges for later (settleLater) then retry them
 * from a request. A purge made here directly would report success and clear
 * nothing, so it's never tried. Never throws.
 */
export async function purgeThroughFetch(run: ScheduledRun, scope: PurgeScope, timeoutMs = LOOPBACK_TIMEOUT_MS): Promise<PurgeOutcome> {
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
			const response = await own({ props: { [PURGE_PROP]: scope } }).fetch(new Request(PURGE_URL, { method: "POST" }));
			if (response.status !== 200) {
				// The wrapper's reason (a scope it refused, a method), when it gave one.
				const reason = await response.text().then((text) => text.slice(0, 200), () => "");
				throw new Error(`the Worker answered ${response.status}${reason ? ` ${reason}` : ""}`);
			}
			const body = (await response.json()) as { outcome?: unknown } | null;
			const outcome = body?.outcome;
			if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) throw new Error(`the Worker answered ${JSON.stringify(body)}`);
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

/** The scope of the pack's own purge call (purgeThroughFetch), from the invocation's ctx; null for any other request. */
export function internalPurge(ctx: unknown): { scope: unknown } | null {
	const props = (ctx as { props?: unknown } | undefined)?.props;
	if (!props || typeof props !== "object" || !Object.hasOwn(props, PURGE_PROP)) return null;
	return { scope: (props as Record<string, unknown>)[PURGE_PROP] };
}

/** The Worker's answer to the pack's purge call: `purge` (the direct purge) runs here, in a fetch invocation. */
export async function answerInternalPurge(request: Request, scope: unknown, purge: (scope: PurgeScope) => Promise<PurgeOutcome>): Promise<Response> {
	const headers = { "Cache-Control": "no-store" };
	if (request.method !== "POST") return Response.json({ outcome: "refused", error: "POST only" }, { status: 405, headers });
	if (!isPurgeScope(scope)) return Response.json({ outcome: "refused", error: "not a purge scope" }, { status: 400, headers });
	let outcome: PurgeOutcome = "refused";
	try {
		outcome = await purge(scope);
	} catch (error) {
		console.error("coywolf-pack: page cache purge for the scheduled run failed", String(error));
	}
	return Response.json({ outcome }, { headers });
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

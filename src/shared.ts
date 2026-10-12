import { PluginRouteError } from "emdash";
import type { z } from "zod";

interface Workers {
	env: Record<string, unknown>;
	waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * cloudflare:workers, loaded once when the isolate starts. A dynamic import,
 * not a static one: astro.config.mjs loads the plugin in Node, where the module
 * doesn't exist (`workers` stays null there). It's loaded long before the first
 * request, so request-time callers never wait for it.
 */
let workers: Workers | null = null;
const workersReady: Promise<Workers | null> = import("cloudflare:workers").then(
	(module) => (workers = module as unknown as Workers),
	() => null,
);

/** Cloudflare bindings. Rejects outside a Worker (callers catch). */
export async function workerEnv(): Promise<Record<string, unknown>> {
	const module = workers ?? (await workersReady);
	if (!module) throw new Error("cloudflare:workers isn't available here");
	return module.env;
}

/**
 * Run `promise` after the response: hand it to waitUntil right now, before
 * anything else happens. Synchronous on purpose. A Worker invocation ends as
 * soon as its response is complete unless waitUntil holds it open, and work
 * started from a hook EmDash doesn't await (media:afterUpload runs
 * fire-and-forget right before the upload's response) has no time to spare: this
 * used to await a dynamic import first, the hook awaited a settings read before
 * that, and the request finished before waitUntil was reached, dropping the
 * work with it without a word (0.30.0–0.33.0). Outside a Worker the promise just
 * runs; in the first instant of an isolate, before cloudflare:workers has
 * loaded, it's handed over as soon as it has.
 */
export function afterResponse(promise: Promise<unknown>): void {
	if (workers) {
		workers.waitUntil?.(promise);
		return;
	}
	void workersReady.then((module) => module?.waitUntil?.(promise));
}

/** Read a Worker secret (env binding, or process.env under nodejs_compat). */
export function secret(env: Record<string, unknown>, name: string): string | undefined {
	return (env[name] as string | undefined) ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[name];
}

/** Validate a route body, reporting problems to the admin instead of a generic 500. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (!result.success) throw PluginRouteError.badRequest(result.error.issues.map((i) => i.message).join("; "));
	return result.data;
}

export interface SettingsReader {
	settings: { get<T>(key: string): Promise<T | null | undefined> };
}

export interface CronScheduler {
	cron?: { schedule(name: string, opts: { schedule: string }): Promise<void> };
}

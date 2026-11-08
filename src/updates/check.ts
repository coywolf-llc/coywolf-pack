/**
 * Update check: once a day, ask npm which version of Coywolf Pack is the
 * latest, and tell the admin when it's newer than the one this site runs.
 * The request is npm's public dist-tags for the package; it carries nothing
 * about the site. Kept in plugin KV, so it costs one request a day per site
 * (checked when an admin opens a pack page or the dashboard, not on a timer).
 */
import type { PluginContext } from "emdash";

import { VERSION } from "../version.js";
import { DIST_TAGS_URL, RELEASES_URL, UPDATE_COMMAND, isNewer, parseVersion } from "./core.js";

const STATE_KEY = "state:update";
const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** After a failed check, wait this long before asking npm again. */
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 5_000;

interface UpdateState {
	/** When npm last answered. */
	checkedAt: string | null;
	latest: string | null;
	/** When the last check failed (cleared by a successful one). */
	failedAt?: string | null;
}

export type UpdateStatus =
	| { enabled: false; current: string }
	| { enabled: true; current: string; latest: string | null; available: boolean; checkedAt: string | null; releasesUrl: string; command: string };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Ctx = Pick<PluginContext, "kv" | "log"> & { http?: { fetch: Fetch } | null };

const age = (at: string | null | undefined, now: number) => (at ? now - Date.parse(at) : Number.POSITIVE_INFINITY);

async function askNpm(ctx: Ctx): Promise<string> {
	const doFetch = (ctx.http ? ctx.http.fetch.bind(ctx.http) : fetch) as Fetch;
	const timeout = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
	const res = await doFetch(DIST_TAGS_URL, { headers: { Accept: "application/json" }, ...(timeout ? { signal: timeout } : {}) });
	if (!res.ok) throw new Error(`npm answered ${res.status}`);
	const tags = (await res.json()) as { latest?: unknown };
	if (!parseVersion(tags.latest)) throw new Error("npm's answer had no latest version");
	return String(tags.latest).trim();
}

let checking: Promise<UpdateState> | null = null;

/** The saved answer, or a new one when it's a day old (or six hours after a failure). */
async function latestState(ctx: Ctx, now: number): Promise<UpdateState> {
	const saved = (await ctx.kv.get<UpdateState>(STATE_KEY).catch(() => null)) ?? { checkedAt: null, latest: null };
	if (age(saved.checkedAt, now) < CHECK_EVERY_MS || age(saved.failedAt, now) < RETRY_AFTER_MS) return saved;
	if (checking) return checking;
	checking = (async () => {
		try {
			const state: UpdateState = { checkedAt: new Date(now).toISOString(), latest: await askNpm(ctx), failedAt: null };
			await ctx.kv.set(STATE_KEY, state);
			return state;
		} catch (error) {
			ctx.log.warn("Update check: couldn't ask npm", { error: error instanceof Error ? error.message : String(error) });
			// Keep the last answer; try again later.
			const state: UpdateState = { ...saved, failedAt: new Date(now).toISOString() };
			await ctx.kv.set(STATE_KEY, state).catch(() => undefined);
			return state;
		}
	})().finally(() => {
		checking = null;
	});
	return checking;
}

/** Whether a newer Coywolf Pack is on npm. Nothing is asked while the check is off. */
export async function updateStatus(ctx: Ctx, enabled: boolean, now = Date.now()): Promise<UpdateStatus> {
	if (!enabled) return { enabled: false, current: VERSION };
	const state = await latestState(ctx, now);
	return {
		enabled: true,
		current: VERSION,
		latest: state.latest,
		available: isNewer(state.latest, VERSION),
		checkedAt: state.checkedAt,
		releasesUrl: RELEASES_URL,
		command: UPDATE_COMMAND,
	};
}

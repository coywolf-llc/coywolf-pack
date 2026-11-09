/**
 * Update check: once a day, ask npm which version of Coywolf Pack is the
 * latest, and tell the admin when it's newer than the one this site runs.
 * The request is npm's public dist-tags for the package; it carries nothing
 * about the site.
 *
 * The answer is a plugin setting (an option row), registered with the
 * switches' query, so EmDash's admin manifest can list the dashboard card
 * only while an update is waiting (see updateCardVisible). A daily task
 * keeps it current; the pack pages' notice also checks when it's a day old.
 */
import { isOn, knownFeatures, knownSiteSetting, registerSiteSetting, rememberSiteSetting } from "../core/features.js";
import { DEADLINES, sharedRead, sharedSlot } from "../core/single-flight.js";
import { afterResponse } from "../shared.js";
import { VERSION } from "../version.js";
import { DIST_TAGS_URL, RELEASES_URL, UPDATE_COMMAND, isNewer, parseVersion } from "./core.js";

export const UPDATE_STATE_SETTING = "updateState";
registerSiteSetting(UPDATE_STATE_SETTING);

const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** After a failed check, wait this long before asking npm again. */
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 5_000;

export interface UpdateState {
	/** When npm last answered. */
	checkedAt: string | null;
	latest: string | null;
	/** When the last check failed (cleared by a successful one). */
	failedAt?: string | null;
	/** The version an admin dismissed the notice for (site-wide; a newer version shows again). */
	dismissed?: string | null;
}

export type UpdateStatus =
	| { enabled: false; current: string }
	| { enabled: true; current: string; latest: string | null; available: boolean; dismissed: boolean; checkedAt: string | null; releasesUrl: string; command: string };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface Ctx {
	settings: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<void> };
	log: { warn(message: string, data?: unknown): void };
	http?: { fetch: Fetch } | null;
}

const age = (at: string | null | undefined, now: number) => (at ? now - Date.parse(at) : Number.POSITIVE_INFINITY);
const EMPTY: UpdateState = { checkedAt: null, latest: null };

/** True when the state has an update the site hasn't dismissed. */
export function showsUpdate(state: UpdateState | null | undefined, current = VERSION): boolean {
	return Boolean(state && isNewer(state.latest, current) && state.dismissed !== state.latest);
}

/**
 * For the admin manifest (synchronous): list the dashboard card only while the check is on and an
 * undismissed update is waiting, as this isolate last read them (afresh for every manifest request).
 */
export function updateCardVisible(): boolean {
	const features = knownFeatures();
	if (!features || !isOn(features, "updates")) return false;
	return showsUpdate(knownSiteSetting<UpdateState>(UPDATE_STATE_SETTING));
}

async function readState(ctx: Ctx): Promise<UpdateState> {
	return (await ctx.settings.get<UpdateState>(UPDATE_STATE_SETTING).catch(() => null)) ?? { ...EMPTY };
}

async function writeState(ctx: Ctx, state: UpdateState): Promise<void> {
	await ctx.settings.set(UPDATE_STATE_SETTING, state);
	rememberSiteSetting(UPDATE_STATE_SETTING, state);
}

async function askNpm(ctx: Ctx): Promise<string> {
	const doFetch = (ctx.http ? ctx.http.fetch.bind(ctx.http) : fetch) as Fetch;
	const timeout = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
	const res = await doFetch(DIST_TAGS_URL, { headers: { Accept: "application/json" }, ...(timeout ? { signal: timeout } : {}) });
	if (!res.ok) throw new Error(`npm answered ${res.status}`);
	const tags = (await res.json()) as { latest?: unknown };
	if (!parseVersion(tags.latest)) throw new Error("npm's answer had no latest version");
	return String(tags.latest).trim();
}

/** A check under way: concurrent admin page loads share it, for a bounded time (DEADLINES.updateCheckWaitMs, src/core/single-flight.ts). */
const checking = sharedSlot<UpdateState>();

/** The saved answer, or a new one when it's a day old (or six hours after a failure). */
export async function checkForUpdate(ctx: Ctx, now = Date.now()): Promise<UpdateState> {
	const saved = await readState(ctx);
	if (age(saved.checkedAt, now) < CHECK_EVERY_MS || age(saved.failedAt, now) < RETRY_AFTER_MS) return saved;
	return sharedRead(checking, () => askAndSave(ctx, now), { waitMs: DEADLINES.updateCheckWaitMs, anchor: afterResponse, label: "the update check" });
}

/** Ask npm, and save the answer (or the failure). */
async function askAndSave(ctx: Ctx, now: number): Promise<UpdateState> {
	let latest: string;
	try {
		latest = await askNpm(ctx);
	} catch (error) {
		ctx.log.warn("Update check: couldn't ask npm", { error: error instanceof Error ? error.message : String(error) });
		// Keep the last answer (re-read, so a dismissal made meanwhile isn't lost); try again later.
		const current = await readState(ctx);
		const state: UpdateState = { ...current, failedAt: new Date(now).toISOString() };
		await writeState(ctx, state).catch(() => undefined);
		return state;
	}
	// Re-read before writing, so a dismissal made while npm answered isn't lost.
	const current = await readState(ctx);
	const state: UpdateState = { ...current, checkedAt: new Date(now).toISOString(), latest, failedAt: null };
	await writeState(ctx, state);
	return state;
}

/** Whether a newer Coywolf Pack is on npm. Nothing is asked while the check is off. */
export async function updateStatus(ctx: Ctx, enabled: boolean, now = Date.now()): Promise<UpdateStatus> {
	if (!enabled) return { enabled: false, current: VERSION };
	const state = await checkForUpdate(ctx, now);
	const available = isNewer(state.latest, VERSION);
	return {
		enabled: true,
		current: VERSION,
		latest: state.latest,
		available,
		dismissed: available && state.dismissed === state.latest,
		checkedAt: state.checkedAt,
		releasesUrl: RELEASES_URL,
		command: UPDATE_COMMAND,
	};
}

/** Hide the notice (pack pages and the dashboard card) for this version, for everyone on the site. */
export async function dismissUpdate(ctx: Ctx, version: string): Promise<UpdateState> {
	const state = await readState(ctx);
	const next: UpdateState = { ...state, dismissed: version };
	await writeState(ctx, next);
	return next;
}

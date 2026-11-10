/**
 * How every Insights report is kept, like the Performance page's usage card:
 * a reading is stored in plugin KV and served until it's `ttlMs` old; Refresh
 * reads again unless the last reading is under `refreshMinMs` old; after a
 * failed reading the provider isn't asked again for `retryAfterMs` (rate
 * limits), and the last good reading, if any, is shown with what went wrong.
 * Concurrent page loads in one isolate share one reading (sharedRead, with a
 * deadline, anchored with waitUntil).
 *
 * A reading belongs to the settings it was made with (`fingerprint`: the
 * site ID, the property, which key is saved…), so changing them reads again
 * at once instead of showing the old site's numbers for an hour.
 */
import { type SharedSlot, sharedRead } from "../core/single-flight.js";
import { afterResponse } from "../shared.js";
import { INSIGHTS_DEADLINES } from "./keys.js";

export interface CachePolicy {
	/** Plugin KV key of the reading; `${key}:failed` holds the last failure. */
	key: string;
	ttlMs: number;
	refreshMinMs: number;
	retryAfterMs: number;
	/** For the stalled-read warning. */
	label: string;
}

/** What a loader finds: a reason it can't read yet (no key, no site ID…), or the report. */
export type Loaded<T> = { setup: string; missing?: string[] } | { report: T; notes?: string[] };

export type ReportState<T> =
	| { state: "setup"; reason: string; missing: string[] }
	| { state: "ready"; at: string; report: T; notes: string[] }
	| { state: "error"; message: string };

interface Stored<T> {
	at: string;
	fingerprint: string;
	report: T;
	notes: string[];
}

interface Failed {
	at: string;
	fingerprint: string;
	message: string;
}

export interface ReportKv {
	get<V>(key: string): Promise<V | null | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete?(key: string): Promise<unknown>;
}

/**
 * A setup step found by asking the provider (no zone for the host, no Web Analytics site, no Search Console
 * property) is kept this long, so an open page doesn't ask again on every load; Refresh asks at once.
 */
export const SETUP_TTL_MS = 10 * 60_000;

interface SetupStored {
	at: string;
	fingerprint: string;
	reason: string;
	missing: string[];
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** The cached reading, a new one, or why there's none. Never throws. */
export async function cachedReport<T>(
	kv: ReportKv,
	policy: CachePolicy,
	fingerprint: string,
	refresh: boolean,
	slot: SharedSlot<ReportState<T>>,
	load: () => Promise<Loaded<T>>,
	now: () => number = Date.now,
): Promise<ReportState<T>> {
	const failedKey = `${policy.key}:failed`;
	const setupKey = `${policy.key}:setup`;
	const cached = await kv.get<Stored<T>>(policy.key).catch(() => null);
	const usable = cached && cached.fingerprint === fingerprint && typeof cached.at === "string" ? cached : null;
	const ready = (s: Stored<T>, extra: string[] = []): ReportState<T> => ({ state: "ready", at: s.at, report: s.report, notes: [...(s.notes ?? []), ...extra] });
	const age = usable ? now() - Date.parse(usable.at) : Number.POSITIVE_INFINITY;
	if (usable && age < (refresh ? policy.refreshMinMs : policy.ttlMs)) return ready(usable);
	if (!refresh) {
		const setup = await kv.get<SetupStored>(setupKey).catch(() => null);
		if (setup && setup.fingerprint === fingerprint && now() - Date.parse(setup.at) < SETUP_TTL_MS) return { state: "setup", reason: setup.reason, missing: setup.missing ?? [] };
	}

	if (!slot.flight) {
		const failed = await kv.get<Failed>(failedKey).catch(() => null);
		if (failed && failed.fingerprint === fingerprint && now() - Date.parse(failed.at) < policy.retryAfterMs) {
			const wait = `${failed.message} Trying again after ${hhmm(Date.parse(failed.at) + policy.retryAfterMs)} UTC.`;
			return usable ? ready(usable, [`Couldn't refresh: ${wait}`]) : { state: "error", message: wait };
		}
	}

	const readNow = async (): Promise<ReportState<T>> => {
		try {
			const loaded = await load();
			if ("setup" in loaded) {
				const setup: SetupStored = { at: new Date(now()).toISOString(), fingerprint, reason: loaded.setup, missing: loaded.missing ?? [] };
				await kv.set(setupKey, setup).catch(() => undefined);
				return { state: "setup", reason: setup.reason, missing: setup.missing };
			}
			const stored: Stored<T> = { at: new Date(now()).toISOString(), fingerprint, report: loaded.report, notes: loaded.notes ?? [] };
			await kv.set(policy.key, stored);
			await kv.delete?.(failedKey)?.catch?.(() => undefined);
			await kv.delete?.(setupKey)?.catch?.(() => undefined);
			return ready(stored);
		} catch (error) {
			const message = messageOf(error);
			await kv.set(failedKey, { at: new Date(now()).toISOString(), fingerprint, message } satisfies Failed).catch(() => undefined);
			return usable ? ready(usable, [`Couldn't refresh: ${message}`]) : { state: "error", message };
		}
	};
	return sharedRead(slot, readNow, { waitMs: INSIGHTS_DEADLINES.sharedWaitMs, anchor: afterResponse, label: policy.label });
}

/** Forget a report's reading and failure (after its settings change, or when its data is deleted). */
export async function forgetReport(kv: ReportKv, key: string): Promise<void> {
	await kv.delete?.(key)?.catch?.(() => undefined);
	await kv.delete?.(`${key}:failed`)?.catch?.(() => undefined);
	await kv.delete?.(`${key}:setup`)?.catch?.(() => undefined);
}

/** A short, stable fingerprint of a report's settings (never the secret itself: only whether one is saved and a hash of it). */
export async function fingerprintOf(parts: Array<string | null | undefined | boolean>): Promise<string> {
	const text = parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("\u0000");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

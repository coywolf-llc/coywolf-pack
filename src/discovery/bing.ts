/**
 * Bing Webmaster API (pure part): URL submissions to Bing with the site
 * owner's own API key, next to the IndexNow ping.
 *
 * Why: Bing and api.indexnow.org throttle IndexNow pings sent from
 * Cloudflare Workers' shared egress IPs. Every IndexNow submission from the
 * pack's sites since October 11, 2026 got 429 TooManyRequests, while the same
 * POST from another network got 202. The Webmaster API is authenticated per
 * user and has a quota per site, so with a key Bing gets the URLs reliably.
 *
 * The API, from Microsoft's docs:
 * - The key: Bing Webmaster Tools → Settings → API access → API Key →
 *   Generate. One key per user, valid for every site verified in that account.
 *   https://learn.microsoft.com/en-us/bingwebmaster/getting-access
 * - JSON protocol and errors: a failed call answers HTTP 400 with
 *   {"ErrorCode":3,"Message":"InvalidApiKey"}.
 *   https://learn.microsoft.com/en-us/bingwebmaster/getting-started
 *   Error codes (ApiErrorCode):
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.apierrorcode?view=bing-webmaster-dotnet
 * - SubmitUrlBatch: POST https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlBatch?apikey=KEY,
 *   body {"siteUrl":"http://example.com","urlList":["http://example.com/url1",…]},
 *   answer 200 {"d":null}. At most 500 URLs a batch, and no more than the
 *   available quota (read it with GetUrlSubmissionQuota first).
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi.submiturlbatch?view=bing-webmaster-dotnet
 * - GetUrlSubmissionQuota: GET https://ssl.bing.com/webmaster/api.svc/json/GetUrlSubmissionQuota?siteUrl=…&apikey=KEY,
 *   answer {"d":{"__type":"UrlSubmissionQuota:#…","DailyQuota":5,"MonthlyQuota":24}}.
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi.geturlsubmissionquota?view=bing-webmaster-dotnet
 * - siteUrl must be a site added and verified in the key owner's Bing
 *   Webmaster Tools account.
 *
 * The key travels in the query string (the API's only key-based method), so
 * no request URL is ever logged, and error text is scrubbed of the key.
 *
 * URLs that can't go out now (over the quota, out of time, Bing unreachable)
 * wait in a queue (state:discovery:bingPending, oldest first, at most
 * BING_PENDING_LIMIT) that every submission drains first and a daily task
 * drains on its own, so nothing is dropped for being one URL over the quota.
 *
 * No EmDash imports, so tests can load it.
 */
import { DEADLINES } from "../core/single-flight.js";
import { type Fetch, type PingLogEntry, fetchWithin } from "./indexnow.js";

export const BING_API_HOST = "ssl.bing.com";
const BASE = `https://${BING_API_HOST}/webmaster/api.svc/json`;
/** The Recent submissions log's endpoint for these attempts. */
export const BING_ENDPOINT = "bing-api";
/** SubmitUrlBatch's limit per request. */
export const BING_BATCH_LIMIT = 500;
/** A quota reading older than this (or from an earlier UTC day) is read again before the next submission. */
export const QUOTA_TTL_MS = 60 * 60_000;
/** Most URLs waiting for Bing; over it, the oldest are dropped (and logged). Two days of a 500/day quota. */
export const BING_PENDING_LIMIT = 1000;
export const BING_DOCS_URL = "https://learn.microsoft.com/en-us/bingwebmaster/getting-access";

/** What GetUrlSubmissionQuota last said is left for the site, kept in KV and counted down as batches go out. */
export interface BingQuota {
	daily: number;
	monthly: number;
	checkedAt: string;
}

/** The siteUrl Bing expects: the site's origin, as in Microsoft's samples (http://example.com). */
export function bingSiteUrl(origin: string): string {
	return new URL(origin).origin;
}

/** Deduped URLs on the site's host (Bing rejects URLs of other sites). */
export function siteUrls(siteUrl: string, urls: string[]): string[] {
	const host = new URL(siteUrl).host;
	return [...new Set(urls)].filter((url) => {
		try {
			return new URL(url).host === host;
		} catch {
			return false;
		}
	});
}

export function chunk<T>(list: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** The SubmitUrlBatch request for one batch (at most BING_BATCH_LIMIT URLs). */
export function submitRequest(siteUrl: string, apiKey: string, urls: string[]): { url: string; init: RequestInit } {
	return {
		url: `${BASE}/SubmitUrlBatch?apikey=${encodeURIComponent(apiKey)}`,
		init: { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ siteUrl, urlList: urls }) },
	};
}

export function quotaRequestUrl(siteUrl: string, apiKey: string): string {
	return `${BASE}/GetUrlSubmissionQuota?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`;
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

/** GetUrlSubmissionQuota's answer, or null when it isn't one. */
export function parseQuota(text: string): { daily: number; monthly: number } | null {
	try {
		const d = (JSON.parse(text) as { d?: { DailyQuota?: unknown; MonthlyQuota?: unknown } } | null)?.d;
		const daily = count(d?.DailyQuota);
		const monthly = count(d?.MonthlyQuota);
		return daily === null || monthly === null ? null : { daily, monthly };
	} catch {
		return null;
	}
}

/** ApiErrorCode names (Microsoft's ApiErrorCode enum). */
const ERROR_NAMES: Record<number, string> = {
	0: "None",
	1: "InternalError",
	2: "UnknownError",
	3: "InvalidApiKey",
	4: "ThrottleUser",
	5: "ThrottleHost",
	6: "UserBlocked",
	7: "InvalidUrl",
	8: "InvalidParameter",
	9: "TooManySites",
	10: "UserNotFound",
	11: "NotFound",
	12: "AlreadyExists",
	13: "NotAllowed",
	14: "NotAuthorized",
	15: "UnexpectedState",
	16: "Deprecated",
};

/**
 * The site wasn't found in the key's account. Most often the site was added there with another URL form
 * (https:// vs http://, www. or not) than this site's own, or isn't verified in that account.
 */
const siteHint = (siteUrl: string) =>
	`Bing has no site matching ${siteUrl} in the key's Bing Webmaster Tools account: most often the site was added there as ${otherForm(siteUrl)} (https:// vs http://, www. or not), or it isn't verified in that account`;

/** The other common spelling of the site's URL, to point at the usual mismatch. */
function otherForm(siteUrl: string): string {
	try {
		const url = new URL(siteUrl);
		url.host = url.host.startsWith("www.") ? url.host.slice(4) : `www.${url.host}`;
		return url.origin;
	} catch {
		return "another URL";
	}
}

const HINTS: Record<number, (siteUrl: string) => string> = {
	3: () => "Bing doesn't accept this key: copy it again from Bing Webmaster Tools → Settings → API access",
	4: () => "Bing is throttling this key for now; later submissions try again",
	5: () => "Bing is throttling this site for now; later submissions try again",
	6: () => "Bing has blocked the Bing Webmaster Tools account this key belongs to",
	10: () => "Bing can't find the account this key belongs to",
	13: siteHint,
	14: siteHint,
};

/**
 * Error codes that say the key itself won't work, however often it's tried: the key is wrong (InvalidApiKey),
 * or its account is blocked (UserBlocked) or gone (UserNotFound). A key saved with one of these is removed again.
 * NotAllowed/NotAuthorized aren't here: the key may be fine and the site not (yet) verified in its account.
 */
export const PERMANENT_KEY_ERRORS: ReadonlySet<number> = new Set([3, 6, 10]);
/**
 * Error codes after which sending the same batch again can't help: the key errors, a bad URL or parameter in
 * the batch (InvalidUrl, InvalidParameter), or a site the account doesn't own (NotAllowed, NotAuthorized).
 * Anything else (no answer, 5xx, throttling, the quota) is temporary, and the batch waits in the queue.
 */
export const PERMANENT_BATCH_ERRORS: ReadonlySet<number> = new Set([3, 6, 7, 8, 10, 13, 14]);

/** Bing's ErrorCode in a failed call's body, or undefined when the body isn't one of its error objects. */
export function bingErrorCode(text: string): number | undefined {
	try {
		const body = JSON.parse(text) as { ErrorCode?: unknown } | null;
		return typeof body?.ErrorCode === "number" ? body.ErrorCode : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A readable error for a failed call: Bing's ErrorCode by name, its message, and what to do. Bing prefixes its
 * messages with "ERROR!!! " (a call with a made-up key, November 9, 2026: HTTP 400
 * {"ErrorCode":3,"Message":"ERROR!!! InvalidApiKey"}); the prefix is dropped.
 */
export function bingErrorText(response: { status: number; statusText: string; text: string }, siteUrl: string): string {
	let code: number | undefined;
	let message = "";
	try {
		const body = JSON.parse(response.text) as { ErrorCode?: unknown; Message?: unknown } | null;
		if (typeof body?.ErrorCode === "number") {
			code = body.ErrorCode;
			message = typeof body.Message === "string" ? body.Message.replace(/^\s*ERROR!*\s*/i, "").trim() : "";
		}
	} catch {
		// Not JSON: the raw text below.
	}
	if (code === undefined) return (response.text.trim() || response.statusText || `HTTP ${response.status}`).slice(0, 300);
	const name = ERROR_NAMES[code] ?? "Error";
	const hint = HINTS[code]?.(siteUrl);
	const detail = message && message !== name ? `: ${message}` : "";
	return `${name} (ErrorCode ${code})${detail}${hint ? `. ${hint[0].toUpperCase()}${hint.slice(1)}.` : ""}`.slice(0, 300);
}

/** Bing's answer when a batch goes over the quota names the quota (e.g. "Quota remaining for today: 0"). */
export function isQuotaError(text: string): boolean {
	return /quota/i.test(text);
}

/** `text` without the API key in it, in plain or URL-encoded form or as an apikey= parameter. */
export function redact(text: string, apiKey: string): string {
	let out = text.replace(/apikey=[^&\s"'<>]*/gi, "apikey=…");
	for (const form of new Set([apiKey, encodeURIComponent(apiKey)])) if (form) out = out.split(form).join("…");
	return out;
}

/** Whether a stored quota reading can be used now (same UTC day, within QUOTA_TTL_MS). */
export function quotaFresh(quota: BingQuota | null, now: number): quota is BingQuota {
	if (!quota) return false;
	const at = Date.parse(quota.checkedAt);
	return Number.isFinite(at) && now - at >= 0 && now - at < QUOTA_TTL_MS && new Date(at).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
}

/**
 * What a submission needs from the host. The two stored values (the quota, the
 * queue) are changed through `update…` functions that take the stored value and
 * return the new one, so the host can apply them with compare-and-set: two
 * isolates finishing submissions at the same moment then both count, instead of
 * the later write replacing the earlier one.
 */
export interface BingDeps {
	/** The plugin's fetch (EmDash checks the host against allowedHosts); null without network:request. */
	fetch: Fetch | null;
	readQuota(): Promise<BingQuota | null>;
	/**
	 * Store `change(stored quota)`. `change` may run more than once (a retry after a concurrent write), so it
	 * must be a pure function of its argument. Returning null stores nothing (and removes a stored value).
	 */
	updateQuota(change: (current: BingQuota | null) => BingQuota | null): Promise<void>;
	/** URLs waiting for Bing, oldest first. */
	readPending(): Promise<string[]>;
	/** Store `change(stored queue)`; same rules as updateQuota. An empty result removes the queue. */
	updatePending(change: (current: string[]) => string[]): Promise<void>;
	now?: () => number;
	/** Per call (default DEADLINES.searchPingMs). */
	timeoutMs?: number;
	/** All the calls of one submission (default DEADLINES.bingSubmitBudgetMs). */
	budgetMs?: number;
}

export type QuotaCheck =
	| { ok: true; quota: BingQuota }
	| {
			ok: false;
			/** HTTP status; 0 when Bing didn't answer (network, deadline, no capability). */
			status: number;
			/** Bing's ErrorCode, when its answer had one. */
			code?: number;
			/** True when the key itself won't work (PERMANENT_KEY_ERRORS): trying again can't help. */
			permanent: boolean;
			error: string;
	  };

/** GetUrlSubmissionQuota for the site, stored when it answers. Never throws. */
export async function checkQuota(deps: BingDeps, siteUrl: string, apiKey: string): Promise<QuotaCheck> {
	const now = deps.now ?? Date.now;
	try {
		if (!deps.fetch) throw new Error("network:request capability missing");
		const response = await fetchWithin(
			deps.fetch,
			quotaRequestUrl(siteUrl, apiKey),
			{ method: "GET", headers: JSON_HEADERS },
			deps.timeoutMs ?? DEADLINES.searchPingMs,
			"Bing Webmaster API quota check",
		);
		if (!response.ok) {
			const code = bingErrorCode(response.text);
			return {
				ok: false,
				status: response.status,
				...(code === undefined ? {} : { code }),
				permanent: code !== undefined && PERMANENT_KEY_ERRORS.has(code),
				error: redact(bingErrorText(response, siteUrl), apiKey),
			};
		}
		const parsed = parseQuota(response.text);
		if (!parsed) return { ok: false, status: response.status, permanent: false, error: "Bing's answer had no quota in it." };
		const quota: BingQuota = { ...parsed, checkedAt: new Date(now()).toISOString() };
		await deps.updateQuota(() => quota).catch(() => undefined);
		return { ok: true, quota };
	} catch (error) {
		return { ok: false, status: 0, permanent: false, error: redact(String(error), apiKey).slice(0, 300) };
	}
}

const QUEUED = "Queued for the next submission";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** `text` ending in a period (Bing's messages and thrown errors don't), so another sentence can follow. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * Submit the queued URLs and then `urls` with SubmitUrlBatch: batches of at
 * most 500, never more than the quota known to be left (read when the stored
 * reading isn't fresh; unknown when that read fails, and then Bing enforces
 * it), within the submission's time budget. One log entry per batch sent,
 * plus one for URLs queued for later (over the quota, out of time, or Bing
 * unreachable) and one when the queue overflowed. Stops at the first failed
 * batch. Never throws.
 */
export async function submitToBing(deps: BingDeps, siteUrl: string, apiKey: string, urls: string[], trigger: PingLogEntry["trigger"]): Promise<PingLogEntry[]> {
	const now = deps.now ?? Date.now;
	const started = now();
	const timeoutMs = deps.timeoutMs ?? DEADLINES.searchPingMs;
	const budgetMs = deps.budgetMs ?? DEADLINES.bingSubmitBudgetMs;
	// The queue first (oldest first), then the new URLs.
	const storedQueue = await deps.readPending().catch((): string[] => []);
	const pending = siteUrls(siteUrl, storedQueue);
	const list = [...new Set([...pending, ...siteUrls(siteUrl, urls)])];
	if (!list.length) {
		// Only URLs that aren't this site's any more (the site moved): out of the queue, nothing to send.
		if (storedQueue.length) await deps.updatePending((current) => siteUrls(siteUrl, current)).catch(() => undefined);
		return [];
	}
	const entry = (batch: string[], patch: Partial<PingLogEntry> = {}): PingLogEntry => ({
		at: new Date(now()).toISOString(),
		endpoint: BING_ENDPOINT,
		count: batch.length,
		urls: batch.slice(0, 10),
		status: 0,
		ok: false,
		trigger,
		...patch,
	});
	const entries: PingLogEntry[] = [];

	const stored = await deps.readQuota().catch(() => null);
	let quota = stored;
	if (!quotaFresh(quota, now())) {
		const check = await checkQuota(deps, siteUrl, apiKey);
		quota = check.ok ? check.quota : null;
	}
	/** The reading the count-down starts from (what's stored when the submission ends, when nothing newer is). */
	const reading = quota;
	let send = list;
	/** URLs that wait for the next submission. */
	const queued: string[] = [];
	/** URLs Bing answered for, well or for good: they leave the queue. */
	const settled: string[] = [];
	/** URLs Bing accepted (counted off the quota). */
	let sent = 0;
	let exhausted = false;
	let held: PingLogEntry | null = null;
	if (quota) {
		const left = Math.min(quota.daily, quota.monthly);
		if (left < list.length) {
			send = list.slice(0, left);
			const which = quota.monthly < quota.daily ? `monthly (${quota.monthly} left this month)` : `daily (${quota.daily} left today)`;
			queued.push(...list.slice(left));
			held = entry(list.slice(left), { queued: true, error: `${QUEUED}: over Bing's ${which} URL submission quota for this site.` });
		}
	}

	const batches = chunk(send, BING_BATCH_LIMIT);
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const rest = batches.slice(i + 1).flat();
		if (now() - started > budgetMs - timeoutMs) {
			const later = batches.slice(i).flat();
			queued.push(...later);
			entries.push(entry(later, { queued: true, error: `${QUEUED}: this one ran out of time after ${i} batch${i === 1 ? "" : "es"}.` }));
			break;
		}
		const attempt = entry(batch);
		let permanent = false;
		try {
			if (!deps.fetch) throw new Error("network:request capability missing");
			const request = submitRequest(siteUrl, apiKey, batch);
			const response = await fetchWithin(deps.fetch, request.url, request.init, timeoutMs, "Bing Webmaster API submission");
			attempt.status = response.status;
			attempt.ok = response.ok;
			if (response.ok) {
				settled.push(...batch);
				sent += batch.length;
				if (quota) {
					quota = { ...quota, daily: Math.max(0, quota.daily - batch.length), monthly: Math.max(0, quota.monthly - batch.length) };
					attempt.quotaLeft = quota.daily;
				}
			} else {
				attempt.error = bingErrorText(response, siteUrl);
				const code = bingErrorCode(response.text);
				if (isQuotaError(response.text)) {
					// Used up (other submissions, another tool): hold off until the next reading.
					quota = { daily: 0, monthly: quota?.monthly ?? 0, checkedAt: new Date(now()).toISOString() };
					attempt.quotaLeft = 0;
					exhausted = true;
				} else if (code !== undefined && PERMANENT_BATCH_ERRORS.has(code)) {
					permanent = true;
				}
			}
		} catch (error) {
			attempt.error = String(error);
		}
		if (!attempt.ok) {
			if (permanent) {
				// Sending it again can't help: the batch leaves the queue, and so does the rest (same key, same site).
				settled.push(...batch, ...rest);
				if (rest.length) attempt.error = `${attempt.error} (${plural(rest.length, "more URL")} not sent.)`;
			} else {
				queued.push(...batch, ...rest);
				attempt.queued = true;
				attempt.error = `${sentence(attempt.error ?? "")} ${QUEUED}${rest.length ? `, with ${plural(rest.length, "more URL")}` : ""}.`;
			}
		}
		entries.push(attempt);
		if (!attempt.ok) break;
	}
	if (held) entries.push(quota ? { ...held, quotaLeft: quota.daily } : held);

	// What's left of the quota, counted down from the stored reading (another isolate's submissions count too).
	if (sent > 0 || exhausted) {
		const checkedAt = new Date(now()).toISOString();
		await deps
			.updateQuota((current) => {
				// A reading newer than ours may already include our batches; counting them twice only holds URLs
				// back until the next hourly reading, while counting them once too few would over-send.
				const base = current ?? reading;
				if (!base) return exhausted ? { daily: 0, monthly: 0, checkedAt } : null;
				const next = { ...base, daily: Math.max(0, base.daily - sent), monthly: Math.max(0, base.monthly - sent) };
				return exhausted ? { ...next, daily: 0, checkedAt } : next;
			})
			.catch(() => undefined);
	}

	// The queue: what Bing answered for leaves it, what waits joins it (newest last); the oldest over the cap go.
	if (pending.length || queued.length || settled.length) {
		let dropped: string[] = [];
		await deps
			.updatePending((current) => {
				const done = new Set(settled);
				const next = [...new Set([...siteUrls(siteUrl, current).filter((url) => !done.has(url)), ...queued])];
				dropped = next.length > BING_PENDING_LIMIT ? next.slice(0, next.length - BING_PENDING_LIMIT) : [];
				return next.slice(dropped.length);
			})
			.catch(() => undefined);
		if (dropped.length) {
			entries.push(entry(dropped, { error: `Dropped: the queue for Bing holds at most ${BING_PENDING_LIMIT.toLocaleString("en-US")} URLs, so the oldest ${plural(dropped.length, "URL")} left it.` }));
		}
	}
	for (const e of entries) if (e.error) e.error = redact(e.error, apiKey).slice(0, 400);
	return entries;
}

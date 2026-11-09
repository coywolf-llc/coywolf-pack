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

const HINTS: Record<number, (host: string) => string> = {
	3: () => "Bing doesn't accept this key: copy it again from Bing Webmaster Tools → Settings → API access",
	4: () => "Bing is throttling this key for now; later submissions try again",
	5: () => "Bing is throttling this site for now; later submissions try again",
	6: () => "Bing has blocked the Bing Webmaster Tools account this key belongs to",
	10: () => "Bing can't find the account this key belongs to",
	13: (host) => `the key's Bing Webmaster Tools account must have ${host} added and verified`,
	14: (host) => `the key's Bing Webmaster Tools account must have ${host} added and verified`,
};

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
	const hint = HINTS[code]?.(new URL(siteUrl).host);
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

export interface BingDeps {
	/** The plugin's fetch (EmDash checks the host against allowedHosts); null without network:request. */
	fetch: Fetch | null;
	readQuota(): Promise<BingQuota | null>;
	writeQuota(quota: BingQuota): Promise<void>;
	now?: () => number;
	/** Per call (default DEADLINES.searchPingMs). */
	timeoutMs?: number;
	/** All the calls of one submission (default DEADLINES.bingSubmitBudgetMs). */
	budgetMs?: number;
}

export type QuotaCheck = { ok: true; quota: BingQuota } | { ok: false; status: number; error: string };

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
		if (!response.ok) return { ok: false, status: response.status, error: redact(bingErrorText(response, siteUrl), apiKey) };
		const parsed = parseQuota(response.text);
		if (!parsed) return { ok: false, status: response.status, error: "Bing's answer had no quota in it." };
		const quota: BingQuota = { ...parsed, checkedAt: new Date(now()).toISOString() };
		await deps.writeQuota(quota).catch(() => undefined);
		return { ok: true, quota };
	} catch (error) {
		return { ok: false, status: 0, error: redact(String(error), apiKey).slice(0, 300) };
	}
}

/**
 * Submit `urls` with SubmitUrlBatch: batches of at most 500, never more than
 * the quota known to be left (read when the stored reading isn't fresh;
 * unknown when that read fails, and then Bing enforces it), within the
 * submission's time budget. One log entry per batch sent, plus one for URLs
 * held back (quota, time). Stops at the first failed batch. Never throws.
 */
export async function submitToBing(deps: BingDeps, siteUrl: string, apiKey: string, urls: string[], trigger: PingLogEntry["trigger"]): Promise<PingLogEntry[]> {
	const now = deps.now ?? Date.now;
	const started = now();
	const timeoutMs = deps.timeoutMs ?? DEADLINES.searchPingMs;
	const budgetMs = deps.budgetMs ?? DEADLINES.bingSubmitBudgetMs;
	const list = siteUrls(siteUrl, urls);
	if (!list.length) return [];
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

	let quota = await deps.readQuota().catch(() => null);
	if (!quotaFresh(quota, now())) {
		const check = await checkQuota(deps, siteUrl, apiKey);
		quota = check.ok ? check.quota : null;
	}
	let changed = false;
	let send = list;
	let held: PingLogEntry | null = null;
	if (quota) {
		const left = Math.min(quota.daily, quota.monthly);
		if (left < list.length) {
			send = list.slice(0, left);
			const which = quota.monthly < quota.daily ? `monthly (${quota.monthly} left this month)` : `daily (${quota.daily} left today)`;
			held = entry(list.slice(left), { error: `Not sent: over Bing's ${which} URL submission quota for this site.` });
		}
	}

	const batches = chunk(send, BING_BATCH_LIMIT);
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const rest = batches.slice(i + 1).flat().length;
		if (now() - started > budgetMs - timeoutMs) {
			entries.push(entry(batches.slice(i).flat(), { error: `Not sent: this submission ran out of time after ${i} batch${i === 1 ? "" : "es"}.` }));
			break;
		}
		const attempt = entry(batch);
		try {
			if (!deps.fetch) throw new Error("network:request capability missing");
			const request = submitRequest(siteUrl, apiKey, batch);
			const response = await fetchWithin(deps.fetch, request.url, request.init, timeoutMs, "Bing Webmaster API submission");
			attempt.status = response.status;
			attempt.ok = response.ok;
			if (response.ok) {
				if (quota) {
					quota = { ...quota, daily: Math.max(0, quota.daily - batch.length), monthly: Math.max(0, quota.monthly - batch.length) };
					attempt.quotaLeft = quota.daily;
					changed = true;
				}
			} else {
				attempt.error = bingErrorText(response, siteUrl);
				if (isQuotaError(response.text)) {
					// Used up (other submissions, another tool): hold off until the next reading.
					quota = { daily: 0, monthly: quota?.monthly ?? 0, checkedAt: new Date(now()).toISOString() };
					attempt.quotaLeft = 0;
					changed = true;
				}
			}
		} catch (error) {
			attempt.error = String(error);
		}
		if (!attempt.ok && rest) attempt.error = `${attempt.error} (${rest} more URL${rest === 1 ? "" : "s"} not sent.)`;
		entries.push(attempt);
		if (!attempt.ok) break;
	}
	if (held) entries.push(quota ? { ...held, quotaLeft: quota.daily } : held);
	if (changed && quota) await deps.writeQuota(quota).catch(() => undefined);
	for (const e of entries) if (e.error) e.error = redact(e.error, apiKey).slice(0, 300);
	return entries;
}

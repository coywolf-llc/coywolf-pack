/**
 * IndexNow (pure part): key handling, the submission payload, sending one
 * ping within a deadline, and a batcher that collects changed URLs for a
 * short window, dedupes them, and submits them in one request.
 *
 * Coywolf SEO pinged Bing once per URL; here several changes in quick
 * succession (a save followed by a publish, a bulk edit) go out as one POST,
 * which every IndexNow endpoint accepts (up to 10,000 URLs).
 *
 * No EmDash imports, so tests can load it.
 */
import { DEADLINES, withDeadline } from "../core/single-flight.js";

export const INDEXNOW_ENDPOINTS = {
	"api.indexnow.org": "https://api.indexnow.org/indexnow",
	"www.bing.com": "https://www.bing.com/indexnow",
} as const;
export type IndexNowEndpoint = keyof typeof INDEXNOW_ENDPOINTS;

/** IndexNow keys: 8–128 characters of a–z, A–Z, 0–9 and "-". */
export const KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;
export const MAX_URLS_PER_REQUEST = 10_000;

/** A new 32-character lowercase hex key. */
export function generateKey(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The key a `/<key>.txt` request asks for, or null when the path isn't key-shaped. */
export function keyFromPath(pathname: string): string | null {
	const match = /^\/([a-zA-Z0-9-]{8,128})\.txt$/.exec(pathname);
	return match ? match[1] : null;
}

export interface IndexNowPayload {
	host: string;
	key: string;
	keyLocation: string;
	urlList: string[];
}

/**
 * The POST body for a batch. URLs on other hosts are dropped: IndexNow
 * rejects a batch whose URLs don't all belong to the key's host.
 */
export function buildPayload(siteUrl: string, key: string, urls: string[]): IndexNowPayload | null {
	const site = new URL(siteUrl);
	const urlList = [...new Set(urls)].filter((url) => {
		try {
			return new URL(url).host === site.host;
		} catch {
			return false;
		}
	});
	if (!urlList.length) return null;
	return {
		host: site.host,
		key,
		keyLocation: `${site.origin}/${key}.txt`,
		urlList: urlList.slice(0, MAX_URLS_PER_REQUEST),
	};
}

/** One attempt in the Recent submissions log (`state:discovery:indexnowLog`). */
export interface PingLogEntry {
	at: string;
	/** An IndexNow endpoint (INDEXNOW_ENDPOINTS' keys) or "bing-api" (the Bing Webmaster API). */
	endpoint: string;
	count: number;
	/** The first 10 URLs. */
	urls: string[];
	/** HTTP status; 0 when no answer came (or nothing was sent). */
	status: number;
	ok: boolean;
	error?: string;
	trigger: "content" | "manual";
	/** Bing Webmaster API: URLs the site's daily quota still allows after this attempt, when known. */
	quotaLeft?: number;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchResult {
	status: number;
	ok: boolean;
	statusText: string;
	text: string;
}

/**
 * `fetch` and its body within `ms`: an AbortSignal on the request and a
 * deadline of the caller's own, in case the fetch ignores the signal.
 * Rejects with a DeadlineError (or the fetch's error).
 */
export function fetchWithin(fetch: Fetch, url: string, init: RequestInit, ms: number, what: string): Promise<FetchResult> {
	const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
	return withDeadline(
		fetch(url, { ...init, ...(signal ? { signal } : {}) }).then(async (response) => ({
			status: response.status,
			ok: response.ok,
			statusText: response.statusText,
			text: await response.text().catch(() => ""),
		})),
		ms,
		what,
	);
}

/** POST one IndexNow payload. Never throws: the outcome is the returned log entry. */
export async function sendIndexNow(
	fetch: Fetch | null,
	endpoint: IndexNowEndpoint,
	payload: IndexNowPayload,
	trigger: PingLogEntry["trigger"],
	timeoutMs: number = DEADLINES.searchPingMs,
): Promise<PingLogEntry> {
	const entry: PingLogEntry = {
		at: new Date().toISOString(),
		endpoint,
		count: payload.urlList.length,
		urls: payload.urlList.slice(0, 10),
		status: 0,
		ok: false,
		trigger,
	};
	try {
		if (!fetch) throw new Error("network:request capability missing");
		const response = await fetchWithin(
			fetch,
			INDEXNOW_ENDPOINTS[endpoint],
			{ method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) },
			timeoutMs,
			`IndexNow ping to ${endpoint}`,
		);
		entry.status = response.status;
		entry.ok = response.ok;
		if (!response.ok) entry.error = response.text.slice(0, 300) || response.statusText;
	} catch (error) {
		entry.error = String(error).slice(0, 300);
	}
	return entry;
}

export interface BatcherOptions {
	/** How long to wait for more URLs before submitting. */
	windowMs: number;
	/** Keep work alive past the response (EmDash's `after()` / waitUntil). */
	defer: (task: () => Promise<void>) => void;
	sleep?: (ms: number) => Promise<void>;
}

export type BatchSender = (urls: string[]) => Promise<void>;

/**
 * Collects URLs for `windowMs`, then hands the deduped list to the most
 * recent sender. One pending batch per isolate.
 */
export class IndexNowBatcher {
	private pending = new Set<string>();
	private sender: BatchSender | null = null;
	private scheduled = false;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly options: BatcherOptions;

	constructor(options: BatcherOptions) {
		this.options = options;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	get size(): number {
		return this.pending.size;
	}

	add(urls: string | string[], sender: BatchSender): void {
		for (const url of Array.isArray(urls) ? urls : [urls]) if (url) this.pending.add(url);
		if (!this.pending.size) return;
		this.sender = sender;
		if (this.scheduled) return;
		this.scheduled = true;
		this.options.defer(async () => {
			await this.sleep(this.options.windowMs);
			await this.flush();
		});
	}

	/** Submit what's pending now. */
	async flush(): Promise<void> {
		this.scheduled = false;
		const urls = [...this.pending];
		const sender = this.sender;
		this.pending.clear();
		this.sender = null;
		if (urls.length && sender) await sender(urls);
	}
}

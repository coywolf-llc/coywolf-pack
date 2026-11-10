/**
 * One JSON request to a provider other than Cloudflare (Fathom, Google), with
 * a deadline that covers the answer's body, aborted when it's past. The
 * caller passes ctx.http's fetch (contextFetch), so the plugin's allowed
 * hosts apply. A secret given as `secret` never appears in an error message.
 */
import { type Fetch, scrubToken } from "../core/cloudflare-api.js";
import { withDeadline } from "../core/single-flight.js";

export interface JsonAnswer {
	status: number;
	ok: boolean;
	/** The parsed body, or null when it wasn't JSON. */
	body: unknown;
	retryAfter: string | null;
}

export async function fetchJson(doFetch: Fetch, url: string, init: RequestInit, deadlineMs: number, what: string, secret?: string | null): Promise<JsonAnswer> {
	const controller = new AbortController();
	try {
		return await withDeadline(
			(async () => {
				const response = await doFetch(url, { ...init, signal: controller.signal });
				const text = await response.text();
				let body: unknown = null;
				try {
					body = text ? JSON.parse(text) : null;
				} catch {
					body = null;
				}
				return { status: response.status, ok: response.ok, body, retryAfter: response.headers.get("retry-after") };
			})(),
			deadlineMs,
			what,
		);
	} catch (error) {
		controller.abort();
		if (error instanceof Error) {
			const scrubbed = scrubToken(error.message, secret);
			if (scrubbed !== error.message) error.message = scrubbed;
		}
		throw error;
	}
}

/**
 * The pack's one client for Cloudflare's v4 API (api.cloudflare.com), used
 * by every module that calls it: media host setup, Cloudflare usage, Crawler
 * Hints, the Radar crawler list, Stream and backup restores.
 *
 * Every call has a deadline (a call past it is aborted), goes through the
 * plugin's ctx.http when the caller has it (so the plugin's allowed hosts
 * apply), parses Cloudflare's envelope ({ success, result, errors }) into
 * the result or one error class, and never lets the API token into an error
 * message. Each module keeps its own paths, types and wording.
 *
 * Kept free of EmDash imports so tests can load it directly.
 */
import { DEADLINES, withDeadline } from "./single-flight.js";

export const CLOUDFLARE_API_HOST = "api.cloudflare.com";
export const CLOUDFLARE_API = `https://${CLOUDFLARE_API_HOST}/client/v4`;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** One of Cloudflare's errors, with the chain of causes it sometimes carries. */
export interface CloudflareErrorItem {
	code?: number;
	message?: string;
	error_chain?: CloudflareErrorItem[] | null;
}

export class CloudflareApiError extends Error {
	readonly status: number;
	/** Every error code in the answer, causes included. */
	readonly codes: number[];
	/** Cloudflare's errors as it sent them. */
	readonly errors: CloudflareErrorItem[];
	constructor(message: string, status: number, errors: CloudflareErrorItem[] = []) {
		super(message);
		this.name = "CloudflareApiError";
		this.status = status;
		this.errors = errors;
		this.codes = errors.flatMap((e) => [e, ...(Array.isArray(e.error_chain) ? e.error_chain : [])]).map((e) => Number(e.code)).filter(Number.isFinite);
	}
}

/** ctx.http's fetch (the plugin's allowed hosts apply) when the context has one, else the global fetch. */
export function contextFetch(ctx?: { http?: { fetch(url: string, init?: RequestInit): Promise<Response> } } | null): Fetch {
	return ctx?.http ? (ctx.http.fetch.bind(ctx.http) as Fetch) : (url, init) => fetch(url, init);
}

/** `text` with the token, and anything sent as a bearer credential, replaced. */
export function scrubToken(text: string, token?: string | null): string {
	let out = text.replaceAll(/Bearer\s+\S+/gi, "Bearer …");
	if (token && token.length >= 8) out = out.replaceAll(token, "…");
	return out;
}

export interface CloudflareCall {
	token: string;
	method?: string;
	/** Sent as JSON (a string is taken to be JSON already), or FormData as it is. */
	body?: unknown;
	headers?: Record<string, string>;
	fetch?: Fetch;
	/** Default DEADLINES.cloudflareApiMs. The deadline covers the answer's body too. */
	deadlineMs?: number;
	/** What the token needs, added to the message of a 401 or 403 ("The API token needs …."). */
	permission?: string;
	/** The start of an error message (default "Cloudflare API"). */
	label?: string;
	/** GraphQL (/graphql): the whole body comes back, and an answer with errors and no data fails. */
	graphql?: boolean;
}

/** Cloudflare's messages, joined. */
export const errorDetail = (errors: CloudflareErrorItem[]) =>
	errors
		.map((e) => e.message)
		.filter(Boolean)
		.join("; ");

/**
 * One call to `path` (under /client/v4). Returns the envelope's result (or
 * the whole body for GraphQL) and the HTTP status. Throws CloudflareApiError
 * for an error answer ("<label> <status>: <Cloudflare's messages>." and the
 * permission hint on 401/403), a DeadlineError past the deadline, and the
 * network error otherwise, each without the token.
 */
export async function cloudflareApi<T>(path: string, call: CloudflareCall): Promise<{ status: number; result: T }> {
	const doFetch = call.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
	const headers: Record<string, string> = { Authorization: `Bearer ${call.token}`, ...(call.headers ?? {}) };
	let body: BodyInit | undefined;
	if (call.body instanceof FormData) body = call.body;
	else if (call.body !== undefined) {
		body = typeof call.body === "string" ? call.body : JSON.stringify(call.body);
		headers["Content-Type"] ??= "application/json";
	}
	const controller = new AbortController();
	type Envelope = { success?: boolean; result?: T; errors?: CloudflareErrorItem[] | null; data?: unknown };
	let status: number;
	let statusText: string;
	let ok: boolean;
	let envelope: Envelope;
	try {
		({ status, statusText, ok, envelope } = await withDeadline(
			(async () => {
				const response = await doFetch(`${CLOUDFLARE_API}${path}`, { method: call.method ?? (body === undefined ? "GET" : "POST"), headers, body, signal: controller.signal });
				const parsed = (await response.json().catch(() => ({}))) as Envelope;
				return { status: response.status, statusText: response.statusText, ok: response.ok, envelope: parsed ?? {} };
			})(),
			call.deadlineMs ?? DEADLINES.cloudflareApiMs,
			`${call.label ?? "Cloudflare's API"} (${path.split("?")[0]})`,
		));
	} catch (error) {
		controller.abort();
		if (error instanceof Error) {
			const scrubbed = scrubToken(error.message, call.token);
			if (scrubbed !== error.message) error.message = scrubbed;
		}
		throw error;
	}
	const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
	const failed = !ok || envelope.success === false || (call.graphql === true && errors.length > 0 && envelope.data === undefined);
	if (failed) {
		const detail = errorDetail(errors) || statusText || "error";
		const hint = (status === 401 || status === 403) && call.permission ? ` The API token needs ${call.permission}.` : "";
		throw new CloudflareApiError(scrubToken(`${call.label ?? "Cloudflare API"} ${status}: ${detail}.${hint}`, call.token), status, errors);
	}
	return { status, result: (call.graphql ? envelope : envelope.result ?? null) as T };
}

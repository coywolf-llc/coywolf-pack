/**
 * The admin pages' requests to plugin routes: one error-text helper and one
 * POST and GET helper, in place of the copy each page used to keep.
 *
 * Kept free of JSX so tests can load it directly.
 */
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";

/** The pack's plugin routes (`/_emdash/api/plugins/coywolf-pack/<route>`). */
export const PACK_API = "/_emdash/api/plugins/coywolf-pack";

/** The message of a thrown error, or `fallback` when it has none. */
export const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

export interface RequestOptions {
	/** The error message when the route doesn't give one (default "The request failed"). */
	fallback?: string;
	signal?: AbortSignal;
}

const DEFAULT_FALLBACK = "The request failed";

/** POST `body` as JSON (no body when it's undefined) and return the route's data. Throws with the route's error message, else `fallback`. */
export async function postJson<T>(url: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
	const response = await apiFetch(url, {
		method: "POST",
		...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		...(options.signal ? { signal: options.signal } : {}),
	});
	return parseApiResponse<T>(response, options.fallback ?? DEFAULT_FALLBACK);
}

/** GET a route and return its data. Throws with the route's error message, else `fallback`. */
export async function getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
	const response = await apiFetch(url, options.signal ? { signal: options.signal } : undefined);
	return parseApiResponse<T>(response, options.fallback ?? DEFAULT_FALLBACK);
}

/** Options for one page's helpers: the error message when a route gives none, and the body sent when a call passes none. */
export interface ApiDefaults {
	fallback?: string;
	/** Sent when a call passes no body (for routes that expect a JSON object). Unset: no body. */
	body?: unknown;
}

const merge = (defaults: ApiDefaults, options?: string | RequestOptions): RequestOptions => ({
	...(defaults.fallback ? { fallback: defaults.fallback } : {}),
	...(typeof options === "string" ? { fallback: options } : options),
});

/**
 * `post(path, body?, fallback | options?)` for the routes under `base`:
 * `const post = apiPost(\`${PACK_API}/schema\`)`, then `post("save", { … }, "Couldn't save")`.
 */
export function apiPost(base: string, defaults: ApiDefaults = {}) {
	return <T>(path: string, body: unknown = defaults.body, options?: string | RequestOptions): Promise<T> =>
		postJson<T>(`${base}/${path}`, body, merge(defaults, options));
}

/** `get(path, fallback | options?)` for the routes under `base`. */
export function apiGet(base: string, defaults: Omit<ApiDefaults, "body"> = {}) {
	return <T>(path: string, options?: string | RequestOptions): Promise<T> => getJson<T>(`${base}/${path}`, merge(defaults, options));
}

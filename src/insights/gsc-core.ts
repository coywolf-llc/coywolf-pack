/**
 * Google Search Console (pure part): the service account key, the signed
 * JWT, properties, date ranges and what the Search Analytics answers become.
 *
 * Google's server-to-server flow (developers.google.com/identity/protocols/
 * oauth2/service-account): a JWT with header { alg: "RS256", typ: "JWT",
 * kid }, claims { iss: client_email, scope, aud:
 * "https://oauth2.googleapis.com/token", iat, exp ≤ iat + 1 hour }, signed
 * with the key's RSA private key (SHA256withRSA, here WebCrypto's
 * RSASSA-PKCS1-v1_5), is exchanged at https://oauth2.googleapis.com/token
 * (grant_type urn:ietf:params:oauth:grant-type:jwt-bearer) for an access
 * token valid for an hour. Search Analytics: POST
 * https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
 * with the webmasters.readonly scope; dates are YYYY-MM-DD in Pacific Time;
 * rows come sorted by clicks. Quotas are per site, user and project (1,200
 * queries a minute per site), with load limits for queries grouped by page or
 * query, so a reading is three small queries, kept for hours.
 *
 * Only crypto.subtle (no imports), so `node --test` can load this file.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SEARCH_CONSOLE_API = "https://www.googleapis.com/webmasters/v3";
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const DAY_MS = 86_400_000;

export interface ServiceAccount {
	client_email: string;
	private_key: string;
	private_key_id?: string;
	project_id?: string;
}

/**
 * The fields the pack keeps from a pasted JSON key. Throws a message that
 * never repeats what was pasted.
 */
export function parseServiceAccount(text: string): ServiceAccount {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.trim());
	} catch {
		throw new Error("That isn't a JSON key file. In Google Cloud, create a key of type JSON for the service account and paste the whole file.");
	}
	// any: the key file.
	const k = (parsed ?? {}) as any;
	if (k.type !== undefined && k.type !== "service_account") throw new Error(`That JSON key is for a ${String(k.type).slice(0, 40)}, not a service account. Create a key for a service account.`);
	if (typeof k.client_email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k.client_email)) throw new Error("The JSON key has no client_email. Paste the whole key file.");
	if (typeof k.private_key !== "string" || !k.private_key.includes("-----BEGIN PRIVATE KEY-----")) throw new Error("The JSON key has no private key (private_key). Paste the whole key file.");
	return {
		client_email: k.client_email.trim(),
		private_key: k.private_key,
		...(typeof k.private_key_id === "string" ? { private_key_id: k.private_key_id } : {}),
		...(typeof k.project_id === "string" ? { project_id: k.project_id } : {}),
	};
}

/** The DER bytes of a PEM PKCS#8 private key. */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
	const base64 = pem
		.replace(/\\n/g, "\n")
		.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
		.replace(/\s+/g, "");
	const binary = atob(base64);
	const out = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function base64url(input: string | Uint8Array): string {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The signed assertion for Google's token endpoint, valid for an hour from `nowS`. */
export async function signServiceJwt(account: ServiceAccount, options: { scope: string; nowS: number; subtle?: SubtleCrypto }): Promise<string> {
	const subtle = options.subtle ?? crypto.subtle;
	const header = { alg: "RS256", typ: "JWT", ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
	const claims = { iss: account.client_email, scope: options.scope, aud: GOOGLE_TOKEN_URL, iat: options.nowS, exp: options.nowS + 3600 };
	const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
	let key: CryptoKey;
	try {
		key = await subtle.importKey("pkcs8", pemToPkcs8(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	} catch {
		// Not the import's own message: keep anything about the key out of errors and logs.
		throw new Error("The service account's private key couldn't be read. Create a new JSON key and save it again.");
	}
	const signature = new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
	return `${unsigned}.${base64url(signature)}`;
}

/** The form body for the token exchange. */
export const tokenRequestBody = (assertion: string) => new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString();

/**
 * A Search Console property as the API names it: "sc-domain:example.com" for
 * a domain property, or a URL-prefix property ending in "/". A bare domain
 * means its domain property. Null when it's neither.
 */
export function normalizeProperty(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const value = input.trim();
	if (!value) return null;
	const domain = /^sc-domain:([a-z0-9.-]+\.[a-z]{2,})$/i.exec(value);
	if (domain) return `sc-domain:${domain[1].toLowerCase()}`;
	if (/^https?:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			if (url.search || url.hash) return null;
			return `${url.origin}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
		} catch {
			return null;
		}
	}
	return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? `sc-domain:${value.toLowerCase()}` : null;
}

/** The property for this site among those the service account can read: its domain property first, then a URL prefix of its origin. */
export function pickProperty(entries: Array<{ siteUrl?: unknown; permissionLevel?: unknown }>, origin: string): string | null {
	const host = new URL(origin).host.toLowerCase();
	const usable = entries.filter((e) => typeof e.siteUrl === "string" && e.permissionLevel !== "siteUnverifiedUser").map((e) => e.siteUrl as string);
	const domains = usable
		.filter((u) => u.startsWith("sc-domain:"))
		.map((u) => ({ u, d: u.slice("sc-domain:".length).toLowerCase() }))
		.filter(({ d }) => host === d || host.endsWith(`.${d}`))
		.sort((a, b) => b.d.length - a.d.length);
	if (domains[0]) return domains[0].u;
	const prefix = usable.filter((u) => !u.startsWith("sc-domain:") && u.replace(/\/+$/, "/").startsWith(`${origin.replace(/\/+$/, "")}/`)).sort((a, b) => a.length - b.length);
	return prefix[0] ?? null;
}

/** A date in Pacific Time (Search Console's), as YYYY-MM-DD. */
export function pacificDate(ms: number): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The last 28 full days in Pacific Time, ending yesterday (today's data is still coming in). */
export function gscRange(now: number, days = 28): { startDate: string; endDate: string } {
	const endDate = shift(pacificDate(now), -1);
	return { startDate: shift(endDate, -(days - 1)), endDate };
}

export interface GscRow {
	key: string;
	clicks: number;
	impressions: number;
	/** 0–1. */
	ctr: number;
	position: number;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseGscRows(body: unknown): GscRow[] {
	// any: Search Analytics answer.
	const rows = Array.isArray((body as any)?.rows) ? ((body as any).rows as any[]) : [];
	return rows.map((r) => ({ key: Array.isArray(r?.keys) ? String(r.keys[0] ?? "") : "", clicks: n(r?.clicks), impressions: n(r?.impressions), ctr: n(r?.ctr), position: n(r?.position) }));
}

export interface GscReport {
	property: string;
	startDate: string;
	endDate: string;
	totals: Omit<GscRow, "key">;
	queries: GscRow[];
	pages: GscRow[];
	/** Days from here on may still change (Google's first incomplete date), when it says. */
	incompleteFrom: string | null;
}

export function gscReport(property: string, range: { startDate: string; endDate: string }, answers: { totals: unknown; queries: unknown; pages: unknown }): GscReport {
	const total = parseGscRows(answers.totals)[0];
	// any: metadata.
	const meta = (answers.totals as any)?.metadata;
	return {
		property,
		...range,
		totals: { clicks: total?.clicks ?? 0, impressions: total?.impressions ?? 0, ctr: total?.ctr ?? 0, position: total?.position ?? 0 },
		queries: parseGscRows(answers.queries),
		pages: parseGscRows(answers.pages),
		incompleteFrom: typeof meta?.first_incomplete_date === "string" ? meta.first_incomplete_date : null,
	};
}

/** What Google's error answer means, with the step that fixes it. Never includes the key. */
export function googleError(status: number, body: unknown, email: string): string {
	// any: Google's errors ({ error: { code, message, status } } from APIs, { error, error_description } from the token endpoint).
	const b = (body ?? {}) as any;
	const message = String(typeof b.error === "object" ? (b.error?.message ?? "") : (b.error_description ?? b.error ?? "")).slice(0, 300);
	if (b.error === "invalid_grant") return `Google refused the service account key (${message || "invalid_grant"}): it may have been deleted or disabled, or the server clock is off. Create a new JSON key and save it.`;
	if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(`${message} ${JSON.stringify(b.error?.details ?? "")}`)) return `The Google Search Console API isn't turned on for the key's Google Cloud project. Turn it on (step 2 of the guide), wait a few minutes, then refresh.`;
	if (status === 403) return `${email} can't read this Search Console property (${message || "forbidden"}). Add it as a user on the property in Search Console (Settings → Users and permissions), with Restricted or Full permission.`;
	if (status === 404) return `Search Console has no such property (${message || "not found"}). Check the property: sc-domain:example.com for a domain property, or the exact URL prefix ending in /.`;
	if (status === 429) return `Google's Search Console quota was reached (${message || "rate limited"}). The card tries again later.`;
	return `Google answered ${status}${message ? `: ${message}` : ""}.`;
}

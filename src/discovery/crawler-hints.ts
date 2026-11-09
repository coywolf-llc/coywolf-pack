/**
 * Crawler Hints: Cloudflare's own IndexNow integration. With it on, Cloudflare
 * tells Bing, Yandex, Seznam, Naver and the other IndexNow engines that a page
 * has likely changed whenever it fetches a fresh copy into its cache. It's a
 * setting of the site's Cloudflare zone, sent from Cloudflare's own systems, so
 * it isn't throttled the way IndexNow pings from Workers' shared IP addresses
 * are (every ping the pack sent from a Worker got HTTP 429).
 *
 * Cloudflare has no public API for the switch. The dashboard reads it from the
 * zone's flags (GET /zones/{id}/flags → cache.crawlhints_enabled) and changes it
 * through an internal endpoint that refuses API tokens (POST
 * /zones/{id}/flags/products/cache/changes answers 10000, Authentication error,
 * even with Zone Settings Edit: checked November 2026). So the pack only reads
 * it, with the read-only token the Performance page uses, and links to the
 * switch in the dashboard.
 */
import { CLOUDFLARE_API_HOST } from "../images/cloudflare.js";
import { DEADLINES, withDeadline } from "../core/single-flight.js";

const API = `https://${CLOUDFLARE_API_HOST}/client/v4`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The dashboard page with the switch: Caching → Configuration of the site's zone. */
export function crawlerHintsDashboardUrl(zone?: { name: string; accountId: string | null } | null): string {
	if (zone?.accountId) return `https://dash.cloudflare.com/${encodeURIComponent(zone.accountId)}/${encodeURIComponent(zone.name)}/caching/configuration`;
	// No account known: the dashboard asks for the account and the zone, then opens the page.
	return "https://dash.cloudflare.com/?to=/:account/:zone/caching/configuration";
}

/** Zone names that can hold `host`, most specific first: get.example.com, example.com (never a bare TLD). */
export function zoneCandidates(host: string): string[] {
	const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i <= labels.length - 2 && out.length < 4; i++) out.push(labels.slice(i).join("."));
	return out;
}

export interface CrawlerHintsZone {
	id: string;
	name: string;
	accountId: string | null;
}

export type CrawlerHintsProblem =
	/** No token to read with. */
	| "no-token"
	/** The token sees no zone for the site's host (it lacks Zone → Zone → Read, or the zone is in another account). */
	| "no-zone"
	/** The token sees the zone but Cloudflare won't show it the setting. */
	| "no-access"
	/** Cloudflare couldn't be reached, or answered in a way the pack doesn't understand. */
	| "error";

export interface CrawlerHintsStatus {
	/** On or off in Cloudflare; null when it couldn't be read (see `problem`). */
	enabled: boolean | null;
	host: string;
	zone: CrawlerHintsZone | null;
	/** The switch in the Cloudflare dashboard (the zone's Caching → Configuration). */
	dashboardUrl: string;
	/** Why it couldn't be read, and what to do. Absent when it was read. */
	problem?: { kind: CrawlerHintsProblem; message: string };
	checkedAt: string;
}

class CloudflareApiError extends Error {
	readonly status: number;
	readonly codes: number[];
	constructor(status: number, codes: number[], message: string) {
		super(message);
		this.status = status;
		this.codes = codes;
	}
}

/** One Cloudflare API call with its own deadline; the token never appears in an error. */
async function api<T>(doFetch: Fetch, token: string, path: string): Promise<T> {
	const response = await withDeadline(doFetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } }), DEADLINES.cloudflareReadMs, "Cloudflare's API");
	const body = (await response.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> | null };
	if (!response.ok || body.success === false) {
		const errors = Array.isArray(body.errors) ? body.errors : [];
		const detail = errors.map((e) => (e.code ? `${e.message ?? "error"} (code ${e.code})` : e.message)).filter(Boolean).join("; ");
		throw new CloudflareApiError(response.status, errors.map((e) => Number(e.code)).filter(Number.isFinite), `HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	return body.result as T;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).replaceAll(/Bearer\s+\S+/g, "Bearer …").slice(0, 300);

/** Cloudflare's answer for a token that may not do this (HTTP 401/403, or its authentication and permission codes). */
const refused = (error: unknown) =>
	error instanceof CloudflareApiError && (error.status === 401 || error.status === 403 || error.codes.some((c) => c === 10000 || c === 9109));

export interface CrawlerHintsDeps {
	/** The read-only Cloudflare API token (Performance page → Cloudflare usage), or null. */
	token: string | null;
	fetch: Fetch;
	/** The zone found before for this host, so it isn't looked up again. */
	knownZone?: CrawlerHintsZone | null;
	now?: () => number;
}

/** Find the site's zone, then read whether Crawler Hints is on. Never throws: what went wrong is in `problem`. */
export async function readCrawlerHints(host: string, deps: CrawlerHintsDeps): Promise<CrawlerHintsStatus> {
	const checkedAt = new Date((deps.now ?? Date.now)()).toISOString();
	const base = { enabled: null, host, zone: null, dashboardUrl: crawlerHintsDashboardUrl(null), checkedAt };
	if (!deps.token) {
		return {
			...base,
			problem: {
				kind: "no-token",
				message:
					"To see here whether Crawler Hints is on, the pack needs a read-only Cloudflare API token with Zone → Zone → Read. The Performance page's Cloudflare usage token works once that permission is added to it.",
			},
		};
	}
	const token = deps.token;

	let zone = deps.knownZone && zoneCandidates(host).includes(deps.knownZone.name) ? deps.knownZone : null;
	if (!zone) {
		try {
			for (const name of zoneCandidates(host)) {
				const found = await api<Array<{ id?: string; name?: string; account?: { id?: string } }>>(deps.fetch, token, `/zones?name=${encodeURIComponent(name)}&per_page=5`);
				const match = (Array.isArray(found) ? found : []).find((z) => z.name === name && typeof z.id === "string");
				if (match?.id) {
					zone = { id: match.id, name, accountId: match.account?.id ?? null };
					break;
				}
			}
		} catch (error) {
			return refused(error)
				? { ...base, problem: { kind: "no-zone", message: `The Cloudflare API token can't list zones (${describe(error)}). Add Zone → Zone → Read to it.` } }
				: { ...base, problem: { kind: "error", message: `Couldn't reach Cloudflare's API: ${describe(error)}` } };
		}
	}
	if (!zone) {
		return {
			...base,
			problem: {
				kind: "no-zone",
				message: `The Cloudflare API token can't see a zone for ${host}. Add Zone → Zone → Read to it (for all zones, or for this site's zone). If it already has that, the zone is in a different Cloudflare account than the token.`,
			},
		};
	}

	const withZone = { ...base, zone, dashboardUrl: crawlerHintsDashboardUrl(zone) };
	try {
		const flags = await api<{ cache?: { crawlhints_enabled?: unknown } }>(deps.fetch, token, `/zones/${encodeURIComponent(zone.id)}/flags`);
		const value = flags?.cache?.crawlhints_enabled;
		if (typeof value !== "boolean") {
			return { ...withZone, problem: { kind: "error", message: "Cloudflare's answer didn't include the Crawler Hints setting. Check it in the Cloudflare dashboard." } };
		}
		return { ...withZone, enabled: value };
	} catch (error) {
		return refused(error)
			? {
					...withZone,
					problem: {
						kind: "no-access",
						message: `The token sees ${zone.name}, but Cloudflare didn't show it the Crawler Hints setting (${describe(error)}). Check it in the Cloudflare dashboard.`,
					},
				}
			: { ...withZone, problem: { kind: "error", message: `Couldn't read Crawler Hints from Cloudflare: ${describe(error)}` } };
	}
}

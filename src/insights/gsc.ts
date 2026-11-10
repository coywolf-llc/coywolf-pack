/**
 * Google Search Console card: clicks, impressions, CTR, average position and
 * the top queries and pages for the last 28 days, read with a Google service
 * account's JSON key (an encrypted secret setting) and kept for six hours.
 * The JWT is signed with WebCrypto in the Worker and exchanged for an access
 * token, which this isolate keeps in memory (never stored) until it nearly
 * expires. Neither the key nor the access token is ever logged or put in an
 * error message. The pure part is ./gsc-core.ts.
 */
import type { PluginContext } from "emdash";

import { contextFetch, type Fetch } from "../core/cloudflare-api.js";
import { sharedSlot } from "../core/single-flight.js";
import { siteOrigin } from "../discovery/urls.js";
import { GOOGLE_TOKEN_URL, GSC_SCOPE, type GscReport, SEARCH_CONSOLE_API, type ServiceAccount, googleError, gscRange, gscReport, normalizeProperty, parseServiceAccount, pickProperty, signServiceJwt, tokenRequestBody } from "./gsc-core.js";
import { fetchJson } from "./http.js";
import { INSIGHTS_DEADLINES, INSIGHTS_SETTINGS } from "./keys.js";
import { type ReportState, cachedReport, fingerprintOf } from "./report-cache.js";

export const GSC_POLICY = { key: "cache:insights:searchConsole", ttlMs: 6 * 60 * 60_000, refreshMinMs: 10 * 60_000, retryAfterMs: 15 * 60_000, label: "the Search Console reading" };

const slot = sharedSlot<ReportState<GscReport>>();
/** Access tokens by key fingerprint, in this isolate's memory only. */
const accessTokens = new Map<string, { token: string; until: number }>();

type Ctx = Pick<PluginContext, "settings" | "kv" | "site" | "log"> & { http?: PluginContext["http"] };

/** The saved service account (only the fields the pack keeps), or why there's none. */
export async function googleAccount(ctx: Pick<PluginContext, "settings">): Promise<{ account: ServiceAccount | null; unreadable: boolean }> {
	let raw: unknown;
	try {
		raw = await ctx.settings.get<string>(INSIGHTS_SETTINGS.googleKey);
	} catch {
		return { account: null, unreadable: true };
	}
	if (typeof raw !== "string" || !raw.trim()) return { account: null, unreadable: false };
	try {
		return { account: parseServiceAccount(raw), unreadable: false };
	} catch {
		return { account: null, unreadable: true };
	}
}

async function accessToken(doFetch: Fetch, account: ServiceAccount, fingerprint: string): Promise<string> {
	const known = accessTokens.get(fingerprint);
	if (known && known.until > Date.now()) return known.token;
	const assertion = await signServiceJwt(account, { scope: GSC_SCOPE, nowS: Math.floor(Date.now() / 1000) });
	const answer = await fetchJson(
		doFetch,
		GOOGLE_TOKEN_URL,
		{ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tokenRequestBody(assertion) },
		INSIGHTS_DEADLINES.googleMs,
		"Google's token endpoint",
		assertion,
	);
	// any: token answer.
	const body = answer.body as any;
	if (!answer.ok || typeof body?.access_token !== "string") throw new Error(googleError(answer.status, answer.body, account.client_email));
	const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
	// Five minutes early, so a token never expires halfway through a reading.
	accessTokens.set(fingerprint, { token: body.access_token, until: Date.now() + Math.max(60, lifetime - 300) * 1000 });
	return body.access_token;
}

export async function searchConsoleReport(ctx: Ctx, refresh = false): Promise<ReportState<GscReport>> {
	const { account, unreadable } = await googleAccount(ctx);
	if (unreadable) return { state: "setup", reason: "The saved service account key can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed, or the key isn't a valid JSON key. Save the key again.", missing: ["key"] };
	if (!account) return { state: "setup", reason: "Add a Google service account's JSON key to see Search Console data here.", missing: ["key"] };
	const saved = await ctx.settings.get<string>(INSIGHTS_SETTINGS.searchConsoleProperty).catch(() => null);
	const property = normalizeProperty(saved);
	const origin = siteOrigin(ctx);
	const fingerprint = await fingerprintOf(["gsc", account.client_email, account.private_key_id ?? account.private_key.slice(-80), property, origin]);
	const doFetch = contextFetch(ctx);
	return cachedReport<GscReport>(ctx.kv, GSC_POLICY, fingerprint, refresh, slot, async () => {
		const token = await accessToken(doFetch, account, fingerprint);
		const call = async (url: string, body?: unknown) => {
			const answer = await fetchJson(
				doFetch,
				url,
				body === undefined ? { headers: { Authorization: `Bearer ${token}` } } : { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
				INSIGHTS_DEADLINES.googleMs,
				"Google's Search Console API",
				token,
			);
			if (answer.status === 401) accessTokens.delete(fingerprint);
			if (!answer.ok) throw new Error(googleError(answer.status, answer.body, account.client_email));
			return answer.body;
		};
		let use = property;
		if (!use) {
			// any: the sites list.
			const sites = (await call(`${SEARCH_CONSOLE_API}/sites`)) as any;
			use = pickProperty(Array.isArray(sites?.siteEntry) ? sites.siteEntry : [], origin);
			if (!use) {
				return {
					setup: `${account.client_email} can't see a Search Console property for ${new URL(origin).host} yet. Add it as a user on the site's property in Search Console (step 5 below), or enter the property here.`,
					missing: ["property"],
				};
			}
		}
		const range = gscRange(Date.now());
		const query = (extra: Record<string, unknown>) => call(`${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(use)}/searchAnalytics/query`, { ...range, type: "web", dataState: "all", ...extra });
		const totals = await query({});
		const queries = await query({ dimensions: ["query"], rowLimit: 10 });
		const pages = await query({ dimensions: ["page"], rowLimit: 10 });
		ctx.log.info("Insights: Search Console read", { property: use });
		return { report: gscReport(use, range, { totals, queries, pages }) };
	});
}

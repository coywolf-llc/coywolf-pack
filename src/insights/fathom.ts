/**
 * Fathom traffic card: visitors, pageviews and top pages for the last 7 and
 * 30 days, read with the site's Fathom API key (an encrypted secret setting)
 * and kept for an hour. The pure part is ./fathom-core.ts.
 *
 * Fathom's API is called from Workers' shared IP addresses. Its documentation
 * names no IP-based limits (its limits are per account: requests an hour and
 * at once), and a community Fathom SDK lists Workers as a tested runtime, but
 * Fathom doesn't promise it either way: Bing throttles Workers' addresses, so
 * a 429 or 403 here may be that, and the card says what Fathom answered.
 */
import type { PluginContext } from "emdash";

import { contextFetch } from "../core/cloudflare-api.js";
import { sharedSlot } from "../core/single-flight.js";
import { type FathomReport, aggregationUrl, fathomError, fathomFrom, fathomPages, fathomTotals, normalizeSiteId, siteUrl, validTimeZone } from "./fathom-core.js";
import { fetchJson } from "./http.js";
import { INSIGHTS_DEADLINES, INSIGHTS_SETTINGS } from "./keys.js";
import { type ReportState, cachedReport, fingerprintOf } from "./report-cache.js";

export const FATHOM_POLICY = { key: "cache:insights:fathom", ttlMs: 60 * 60_000, refreshMinMs: 60_000, retryAfterMs: 10 * 60_000, label: "the Fathom reading" };

const slot = sharedSlot<ReportState<FathomReport>>();
/** The site's reporting time zone, read once a day (it changes only when someone changes it in Fathom). */
const SITE_KEY = "state:insights:fathomSite";
const SITE_TTL_MS = 24 * 60 * 60_000;

type Ctx = Pick<PluginContext, "settings" | "kv" | "log"> & { http?: PluginContext["http"] };

/** The saved API key, or null; `unreadable` when one is stored but can't be decrypted. */
export async function fathomKey(ctx: Pick<PluginContext, "settings">): Promise<{ key: string | null; unreadable: boolean }> {
	try {
		const key = await ctx.settings.get<string>(INSIGHTS_SETTINGS.fathomKey);
		return { key: typeof key === "string" && key.trim() ? key.trim() : null, unreadable: false };
	} catch {
		return { key: null, unreadable: true };
	}
}

export async function fathomReport(ctx: Ctx, refresh = false): Promise<ReportState<FathomReport>> {
	const siteId = normalizeSiteId(await ctx.settings.get<string>(INSIGHTS_SETTINGS.fathomSiteId).catch(() => null));
	const { key, unreadable } = await fathomKey(ctx);
	const missing = [...(siteId ? [] : ["siteId"]), ...(key ? [] : ["key"])];
	if (unreadable) return { state: "setup", reason: "The saved Fathom API key can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed. Save the key again.", missing: ["key"] };
	if (!siteId || !key) return { state: "setup", reason: `Add ${!siteId && !key ? "the Fathom site ID and an API key" : !siteId ? "the Fathom site ID" : "a Fathom API key"} to see traffic here.`, missing };
	const fingerprint = await fingerprintOf(["fathom", siteId, key]);
	const doFetch = contextFetch(ctx);
	return cachedReport<FathomReport>(ctx.kv, FATHOM_POLICY, fingerprint, refresh, slot, async () => {
		const get = async (url: string) => {
			const answer = await fetchJson(doFetch, url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }, INSIGHTS_DEADLINES.fathomMs, "Fathom's API", key);
			if (!answer.ok) throw new Error(fathomError(answer.status, answer.body, answer.retryAfter, siteId));
			return answer.body;
		};
		const now = Date.now();
		// Fathom reads date_from in the site's reporting time zone: get it (once a day) so "the last 7 days" match its dashboard.
		const known = await ctx.kv.get<{ siteId: string; timeZone: string; at: string }>(SITE_KEY).catch(() => null);
		let timeZone = known?.siteId === siteId && now - Date.parse(known.at) < SITE_TTL_MS ? known.timeZone : null;
		if (!timeZone) {
			// any: Fathom's site object.
			const site = (await get(siteUrl(siteId))) as any;
			timeZone = validTimeZone(site?.timezone) ?? "UTC";
			await ctx.kv.set(SITE_KEY, { siteId, timeZone, at: new Date(now).toISOString() }).catch(() => undefined);
		}
		const from = (days: number) => fathomFrom(now, days, timeZone);
		// One after another: Fathom allows 5 requests at once per account, and other tools may be using some.
		const week = fathomTotals(await get(aggregationUrl(siteId, { from: from(7), aggregates: ["visits", "pageviews"] })));
		const month = fathomTotals(await get(aggregationUrl(siteId, { from: from(30), aggregates: ["visits", "pageviews"] })));
		const pages = (days: number) => aggregationUrl(siteId, { from: from(days), aggregates: ["pageviews", "uniques"], grouping: "pathname", sort: "pageviews:desc", limit: 10 });
		const weekPages = fathomPages(await get(pages(7)));
		const monthPages = fathomPages(await get(pages(30)));
		ctx.log.info("Insights: Fathom read", { siteId });
		return { report: { siteId, timeZone, week, month, weekPages, monthPages } };
	});
}

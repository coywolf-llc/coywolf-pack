/**
 * Core Web Vitals card: real visitors' LCP, INP and CLS at the 75th
 * percentile from Cloudflare Web Analytics, read with the read-only token
 * (Account Analytics → Read for the numbers, Account Settings → Read to find
 * the site's tag) and kept for an hour. The beacon itself is the
 * insights.beacon part (pack.ts); the card also reads sites whose beacon comes
 * from the theme or from Cloudflare's automatic setup. The pure part is
 * ./vitals-core.ts.
 */
import type { PluginContext } from "emdash";

import { sharedSlot } from "../core/single-flight.js";
import { zoneCandidates } from "../discovery/crawler-hints.js";
import { type Zone, cfCall, cfGraphql, cloudflareAccess, findAccountId, findZone } from "./cloudflare.js";
import { INSIGHTS_SETTINGS } from "./keys.js";
import { type ReportState, cachedReport, fingerprintOf } from "./report-cache.js";
import { type RumSite, type VitalsReport, matchSite, parseSites, parseVitals, vitalsQuery } from "./vitals-core.js";

export const VITALS_POLICY = { key: "cache:insights:vitals", ttlMs: 60 * 60_000, refreshMinMs: 60_000, retryAfterMs: 5 * 60_000, label: "the Core Web Vitals reading" };
const DAY_MS = 86_400_000;
const ANALYTICS = "Account → Account Analytics → Read";

const slot = sharedSlot<ReportState<VitalsReport>>();

type Ctx = Pick<PluginContext, "settings" | "kv" | "site" | "log"> & { http?: PluginContext["http"] };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function vitalsReport(ctx: Ctx, refresh = false, bindings?: Record<string, unknown>): Promise<ReportState<VitalsReport>> {
	const a = await cloudflareAccess(ctx, bindings);
	if ("setup" in a) return { state: "setup", reason: a.setup, missing: ["token"] };
	const token = (await ctx.settings.get<string>(INSIGHTS_SETTINGS.beaconToken).catch(() => null))?.trim() || null;
	const fingerprint = await fingerprintOf(["vitals", a.host, token, a.token]);
	return cachedReport<VitalsReport>(ctx.kv, VITALS_POLICY, fingerprint, refresh, slot, async () => {
		const notes: string[] = [];
		// The zone helps find the account and the site; without Zone → Read the card still works with CF_ACCOUNT_ID.
		let zone: Zone | null = null;
		try {
			zone = await findZone(ctx, a);
		} catch {
			zone = null;
		}
		const accountId = await findAccountId(ctx, a, zone);
		let site: RumSite | null = null;
		try {
			const sites = parseSites(await cfCall<unknown>(a, `/accounts/${encodeURIComponent(accountId)}/rum/site_info/list?per_page=100`, { permission: "Account → Account Settings → Read" }));
			site = matchSite(sites, { token, host: a.host, zoneNames: zone ? [zone.name] : zoneCandidates(a.host) });
		} catch (error) {
			notes.push(`Couldn't list the account's Web Analytics sites (the token needs Account → Account Settings → Read): ${messageOf(error)}`);
		}
		const siteTag = site?.tag ?? token;
		if (!siteTag) {
			return {
				setup: `Cloudflare Web Analytics has no site for ${a.host} in this account yet. Add the site in Cloudflare (the steps are below), then either turn on the Web Analytics beacon part here with its token, or Cloudflare's automatic setup.`,
				missing: ["site"],
			};
		}
		if (!site && token) notes.push("Couldn't look up the site's tag, so the beacon token stands in for it. If nothing shows after a day of visits, add Account → Account Settings → Read to the token.");

		const now = Date.now();
		const variables = { account: accountId, site: siteTag, week: new Date(now - 7 * DAY_MS).toISOString(), month: new Date(now - 30 * DAY_MS).toISOString(), end: new Date(now).toISOString() };
		let result: Awaited<ReturnType<typeof cfGraphql>>;
		try {
			result = await cfGraphql(a, vitalsQuery({ botFilter: true }), variables, ANALYTICS);
		} catch (error) {
			// The bot filter isn't documented for every account: read without it rather than nothing.
			if (!/\bbot\b/i.test(messageOf(error))) throw error;
			result = await cfGraphql(a, vitalsQuery({ botFilter: false }), variables, ANALYTICS);
			notes.push("Cloudflare wouldn't filter out known bots for this account, so these numbers include any bot that ran the beacon.");
		}
		if (result.errors.length) notes.push(`Part of the reading failed: ${result.errors.join("; ")}`);
		// any: GraphQL answer.
		const account = ((result.data as any)?.viewer?.accounts?.[0] ?? null) as Record<string, unknown> | null;
		const report = parseVitals(account, { siteTag, autoInstall: site ? site.autoInstall : null });
		return { report, notes };
	});
}

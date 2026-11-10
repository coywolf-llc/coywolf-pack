/**
 * Edge errors and crawlers: the site's 404 and 410 paths (files, images and
 * the media host included), 5xx responses, and requests per crawler, from
 * Cloudflare's HTTP request analytics for the site's zone. Read with the
 * read-only token (it needs Zone → Zone → Read and Zone → Analytics → Read)
 * and kept for an hour. The pure part is ./edge-core.ts.
 */
import type { PluginContext } from "emdash";

import { sharedSlot } from "../core/single-flight.js";
import { imageCdn } from "../images/lib.js";
import { refreshMediaHost } from "../images/settings.js";
import { baselineBots } from "../robots/directory.js";
import { type CloudflareAccess, type Zone, cfGraphql, cloudflareAccess, findZone, forgetZone, refused } from "./cloudflare.js";
import { type CrawlerPattern, type DatasetLimits, EDGE_DATASET, type EdgeReport, crawlerPatterns, edgeQuery, fieldAvailable, parseDatasetSettings, parseEdgeReport, reportWindow, settingsQuery } from "./edge-core.js";
import { type ReportState, cachedReport, fingerprintOf } from "./report-cache.js";

export const EDGE_POLICY = { key: "cache:insights:edge", ttlMs: 60 * 60_000, refreshMinMs: 60_000, retryAfterMs: 5 * 60_000, label: "the edge errors report" };
/** The zone's dataset limits, read once a day (they change only with the plan). */
const LIMITS_KEY = "state:insights:edgeLimits";
const LIMITS_TTL_MS = 24 * 60 * 60_000;

const slot = sharedSlot<ReportState<EdgeReport>>();

type Ctx = Pick<PluginContext, "settings" | "kv" | "site" | "log"> & { http?: PluginContext["http"] };

let patterns: Promise<CrawlerPattern[]> | null = null;
/** The bundled crawler directory as match patterns, once per isolate. */
function crawlerList(): Promise<CrawlerPattern[]> {
	patterns ??= baselineBots().then(crawlerPatterns, () => []);
	return patterns;
}

/** The media host's name (media.example.com), when Clean Image URLs has one. */
async function mediaHostName(): Promise<string | null> {
	await refreshMediaHost().catch(() => undefined);
	const cdn = imageCdn();
	try {
		return cdn ? new URL(cdn).host.toLowerCase() : null;
	} catch {
		return null;
	}
}

async function datasetLimits(ctx: Ctx, a: CloudflareAccess, zone: Zone, notes: string[]): Promise<DatasetLimits | null> {
	const stored = await ctx.kv.get<{ zone: string; at: string; limits: DatasetLimits }>(LIMITS_KEY).catch(() => null);
	if (stored?.zone === zone.id && Date.now() - Date.parse(stored.at) < LIMITS_TTL_MS) return stored.limits;
	try {
		const { data } = await cfGraphql(a, settingsQuery(EDGE_DATASET), { tag: zone.id }, "Zone → Analytics → Read");
		const limits = parseDatasetSettings({ data }, EDGE_DATASET);
		if (limits) await ctx.kv.set(LIMITS_KEY, { zone: zone.id, at: new Date().toISOString(), limits }).catch(() => undefined);
		else notes.push("Cloudflare didn't say what this zone's plan can query, so the report reads the last 30 days with the fields every plan has.");
		return limits;
	} catch (error) {
		if (refused(error)) throw error;
		notes.push(`Couldn't read the zone's analytics limits (${error instanceof Error ? error.message : String(error)}); the report reads the last 30 days with the fields every plan has.`);
		return null;
	}
}

/** The report (kept an hour), or why it can't be read. `bindings` replaces the Worker's env (tests). */
export async function edgeReport(ctx: Ctx, refresh = false, bindings?: Record<string, unknown>): Promise<ReportState<EdgeReport>> {
	const a = await cloudflareAccess(ctx, bindings);
	if ("setup" in a) return { state: "setup", reason: a.setup, missing: ["token"] };
	const mediaHost = await mediaHostName();
	const fingerprint = await fingerprintOf(["edge", a.host, mediaHost, a.token]);
	return cachedReport<EdgeReport>(ctx.kv, EDGE_POLICY, fingerprint, refresh, slot, async () => {
		const notes: string[] = [];
		let zone: Zone;
		try {
			zone = await findZone(ctx, a);
		} catch (error) {
			return { setup: error instanceof Error ? error.message : String(error), missing: ["zone"] };
		}
		let limits: DatasetLimits | null;
		try {
			limits = await datasetLimits(ctx, a, zone, notes);
		} catch (error) {
			// The remembered zone may have stopped working: look it up again next time.
			await forgetZone(ctx);
			throw error;
		}
		if (limits && !limits.enabled) return { setup: `Cloudflare says this zone (${zone.name}) can't query its HTTP request analytics with this token. Check that the token has Zone → Analytics → Read for it.`, missing: ["permission"] };
		const window = reportWindow(limits, Date.now());
		const verified = fieldAvailable(limits, "verifiedBotCategory");
		const { data, errors } = await cfGraphql(a, edgeQuery({ verifiedBotCategory: verified }), { zone: zone.id, start: window.start, end: window.end }, "Zone → Analytics → Read");
		// any: GraphQL answer.
		const zoneData = ((data as any)?.viewer?.zones?.[0] ?? null) as Record<string, unknown> | null;
		if (errors.length) notes.push(`Part of the report couldn't be read: ${errors.join("; ")}`);
		const report = parseEdgeReport(zoneData, { host: a.host, mediaHost, crawlers: await crawlerList(), days: window.days });
		ctx.log.info("Insights: edge report read", { zone: zone.name, days: window.days, notFound: report.notFound.length });
		return { report, notes };
	});
}

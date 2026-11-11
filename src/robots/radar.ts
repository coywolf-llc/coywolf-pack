/**
 * Weekly crawler-directory refresh from the Cloudflare Radar API.
 *
 *   GET https://api.cloudflare.com/client/v4/radar/bots?limit=1000&offset=N
 *   Authorization: Bearer <token>   (token permission: Account → Radar → Read)
 *
 * The token is the Cloudflare API token (src/core/cloudflare-token.ts), else
 * the older Radar token or the RADAR_API_TOKEN Worker secret.
 *
 * One request covers the whole directory (~710 bots in October 2026; the
 * API caps `limit` at 1000, so we page by offset just in case). The list
 * gives slug, name, operator, category, description, kind and
 * userAgentPatterns — not robots.txt tokens, which is why new bots arrive
 * unverified (see ./bots.ts).
 */
import type { PluginContext } from "emdash";

import { CLOUDFLARE_API_HOST, CloudflareApiError, cloudflareApi, contextFetch, errorDetail } from "../core/cloudflare-api.js";
import { UNREADABLE_TOKEN_MESSAGE, cloudflareToken, noTokenMessage, tokenName } from "../core/cloudflare-token.js";
import { workerEnv } from "../shared.js";
import { type BotOverlay, type RadarBot, mergeRadar } from "./bots.js";
import { baselineBots } from "./directory.js";

export const RADAR_HOST = CLOUDFLARE_API_HOST;
const RADAR_PATH = "/radar/bots";
const PAGE = 1000;
const MAX_PAGES = 3;

export const RADAR_TOKEN_SETTING = "robotsRadarToken";
export const RADAR_TOKEN_SECRET = "RADAR_API_TOKEN";
export const OVERLAY_COLLECTION = "robots_bots";
export const SYNC_STATE_KEY = "state:robots.radarSync";

export interface SyncState {
	at: string;
	ok: boolean;
	total?: number;
	added?: number;
	updated?: number;
	delisted?: number;
	error?: string;
}

/**
 * Where the Radar token comes from: the Cloudflare API token ("shared", saved on the plugin's Settings page;
 * "shared-env", the CLOUDFLARE_API_TOKEN Worker secret), the older Radar token ("settings") or its Worker
 * secret ("env"), or nowhere.
 */
export type RadarTokenSource = "shared" | "shared-env" | "settings" | "env";

async function radarResolved(ctx: Pick<PluginContext, "settings">, bindings?: Record<string, unknown>) {
	return cloudflareToken(ctx, bindings ?? (await workerEnv().catch(() => ({}) as Record<string, unknown>)), "radar");
}

const sourceOf = (source: string | null): RadarTokenSource | null =>
	source === "shared" || source === "shared-env" ? source : source === "older" ? "settings" : source === "older-env" ? "env" : null;

export async function radarTokenSource(ctx: Pick<PluginContext, "settings">, bindings?: Record<string, unknown>): Promise<RadarTokenSource | null> {
	return sourceOf((await radarResolved(ctx, bindings)).source);
}

/** Where the token comes from, and whether a saved one can't be decrypted (with none to use instead), for the Bots tab. */
export async function radarTokenStatus(ctx: Pick<PluginContext, "settings">, bindings?: Record<string, unknown>): Promise<{ tokenSource: RadarTokenSource | null; tokenUnreadable: boolean }> {
	const resolved = await radarResolved(ctx, bindings);
	return { tokenSource: sourceOf(resolved.source), tokenUnreadable: resolved.unreadable && !resolved.token };
}

/** The token the Radar sync uses (`bindings` replaces the Worker's env in tests). */
export async function radarToken(ctx: Pick<PluginContext, "settings">, bindings?: Record<string, unknown>): Promise<string | undefined> {
	return (await radarResolved(ctx, bindings)).token ?? undefined;
}

/** Every overlay document (plugin storage pages are capped at 100). */
export async function readOverlays(ctx: PluginContext): Promise<BotOverlay[]> {
	const collection = ctx.storage[OVERLAY_COLLECTION];
	if (!collection) return [];
	const out: BotOverlay[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 50; i++) {
		const page = await collection.query({ limit: 100, ...(cursor ? { cursor } : {}) });
		for (const item of page.items) out.push(item.data as BotOverlay);
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}
	return out;
}

async function fetchRadar(ctx: PluginContext, token: string, name: string): Promise<RadarBot[]> {
	const doFetch = contextFetch(ctx);
	const bots: RadarBot[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		let result: { bots?: RadarBot[] } | null;
		try {
			({ result } = await cloudflareApi<{ bots?: RadarBot[] } | null>(`${RADAR_PATH}?limit=${PAGE}&offset=${page * PAGE}&format=JSON`, { token, fetch: doFetch, headers: { Accept: "application/json" } }));
		} catch (error) {
			if (!(error instanceof CloudflareApiError)) throw error;
			if (error.status === 401 || error.status === 403) {
				throw new Error(`Cloudflare refused the token (${error.status}). The ${name} needs Radar → Read.`);
			}
			const detail = errorDetail(error.errors);
			throw new Error(`Radar API error ${error.status}${detail ? `: ${detail}` : ""}`);
		}
		const list = result?.bots ?? [];
		bots.push(...list);
		if (list.length < PAGE) break;
	}
	return bots;
}

/** Fetch Radar, merge into the stored overlay, and record the outcome. Throws on failure (after recording it). `bindings` replaces the Worker's env (tests). */
export async function syncRadar(ctx: PluginContext, bindings?: Record<string, unknown>): Promise<SyncState> {
	const at = new Date().toISOString();
	const resolved = await radarResolved(ctx, bindings);
	const token = resolved.token;
	if (!token) {
		const state: SyncState = { at, ok: false, error: resolved.unreadable ? UNREADABLE_TOKEN_MESSAGE : noTokenMessage("Radar → Read") };
		await ctx.kv.set(SYNC_STATE_KEY, state);
		return state;
	}
	try {
		const radar = await fetchRadar(ctx, token, tokenName(resolved));
		if (radar.length < 100) throw new Error(`Radar returned only ${radar.length} bots; keeping the current directory.`);
		const result = mergeRadar(await baselineBots(), await readOverlays(ctx), radar, at.slice(0, 10));
		const collection = ctx.storage[OVERLAY_COLLECTION];
		if (result.writes.length && collection) {
			for (let i = 0; i < result.writes.length; i += 100) {
				await collection.putMany(result.writes.slice(i, i + 100).map((data) => ({ id: data.slug, data })));
			}
		}
		const state: SyncState = { at, ok: true, total: result.total, added: result.added, updated: result.updated, delisted: result.delisted };
		await ctx.kv.set(SYNC_STATE_KEY, state);
		ctx.log.info("Robots: Radar bot directory synced", { total: result.total, added: result.added, updated: result.updated, delisted: result.delisted });
		return state;
	} catch (error) {
		const state: SyncState = { at, ok: false, error: error instanceof Error ? error.message : String(error) };
		await ctx.kv.set(SYNC_STATE_KEY, state);
		ctx.log.error("Robots: Radar sync failed", { error: state.error });
		throw error;
	}
}

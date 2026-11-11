/**
 * Insights' Cloudflare reads (edge errors and crawlers, Core Web Vitals):
 * the Cloudflare API token (src/core/cloudflare-token.ts, as the Performance
 * page's usage card reads it), the site's zone and account, and one call
 * helper over the shared client (src/core/cloudflare-api.ts: deadline,
 * ctx.http, no token in errors).
 */
import type { PluginContext } from "emdash";

import { CloudflareApiError, type Fetch, cloudflareApi, contextFetch } from "../core/cloudflare-api.js";
import { zoneCandidates } from "../discovery/crawler-hints.js";
import { siteOrigin } from "../discovery/urls.js";
import { UNREADABLE_TOKEN_MESSAGE, cloudflareAccountId, noAccountMessage, noTokenMessage, tokenName } from "../core/cloudflare-token.js";
import { readCloudflareToken } from "../pageCache/usage.js";
import { workerEnv } from "../shared.js";
import { INSIGHTS_DEADLINES } from "./keys.js";

export interface CloudflareAccess {
	token: string;
	fetch: Fetch;
	/** The site's host (from EmDash's site URL). */
	host: string;
	env: Record<string, unknown>;
	/** The token's name for messages: the one actually used (src/core/cloudflare-token.ts tokenName). */
	name: string;
}

export interface Zone {
	id: string;
	name: string;
	accountId: string | null;
}

type Ctx = Pick<PluginContext, "settings" | "kv" | "site"> & { http?: PluginContext["http"] };

/** The token (and how to call), or why there's none. */
export async function cloudflareAccess(ctx: Ctx, bindings?: Record<string, unknown>): Promise<CloudflareAccess | { setup: string }> {
	const env = bindings ?? (await workerEnv().catch(() => ({}) as Record<string, unknown>));
	const resolved = await readCloudflareToken(ctx, env);
	const { token, unreadable } = resolved;
	if (!token) {
		return {
			setup: unreadable ? UNREADABLE_TOKEN_MESSAGE : `${noTokenMessage("Zone → Read and Analytics → Read (edge errors), and Account Analytics → Read (Core Web Vitals)")} The steps are below.`,
		};
	}
	return { token, fetch: contextFetch(ctx), host: new URL(siteOrigin(ctx)).host.toLowerCase(), env, name: tokenName(resolved) };
}

/** One call to Cloudflare's API with Insights' deadline. GraphQL calls return the whole body ({ data, errors }). */
export async function cfCall<T>(a: CloudflareAccess, path: string, options: { body?: unknown; permission: string; graphql?: boolean }): Promise<T> {
	const { result } = await cloudflareApi<T>(path, {
		token: a.token,
		fetch: a.fetch,
		method: options.body === undefined ? "GET" : "POST",
		body: options.body,
		graphql: options.graphql,
		permission: options.permission,
		tokenName: a.name,
		deadlineMs: INSIGHTS_DEADLINES.cloudflareMs,
		label: "Cloudflare's API",
	});
	return result;
}

/** A GraphQL query; errors next to data become notes (a node the token or plan can't read), errors without data throw. */
export async function cfGraphql(a: CloudflareAccess, query: string, variables: Record<string, unknown>, permission: string): Promise<{ data: Record<string, unknown> | null; errors: string[] }> {
	const body = await cfCall<{ data?: Record<string, unknown> | null; errors?: Array<{ message?: string }> | null }>(a, "/graphql", { body: { query, variables }, permission, graphql: true });
	const errors = (Array.isArray(body?.errors) ? body.errors : []).map((e) => e?.message ?? "error").filter(Boolean);
	if (!body?.data && errors.length) throw new Error(`Cloudflare analytics: ${errors.join("; ")}. The ${a.name ?? "Cloudflare API token"} needs ${permission}.`);
	return { data: body?.data ?? null, errors };
}

const ZONE_KEY = "state:insights:zone";

/** The site's Cloudflare zone, found once with the token (Zone → Zone → Read) and remembered per host. */
export async function findZone(ctx: Ctx, a: CloudflareAccess): Promise<Zone> {
	const stored = await ctx.kv.get<{ host: string; zone: Zone }>(ZONE_KEY).catch(() => null);
	if (stored?.host === a.host && stored.zone?.id) return stored.zone;
	for (const name of zoneCandidates(a.host)) {
		const found = await cfCall<Array<{ id?: string; name?: string; account?: { id?: string } }>>(a, `/zones?name=${encodeURIComponent(name)}&per_page=5`, { permission: "Zone → Zone → Read" });
		const match = (Array.isArray(found) ? found : []).find((z) => z.name === name && typeof z.id === "string");
		if (match?.id) {
			const zone = { id: match.id, name, accountId: match.account?.id ?? null };
			await ctx.kv.set(ZONE_KEY, { host: a.host, zone }).catch(() => undefined);
			return zone;
		}
	}
	throw new Error(`The ${a.name ?? "Cloudflare API token"} can't see a zone for ${a.host}. Add Zone → Zone → Read to it (for this site's domain, or all domains), or check that the zone is in the token's account.`);
}

/** Forget the remembered zone (it stopped working: deleted and added again, or moved). */
export async function forgetZone(ctx: Ctx): Promise<void> {
	await ctx.kv.delete(ZONE_KEY).catch(() => undefined);
}

/** The account: the CF_ACCOUNT_ID Worker variable, the Clean Image URLs account, the zone's, or the token's only account (src/core/cloudflare-token.ts). */
export async function findAccountId(ctx: Ctx, a: CloudflareAccess, zone?: Zone | null): Promise<string> {
	const id = await cloudflareAccountId(ctx, a.env, { token: a.token, fetch: a.fetch }, null, { hint: zone?.accountId });
	if (id) return id;
	throw new Error(noAccountMessage());
}

/** Cloudflare refused the token (401/403, or its authentication and permission codes). */
export const refused = (error: unknown) => error instanceof CloudflareApiError && (error.status === 401 || error.status === 403 || error.codes.some((c) => c === 10000 || c === 9109));

/**
 * The Features page's Cloudflare API token card: whether the token is there
 * and which account it works in, which older tokens are still saved, and
 * removing them once the token is saved and checked (a second way, beside
 * Clear stored value on the plugin's Settings page).
 */
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { parseInput, secret, workerEnv } from "../shared.js";
import { contextFetch } from "./cloudflare-api.js";
import { CLOUDFLARE_TOKEN_SECRET, CLOUDFLARE_TOKEN_SETTING, OLDER_TOKENS, OLDER_TOKEN_SECRETS, checkCloudflareToken, cloudflareAccountId, savedR2KeyPair } from "./cloudflare-token.js";
import { readOnlyRoute } from "./routes.js";
import { SECRET_SETTINGS } from "./secrets.js";

/** The seven older per-feature Cloudflare tokens (not the R2 key: removing that is a separate choice). */
export const OLDER_TOKEN_SETTINGS: readonly string[] = Object.values(OLDER_TOKENS).flatMap((o) => (o.setting ? [o.setting] : []));
/** The File Downloads R2 key pair (the account ID and bucket name stay: they aren't secrets, and the bucket is still needed). */
export const R2_KEY_PAIR = ["filesR2SecretAccessKey", "filesR2AccessKeyId"] as const;

/** The pages each older token served: check them with the Cloudflare API token before removing it. */
export const OLDER_TOKEN_PAGES: Record<string, string> = {
	usageApiToken: "Performance (Cloudflare usage), Insights, Discovery (Crawler Hints) and Cloudflare Checkup (reading)",
	cloudflareSetupToken: "Cloudflare Checkup (one-click fixes)",
	imagesApiToken: "Clean Image URLs (Set up media host) and Performance (media cache)",
	videosApiToken: "Videos",
	backupsCloudflareToken: "Backups (Retention on Cloudflare)",
	socialImagesApiToken: "Social Images",
	robotsRadarToken: "Robots.txt (Radar sync)",
	filesR2SecretAccessKey: "File Downloads (large uploads)",
};

interface Ctx {
	settings: { get<T>(key: string): Promise<T | null | undefined>; delete(key: string): Promise<unknown> };
	kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<void> };
	log: { info(message: string, data?: Record<string, unknown>): void };
	http?: { fetch(url: string, init?: RequestInit): Promise<Response> };
}

/** Whether a setting is stored: a value, or a secret that can't be decrypted (it's there, and removing it is still right). */
async function stored(ctx: Ctx, key: string): Promise<boolean> {
	try {
		const value = await ctx.settings.get<unknown>(key);
		return typeof value === "string" ? value.trim() !== "" : value != null;
	} catch {
		return true;
	}
}

const envSet = (env: Record<string, unknown>, name: string) => Boolean(secret(env, name)?.trim());
const labelOf = (key: string) => (SECRET_SETTINGS as Record<string, { label: string }>)[key]?.label.replace(/^Older: /, "") ?? key;

/** The saved Cloudflare API token, or whether it's stored but can't be decrypted. */
async function savedToken(ctx: Ctx): Promise<{ token: string | null; unreadable: boolean }> {
	try {
		const value = await ctx.settings.get<string>(CLOUDFLARE_TOKEN_SETTING);
		return { token: typeof value === "string" && value.trim() ? value.trim() : null, unreadable: false };
	} catch {
		return { token: null, unreadable: true };
	}
}

/** The card's state. Asks Cloudflare nothing: the account is the configured or remembered one. */
export async function cloudflareTokenStatus(ctx: Ctx, bindings?: Record<string, unknown>) {
	const env = bindings ?? (await workerEnv().catch(() => ({}) as Record<string, unknown>));
	const { token: saved, unreadable } = await savedToken(ctx);
	const fromEnv = envSet(env, CLOUDFLARE_TOKEN_SECRET);
	const token = saved ?? (secret(env, CLOUDFLARE_TOKEN_SECRET)?.trim() || null);
	const older = (await Promise.all(OLDER_TOKEN_SETTINGS.map(async (key) => ((await stored(ctx, key)) ? { key, label: labelOf(key), page: OLDER_TOKEN_PAGES[key] ?? "" } : null)))).filter(
		(o): o is { key: string; label: string; page: string } => o !== null,
	);
	// The same rule large uploads use (savedR2KeyPair): only a complete, readable pair is used. Anything less is left over.
	const [pair, r2Stored] = await Promise.all([savedR2KeyPair(ctx).catch(() => null), Promise.all(R2_KEY_PAIR.map((key) => stored(ctx, key)))]);
	const r2 = pair?.complete ?? false;
	return {
		/** Saved on the plugin's Settings page. */
		saved: Boolean(saved),
		/** Saved, but can't be decrypted (EMDASH_ENCRYPTION_KEY missing or changed). */
		unreadable,
		/** The CLOUDFLARE_API_TOKEN Worker secret is set (used after the older tokens, and when nothing is saved). */
		env: fromEnv,
		/** The account it works in, when it's set or was found before; null otherwise (features find it when they first need it). */
		accountId: token ? await cloudflareAccountId(ctx, env, { token }, null, { lookup: false }) : null,
		/** The older tokens still saved, with their Settings page names and the pages they served. */
		older,
		/** A complete File Downloads R2 key pair is saved (account ID, access key ID and a readable secret): it wins over the token for large uploads. */
		r2KeyPair: r2,
		/** Part of an R2 key pair is saved, but not a complete one: it isn't used (large uploads make their keys from the token). */
		r2Leftovers: !r2 && r2Stored.some(Boolean),
		r2Page: OLDER_TOKEN_PAGES.filesR2SecretAccessKey,
		/** Older Worker secrets that are set; deleting them is `npx wrangler secret delete <name>`. */
		olderSecrets: OLDER_TOKEN_SECRETS.filter((name) => envSet(env, name)),
	};
}

export function cloudflareTokenRoutes() {
	return {
		/** The Features page card. A GET: it changes nothing. */
		"cloudflare-token/status": {
			permission: "plugins:manage" as const,
			// any: plugin context.
			handler: async (ctx: any) => cloudflareTokenStatus(ctx),
		},

		/**
		 * Remove the older tokens. Only with the Cloudflare API token saved on Settings (never on the Worker secret
		 * alone: older tokens outrank it, so removing them would switch features to a token nobody chose for them),
		 * and only once Cloudflare says that token is active and sees exactly one account. `r2: true` removes the
		 * File Downloads R2 key pair too, complete (large uploads then use the token) or left over (nothing changes).
		 *
		 * readOnlyRoute: it deletes settings, but none that any page renders, so the page cache and the settings
		 * generation are left alone (an unmarked POST would clear every cached page for nothing). Every feature
		 * reads its token per request, so the change applies at once.
		 */
		"cloudflare-token/clear-older": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { r2 } = parseInput(z.object({ r2: z.boolean().optional() }), ctx.input ?? {});
					const { token, unreadable } = await savedToken(ctx);
					if (unreadable) {
						throw PluginRouteError.badRequest(
							"The saved Cloudflare API token can't be read (EMDASH_ENCRYPTION_KEY is missing or has changed). Save it again on the plugin's Settings page first: until then, the older tokens are what the features use.",
						);
					}
					if (!token) {
						throw PluginRouteError.badRequest("Save the Cloudflare API token on the plugin's Settings page first. Until then, the older tokens are what the features use.");
					}
					const check = await checkCloudflareToken({ token, fetch: contextFetch(ctx) });
					if (!check.ok) throw PluginRouteError.badRequest(`Nothing was removed. ${check.reason}`);
					const before = await cloudflareTokenStatus(ctx);
					// Only what's stored, so the count is what was removed (leftovers are often one value of the pair).
					const r2Keys = r2 ? (await Promise.all(R2_KEY_PAIR.map(async (key) => ((await stored(ctx, key)) ? key : null)))).filter((key) => key !== null) : [];
					const keys = [...before.older.map((o) => o.key), ...r2Keys];
					for (const key of keys) await ctx.settings.delete(key);
					ctx.log.info("Older Cloudflare tokens removed", { keys });
					return { removed: keys.length, status: await cloudflareTokenStatus(ctx) };
				},
			}),
		),
	};
}

/**
 * The Features page's Cloudflare API token card: whether the token is there
 * and which account it works in, which older tokens are still saved, and
 * removing them once the token is (a second way, beside Clear stored value
 * on the plugin's Settings page).
 */
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { parseInput, secret, workerEnv } from "../shared.js";
import { CLOUDFLARE_TOKEN_SECRET, CLOUDFLARE_TOKEN_SETTING, OLDER_TOKENS, OLDER_TOKEN_SECRETS, cloudflareAccountId } from "./cloudflare-token.js";
import { readOnlyRoute } from "./routes.js";
import { SECRET_SETTINGS } from "./secrets.js";

/** The seven older per-feature Cloudflare tokens (not the R2 key: removing that is a separate choice). */
export const OLDER_TOKEN_SETTINGS: readonly string[] = Object.values(OLDER_TOKENS).flatMap((o) => (o.setting ? [o.setting] : []));
/** The File Downloads R2 key pair (the account ID and bucket name stay: they aren't secrets, and the bucket is still needed). */
export const R2_KEY_PAIR = ["filesR2SecretAccessKey", "filesR2AccessKeyId"] as const;

interface Ctx {
	settings: { get<T>(key: string): Promise<T | null | undefined>; delete(key: string): Promise<unknown> };
	kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<void> };
	log: { info(message: string, data?: Record<string, unknown>): void };
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

/** The card's state. Asks Cloudflare nothing: the account is the configured or remembered one. */
export async function cloudflareTokenStatus(ctx: Ctx, bindings?: Record<string, unknown>) {
	const env = bindings ?? (await workerEnv().catch(() => ({}) as Record<string, unknown>));
	let saved = false;
	let unreadable = false;
	let token: string | null = null;
	try {
		const value = await ctx.settings.get<string>(CLOUDFLARE_TOKEN_SETTING);
		if (typeof value === "string" && value.trim()) {
			saved = true;
			token = value.trim();
		}
	} catch {
		unreadable = true;
	}
	const fromEnv = envSet(env, CLOUDFLARE_TOKEN_SECRET);
	token ??= secret(env, CLOUDFLARE_TOKEN_SECRET)?.trim() || null;
	const label = (key: string) => (SECRET_SETTINGS as Record<string, { label: string }>)[key]?.label.replace(/^Older: /, "") ?? key;
	const older = (await Promise.all(OLDER_TOKEN_SETTINGS.map(async (key) => ((await stored(ctx, key)) ? { key, label: label(key) } : null)))).filter(
		(o): o is { key: string; label: string } => o !== null,
	);
	const r2 = (await Promise.all(R2_KEY_PAIR.map((key) => stored(ctx, key)))).some(Boolean);
	return {
		/** Saved on the plugin's Settings page. */
		saved,
		/** Saved, but can't be decrypted (EMDASH_ENCRYPTION_KEY missing or changed). */
		unreadable,
		/** The CLOUDFLARE_API_TOKEN Worker secret is set (used after the older tokens, and when nothing is saved). */
		env: fromEnv,
		/** The account it works in, when it's set or was found before; null otherwise (features find it when they first need it). */
		accountId: token ? await cloudflareAccountId(ctx, env, { token }, null, { lookup: false }) : null,
		/** The older tokens still saved, with their Settings page names. */
		older,
		/** The File Downloads R2 key pair is saved (it wins over the token for large uploads). */
		r2KeyPair: r2,
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
		 * Remove the older tokens, once the Cloudflare API token is there (saved, or the Worker secret): every feature
		 * then uses it. `r2: true` removes the File Downloads R2 key pair too (large uploads then use the token).
		 * Nothing a page shows changes, so no cache is cleared.
		 */
		"cloudflare-token/clear-older": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { r2 } = parseInput(z.object({ r2: z.boolean().optional() }), ctx.input ?? {});
					const before = await cloudflareTokenStatus(ctx);
					if (!before.saved && !before.env) {
						throw PluginRouteError.badRequest("Save the Cloudflare API token on the plugin's Settings page first. Until then, the older tokens are what the features use.");
					}
					const keys = [...before.older.map((o) => o.key), ...(r2 ? R2_KEY_PAIR : [])];
					for (const key of keys) await ctx.settings.delete(key);
					ctx.log.info("Older Cloudflare tokens removed", { keys });
					return { removed: keys.length, status: await cloudflareTokenStatus(ctx) };
				},
			}),
		),
	};
}

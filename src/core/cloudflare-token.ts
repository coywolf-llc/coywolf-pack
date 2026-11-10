/**
 * The one Cloudflare API token: which token a feature uses, which account it
 * works in, and the R2 S3 credentials it gives large uploads.
 *
 * Every Cloudflare feature reads its token here, in this order:
 *
 * 1. a token typed on the page for one action (Set up media host, a Checkup
 *    fix, a Retention check), never stored unless asked;
 * 2. the Cloudflare API token saved on the plugin's Settings page
 *    (`cloudflareApiToken`);
 * 3. the feature's older saved token (Cloudflare usage, setup, Stream…);
 * 4. the feature's older Worker secret (USAGE_API_TOKEN, CF_STREAM_TOKEN…);
 * 5. the CLOUDFLARE_API_TOKEN Worker secret, last: a site that holds it for
 *    another reason keeps using its older tokens.
 *
 * So a site keeps working as it did until the new token is saved, and the
 * new token then wins everywhere. No feature retries with another token when
 * Cloudflare refuses one: which token is used never depends on the answer.
 * Restores never use it: they keep their own D1 Edit token (the
 * BACKUPS_API_TOKEN Worker secret, src/backups/module.ts).
 *
 * Kept free of EmDash imports so tests can load it directly.
 */
import { type Fetch, cloudflareApi } from "./cloudflare-api.js";

export const CLOUDFLARE_TOKEN_SETTING = "cloudflareApiToken";
export const CLOUDFLARE_TOKEN_SECRET = "CLOUDFLARE_API_TOKEN";
/** Clean Image URLs' account ID setting (IMAGES_SETTINGS.accountId), used by every feature as before. */
const IMAGES_ACCOUNT_SETTING = "imagesAccountId";
const ACCOUNT_KEY = "state:cloudflare:account";
const TOKEN_ID_KEY = "state:cloudflare:tokenId";

export type CloudflareFeature = "read" | "checkupFix" | "images" | "stream" | "backupsRetention" | "browserRun" | "radar" | "files";

/**
 * Each feature's older token: the setting it was saved as and the Worker
 * secrets it was read from, both still read (after the new token). Backups
 * passes its secret's name itself (options.restore.tokenSecret). Large
 * uploads had no token, only an R2 key pair (src/files/module.ts).
 */
export const OLDER_TOKENS: Record<CloudflareFeature, { setting?: string; env: readonly string[] }> = {
	read: { setting: "usageApiToken", env: ["USAGE_API_TOKEN"] },
	checkupFix: { setting: "cloudflareSetupToken", env: [] },
	images: { setting: "imagesApiToken", env: ["IMAGES_API_TOKEN"] },
	stream: { setting: "videosApiToken", env: ["CF_STREAM_TOKEN"] },
	backupsRetention: { setting: "backupsCloudflareToken", env: [] },
	browserRun: { setting: "socialImagesApiToken", env: ["BROWSER_RUN_API_TOKEN"] },
	radar: { setting: "robotsRadarToken", env: ["RADAR_API_TOKEN"] },
	files: { env: [] },
};

/** The older Worker secrets, for the Features page's list (not BACKUPS_API_TOKEN: restores still need it). */
export const OLDER_TOKEN_SECRETS: readonly string[] = [...new Set(Object.values(OLDER_TOKENS).flatMap((o) => o.env))];

export type TokenSource = "typed" | "shared" | "older" | "older-env" | "shared-env";

export interface ResolvedToken {
	token: string | null;
	source: TokenSource | null;
	/** A saved token (the new one or the feature's older one) is stored but can't be decrypted: EMDASH_ENCRYPTION_KEY is missing or changed. */
	unreadable: boolean;
}

interface SettingsReader {
	settings: { get<T>(key: string): Promise<T | null | undefined> };
}

interface KvStore {
	kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<void> };
}

/** For messages: where the token goes. */
export const TOKEN_HOME = "the Cloudflare API token on the plugin's Settings page (or the CLOUDFLARE_API_TOKEN Worker secret)";

/** The message for a feature without any token: what to add, and what it needs here. */
export const noTokenMessage = (needs: string) => `Add the Cloudflare API token on the plugin's Settings page (or the CLOUDFLARE_API_TOKEN Worker secret). Here it needs ${needs}.`;

/** The message for a saved token that can't be decrypted. */
export const UNREADABLE_TOKEN_MESSAGE =
	"A saved Cloudflare token can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed. Save the Cloudflare API token again on the plugin's Settings page.";

/** A Worker secret (env binding, or process.env under nodejs_compat), trimmed. */
function envValue(env: Record<string, unknown>, name: string): string {
	const value = (env[name] as unknown) ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[name];
	return typeof value === "string" ? value.trim() : "";
}

/** A saved secret's value, or whether it's stored but can't be decrypted (EmDash throws). */
async function savedValue(ctx: SettingsReader, key: string): Promise<{ value: string; unreadable: boolean }> {
	try {
		const value = await ctx.settings.get<string>(key);
		return { value: typeof value === "string" ? value.trim() : "", unreadable: false };
	} catch {
		return { value: "", unreadable: true };
	}
}

/**
 * The token `feature` uses, and where it came from (the order is at the top of
 * this file). `typed`: a token typed on the page for this one action.
 * `olderEnv`: the older Worker secrets to read in place of the feature's own
 * (Backups names its secret in astro.config).
 */
export async function cloudflareToken(
	ctx: SettingsReader,
	env: Record<string, unknown>,
	feature: CloudflareFeature,
	o: { typed?: string | null; olderEnv?: readonly string[] } = {},
): Promise<ResolvedToken> {
	const typed = o.typed?.trim();
	if (typed) return { token: typed, source: "typed", unreadable: false };
	const older = OLDER_TOKENS[feature];
	// Both saved values in one go: each is a D1 read.
	const [shared, olderSaved] = await Promise.all([savedValue(ctx, CLOUDFLARE_TOKEN_SETTING), older.setting ? savedValue(ctx, older.setting) : null]);
	const unreadable = shared.unreadable || Boolean(olderSaved?.unreadable);
	if (shared.value) return { token: shared.value, source: "shared", unreadable };
	if (olderSaved?.value) return { token: olderSaved.value, source: "older", unreadable };
	for (const name of o.olderEnv ?? older.env) {
		const value = envValue(env, name);
		if (value) return { token: value, source: "older-env", unreadable };
	}
	const fromEnv = envValue(env, CLOUDFLARE_TOKEN_SECRET);
	if (fromEnv) return { token: fromEnv, source: "shared-env", unreadable };
	return { token: null, source: null, unreadable };
}

/** The one token is in use (saved on Settings, or the CLOUDFLARE_API_TOKEN Worker secret): module pages hide their own token fields. */
export function sharedTokenState(resolved: Pick<ResolvedToken, "source">): { sharedToken: boolean; sharedTokenEnv: boolean } {
	return { sharedToken: resolved.source === "shared" || resolved.source === "shared-env", sharedTokenEnv: resolved.source === "shared-env" };
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A short tag for a token, so what's remembered for it (its account, its ID)
 * is used only with that token. Hashed with a prefix: never a part of the
 * token's own SHA-256, which is its R2 secret access key.
 */
export async function tokenFingerprint(token: string): Promise<string> {
	return (await sha256Hex(`coywolf-pack:token-fingerprint:${token}`)).slice(0, 16);
}

/** Tokens whose account couldn't be found, per isolate, so a page that asks often doesn't ask Cloudflare each time. */
const accountMisses = new Map<string, number>();
const ACCOUNT_RETRY_MS = 5 * 60_000;

/** Forget the isolate's misses (tests). */
export function resetAccountMisses(): void {
	accountMisses.clear();
}

/**
 * The Cloudflare account to work in: `override` (a module's own account ID
 * setting), the CF_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID Worker variable, Clean
 * Image URLs' account ID, `o.hint` (the account of a zone the token found),
 * the account found before for this token, else the token's only account (GET
 * /accounts, then remembered; skipped with `o.lookup: false`). Null when the
 * token sees more than one account, or none: then the page asks for the
 * account ID.
 */
export async function cloudflareAccountId(
	ctx: SettingsReader & KvStore,
	env: Record<string, unknown>,
	a: { token: string; fetch?: Fetch },
	override?: string | null,
	o: { hint?: string | null; lookup?: boolean } = {},
): Promise<string | null> {
	const own = override?.trim();
	if (own) return own;
	const fromEnv = envValue(env, "CF_ACCOUNT_ID") || envValue(env, "CLOUDFLARE_ACCOUNT_ID");
	if (fromEnv) return fromEnv;
	const images = (await savedValue(ctx, IMAGES_ACCOUNT_SETTING)).value;
	if (images) return images;
	if (o.hint?.trim()) return o.hint.trim();
	const fp = await tokenFingerprint(a.token);
	const known = await ctx.kv.get<{ fp?: string; accountId?: string }>(ACCOUNT_KEY).catch(() => null);
	if (known?.fp === fp && known.accountId) return known.accountId;
	if (o.lookup === false || (accountMisses.get(fp) ?? 0) > Date.now()) return null;
	const accounts = await cloudflareApi<Array<{ id?: string }> | null>("/accounts?per_page=5", { token: a.token, fetch: a.fetch, label: "Cloudflare's API" })
		.then((r) => r.result)
		.catch(() => null);
	const id = Array.isArray(accounts) && accounts.length === 1 && typeof accounts[0]?.id === "string" ? accounts[0].id : null;
	if (!id) {
		accountMisses.set(fp, Date.now() + ACCOUNT_RETRY_MS);
		return null;
	}
	await ctx.kv.set(ACCOUNT_KEY, { fp, accountId: id }).catch(() => undefined);
	return id;
}

/** The message for a token whose account can't be found; `field`: where the page takes an account ID ("Advanced"). */
export const noAccountMessage = (field?: string) =>
	`Couldn't tell which Cloudflare account to use: the Cloudflare API token sees more than one account, or none. ${field ? `Enter the account ID under ${field}, or set` : "Set"} the CF_ACCOUNT_ID Worker variable.`;

/**
 * R2's S3 credentials from the token (developers.cloudflare.com/r2/api/tokens/):
 * the access key ID is the token's ID and the secret access key is the
 * SHA-256 of the token, in hex. The ID comes from Cloudflare's verify
 * endpoint: the account's for an account token (cfat_…), the user's for any
 * other, then the other one if that fails (older tokens have no prefix). The
 * ID is remembered for the token; the secret is worked out on each call and
 * never stored. Null when Cloudflare doesn't give the ID.
 */
export async function r2S3Credentials(ctx: KvStore, a: { token: string; fetch?: Fetch; accountId: string }): Promise<{ accessKeyId: string; secretAccessKey: string } | null> {
	const fp = await tokenFingerprint(a.token);
	const known = await ctx.kv.get<{ fp?: string; id?: string }>(TOKEN_ID_KEY).catch(() => null);
	let id = known?.fp === fp && known.id ? known.id : null;
	if (!id) {
		const paths = [`/accounts/${encodeURIComponent(a.accountId)}/tokens/verify`, "/user/tokens/verify"];
		if (!a.token.startsWith("cfat_")) paths.reverse();
		for (const path of paths) {
			const result = await cloudflareApi<{ id?: string; status?: string } | null>(path, { token: a.token, fetch: a.fetch, label: "Cloudflare's API" })
				.then((r) => r.result)
				.catch(() => null);
			if (typeof result?.id === "string" && result.id && (result.status ?? "active") === "active") {
				id = result.id;
				break;
			}
		}
		if (!id) return null;
		await ctx.kv.set(TOKEN_ID_KEY, { fp, id }).catch(() => undefined);
	}
	return { accessKeyId: id, secretAccessKey: await sha256Hex(a.token) };
}

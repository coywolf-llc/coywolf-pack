/**
 * Making one social image: the template (template.ts) as a PNG from
 * Cloudflare Browser Run, stored in the media bucket, recorded in the
 * entry's document (store.ts).
 *
 * Browser Run is reached through the site's `BROWSER` binding when it has
 * one (its Quick Actions need compatibility_date 2026-03-24 or later; no
 * token), else its REST API on api.cloudflare.com through ctx.http, with an
 * API token that has Browser Run → Edit and the account ID. Every call has
 * a deadline. A 429 (Workers Free allows one Quick Action every 10 seconds
 * and 10 minutes of browser time a day) stops the batch; the rest wait for
 * the next run.
 */
import type { PluginContext } from "emdash";

import { CLOUDFLARE_API, type Fetch, contextFetch, scrubToken } from "../core/cloudflare-api.js";
import { siteName as readSiteName } from "../core/site.js";
import { withDeadline } from "../core/single-flight.js";
import { IMAGES_SETTINGS } from "../images/settings.js";
import { secret, workerEnv } from "../shared.js";
import { SOCIAL_SETTINGS_KEY, type SocialImageDoc, docId, parseDefaultImages, socialImages } from "./store.js";
import { HEIGHT, type TemplateSettings, WIDTH, imageHash, imageKey, normalizeTemplate, socialImageHtml } from "./template.js";

export const TOKEN_SETTING = "socialImagesApiToken";
export const SETTINGS_KEY = SOCIAL_SETTINGS_KEY;
/** Longest a screenshot may take (Browser Run's own page timeout is 15 s below this). */
export const RENDER_MS = 30_000;
/** Largest PNG kept (a 1200×630 card is 50–300 KB). */
const MAX_BYTES = 5 * 1024 * 1024;
/** Largest logo inlined into the template as a data: URL. */
const MAX_LOGO_BYTES = 512 * 1024;

export interface SocialSettings {
	template: TemplateSettings;
	/** Collections to make images for; empty means every collection with public pages. */
	collections: string[];
	/** Cloudflare account ID for the REST API (not needed with a BROWSER binding). */
	accountId: string;
	/**
	 * The theme's site-wide share images (URLs or paths): a page whose image (or SEO image) is one of these
	 * counts as having none, so its generated image is used (src/social/store.ts isThemeDefault).
	 */
	defaultImages: string[];
}

export function normalizeSocialSettings(raw: unknown): SocialSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof SocialSettings, unknown>>;
	return {
		template: normalizeTemplate(r.template),
		collections: Array.isArray(r.collections) ? r.collections.filter((c): c is string => typeof c === "string" && /^[a-z][a-z0-9_]*$/.test(c)).slice(0, 100) : [],
		accountId: typeof r.accountId === "string" && /^[0-9a-f]{32}$/i.test(r.accountId.trim()) ? r.accountId.trim().toLowerCase() : "",
		defaultImages: parseDefaultImages(r.defaultImages),
	};
}

export async function readSocialSettings(ctx: PluginContext): Promise<SocialSettings> {
	return normalizeSocialSettings(await ctx.settings.get(SETTINGS_KEY).catch(() => null));
}

export class RenderError extends Error {
	readonly status: number;
	constructor(message: string, status = 0) {
		super(message);
		this.name = "RenderError";
		this.status = status;
	}
}

interface BrowserBinding {
	quickAction(action: "screenshot", options: Record<string, unknown>): Promise<Response>;
}

/** How this site reaches Browser Run, or why it can't. */
export type Renderer = { kind: "binding"; browser: BrowserBinding } | { kind: "api"; token: string; accountId: string; fetch: Fetch } | { kind: "none"; reason: string };

/** The token: the encrypted setting, else the BROWSER_RUN_API_TOKEN Worker secret. */
async function token(ctx: PluginContext, env: Record<string, unknown>): Promise<string | null> {
	const saved = await ctx.settings.get<string>(TOKEN_SETTING).catch(() => null);
	return (typeof saved === "string" && saved.trim()) || secret(env, "BROWSER_RUN_API_TOKEN") || null;
}

/** The account: Social Images' setting, the CF_ACCOUNT_ID Worker secret, Clean Image URLs' account ID, else the token's only account. */
async function accountId(ctx: PluginContext, env: Record<string, unknown>, settings: SocialSettings, apiToken: string, doFetch: Fetch): Promise<string | null> {
	const known = settings.accountId || secret(env, "CF_ACCOUNT_ID") || secret(env, "CLOUDFLARE_ACCOUNT_ID") || (await ctx.settings.get<string>(IMAGES_SETTINGS.accountId).catch(() => null))?.trim();
	if (known) return known;
	try {
		const response = await withDeadline(doFetch(`${CLOUDFLARE_API}/accounts?per_page=5`, { headers: { Authorization: `Bearer ${apiToken}` } }), 8_000, "Looking up the Cloudflare account");
		const body = (await response.json().catch(() => ({}))) as { result?: Array<{ id?: string }> };
		return body.result?.length === 1 && body.result[0].id ? body.result[0].id : null;
	} catch {
		return null;
	}
}

export async function renderer(ctx: PluginContext, settings: SocialSettings, bindings?: Record<string, unknown>): Promise<Renderer> {
	const env = bindings ?? (await workerEnv().catch(() => ({}) as Record<string, unknown>));
	const browser = env.BROWSER as Partial<BrowserBinding> | undefined;
	if (browser && typeof browser.quickAction === "function") return { kind: "binding", browser: browser as BrowserBinding };
	const apiToken = await token(ctx, env);
	if (!apiToken) return { kind: "none", reason: "Add a Cloudflare API token with Browser Run → Edit (below), or a BROWSER binding to the site's Worker." };
	const doFetch = contextFetch(ctx);
	const account = await accountId(ctx, env, settings, apiToken, doFetch);
	if (!account) return { kind: "none", reason: "Enter the Cloudflare account ID (the token can see more than one account)." };
	return { kind: "api", token: apiToken, accountId: account, fetch: doFetch };
}

const SCREENSHOT = {
	viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
	screenshotOptions: { type: "png" },
	gotoOptions: { waitUntil: "load", timeout: 15_000 },
};

/** Read a screenshot answer: the PNG, or an error with Browser Run's message. */
async function pngFrom(response: Response, apiToken?: string): Promise<Uint8Array> {
	const type = response.headers.get("content-type") ?? "";
	if (response.ok && type.startsWith("image/")) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_BYTES) throw new RenderError(`The image came back too large (${Math.round(bytes.byteLength / 1024)} KB).`);
		if (bytes.byteLength < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new RenderError("Browser Run didn't return a PNG.");
		return bytes;
	}
	const body = (await response.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
	const detail = body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || response.statusText || "error";
	const hint = response.status === 401 || response.status === 403 ? " The API token needs Account → Browser Run → Edit." : response.status === 429 ? " Browser Run's limit for now is reached; the rest wait for the next run." : "";
	throw new RenderError(scrubToken(`Browser Run ${response.status}: ${detail}.${hint}`, apiToken), response.status);
}

/** The template as a PNG. */
export async function screenshot(r: Exclude<Renderer, { kind: "none" }>, html: string): Promise<Uint8Array> {
	if (r.kind === "binding") {
		const response = await withDeadline(r.browser.quickAction("screenshot", { html, ...SCREENSHOT }), RENDER_MS, "Browser Run's screenshot");
		return pngFrom(response);
	}
	const controller = new AbortController();
	const call = async (path: string) =>
		r.fetch(`${CLOUDFLARE_API}/accounts/${r.accountId}/${path}/screenshot`, {
			method: "POST",
			headers: { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ html, ...SCREENSHOT }),
			signal: controller.signal,
		});
	try {
		return await withDeadline(
			(async () => {
				let response = await call("browser-run");
				// Accounts (or API versions) that only know the old name.
				if (response.status === 404) response = await call("browser-rendering");
				return pngFrom(response, r.token);
			})(),
			RENDER_MS,
			"Browser Run's screenshot",
		);
	} catch (error) {
		controller.abort();
		if (error instanceof Error) error.message = scrubToken(error.message, r.token);
		throw error;
	}
}

// ── The template's inputs ────────────────────────────────────────

const MEDIA_ROUTE = "/_emdash/api/media/file/";

/** The site's logo (Settings → Logo): a data: URL from the media bucket, or its absolute https URL. `key` identifies it for the hash. */
export async function siteLogo(bucket: R2Bucket | undefined, origin: string): Promise<{ src: string | null; key: string | null }> {
	let logo: { url?: string } | undefined;
	try {
		const { getSiteSettings } = await import("emdash");
		logo = ((await getSiteSettings()) as { logo?: { url?: string } }).logo;
	} catch {
		logo = undefined;
	}
	const url = logo?.url?.trim();
	if (!url) return { src: null, key: null };
	if (url.startsWith(MEDIA_ROUTE) && bucket) {
		const key = decodeURIComponent(url.slice(MEDIA_ROUTE.length).split(/[?#]/)[0]);
		const object = await bucket.get(key).catch(() => null);
		const type = object?.httpMetadata?.contentType ?? "";
		if (object && object.size <= MAX_LOGO_BYTES && /^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(type)) {
			const bytes = new Uint8Array(await object.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			return { src: `data:${type};base64,${btoa(binary)}`, key: `${key}:${object.etag}` };
		}
	}
	try {
		const absolute = new URL(url, origin || undefined);
		return absolute.protocol === "https:" ? { src: absolute.href, key: absolute.href } : { src: null, key: null };
	} catch {
		return { src: null, key: null };
	}
}

/** RenderError's status when Browser Run isn't set up (no binding, token or account): the batch stops, nothing is counted against the entry. */
export const NOT_SET_UP = -1;

export interface RenderContext {
	/** How Browser Run is reached, looked up on the first render that needs it (an unchanged image needs none). Throws RenderError(NOT_SET_UP). */
	renderer: () => Promise<Exclude<Renderer, { kind: "none" }>>;
	bucket: R2Bucket;
	siteName: string;
	logo: { src: string | null; key: string | null };
	template: TemplateSettings;
}

/** What every render in a batch shares: the renderer (looked up when first needed), the bucket, the site's name and logo, the template. */
export async function renderContext(ctx: PluginContext, settings: SocialSettings, bucketName = "MEDIA"): Promise<RenderContext | { reason: string }> {
	const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
	const bucket = env[bucketName] as R2Bucket | undefined;
	if (!bucket?.put) return { reason: `The media bucket isn't bound as ${bucketName}.` };
	const origin = ctx.site?.url ?? "";
	let found: Promise<Renderer> | null = null;
	const get = async () => {
		const r = await (found ??= renderer(ctx, settings, env));
		if (r.kind === "none") throw new RenderError(r.reason, NOT_SET_UP);
		return r;
	};
	return { renderer: get, bucket, siteName: (await readSiteName(ctx).catch(() => "")) || ctx.site?.name || "", logo: await siteLogo(bucket, origin), template: settings.template };
}

/**
 * Make (or keep) one entry's image. Skips the render when the stored image
 * already shows this title with this template. Returns the new document.
 */
export async function renderEntry(ctx: PluginContext, rc: RenderContext, entry: { collection: string; id: string; title: string }): Promise<SocialImageDoc> {
	const store = socialImages(ctx);
	const id = docId(entry.collection, entry.id);
	const existing = await store.get(id);
	const hash = await imageHash({ title: entry.title, siteName: rc.siteName, logoKey: rc.logo.key, settings: rc.template });
	const now = new Date().toISOString();
	if (existing?.key && existing.hash === hash) {
		const doc: SocialImageDoc = { ...existing, title: entry.title, status: "ready", note: null, updatedAt: now };
		await store.put(id, doc);
		return doc;
	}
	const base: SocialImageDoc = existing ?? { collection: entry.collection, id: entry.id, title: entry.title, key: null, hash: null, status: "pending", note: null, attempts: 0, updatedAt: now, renderedAt: null };
	try {
		const png = await screenshot(await rc.renderer(), socialImageHtml({ title: entry.title, siteName: rc.siteName, logo: rc.logo.src, settings: rc.template }));
		const key = imageKey(entry.collection, entry.id, hash);
		await rc.bucket.put(key, png, { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" } });
		const replaced = existing?.key && existing.key !== key ? existing.key : (existing?.previousKey ?? null);
		const doc: SocialImageDoc = { ...base, title: entry.title, key, hash, previousKey: replaced, status: "ready", note: null, attempts: 0, updatedAt: now, renderedAt: now };
		await store.put(id, doc);
		// The image before the one just replaced: no page can point to it any more.
		const stale = existing?.previousKey;
		if (stale && stale !== key && stale !== replaced) await rc.bucket.delete(stale).catch(() => undefined);
		return doc;
	} catch (error) {
		const status = error instanceof RenderError ? error.status : 0;
		const attempts = base.attempts + 1;
		// A rate limit, or Browser Run not set up, isn't the entry's fault: it stays pending without counting an attempt.
		const notCounted = status === 429 || status === NOT_SET_UP;
		const doc: SocialImageDoc = { ...base, title: entry.title, status: notCounted ? "pending" : attempts >= 3 ? "failed" : "pending", note: (error instanceof Error ? error.message : String(error)).slice(0, 300), attempts: notCounted ? base.attempts : attempts, updatedAt: now };
		await store.put(id, doc);
		throw error;
	}
}

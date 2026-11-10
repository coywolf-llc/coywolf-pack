/**
 * The site's name as editors set it (Settings → Site title). EmDash's plugin
 * context reports the title from initial setup (`emdash:site_title`), which
 * Settings doesn't change, so prefer the Settings value.
 */
import type { PluginContext } from "emdash";

import { noteReadFailure } from "./read-failures.js";
import { requestStore } from "./request-memo.js";

export async function siteName(ctx: Pick<PluginContext, "site">): Promise<string> {
	try {
		const { getSiteSettings } = await import("emdash");
		const settings = (await getSiteSettings()) as { title?: unknown };
		if (typeof settings.title === "string" && settings.title.trim()) return settings.title.trim();
	} catch {
		// Outside a request context: fall back to the plugin context. Inside one it's a failed read.
		if (requestStore()) noteReadFailure("site settings (site name)");
	}
	return ctx.site?.name ?? "";
}

/**
 * Whether the site is in EmDash's staging mode (Settings → General → Site Status, EmDash 1.5+):
 * hidden from search engines until it goes live. Sites without the setting (all sites before
 * that release, and sites that went live) are live. A failed read counts as live.
 */
export async function siteInStaging(): Promise<boolean> {
	try {
		const { getSiteSetting } = await import("emdash");
		// any: "staging" isn't in older EmDash versions' setting keys.
		return (await (getSiteSetting as (key: any) => Promise<unknown>)("staging")) === true;
	} catch {
		return false;
	}
}

let configuredSiteUrl: Promise<string | null> | null = null;

/** EmDash's build-time siteUrl (`emdash({ siteUrl })`, virtual:emdash/config), read once per isolate. Null outside a site build. */
function readConfiguredSiteUrl(): Promise<string | null> {
	configuredSiteUrl ??= (async () => {
		try {
			// @ts-ignore: provided by EmDash's Vite integration in the site build; absent under Node tests.
			const mod = (await import("virtual:emdash/config")) as { default?: { siteUrl?: unknown } };
			return typeof mod.default?.siteUrl === "string" ? mod.default.siteUrl : null;
		} catch {
			return null;
		}
	})();
	return configuredSiteUrl;
}

/** An http(s) URL's origin, or null. */
function originOrNull(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
	} catch {
		return null;
	}
}

/**
 * The site's public address as it's configured, for telling other sites who's asking (the link
 * checker's user agent): EmDash's `siteUrl` option, else the EMDASH_SITE_URL (or SITE_URL) variable,
 * else Settings → General → Site URL. Never the address of the request or the one recorded at setup,
 * which can be a staging or preview host. Null when none is set.
 */
export async function configuredSiteOrigin(env: Record<string, unknown> = {}, readSetting: () => Promise<unknown> = defaultSiteUrlSetting): Promise<string | null> {
	const configured = originOrNull(await readConfiguredSiteUrl());
	if (configured) return configured;
	const fromEnv = originOrNull(env.EMDASH_SITE_URL) ?? originOrNull(env.SITE_URL);
	if (fromEnv) return fromEnv;
	return originOrNull(await readSetting().catch(() => null));
}

async function defaultSiteUrlSetting(): Promise<unknown> {
	const { getSiteSetting } = await import("emdash");
	// any: "url" is a site setting key in EmDash's settings ("site:url"), typed loosely across versions.
	return (getSiteSetting as (key: any) => Promise<unknown>)("url");
}

/** Forget the configured siteUrl read (tests). */
export function resetConfiguredSiteUrl(value?: string | null): void {
	configuredSiteUrl = value === undefined ? null : Promise.resolve(value);
}

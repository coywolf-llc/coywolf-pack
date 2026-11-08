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
		// biome-ignore lint/suspicious/noExplicitAny: "staging" isn't in older EmDash versions' setting keys.
		return (await (getSiteSetting as (key: any) => Promise<unknown>)("staging")) === true;
	} catch {
		return false;
	}
}

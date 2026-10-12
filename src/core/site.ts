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
		if (requestStore()) noteReadFailure();
	}
	return ctx.site?.name ?? "";
}

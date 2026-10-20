import type { PluginContext } from "emdash";

import { cachedCtxFeatures, isOn, registerFeatures } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { serveCachedRedirect } from "./middleware.js";
import { type RedirectsOptions, redirectsModule } from "./module.js";
import { TRASH_PROMPT_FEATURE, removedModule } from "./removed.js";
import { SLUG_CHANGES_FEATURE, slugChangesModule } from "./slug-changes.js";

const FEATURES = [
	{
		id: "redirects",
		label: "Redirects",
		description: "External and file-path redirects, regular expressions, hit counts, and import.",
		default: true,
	},
	{
		id: TRASH_PROMPT_FEATURE,
		label: "Removed content",
		description:
			"When a published entry is trashed or unpublished, ask what its old URL should do: redirect it or return 410 Gone. Undecided URLs stay listed on the Redirects page.",
		default: false,
	},
	{
		id: SLUG_CHANGES_FEATURE,
		label: "Slug changes",
		description:
			"When a published entry's URL changes (a new slug, category or parent page), add a 301 from the old URL to the new one. EmDash's own slug-change redirect uses the collection's URL pattern, which can't express category or parent paths.",
		default: true,
	},
];
registerFeatures(FEATURES);

// biome-ignore lint/suspicious/noExplicitAny: hook events differ per hook.
type Hook = (event: any, ctx: PluginContext) => Promise<unknown>;

/**
 * One handler per hook from the features that share it, each run only while its
 * feature is on (the module's own gate is the main Redirects switch).
 */
function mergeHooks(parts: Array<{ feature: string; hooks: Record<string, Hook> }>): Record<string, Hook> {
	const names = new Set(parts.flatMap((p) => Object.keys(p.hooks)));
	return Object.fromEntries(
		[...names].map((name) => [
			name,
			async (event: unknown, ctx: PluginContext) => {
				const features = await cachedCtxFeatures(ctx);
				let result: unknown;
				for (const part of parts) {
					const run = part.hooks[name];
					if (!run || !isOn(features, part.feature)) continue;
					// Each feature on its own, as compose.ts isolates modules: one failing doesn't skip the other.
					try {
						const value = await run(event, ctx);
						if (value !== undefined) result = value;
					} catch (error) {
						ctx.log.warn(`Redirects: ${part.feature} ${name} failed`, { error: String(error) });
					}
				}
				return result;
			},
		]),
	);
}

export function redirectsPack(options: RedirectsOptions): PackModule {
	const removed = removedModule(options);
	const slugs = slugChangesModule(options);
	return {
		id: "redirects",
		label: "Redirects",
		features: FEATURES,
		routes: { ...redirectsModule(options).routes, ...removed.routes },
		adminPages: [{ path: "/redirects", label: "Redirects", icon: "arrow-bend-up-right" }],
		hooks: mergeHooks([
			{ feature: TRASH_PROMPT_FEATURE, hooks: removed.hooks },
			{ feature: SLUG_CHANGES_FEATURE, hooks: slugs.hooks },
		]),
		storage: { ...removed.storage, ...slugs.storage },
		capabilities: ["content:read"],
	};
}

export const redirectsMiddleware: PackMiddleware = {
	module: "redirects",
	feature: "redirects",
	ownsCache: true,
	handle: serveCachedRedirect,
};

/**
 * Coywolf Pack's Astro cache provider, "@coywolf/emdash/cache-provider": Astro's
 * Cloudflare provider (what cacheCloudflare() sets up) with two changes to
 * invalidate(). Set it in the site's astro.config.mjs instead of cacheCloudflare():
 *
 * ```js
 * cache: { provider: { name: "cloudflare", entrypoint: "@coywolf/emdash/cache-provider" } },
 * ```
 *
 * `name` must stay "cloudflare": Astro's Cloudflare adapter turns Workers Cache
 * on for the Worker (and its no-store default for other responses) only for a
 * provider named that.
 *
 * invalidate(), which EmDash calls after content, menu and settings writes:
 * - Workers Cache off (no cache.purge in cloudflare:workers, as on a staging
 *   Worker with "cache": { "enabled": false }): does nothing. Astro's provider
 *   would throw there, and every save with it.
 * - In a request: Astro's own invalidate(), unchanged.
 * - During the Worker's scheduled run (EmDash publishing scheduled entries, and
 *   plugins' scheduled tasks editing entries): through a fetch call to the
 *   Worker itself, like the pack's own purges (src/core/scheduled-purge.ts).
 *   Workers Cache ignores a purge made in the scheduled run itself: it reports
 *   success and the pages stay cached (tested on November 25, 2026). Needs the
 *   stripTrackingParams wrapper in src/worker.ts; without it, this is the same
 *   as Astro's own provider. A purge that fails is logged; nothing is thrown
 *   (EmDash logs and carries on either way).
 *
 * Astro loads this module through its own entrypoint (bundled into the Worker),
 * and @astrojs/cloudflare comes from the site. No static cloudflare:workers or
 * node: import here: Astro may also load providers outside the Worker.
 */
import cloudflare from "@astrojs/cloudflare/cache/provider";
import type { CacheProviderFactory, InvalidateOptions } from "astro";
import { collectInvalidationTags } from "astro/cache/provider-utils";

import { scheduledRun } from "./core/scheduled-purge.js";
import { purgeOutcome } from "./pageCache/lib.js";

/** Most tags one Workers Cache purge takes (Cloudflare's limit per call). */
const TAGS_PER_PURGE = 100;

const coywolfCloudflareCache: CacheProviderFactory = (config) => {
	const provider = cloudflare(config);
	return {
		...provider,
		async invalidate(options: InvalidateOptions): Promise<void> {
			const { cache } = (await import("cloudflare:workers")) as unknown as { cache?: { purge?: unknown } };
			if (typeof cache?.purge !== "function") return; // Workers Cache off: nothing is cached, nothing to purge.
			if (!scheduledRun()) return provider.invalidate(options);
			// The tags Astro's provider would purge (its path tag included), on a copy: collectInvalidationTags adds to the array it's given.
			const tags = [...new Set(collectInvalidationTags({ ...options, tags: Array.isArray(options.tags) ? [...options.tags] : options.tags }))].filter(Boolean);
			for (let i = 0; i < tags.length; i += TAGS_PER_PURGE) await purgeOutcome({ tags: tags.slice(i, i + TAGS_PER_PURGE) });
		},
	};
};

export default coywolfCloudflareCache;

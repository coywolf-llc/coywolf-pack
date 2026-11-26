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
 *   plugins' scheduled tasks editing entries): through an RPC call to the
 *   Worker's own default entrypoint, like the pack's own purges
 *   (src/core/scheduled-purge.ts).
 *   Workers Cache ignores a purge made in the scheduled run itself: it reports
 *   success and the pages stay cached (tested on November 25, 2026). Needs the
 *   stripTrackingParams wrapper in src/worker.ts; without it, this is the same
 *   as Astro's own provider. A purge that fails is logged; nothing is thrown
 *   (EmDash logs and carries on either way).
 *
 * In the scheduled run the tags are gathered and purged together (see
 * `batching`): EmDash purges once per entry a scheduled task publishes
 * (glossary.io's daily run publishes up to 25 in half a minute), and the
 * account's purge limit (5 a minute, a burst of 25, shared by every site) would
 * otherwise run out, refusing editors' saves on every site for minutes after.
 * invalidate() then returns before the purge is made; the scheduled run is kept
 * open until it is (ctx.waitUntil). A refused batch is logged, not retried.
 *
 * Astro loads this module through its own entrypoint (bundled into the Worker),
 * and @astrojs/cloudflare comes from the site. No static cloudflare:workers or
 * node: import here: Astro may also load providers outside the Worker.
 */
import cloudflare from "@astrojs/cloudflare/cache/provider";
import type { CacheProviderFactory, InvalidateOptions } from "astro";
import { collectInvalidationTags } from "astro/cache/provider-utils";

import { type ScheduledRun, purgeThroughEntrypoint, scheduledRun } from "./core/scheduled-purge.js";

/** Most tags one Workers Cache purge takes (Cloudflare's limit per call). */
const TAGS_PER_PURGE = 100;

/**
 * How a scheduled run's purges are gathered: purged once no more come for
 * `quietMs`, at most `maxWaitMs` after the first, and at once when there are
 * 100 tags. Nothing waits for the purge, so the quiet time can be long enough
 * for a task that publishes an entry every second or two (glossary.io's daily
 * run: 25 terms in up to 25 seconds, each a few D1 trips away). (Tests change
 * these.)
 */
export const batching = { quietMs: 5_000, maxWaitMs: 10_000 };

interface Batch {
	tags: Set<string>;
	first: number;
	timer?: ReturnType<typeof setTimeout>;
	done(): void;
}

/** The scheduled run's batch waiting to be purged (one per run: the store object is the run's). */
const batches = new WeakMap<ScheduledRun, Batch>();

/** Keep the scheduled run open until `promise` settles (its ctx.waitUntil, else cloudflare:workers' waitUntil). */
async function holdRun(run: ScheduledRun, promise: Promise<void>): Promise<void> {
	const ctx = run.ctx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
	try {
		if (typeof ctx?.waitUntil === "function") return ctx.waitUntil(promise);
	} catch {
		// The run's ctx no longer takes work: try the module's.
	}
	try {
		((await import("cloudflare:workers")) as unknown as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.(promise);
	} catch {
		// Not on Workers.
	}
}

async function flush(run: ScheduledRun, batch: Batch): Promise<void> {
	if (batches.get(run) === batch) batches.delete(run); // Tags queued from here on start a new batch.
	const tags = [...batch.tags];
	try {
		for (let i = 0; i < tags.length; i += TAGS_PER_PURGE) {
			const chunk = tags.slice(i, i + TAGS_PER_PURGE);
			// Through the run the tags were queued in (not whatever store the timer sees): the purge must go to the default entrypoint.
			const outcome = await purgeThroughEntrypoint(run, { tags: chunk });
			// Refused (the account's purge limit) or failed: said here too, where the scheduled run's logs show it.
			if (outcome === "refused") console.error(`coywolf-pack: EmDash's page cache purge from the scheduled run was refused (${chunk.length} tags); those pages stay cached until they expire`);
		}
	} finally {
		batch.done();
	}
}

/** Add tags to the run's batch and (re)arm its purge. Synchronous up to holdRun, which is started on a new batch only. */
function queue(run: ScheduledRun, tags: string[]): void {
	let batch = batches.get(run);
	if (!batch) {
		let done!: () => void;
		const settled = new Promise<void>((resolve) => (done = resolve));
		batch = { tags: new Set(), first: Date.now(), done };
		batches.set(run, batch);
		void holdRun(run, settled);
	}
	for (const tag of tags) batch.tags.add(tag);
	if (batch.timer !== undefined) clearTimeout(batch.timer);
	const wait = batch.tags.size >= TAGS_PER_PURGE ? 0 : Math.max(0, Math.min(batching.quietMs, batch.first + batching.maxWaitMs - Date.now()));
	const current = batch;
	batch.timer = setTimeout(() => void flush(run, current), wait);
}

const coywolfCloudflareCache: CacheProviderFactory = (config) => {
	const provider = cloudflare(config);
	return {
		...provider,
		async invalidate(options: InvalidateOptions): Promise<void> {
			const { cache } = (await import("cloudflare:workers")) as unknown as { cache?: { purge?: unknown } };
			if (typeof cache?.purge !== "function") return; // Workers Cache off: nothing is cached, nothing to purge.
			const run = scheduledRun();
			if (!run) return provider.invalidate(options);
			// The tags Astro's provider would purge (its path tag included), on a copy: collectInvalidationTags adds to the array it's given.
			const tags = collectInvalidationTags({ ...options, tags: Array.isArray(options.tags) ? [...options.tags] : options.tags }).filter(Boolean);
			if (!tags.length) return;
			// A run whose ctx can't be held open (no waitUntil: never on Workers) purges now, as nothing would keep a later purge alive.
			if (typeof (run.ctx as { waitUntil?: unknown } | undefined)?.waitUntil !== "function") {
				for (let i = 0; i < tags.length; i += TAGS_PER_PURGE) await purgeThroughEntrypoint(run, { tags: tags.slice(i, i + TAGS_PER_PURGE) });
				return;
			}
			queue(run, tags);
		},
	};
};

export default coywolfCloudflareCache;

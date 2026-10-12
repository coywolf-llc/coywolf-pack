/**
 * Clean Image URLs module: resized copies of media-library images at short,
 * cacheable URLs, and cleanImageUrl() / originalImageUrl() for themes. Off by
 * default.
 *
 * Two modes:
 *  - Media host (recommended): an R2 custom domain on the media bucket with
 *    Cloudflare Image Transformations and two URL-rewrite rules
 *    (https://media.example.com/s/<w>x<h>/<file>). Images never touch the
 *    Worker. Set with `images: { cdn }` or on the Clean Image URLs page.
 *  - Worker route: /media/<id>-<w>x<h>.<format>, read from the media bucket,
 *    resized by the Images binding, cached at the edge for a year. With a
 *    media host set, these old URLs 301 to the media host.
 *
 * Stored image sizes (with a media host): WebP and AVIF copies of each image
 * at fixed widths, made once when the image is uploaded (or, when the site
 * opts in, by the backfill for existing images), plus the site's crops, made
 * when a page first shows them; all served as plain files. responsiveImage()
 * and croppedImage() give themes their srcsets; until an image's copies exist
 * they return null and themes use cleanImageUrl() (/s/). See variants.ts.
 */
import type { PluginContext } from "emdash";

import { batchedAll } from "../core/d1-batch.js";
import { isCurrent, registerFeatures, registerSiteOption, rememberSiteOption, settingsEpoch, siteFeatureOn, siteOption, siteSetting } from "../core/features.js";
import { purgePageCache } from "../pageCache/lib.js";
import { WARMER_AGENT, WARM_SETTING, WARM_STATE_OPTION, startWarm } from "../pageCache/warm.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { CLOUDFLARE_API_HOST } from "./cloudflare.js";
import { afterResponse, workerEnv } from "../shared.js";
import { FORMATS, IMAGE_PATH, cdnOriginalUrl, cdnRedirectUrl, cleanImagePath, imageCdn, mediaFile, parseImagePath, parseCdnUrl, setImageCdn, snappedImagePath } from "./lib.js";
import { imagesModule } from "./module.js";
import { markPendingMedia } from "./pending.js";
import { configureMediaHostDatabase, refreshMediaHost, variantsBulkOn } from "./settings.js";
import { type ImagesBinding, type VariantBucket, type VariantDoc, type Crop, VARIANTS_VERSION, cropSrcsets, cropState, currentDoc, eligible, generateVariants, parseDoc, setImageCrops, variantSrcsets } from "./variants.js";
import {
	type BackfillDeps,
	type Db,
	VARIANTS_COLLECTION,
	VARIANTS_STATE_OPTION,
	type VariantsState,
	acquireLease,
	addCrops,
	backfillMayHaveWork,
	backfillStep,
	forgetMedia,
	mediaRow,
	pausedAt,
	processMedia,
	readVariantsState,
	releaseLease,
	startVariantsRun,
} from "./variants-store.js";
import { upgradeListedPosters } from "../videos/poster.js";

export const F = { main: "images" } as const;
export const FEATURES = [
	{
		id: F.main,
		label: "Clean image URLs",
		description:
			"Resized images at short addresses instead of /_image?href=…: on your own media host (media.example.com/s/600x315/<file>, set up on the Clean Image URLs page) or at /media/<id>-600x315.webp. Themes use cleanImageUrl() to build them.",
		default: false,
	},
];
registerFeatures(FEATURES);

export interface ImagesOptions {
	/** R2 binding of the media library. Default "MEDIA". */
	bucket?: string;
	/** Images binding. Default "IMAGES" (the Astro Cloudflare adapter's). */
	images?: string;
	/**
	 * Media host: an https origin serving the media bucket with the /s/ resize
	 * rules, e.g. "https://media.example.com" (see README, "Clean Image URLs").
	 * A host saved on the Clean Image URLs page takes precedence.
	 */
	cdn?: string;
	/** D1 binding of the site database (for the saved media host). Default "DB". */
	database?: string;
	/**
	 * Cropped sizes the theme shows, as [width, height] pairs (e.g. list
	 * thumbnails and avatars at 1x and 2x). A crop is stored as WebP and AVIF
	 * the first time a page shows it for an image (when the image is at least
	 * that large); see croppedImage(). Crops not listed here always use /s/.
	 */
	crops?: Array<Crop>;
}

let config: { bucket: string; images: string; database: string } = { bucket: "MEDIA", images: "IMAGES", database: "DB" };

/** Scheduled job that restarts the backfill (a finished run a day later, a stalled or paused chain). */
export const VARIANTS_TASK = "images-variants";

// The backfill's progress row is read with the feature switches, so page requests can tell
// whether a chain should start without a query of their own.
registerSiteOption(VARIANTS_STATE_OPTION);

/**
 * The backfill runs as a chain of steps, each in a Worker invocation of its own
 * (so each gets its own subrequest budget), back to back until the run is done:
 *
 *  - A trigger (turning sizes for existing images on, "Make missing sizes now",
 *    a WordPress media import, the hourly task, or a page request that sees a
 *    run with no chain) takes the run's lease (a compare-and-swap on its
 *    progress row, so there's one chain at a time) and hands the first step to
 *    the Worker itself: a POST to BACKFILL_PATH through the SELF service
 *    binding, carrying the lease's token. Like cache warming
 *    (src/pageCache/warm.ts), no work happens in the Cron Trigger itself: it
 *    runs wherever Cloudflare has room, often far from the database.
 *  - A step renews the lease, makes sizes for up to STEP_BUDGET.maxImages
 *    images (claiming no batch after STEP_BUDGET.budgetMs), then, while work
 *    is left, renews the lease again and posts the next step the same way.
 *  - The endpoint only works for the chain holding the lease: a request
 *    without its current token (a random UUID kept in the database, never sent
 *    to browsers) gets a 403 and starts nothing, so the public can't trigger
 *    transformations.
 *  - Cloudflare allows 32 Worker invocations per incoming request (each
 *    service-binding call counts), so a chain stops after MAX_HOPS steps and
 *    lets go of the lease; the next page request (or the hourly task) starts a
 *    new one. A chain that dies (an error, a deploy) leaves a lease that runs
 *    out after LEASE_MS, and the next trigger takes over the same way.
 *  - Turning sizes for existing images off stops it (keepGoing); Cloudflare
 *    Images refusing work pauses the run for PAUSE_MS (see backfillStep): page
 *    requests and the hourly task resume it after that.
 *
 * Budget per step: an image takes at most ~22 subrequests (a list, the
 * original, and for up to 5 widths a WebP and an AVIF transform and two puts)
 * plus its record, so 25 images are ≤ 575; the claims and counts (5 batches ×
 * ~5 statements), the lease (~4) and the next step's POST add ~30: ~600 of the
 * 1,000 a Worker invocation may make. Images are made 2 at a time, each
 * taking ~2–4 s, so a step ends ~15–25 s after it started, inside the 30
 * seconds waitUntil allows after its 202 response; CPU time stays small (the
 * encoding happens in the Images binding). Throughput: ~15–25 images per
 * ~20-second step, back to back, ≈ 2,000–4,000 images an hour (less with
 * large originals), against the ~15 an hour of the hourly job alone.
 */
export const STEP_BUDGET = { budgetMs: 15_000, maxImages: 25 };
/** Internal endpoint of a chain's next step (POST, through the SELF service binding). */
export const BACKFILL_PATH = "/_coywolf-pack/images/backfill";
/** Steps per chain: Cloudflare allows 32 Worker invocations per incoming request, each service-binding call counting. */
export const MAX_HOPS = 24;
const TOKEN_HEADER = "X-Coywolf-Backfill";
const STEP_HEADER = "X-Coywolf-Backfill-Step";

interface Fetcher {
	fetch(request: Request): Promise<Response>;
}

/** The SELF service binding (the site's own Worker), if bound. */
async function selfBinding(): Promise<Fetcher | undefined> {
	const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
	const self = env.SELF as Fetcher | undefined;
	return typeof self?.fetch === "function" ? self : undefined;
}

/** Keep this isolate's copy of the progress row current (page requests check it before starting a chain). */
function rememberState(state: VariantsState | null): void {
	if (state) rememberSiteOption(VARIANTS_STATE_OPTION, JSON.stringify(state));
}

interface Chain {
	token: string;
	/** 0 for the trigger, 1… for the steps posted to BACKFILL_PATH. */
	step: number;
	/** The site's origin, for posting the next step; without it (or SELF), the work is done right here, one step only. */
	origin?: string;
	self?: Fetcher;
}

/**
 * Renew the lease and post the chain's next step through SELF. The renewed
 * state when the step was accepted (202); null when the run is no longer this
 * chain's or the post failed (the caller then works or lets go).
 */
async function postNextStep(deps: BackfillDeps, chain: Chain & { self: Fetcher; origin: string }): Promise<VariantsState | null> {
	const renewed = await acquireLease(deps.db, chain.token, { follow: true });
	if (!renewed) return null;
	try {
		const response = await chain.self.fetch(
			new Request(`${chain.origin}${BACKFILL_PATH}`, { method: "POST", headers: { [TOKEN_HEADER]: chain.token, [STEP_HEADER]: String(chain.step + 1) } }),
		);
		await response.body?.cancel();
		if (response.status === 202) return renewed;
		console.error(`coywolf-pack images: the next backfill step answered ${response.status}`);
	} catch (error) {
		console.error("coywolf-pack images: couldn't start the next backfill step", error);
	}
	return null;
}

/**
 * One link of the chain: take the lease; the trigger (step 0) hands the work
 * to a step of its own, and a step works and then posts the next one; when the
 * hand-off isn't accepted (no SELF binding, or something ahead of the pack's
 * middleware refused the internal request) the work is done right here, one
 * step's worth. Lets go of the lease when nothing follows.
 */
async function chainStep(deps: BackfillDeps, chain: Chain): Promise<VariantsState | null> {
	const lease = await acquireLease(deps.db, chain.token, { follow: chain.step > 0 });
	if (!lease) return null;
	const link = chain.self && chain.origin ? (chain as Chain & { self: Fetcher; origin: string }) : null;
	if (chain.step === 0 && link) {
		const next = await postNextStep(deps, link);
		if (next) {
			rememberState(next);
			return next;
		}
	}
	const state = (await backfillStep(deps, STEP_BUDGET)) ?? lease;
	console.log(
		`coywolf-pack images: backfill step ${chain.step}: ${state.done} made, ${state.skipped} skipped, ${state.failed} failed; ${state.phase}${state.pausedUntil ? `, paused until ${state.pausedUntil}` : ""}`,
	);
	const more = (state.phase === "running" || state.phase === "cleanup") && !pausedAt(state, Date.now()) && (deps.keepGoing ? await deps.keepGoing() : true);
	// A trigger whose hand-off was refused doesn't try again: the next trigger starts a new chain.
	if (more && link && chain.step > 0 && chain.step < MAX_HOPS) {
		const next = await postNextStep(deps, link);
		if (next) {
			rememberState(next);
			return next;
		}
	}
	const released = (await releaseLease(deps.db, chain.token)) ?? state;
	rememberState(released);
	return released;
}

/** Constant-time comparison of two tokens of the same length (both are checked against the UUID shape first). */
function sameToken(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Start a chain on the current run (starting a run first: with `force`, a new
 * one; otherwise only when the last finished a day ago), unless one is under
 * way. A no-op without the bindings, a media host, or sizes for existing images
 * turned on. With `origin` and the SELF binding the work runs in steps of their
 * own; otherwise one step runs here.
 */
export async function startBackfillChain(origin?: string, options: { force?: boolean } = {}): Promise<VariantsState | null> {
	if (!(await variantsBulkOn())) return null;
	const deps = await variantDeps();
	if (!deps) return null;
	const run = await startVariantsRun(deps.db, { force: options.force });
	// Another chain holds the run, it's paused or done: nothing to start (and this isolate now knows, so
	// page requests stop asking until its lease runs out).
	if (!backfillMayHaveWork(JSON.stringify(run))) {
		rememberState(run);
		return run;
	}
	return chainStep(deps, { token: crypto.randomUUID(), step: 0, origin, self: origin ? await selfBinding() : undefined });
}

/**
 * The internal endpoint (BACKFILL_PATH): runs a chain's next step after the
 * response (202) when the request carries the lease's current token; 403
 * otherwise. Undefined for any other path.
 */
export async function handleBackfillRequest(request: Request, waitUntil: (p: Promise<unknown>) => void): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== BACKFILL_PATH) return undefined;
	const forbidden = () => new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
	const token = request.headers.get(TOKEN_HEADER) ?? "";
	const step = Number(request.headers.get(STEP_HEADER));
	if (request.method !== "POST" || !/^[0-9a-f-]{36}$/.test(token) || !Number.isInteger(step) || step < 1 || step > MAX_HOPS) return forbidden();
	const deps = await variantDeps();
	if (!deps) return forbidden();
	const { state } = await readVariantsState(deps.db);
	if (!state?.lease || !sameToken(state.lease, token)) return forbidden();
	waitUntil(chainStep(deps, { token, step, origin: url.origin, self: await selfBinding() }).catch((error) => console.error("coywolf-pack images: backfill step failed", error)));
	return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
}

/** Per isolate: page requests look for a chain to start at most this often. */
let chainCheckUntil = 0;
const CHAIN_CHECK_MS = 10_000;

/**
 * From a page request: start a chain when the progress row (as read with the
 * feature switches: no query) shows a run with no chain working on it.
 */
function maybeStartChain(origin: string, waitUntil: (p: Promise<unknown>) => void): void {
	const now = Date.now();
	if (now < chainCheckUntil || !backfillMayHaveWork(siteOption(VARIANTS_STATE_OPTION), now)) return;
	chainCheckUntil = now + CHAIN_CHECK_MS;
	waitUntil(startBackfillChain(origin).catch((error) => console.error("coywolf-pack images: couldn't start the backfill", error)));
}

/** The bindings stored sizes need, or null when one is missing (or there's no media host). */
export async function variantDeps(): Promise<BackfillDeps | null> {
	await refreshMediaHost();
	if (!imageCdn()) return null;
	const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
	const db = env[config.database] as Db | undefined;
	const bucket = env[config.bucket] as VariantBucket | undefined;
	const images = env[config.images] as ImagesBinding | undefined;
	if (!db || !bucket || !images) return null;
	return {
		db,
		bucket,
		images,
		upgradePosters: (deadline) => upgradeListedPosters(db as never, bucket, images, deadline),
		// Read with the feature switches (per-isolate cache, FEATURES_TTL_MS), so a run under way
		// stops within that long of the setting being turned off; a toggle in this isolate stops it at once.
		keepGoing: variantsBulkOn,
		// Pages showing images still on /s/ were cached normally (not as stopgaps): once the run made
		// sizes, clear the page cache once and warm it again, so every page picks them up together.
		onDone: async () => {
			if (!(await purgePageCache())) return;
			if (await siteSetting<boolean>(WARM_SETTING, config.database)) rememberSiteOption(WARM_STATE_OPTION, JSON.stringify(await startWarm(db as unknown as D1Database, "images")));
		},
	};
}

/** The site's origin (for the chain's steps), from its configured URL. */
function siteOrigin(ctx: PluginContext): string | undefined {
	try {
		return ctx.site?.url ? new URL(ctx.site.url).origin : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Make one uploaded image's stored sizes. Runs after the upload's response
 * (compose.ts hands media:afterUpload work to waitUntil, gated by the feature
 * switch), on the raw bindings. Without a media host there are no stored sizes
 * (the Worker route resizes on request), so nothing is said; a media host with
 * a binding missing is a misconfiguration, said once per upload: silence here
 * hid a dropped hook for three releases. A job cut off at waitUntil's limit
 * (about 30 seconds after the response) leaves no record, and with sizes for
 * existing images off nothing comes back for it; a run of the backfill does.
 */
async function variantsForUpload(media: { id: string; mimeType?: string | null }): Promise<void> {
	if (!eligible(media.mimeType, 1, 0)) return;
	const deps = await variantDeps();
	if (!deps) {
		if (imageCdn()) console.warn(`coywolf-pack images: no stored sizes for upload ${media.id}: the ${config.database}, ${config.bucket} or ${config.images} binding is missing`);
		return;
	}
	const row = await mediaRow(deps.db, media.id);
	if (row) await processMedia(deps, row);
	forgetInfo(media.id);
}

const MEDIA_ITEM = /^\/_emdash\/api\/media\/([A-Za-z0-9_-]+)(?:\/(replace))?$/;
const WP_MEDIA_IMPORT = "/_emdash/api/import/wordpress/media";

/**
 * Keep stored sizes in step with media-library writes the hooks don't cover,
 * after a successful response (null when the request isn't one):
 * - a deleted image: its copies and record go (whether or not the feature is on);
 * - a replaced file (PUT …/replace, same key): its sizes are made again;
 * - a WordPress media import (EmDash's importer doesn't notify plugins): a new backfill run starts (its chain
 *   of steps, see startBackfillChain), only when the site turned on stored sizes for existing images (an
 *   import can be thousands of images). `origin` is the site's, for the chain's steps.
 * New uploads aren't handled here: since EmDash 1.2.0 the media:afterUpload hook runs for every upload,
 * direct (POST …/confirm) ones included, and makes their sizes (see the hook in imagesPack).
 */
export function variantsAfterMediaWrite(method: string, pathname: string, featureOn: boolean, origin?: string): Promise<void> | null {
	if (pathname === WP_MEDIA_IMPORT && method === "POST") {
		if (!featureOn) return null;
		return startBackfillChain(origin, { force: true }).then(() => undefined);
	}
	const m = MEDIA_ITEM.exec(pathname);
	if (!m) return null;
	const [, id, action] = m;
	if (method === "DELETE" && !action) {
		return (async () => {
			const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
			const db = env[config.database] as Db | undefined;
			const bucket = env[config.bucket] as VariantBucket | undefined;
			if (db && bucket) await forgetMedia({ db, bucket }, id);
			forgetInfo(id);
		})();
	}
	// PUT /media/<id>/replace keeps the key but changes the file: EmDash runs no upload hook for it.
	if (method === "PUT" && action === "replace" && featureOn) {
		return (async () => {
			const deps = await variantDeps();
			if (!deps) return;
			await forgetMedia(deps, id);
			const row = await mediaRow(deps.db, id);
			if (row) await processMedia(deps, row, undefined, { force: true });
			forgetInfo(id);
		})();
	}
	return null;
}

export function imagesPack(options: ImagesOptions = {}): PackModule {
	config = { bucket: options.bucket ?? "MEDIA", images: options.images ?? "IMAGES", database: options.database ?? "DB" };
	setImageCrops(options.crops);
	if (options.cdn && !/^https:\/\//i.test(options.cdn.trim())) console.warn("coywolf-pack images: images.cdn must be an https origin like https://media.example.com; ignored.");
	setImageCdn(options.cdn);
	configureMediaHostDatabase(options.database);
	return {
		id: "images",
		label: "Clean Image URLs",
		features: FEATURES,
		routes: imagesModule({ database: options.database, variants: { start: (origin, force) => startBackfillChain(origin, { force }), deps: variantDeps } }).routes,
		adminPages: [{ path: "/images", label: "Clean Image URLs", icon: "image" }],
		storage: { [VARIANTS_COLLECTION]: { indexes: [] } },
		hooks: {
			// Every new upload (EmDash 1.2.0+ runs it for direct uploads too, after POST …/confirm). EmDash
			// doesn't wait for this hook, so compose.ts runs it under waitUntil, after the upload's response;
			// an image whose sizes already exist is left alone (processMedia).
			"media:afterUpload": (event: { media: { id: string; mimeType?: string } }) => variantsForUpload(event.media),
		},
		tasks: [
			{
				name: VARIANTS_TASK,
				schedule: "@hourly",
				// Restarts the backfill: a run finished a day ago (to retry failures), or one whose chain
				// stopped or paused. The steps run in requests of their own (see startBackfillChain).
				handler: async (ctx: PluginContext) => {
					await startBackfillChain(siteOrigin(ctx));
				},
			},
		],
		capabilities: ["network:request"],
		allowedHosts: [CLOUDFLARE_API_HOST],
	};
}

/**
 * A clean URL for a resized copy of a media-library image, or null when the
 * feature is off or `src` isn't a media-library file (use your usual image
 * code then). `height` crops to fill; without it the ratio is kept.
 */
export async function cleanImageUrl(src: string | null | undefined, options: { width: number; height?: number; format?: string }): Promise<string | null> {
	if (!(await siteFeatureOn(F.main))) return null;
	await refreshMediaHost();
	return cleanImagePath(src, options);
}

/**
 * The original file on the media host (e.g. for a full-size link or an
 * <img> src without resizing). Falls back to `src` itself when the feature
 * is off, no media host is set, or `src` isn't a media-library file.
 */
export async function originalImageUrl<T extends string | null | undefined>(src: T): Promise<string | T> {
	if (!src || !(await siteFeatureOn(F.main))) return src;
	await refreshMediaHost();
	return cdnOriginalUrl(src) ?? src;
}

/** Same as originalImageUrl. */
export const mediaUrl = originalImageUrl;

export interface ImageDimensions {
	width: number;
	height: number;
}

/** A media-library image as pages need it: its size, focal point, and stored sizes (if any). */
export interface ImageInfo {
	/** Media id. */
	id: string;
	width: number | null;
	height: number | null;
	mimeType: string | null;
	size: number | null;
	/** Its stored-sizes record, any version (null when there's none). */
	variants: VariantDoc | null;
	/** When it was added to the media library (ms; null when unknown). */
	createdAt: number | null;
}

/** Per isolate, by media id: dropped when settings change (settingsEpoch) or after INFO_TTL_MS. */
const infoCache = new Map<string, { info: ImageInfo | null; epoch: number; at: number }>();
const INFO_TTL_MS = 10 * 60_000;

/** Forget one image (its sizes were just made or removed in this isolate). */
export function forgetInfo(id: string): void {
	infoCache.delete(id);
}

/** The media id and bucket key (<id>.<ext>) of a media-library or media-host URL. */
function mediaRef(src: string): { id: string; key: string } | null {
	const file = mediaFile(src) ?? parseCdnUrl(src.trim());
	return file ? { id: file.id, key: `${file.id}.${file.ext}` } : null;
}

/**
 * Facts about media-library images (size, focal point, stored sizes) for the
 * given sources, in one D1 statement for the whole list (batched with the
 * page's other pack reads of this tick); remembered per isolate for a few
 * minutes. Call it once per page with every image the page shows, then
 * responsiveImage()/croppedImage() for each answer from the cache. Works
 * whether or not Clean image URLs is on. Unknown sources are left out.
 */
export async function imageInfo(srcs: Iterable<string | null | undefined>, database = config.database): Promise<Map<string, ImageInfo>> {
	const result = new Map<string, ImageInfo>();
	const wanted = new Map<string, { id: string; srcs: string[] }>();
	for (const src of srcs) {
		if (!src) continue;
		const ref = mediaRef(src);
		if (!ref) continue;
		const hit = infoCache.get(ref.id);
		if (hit && isCurrent(hit, INFO_TTL_MS)) {
			if (hit.info) result.set(src, hit.info);
			continue;
		}
		const entry = wanted.get(ref.key) ?? { id: ref.id, srcs: [] };
		entry.srcs.push(src);
		wanted.set(ref.key, entry);
	}
	if (!wanted.size) return result;
	const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
	const db = env[database] as D1Database | undefined;
	if (!db) return result;
	const keys = [...wanted.keys()];
	const epoch = settingsEpoch();
	// D1 allows at most 100 bound parameters per query.
	for (let i = 0; i < keys.length; i += 90) {
		const batch = keys.slice(i, i + 90);
		type Row = { id: string; storage_key: string; width: number | null; height: number | null; mime_type: string | null; size: number | null; created_at: string | null; data: string | null };
		// By storage_key: the file name in a media URL is the bucket key's stem, not the media id
		// (EmDash names files with their own ULID, and uploads since 1.1 as <stem>.<attempt>.<ext>).
		// storage_key has no index, so this is one scan of the media table per uncached page.
		const rows = await batchedAll<Row>(
			db,
			db
				.prepare(
					`SELECT m.id, m.storage_key, m.width, m.height, m.mime_type, m.size, m.created_at, s.data FROM media AS m
					LEFT JOIN _plugin_storage AS s ON s.plugin_id = 'coywolf-pack' AND s.collection = '${VARIANTS_COLLECTION}' AND s.id = m.id
					WHERE m.storage_key IN (${batch.map(() => "?").join(",")})`,
				)
				.bind(...batch),
		);
		const found = new Map(rows.map((r) => [r.storage_key, r]));
		if (infoCache.size > 5000) infoCache.clear();
		for (const key of batch) {
			const row = found.get(key);
			const { id, srcs: sources } = wanted.get(key)!;
			const info: ImageInfo | null = row
				? { id: row.id, width: row.width, height: row.height, mimeType: row.mime_type, size: row.size, variants: parseDoc(row.data), createdAt: mediaTime(row.created_at) }
				: null;
			infoCache.set(id, { info, epoch, at: Date.now() });
			if (info) for (const src of sources) result.set(src, info);
		}
	}
	return result;
}

/**
 * Width and height of media-library images, from the media library itself.
 * For images whose Portable Text block has none (WordPress imports don't record
 * them), so themes can still build responsive srcsets and set width/height.
 * Same single read and cache as imageInfo. Unknown sources are left out.
 */
export async function imageDimensions(srcs: Iterable<string | null | undefined>, database = config.database): Promise<Map<string, ImageDimensions>> {
	const result = new Map<string, ImageDimensions>();
	for (const [src, info] of await imageInfo(srcs, database)) if (info.width && info.height) result.set(src, { width: info.width, height: info.height });
	return result;
}

/** An image's stored sizes as srcsets for a <picture>: AVIF and WebP (the original is the largest candidate). */
export interface ResponsiveImage {
	avif: string;
	webp: string;
	src: string;
	full: string;
	width: number;
	height: number;
}

/** A media row's created_at ("YYYY-MM-DD HH:MM:SS" in UTC from SQLite's datetime(), or ISO) in ms. */
function mediaTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

/** An upload this recent may still be getting its sizes (they're made right after the upload, within a minute or so). */
export const NEW_UPLOAD_MS = 15 * 60_000;

/**
 * Whether an image without a current record will get its widths within minutes,
 * so a page showing its /s/ stopgap should be cached briefly: only when it was
 * uploaded in the last 15 minutes. Older images waiting for the backfill don't
 * shorten pages (that would rebuild every page every five minutes for hours):
 * the page is cached normally, and the backfill clears the page cache once when
 * its run is done (BackfillDeps.onDone), so all pages pick the sizes up together.
 */
function expectedSoon(info: ImageInfo, now = Date.now()): boolean {
	if (!eligible(info.mimeType, info.width, info.size)) return false;
	if (info.variants?.v === VARIANTS_VERSION && info.variants.skip) return false;
	return info.createdAt !== null && now - info.createdAt < NEW_UPLOAD_MS;
}

/**
 * The image's stored widths as AVIF and WebP srcsets (and the original), or
 * null when there are none (the feature is off, there's no media host, the
 * image isn't a media-library file, or its sizes aren't made yet): use
 * cleanImageUrl() then. Pass `locals` (Astro.locals) so a page shown before
 * the sizes exist is cached for minutes, not days.
 */
export async function responsiveImage(src: string | null | undefined, options: { locals?: object | null } = {}): Promise<ResponsiveImage | null> {
	if (!src || !(await siteFeatureOn(F.main))) return null;
	await refreshMediaHost();
	const cdn = imageCdn();
	const original = cdnOriginalUrl(src);
	if (!cdn || !original) return null;
	const info = (await imageInfo([src])).get(src);
	if (!info?.width || !info.height) return null;
	if (!currentDoc(info.variants)) {
		if (expectedSoon(info)) markPendingMedia(options.locals);
		return null;
	}
	// Images under 400 pixels have no stored widths: a plain <img> of the original (or /s/) is all there is.
	if (!info.variants.w.some((w) => w < (info.width as number))) return null;
	return { ...variantSrcsets(cdn, info.id, info.variants, original, info.width), width: info.width, height: info.height };
}

/**
 * Crops made on first use: per isolate, by "<media id>:<crop>", when each was
 * queued (so it isn't queued again while it's being made) or failed (so pages
 * don't wait for it, and it's tried again an hour later).
 */
const cropJobs = new Map<string, { until: number; failed?: boolean }>();
const CROP_JOB_MS = 10 * 60_000;
const CROP_RETRY_MS = 60 * 60_000;
/** Images whose crops are queued in this isolate, made one at a time (each holds its original in memory). */
let cropQueue: Promise<void> = Promise.resolve();
let queuedImages = 0;
const MAX_QUEUED_IMAGES = 6;

/** Make the given crops of one image and add them to its record (after the response). */
async function makeCrops(id: string, names: string[]): Promise<void> {
	const deps = await variantDeps();
	const row = deps ? await mediaRow(deps.db, id) : null;
	if (!deps || !row?.width) return;
	const doc = await generateVariants({
		bucket: deps.bucket,
		images: deps.images,
		key: row.storage_key,
		id: row.id,
		width: row.width,
		height: row.height,
		focal: row.focal_x != null && row.focal_y != null ? { x: row.focal_x, y: row.focal_y } : null,
		widths: [],
		crops: names,
	});
	await addCrops(deps.db, id, doc.c ?? []);
	forgetInfo(id);
}

/**
 * Queue missing crops of an image whose widths are stored. False when one of
 * them failed recently (the page uses /s/ for it without waiting). Queued
 * crops, and ones that couldn't be queued now (this isolate is busy; a later
 * render queues them), are "on their way": the page is a stopgap.
 */
function queueCrops(id: string, names: string[], now = Date.now()): boolean {
	const jobs = names.map((name) => cropJobs.get(`${id}:${name}`));
	if (jobs.some((job) => job?.failed && job.until > now)) return false;
	const fresh = names.filter((_, i) => !jobs[i] || jobs[i].until <= now);
	if (!fresh.length || queuedImages >= MAX_QUEUED_IMAGES) return true;
	if (cropJobs.size > 5000) cropJobs.clear();
	for (const name of fresh) cropJobs.set(`${id}:${name}`, { until: now + CROP_JOB_MS });
	queuedImages++;
	cropQueue = cropQueue
		.then(() => makeCrops(id, fresh))
		.catch((error) => {
			console.error(`coywolf-pack images: couldn't make crops ${fresh.join(", ")} of ${id}`, error);
			for (const name of fresh) cropJobs.set(`${id}:${name}`, { until: Date.now() + CROP_RETRY_MS, failed: true });
		})
		.finally(() => {
			queuedImages--;
		});
	void afterResponse(cropQueue);
	return true;
}

/** Wait for this isolate's queued crops (tests). */
export function cropsIdle(): Promise<void> {
	return cropQueue;
}

/** Forget queued and failed crops (tests). */
export function resetCropJobs(): void {
	cropJobs.clear();
}

/**
 * Stored crops of an image (sizes from the site's `images.crops`) as AVIF and
 * WebP srcsets: `crops` are [width, height, descriptor] such as
 * [600, 315, "600w"] or [50, 50, "1x"]; `src` is the WebP of `srcIndex`. Null
 * when any of them isn't stored (use cleanImageUrl() then).
 *
 * Crops are made on first use: when the image's widths are stored but a crop
 * isn't, it's made after the response and the page is marked as a stopgap
 * (through `locals`), so its next render uses it. An image without stored
 * widths gets no crops until it has them.
 */
export async function croppedImage(
	src: string | null | undefined,
	crops: Array<readonly [number, number, string]>,
	options: { locals?: object | null; srcIndex?: number } = {},
): Promise<{ avif: string; webp: string; src: string } | null> {
	if (!src || !crops.length || !(await siteFeatureOn(F.main))) return null;
	await refreshMediaHost();
	const cdn = imageCdn();
	if (!cdn || !cdnOriginalUrl(src)) return null;
	const info = (await imageInfo([src])).get(src);
	if (!info) return null;
	const names = crops.map(([w, h]) => `${Math.round(w)}x${Math.round(h)}`);
	const states = names.map((name) => cropState(info.variants, name, info.width, info.height));
	if (states.every((s) => s === "stored")) return cropSrcsets(cdn, info.id, info.variants as VariantDoc, names.map((n, i) => [n, crops[i][2]]), options.srcIndex);
	if (states.includes("never")) return null;
	if (states.includes("none")) {
		if (expectedSoon(info)) markPendingMedia(options.locals);
		return null;
	}
	if (queueCrops(info.id, names.filter((_, i) => states[i] === "missing"))) markPendingMedia(options.locals);
	return null;
}

const listCache = new Map<string, string | null>();

/** The bucket key of a file id (files are stored as <id>.<ext>). */
async function findKey(bucket: R2Bucket, id: string): Promise<string | null> {
	if (listCache.has(id)) return listCache.get(id) ?? null;
	const page = await bucket.list({ prefix: `${id}.`, limit: 2 });
	const key = page.objects.find((o) => o.key.startsWith(`${id}.`))?.key ?? null;
	if (listCache.size > 5000) listCache.clear();
	listCache.set(id, key);
	return key;
}

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });

export const imagesMiddleware: PackMiddleware = {
	module: "images",
	feature: F.main,
	handle: async (context, env, waitUntil) => {
		const { pathname } = context.url;
		// A backfill chain's next step (internal; see startBackfillChain).
		if (pathname === BACKFILL_PATH) return handleBackfillRequest(context.request, waitUntil);
		// Page traffic restarts a backfill run that has no chain working on it (no query when there's none).
		if (context.request.method === "GET" && !pathname.startsWith("/_emdash/") && context.request.headers.get("user-agent") !== WARMER_AGENT) {
			maybeStartChain(context.url.origin, waitUntil);
		}
		if (!pathname.startsWith(IMAGE_PATH)) return undefined;
		const request = parseImagePath(pathname);
		if (!request) return undefined;
		if (context.request.method !== "GET" && context.request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

		const bucket = env[config.bucket] as R2Bucket | undefined;
		if (!bucket) return undefined;
		// With a media host, old Worker-route URLs move there (same size; the host picks the format).
		await refreshMediaHost();
		if (imageCdn()) {
			const key = await findKey(bucket, request.id);
			const target = key ? cdnRedirectUrl(request, key) : null;
			if (!target) return notFound();
			return new Response(null, { status: 301, headers: { Location: target, "Cache-Control": "public, max-age=86400" } });
		}

		// Only sizes on the grid are resized; anything else moves to the nearest one up.
		const snapped = snappedImagePath(request);
		if (snapped) return new Response(null, { status: 301, headers: { Location: snapped, "Cache-Control": "public, max-age=86400" } });

		const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
		// Keyed by path alone: a query string can't force a fresh (billed) transform.
		const cacheKey = new Request(`${context.url.origin}${pathname}`, { method: "GET" });
		const hit = cache ? await cache.match(cacheKey) : undefined;
		// Cached responses have immutable headers; hand back a copy later middleware can still change.
		if (hit) return new Response(context.request.method === "HEAD" ? null : hit.body, { status: hit.status, headers: new Headers(hit.headers) });

		const images = env[config.images] as ImagesBinding | undefined;
		if (!images) return undefined;
		const key = await findKey(bucket, request.id);
		if (!key) return notFound();
		const object = await bucket.get(key);
		if (!object) return notFound();
		if ((object.httpMetadata?.contentType ?? "").includes("svg")) return notFound();

		let out: Response;
		try {
			const transformed = await images
				.input(object.body)
				.transform(request.height === undefined ? { width: request.width } : { width: request.width, height: request.height, fit: "cover" })
				.output({ format: FORMATS[request.format], quality: 85 });
			out = transformed.response();
		} catch (error) {
			console.error("coywolf-pack images: transform failed", key, error);
			return new Response("Could not resize this image", { status: 502, headers: { "Cache-Control": "no-store" } });
		}
		const headers = new Headers(out.headers);
		headers.set("Content-Type", FORMATS[request.format]);
		headers.set("Cache-Control", "public, max-age=31536000, immutable");
		headers.set("X-Content-Type-Options", "nosniff");
		const response = new Response(out.body, { status: 200, headers });
		if (cache) waitUntil(cache.put(cacheKey, response.clone()));
		return context.request.method === "HEAD" ? new Response(null, { headers: new Headers(headers) }) : response;
	},
};

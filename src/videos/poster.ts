/**
 * Video posters from the media host.
 *
 * Stream makes thumbnails on request: even cached ones take 120–450 ms to start
 * arriving, a new one over a second, always as JPEG, and from another host the
 * browser has to connect to first. So each poster is copied into the media
 * bucket (one full-size JPEG per video and poster time) with stored WebP and
 * AVIF sizes next to it (src/images/variants.ts), and pages use those from the
 * media host like any other image. Without a media host, or until the copy
 * exists, Stream's thumbnails are used. Posters copied before stored sizes
 * existed (listed without "#v<version>") use the media host's /s/ resizing
 * until the stored-sizes backfill makes theirs (upgradeListedPosters).
 *
 * Rendering never waits on the bucket or on Stream: the copied posters are
 * listed in one plugin setting (read with the feature switches, so it costs no
 * query), and a poster that isn't listed yet is rendered from Stream while it's
 * copied (and listed) in the background. Such a page is marked (see
 * markPendingMedia) so the pack middleware caches it for minutes, not days:
 * the next render, once the copy is listed, uses the media host.
 */
import { PLUGIN_ID, registerSiteSetting, rememberSiteSetting, siteFeatureOn, siteSetting } from "../core/features.js";
import { imageCdn } from "../images/lib.js";
import { markPendingMedia, pendingMediaRenders, renderedPendingMedia, resetPendingMedia, PENDING_MEDIA_LOCAL } from "../images/pending.js";
import { refreshMediaHost } from "../images/settings.js";
import { type ImagesBinding, VARIANTS_VERSION, type VariantBucket, generateVariants, variantKey } from "../images/variants.js";
import { afterResponse, workerEnv } from "../shared.js";
import { POSTER_WIDTHS, posterImage, posterUrl } from "./lib.js";

/** Width of the copy kept in the bucket: covers the largest poster on a 2x screen. */
export const SOURCE_WIDTH = 1600;
const FETCH_TIMEOUT_MS = 5000;
const MEDIA_BINDING = "MEDIA";
const IMAGES_BINDING = "IMAGES";

/** Plugin setting listing the poster keys already in the bucket. */
export const POSTERS_SETTING = "videosMirroredPosters";
export const POSTERS_OPTION = `plugin:${PLUGIN_ID}:settings:${POSTERS_SETTING}`;
/** Most keys the list keeps (about 60 bytes each); past it, new posters are still copied but found per isolate. */
export const MAX_LISTED_POSTERS = 3000;
registerSiteSetting(POSTERS_SETTING);

type PosterRef = { posterImage?: string; posterTime?: number };

interface Bucket {
	head(key: string): Promise<unknown | null>;
	put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

/** The list entry of a poster whose stored sizes (current version) exist. */
export const posterEntry = (key: string) => `${key}#v${VARIANTS_VERSION}`;
/** Id of a poster's stored sizes: its key without the extension. */
const posterId = (key: string) => key.replace(/\.[a-z0-9]+$/i, "");

/** The slice of a D1 binding used to list a copied poster. */
interface Db {
	prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown>; first<T = unknown>(): Promise<T | null> } };
}

/** Bucket key for a Stream thumbnail URL: flat, so the media host's /s/<w>/<file> rule resizes it. */
export async function posterKey(uid: string, source: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
	const hash = [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `cwposter-${uid}-${hash}.jpg`;
}

/** "copied": newly put in the bucket; "present": it was already there; false: the copy failed. */
export type MirrorResult = "copied" | "present" | false;

/** Per-isolate: copies under way or done. A failed copy is forgotten, so it's retried. */
const mirrored = new Map<string, Promise<MirrorResult>>();
/** Per-isolate: keys known to be in the bucket. */
const present = new Set<string>();

/** Copy `source` into the bucket at `key` unless it's there already. Truthy when the bucket has it. */
export function mirrorPoster(bucket: Bucket, key: string, source: string, fetcher: typeof fetch = fetch): Promise<MirrorResult> {
	let pending = mirrored.get(key);
	if (!pending) {
		pending = (async (): Promise<MirrorResult> => {
			if (await bucket.head(key)) return "present";
			const res = await fetcher(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			const type = res.headers.get("content-type") ?? "";
			if (!res.ok || !type.startsWith("image/")) return false;
			await bucket.put(key, await res.arrayBuffer(), {
				httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
			});
			return "copied";
		})().catch(() => false as const);
		mirrored.set(key, pending);
		pending.then((ok) => (ok ? present.add(key) : mirrored.delete(key)));
	}
	return pending;
}

/** Request each URL as AVIF and as WebP so the media host resizes and caches them. */
export function warmSizes(urls: string[], fetcher: typeof fetch = fetch): Promise<unknown> {
	return Promise.allSettled(
		urls.flatMap((url) =>
			["image/avif", "image/webp"].map((accept) =>
				fetcher(url, { headers: { accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((r) => r.body?.cancel()),
			),
		),
	);
}

/**
 * Add `key` to the listed posters in one statement (no read-modify-write, so
 * renders in other isolates can't drop each other's keys). No-op when it's
 * listed already or the list is full.
 */
export async function listPoster(db: Db, key: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO options (name, value) VALUES (?1, json_array(?2))
			ON CONFLICT(name) DO UPDATE SET value = json_insert(CASE WHEN json_valid(options.value) AND json_type(options.value) = 'array' THEN options.value ELSE '[]' END, '$[#]', ?2)
			WHERE NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(options.value) THEN options.value ELSE '[]' END) WHERE json_each.value = ?2)
				AND (NOT json_valid(options.value) OR json_type(options.value) <> 'array' OR json_array_length(options.value) < ?3)`,
		)
		.bind(POSTERS_OPTION, key, MAX_LISTED_POSTERS)
		.run();
}

/** The listed keys as a set, rebuilt only when the cached list changes. */
let listedMemo: { list: unknown; keys: Set<string> } | null = null;
function listedKeys(list: unknown): Set<string> {
	if (listedMemo && listedMemo.list === list) return listedMemo.keys;
	const keys = new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
	listedMemo = { list, keys };
	return keys;
}

/** Forget what this isolate has copied (tests). */
export function resetMirroredPosters(): void {
	mirrored.clear();
	present.clear();
	madeHere.clear();
	listedMemo = null;
	resetPendingMedia();
}

/** Earlier names of the stopgap marking (now src/images/pending.ts, shared with images). */
export const PENDING_POSTER_LOCAL = PENDING_MEDIA_LOCAL;
export const markPendingPoster = markPendingMedia;
export const pendingPosterRenders = pendingMediaRenders;
export const renderedPendingPoster = renderedPendingMedia;

/** Make a copied poster's stored sizes. Throws when they can't be made. */
export function posterVariants(bucket: VariantBucket, images: ImagesBinding, key: string) {
	return generateVariants({ bucket, images, key, id: posterId(key), width: SOURCE_WIDTH, widths: POSTER_WIDTHS, crops: [] });
}

export interface PosterDeps {
	cdn: string;
	bucket: Bucket & Partial<VariantBucket>;
	/** Images binding, to make the stored sizes; without it new copies use /s/ resizing. */
	images?: ImagesBinding;
	/** Keys listed as copied (from the plugin setting). */
	listed: Set<string>;
	/** List a key once the bucket has it. */
	list: (key: string) => Promise<void>;
	/** Schedule work after the response. */
	defer: (work: Promise<unknown>) => void;
	fetcher?: typeof fetch;
}

export interface MediaPosterImage {
	src: string;
	srcset: string;
	/** srcset of the AVIF copies (stored sizes only). */
	avif?: string;
	full: string;
}

/** Stored sizes of a poster: WebP and AVIF at POSTER_WIDTHS. */
function storedPoster(cdn: string, key: string): MediaPosterImage {
	const at = (w: number, ext: "webp" | "avif") => `${cdn}/${variantKey(posterId(key), w, ext)}`;
	const set = (ext: "webp" | "avif") => POSTER_WIDTHS.map((w) => `${at(w, ext)} ${w}w`).join(", ");
	return { src: at(800, "webp"), srcset: set("webp"), avif: set("avif"), full: at(1200, "webp") };
}

/** A poster copied before stored sizes: resized by the media host (/s/). */
function resizedPoster(cdn: string, key: string): MediaPosterImage {
	const at = (w: number) => `${cdn}/s/${w}/${key}`;
	return { src: at(800), srcset: POSTER_WIDTHS.map((w) => `${at(w)} ${w}w`).join(", "), full: at(1200) };
}

/** Per-isolate: list entries of posters this isolate copied (and sized) itself. */
const madeHere = new Set<string>();

/**
 * The media-host poster when the copy is known to exist (listed, or made by
 * this isolate), else null right away. The copy starts at once (during this
 * render, not after it), and `defer` only keeps it, its stored sizes and its
 * listing alive past the response, so the next render a few minutes later
 * finds it listed.
 */
export async function mediaPoster(uid: string, source: string, deps: PosterDeps): Promise<MediaPosterImage | null> {
	const key = await posterKey(uid, source);
	if (deps.listed.has(posterEntry(key)) || madeHere.has(posterEntry(key))) return storedPoster(deps.cdn, key);
	if (deps.listed.has(key) || madeHere.has(key)) return resizedPoster(deps.cdn, key);
	if (!mirrored.has(key)) {
		deps.defer(
			mirrorPoster(deps.bucket, key, source, deps.fetcher).then(async (result) => {
				if (!result) return;
				const { images, bucket } = deps;
				if (images && bucket.get && bucket.list && bucket.delete) {
					const sized = await posterVariants(bucket as VariantBucket, images, key).then(
						() => true,
						(error) => (console.error("coywolf-pack videos: couldn't make the poster's stored sizes", key, error), false),
					);
					if (sized) {
						madeHere.add(posterEntry(key));
						await deps.list(posterEntry(key)).catch(() => undefined);
						return;
					}
				}
				madeHere.add(key);
				await deps.list(key).catch(() => undefined);
				// Just copied: have the media host make each size now (AVIF and WebP), so the first
				// visitor doesn't wait for the resize. A poster already in the bucket was warmed then.
				if (result === "copied") await warmSizes(POSTER_WIDTHS.map((w) => `${deps.cdn}/s/${w}/${key}`), deps.fetcher);
			}),
		);
	}
	return null;
}

/** Replace (or, with `to` null, remove) one entry of the listed posters in one statement. */
export async function relistPoster(db: Db, from: string, to: string | null): Promise<void> {
	await db
		.prepare(
			`UPDATE options SET value = (
				SELECT json_group_array(CASE WHEN j.value = ?2 THEN ?3 ELSE j.value END) FROM json_each(options.value) AS j WHERE ?3 IS NOT NULL OR j.value <> ?2
			) WHERE name = ?1 AND json_valid(value) AND json_type(value) = 'array'`,
		)
		.bind(POSTERS_OPTION, from, to)
		.run();
}

/** Legacy posters upgraded per call: each is ~16 subrequests, and the call shares an invocation's 1,000 with the images made before it. */
export const POSTER_UPGRADES_PER_CALL = 10;

/**
 * Make the stored sizes of posters listed before they existed (or with an
 * older version), and list them as sized. A poster whose sizes can't be made
 * is unlisted, so the next render copies it again (its JPEG is still in the
 * bucket, so that's a head request and another try). True when none are left;
 * false when `deadline` passed or POSTER_UPGRADES_PER_CALL were done first.
 */
export async function upgradeListedPosters(db: Db, bucket: VariantBucket, images: ImagesBinding, deadline: number): Promise<boolean> {
	const row = await db.prepare("SELECT value FROM options WHERE name = ?1").bind(POSTERS_OPTION).first<{ value: string }>();
	let list: unknown = [];
	try {
		list = row?.value ? JSON.parse(row.value) : [];
	} catch {
		return true;
	}
	const legacy = (Array.isArray(list) ? list : []).filter((e): e is string => typeof e === "string" && !e.endsWith(`#v${VARIANTS_VERSION}`));
	let done = 0;
	for (const entry of legacy) {
		if (Date.now() > deadline || done++ >= POSTER_UPGRADES_PER_CALL) return false;
		const key = entry.split("#")[0];
		try {
			await posterVariants(bucket, images, key);
			await relistPoster(db, entry, posterEntry(key));
		} catch (error) {
			console.error("coywolf-pack videos: couldn't make a listed poster's stored sizes", key, error);
			await relistPoster(db, entry, null);
		}
	}
	return true;
}

/**
 * The poster as a responsive image from the media host when there is one,
 * else Stream's thumbnails (see posterImage). `full` is a single large URL
 * for the player's own poster. Pass the page's `Astro.locals` so a page shown
 * with Stream's poster while the copy is made gets a short cache lifetime
 * (without it, the middleware still notices through a per-isolate count).
 */
export async function hostedPosterImage(
	host: string | null,
	uid: string,
	ref: PosterRef,
	fallback: PosterRef = {},
	origin?: string | null,
	/** Astro.locals, so only this page gets the stopgap lifetime. */
	locals?: object | null,
): Promise<{ src: string; srcset?: string; avif?: string; full: string }> {
	const stream = posterImage(host, uid, ref, fallback, origin);
	const source = posterUrl(host, uid, ref, fallback, SOURCE_WIDTH, origin);
	// An explicit poster image is used as it is.
	if (!stream.srcset) return { ...stream, full: stream.src };
	try {
		if (!(await siteFeatureOn("images"))) return { ...stream, full: source };
		await refreshMediaHost();
		const cdn = imageCdn();
		const env = await workerEnv();
		const bucket = env[MEDIA_BINDING] as Bucket | undefined;
		if (!cdn || !bucket) return { ...stream, full: source };
		const list = await siteSetting<unknown>(POSTERS_SETTING);
		const db = env.DB as Db | undefined;
		const media = await mediaPoster(uid, source, {
			cdn,
			bucket,
			images: env[IMAGES_BINDING] as ImagesBinding | undefined,
			listed: listedKeys(list),
			list: async (key) => {
				if (!db) return;
				await listPoster(db, key);
				// This isolate sees it now; others when their settings cache refreshes (FEATURES_TTL_MS).
				const current = (await siteSetting<unknown>(POSTERS_SETTING)) ?? [];
				if (Array.isArray(current) && !current.includes(key)) rememberSiteSetting(POSTERS_SETTING, [...current, key]);
			},
			defer: (work) => void afterResponse(work),
		});
		if (media) return media;
		markPendingMedia(locals);
		return { ...stream, full: source };
	} catch {
		// Stream's poster for now, like a copy still being made: cached for minutes, not days.
		markPendingMedia(locals);
		return { ...stream, full: source };
	}
}

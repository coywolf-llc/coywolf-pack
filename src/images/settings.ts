/**
 * Where the media host comes from, applied to the pure helpers in lib.ts:
 *
 * - EmDash's storage publicUrl (`r2({ binding, publicUrl })`), read once per
 *   isolate from EmDash's build-time config (virtual:emdash/config). It wins
 *   when set: EmDash's own components print media there too.
 * - The host saved on the Clean Image URLs page, read outside the plugin
 *   context (theme code, middleware, the page:metadata hook) from D1 in the
 *   feature switches' query, sharing their per-isolate cache. It overrides the
 *   astro.config.mjs option (`images.cdn`).
 */
import { invalidateFeatures, readSiteSetting, registerSiteSetting, rememberSiteSetting, siteSetting } from "../core/features.js";
import { setSavedImageCdn, setStoragePublicUrl } from "./lib.js";

/** Plain settings (edited on the Clean Image URLs page). The API token is a secret, declared in src/core/secrets.ts. */
export const IMAGES_SETTINGS = {
	host: "imagesMediaHost",
	accountId: "imagesAccountId",
	bucket: "imagesBucketName",
	token: "imagesApiToken",
	/** Make stored sizes for existing images too (the backfill). Off until an admin turns it on: it costs transformations. */
	bulk: "imagesVariantsBulk",
} as const;

registerSiteSetting(IMAGES_SETTINGS.host);
registerSiteSetting(IMAGES_SETTINGS.bulk);
let database = "DB";

export function configureMediaHostDatabase(name: string | undefined): void {
	database = name ?? "DB";
}

/** Forget the cached value (call after saving it), optionally applying the new one right away. */
export function invalidateMediaHost(value?: string | null): void {
	if (value === undefined) {
		invalidateFeatures();
		return;
	}
	setSavedImageCdn(value);
	rememberSiteSetting(IMAGES_SETTINGS.host, value);
}

/** EmDash's storage config as its build-time config module carries it. */
interface StorageConfig {
	storage?: { entrypoint?: string; config?: { publicUrl?: unknown } } | null;
}

let storageRead: Promise<void> | null = null;

/**
 * Read EmDash's storage publicUrl once per isolate (a site build has EmDash's
 * virtual:emdash/config; under Node tests there's none, and nothing is set).
 */
export function loadStoragePublicUrl(load: () => Promise<StorageConfig | undefined> = importEmDashConfig): Promise<void> {
	storageRead ??= load()
		.then((config) => {
			const publicUrl = config?.storage?.config?.publicUrl;
			setStoragePublicUrl(typeof publicUrl === "string" ? publicUrl : null);
		})
		.catch(() => undefined);
	return storageRead;
}

/** Forget the storage read (tests). */
export function resetStoragePublicUrl(): void {
	storageRead = null;
	setStoragePublicUrl(null);
}

async function importEmDashConfig(): Promise<StorageConfig | undefined> {
	// @ts-ignore: provided by EmDash's Vite integration in the site build; absent under Node tests.
	const mod = (await import("virtual:emdash/config")) as { default?: StorageConfig };
	return mod.default;
}

/**
 * Apply EmDash's publicUrl (once per isolate) and the saved media host (from
 * the feature switches' cache). Keeps the last saved value if D1 can't be read.
 */
export async function refreshMediaHost(): Promise<void> {
	await loadStoragePublicUrl();
	const read = await readSiteSetting(IMAGES_SETTINGS.host, database).catch(() => null);
	// Not on Cloudflare, or no database: the option (if any) stays in use.
	if (read) setSavedImageCdn(typeof read.value === "string" ? read.value : null);
}

/** Whether the site turned on stored sizes for existing images (read with the feature switches: no extra query). */
export async function variantsBulkOn(): Promise<boolean> {
	return (await siteSetting<boolean>(IMAGES_SETTINGS.bulk, database).catch(() => null)) === true;
}

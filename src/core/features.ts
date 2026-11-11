/**
 * Feature switches. Every Coywolf Pack feature can be turned off on the
 * Features admin page; the choices are one plugin setting ("features", an
 * object of id → boolean). Hooks and routes read it through the plugin
 * context; middleware and Astro block renderers, which run outside it, read
 * the same option row from D1 with a per-isolate cache (five minutes).
 *
 * That one query also reads every registered site setting and a few pack
 * option rows (the settings generation, the deployed version), so the
 * settings a page render needs cost no query of their own. A save through
 * the pack's admin routes clears this isolate's cache at once and records a
 * new settings generation; other isolates see it on their next read and drop
 * every cache keyed on settingsEpoch() (see src/core/generation.ts).
 */
import type { FeatureDef } from "./module.js";
import { afterResponse, workerEnv } from "../shared.js";
import { batchedAll } from "./d1-batch.js";
import { noteReadFailure } from "./read-failures.js";
import { sharedRead, sharedSlot } from "./single-flight.js";

export const PLUGIN_ID = "coywolf-pack";
export const FEATURES_SETTING = "features";
const OPTION_NAME = `plugin:${PLUGIN_ID}:settings:${FEATURES_SETTING}`;

export type FeatureMap = Record<string, boolean>;

/** Every feature the pack knows about. Modules register theirs at import time. */
const catalog = new Map<string, FeatureDef>();

export function registerFeatures(defs: FeatureDef[]): void {
	for (const def of defs) catalog.set(def.id, def);
}

export function featureCatalog(): FeatureDef[] {
	return [...catalog.values()];
}

const parentOf = (id: string) => (id.includes(".") ? id.slice(0, id.indexOf(".")) : null);

/**
 * A key in the stored switches that isn't a feature: true once the site's
 * switches account for the defaults that changed in 0.36.0 (Redirect
 * Manager, Slug changes and Backups start off on new sites; see
 * recordDefaults). Until it's there, a feature with a `legacyDefault` takes
 * that instead of its `default`, so an existing site keeps what it had,
 * whatever reads the switches first, and a read that fails (resolved from
 * nothing) doesn't turn them off either.
 */
export const DEFAULTS_RECORDED = "_defaults036";

/** A feature's default for this stored map: its pre-0.36.0 default until the map records the change. */
function defaultOf(def: FeatureDef, stored: FeatureMap | null | undefined): boolean {
	if (stored?.[DEFAULTS_RECORDED] !== true && def.legacyDefault !== undefined) return def.legacyDefault;
	return def.default ?? false;
}

/**
 * The stored choice of a feature's legacy ids (FeatureDef.replaces): the
 * first one present in the map wins. A legacy sub-feature ("a.b") counted
 * only while its parent was on, so its parent's state (stored, else the
 * parent's default) is applied too. Undefined when none is stored.
 */
export function legacyChoice(stored: FeatureMap | null | undefined, def: FeatureDef): boolean | undefined {
	if (!stored || !def.replaces) return undefined;
	for (const legacy of def.replaces) {
		if (typeof stored[legacy] !== "boolean") continue;
		const parent = parentOf(legacy);
		// A parent that's no longer in the catalog (and wasn't stored) doesn't hold the choice back.
		const known = parent ? catalog.get(parent) : undefined;
		const parentOn = !parent || (stored[parent] ?? (known ? defaultOf(known, stored) : !catalog.has(parent)));
		return stored[legacy] && parentOn;
	}
	return undefined;
}

/**
 * Each feature's own switch: its stored choice, else its legacy ids' choice
 * (FeatureDef.replaces), else its default (`legacyDefault` until the map
 * records the 0.36.0 defaults). A part keeps its own switch while its module
 * is off, so it comes back as it was when the module is turned on again. The
 * Features page shows the switches from this (features/list, features/save).
 */
export function featureChoices(stored: FeatureMap | null | undefined): FeatureMap {
	const out: FeatureMap = {};
	for (const def of catalog.values()) out[def.id] = stored?.[def.id] ?? legacyChoice(stored, def) ?? defaultOf(def, stored);
	return out;
}

/**
 * The switches as they apply: each feature's own switch (featureChoices),
 * with a sub-feature ("a.b") on only when its parent ("a") is on too.
 */
export function resolveFeatures(stored: FeatureMap | null | undefined): FeatureMap {
	const out = featureChoices(stored);
	for (const id of Object.keys(out)) {
		const parent = parentOf(id);
		if (parent && parent in out && !out[parent]) out[id] = false;
	}
	return out;
}

export function isOn(features: FeatureMap, id: string): boolean {
	return features[id] ?? false;
}

// ── Plugin context (hooks, routes) ───────────────────────────────

interface SettingsCtx {
	settings: { get<T>(key: string): Promise<T | null | undefined> };
}

async function readStored(ctx: SettingsCtx): Promise<FeatureMap | null | undefined> {
	try {
		return await ctx.settings.get<FeatureMap>(FEATURES_SETTING);
	} catch (error) {
		// A page hook that can't read the switches adds nothing to the page: keep that page out of the edge cache.
		noteReadFailure("feature switches (plugin context)");
		throw error;
	}
}

export async function ctxFeatures(ctx: SettingsCtx): Promise<FeatureMap> {
	return remember(resolveFeatures(await readStored(ctx)));
}

/** For the Features page's routes: the switches as they apply, and each one's own switch (featureChoices), from one read. */
export async function ctxFeatureState(ctx: SettingsCtx): Promise<{ features: FeatureMap; choices: FeatureMap }> {
	const stored = await readStored(ctx);
	return { features: remember(resolveFeatures(stored)), choices: featureChoices(stored) };
}

/**
 * The stored switches with the 0.36.0 defaults recorded (DEFAULTS_RECORDED
 * set). For an `existing` site, every feature with a legacyDefault that has
 * no stored or legacy choice gets its legacyDefault stored, so it stays as it
 * was; a new site takes the new defaults. A map that already records them
 * comes back as it is.
 */
export function withRecordedDefaults(stored: FeatureMap | null | undefined, existing: boolean): FeatureMap {
	if (stored?.[DEFAULTS_RECORDED] === true) return stored;
	const next: FeatureMap = { ...(stored ?? {}) };
	if (existing) {
		for (const def of catalog.values()) {
			if (def.legacyDefault === undefined || typeof next[def.id] === "boolean" || legacyChoice(next, def) !== undefined) continue;
			next[def.id] = def.legacyDefault;
		}
	}
	next[DEFAULTS_RECORDED] = true;
	return next;
}

interface DefaultsCtx {
	settings: {
		getVersioned<T>(key: string): Promise<{ value: T; revision: string } | null>;
		compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: boolean }>;
	};
	kv: {
		list(prefix?: string): Promise<Array<{ key: string }>>;
		get<T>(key: string): Promise<T | null>;
		set(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<boolean>;
	};
	storage?: Record<string, { count(): Promise<number> } | undefined>;
}

/**
 * Left by plugin:install until the defaults are recorded, so a fresh install
 * whose recording failed there is still recorded as one later (a KV row, and
 * a flag in this isolate for when that write failed too).
 */
export const FRESH_INSTALL_KEY = "state:freshInstall";
let freshInstall = false;

/**
 * KV rows the pack writes by itself on any site, whether or not anyone has
 * used a feature: they don't make a site "existing". The fresh-install flag;
 * the deployed version the page cache middleware records on the first request
 * (src/pageCache/lib.ts VERSION_OPTION) and its warming progress
 * (src/pageCache/warm.ts WARM_STATE_OPTION); Discovery's IndexNow clean-up
 * marker (src/discovery/module.ts RETIRED_MARKER, set in plugin:activate; remove it here in 0.38.0,
 * with retireIndexNow).
 */
export const HOUSEKEEPING_KEYS: ReadonlySet<string> = new Set([FRESH_INSTALL_KEY, "pageCache:version", "pageCache:warmState", "state:discovery:indexnowRetired"]);

/**
 * Anything the pack has stored on this site: a plugin setting or KV row
 * (EmDash's options table, where the switches, the settings generation and
 * every module's settings live) other than its housekeeping rows, or a
 * document in one of its storage collections. A read that fails counts as yes.
 */
async function hasPackState(ctx: DefaultsCtx): Promise<boolean> {
	try {
		if ((await ctx.kv.list()).some((row) => !HOUSEKEEPING_KEYS.has(row.key))) return true;
		for (const collection of Object.values(ctx.storage ?? {})) if (collection && (await collection.count()) > 0) return true;
		return false;
	} catch {
		return true;
	}
}

/**
 * One time per site: record the 0.36.0 defaults in the stored switches
 * (withRecordedDefaults), so an existing site keeps Redirect Manager, Slug
 * changes and Backups as they were while new sites start with them off.
 *
 * A site counts as new only after a fresh install (`fresh`: plugin:install,
 * which EmDash runs once, when it first records the plugin on a site; or the
 * flag it leaves, FRESH_INSTALL_KEY, when recording failed there) and while
 * the pack has nothing stored there but its housekeeping rows. Every other
 * call (plugin:activate, the Features page, a save of the switches) and any
 * doubt (stored switches, any pack setting or data, a read that fails) count
 * as an existing site. Writes only if the switches didn't change meanwhile
 * (compare-and-set); a save of the switches records them itself. Returns
 * true when the map records them now.
 */
export async function recordDefaults(ctx: DefaultsCtx, options: { fresh?: boolean } = {}): Promise<boolean> {
	if (options.fresh) {
		freshInstall = true;
		// Before anything that can fail: a later call retries as a fresh install.
		await ctx.kv.set(FRESH_INSTALL_KEY, true).catch(() => undefined);
	}
	const current = await ctx.settings.getVersioned<FeatureMap>(FEATURES_SETTING);
	const stored = current?.value ?? null;
	if (stored?.[DEFAULTS_RECORDED] === true) {
		await forgetFreshInstall(ctx);
		return true;
	}
	const fresh = options.fresh || freshInstall || (await ctx.kv.get<boolean>(FRESH_INSTALL_KEY).catch(() => null)) === true;
	const existing = !fresh || stored !== null || (await hasPackState(ctx));
	const { applied } = await ctx.settings.compareAndSet(FEATURES_SETTING, current?.revision ?? null, withRecordedDefaults(stored, existing));
	if (applied) {
		invalidateFeatures();
		await forgetFreshInstall(ctx);
	}
	return applied;
}

async function forgetFreshInstall(ctx: DefaultsCtx): Promise<void> {
	freshInstall = false;
	await ctx.kv.delete(FRESH_INSTALL_KEY).catch(() => undefined);
}

/** Tests: forget this isolate's fresh-install flag. */
export function resetFreshInstallForTests(): void {
	freshInstall = false;
}

/** The switches most recently read in this isolate (null before the first read). */
let lastKnown: FeatureMap | null = null;
function remember(features: FeatureMap): FeatureMap {
	lastKnown = features;
	return features;
}

/**
 * Synchronous view of the switches, for EmDash's admin manifest (sidebar
 * pages and dashboard widgets), which reads the plugin's page list on every
 * admin request. The pack middleware reads the switches before EmDash's
 * routes run, so this is current; before any read it returns null.
 */
export function knownFeatures(): FeatureMap | null {
	return lastKnown;
}

/**
 * Like ctxFeatures, but shares the per-isolate cache with siteFeatures so
 * hooks that run on every page view (page:metadata, page:fragments) don't
 * add a settings read to each render.
 */
export async function cachedCtxFeatures(ctx: SettingsCtx): Promise<FeatureMap> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.features;
	const started = generation;
	const features = await ctxFeatures(ctx);
	// Same guard as queryOptions: a save in this isolate while this read ran (invalidateFeatures) makes it stale.
	if (generation === started) cached = { features, at: Date.now() };
	return features;
}

/** For public routes: like requireFeature, but from the per-isolate cache (no settings read on most requests). */
export async function requireCachedFeature(ctx: SettingsCtx, id: string): Promise<void> {
	if (!isOn(await cachedCtxFeatures(ctx), id)) {
		const { PluginRouteError } = await import("emdash");
		throw PluginRouteError.notFound("This feature is turned off (Coywolf Pack → Features).");
	}
}

// ── Outside the plugin context (middleware, Astro components) ────

/** How long this isolate trusts its read of the switches, settings and generation. */
export const FEATURES_TTL_MS = 5 * 60_000;
const TTL_MS = FEATURES_TTL_MS;
/**
 * `settings` is set when the read came from D1 (siteFeatures), which also
 * reads the registered settings; `keys` are the settings that read asked for;
 * `options` are the raw values of the registered option rows (registerSiteOption).
 */
let cached: { features: FeatureMap; at: number; settings?: Map<string, unknown>; keys?: Set<string>; options?: Map<string, string> } | null = null;
/**
 * A D1 read in progress: concurrent cache misses in this isolate share it,
 * for a bounded time (src/core/single-flight.ts: a read whose request was
 * canceled would otherwise hang every later request of the isolate).
 */
const reading = sharedSlot<SiteOptions>();
/** Bumped by invalidateFeatures, so a read that started before a save isn't cached. */
let generation = 0;

/**
 * Bumped whenever settings may have changed: a save in this isolate
 * (invalidateFeatures) or a new settings generation seen in D1 (a save in
 * another isolate). Per-isolate caches of settings-derived data store the
 * epoch they were read at and are dropped when it moves (isCurrent).
 */
let epoch = 0;
export function settingsEpoch(): number {
	return epoch;
}

/** A per-isolate cache entry is usable while the settings epoch hasn't moved and it's younger than `maxAgeMs`. */
export function isCurrent(entry: { epoch: number; at: number } | null | undefined, maxAgeMs: number): boolean {
	return Boolean(entry && entry.epoch === epoch && Date.now() - entry.at < maxAgeMs);
}

/**
 * Settings read on most page renders, registered up front so the first read
 * of an isolate already includes them (a key registered after that read costs
 * a second query). Modules still call registerSiteSetting for their own keys.
 */
const PRELOADED_SETTINGS = [
	// Content blocks, Headings, Breadcrumbs (+ its legacy key), Code blocks, Reviews.
	"contentBlocks",
	"customBlocksPodcast",
	"headings",
	"breadcrumbs",
	"codeBlocksTheme",
	"reviewsStyle",
	// Clean image URLs, Page cache, Search, Videos posters.
	"imagesMediaHost",
	"pageCacheMaxAgeDays",
	"pageCacheRefreshDays",
	"pageCacheWarm",
	"searchVersion",
	"videosMirroredPosters",
	// Coywolf Files.
	"filesBase",
	"filesPublicBaseUrl",
	"filesScheme",
	"filesAccent",
	// Schema & Social (src/schema/module.ts schemaSettingsSchema).
	"schemaSearchUrl",
	"schemaAuthorUrlPattern",
	"schemaBreadcrumbHome",
	"schemaRobotsMaxImage",
	"schemaRobotsMaxSnippet",
	"schemaRobotsMaxVideo",
	"schemaRobotsNofollow",
	"schemaOgLocale",
	// Videos player settings (src/videos/store.ts publicConfig).
	"videosCustomerSubdomain",
	"videosAccentColor",
	"videosBackgroundColor",
	"videosLightEmbed",
	"videosDisplay",
	// Discovery.
	"discoverySettings",
];

/**
 * Other plugin settings read in the same query as the switches, sharing
 * their per-isolate cache, so middleware, page hooks and Astro renderers that
 * need them on every request add no query (e.g. the search content version,
 * the code block theme, the review style).
 */
const siteSettingKeys = new Set<string>(PRELOADED_SETTINGS);
export function registerSiteSetting(key: string): void {
	siteSettingKeys.add(key);
}

/** Whole option rows (not plugin settings) read in the same query, raw (see siteOption). */
const siteOptionNames = new Set<string>();
export function registerSiteOption(name: string): void {
	siteOptionNames.add(name);
}

const settingOption = (key: string) => `plugin:${PLUGIN_ID}:settings:${key}`;

/** Forget cached switches and registered settings (call after saving them). */
export function invalidateFeatures(): void {
	cached = null;
	reading.flight = null;
	generation++;
	epoch++;
}

/** The option row last read for the settings generation, to notice saves made in other isolates. */
let lastGeneration: string | null | undefined;
/** Name of the settings-generation row (written by src/core/generation.ts). */
export const GENERATION_OPTION = `plugin:${PLUGIN_ID}:state:settingsGeneration`;
registerSiteOption(GENERATION_OPTION);

/**
 * Read the switches straight from D1. Fails closed (all off) if the database
 * can't be read, and notes the failure (src/core/read-failures.ts), so the
 * page rendered with them isn't edge-cached.
 */
export async function siteFeatures(database = "DB", fresh = false): Promise<FeatureMap> {
	if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.features;
	return (await readSiteOptions(database)).features;
}

/** A D1 binding name, or the binding itself (for callers that already have it). */
type Database = string | D1Database;

interface SiteOptions {
	features: FeatureMap;
	settings: Map<string, unknown>;
	/** The registered settings this read asked for. */
	keys: Set<string>;
	/** False when D1 couldn't be read (features are then all off and settings empty; each caller notes it, see readSiteOptions). */
	ok: boolean;
}

/**
 * The switches and registered settings from D1, one read shared by the
 * isolate's concurrent cache misses. The read is anchored with waitUntil, so
 * a request that answers before it's done (or is left by its client) still
 * finishes it; a caller never waits for another request's read longer than
 * DEADLINES.sharedWaitMs, then reads itself. Every D1 read has its own
 * deadline too (src/core/d1-batch.ts), so a read that can't finish fails
 * closed (ok: false) instead of hanging.
 */
function readSiteOptions(database: Database): Promise<SiteOptions> {
	return sharedRead(reading, () => queryOptions(database), { anchor: afterResponse, label: "the feature switches and settings" }).then((read) => {
		// Noted for each caller handed a failed read (concurrent requests share one), not once per query.
		if (!read.ok) noteReadFailure("feature switches and settings");
		return read;
	});
}

async function queryOptions(database: Database): Promise<SiteOptions> {
	let stored: FeatureMap | null = null;
	const settings = new Map<string, unknown>();
	const options = new Map<string, string>();
	const keys = new Set(siteSettingKeys);
	const optionNames = new Set(siteOptionNames);
	const started = generation;
	try {
		const db = typeof database === "string" ? ((await workerEnv())[database] as D1Database | undefined) : database;
		const names = [OPTION_NAME, ...[...keys].map(settingOption), ...optionNames];
		// With the pack's other reads of this tick (the request's redirect lookup): one D1 batch.
		const rows = db
			? await batchedAll<{ name: string; value: string }>(db, db.prepare(`SELECT name, value FROM options WHERE name IN (${names.map(() => "?").join(",")})`).bind(...names))
			: [];
		for (const row of rows) {
			if (!row.value) continue;
			if (optionNames.has(row.name)) options.set(row.name, row.value);
			else if (row.name === OPTION_NAME) stored = JSON.parse(row.value) as FeatureMap;
			else {
				try {
					settings.set(row.name.slice(settingOption("").length), JSON.parse(row.value));
				} catch {
					// An unreadable setting reads as unset.
				}
			}
		}
	} catch (error) {
		console.error("coywolf-pack: could not read feature switches", error);
		return { features: resolveFeatures({}), settings, keys, ok: false };
	}
	const features = remember(resolveFeatures(stored));
	// A save in another isolate since the last read: drop this isolate's settings-derived caches.
	const seen = options.get(GENERATION_OPTION) ?? null;
	if (lastGeneration !== undefined && seen !== lastGeneration && savedGeneration(seen) !== savedGeneration(lastGeneration)) epoch++;
	lastGeneration = seen;
	// A save in this isolate while the query ran (invalidateFeatures) makes this read stale: don't cache it.
	if (generation === started) cached = { features, at: Date.now(), settings, keys, options };
	return { features, settings, keys, ok: true };
}

/** The generation id in a settings-generation row ("settled" changes don't count as a new save). */
function savedGeneration(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as { id?: unknown };
		return typeof value?.id === "string" ? value.id : raw;
	} catch {
		return raw;
	}
}

/**
 * A registered option row (registerSiteOption) from the last read of this
 * isolate, raw. Undefined when there's no current read with it (call
 * siteFeatures first); null when the row doesn't exist.
 */
export function siteOption(name: string): string | null | undefined {
	if (!cached?.options || Date.now() - cached.at >= TTL_MS) return undefined;
	return cached.options.get(name) ?? null;
}

/** Update a registered option row in this isolate's cache after writing it. */
export function rememberSiteOption(name: string, raw: string | null): void {
	if (!cached?.options) return;
	if (raw === null) cached.options.delete(name);
	else cached.options.set(name, raw);
	if (name === GENERATION_OPTION) lastGeneration = raw;
}

/**
 * The registered settings from the per-isolate cache, or a fresh read when
 * the cache is old or was read before `key` was registered (a module imported
 * after the first read of this isolate). Null when D1 can't be read (a noted
 * read failure, see src/core/read-failures.ts).
 */
async function siteSettings(key: string, database: Database): Promise<Map<string, unknown> | null> {
	registerSiteSetting(key);
	if (cached?.settings && cached.keys?.has(key) && Date.now() - cached.at < TTL_MS) return cached.settings;
	let read = await readSiteOptions(database);
	// A read that was already in flight may have been started before `key` was registered.
	if (read.ok && !read.keys.has(key)) read = await readSiteOptions(database);
	return read.ok ? read.settings : null;
}

/** A setting registered with registerSiteSetting, from the switches' per-isolate cache (null when unset). */
export async function siteSetting<T>(key: string, database = "DB"): Promise<T | null> {
	return (((await siteSettings(key, database))?.get(key) as T | undefined) ?? null);
}

/**
 * Like siteSetting, but tells an unset setting (`{ value: null }`) from one
 * that couldn't be read (null), for callers that keep their last value or
 * skip caching a default when D1 is unavailable.
 */
export async function readSiteSetting<T = unknown>(key: string, database: Database = "DB"): Promise<{ value: T | null } | null> {
	const settings = await siteSettings(key, database);
	return settings ? { value: (settings.get(key) as T | undefined) ?? null } : null;
}

/**
 * A registered setting as this isolate last read it, synchronously (undefined before any read),
 * for EmDash's admin manifest like knownFeatures. The middleware reads the settings afresh for
 * every manifest request, so it's current there.
 */
export function knownSiteSetting<T>(key: string): T | null | undefined {
	if (!cached?.keys?.has(key)) return undefined;
	return (cached.settings?.get(key) as T | undefined) ?? null;
}

/** Update a registered setting in this isolate's cache after writing it (other isolates see it within FEATURES_TTL_MS). */
export function rememberSiteSetting(key: string, value: unknown): void {
	cached?.settings?.set(key, value);
}

export async function siteFeatureOn(id: string, database?: string): Promise<boolean> {
	return isOn(await siteFeatures(database), id);
}

/** For routes: answer 404 when the feature is off, so a disabled module looks absent. */
export async function requireFeature(ctx: SettingsCtx, id: string): Promise<void> {
	if (!isOn(await ctxFeatures(ctx), id)) {
		const { PluginRouteError } = await import("emdash");
		throw PluginRouteError.notFound("This feature is turned off (Coywolf Pack → Features).");
	}
}

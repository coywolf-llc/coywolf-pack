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
import { workerEnv } from "../shared.js";
import { batchedAll } from "./d1-batch.js";
import { noteReadFailure } from "./read-failures.js";

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
		const parentOn = !parent || (stored[parent] ?? (catalog.has(parent) ? (catalog.get(parent)?.default ?? false) : true));
		return stored[legacy] && parentOn;
	}
	return undefined;
}

/**
 * Stored choices over catalog defaults. A feature with no stored choice
 * takes its legacy ids' choice (FeatureDef.replaces), then its default. A
 * sub-feature ("a.b") is on only when its parent ("a") is on too.
 */
export function resolveFeatures(stored: FeatureMap | null | undefined): FeatureMap {
	const out: FeatureMap = {};
	for (const def of catalog.values()) out[def.id] = stored?.[def.id] ?? legacyChoice(stored, def) ?? def.default ?? false;
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

export async function ctxFeatures(ctx: SettingsCtx): Promise<FeatureMap> {
	let stored: FeatureMap | null | undefined;
	try {
		stored = await ctx.settings.get<FeatureMap>(FEATURES_SETTING);
	} catch (error) {
		// A page hook that can't read the switches adds nothing to the page: keep that page out of the edge cache.
		noteReadFailure("feature switches (plugin context)");
		throw error;
	}
	return remember(resolveFeatures(stored));
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
		throw PluginRouteError.notFound("This feature is turned off (Plugins → Coywolf Pack).");
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
/** A D1 read in progress: concurrent cache misses in this isolate share it. */
let reading: Promise<SiteOptions> | null = null;
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
	reading = null;
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

function readSiteOptions(database: Database): Promise<SiteOptions> {
	if (!reading) {
		const read = queryOptions(database).finally(() => {
			if (reading === read) reading = null;
		});
		reading = read;
	}
	// Noted for each caller handed a failed read (concurrent requests share one), not once per query.
	return reading.then((read) => {
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
		throw PluginRouteError.notFound("This feature is turned off (Plugins → Coywolf Pack).");
	}
}

/**
 * Schema & Social module: the page:metadata hook (JSON-LD @graph, robots
 * directives, Open Graph extras) and the routes behind the Schema admin page.
 *
 * Simple values are settings (settingsSchema); structured data lives in
 * plugin storage: schemaDocs ("site" = Site Details, "types" = per-collection
 * type defaults), schemaEntries (per-entry type overrides and main
 * subject, id "<collection>:<entry id>") and schemaAuthors (Person property
 * rows per byline id; a row may be marked profile-only).
 */
import { getManyBatched } from "../core/storage.js";
import { FORMATS, cdnOriginalUrl, imageCdn, parseCdnUrl, parseImagePath } from "../images/lib.js";
import { refreshMediaHost } from "../images/settings.js";
import { siteName } from "../core/site.js";
import type { PageMetadataContribution, PluginContext, PublicPageContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { absoluteUrl, entryUrl } from "../core/content-url.js";
import {
	type FeatureMap,
	cachedCtxFeatures,
	ctxFeatures,
	invalidateFeatures,
	isCurrent,
	isOn,
	readSiteSetting,
	registerSiteSetting,
	requireFeature,
	settingsEpoch,
} from "../core/features.js";
import { batchedFirst } from "../core/d1-batch.js";
import { readEntryDocs } from "../core/entry-docs.js";
import { noteReadFailure, readFailures } from "../core/read-failures.js";
import { requestMemo, requestStore } from "../core/request-memo.js";
import { parseInput, workerEnv } from "../shared.js";
import { type MediaRow, cleanDefaultOgImage, mediaHostImageInfo, ogImageTags, ownImageOnMediaHost, packOwnsOgImage } from "./og-image.js";
import { ARTICLE_TYPES, ORGANIZATION_PROPERTIES, ORGANIZATION_TYPES, PAGE_TYPES, PERSON_PROPERTIES, PROPERTY_INPUTS } from "./catalog.js";
import {
	type BylineFacts,
	CUSTOM_KEY,
	HOME_KEY,
	type ImageInfo,
	type MainSubject,
	type Node,
	type PropertyRow,
	type SiteDetails,
	type TypeChoice,
	type TypeMap,
	absolute,
	authorId,
	authorPath,
	breadcrumbDocument,
	buildGraph,
	enrichImageObjects,
	mainSubjectByline,
	mediaRefFromUrl,
	ogLocale,
	originOf,
	pageUrl,
	parseLimit,
	personNode,
	publisherNode,
	resolveTypes,
	robotsContent,
	attachVideos,
	themeVideoNode,
} from "./graph.js";

export interface SchemaOptions {
	/** D1 binding of the site database (for media dimension lookups). Default "DB". */
	database?: string;
}

export const SCHEMA_FEATURES = {
	main: "schema",
	graph: "schema.graph",
	breadcrumbs: "schema.breadcrumbs",
	robots: "schema.robots",
	openGraph: "schema.openGraph",
	authors: "schema.authors",
} as const;

export const schemaSettingsSchema = {
	schemaSearchUrl: {
		type: "string",
		label: "Schema: search URL template",
		description: "Adds a SearchAction to the WebSite node. Use {search_term_string} for the query. Leave empty for none.",
		default: "/?s={search_term_string}",
	},
	schemaAuthorUrlPattern: {
		type: "string",
		label: "Schema: author page URL",
		description:
			"Your site's author page URL, e.g. /author/{slug}/ ({slug} is the byline slug). Used for an author's url and @id when the byline has no website. Leave empty if the site has no author pages.",
		default: "",
	},
	schemaBreadcrumbHome: {
		type: "string",
		label: "Schema: breadcrumb home label",
		description: "First crumb of breadcrumb trails derived from the URL path.",
		default: "Home",
	},
	schemaRobotsMaxImage: {
		type: "select",
		label: "Robots: max-image-preview",
		options: [
			{ value: "large", label: "Large" },
			{ value: "standard", label: "Standard" },
			{ value: "none", label: "None" },
			{ value: "", label: "Don't set" },
		],
		default: "large",
	},
	schemaRobotsMaxSnippet: {
		type: "number",
		label: "Robots: max-snippet",
		description: "Characters; -1 for no limit.",
		default: -1,
		min: -1,
	},
	schemaRobotsMaxVideo: {
		type: "number",
		label: "Robots: max-video-preview",
		description: "Seconds; -1 for no limit.",
		default: -1,
		min: -1,
	},
	schemaRobotsNofollow: {
		type: "boolean",
		label: "Robots: nofollow every page",
		default: false,
	},
	schemaOgLocale: {
		type: "string",
		label: "Open Graph: og:locale",
		description: "For example en_US. Leave empty to derive it from the site locale.",
		default: "",
	},
} as const;

type SettingKey = keyof typeof schemaSettingsSchema;
// Read with the feature switches (one query for all of them, cached per isolate).
for (const key of Object.keys(schemaSettingsSchema)) registerSiteSetting(key);
type SimpleSettings = { [K in SettingKey]: (typeof schemaSettingsSchema)[K]["default"] extends number ? number : (typeof schemaSettingsSchema)[K]["default"] extends boolean ? boolean : string };

export const schemaStorage = {
	schemaDocs: { indexes: [] as string[] },
	schemaEntries: { indexes: ["collection"] },
	schemaAuthors: { indexes: [] as string[] },
};

interface EntryOverride extends TypeChoice {
	collection: string;
	entryId: string;
	title?: string;
	/** What the entry is about: a byline (Person) or the site publisher. */
	mainSubject?: MainSubject;
	updatedAt?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: storage collections are untyped at this layer.
type Coll = any;
const docs = (ctx: PluginContext): Coll => (ctx.storage as Record<string, Coll>).schemaDocs;
const entries = (ctx: PluginContext): Coll => (ctx.storage as Record<string, Coll>).schemaEntries;
const authorsStore = (ctx: PluginContext): Coll => (ctx.storage as Record<string, Coll>).schemaAuthors;

// ── Config (cached per isolate) ──────────────────────────────────

interface Config {
	settings: SimpleSettings;
	site: SiteDetails;
	types: TypeMap;
	/** The publisher Person's byline and rows, when Site Details say "person". */
	person: { byline: BylineFacts | null; rows: PropertyRow[] | null } | null;
	/** Every byline's saved Person rows, by byline id; null when there are too many to keep (read per page then). */
	authors: Map<string, { rows: PropertyRow[] }> | null;
}

/**
 * Kept until a pack settings save (here, or in another isolate: settingsEpoch)
 * or ten minutes, whichever comes first. Byline profile edits (made in
 * EmDash, not here) show up within the ten minutes.
 */
const CONFIG_TTL_MS = 10 * 60_000;
/** Saved author rows kept in the config; more than this and they're read per page instead. */
const MAX_CACHED_AUTHORS = 500;
let configCache: { at: number; epoch: number; config: Config } | null = null;

export function invalidateSchemaConfig(): void {
	configCache = null;
}

const DEFAULT_SITE: SiteDetails = { publisherType: "organization", personBylineId: null, orgRows: [] };

async function readSettings(ctx: PluginContext, database?: string, fresh = false): Promise<SimpleSettings> {
	const keys = Object.keys(schemaSettingsSchema) as SettingKey[];
	// From the feature switches' query (usually already cached); else (and for the admin) one read for every schema* setting (they share the prefix).
	const reads = fresh ? [] : await Promise.all(keys.map((k) => readSiteSetting(k, database ?? "DB").catch(() => null)));
	const stored = !fresh && reads.every(Boolean)
		? new Map(keys.map((k, i) => [k as string, reads[i]?.value ?? undefined]))
		: new Map((await ctx.settings.list("schema")).map((e) => [e.key, e.value]));
	const out: Record<string, unknown> = {};
	for (const k of keys) out[k] = stored.get(k) ?? schemaSettingsSchema[k].default;
	return out as SimpleSettings;
}

/** Every saved author row (one query), or null when there are more than MAX_CACHED_AUTHORS. */
async function readAllAuthors(ctx: PluginContext): Promise<Map<string, { rows: PropertyRow[] }> | null> {
	const out = new Map<string, { rows: PropertyRow[] }>();
	let cursor: string | undefined;
	for (let page = 0; page * 100 < MAX_CACHED_AUTHORS; page++) {
		const result = await authorsStore(ctx).query({ limit: 100, ...(cursor ? { cursor } : {}) });
		for (const item of result.items as Array<{ id: string; data: { rows: PropertyRow[] } }>) out.set(item.id, item.data);
		if (!result.hasMore || !result.cursor) return out;
		cursor = result.cursor;
	}
	return null;
}

/** A read that may fail on a page: null instead (a missing byline or media item is null too), and the failure noted (src/core/read-failures.ts). */
const orNull = <T,>(read: Promise<T> | undefined): Promise<T | null> =>
	read
		? read.catch(() => {
				noteReadFailure("schema: bylines or media");
				return null;
			})
		: Promise.resolve(null);

async function bylineFacts(ctx: PluginContext, id: string): Promise<BylineFacts | null> {
	const byline = await orNull(ctx.bylines?.get(id));
	if (!byline) return null;
	let avatarUrl: string | null = null;
	if (byline.avatarMediaId) avatarUrl = (await orNull(ctx.media?.get(byline.avatarMediaId)))?.url ?? null;
	return { id: byline.id, slug: byline.slug, displayName: byline.displayName, bio: byline.bio, websiteUrl: byline.websiteUrl, avatarUrl };
}

/** The module's settings and docs (cached per isolate). `fresh`: read them now (admin pages). */
async function loadConfig(ctx: PluginContext, database?: string, fresh = false): Promise<Config> {
	if (!fresh && configCache && isCurrent(configCache, CONFIG_TTL_MS)) return configCache.config;
	const epoch = settingsEpoch();
	const failures = readFailures();
	const [settings, stored, authors] = await Promise.all([
		readSettings(ctx, database, fresh),
		docs(ctx).getMany(["site", "types"]) as Promise<Map<string, unknown>>,
		authorsStore(ctx)?.query ? orNull(readAllAuthors(ctx)) : null,
	]);
	const site = { ...DEFAULT_SITE, ...((stored.get("site") as SiteDetails | undefined) ?? {}) };
	const types = (stored.get("types") as TypeMap | undefined) ?? {};
	let person: Config["person"] = null;
	if (site.publisherType === "person" && site.personBylineId) {
		const [byline, rows] = await Promise.all([
			bylineFacts(ctx, site.personBylineId),
			authors ? authors.get(site.personBylineId) : (authorsStore(ctx).get(site.personBylineId) as Promise<{ rows: PropertyRow[] } | null>),
		]);
		person = { byline, rows: rows?.rows ?? null };
	}
	const config = { settings, site, types, person, authors };
	// A save while this read ran (the epoch moved) leaves it uncached, and so does a failed read (a missing byline
	// would make the publisher a bare Organization on every page for the cache's lifetime).
	if (epoch === settingsEpoch() && readFailures() === failures) configCache = { at: Date.now(), epoch, config };
	return config;
}

/** Saved Person rows for these bylines: from the config when it holds them all, else one read. */
async function authorRows(ctx: PluginContext, config: Config, ids: string[]): Promise<Map<string, { rows: PropertyRow[] }>> {
	if (config.authors) return new Map(ids.flatMap((id) => (config.authors?.has(id) ? [[id, config.authors.get(id) as { rows: PropertyRow[] }]] : [])));
	return getManyBatched(authorsStore(ctx), ids);
}

// ── Media lookups (dimensions and alt, cached per isolate) ───────

const MEDIA_TTL_MS = 10 * 60_000;
const MEDIA_MAX = 500;
const mediaCache = new Map<string, { at: number; info: ImageInfo | null }>();
/** Media rows by storage key, for media-host URLs (any size of a file shares its row). */
const mediaRowCache = new Map<string, { at: number; row: MediaRow | null }>();

/**
 * A clean image URL (Clean image URLs module): on the media host
 * (https://media.example.com/<file> or /s/<w>[x<h>]/<file>) or the Worker
 * route (/media/<file id>-<w>x<h>.<format>). The media item, at the requested
 * dimensions. Undefined when it's neither.
 */
async function lookupCleanMedia(options: SchemaOptions, url: string, origin: string): Promise<ImageInfo | null | undefined> {
	const onHost = parseCdnUrl(url);
	if (onHost) {
		const key = `${onHost.id}.${onHost.ext}`;
		const hit = mediaRowCache.get(key);
		if (hit && Date.now() - hit.at < MEDIA_TTL_MS) return hit.row ? mediaHostImageInfo(url, hit.row) : null;
		let row: MediaRow | null = null;
		try {
			const env = await workerEnv();
			const db = env[options.database ?? "DB"] as D1Database | undefined;
			// With the page's other pack reads of this tick (one D1 batch).
			row = db ? await batchedFirst<MediaRow>(db, db.prepare("SELECT width, height, alt, mime_type FROM media WHERE storage_key = ? LIMIT 1").bind(key)) : null;
		} catch {
			noteReadFailure("schema: media details");
			return null; // Don't cache failures.
		}
		if (mediaRowCache.size >= MEDIA_MAX) mediaRowCache.delete(mediaRowCache.keys().next().value as string);
		mediaRowCache.set(key, { at: Date.now(), row });
		return row ? mediaHostImageInfo(url, row) : null;
	}
	let pathname: string;
	try {
		const parsed = new URL(url, origin || "https://site.invalid");
		if (origin && /^https?:/i.test(url) && parsed.origin !== new URL(origin).origin) return undefined;
		pathname = parsed.pathname;
	} catch {
		return undefined;
	}
	const clean = parseImagePath(pathname);
	if (!clean) return undefined;
	try {
		const env = await workerEnv();
		const db = env[options.database ?? "DB"] as D1Database | undefined;
		const row = db
			? await batchedFirst<{ width: number | null; height: number | null; alt: string | null }>(
					db,
					db.prepare("SELECT width, height, alt FROM media WHERE storage_key LIKE ? LIMIT 1").bind(`${clean.id}.%`),
				)
			: null;
		if (!row) return null;
		const height = clean.height ?? (row.width && row.height ? Math.round((clean.width * row.height) / row.width) : null);
		return { url, width: clean.width, height, alt: row.alt, mimeType: FORMATS[clean.format] };
	} catch {
		return null;
	}
}

async function lookupMedia(options: SchemaOptions, url: string, origin: string): Promise<ImageInfo | null> {
	const cleanInfo = await lookupCleanMedia(options, url, origin);
	if (cleanInfo !== undefined) return cleanInfo;
	const ref = mediaRefFromUrl(url, origin);
	if (!ref) return null;
	const cacheKey = `${ref.by}:${ref.value}`;
	const hit = mediaCache.get(cacheKey);
	if (hit && Date.now() - hit.at < MEDIA_TTL_MS) return hit.info ? { ...hit.info, url } : null;
	let info: ImageInfo | null = null;
	try {
		const env = await workerEnv();
		const db = env[options.database ?? "DB"] as D1Database | undefined;
		const row = db
			? await batchedFirst<{ width: number | null; height: number | null; alt: string | null; mime_type: string | null }>(
					db,
					db.prepare(`SELECT width, height, alt, mime_type FROM media WHERE ${ref.by === "id" ? "id" : "storage_key"} = ? LIMIT 1`).bind(ref.value),
				)
			: null;
		if (row) info = { url, width: row.width, height: row.height, alt: row.alt, mimeType: row.mime_type };
	} catch {
		noteReadFailure("schema: media details");
		return null; // Don't cache failures.
	}
	if (mediaCache.size >= MEDIA_MAX) mediaCache.delete(mediaCache.keys().next().value as string);
	mediaCache.set(cacheKey, { at: Date.now(), info });
	return info;
}

// ── page:metadata ────────────────────────────────────────────────

interface SiteFacts {
	origin: string;
	siteName: string;
	tagline: string | null;
	logo: ImageInfo | null;
	defaultOgImage: ImageInfo | null;
}

async function siteFacts(ctx: PluginContext, page: PublicPageContext): Promise<SiteFacts> {
	// biome-ignore lint/suspicious/noExplicitAny: SiteSettings is request-cached by EmDash; read loosely.
	let settings: any = {};
	try {
		const { getSiteSettings } = await import("emdash");
		settings = await getSiteSettings();
	} catch {
		// Outside a request context (or no database): fall back to the plugin context. Inside one it's a failed read.
		if (requestStore()) noteReadFailure("schema: site settings");
	}
	const base = page.siteUrl || settings.url || ctx.site.url || (URL.canParse(page.url) ? new URL(page.url).origin : "");
	const origin = originOf(base);
	const ref = (m: { url?: string; width?: number; height?: number; alt?: string } | undefined): ImageInfo | null =>
		m?.url ? { url: absolute(m.url, origin) ?? m.url, width: m.width, height: m.height, alt: m.alt } : null;
	return {
		origin,
		siteName: page.siteName || settings.title || ctx.site.name,
		tagline: settings.tagline || null,
		logo: ref(settings.logo),
		defaultOgImage: ref(settings.seo?.defaultOgImage),
	};
}

/**
 * The page's og:image (same precedence as core). With Clean image URLs on:
 * the default image at a clean 1200x630 URL, and the page's own
 * media-library image as its original on the media host (when one is set).
 */
async function primaryImage(options: SchemaOptions, page: PublicPageContext, site: SiteFacts, cleanUrls = false): Promise<ImageInfo | null> {
	const own = page.seo?.ogImage || page.image;
	if (!own) return cleanUrls ? (cleanDefaultOgImage(site.defaultOgImage, site.origin) ?? site.defaultOgImage) : site.defaultOgImage;
	const original = cleanUrls ? ownImageOnMediaHost(own) : null;
	if (original) return (await lookupMedia(options, original, site.origin)) ?? { url: original };
	const url = absolute(own, site.origin) ?? own;
	return (await lookupMedia(options, own, site.origin)) ?? { url };
}

type EntryBylines = Awaited<ReturnType<NonNullable<PluginContext["bylines"]>["getEntriesBylines"]>>;
type Credit = EntryBylines[number]["bylines"][number];

/**
 * What the theme already loaded for the page's entry and passes through the
 * page context, so the pack doesn't read it again:
 * - `page.coywolf.entry`: the entry from getEmDashEntry() (its `data` has
 *   the fields and, hydrated by EmDash, `bylines`);
 * - `page.coywolf.bylines`: just the credits (entry.data.bylines).
 * An entry whose data.id isn't the page's content id is ignored.
 */
export function themedEntry(page: PublicPageContext): { data?: Record<string, unknown>; bylines?: Credit[] } {
	const coywolf = (page as PublicPageContext & { coywolf?: { entry?: unknown; bylines?: unknown } }).coywolf;
	if (!coywolf || !page.content) return {};
	const entry = coywolf.entry as { data?: unknown } | undefined;
	const data = entry?.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : undefined;
	const sameEntry = data && (typeof data.id !== "string" || data.id === page.content.id);
	const credits = Array.isArray(coywolf.bylines) ? coywolf.bylines : sameEntry && Array.isArray(data?.bylines) ? data.bylines : undefined;
	const bylines = credits?.filter((c): c is Credit => Boolean(c && typeof c === "object" && (c as Credit).byline && typeof (c as Credit).byline.id === "string"));
	return { ...(sameEntry ? { data } : {}), ...(bylines ? { bylines } : {}) };
}

/** The entry's credited bylines (none without an entry, or on error): the theme's, else read. Started early, alongside the page's other reads. */
function entryBylines(ctx: PluginContext, page: PublicPageContext, themed?: Credit[]): Promise<EntryBylines> {
	if (!page.content) return Promise.resolve([]);
	if (themed) return Promise.resolve([{ entryId: page.content.id, bylines: themed }]);
	const bylines = ctx.bylines;
	if (!bylines) return Promise.resolve([]);
	const { collection, id } = page.content;
	// Once per request, however many times the hook runs for the page.
	return requestMemo(`coywolf-entry-bylines:${collection}:${id}`, async () => (await orNull(bylines.getEntriesBylines(collection, [id]))) ?? []);
}

async function authorNodes(ctx: PluginContext, credited: Promise<EntryBylines>, config: Config, site: SiteFacts, features: FeatureMap): Promise<Node[]> {
	const [credits] = await credited;
	const bylines = credits?.bylines.map((c) => c.byline) ?? [];
	if (!bylines.length) return [];
	const rowsById: Map<string, { rows: PropertyRow[] }> = isOn(features, SCHEMA_FEATURES.authors)
		? await authorRows(ctx, config, bylines.map((b) => b.id))
		: new Map();
	const nodes = await Promise.all(
		bylines.map(async (b) => {
			const rows = rowsById.get(b.id)?.rows ?? null;
			const hasImage = rows?.some((r) => r.prop === "image" && r.value);
			const avatarUrl = !hasImage && b.avatarMediaId ? ((await orNull(ctx.media?.get(b.avatarMediaId)))?.url ?? null) : null;
			const path = authorPath(config.settings.schemaAuthorUrlPattern, b.slug);
			const authorUrl = path ? absolute(path, site.origin) : null;
			return personNode({
				byline: { id: b.id, slug: b.slug, displayName: b.displayName, bio: b.bio, websiteUrl: b.websiteUrl, avatarUrl },
				rows,
				origin: site.origin,
				defaultId: authorId({
					bylineId: b.id,
					slug: b.slug,
					origin: site.origin,
					authorUrl,
					details: config.site,
					personRows: config.person?.rows,
				}),
				authorUrl,
			});
		}),
	);
	return nodes.filter((n): n is Node => n !== null);
}

/**
 * The Person for a byline chosen as a page's main subject: same @id as when
 * they're credited as an author, plus their profile-only properties. Null
 * when the byline no longer exists.
 */
async function mainSubjectPerson(ctx: PluginContext, bylineId: string, config: Config, site: SiteFacts, features: FeatureMap): Promise<Node | null> {
	const facts = await bylineFacts(ctx, bylineId);
	if (!facts) return null;
	const stored = isOn(features, SCHEMA_FEATURES.authors) ? ((await authorRows(ctx, config, [bylineId])).get(bylineId) ?? null) : null;
	const path = authorPath(config.settings.schemaAuthorUrlPattern, facts.slug);
	const authorUrl = path ? absolute(path, site.origin) : null;
	return personNode({
		byline: facts,
		rows: stored?.rows ?? null,
		origin: site.origin,
		defaultId: authorId({ bylineId, slug: facts.slug, origin: site.origin, authorUrl, details: config.site, personRows: config.person?.rows }),
		authorUrl,
		profile: true,
	});
}

/**
 * A change to the page's graph whose data was loaded ahead of time, so the
 * loads run alongside each other and the changes still apply in a fixed order.
 */
type GraphStep = (graph: { "@graph": Node[] }) => void;
const noStep: GraphStep = () => {};

/**
 * Load the page's videos; the step folds them into the graph (see
 * attachVideos). `embeds`: the entry's embed-index doc, already read with the
 * page's other docs. Errors are logged, never fatal.
 */
async function pageVideosStep(ctx: PluginContext, page: PublicPageContext, origin: string, on: FeatureMap, embeds?: Promise<unknown>): Promise<GraphStep> {
	const warn = (error: unknown) => ctx.log.warn("schema: could not attach videos", { error: String(error) });
	try {
		const videos: Node[] = [];
		if (isOn(on, "videos.schema")) {
			const [{ entryVideoObjects }, embedDoc] = await Promise.all([import("../videos/module.js"), embeds]);
			videos.push(...(await entryVideoObjects(ctx as never, page, embeds ? (embedDoc as never) : undefined)));
		}
		const themed = (page as PublicPageContext & { coywolf?: { videos?: unknown } }).coywolf?.videos;
		if (Array.isArray(themed)) for (const v of themed.slice(0, 50)) {
			const node = themeVideoNode(v, origin);
			if (node) videos.push(node);
		}
		return (graph) => {
			try {
				attachVideos(graph, videos);
			} catch (error) {
				warn(error);
			}
		};
	} catch (error) {
		warn(error);
		noteReadFailure("schema: videos");
		return noStep;
	}
}

/**
 * Load `about` / `mentions` from AI Enrichment; the step adds them to the
 * page's Article node (or its WebPage when there's no Article). Loaded lazily
 * so sites without the AI module don't pay for it.
 */
async function entitiesStep(ctx: PluginContext, content: { collection: string; id: string }, record?: Promise<unknown>): Promise<GraphStep> {
	const warn = (error: unknown) => ctx.log.warn("schema: could not attach AI entities", { error: String(error) });
	try {
		const [{ getEntryEntities }, preloaded] = await Promise.all([import("../ai/entities.js"), record]);
		const { about, mentions } = await getEntryEntities(ctx, content.collection, content.id, record ? { record: preloaded as never } : undefined);
		if (!about.length && !mentions.length) return noStep;
		return (graph) => {
			try {
				mergeEntities(graph, about, mentions);
			} catch (error) {
				warn(error);
			}
		};
	} catch (error) {
		warn(error);
		noteReadFailure("schema: AI entities");
		return noStep;
	}
}

function mergeEntities(graph: { "@graph": Node[] }, about: Record<string, unknown>[], mentions: Record<string, unknown>[]) {
	const nodes = (graph["@graph"] ?? []) as Record<string, unknown>[];
	const byId = (suffix: string) => nodes.find((n) => typeof n["@id"] === "string" && (n["@id"] as string).endsWith(suffix));
	const target = byId("#article") ?? byId("#webpage");
	if (!target) return;
	const merge = (key: "about" | "mentions", extra: Record<string, unknown>[]) => {
		if (!extra.length) return;
		const existing = target[key];
		const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
		const all = [...list, ...extra];
		target[key] = all.length === 1 ? all[0] : all;
	};
	merge("about", about);
	merge("mentions", mentions);
}

/**
 * Every contribution this module makes for a page (also used by the admin
 * preview). Reads that don't depend on each other run at once: config and
 * site facts, then the page image, the entry's docs (override, embed index,
 * AI entities, and its data for review blocks when the theme didn't pass it:
 * one D1 batch), credited bylines (unless the theme passed them), logo
 * dimensions, videos, reviews and entities; then the bylines' Person nodes
 * (which need the override's article type). The graph is assembled in a
 * fixed order afterwards, so the output doesn't depend on which read
 * finishes first.
 */
export async function schemaContributions(
	ctx: PluginContext,
	page: PublicPageContext,
	options: SchemaOptions,
	features?: FeatureMap,
): Promise<PageMetadataContribution[]> {
	const on = features ?? (await cachedCtxFeatures(ctx));
	if (!isOn(on, SCHEMA_FEATURES.main)) return [];
	const out: PageMetadataContribution[] = [];
	const graphOn = isOn(on, SCHEMA_FEATURES.graph);
	const ogOn = isOn(on, SCHEMA_FEATURES.openGraph);
	const cleanImages = isOn(on, "images");
	const [config, site] = await Promise.all([loadConfig(ctx, options.database), siteFacts(ctx, page), cleanImages ? refreshMediaHost() : undefined]);
	const imageRead = graphOn || ogOn ? primaryImage(options, page, site, cleanImages) : Promise.resolve(null);

	if (graphOn) {
		const personPath = config.person?.byline ? authorPath(config.settings.schemaAuthorUrlPattern, config.person.byline.slug) : null;
		const publisher = publisherNode({
			details: config.site,
			origin: site.origin,
			siteName: site.siteName,
			siteLogo: site.logo,
			person: config.person,
			authorUrl: personPath ? absolute(personPath, site.origin) : null,
		});
		const logoUrl = (publisher.logo as Node | undefined)?.url;
		const themed = themedEntry(page);
		// Credited bylines are read before knowing whether the page has an article (one read, usually needed), unless the theme passed them.
		const credited = entryBylines(ctx, page, themed.bylines);
		const reviewsOn = isOn(on, "reviews.schema");
		const reviews = reviewsOn ? import("../reviews/schema.js") : null;
		// The entry's docs in one read: its override, embed index and AI entities, and its data when review blocks must be looked for.
		const entryRead = page.content
			? (reviews ?? Promise.resolve(null)).then((r) =>
					readEntryDocs(
						ctx,
						{
							collection: page.content!.collection,
							id: page.content!.id,
							collections: [
								"schemaEntries",
								...(isOn(on, "videos.schema") ? ["videosEmbeds"] : []),
								...(isOn(on, "ai.entities") ? ["aiEntries"] : []),
							],
							data: Boolean(r && !themed.data && r.needsEntryData(page)),
							database: options.database,
						},
						r?.REVIEW_MARKER,
					),
				)
			: null;
		const doc = (collection: string) => entryRead?.then((d) => d.docs.get(collection) ?? null);
		const [image, override, logoInfo, videosStep, reviewsStep, entityStep] = await Promise.all([
			imageRead,
			(doc("schemaEntries") ?? null) as Promise<EntryOverride | null> | null,
			typeof logoUrl === "string" ? lookupMedia(options, logoUrl, site.origin) : null,
			// Videos: from the Videos module, and any the theme passes as page.coywolf.videos.
			pageVideosStep(ctx, page, site.origin, on, doc("videosEmbeds")),
			// Reviews: coywolf-review blocks in the entry, and any the theme passes as page.coywolf.reviews.
			reviews
				? reviews.then(({ pageReviewsStep }) =>
						pageReviewsStep(ctx, page, site.origin, themed.data ?? (entryRead ? () => entryRead.then((d) => d.data) : undefined)),
					)
				: noStep,
			// AI Enrichment's Wikidata-grounded entities, when that feature is on.
			page.content && isOn(on, "ai.entities") ? entitiesStep(ctx, page.content, doc("aiEntries")) : noStep,
		]);
		enrichImageObjects(publisher, (url) => (url === logoUrl ? logoInfo : null));
		const { articleType } = resolveTypes(page, config.types, override);
		const subjectByline = mainSubjectByline(override?.mainSubject);
		const [authors, mainEntity] = await Promise.all([
			articleType !== "none" ? authorNodes(ctx, credited, config, site, on) : [],
			override?.mainSubject === "publisher" ? publisher : subjectByline ? mainSubjectPerson(ctx, subjectByline, config, site, on) : null,
		]);
		const graph = buildGraph({
			page,
			origin: site.origin,
			siteName: site.siteName,
			tagline: site.tagline,
			language: page.locale || ctx.site.locale || null,
			types: config.types,
			override,
			searchUrl: config.settings.schemaSearchUrl,
			publisher,
			authors,
			mainEntity,
			image,
			breadcrumbs: isOn(on, SCHEMA_FEATURES.breadcrumbs),
			homeLabel: config.settings.schemaBreadcrumbHome || "Home",
		});
		// Videos, then reviews, then entities: each step may look at what the one before added.
		for (const step of [videosStep, reviewsStep, entityStep]) step(graph as { "@graph": Node[] });
		// Same id as EmDash's own JSON-LD, so this graph replaces it (first contribution wins).
		// With a media host, every media-library file in the graph (author images, logo, …) points at it.
		if (cleanImages && imageCdn()) rewriteMediaUrls(graph);
		out.push({ kind: "jsonld", id: "primary", graph });
	} else if (isOn(on, SCHEMA_FEATURES.breadcrumbs)) {
		const doc = breadcrumbDocument(page, site.origin, config.settings.schemaBreadcrumbHome || "Home");
		if (doc) out.push({ kind: "jsonld", id: "coywolf-breadcrumbs", graph: doc });
	}

	if (isOn(on, SCHEMA_FEATURES.robots)) {
		const s = config.settings;
		out.push({
			kind: "meta",
			name: "robots",
			content: robotsContent(page.seo?.robots, {
				maxImagePreview: s.schemaRobotsMaxImage,
				maxSnippet: parseLimit(s.schemaRobotsMaxSnippet),
				maxVideoPreview: parseLimit(s.schemaRobotsMaxVideo),
				nofollow: !!s.schemaRobotsNofollow,
			}),
		});
	}

	if (ogOn) {
		const image = await imageRead;
		const locale = config.settings.schemaOgLocale?.trim() || ogLocale(page.locale || ctx.site.locale);
		if (locale) out.push({ kind: "property", property: "og:locale", content: locale });
		// The default OG image at its clean URL, or the page's image on the media host: these win over EmDash's own og:image/twitter:image (first contribution wins).
		const own = Boolean(page.seo?.ogImage || page.image);
		out.push(...ogImageTags(image, Boolean(image && cleanImages && packOwnsOgImage(image.url, site.origin, own))));
	}
	return out;
}

// ── Admin routes ─────────────────────────────────────────────────

const ORG_SET = new Set(ORGANIZATION_PROPERTIES);
const PERSON_SET = new Set(PERSON_PROPERTIES);
const TYPE_SET = new Set(PAGE_TYPES.map(([t]) => t));
const ARTICLE_SET = new Set(ARTICLE_TYPES.map(([t]) => t));

const rowInput = z.object({
	prop: z.string().max(100),
	value: z.union([z.string().max(5000), z.record(z.string(), z.string().max(2000))]),
	profileOnly: z.boolean().optional(),
});
/** max-snippet / max-video-preview: blank or missing means -1 (no limit); anything non-numeric is rejected. */
const limitInput = z
	.union([z.number(), z.string().max(20), z.null()])
	.optional()
	.transform((v, zctx) => {
		if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return -1;
		const n = Number(v);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n < -1 || n > 1_000_000) {
			zctx.addIssue({ code: "custom", message: "Robots limits must be whole numbers, -1 or more (-1 = no limit)." });
			return z.NEVER;
		}
		return n;
	});
const typeChoiceInput = z.object({ pageType: z.string().max(60).optional(), articleType: z.string().max(60).optional() });

function cleanValue(value: string, input: string | undefined): string {
	const v = value.trim();
	if (!v) return "";
	if (input === "url" || input === "image") return /^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//")) ? v : "";
	if (input === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
	if (input === "number") return /^\d+$/.test(v) ? v : "";
	return v.replace(/[\u0000-\u001f]/g, " ");
}

/**
 * Keep only catalog properties with valid values, like Coywolf SEO's
 * sanitize_properties(). `profileOnly` keeps the rows' profile-only marks
 * (Person rows only).
 */
export function sanitizeRows(rows: z.infer<typeof rowInput>[], allowed: Set<string>, profileOnly = false): PropertyRow[] {
	const out: PropertyRow[] = [];
	// Never @id: the person must keep one @id on every page.
	const mark = (row: z.infer<typeof rowInput>) => (profileOnly && row.profileOnly === true && row.prop !== "@id" ? { profileOnly: true } : {});
	for (const row of rows) {
		if (!allowed.has(row.prop)) continue;
		const meta = PROPERTY_INPUTS[row.prop] ?? { input: "text" };
		if (meta.fields) {
			if (typeof row.value !== "object") continue;
			const value: Record<string, string> = {};
			for (const [sub, subMeta] of Object.entries(meta.fields)) {
				const v = cleanValue(row.value[sub] ?? "", subMeta.input);
				if (v) value[sub] = v;
			}
			if (Object.keys(value).length) out.push({ prop: row.prop, value, ...mark(row) });
		} else {
			if (typeof row.value !== "string") continue;
			const value = cleanValue(row.value, meta.input);
			if (value) out.push({ prop: row.prop, value, ...mark(row) });
		}
	}
	return out;
}

function cleanChoice(choice: TypeChoice): TypeChoice {
	const out: TypeChoice = {};
	if (choice.pageType && TYPE_SET.has(choice.pageType)) out.pageType = choice.pageType;
	if (choice.articleType && ARTICLE_SET.has(choice.articleType)) out.articleType = choice.articleType;
	return out;
}

function entryTitle(data: Record<string, unknown>, titleField: string | null | undefined): string {
	const value = (titleField && data[titleField]) || data.title || data.name || data.headline;
	return typeof value === "string" ? value : "";
}

const MAIN = SCHEMA_FEATURES.main;

export function schemaModule(options: SchemaOptions) {
	const routes = {
		/** Everything the admin page needs to render. */
		"schema/config": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, MAIN);
				invalidateSchemaConfig();
				const [config, collections, features] = await Promise.all([
					loadConfig(ctx, options.database, true),
					ctx.schema?.listCollections().catch(() => []) ?? [],
					ctxFeatures(ctx),
				]);
				return {
					settings: config.settings,
					site: config.site,
					types: config.types,
					collections: collections
						.filter((c) => !c.hidden)
						.map((c) => ({ slug: c.slug, label: c.label, routable: c.routable, dated: !!c.dateField })),
					features: Object.fromEntries(Object.values(SCHEMA_FEATURES).map((id) => [id, isOn(features, id)])),
					catalog: {
						pageTypes: PAGE_TYPES,
						articleTypes: ARTICLE_TYPES,
						organization: ORGANIZATION_PROPERTIES,
						organizationTypes: ORGANIZATION_TYPES,
						person: PERSON_PROPERTIES,
						inputs: PROPERTY_INPUTS,
					},
					keys: { home: HOME_KEY, custom: CUSTOM_KEY },
				};
			},
		},

		"schema/settings/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const input = parseInput(
					z.object({
						schemaSearchUrl: z.string().max(500).optional(),
						schemaAuthorUrlPattern: z.string().max(500).optional(),
						schemaBreadcrumbHome: z.string().max(100).optional(),
						schemaRobotsMaxImage: z.enum(["large", "standard", "none", ""]).optional(),
						schemaRobotsMaxSnippet: limitInput,
						schemaRobotsMaxVideo: limitInput,
						schemaRobotsNofollow: z.boolean().optional(),
						schemaOgLocale: z
							.string()
							.max(20)
							.regex(/^([a-z]{2,3}_[A-Z]{2})?$/, "og:locale looks like en_US")
							.optional(),
					}),
					ctx.input,
				);
				if (input.schemaSearchUrl && !input.schemaSearchUrl.includes("{search_term_string}"))
					throw PluginRouteError.badRequest("The search URL needs {search_term_string} where the query goes.");
				for (const [key, value] of Object.entries(input)) if (value !== undefined) await ctx.settings.set(key, value);
				// The settings are read with the feature switches: drop that cache too.
				invalidateFeatures();
				invalidateSchemaConfig();
				return { settings: (await loadConfig(ctx, options.database, true)).settings };
			},
		}),

		"schema/site/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const input = parseInput(
					z.object({
						publisherType: z.enum(["organization", "person"]),
						organizationType: z.string().nullish(),
						personBylineId: z.string().max(100).nullish(),
						orgRows: z.array(rowInput).max(200),
					}),
					ctx.input,
				);
				const site: SiteDetails = {
					publisherType: input.publisherType,
					organizationType: ORGANIZATION_TYPES.some(([t]) => t === input.organizationType) ? input.organizationType : "Organization",
					personBylineId: input.personBylineId || null,
					orgRows: sanitizeRows(input.orgRows, ORG_SET),
				};
				await docs(ctx).put("site", site);
				invalidateSchemaConfig();
				return { site };
			},
		}),

		"schema/types/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { types } = parseInput(z.object({ types: z.record(z.string().max(100), typeChoiceInput) }), ctx.input);
				const clean: TypeMap = {};
				for (const [key, choice] of Object.entries(types)) {
					const c = cleanChoice(choice);
					if (c.pageType || c.articleType) clean[key] = c;
				}
				await docs(ctx).put("types", clean);
				invalidateSchemaConfig();
				return { types: clean };
			},
		}),

		/** Bylines with their saved Person rows. */
		"schema/authors": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, MAIN);
				if (!ctx.bylines) return { items: [], authorsOn: false };
				const items: Array<{ id: string; slug: string; displayName: string; bio: string | null; websiteUrl: string | null; locale: string; rows: PropertyRow[] | null }> = [];
				let cursor: string | undefined;
				for (let page = 0; page < 10; page++) {
					const result = await ctx.bylines.list({ limit: 100, cursor });
					for (const b of result.items)
						items.push({ id: b.id, slug: b.slug, displayName: b.displayName, bio: b.bio, websiteUrl: b.websiteUrl, locale: b.locale, rows: null });
					if (!result.hasMore || !result.cursor) break;
					cursor = result.cursor;
				}
				const saved: Map<string, { rows: PropertyRow[] }> = items.length ? await getManyBatched(authorsStore(ctx), items.map((i) => i.id)) : new Map();
				for (const item of items) item.rows = saved.get(item.id)?.rows ?? null;
				return { items, authorsOn: isOn(await ctxFeatures(ctx), SCHEMA_FEATURES.authors) };
			},
		},

		"schema/authors/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, SCHEMA_FEATURES.authors);
				const { bylineId, rows } = parseInput(z.object({ bylineId: z.string().min(1).max(100), rows: z.array(rowInput).max(200) }), ctx.input);
				if (ctx.bylines && !(await ctx.bylines.get(bylineId))) throw PluginRouteError.notFound("Unknown byline.");
				const clean = sanitizeRows(rows, PERSON_SET, true);
				if (clean.length) await authorsStore(ctx).put(bylineId, { rows: clean, updatedAt: new Date().toISOString() });
				else await authorsStore(ctx).delete(bylineId);
				invalidateSchemaConfig();
				return { rows: clean };
			},
		}),

		/** Per-entry overrides. */
		"schema/entries": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, MAIN);
				const items: EntryOverride[] = [];
				let cursor: string | undefined;
				for (let page = 0; page < 20; page++) {
					const result = await entries(ctx).query({ limit: 100, cursor });
					for (const row of result.items as Array<{ data: EntryOverride }>) items.push(row.data);
					if (!result.hasMore || !result.cursor) break;
					cursor = result.cursor;
				}
				items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
				return { items };
			},
		},

		/** An entry's credited byline ids, so the main-subject picker can list them first. */
		"schema/entries/bylines": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { collection, entryId } = parseInput(z.object({ collection: z.string().min(1).max(100), entryId: z.string().min(1).max(100) }), ctx.input);
				if (!ctx.bylines) return { ids: [] };
				const [credits] = await ctx.bylines.getEntriesBylines(collection, [entryId]).catch(() => []);
				return { ids: credits?.bylines.map((c) => c.byline.id) ?? [] };
			},
		}),

		/** Recent entries of a collection, for picking one to override or preview. */
		"schema/entries/find": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { collection, query } = parseInput(z.object({ collection: z.string().min(1).max(100), query: z.string().max(200).optional() }), ctx.input);
				if (!ctx.content) throw PluginRouteError.badRequest("Content access is unavailable.");
				const info = await ctx.schema?.getCollection(collection);
				if (!info) throw PluginRouteError.notFound("Unknown collection.");
				const result = await ctx.content.list(collection, { limit: 100, orderBy: { updatedAt: "desc" } }).catch(async () => ctx.content!.list(collection, { limit: 100 }));
				const q = query?.trim().toLowerCase();
				const items = result.items
					.map((item) => ({ id: item.id, slug: item.slug, status: item.status, title: entryTitle(item.data, info.titleField) || item.slug || item.id }))
					.filter((i) => !q || i.title.toLowerCase().includes(q) || (i.slug ?? "").toLowerCase().includes(q));
				return { items: items.slice(0, 50) };
			},
		}),

		"schema/entries/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const input = parseInput(
					z
						.object({
							collection: z.string().min(1).max(100),
							entryId: z.string().min(1).max(100),
							title: z.string().max(500).optional(),
							mainSubject: z.string().max(120).nullish(),
						})
						.merge(typeChoiceInput),
					ctx.input,
				);
				const choice = cleanChoice(input);
				const id = `${input.collection}:${input.entryId}`;
				let mainSubject: MainSubject | undefined;
				if (input.mainSubject === "publisher") mainSubject = "publisher";
				else if (input.mainSubject) {
					const bylineId = mainSubjectByline(input.mainSubject);
					if (!bylineId) throw PluginRouteError.badRequest("Choose a byline or the site publisher as the main subject.");
					if (ctx.bylines && !(await ctx.bylines.get(bylineId).catch(() => null))) throw PluginRouteError.notFound("That byline doesn't exist.");
					mainSubject = `byline:${bylineId}`;
				}
				if (!choice.pageType && !choice.articleType && !mainSubject) {
					await entries(ctx).delete(id);
					return { deleted: true };
				}
				if (!ctx.content) throw PluginRouteError.badRequest("Content access is unavailable.");
				const entry = await ctx.content.get(input.collection, input.entryId).catch(() => null);
				if (!entry) throw PluginRouteError.notFound("That entry doesn't exist.");
				const item: EntryOverride = {
					collection: input.collection,
					entryId: input.entryId,
					title: input.title,
					...choice,
					...(mainSubject ? { mainSubject } : {}),
					updatedAt: new Date().toISOString(),
				};
				await entries(ctx).put(id, item);
				return { item };
			},
		}),

		"schema/entries/delete": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { collection, entryId } = parseInput(z.object({ collection: z.string().max(100), entryId: z.string().max(100) }), ctx.input);
				return { deleted: await entries(ctx).delete(`${collection}:${entryId}`) };
			},
		}),

		/** Images from the media library, for the logo/image pickers. */
		"schema/media": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { cursor } = parseInput(z.object({ cursor: z.string().max(500).optional() }), ctx.input);
				if (!ctx.media) return { items: [], hasMore: false };
				const result = await ctx.media.list({ limit: 30, cursor, mimeType: "image/" });
				return {
					items: result.items.map((m) => ({ id: m.id, url: m.url, filename: m.filename, alt: m.alt ?? null, width: m.width ?? null, height: m.height ?? null })),
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		}),

		/** What this module would add to the head of the home page or an entry. */
		"schema/preview": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const input = parseInput(
					z.object({ target: z.enum(["home", "entry"]), collection: z.string().max(100).optional(), entryId: z.string().max(100).optional() }),
					ctx.input,
				);
				invalidateSchemaConfig();
				// Fresh settings and docs for the preview (and the cache it then renders from).
				await loadConfig(ctx, options.database, true);
				const siteUrl = originOf(ctx.site.url);
				const name = await siteName(ctx);
				let page: PublicPageContext;
				if (input.target === "home") {
					page = { url: `${siteUrl}/`, path: "/", locale: null, kind: "custom", pageType: "website", title: name, pageTitle: name, description: null, canonical: `${siteUrl}/`, image: null, siteName: name };
				} else {
					if (!input.collection || !input.entryId || !ctx.content) throw PluginRouteError.badRequest("Choose an entry.");
					const [item, info] = await Promise.all([ctx.content.get(input.collection, input.entryId), ctx.schema?.getCollection(input.collection)]);
					if (!item) throw PluginRouteError.notFound("Entry not found.");
					const publicPath = await entryUrl(ctx, input.collection, item).catch(() => null);
					const publicUrl = publicPath ? absoluteUrl(publicPath, siteUrl) : `${siteUrl}/${item.slug ?? item.id}/`;
					const url = absolute(publicUrl, siteUrl) ?? publicUrl;
					const title = item.seo?.title || entryTitle(item.data, info?.titleField) || item.slug || item.id;
					const image = item.seo?.image ? (item.seo.image.startsWith("/") || /^https?:/i.test(item.seo.image) ? item.seo.image : `/_emdash/api/media/file/${item.seo.image}`) : null;
					page = {
						url,
						path: URL.canParse(url) ? new URL(url).pathname : "/",
						locale: item.locale,
						kind: "content",
						pageType: info?.dateField ? "article" : "website",
						title,
						pageTitle: title,
						description: item.seo?.description || (typeof item.data.excerpt === "string" ? item.data.excerpt : null),
						canonical: item.seo?.canonical ? (absolute(item.seo.canonical, siteUrl) ?? url) : url,
						image,
						content: { collection: input.collection, id: item.id, slug: item.slug },
						seo: { robots: item.seo?.noIndex ? "noindex, nofollow" : null },
						articleMeta: { publishedTime: item.publishedAt, modifiedTime: item.updatedAt },
						siteName: name,
					};
				}
				const contributions = await schemaContributions(ctx, page, options);
				return { page: { url: pageUrl(page), pageType: page.pageType }, contributions };
			},
		}),
	};

	return { routes };
}

/** The hook EmDash calls for each rendered page. */
export function schemaMetadataHook(options: SchemaOptions) {
	return async (event: { page: PublicPageContext }, ctx: PluginContext) => schemaContributions(ctx, event.page, options);
}

/** Replace media-library file URLs (/_emdash/api/media/file/<file>) anywhere in a JSON-LD value with their media-host originals, in place. */
export function rewriteMediaUrls(value: unknown): unknown {
	if (typeof value === "string") return cdnOriginalUrl(value) ?? value;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) value[i] = rewriteMediaUrls(value[i]);
		return value;
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of Object.keys(obj)) obj[key] = rewriteMediaUrls(obj[key]);
	}
	return value;
}

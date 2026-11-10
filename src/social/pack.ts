/**
 * Social Images: a 1200×630 Open Graph image (the entry's title, the site's
 * name and logo, in the site's colors) for published entries that have no
 * image of their own, made once with Cloudflare Browser Run, stored in the
 * media bucket and set as og:image by the Schema & Social module's
 * page:metadata hook. See docs/social-images.md.
 */
import type { CollectionSchemaInfo, PluginContext } from "emdash";
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { CLOUDFLARE_API_HOST } from "../core/cloudflare-api.js";
import { createEntryUrlResolver } from "../core/content-url.js";
import { ctxFeatures, isOn, registerFeatures, requireFeature } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { purgePageCache } from "../pageCache/lib.js";
import { siteName } from "../core/site.js";
import { afterResponse, parseInput, workerEnv } from "../shared.js";
import { type RenderContext, RenderError, SETTINGS_KEY, TOKEN_SETTING, normalizeSocialSettings, readSocialSettings, renderContext, renderEntry, renderer, screenshot, siteLogo } from "./render.js";
import { SOCIAL_STORAGE, type SocialImageDoc, counts, docId, markPending, socialImages, socialImageUrl } from "./store.js";
import { TEMPLATE_DEFAULTS, socialImageHtml } from "./template.js";

export const SOCIAL_FEATURE = "socialImages";
const FEATURES = [
	{
		id: SOCIAL_FEATURE,
		label: "Social Images",
		description:
			"A 1200×630 Open Graph image (the entry's title, your site's name and logo, in your colors) for published entries without an image of their own, made once with Cloudflare Browser Run and stored in your media bucket. Needs Schema & Social on, and a Browser Run token or binding.",
		default: false,
	},
];
registerFeatures(FEATURES);

export const SOCIAL_TASK = "social-images";
/** Images per scheduled run, and its time limit (Browser Run on Workers Free takes one request every 10 seconds). */
const CRON_BATCH = 10;
const CRON_MS = 5 * 60_000;
const BACKFILL_PAGE = 50;
const BACKFILL_KEY = "social:backfill";

export interface SocialImagesOptions {
	/** R2 binding of the media bucket. Default "MEDIA" (the bucket EmDash serves media from). */
	bucket?: string;
}

type Item = { id: string; slug: string | null; status: string; data: Record<string, unknown>; seo?: { image?: string | null } | null };

const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** Whether an entry has an image of its own (an SEO image or an image field): then it keeps that. */
export function hasOwnImage(item: Item, schema: Pick<CollectionSchemaInfo, "fields">): boolean {
	if (nonEmpty(item.seo?.image)) return true;
	for (const f of schema.fields) {
		if (f.type !== "image") continue;
		const v = item.data[f.slug];
		if (nonEmpty(v) || (v && typeof v === "object" && (nonEmpty((v as Record<string, unknown>).id) || nonEmpty((v as Record<string, unknown>).src)))) return true;
	}
	return false;
}

function titleOf(schema: CollectionSchemaInfo, item: Item): string {
	const candidates = [schema.titleField ? item.data[schema.titleField] : undefined, item.data.title, item.data.name, item.slug];
	return String(candidates.find((v) => nonEmpty(v)) ?? "").trim().slice(0, 200);
}

let schemaCache: { at: number; list: CollectionSchemaInfo[] } | null = null;
async function collections(ctx: PluginContext): Promise<CollectionSchemaInfo[]> {
	if (schemaCache && Date.now() - schemaCache.at < 60_000) return schemaCache.list;
	const list = ((await ctx.schema?.listCollections()) ?? []).filter((c) => c.routable !== false && !c.hidden);
	schemaCache = { at: Date.now(), list };
	return list;
}

const wanted = (selected: string[], slug: string) => !selected.length || selected.includes(slug);

/**
 * Make images for pending entries, up to `limit`, within `deadline`. An entry
 * that has its own image now, or isn't published, is skipped. Pages of the
 * entries that got a new image are purged from the edge cache, so shares see it.
 */
export async function renderPending(ctx: PluginContext, options: { limit: number; deadline: number; bucket?: string }): Promise<{ rendered: number; skipped: number; failed: number; stopped?: string }> {
	const settings = await readSocialSettings(ctx);
	const out = { rendered: 0, skipped: 0, failed: 0 } as { rendered: number; skipped: number; failed: number; stopped?: string };
	const page = await socialImages(ctx).query({ where: { status: "pending" }, orderBy: { updatedAt: "asc" }, limit: Math.min(options.limit, 50) });
	if (!page.items.length) return out;
	const rc = await renderContext(ctx, settings, options.bucket);
	if ("reason" in rc) return { ...out, stopped: rc.reason };
	const schemas = new Map((await collections(ctx)).map((c) => [c.slug, c]));
	const changed: Array<{ collection: string; id: string; slug: string | null }> = [];
	for (const { data: doc } of page.items) {
		if (Date.now() >= options.deadline) break;
		const schema = schemas.get(doc.collection);
		const item = (await ctx.content?.get(doc.collection, doc.id).catch(() => null)) as Item | null;
		if (!schema || !item || item.status !== "published" || !wanted(settings.collections, doc.collection) || hasOwnImage(item, schema)) {
			const note = !item || item.status !== "published" ? "Not published" : schema && hasOwnImage(item, schema) ? "Has its own image" : "Not in the chosen collections";
			await socialImages(ctx).put(docId(doc.collection, doc.id), { ...doc, status: "skipped", note, updatedAt: new Date().toISOString() });
			out.skipped++;
			continue;
		}
		try {
			const before = doc.key;
			const after = await renderEntry(ctx, rc, { collection: doc.collection, id: doc.id, title: titleOf(schema, item) || doc.title });
			out.rendered++;
			if (after.key !== before) changed.push({ collection: doc.collection, id: doc.id, slug: item.slug });
		} catch (error) {
			out.failed++;
			if (error instanceof RenderError && error.status === 429) {
				out.stopped = error.message;
				break;
			}
			ctx.log.warn("social images: a render failed", { entry: docId(doc.collection, doc.id), error: String(error) });
		}
	}
	await purgeEntries(ctx, changed);
	return out;
}

/** Purge the pages of entries whose image changed (at most 100 paths, Cloudflare's limit per purge). */
async function purgeEntries(ctx: PluginContext, entries: Array<{ collection: string; id: string; slug: string | null }>): Promise<void> {
	if (!entries.length) return;
	try {
		const resolver = createEntryUrlResolver(ctx);
		const paths: string[] = [];
		const byCollection = new Map<string, Array<{ id: string; slug: string | null }>>();
		for (const e of entries) byCollection.set(e.collection, [...(byCollection.get(e.collection) ?? []), e]);
		for (const [collection, list] of byCollection) for (const path of (await resolver.urls(collection, list.map((e) => ({ ...e, status: "published" })))).values()) if (path) paths.push(path);
		if (paths.length) await purgePageCache({ pathPrefixes: paths.slice(0, 100) });
	} catch (error) {
		ctx.log.warn("social images: couldn't clear the pages' cached copies", { error: String(error) });
	}
}

interface BackfillState {
	status: "idle" | "running";
	collections: string[];
	index: number;
	cursor: string | null;
	queued: number;
	finishedAt: string | null;
}

const IDLE_BACKFILL: BackfillState = { status: "idle", collections: [], index: 0, cursor: null, queued: 0, finishedAt: null };

/** One step of queueing existing entries without an image of their own (pages of BACKFILL_PAGE). */
async function backfillStep(ctx: PluginContext, restart: boolean, deadline: number): Promise<BackfillState> {
	const settings = await readSocialSettings(ctx);
	const all = await collections(ctx);
	let state: BackfillState = { ...IDLE_BACKFILL, ...((await ctx.kv.get<BackfillState>(BACKFILL_KEY)) ?? {}) };
	if (restart || state.status !== "running") state = { ...IDLE_BACKFILL, status: "running", collections: all.filter((c) => wanted(settings.collections, c.slug)).map((c) => c.slug) };
	const schemas = new Map(all.map((c) => [c.slug, c]));
	while (state.index < state.collections.length && Date.now() < deadline && ctx.content) {
		const schema = schemas.get(state.collections[state.index]);
		if (!schema) {
			Object.assign(state, { index: state.index + 1, cursor: null });
			continue;
		}
		const page = await ctx.content.list(schema.slug, { limit: BACKFILL_PAGE, cursor: state.cursor ?? undefined, where: { status: "published" } });
		const need = (page.items as Item[]).filter((item) => item.status === "published" && !hasOwnImage(item, schema));
		if (need.length) {
			const existing = await socialImages(ctx).getMany(need.map((i) => docId(schema.slug, i.id)));
			const now = new Date().toISOString();
			const fresh = need.filter((i) => {
				const doc = existing.get(docId(schema.slug, i.id));
				return !doc || doc.status === "skipped" || (doc.status === "failed" && !doc.key);
			});
			if (fresh.length) {
				await socialImages(ctx).putMany(
					fresh.map((i) => ({
						id: docId(schema.slug, i.id),
						data: { collection: schema.slug, id: i.id, title: titleOf(schema, i), key: null, hash: null, status: "pending", note: null, attempts: 0, updatedAt: now, renderedAt: null } satisfies SocialImageDoc,
					})),
				);
				state.queued += fresh.length;
			}
		}
		if (page.hasMore && page.cursor) state.cursor = page.cursor;
		else Object.assign(state, { index: state.index + 1, cursor: null });
	}
	if (state.index >= state.collections.length) Object.assign(state, { status: "idle", finishedAt: new Date().toISOString() });
	await ctx.kv.set(BACKFILL_KEY, state);
	return state;
}

const SAMPLE_TITLE = "How to Plan a Content Calendar That Your Whole Team Will Actually Use";

const templateInput = z.object({
	background: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex color like #0f172a."),
	text: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex color like #ffffff."),
	accent: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex color like #38bdf8."),
	layout: z.enum(["left", "center"]),
	showLogo: z.boolean(),
	showSiteName: z.boolean(),
});

export function socialImagesPack(options: SocialImagesOptions = {}): PackModule {
	const bucket = options.bucket ?? "MEDIA";

	/** Queue the entry and start its render after the response (the hourly job retries what doesn't finish). */
	const onPublished = async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
		const content = event.content as { id?: string; status?: string };
		if (!content?.id || (content.status && content.status !== "published")) return;
		const settings = await readSocialSettings(ctx);
		if (!wanted(settings.collections, event.collection)) return;
		await markPending(ctx, event.collection, content.id);
		afterResponse(renderPending(ctx, { limit: 1, deadline: Date.now() + 25_000, bucket }).catch((error: unknown) => ctx.log.warn("social images: render after publish failed; the hourly job retries", { error: String(error) })));
	};

	const routes = {
		/** Settings, how Browser Run is reached (never the token), counts and recent images. */
		"social/status": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, SOCIAL_FEATURE);
					const settings = await readSocialSettings(ctx);
					const r = await renderer(ctx, settings);
					const tokenSaved = Boolean(await ctx.settings.get<string>(TOKEN_SETTING).catch(() => null));
					const recent = await socialImages(ctx).query({ orderBy: { updatedAt: "desc" }, limit: 12 });
					const origin = ctx.site?.url ?? "";
					const features = await ctxFeatures(ctx);
					return {
						// og:image is set by Schema & Social's page:metadata hook: without it, images are made but not used.
						schemaOn: isOn(features, "schema"),
						settings,
						renderer: r.kind === "none" ? { kind: "none", reason: r.reason } : { kind: r.kind },
						tokenSaved,
						counts: await counts(ctx),
						backfill: (await ctx.kv.get<BackfillState>(BACKFILL_KEY)) ?? IDLE_BACKFILL,
						collections: (await collections(ctx)).map((c) => ({ slug: c.slug, label: c.label })),
						recent: recent.items.map(({ data }) => ({ ...data, url: data.key ? socialImageUrl(data.key, origin) : null })),
						defaults: TEMPLATE_DEFAULTS,
					};
				},
			}),
		),

		/** The template as HTML, for the page's live preview (nothing is rendered or stored). */
		"social/preview": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, SOCIAL_FEATURE);
					const input = parseInput(z.object({ template: templateInput, title: z.string().max(200).optional() }), ctx.input);
					const media = ((await workerEnv().catch(() => ({}))) as Record<string, unknown>)[bucket] as R2Bucket | undefined;
					const logo = await siteLogo(media, ctx.site?.url ?? "");
					const name = (await siteName(ctx).catch(() => "")) || ctx.site?.name || "Your site";
					return { html: socialImageHtml({ title: input.title?.trim() || SAMPLE_TITLE, siteName: name, logo: logo.src, settings: normalizeSocialSettings({ template: input.template }).template }) };
				},
			}),
		),

		// The routes below change only Social Images' own settings, records and stored images: read-only for the page cache
		// (an entry's page is purged when its image changes, in renderPending).
		"social/settings/save": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, SOCIAL_FEATURE);
					const input = parseInput(
						z.object({
							template: templateInput,
							collections: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(100),
							accountId: z.string().trim().regex(/^([0-9a-fA-F]{32})?$/, "The account ID is 32 letters and numbers (Cloudflare dashboard → the account's home → Account ID)."),
							token: z.string().trim().max(500).optional(),
							clearToken: z.boolean().optional(),
						}),
						ctx.input,
					);
					const settings = normalizeSocialSettings(input);
					await ctx.settings.set(SETTINGS_KEY, settings);
					if (input.clearToken) await ctx.settings.delete(TOKEN_SETTING);
					else if (input.token) await ctx.settings.set(TOKEN_SETTING, input.token);
					return { settings, tokenSaved: input.clearToken ? false : Boolean(input.token) || Boolean(await ctx.settings.get<string>(TOKEN_SETTING).catch(() => null)) };
				},
			}),
		),

		/** Render the sample title once and return it (not stored): checks the token and shows the real result. */
		"social/test": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, SOCIAL_FEATURE);
					const settings = await readSocialSettings(ctx);
					const rc: RenderContext | { reason: string } = await renderContext(ctx, settings, bucket);
					if ("reason" in rc) return { ok: false, error: rc.reason };
					try {
						const png = await screenshot(rc.renderer, socialImageHtml({ title: SAMPLE_TITLE, siteName: rc.siteName, logo: rc.logo.src, settings: rc.template }));
						let binary = "";
						for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
						return { ok: true, image: `data:image/png;base64,${btoa(binary)}`, bytes: png.byteLength };
					} catch (error) {
						return { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
				},
			}),
		),

		/** Queue existing entries without an image (one step per call; the page calls again while it's running). */
		"social/backfill": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, SOCIAL_FEATURE);
					const { restart } = parseInput(z.object({ restart: z.boolean().optional() }), ctx.input ?? {});
					return backfillStep(ctx, Boolean(restart), Date.now() + 15_000);
				},
			}),
		),

		/** Make the next few pending images (the page calls again while some are pending). */
		"social/render": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, SOCIAL_FEATURE);
					const result = await renderPending(ctx, { limit: 3, deadline: Date.now() + 20_000, bucket });
					return { ...result, counts: await counts(ctx) };
				},
			}),
		),

		/** Make one entry's image again (it's queued first). */
		"social/regenerate": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, SOCIAL_FEATURE);
					const input = parseInput(z.object({ collection: z.string().regex(/^[a-z][a-z0-9_]*$/), id: z.string().min(1).max(128) }), ctx.input);
					const store = socialImages(ctx);
					const doc = await store.get(docId(input.collection, input.id));
					// A new hash isn't needed: clearing the stored hash makes the next render draw it again.
					if (doc) await store.put(docId(input.collection, input.id), { ...doc, hash: null, status: "pending", attempts: 0, note: null, updatedAt: new Date().toISOString() });
					else await markPending(ctx, input.collection, input.id);
					return renderPending(ctx, { limit: 1, deadline: Date.now() + 25_000, bucket });
				},
			}),
		),
	};

	return {
		id: "socialImages",
		label: "Social Images",
		features: FEATURES,
		routes,
		hooks: {
			"content:afterPublish": onPublished,
			"content:afterSave": onPublished,
		},
		tasks: [
			{
				name: SOCIAL_TASK,
				schedule: "@hourly",
				// While nothing is pending: one indexed count-free query an hour.
				handler: async (ctx: PluginContext) => {
					const result = await renderPending(ctx, { limit: CRON_BATCH, deadline: Date.now() + CRON_MS, bucket });
					if (result.rendered || result.failed) ctx.log.info("social images: scheduled run", result);
				},
			},
		],
		adminPages: [{ path: "/social-images", label: "Social Images", icon: "image-square" }],
		storage: SOCIAL_STORAGE,
		capabilities: ["content:read", "schema:read", "network:request"],
		allowedHosts: [CLOUDFLARE_API_HOST],
	};
}

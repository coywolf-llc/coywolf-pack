/**
 * Social Images: a 1200×630 Open Graph image (the entry's title, the site's
 * name and logo, in the site's colors) for published entries that have no
 * image of their own, made once with Cloudflare Browser Run, stored in the
 * media bucket and set as og:image by the Schema & Social module's
 * page:metadata hook. See docs/social-images.md.
 */
import type { CollectionSchemaInfo, PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { CLOUDFLARE_API_HOST } from "../core/cloudflare-api.js";
import { createEntryUrlResolver } from "../core/content-url.js";
import { ctxFeatures, isOn, registerFeatures, requireFeature } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { purgePageCache } from "../pageCache/lib.js";
import { siteName } from "../core/site.js";
import { afterResponse, parseInput, workerEnv } from "../shared.js";
import { NOT_SET_UP, type RenderContext, RenderError, SETTINGS_KEY, type SocialSettings, TOKEN_SETTING, hashFor, normalizeSocialSettings, readSocialSettings, removeEntryImage, renderContext, renderEntry, renderer, screenshot, siteLogo, templateInputs } from "./render.js";
import { knownPlan } from "../core/plan.js";
import { SOCIAL_STORAGE, type SocialImageDoc, counts, docId, markPending, parseDefaultImages, socialImages, socialImageUrl } from "./store.js";
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
/**
 * Images per scheduled run. Each takes about five D1 statements, and EmDash runs every due task in one invocation
 * (Workers Free: 50 D1 queries per invocation for all of them), so a Free site makes 4 an hour; a site the usage
 * card has seen on Workers Paid makes up to 30.
 */
const CRON_BATCH = { free: 4, paid: 30 } as const;
const CRON_MS = 3 * 60_000;
/** Browser Run's Quick Actions on Workers Free: one request every 10 seconds. */
const FREE_SPACING_MS = 10_500;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = "rendered" | "unchanged" | "skipped";

/**
 * One entry: read it as published (never the save that queued it, which may
 * be a draft), skip it when it isn't published, isn't in the chosen
 * collections or has an image of its own, else make (or keep) its image.
 */
async function renderLive(ctx: PluginContext, rc: RenderContext, settings: SocialSettings, schemas: Map<string, CollectionSchemaInfo>, collection: string, id: string): Promise<{ outcome: Outcome; slug: string | null }> {
	const schema = schemas.get(collection);
	const item = (await ctx.content?.get(collection, id).catch(() => null)) as Item | null;
	if (!schema || !item || item.status !== "published" || !wanted(settings.collections, collection) || hasOwnImage(item, schema)) {
		const note = !item || item.status !== "published" ? "Not published" : schema && hasOwnImage(item, schema) ? "Has its own image" : "Not in the chosen collections";
		await skip(ctx, collection, id, note);
		return { outcome: "skipped", slug: item?.slug ?? null };
	}
	const before = (await socialImages(ctx).get(docId(collection, id)))?.key ?? null;
	const after = await renderEntry(ctx, rc, { collection, id, title: titleOf(schema, item) || id });
	return { outcome: after.key !== before ? "rendered" : "unchanged", slug: item.slug };
}

/** Mark a record skipped (it has its own image, isn't published…): its generated image is no longer used. */
async function skip(ctx: PluginContext, collection: string, id: string, note: string): Promise<void> {
	const store = socialImages(ctx);
	const read = await store.getVersioned(docId(collection, id));
	if (!read?.value || read.value.status === "skipped") return;
	await store.compareAndSet(docId(collection, id), read.revision, { ...read.value, status: "skipped", note, updatedAt: new Date().toISOString() }).catch(() => undefined);
}

/**
 * Make images for pending entries, up to `limit`, within `deadline`, oldest
 * first. On Workers Free (or an unknown plan) renders are 10 seconds apart,
 * Browser Run's Quick Actions limit there; a 429 waits out its Retry-After
 * when the deadline allows, else stops the batch. Pages of the entries that
 * got a new image are purged from the edge cache, so shares see it.
 */
export async function renderPending(ctx: PluginContext, options: { limit: number; deadline: number; bucket?: string; spacingMs?: number }): Promise<{ rendered: number; skipped: number; failed: number; stopped?: string }> {
	const settings = await readSocialSettings(ctx);
	const out = { rendered: 0, skipped: 0, failed: 0 } as { rendered: number; skipped: number; failed: number; stopped?: string };
	const page = await socialImages(ctx).query({ where: { status: "pending" }, orderBy: { updatedAt: "asc" }, limit: Math.min(options.limit, 50) });
	if (!page.items.length) return out;
	const rc = await renderContext(ctx, settings, options.bucket);
	if ("reason" in rc) return { ...out, stopped: rc.reason };
	const schemas = new Map((await collections(ctx)).map((c) => [c.slug, c]));
	const spacing = options.spacingMs ?? ((await knownPlan(ctx.kv)) === "paid" ? 0 : FREE_SPACING_MS);
	const changed: Array<{ collection: string; id: string; slug: string | null }> = [];
	let lastRender = 0;
	for (const { data: doc } of page.items) {
		for (let attempt = 0; attempt < 2; attempt++) {
			const wait = lastRender ? Math.max(0, lastRender + spacing - Date.now()) : 0;
			if (Date.now() + wait >= options.deadline) return finish();
			if (wait) await sleep(wait);
			try {
				const result = await renderLive(ctx, rc, settings, schemas, doc.collection, doc.id);
				if (result.outcome === "skipped") out.skipped++;
				else {
					out.rendered++;
					lastRender = Date.now();
					if (result.outcome === "rendered") changed.push({ collection: doc.collection, id: doc.id, slug: result.slug });
				}
				break;
			} catch (error) {
				lastRender = Date.now();
				const retryAfter = error instanceof RenderError && error.status === 429 ? (error.retryAfterMs ?? spacing) : null;
				if (retryAfter !== null && attempt === 0 && Date.now() + retryAfter + 5_000 < options.deadline) {
					await sleep(retryAfter);
					continue;
				}
				out.failed++;
				if (error instanceof RenderError && (error.status === 429 || error.status === NOT_SET_UP)) {
					out.stopped = error.message;
					return finish();
				}
				ctx.log.warn("social images: a render failed", { entry: docId(doc.collection, doc.id), error: String(error) });
				break;
			}
		}
	}
	return finish();

	async function finish() {
		await purgeEntries(ctx, changed);
		return out;
	}
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

/**
 * One step of queueing existing entries without an image of their own (pages
 * of BACKFILL_PAGE): those with no image yet, and those whose image no longer
 * matches their title or the template (after a template change).
 */
async function backfillStep(ctx: PluginContext, restart: boolean, deadline: number, bucket: string): Promise<BackfillState> {
	const settings = await readSocialSettings(ctx);
	const inputs = await templateInputs(ctx, settings, bucket);
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
			const fresh: SocialImageDoc[] = [];
			for (const i of need) {
				const doc = existing.get(docId(schema.slug, i.id));
				if (doc?.status === "pending") continue;
				const stale = !doc || doc.status === "skipped" || !doc.key || ("reason" in inputs ? false : doc.hash !== (await hashFor(inputs, titleOf(schema, i) || i.id)));
				if (!stale) continue;
				// Its current image (if any) stays in use until the new one is made.
				fresh.push({ collection: schema.slug, id: i.id, title: doc?.title ?? "", key: doc?.key ?? null, hash: doc?.hash ?? null, previousKey: doc?.previousKey ?? null, status: "pending", note: null, attempts: 0, updatedAt: now, renderedAt: doc?.renderedAt ?? null });
			}
			if (fresh.length) {
				await socialImages(ctx).putMany(fresh.map((d) => ({ id: docId(d.collection, d.id), data: d })));
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

	/**
	 * Jobs under way in this isolate, by entry. A save or publish while one runs sets `again`, and the job checks
	 * the entry once more when it's done (a publish fires afterSave and afterPublish: one job, then one cheap re-check).
	 */
	const inFlight = new Map<string, { again: boolean }>();

	/**
	 * After a save or publish: compare the entry as published (EmDash hands
	 * afterSave the draft, which is never used) with its record, and make that
	 * entry's image after the response when its title changed. An unchanged
	 * entry (most draft saves) costs a few reads and no writes. What can't be
	 * made now (a rate limit, Browser Run not set up) is queued for the hourly job.
	 */
	const onSaved = async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
		const id = (event.content as { id?: unknown })?.id;
		if (typeof id !== "string" || !id) return;
		const key = docId(event.collection, id);
		const running = inFlight.get(key);
		if (running) {
			running.again = true;
			return;
		}
		const flags = { again: false };
		inFlight.set(key, flags);
		const check = async () => {
			const settings = await readSocialSettings(ctx);
			if (!wanted(settings.collections, event.collection)) return;
			const schema = (await collections(ctx)).find((c) => c.slug === event.collection);
			const item = (await ctx.content?.get(event.collection, id).catch(() => null)) as Item | null;
			if (!schema || !item || item.status !== "published") return;
			if (hasOwnImage(item, schema)) return skip(ctx, event.collection, id, "Has its own image");
			const doc = await socialImages(ctx).get(key);
			if (doc?.status === "ready" && doc.title === titleOf(schema, item)) return;
			const rc = await renderContext(ctx, settings, bucket);
			if ("reason" in rc) return markPending(ctx, event.collection, id, rc.reason);
			try {
				const result = await renderLive(ctx, rc, settings, new Map([[schema.slug, schema]]), event.collection, id);
				if (result.outcome === "rendered") await purgeEntries(ctx, [{ collection: event.collection, id, slug: result.slug }]);
			} catch (error) {
				if (error instanceof RenderError && (error.status === 429 || error.status === NOT_SET_UP)) await markPending(ctx, event.collection, id, error.message);
				else ctx.log.warn("social images: render after publish failed; the hourly job retries", { entry: key, error: String(error) });
			}
		};
		const job = (async () => {
			// At most a few passes: a save during a pass asks for one more (the entry as published then).
			for (let pass = 0; pass < 3; pass++) {
				flags.again = false;
				await check().catch((error: unknown) => ctx.log.warn("social images: couldn't check the entry after a save", { entry: key, error: String(error) }));
				if (!flags.again) break;
			}
		})().finally(() => inFlight.delete(key));
		afterResponse(job);
	};

	/** A deleted entry's images and record go with it. */
	const onDeleted = async (event: { id: string; collection: string }, ctx: PluginContext) => {
		const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
		await removeEntryImage(ctx, env[bucket] as R2Bucket | undefined, event.collection, event.id);
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

		// A normal save (not read-only): the theme default images change which og:image pages get, so the page cache
		// is cleared and every isolate reads the settings again, as with any pack settings save.
		"social/settings/save": definePluginRoute({
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
						defaultImages: z.array(z.string().trim().max(500)).max(10).optional(),
						token: z.string().trim().max(500).optional(),
						clearToken: z.boolean().optional(),
					}),
					ctx.input,
				);
				const bad = (input.defaultImages ?? []).filter((v) => v && !parseDefaultImages([v]).length);
				if (bad.length) throw PluginRouteError.badRequest(`Use a full https URL or a path starting with /: ${bad.slice(0, 3).join(", ")}`);
				const settings = normalizeSocialSettings(input);
				await ctx.settings.set(SETTINGS_KEY, settings);
				if (input.clearToken) await ctx.settings.delete(TOKEN_SETTING);
				else if (input.token) await ctx.settings.set(TOKEN_SETTING, input.token);
				return { settings, tokenSaved: input.clearToken ? false : Boolean(input.token) || Boolean(await ctx.settings.get<string>(TOKEN_SETTING).catch(() => null)) };
			},
		}),

		// The routes below change only Social Images' own records and stored images: read-only for the page cache
		// (an entry's page is purged when its image changes, in renderPending).

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
						const png = await screenshot(await rc.renderer(), socialImageHtml({ title: SAMPLE_TITLE, siteName: rc.siteName, logo: rc.logo.src, settings: rc.template }));
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
					return backfillStep(ctx, Boolean(restart), Date.now() + 15_000, bucket);
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
					// Paid: a few at once; Free (or unknown): two, 10 seconds apart (Browser Run's limit there).
					const paid = (await knownPlan(ctx.kv)) === "paid";
					const result = await renderPending(ctx, { limit: paid ? 4 : 2, deadline: Date.now() + 25_000, bucket });
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
					// A new hash isn't needed: clearing the stored hash makes the render draw it again.
					if (doc) await store.put(docId(input.collection, input.id), { ...doc, hash: null, status: "pending", attempts: 0, note: null, updatedAt: new Date().toISOString() });
					else await markPending(ctx, input.collection, input.id);
					// This entry, now (not the oldest one waiting).
					const settings = await readSocialSettings(ctx);
					const rc = await renderContext(ctx, settings, bucket);
					if ("reason" in rc) return { rendered: 0, skipped: 0, failed: 0, stopped: rc.reason };
					try {
						const result = await renderLive(ctx, rc, settings, new Map((await collections(ctx)).map((c) => [c.slug, c])), input.collection, input.id);
						if (result.outcome === "rendered") await purgeEntries(ctx, [{ collection: input.collection, id: input.id, slug: result.slug }]);
						return { rendered: result.outcome === "skipped" ? 0 : 1, skipped: result.outcome === "skipped" ? 1 : 0, failed: 0 };
					} catch (error) {
						return { rendered: 0, skipped: 0, failed: 1, stopped: error instanceof Error ? error.message : String(error) };
					}
				},
			}),
		),
	};

	return {
		id: "socialImages",
		label: "Social Images",
		features: FEATURES,
		routes,
		// afterSave covers collections without drafts (a save is the publish); a publish fires both, and one job serves them.
		hooks: {
			"content:afterPublish": onSaved,
			"content:afterSave": onSaved,
			"content:afterDelete": onDeleted,
			"content:afterRestore": onSaved,
		},
		tasks: [
			{
				name: SOCIAL_TASK,
				schedule: "@hourly",
				// Scheduled only while Social Images is on. While nothing is pending: one indexed query an hour.
				onlyWhileOn: true,
				handler: async (ctx: PluginContext) => {
					const limit = (await knownPlan(ctx.kv)) === "paid" ? CRON_BATCH.paid : CRON_BATCH.free;
					const result = await renderPending(ctx, { limit, deadline: Date.now() + CRON_MS, bucket });
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

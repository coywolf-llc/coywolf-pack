/**
 * Robots.txt Rules: admin routes. The file itself is served by the pack
 * middleware (./middleware.ts); the URL tester and the validator run in the
 * browser against the generated text (./rep.ts), and the server re-checks
 * every save (shape, contradictions and the self-check) before storing it.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, requireFeature } from "../core/features.js";
import { parseInput, workerEnv } from "../shared.js";
import { type BotOverride, applyOverrides, customSlug, mergeDirectory } from "./bots.js";
import { baselineBots, baselineDate } from "./directory.js";
import { ADDITIONS_NOTES, emdashRobots, importRobots } from "./importer.js";
import { CONFIG_SETTING, invalidateRobotsCache, readEmdashAiTraining, readEmdashCustomRobots } from "./middleware.js";
import { RADAR_TOKEN_SETTING, SYNC_STATE_KEY, type SyncState, radarTokenSource, readOverlays, syncRadar } from "./radar.js";
import { type GroupChange, PRESETS, RULE_KINDS, type RobotsConfig, automaticFrom, generate, isValidToken, normalizeConfig, refreshGroups } from "./rules.js";
import { checkConfig, extraLineWarnings } from "./validate.js";

export const HISTORY_COLLECTION = "robots_history";
export const BOT_OVERRIDES_COLLECTION = "robots_bot_overrides";
const HISTORY_LIMIT = 20;
/** KV flag: the admin closed the "your sitemap isn't listed" note. */
const SITEMAP_NOTE_KEY = "robots:sitemapNoteDismissed";

export interface RobotsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
}

export interface HistoryEntry {
	at: string;
	by?: string;
	label: string;
	config: RobotsConfig;
}

const NO_NEWLINE = /^[^\r\n]*$/;
const oneLine = (max: number) => z.string().max(max).regex(NO_NEWLINE, "Line breaks aren't allowed here.");

const ruleInput = z.object({
	id: z.string().min(1).max(64),
	name: z.string().max(300),
	description: z.string().max(500).optional(),
	enabled: z.boolean(),
	agents: z.array(oneLine(100)).max(1000),
	directive: z.enum(["allow", "disallow"]),
	kind: z.enum(RULE_KINDS),
	path: oneLine(2100).optional(),
	ext: oneLine(20).optional(),
	exts: z.array(oneLine(20)).max(50).optional(),
	params: z.array(oneLine(100)).max(50).optional(),
	allow: oneLine(2100).optional(),
	strict: z.boolean().optional(),
	anyDepth: z.boolean().optional(),
	except: z.array(oneLine(2100)).max(50).optional(),
	group: z.string().max(40).optional(),
	source: z.enum(["user", "import", "template", "legacy"]).optional(),
});

const configInput = z.object({
	version: z.number().optional(),
	rules: z.array(ruleInput).max(200),
	includeSitemap: z.boolean(),
	sitemaps: z.array(oneLine(2000)).max(50),
	allowMedia: z.boolean(),
	comments: z.boolean(),
	extra: z.string().max(20_000),
	inheritGeneral: z.boolean(),
	emdashLines: z.boolean(),
	discoveryAllowances: z.boolean().optional(),
	discoveryPaths: z.array(oneLine(500)).max(50).optional(),
	importedAt: z.string().max(40).optional(),
	importMode: z.enum(["rules", "verbatim"]).optional(),
	importNotes: z.array(z.string().max(500)).max(10).optional(),
});

const siteUrlOf = (ctx: PluginContext) => (ctx.site.url || "").replace(/\/+$/, "");
const who = (ctx: { user?: { name: string | null; email: string } }) => ctx.user?.name || ctx.user?.email || undefined;

async function siteDb(database: string): Promise<D1Database | undefined> {
	try {
		return (await workerEnv())[database] as D1Database | undefined;
	} catch {
		return undefined;
	}
}

/** The robots.txt EmDash itself would serve right now. */
async function emdashServed(database: string, siteUrl: string): Promise<{ text: string; custom: boolean }> {
	const db = await siteDb(database);
	let custom: string | null;
	try {
		if (!db) throw new Error(`no ${database} binding`);
		custom = await readEmdashCustomRobots(db);
	} catch (error) {
		// Never fall back to EmDash's default here: importing or resetting from it could replace a custom file.
		throw PluginRouteError.badRequest(`Couldn't read EmDash's robots.txt settings (${error instanceof Error ? error.message : "database error"}). Nothing was changed; try again.`);
	}
	return { text: emdashRobots(custom, siteUrl || "https://example.com"), custom: Boolean(custom) };
}

/** Top-level sections from EmDash collections' URL patterns (e.g. "/recipes/{slug}" → "/recipes/"), for the rule dialog. */
/** EmDash's "Disallow AI training" (Settings > SEO), which the served robots.txt includes. */
async function emdashAiTraining(database: string): Promise<boolean> {
	const db = await siteDb(database);
	return db ? readEmdashAiTraining(db) : false;
}

async function siteSections(database: string): Promise<Array<{ label: string; path: string }>> {
	const db = await siteDb(database);
	if (!db) return [];
	try {
		const { results } = await db.prepare("SELECT label, url_pattern FROM _emdash_collections WHERE url_pattern IS NOT NULL").all<{ label: string; url_pattern: string }>();
		const out: Array<{ label: string; path: string }> = [];
		for (const row of results ?? []) {
			const head = row.url_pattern.split("{")[0];
			const path = head.slice(0, head.lastIndexOf("/") + 1);
			if (path.length > 1 && path.startsWith("/") && !out.some((o) => o.path === path)) out.push({ label: row.label, path });
		}
		return out.slice(0, 12);
	} catch {
		return [];
	}
}

async function readHistory(ctx: PluginContext): Promise<Array<{ id: string; data: HistoryEntry }>> {
	const collection = ctx.storage[HISTORY_COLLECTION];
	if (!collection) return [];
	const page = await collection.query({ limit: 100 });
	return (page.items as Array<{ id: string; data: HistoryEntry }>).sort((a, b) => b.data.at.localeCompare(a.data.at));
}

async function pushHistory(ctx: PluginContext, entry: HistoryEntry): Promise<void> {
	const collection = ctx.storage[HISTORY_COLLECTION];
	if (!collection) return;
	const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	await collection.put(id, entry);
	const all = await readHistory(ctx);
	const stale = all.slice(HISTORY_LIMIT).map((e) => e.id);
	if (stale.length) await collection.deleteMany(stale);
}

async function readBotOverrides(ctx: PluginContext): Promise<BotOverride[]> {
	const collection = ctx.storage[BOT_OVERRIDES_COLLECTION];
	if (!collection) return [];
	const out: BotOverride[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 20; i++) {
		const page = await collection.query({ limit: 100, ...(cursor ? { cursor } : {}) });
		for (const item of page.items) out.push(item.data as BotOverride);
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}
	return out;
}

/**
 * The saved config, importing EmDash's robots.txt first when nothing is saved
 * yet. compareAndSet(null) only creates when absent, so a concurrent import
 * from the middleware (or another admin tab) wins cleanly.
 */
async function loadOrImport(ctx: PluginContext, database: string): Promise<RobotsConfig> {
	const stored = await ctx.settings.get<Partial<RobotsConfig>>(CONFIG_SETTING);
	if (stored && !stored.version) {
		// Saved before 0.7.0: store the migrated shape once, and say what's new.
		const migrated = { ...normalizeConfig(stored), importNotes: [...ADDITIONS_NOTES] };
		await ctx.settings.set(CONFIG_SETTING, migrated);
		invalidateRobotsCache();
		return migrated;
	}
	if (stored) return normalizeConfig(stored);
	const siteUrl = siteUrlOf(ctx);
	const { text } = await emdashServed(database, siteUrl);
	const { config } = importRobots(text, siteUrl || "https://example.com");
	const result = await ctx.settings.compareAndSet(CONFIG_SETTING, null, config);
	if (result.applied) {
		invalidateRobotsCache();
		await pushHistory(ctx, { at: new Date().toISOString(), label: "Imported from EmDash's robots.txt", config }).catch(() => undefined);
		ctx.log.info("Robots: imported EmDash's robots.txt", { rules: config.rules.length, mode: config.importMode });
		return config;
	}
	return normalizeConfig(await ctx.settings.get<Partial<RobotsConfig>>(CONFIG_SETTING));
}

async function persist(ctx: PluginContext, database: string, config: RobotsConfig, label: string, by: string | undefined) {
	const siteUrl = siteUrlOf(ctx);
	const { automatic: _ignored, ...stored } = config;
	const live: RobotsConfig = { ...stored, automatic: automaticFrom(await ctxFeatures(ctx), await emdashAiTraining(database)) };
	const problem = checkConfig(live, siteUrl || undefined);
	if (problem) throw PluginRouteError.badRequest(problem);
	const preview = generate(live, { siteUrl });
	if (new TextEncoder().encode(preview).length > 500 * 1024) {
		throw PluginRouteError.badRequest("That robots.txt would be over 500 KiB, the most Google reads. Remove some rules.");
	}
	await ctx.settings.set(CONFIG_SETTING, stored);
	invalidateRobotsCache();
	await pushHistory(ctx, { at: new Date().toISOString(), by, label, config: stored }).catch((error) => ctx.log.warn("Robots: history not saved", { error: String(error) }));
	ctx.log.info("Robots.txt rules saved", { rules: config.rules.length, label });
	return { config: live, preview, saved: true, warnings: extraLineWarnings(live, siteUrl || undefined) };
}

const httpUrl = z
	.string()
	.url()
	.max(2000)
	.refine((u) => /^https?:\/\//i.test(u), "Use a web address starting with https:// or http://.");

const botAction = z.discriminatedUnion("action", [
	z.object({ action: z.literal("verify"), slug: z.string().min(1).max(120), sourceUrl: httpUrl, note: z.string().max(500).optional() }),
	z.object({ action: z.literal("unverify"), slug: z.string().min(1).max(120) }),
	z.object({ action: z.literal("rename"), slug: z.string().min(1).max(120), name: z.string().trim().min(1).max(120) }),
	z.object({
		action: z.literal("save-custom"),
		slug: z.string().max(120).optional(),
		name: z.string().trim().min(1).max(120),
		token: z.string().trim().min(1).max(100),
		category: z.string().min(1).max(60),
		purpose: z.enum(["training", "ai-search", "ai-assistant", "search-engine", "seo", "other"]).optional(),
		operator: z.string().max(120).optional(),
		sourceUrl: z.union([httpUrl, z.literal("")]).optional(),
		notes: z.string().max(500).optional(),
	}),
	z.object({ action: z.literal("delete"), slug: z.string().min(1).max(120) }),
	z.object({ action: z.literal("reset"), slug: z.string().min(1).max(120) }),
]);

export function robotsModule(options: RobotsOptions) {
	const database = options.database ?? "DB";

	const routes = {
		/** Saved rules (importing EmDash's file on first load), the served file, EmDash's original, history and sync status. */
		"robots/get": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, "robots");
				const loaded = await loadOrImport(ctx, database);
				// Rules made from a crawler preset follow the preset's current members.
				const [overlays, overrides] = await Promise.all([readOverlays(ctx), readBotOverrides(ctx)]);
				const refreshed = refreshGroups(loaded, applyOverrides(mergeDirectory(await baselineBots(), overlays), overrides));
				let groupChanges: GroupChange[] = [];
				if (JSON.stringify(refreshed.config.rules) !== JSON.stringify(loaded.rules)) {
					await ctx.settings.set(CONFIG_SETTING, refreshed.config);
					invalidateRobotsCache();
					groupChanges = refreshed.changes;
					if (groupChanges.length) {
						await pushHistory(ctx, { at: new Date().toISOString(), label: "Updated crawler groups", config: refreshed.config }).catch(() => undefined);
						ctx.log.info("Robots: rules updated to the current crawler groups", { rules: groupChanges.length });
					}
				}
				const config: RobotsConfig = { ...refreshed.config, automatic: automaticFrom(await ctxFeatures(ctx), await emdashAiTraining(database)) };
				const siteUrl = siteUrlOf(ctx);
				const tokenSource = await radarTokenSource(ctx);
				const emdash = await emdashServed(database, siteUrl).catch(() => ({ text: "EmDash's robots.txt couldn't be read right now.", custom: false }));
				let history = await readHistory(ctx).catch(() => []);
				if (!history.length) {
					// Rules imported by the middleware (or saved before 0.7.0) get a first version to restore to.
					await pushHistory(ctx, { at: new Date().toISOString(), label: config.importedAt ? "Imported from EmDash's robots.txt" : "Rules before version history", config }).catch(() => undefined);
					history = await readHistory(ctx).catch(() => []);
				}
				return {
					config,
					saved: true,
					siteUrl,
					preview: generate(config, { siteUrl }),
					emdash,
					history: history.map((h) => ({ id: h.id, at: h.data.at, by: h.data.by, label: h.data.label, rules: h.data.config.rules.length })),
					groupChanges,
					warnings: extraLineWarnings(config, siteUrl || undefined),
					sitemapNoteDismissed: (await ctx.kv.get<boolean>(SITEMAP_NOTE_KEY)) === true,
					presets: PRESETS,
					sections: await siteSections(database),
					radar: {
						tokenSource,
						tokenConfigured: Boolean(tokenSource),
						state: await ctx.kv.get<SyncState>(SYNC_STATE_KEY),
						baselineDate: await baselineDate(),
					},
				};
			},
		},

		/** Close the "your sitemap isn't listed" note for good. */
		"robots/dismiss-sitemap-note": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await ctx.kv.set(SITEMAP_NOTE_KEY, true);
				return { dismissed: true };
			},
		}),

		/** The crawler directory (bundled baseline + Radar overlay + this site's verifications, renames and custom bots). */
		"robots/bots": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, "robots");
				const [overlays, overrides] = await Promise.all([readOverlays(ctx), readBotOverrides(ctx)]);
				return { bots: applyOverrides(mergeDirectory(await baselineBots(), overlays), overrides) };
			},
		},

		"robots/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json", maxBytes: 512 * 1024 },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots");
				const input = parseInput(z.object({ config: configInput, label: z.string().max(200).optional() }), ctx.input);
				const config = normalizeConfig(input.config as RobotsConfig);
				return persist(ctx, database, config, input.label?.trim() || "Saved", who(ctx));
			},
		}),

		/** Restore a saved version (it becomes a new version, so restoring can be undone). */
		"robots/restore": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots");
				const { id } = parseInput(z.object({ id: z.string().min(1).max(64) }), ctx.input);
				const entry = (await ctx.storage[HISTORY_COLLECTION]?.get(id)) as HistoryEntry | null | undefined;
				if (!entry) throw PluginRouteError.notFound("That version is no longer kept.");
				const date = new Date(entry.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
				return persist(ctx, database, normalizeConfig(entry.config), `Restored the version from ${date} UTC`, who(ctx));
			},
		}),

		/** Start over from the robots.txt EmDash would serve now. */
		"robots/reset": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots");
				const siteUrl = siteUrlOf(ctx);
				const { text } = await emdashServed(database, siteUrl);
				const { config } = importRobots(text, siteUrl || "https://example.com");
				return persist(ctx, database, config, "Reset to EmDash's original", who(ctx));
			},
		}),

		/** Verify, rename, add, edit or delete crawler directory entries for this site. */
		"robots/bot": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots");
				const input = parseInput(botAction, ctx.input);
				const collection = ctx.storage[BOT_OVERRIDES_COLLECTION];
				if (!collection) throw PluginRouteError.badRequest("Plugin storage isn't available.");
				const current = ((await collection.get(input.slug ?? "")) as BotOverride | null) ?? null;
				const by = who(ctx);
				const now = new Date().toISOString();
				switch (input.action) {
					case "verify":
						await collection.put(input.slug, { ...(current ?? { slug: input.slug }), verified: { sourceUrl: input.sourceUrl, note: input.note?.trim() || undefined, at: now, by } });
						break;
					case "unverify":
						if (current) await collection.put(input.slug, { ...current, verified: undefined });
						break;
					case "rename":
						await collection.put(input.slug, { ...(current ?? { slug: input.slug }), name: input.name });
						break;
					case "save-custom": {
						if (!isValidToken(input.token) || input.token === "*") {
							throw PluginRouteError.badRequest("A robots.txt token uses only letters, digits, dot, underscore and dash (like ExampleBot).");
						}
						const slug = input.slug || customSlug(input.token);
						const existing = ((await collection.get(slug)) as BotOverride | null) ?? null;
						if (!input.slug && existing) throw PluginRouteError.badRequest(`You already added a bot with the token ${input.token}.`);
						if (input.slug && !existing?.custom) throw PluginRouteError.badRequest("Only bots you added can be edited this way.");
						const directory = mergeDirectory(await baselineBots(), await readOverlays(ctx));
						const clash = directory.find((b) => b.token.toLowerCase() === input.token.toLowerCase());
						if (clash && !input.slug) throw PluginRouteError.badRequest(`${input.token} is already in the directory as ${clash.name}.`);
						await collection.put(slug, {
							...(existing ?? {}),
							slug,
							name: input.name,
							custom: {
								token: input.token,
								category: input.category,
								purpose: input.purpose,
								operator: input.operator?.trim() || undefined,
								sourceUrl: input.sourceUrl || undefined,
								notes: input.notes?.trim() || undefined,
								createdAt: existing?.custom?.createdAt ?? now,
								createdBy: existing?.custom?.createdBy ?? by,
							},
						} satisfies BotOverride);
						break;
					}
					case "delete":
						if (!current?.custom) throw PluginRouteError.badRequest("Only bots you added can be deleted.");
						await collection.delete(input.slug);
						break;
					case "reset":
						await collection.delete(input.slug);
						break;
				}
				ctx.log.info("Robots: crawler directory changed", { action: input.action, slug: input.slug ?? "" });
				const [overlays, overrides] = await Promise.all([readOverlays(ctx), readBotOverrides(ctx)]);
				return { bots: applyOverrides(mergeDirectory(await baselineBots(), overlays), overrides) };
			},
		}),

		/** Save (or remove) the Radar API token. It's a secret setting, so EmDash stores it encrypted. */
		"robots/radar-token": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots");
				const input = parseInput(z.object({ token: z.string().trim().max(500).optional(), clear: z.boolean().optional() }), ctx.input);
				if (input.clear) await ctx.settings.delete(RADAR_TOKEN_SETTING);
				else if (input.token) await ctx.settings.set(RADAR_TOKEN_SETTING, input.token);
				else throw PluginRouteError.badRequest("Enter a Cloudflare Radar API token.");
				ctx.log.info(input.clear ? "Radar token removed" : "Radar token saved");
				const tokenSource = await radarTokenSource(ctx);
				return { tokenSource, tokenConfigured: Boolean(tokenSource) };
			},
		}),

		/** Refresh the crawler directory from Cloudflare Radar now. */
		"robots/refresh": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots.radarSync");
				try {
					return await syncRadar(ctx);
				} catch (error) {
					throw PluginRouteError.badRequest(error instanceof Error ? error.message : "Radar sync failed");
				}
			},
		}),
	};

	return { routes };
}


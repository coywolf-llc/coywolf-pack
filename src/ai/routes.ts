/**
 * AI Enrichment admin routes (/_emdash/api/plugins/coywolf-pack/ai/*).
 * Everything that costs a model call is gated by its feature switch.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, isOn, requireFeature } from "../core/features.js";
import { parseInput } from "../shared.js";
import { type QueueJob, cleanText, DESCRIPTION_MAX, ALT_MAX, CAPTION_MAX } from "./logic.js";
import { type ModelOption, PROVIDERS, chat, listModels } from "./providers.js";
import {
	type AiOptions,
	type BulkState,
	type EntryRecord,
	type MediaRecord,
	type UsageRow,
	SETTINGS_SCHEMA,
	bulkKey,
	callsToday,
	col,
	enqueue,
	entryKey,
	lockHeld,
	logUsage,
	providerConfig,
	publicSettings,
	queueCounts,
	readSettings,
	takeCall,
} from "./store.js";
import { applyDescription, applyImageText, targetCollections, tick } from "./worker.js";
import { readOnlyRoute } from "../core/routes.js";

const asCtx = (ctx: unknown) => ctx as PluginContext;
/** Model lists per provider, per isolate (keyed to the saved key so a new key refetches). */
const modelCache = new Map<string, { key: string; at: number; models: ModelOption[] }>();

const settingsInput = z.object({
	aiProvider: z.enum(["workers-ai", "anthropic", "openai", "gemini"]).optional(),
	aiModel: z.string().max(200).optional(),
	aiVisionModel: z.string().max(200).optional(),
	/** A new key; omit to keep the saved one. */
	aiApiKey: z.string().max(500).optional(),
	clearApiKey: z.boolean().optional(),
	aiMaxCallsPerDay: z.number().int().min(1).max(100000).optional(),
	aiJobsPerTick: z.number().int().min(1).max(20).optional(),
	aiCollections: z.string().max(2000).optional(),
	aiDebounceMinutes: z.number().int().min(0).max(120).optional(),
	aiDescriptionsMode: z.enum(["suggest", "apply"]).optional(),
	aiImageMode: z.enum(["apply", "suggest"]).optional(),
	aiImageCaption: z.boolean().optional(),
	aiImageOverwrite: z.boolean().optional(),
	aiImageInstructions: z.string().max(4000).optional(),
});

const entryRef = z.object({ collection: z.string().min(1).max(200), id: z.string().min(1).max(200) });
const listInput = z.object({ cursor: z.string().max(2000).optional(), filter: z.string().max(40).optional() });

async function featureForBulk(ctx: PluginContext, kind: BulkState["kind"]) {
	const features = await ctxFeatures(ctx);
	const on = kind === "media" ? isOn(features, "ai.imageText") : isOn(features, "ai.entities") || isOn(features, "ai.descriptions");
	if (!on) throw PluginRouteError.notFound("Turn on the matching AI feature first (Coywolf Pack → Features, or the AI Enrichment page).");
}

export function aiRoutes(options: AiOptions) {
	return {
		"ai/status": {
			permission: "plugins:manage" as const,
			handler: async (raw: unknown) => {
				const ctx = asCtx(raw);
				const settings = await readSettings(ctx, options);
				const features = await ctxFeatures(ctx);
				const [entriesBulk, mediaBulk] = await Promise.all([ctx.kv.get<BulkState>(bulkKey("entries")), ctx.kv.get<BulkState>(bulkKey("media"))]);
				return {
					settings: publicSettings(settings),
					providers: PROVIDERS,
					features: {
						ai: isOn(features, "ai"),
						entities: isOn(features, "ai.entities"),
						descriptions: isOn(features, "ai.descriptions"),
						imageText: isOn(features, "ai.imageText"),
						entitiesStandalone: isOn(features, "ai.entitiesStandalone"),
					},
					queue: await queueCounts(ctx),
					bulk: { entries: entriesBulk, media: mediaBulk },
					callsToday: await callsToday(ctx),
					running: await lockHeld(ctx),
					collections: await targetCollections(ctx, settings).catch(() => []),
				};
			},
		},

		"ai/settings": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(settingsInput, ctx.input);
				const { aiApiKey, clearApiKey, ...rest } = input;
				for (const [key, value] of Object.entries(rest)) {
					if (value !== undefined && key in SETTINGS_SCHEMA) await ctx.settings.set(key, typeof value === "string" ? value.trim() : value);
				}
				if (clearApiKey) await ctx.settings.delete("aiApiKey");
				else if (aiApiKey?.trim()) await ctx.settings.set("aiApiKey", aiApiKey.trim());
				ctx.log.info("AI settings saved", { keys: Object.keys(rest), apiKeyChanged: Boolean(clearApiKey || aiApiKey) });
				return { settings: publicSettings(await readSettings(ctx, options)) };
			},
		}),

		/** Models the saved key (or Workers AI) can use, for the settings page's pickers. No model call. */
		"ai/models": {
			permission: "plugins:manage" as const,
			handler: async (raw: unknown) => {
				const ctx = asCtx(raw);
				const s = await readSettings(ctx, options);
				if (s.provider !== "workers-ai" && !s.apiKey) return { provider: s.provider, models: [] as ModelOption[] };
				const cached = modelCache.get(s.provider);
				if (cached && cached.key === s.apiKey && Date.now() - cached.at < 10 * 60_000) return { provider: s.provider, models: cached.models };
				try {
					const cfg = await providerConfig(ctx, options, s, false);
					const models = await listModels(cfg);
					modelCache.set(s.provider, { key: s.apiKey, at: Date.now(), models });
					return { provider: s.provider, models };
				} catch (error) {
					return { provider: s.provider, models: [] as ModelOption[], error: String((error as Error).message ?? error).slice(0, 200) };
				}
			},
		},

		/** One tiny real call with the saved settings. Counts toward the daily limit. */
		"ai/test": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				await requireFeature(ctx, "ai");
				const s = await readSettings(ctx, options);
				if (!(await takeCall(ctx, s.maxCallsPerDay))) return { ok: false, error: "Today's call limit is reached." };
				const cfg = await providerConfig(ctx, options, s, false);
				const started = Date.now();
				try {
					const result = await chat(cfg, { system: "Reply with exactly: OK", user: "ping", maxTokens: 20 });
					await logUsage(ctx, { feature: "test", provider: s.provider, model: cfg.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: true });
					return { ok: result.text.trim().length > 0, reply: cleanText(result.text, 100), provider: s.provider, model: cfg.model, ms: Date.now() - started };
				} catch (error) {
					const message = String((error as Error).message ?? error).slice(0, 300);
					await logUsage(ctx, { feature: "test", provider: s.provider, model: cfg.model, inputTokens: 0, outputTokens: 0, ok: false, error: message });
					return { ok: false, error: message, provider: s.provider, model: cfg.model };
				}
			},
		})),

		/** Start a bulk run. The cron tick turns it into queue jobs a page at a time. */
		"ai/bulk": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				const { kind, force } = parseInput(z.object({ kind: z.enum(["entries", "media"]), force: z.boolean().optional() }), (raw as { input: unknown }).input);
				await featureForBulk(ctx, kind);
				const s = await readSettings(ctx, options);
				const state: BulkState = {
					kind,
					force: force ?? false,
					collections: kind === "entries" ? await targetCollections(ctx, s) : [],
					queued: 0,
					skipped: 0,
					started: new Date().toISOString(),
				};
				await ctx.kv.set(bulkKey(kind), state);
				return { bulk: state };
			},
		}),

		/** Stop a bulk run and drop its queued jobs. */
		"ai/bulk/cancel": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				const { kind } = parseInput(z.object({ kind: z.enum(["entries", "media"]) }), (raw as { input: unknown }).input);
				await ctx.kv.delete(bulkKey(kind));
				const queue = col<QueueJob>(ctx, "aiQueue");
				let removed = 0;
				for (let i = 0; i < 20; i++) {
					const page = await queue.query({ where: { kind: kind === "media" ? "media" : "entry" }, limit: 100 });
					if (!page.items.length) break;
					removed += await queue.deleteMany(page.items.map((j) => j.id));
				}
				return { removed };
			},
		}),

		/** Process one queued item now (for trying settings without waiting for the schedule). */
		"ai/run": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				await requireFeature(ctx, "ai");
				return tick(ctx, options, { maxJobs: 1, budgetMs: 20_000 });
			},
		}),

		"ai/entries": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				const { cursor, filter } = parseInput(listInput, (raw as { input: unknown }).input);
				const where: Record<string, string> | undefined = filter === "suggested" ? { descriptionStatus: "suggested" } : filter === "error" ? { status: "error" } : undefined;
				const page = await col<EntryRecord>(ctx, "aiEntries").query({ where, orderBy: { updated: "desc" }, limit: 50, cursor });
				return { items: page.items.map((i) => i.data), cursor: page.cursor, hasMore: page.hasMore };
			},
		})),

		/** One entry's analysis, for the entry editor's AI suggestions panel. */
		"ai/entry": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				await requireFeature(ctx, "ai");
				const { collection, id } = parseInput(entryRef, (raw as { input: unknown }).input);
				const [record, features, collections] = await Promise.all([
					col<EntryRecord>(ctx, "aiEntries").get(entryKey(collection, id)),
					ctxFeatures(ctx),
					readSettings(ctx, options).then((s) => targetCollections(ctx, s)).catch(() => null),
				]);
				return {
					record: record ?? null,
					covered: !collections || collections.includes(collection),
					features: { entities: isOn(features, "ai.entities"), descriptions: isOn(features, "ai.descriptions") },
				};
			},
		})),

		"ai/entry/reanalyze": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				const features = await ctxFeatures(ctx);
				if (!isOn(features, "ai.entities") && !isOn(features, "ai.descriptions")) throw PluginRouteError.notFound("Turn on AI entities or descriptions first.");
				const { collection, id } = parseInput(entryRef, (raw as { input: unknown }).input);
				await enqueue(ctx, { kind: "entry", collection, entryId: id, due: Date.now(), force: true });
				return { queued: true };
			},
		}),

		"ai/description/apply": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				await requireFeature(ctx, "ai.descriptions");
				const input = parseInput(entryRef.extend({ description: z.string().min(1).max(500), replace: z.boolean().optional() }), (raw as { input: unknown }).input);
				const description = cleanText(input.description, DESCRIPTION_MAX * 2);
				const applied = await applyDescription(ctx, input.collection, input.id, description, input.replace ?? false);
				if (!applied) throw PluginRouteError.badRequest("This entry already has a meta description (or its collection has no SEO panel). Choose Replace to overwrite it.");
				const records = col<EntryRecord>(ctx, "aiEntries");
				const key = entryKey(input.collection, input.id);
				const prev = await records.get(key);
				if (prev) await records.put(key, { ...prev, description, descriptionStatus: "applied", updated: new Date().toISOString() });
				return { applied: true };
			},
		}),

		"ai/description/dismiss": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				const { collection, id } = parseInput(entryRef, (raw as { input: unknown }).input);
				const records = col<EntryRecord>(ctx, "aiEntries");
				const prev = await records.get(entryKey(collection, id));
				if (prev) await records.put(entryKey(collection, id), { ...prev, descriptionStatus: "dismissed", updated: new Date().toISOString() });
				return { dismissed: true };
			},
		}),

		"ai/media": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				const { cursor, filter } = parseInput(listInput, (raw as { input: unknown }).input);
				const where: Record<string, string> | undefined = filter && ["suggested", "applied", "skipped", "error"].includes(filter) ? { status: filter } : undefined;
				const page = await col<MediaRecord>(ctx, "aiMedia").query({ where, orderBy: { updated: "desc" }, limit: 50, cursor });
				return { items: page.items.map((i) => i.data), cursor: page.cursor, hasMore: page.hasMore };
			},
		})),

		"ai/media/generate": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				await requireFeature(ctx, "ai.imageText");
				const { mediaId } = parseInput(z.object({ mediaId: z.string().min(1).max(200) }), (raw as { input: unknown }).input);
				await enqueue(ctx, { kind: "media", mediaId, due: Date.now(), force: true });
				return { queued: true };
			},
		}),

		"ai/media/apply": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				await requireFeature(ctx, "ai.imageText");
				const input = parseInput(
					z.object({ mediaId: z.string().min(1).max(200), alt: z.string().max(1000).optional(), caption: z.string().max(1000).optional(), replace: z.boolean().optional() }),
					(raw as { input: unknown }).input,
				);
				const alt = cleanText(input.alt ?? "", ALT_MAX);
				const caption = cleanText(input.caption ?? "", CAPTION_MAX);
				const written = await applyImageText(ctx, input.mediaId, { alt, caption }, { caption: Boolean(caption), overwrite: input.replace ?? false });
				const records = col<MediaRecord>(ctx, "aiMedia");
				const prev = await records.get(input.mediaId);
				if (prev && written.length) await records.put(input.mediaId, { ...prev, status: "applied", written, updated: new Date().toISOString() });
				return { written };
			},
		}),

		"ai/media/dismiss": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				const { mediaId } = parseInput(z.object({ mediaId: z.string().min(1).max(200) }), (raw as { input: unknown }).input);
				const records = col<MediaRecord>(ctx, "aiMedia");
				const prev = await records.get(mediaId);
				if (prev) await records.put(mediaId, { ...prev, status: "dismissed", updated: new Date().toISOString() });
				return { dismissed: true };
			},
		}),

		"ai/usage": {
			permission: "plugins:manage" as const,
			handler: async (raw: unknown) => {
				const ctx = asCtx(raw);
				const page = await col<UsageRow>(ctx, "aiUsage").query({ orderBy: { time: "desc" }, limit: 100 });
				return { items: page.items.map((i) => i.data), callsToday: await callsToday(ctx) };
			},
		},

		"ai/queue/clear": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (raw) => {
				const ctx = asCtx(raw);
				const queue = col<QueueJob>(ctx, "aiQueue");
				let removed = 0;
				for (let i = 0; i < 20; i++) {
					const page = await queue.query({ limit: 100 });
					if (!page.items.length) break;
					removed += await queue.deleteMany(page.items.map((j) => j.id));
				}
				await ctx.kv.delete(bulkKey("entries"));
				await ctx.kv.delete(bulkKey("media"));
				return { removed };
			},
		}),
	};
}

/**
 * AI Enrichment state: settings, plugin-storage records, the job queue, the
 * daily call counter, the usage log, and a cron lock.
 *
 * Storage collections (plugin storage, D1):
 *   aiQueue   — pending jobs, id "entry:<collection>:<id>" or "media:<id>"
 *   aiEntries — per-entry analysis: hash, entities, description suggestion
 *   aiMedia   — per-image suggestion and what was written
 *   aiUsage   — one row per model call (kept 30 days)
 *   aiGlossary — glossary.io's entity index ("index"), refreshed about daily, and
 *               what Remove links to deleted terms tracks ("gone"; src/ai/glossary-gone.ts)
 *   aiLinks   — glossary.io links per entry: QIDs linked, text hash, links to
 *               remove, retries
 */
import type { PluginContext, StorageCollection } from "emdash";

import { workerEnv } from "../shared.js";
import { type Entity, type ImageText, type QueueJob, dayKey, mergeJob, queueId } from "./logic.js";
import { PROVIDERS, type ProviderConfig, type ProviderId } from "./providers.js";

export interface AiOptions {
	/** Workers AI binding name. Default "AI". */
	binding?: string;
	/** Cloudflare Images binding used to downscale large images before analysis. Default "IMAGES". */
	images?: string;
	/** glossary.io links (part "ai.glossaryLinks"; src/ai/glossary-linker.ts). */
	glossaryLinks?: {
		/**
		 * The site's other domains: links to them are never switched. The site's own
		 * host always counts. "name.*" matches every domain with that name
		 * ("coywolf.*": coywolf.com, coywolf.pro, forum.coywolf.com).
		 */
		ownHosts?: string[];
		/** The site's short-link domains for affiliate links (e.g. "coywolf.io"): never switched, and the entity they name gets no glossary link. */
		shortHosts?: string[];
		/** Entry slugs never linked (legal pages, link directories), in any collection; "posts:slug" for one collection. */
		skip?: string[];
		/**
		 * After this part publishes its own link-only edit, put the entry's updated
		 * date back (needs the site's D1 binding, DB). Default false.
		 */
		keepDates?: boolean;
	};
}

export const STORAGE = {
	aiQueue: { indexes: ["due", "kind"] },
	aiEntries: { indexes: ["collection", "status", "descriptionStatus", "updated"] },
	aiMedia: { indexes: ["status", "updated"] },
	aiUsage: { indexes: ["time"] },
	/** glossary.io's entity index ("index"; src/ai/glossary.ts) and the deleted-term checks ("gone"; src/ai/glossary-gone.ts). */
	aiGlossary: { indexes: [] as string[] },
	/** glossary.io links: what each entry's links remember (LinkMemo in src/ai/glossary-linker.ts). Kept when an entry is trashed. */
	aiLinks: { indexes: ["retryAt"] },
};

export const SETTINGS_SCHEMA = {
	aiProvider: {
		type: "select" as const,
		label: "AI: provider",
		description: "Workers AI runs on your Cloudflare account (needs the AI binding). The others need your own API key.",
		options: PROVIDERS.map((p) => ({ value: p.id, label: p.label })),
		default: "workers-ai",
	},
	aiModel: { type: "string" as const, label: "AI: text model", description: "Leave blank for the provider's default." },
	aiVisionModel: { type: "string" as const, label: "AI: image model", description: "Must accept images. Leave blank for the provider's default." },
	aiApiKey: { type: "secret" as const, label: "AI: API key", description: "For Anthropic, OpenAI, or Gemini. Stored encrypted." },
	aiMaxCallsPerDay: { type: "number" as const, label: "AI: max model calls per day", min: 1, max: 100000, default: 200 },
	aiJobsPerTick: { type: "number" as const, label: "AI: items per scheduled run", description: "Scheduled runs happen every two minutes, or with each cron tick if the site's cron runs less often.", min: 1, max: 20, default: 3 },
	aiCollections: { type: "string" as const, label: "AI: collections", description: "Comma-separated collection slugs. Blank = every public collection." },
	aiDebounceMinutes: { type: "number" as const, label: "AI: wait after a save (minutes)", min: 0, max: 120, default: 2 },
	aiDescriptionsMode: {
		type: "select" as const,
		label: "AI: meta descriptions",
		options: [
			{ value: "suggest", label: "Suggest (review on the AI page)" },
			{ value: "apply", label: "Fill empty descriptions automatically" },
		],
		default: "suggest",
	},
	aiImageMode: {
		type: "select" as const,
		label: "AI: image text",
		options: [
			{ value: "apply", label: "Fill empty alt text automatically" },
			{ value: "suggest", label: "Suggest (review on the AI page)" },
		],
		default: "apply",
	},
	aiImageCaption: { type: "boolean" as const, label: "AI: also write captions", default: false },
	aiImageOverwrite: { type: "boolean" as const, label: "AI: overwrite existing alt text and captions", default: false },
	aiImageInstructions: { type: "string" as const, label: "AI: extra image instructions", multiline: true },
};

export interface AiSettings {
	provider: ProviderId;
	textModel: string;
	visionModel: string;
	apiKeySet: boolean;
	maxCallsPerDay: number;
	jobsPerTick: number;
	collections: string[];
	debounceMinutes: number;
	descriptionsMode: "suggest" | "apply";
	imageMode: "apply" | "suggest";
	imageCaption: boolean;
	imageOverwrite: boolean;
	imageInstructions: string;
	bindingAvailable: boolean;
	imagesBindingAvailable: boolean;
}

type Ctx = Pick<PluginContext, "settings" | "storage" | "kv" | "log"> & Partial<Pick<PluginContext, "http">>;

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
	const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
	return Math.min(max, Math.max(min, Math.round(v)));
};

export async function bindings(options: AiOptions) {
	const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
	const ai = env[options.binding ?? "AI"] as ProviderConfig["binding"] | undefined;
	const images = env[options.images ?? "IMAGES"] as ImagesBinding | undefined;
	return { ai: ai && typeof ai.run === "function" ? ai : undefined, images: images && typeof images.input === "function" ? images : undefined };
}

export async function readSettings(ctx: Pick<PluginContext, "settings">, options: AiOptions): Promise<AiSettings & { apiKey: string }> {
	const keys = Object.keys(SETTINGS_SCHEMA) as Array<keyof typeof SETTINGS_SCHEMA>;
	const [{ ai, images }, values] = await Promise.all([
		bindings(options),
		Promise.all(keys.map((key) => ctx.settings.get<unknown>(key).catch(() => null))),
	]);
	const v = Object.fromEntries(keys.map((key, i) => [key, values[i]])) as Record<keyof typeof SETTINGS_SCHEMA, unknown>;
	const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
	const stored = str(v.aiProvider) as ProviderId;
	const provider: ProviderId = PROVIDERS.some((p) => p.id === stored) ? stored : ai ? "workers-ai" : "anthropic";
	const def = PROVIDERS.find((p) => p.id === provider)!;
	const apiKey = str(v.aiApiKey);
	return {
		provider,
		textModel: str(v.aiModel) || def.textModel,
		visionModel: str(v.aiVisionModel) || def.visionModel,
		apiKey,
		apiKeySet: apiKey.length > 0,
		maxCallsPerDay: clamp(v.aiMaxCallsPerDay, 1, 100000, 200),
		jobsPerTick: clamp(v.aiJobsPerTick, 1, 20, 3),
		collections: str(v.aiCollections)
			.split(",")
			.map((c) => c.trim())
			.filter(Boolean),
		debounceMinutes: clamp(v.aiDebounceMinutes, 0, 120, 2),
		descriptionsMode: v.aiDescriptionsMode === "apply" ? "apply" : "suggest",
		imageMode: v.aiImageMode === "suggest" ? "suggest" : "apply",
		imageCaption: v.aiImageCaption === true,
		imageOverwrite: v.aiImageOverwrite === true,
		imageInstructions: typeof v.aiImageInstructions === "string" ? v.aiImageInstructions : "",
		bindingAvailable: Boolean(ai),
		imagesBindingAvailable: Boolean(images),
	};
}

/** Settings safe to send to the admin (no key). */
export function publicSettings(s: AiSettings & { apiKey: string }): AiSettings {
	const { apiKey: _omit, ...rest } = s;
	return rest;
}

export async function providerConfig(ctx: Ctx, options: AiOptions, s: AiSettings & { apiKey: string }, vision: boolean): Promise<ProviderConfig> {
	const { ai } = await bindings(options);
	return {
		provider: s.provider,
		model: vision ? s.visionModel : s.textModel,
		apiKey: s.apiKey,
		binding: ai,
		fetch: (url, init) => (ctx.http ? ctx.http.fetch(url, init) : fetch(url, init)),
	};
}

// ── Storage records ──────────────────────────────────────────────

export interface EntryRecord {
	collection: string;
	entryId: string;
	title: string;
	hash: string;
	status: "ok" | "error";
	error: string;
	entities: Entity[];
	/** AI-written description and what happened to it. */
	description: string;
	descriptionStatus: "none" | "suggested" | "applied" | "dismissed";
	updated: string;
}

export interface MediaRecord {
	mediaId: string;
	filename: string;
	url: string;
	suggestion: ImageText | null;
	status: "suggested" | "applied" | "skipped" | "error" | "dismissed";
	written: string[];
	error: string;
	updated: string;
}

export interface UsageRow {
	time: string;
	feature: "entities" | "descriptions" | "imageText" | "test";
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	ok: boolean;
	error?: string;
	ref?: string;
}

export function col<T>(ctx: Pick<PluginContext, "storage">, name: keyof typeof STORAGE): StorageCollection<T> {
	return (ctx.storage as Record<string, StorageCollection>)[name] as StorageCollection<T>;
}

export const entryKey = (collection: string, id: string) => `${collection}:${id}`;

// ── Queue ────────────────────────────────────────────────────────

export async function enqueue(ctx: Pick<PluginContext, "storage">, job: Omit<QueueJob, "attempts" | "enqueuedAt"> & Partial<QueueJob>): Promise<void> {
	const queue = col<QueueJob>(ctx, "aiQueue");
	const id = queueId(job);
	const next: QueueJob = { attempts: 0, enqueuedAt: Date.now(), ...job };
	await queue.put(id, mergeJob(await queue.get(id), next));
}

export async function queueCounts(ctx: Pick<PluginContext, "storage">) {
	const queue = col<QueueJob>(ctx, "aiQueue");
	const [entries, media] = await Promise.all([queue.count({ kind: "entry" }), queue.count({ kind: "media" })]);
	return { entries, media };
}

// ── Daily call cap ───────────────────────────────────────────────

const callsKey = (now = Date.now()) => `state:ai:calls:${dayKey(now)}`;

export async function callsToday(ctx: Pick<PluginContext, "kv">): Promise<number> {
	return (await ctx.kv.get<number>(callsKey())) ?? 0;
}

/** Count one model call against today's cap. Returns false (and counts nothing) when the cap is reached. */
export async function takeCall(ctx: Pick<PluginContext, "kv">, max: number): Promise<boolean> {
	const key = callsKey();
	for (let i = 0; i < 5; i++) {
		const current = await ctx.kv.getVersioned<number>(key);
		const used = current?.value ?? 0;
		if (used >= max) return false;
		const result = await ctx.kv.compareAndSet(key, current?.revision ?? null, used + 1);
		if (result.applied) return true;
	}
	return false;
}

export class DailyLimitError extends Error {
	constructor() {
		super("Today's AI call limit is reached. Work resumes tomorrow (UTC), or raise the limit on the AI page.");
		this.name = "DailyLimitError";
	}
}

// ── Usage log ────────────────────────────────────────────────────

export async function logUsage(ctx: Pick<PluginContext, "storage">, row: Omit<UsageRow, "time">): Promise<void> {
	const time = new Date().toISOString();
	try {
		await col<UsageRow>(ctx, "aiUsage").put(`${time}-${crypto.randomUUID().slice(0, 8)}`, { time, ...row });
	} catch {
		// The log is best effort.
	}
}

/** Delete usage rows older than 30 days, a page at a time. */
export async function pruneUsage(ctx: Pick<PluginContext, "storage">): Promise<void> {
	const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
	const usage = col<UsageRow>(ctx, "aiUsage");
	const old = await usage.query({ where: { time: { lt: cutoff } }, limit: 200 });
	if (old.items.length) await usage.deleteMany(old.items.map((i) => i.id));
}

// ── Lock ─────────────────────────────────────────────────────────

const LOCK_KEY = "state:ai:lock";

/** A soft lock so the cron tick and "Run now" don't process the queue concurrently. */
export async function withLock<T>(ctx: Pick<PluginContext, "kv">, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
	const now = Date.now();
	const current = await ctx.kv.getVersioned<{ until: number; token: string }>(LOCK_KEY);
	if (current?.value && current.value.until > now) return null;
	const token = crypto.randomUUID();
	const taken = await ctx.kv.compareAndSet(LOCK_KEY, current?.revision ?? null, { until: now + ttlMs, token });
	if (!taken.applied) return null;
	try {
		return await fn();
	} finally {
		const mine = await ctx.kv.getVersioned<{ token: string }>(LOCK_KEY);
		if (mine?.value?.token === token) await ctx.kv.compareAndDelete(LOCK_KEY, mine.revision).catch(() => undefined);
	}
}

export async function lockHeld(ctx: Pick<PluginContext, "kv">): Promise<boolean> {
	const current = await ctx.kv.get<{ until: number }>(LOCK_KEY);
	return Boolean(current && current.until > Date.now());
}

// ── Bulk scan state ──────────────────────────────────────────────

export interface BulkState {
	kind: "entries" | "media";
	force: boolean;
	/** Collections still to scan (entries). */
	collections: string[];
	cursor?: string;
	queued: number;
	skipped: number;
	started: string;
	finished?: string;
}

export const bulkKey = (kind: BulkState["kind"]) => `state:ai:bulk:${kind}`;
/** Epoch ms until which Wikidata asked to slow down (shared by every entry job, so one Retry-After throttles them all). */
export const WIKIDATA_BUSY_KEY = "state:ai:wikidataBusyUntil";

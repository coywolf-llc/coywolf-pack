/**
 * AI Enrichment worker: analyzes entries (entities + meta descriptions) and
 * images (alt text + captions) from the queue. Runs on the cron tick (and the
 * admin's "Run now"), never inside a save: hooks only enqueue.
 */
import { siteName } from "../core/site.js";
import { workerEnv } from "../shared.js";
import type { CollectionSchemaInfo, PluginContext } from "emdash";

import { type FeatureMap, ctxFeatures, isOn } from "../core/features.js";
import {
	type Entity,
	type GroundedMention,
	type QueueJob,
	type StageCache,
	applyChoices,
	attachCandidates,
	cleanDescription,
	deferJob,
	entryPlainText,
	parseChoices,
	parseImageText,
	parseMentions,
	planBatch,
	queueId,
	retryAt,
	userAgent,
	verifyEntities,
} from "./logic.js";
import { buildImageContext, findImageEntry } from "./image-context.js";
import { DESCRIBE_SYSTEM, DISAMBIGUATE_SYSTEM, EXTRACT_SYSTEM, IMAGE_SYSTEM, articlePrompt, disambiguatePrompt, imagePrompt } from "./prompts.js";
import { type ChatRequest, chat } from "./providers.js";
import {
	type AiOptions,
	type AiSettings,
	type BulkState,
	DailyLimitError,
	type EntryRecord,
	type MediaRecord,
	type UsageRow,
	WIKIDATA_BUSY_KEY,
	bindings,
	bulkKey,
	callsToday,
	col,
	enqueue,
	entryKey,
	logUsage,
	providerConfig,
	pruneUsage,
	readSettings,
	takeCall,
	withLock,
} from "./store.js";
import { WikidataBusyError, entityDetails, searchCandidates } from "./wikidata.js";
import { VERSION } from "../version.js";

type Settings = AiSettings & { apiKey: string };

/** Image bytes sent to a model: at most this many (larger images are downscaled with the Images binding, or skipped). */
const MAX_IMAGE_BYTES = 3_670_016;
const MAX_EDGE = 1568;
const DIRECT_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export class SkipError extends Error {}

// ── Helpers ──────────────────────────────────────────────────────

const schemaCache = new Map<string, { info: CollectionSchemaInfo | null; at: number }>();

async function collectionInfo(ctx: PluginContext, slug: string): Promise<CollectionSchemaInfo | null> {
	const hit = schemaCache.get(slug);
	if (hit && Date.now() - hit.at < 60_000) return hit.info;
	const info = (await ctx.schema?.getCollection(slug)) ?? null;
	schemaCache.set(slug, { info, at: Date.now() });
	return info;
}

/** Collections the module works on: the configured list, or every routable, visible one. */
export async function targetCollections(ctx: PluginContext, s: Settings): Promise<string[]> {
	if (s.collections.length) return s.collections;
	const all = (await ctx.schema?.listCollections()) ?? [];
	return all.filter((c) => c.routable && !c.hidden).map((c) => c.slug);
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function signature(s: Settings, features: FeatureMap): string {
	return `p:${s.provider}|m:${s.textModel}|ent:${isOn(features, "ai.entities") ? 1 : 0}|desc:${isOn(features, "ai.descriptions") ? 1 : 0}`;
}

export interface EntryText {
	title: string;
	text: string;
	hash: string;
	info: CollectionSchemaInfo;
}

/** Title, plain text, and change hash of an entry; null when it has no text worth analyzing. */
export async function entryText(ctx: PluginContext, collection: string, data: Record<string, unknown>, s: Settings, features: FeatureMap): Promise<EntryText | null> {
	const info = await collectionInfo(ctx, collection);
	if (!info) return null;
	const titleField = info.titleField ?? "title";
	const title = typeof data[titleField] === "string" ? (data[titleField] as string).trim() : "";
	const fields = [...info.fields].sort((a, b) => a.sortOrder - b.sortOrder).filter((f) => f.slug !== titleField);
	const text = entryPlainText(data, fields);
	if (!text.trim()) return null;
	return { title, text, info, hash: await sha256(`${title}\n${text}\n${signature(s, features)}`) };
}

const language = (ctx: PluginContext) => (ctx.site?.locale || "en").slice(0, 2).toLowerCase() || "en";
/**
 * Outbound requests (model calls and Wikidata lookups) per invocation. The
 * Workers Free plan allows 50 subrequests; this leaves room for the host's own.
 */
export const SUBREQUEST_BUDGET = 40;
/** Worst case for one job: entry = extraction + disambiguation + description + 12 searches + 1 details; image = 1 call. */
export const WORST_CASE_SUBREQUESTS = { entry: 16, media: 1 } as const;

export interface Budget {
	used: number;
	max: number;
}

const fetcher = (ctx: PluginContext, budget: Budget) => (url: string, init?: RequestInit) => {
	budget.used++;
	return ctx.http ? ctx.http.fetch(url, init) : fetch(url, init);
};

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** One model call: counted against the daily cap and written to the usage log. */
async function callModel(
	ctx: PluginContext,
	options: AiOptions,
	s: Settings,
	feature: UsageRow["feature"],
	req: ChatRequest,
	ref: string,
	budget: Budget,
): Promise<string> {
	if (!(await takeCall(ctx, s.maxCallsPerDay))) throw new DailyLimitError();
	budget.used++;
	const cfg = await providerConfig(ctx, options, s, Boolean(req.image));
	try {
		const result = await chat(cfg, req);
		await logUsage(ctx, { feature, provider: s.provider, model: cfg.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: true, ref });
		return result.text;
	} catch (error) {
		await logUsage(ctx, { feature, provider: s.provider, model: cfg.model, inputTokens: 0, outputTokens: 0, ok: false, error: String((error as Error).message ?? error).slice(0, 300), ref });
		throw error;
	}
}

// ── Entries ──────────────────────────────────────────────────────

async function groundEntities(ctx: PluginContext, options: AiOptions, s: Settings, t: EntryText, ref: string, cache: StageCache, budget: Budget): Promise<Entity[]> {
	// Stage 1 (cached on the job, so a retry doesn't pay for it twice).
	cache.mentions ??= parseMentions(
		await callModel(ctx, options, s, "entities", { system: EXTRACT_SYSTEM, user: articlePrompt(t.title, t.text), maxTokens: 2000 }, ref, budget),
	);
	const mentions = cache.mentions;
	if (!mentions.length) return [];
	const lang = language(ctx);
	const f = fetcher(ctx, budget);
	const ua = userAgent(VERSION, ctx.site?.url);
	// Stage 2: real candidates, one lookup at a time (Wikimedia's API etiquette).
	const candidates = [];
	for (const m of mentions) candidates.push(await searchCandidates(f, m.name, lang, ua));
	let { mentions: grounded, ambiguous } = attachCandidates(mentions, candidates);
	// Stage 3: the model chooses among real candidates only.
	if (ambiguous.length) {
		const subset: GroundedMention[] = ambiguous.map((i) => grounded[i]);
		cache.choices ??= parseChoices(
			await callModel(ctx, options, s, "entities", { system: DISAMBIGUATE_SYSTEM, user: disambiguatePrompt(subset, t.title, t.text), maxTokens: 1000 }, ref, budget),
		);
		grounded = applyChoices(grounded, ambiguous, cache.choices);
	}
	// Stage 4: type verification against P31.
	const resolved = grounded.filter((m) => m.qid);
	if (!resolved.length) return [];
	const details = await entityDetails(f, resolved.map((m) => m.qid), lang, ua);
	if (!details) throw new Error("Wikidata didn't answer, so the entities couldn't be verified. Retrying later.");
	return verifyEntities(resolved, details);
}

export async function analyzeEntry(ctx: PluginContext, options: AiOptions, s: Settings, features: FeatureMap, job: QueueJob, budget: Budget): Promise<"done" | "skipped"> {
	const collection = job.collection!;
	const id = job.entryId!;
	const item = await ctx.content?.get(collection, id);
	if (!item || item.status !== "published") return "skipped";
	const t = await entryText(ctx, collection, item.data, s, features);
	if (!t) return "skipped";

	const records = col<EntryRecord>(ctx, "aiEntries");
	const key = entryKey(collection, id);
	const previous = await records.get(key);
	if (!job.force && previous?.status === "ok" && previous.hash === t.hash) return "skipped";

	const ref = key;
	// Outputs from an earlier failed attempt on the same text are reused (the job is saved with them on failure).
	if (job.cache?.hash !== t.hash) job.cache = { hash: t.hash };
	const cache = job.cache;
	const wantEntities = isOn(features, "ai.entities");
	const hasDescription = Boolean(item.seo?.description?.trim());
	const wantDescription = isOn(features, "ai.descriptions") && t.info.hasSeo && !hasDescription;

	const entities = wantEntities ? await groundEntities(ctx, options, s, t, ref, cache, budget) : (previous?.entities ?? []);

	let description = previous?.description ?? "";
	let descriptionStatus: EntryRecord["descriptionStatus"] = hasDescription && previous?.descriptionStatus !== "applied" ? "none" : (previous?.descriptionStatus ?? "none");
	if (wantDescription) {
		cache.description ??= cleanDescription(
			await callModel(ctx, options, s, "descriptions", { system: DESCRIBE_SYSTEM, user: articlePrompt(t.title, t.text), maxTokens: 300 }, ref, budget),
		);
		description = cache.description;
		descriptionStatus = description ? "suggested" : "none";
		if (description && s.descriptionsMode === "apply") {
			descriptionStatus = (await applyDescription(ctx, collection, id, description, false)) ? "applied" : "none";
		}
	}

	await records.put(key, {
		collection,
		entryId: id,
		title: t.title,
		hash: t.hash,
		status: "ok",
		error: "",
		entities,
		description,
		descriptionStatus,
		updated: new Date().toISOString(),
	});
	return "done";
}

/**
 * Write a meta description into EmDash's SEO panel (a SEO-only update touches
 * nothing else). Unless `replace`, only when the entry still has none, so a
 * description an editor wrote meanwhile is never overwritten.
 */
export async function applyDescription(ctx: PluginContext, collection: string, id: string, description: string, replace: boolean): Promise<boolean> {
	const content = ctx.content;
	if (!content?.update) throw new Error("Content write access is unavailable.");
	const fresh = await content.get(collection, id);
	if (!fresh || fresh.seo === undefined) return false;
	if (!replace && fresh.seo.description?.trim()) return false;
	await content.update(collection, id, { seo: { description } });
	return true;
}

// ── Images ───────────────────────────────────────────────────────

async function imagePayload(ctx: PluginContext, options: AiOptions, media: { id: string; mimeType: string; width?: number | null; height?: number | null }) {
	if (!ctx.media?.readBytes) throw new Error("Media byte access is unavailable.");
	const { images } = await bindings(options);
	const bigEdge = Math.max(media.width ?? 0, media.height ?? 0) > MAX_EDGE * 2;
	let bytes: Uint8Array;
	try {
		bytes = (await ctx.media.readBytes(media.id, { maxBytes: images ? 16 * 1024 * 1024 : MAX_IMAGE_BYTES })).bytes;
	} catch (error) {
		throw new SkipError(images ? `The image couldn't be read: ${(error as Error).message}` : "The image is larger than 3.5 MB. Add an Images binding (see README) to analyze large images.");
	}
	let mimeType = media.mimeType;
	if (images && (bytes.byteLength > 1_000_000 || bigEdge || !DIRECT_MIMES.has(mimeType))) {
		const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
		const result = await images
			.input(stream)
			.transform({ width: MAX_EDGE, height: MAX_EDGE, fit: "scale-down" })
			.output({ format: "image/jpeg", quality: 85 });
		bytes = new Uint8Array(await result.response().arrayBuffer());
		mimeType = "image/jpeg";
	}
	if (!DIRECT_MIMES.has(mimeType)) throw new SkipError(`${mimeType} images can't be analyzed without an Images binding.`);
	if (bytes.byteLength > MAX_IMAGE_BYTES) throw new SkipError("The image is too large to analyze.");
	return { mimeType, base64: base64(bytes) };
}

/**
 * The article an image is used in, as context for its alt text and caption (src/ai/image-context.ts): the earliest
 * published entry that uses it, from EmDash's media usage index. "" when it isn't used in one, or can't be read.
 */
async function imageArticleContext(ctx: PluginContext, mediaId: string): Promise<string> {
	try {
		const env = await workerEnv();
		const db = env.DB as D1Database | undefined;
		if (!db || !ctx.content) return "";
		const used = await findImageEntry(db, mediaId);
		if (!used) return "";
		const item = await ctx.content.get(used.collection, used.id);
		if (!item || (item as { status?: string }).status !== "published") return "";
		const data = (item.data ?? {}) as Record<string, unknown>;
		const info = (await ctx.schema?.listCollections())?.find((c) => c.slug === used.collection);
		const titleField = info?.titleField ?? "title";
		const title = typeof data[titleField] === "string" ? (data[titleField] as string) : (used.title ?? "");
		const fields = (info?.fields ?? []).filter((f) => f.type === "portableText").map((f) => data[f.slug]);
		// Image blocks name the media item by id; ones added by URL only (/_emdash/api/media/file/<key>) by its key.
		const keyRow = await db.prepare("SELECT storage_key FROM media WHERE id = ? LIMIT 1").bind(mediaId).first<{ storage_key: string | null }>();
		const storageKey = keyRow?.storage_key ?? null;
		return buildImageContext(title, fields.length ? fields : Object.values(data).filter(Array.isArray), mediaId, storageKey);
	} catch (error) {
		ctx.log.warn("AI: couldn't read the article an image is used in; it's described on its own", { media: mediaId, error: String(error).slice(0, 200) });
		return "";
	}
}

export async function analyzeMedia(ctx: PluginContext, options: AiOptions, s: Settings, job: QueueJob, budget: Budget): Promise<"done" | "skipped"> {
	const id = job.mediaId!;
	const media = await ctx.media?.get(id);
	const records = col<MediaRecord>(ctx, "aiMedia");
	if (!media) {
		await records.delete(id).catch(() => false);
		return "skipped";
	}
	const base: Omit<MediaRecord, "status" | "suggestion" | "written" | "error"> = { mediaId: id, filename: media.filename, url: media.url, updated: new Date().toISOString() };
	if (!media.mimeType.startsWith("image/") || media.mimeType === "image/svg+xml") {
		await records.put(id, { ...base, suggestion: null, status: "skipped", written: [], error: "Only raster images get image text." });
		return "skipped";
	}
	const needsAlt = !media.alt?.trim();
	const needsCaption = s.imageCaption && !media.caption?.trim();
	if (!job.force && !s.imageOverwrite && !needsAlt && !needsCaption) return "skipped";

	let payload: { mimeType: string; base64: string };
	try {
		payload = await imagePayload(ctx, options, media);
	} catch (error) {
		if (!(error instanceof SkipError)) throw error;
		await records.put(id, { ...base, suggestion: null, status: "skipped", written: [], error: error.message });
		return "skipped";
	}
	const raw = await callModel(
		ctx,
		options,
		s,
		"imageText",
		{
			system: IMAGE_SYSTEM,
			user: imagePrompt({ filename: media.filename, site: await siteName(ctx), locale: ctx.site?.locale || "en", extra: s.imageInstructions, articleContext: await imageArticleContext(ctx, id) }),
			image: payload,
			maxTokens: 1024,
		},
		`media:${id}`,
		budget,
	);
	const suggestion = parseImageText(raw);

	let written: string[] = [];
	if (s.imageMode === "apply") written = await applyImageText(ctx, id, suggestion, { caption: s.imageCaption, overwrite: s.imageOverwrite });
	await records.put(id, { ...base, suggestion, status: written.length ? "applied" : "suggested", written, error: "" });
	return "done";
}

/** Write alt text (and optionally the caption) to a media item. Human-entered values are kept unless `overwrite`. */
export async function applyImageText(
	ctx: PluginContext,
	id: string,
	text: { alt?: string; caption?: string },
	opts: { caption: boolean; overwrite: boolean },
): Promise<string[]> {
	if (!ctx.media?.updateMetadata) throw new Error("Media metadata write access is unavailable.");
	const fresh = await ctx.media.get(id);
	if (!fresh) return [];
	const patch: { alt?: string; caption?: string } = {};
	if (text.alt && (opts.overwrite || !fresh.alt?.trim())) patch.alt = text.alt;
	if (opts.caption && text.caption && (opts.overwrite || !fresh.caption?.trim())) patch.caption = text.caption;
	if (!Object.keys(patch).length) return [];
	await ctx.media.updateMetadata(id, patch);
	return Object.keys(patch);
}

// ── Bulk scan ────────────────────────────────────────────────────

/** Turn part of a bulk run into queue jobs (up to ~200 items per call). */
export async function advanceBulk(ctx: PluginContext, s: Settings, features: FeatureMap, kind: BulkState["kind"]): Promise<void> {
	const state = await ctx.kv.get<BulkState>(bulkKey(kind));
	if (!state || state.finished) return;
	const now = Date.now();
	let pages = 2;
	if (kind === "entries") {
		const records = col<EntryRecord>(ctx, "aiEntries");
		while (pages-- > 0 && state.collections.length) {
			const collection = state.collections[0];
			const page = await ctx.content!.list(collection, { where: { status: "published" }, limit: 100, cursor: state.cursor });
			const stored = await records.getMany(page.items.map((i) => entryKey(collection, i.id)));
			for (const item of page.items) {
				if (!state.force) {
					const t = await entryText(ctx, collection, item.data, s, features);
					const prev = stored.get(entryKey(collection, item.id));
					if (!t || (prev?.status === "ok" && prev.hash === t.hash)) {
						state.skipped++;
						continue;
					}
				}
				await enqueue(ctx, { kind: "entry", collection, entryId: item.id, due: now, force: state.force });
				state.queued++;
			}
			if (page.hasMore && page.cursor) state.cursor = page.cursor;
			else {
				state.collections.shift();
				state.cursor = undefined;
			}
		}
		if (!state.collections.length) state.finished = new Date().toISOString();
	} else {
		while (pages-- > 0 && !state.finished) {
			const page = await ctx.media!.list({ mimeType: "image/", limit: 100, cursor: state.cursor });
			for (const m of page.items) {
				const lacking = !m.alt?.trim() || (s.imageCaption && !m.caption?.trim());
				if (m.mimeType === "image/svg+xml" || (!state.force && !lacking)) {
					state.skipped++;
					continue;
				}
				await enqueue(ctx, { kind: "media", mediaId: m.id, due: now, force: state.force });
				state.queued++;
			}
			if (page.hasMore && page.cursor) state.cursor = page.cursor;
			else state.finished = new Date().toISOString();
		}
	}
	await ctx.kv.set(bulkKey(kind), state);
}

// ── Tick ─────────────────────────────────────────────────────────

export interface TickResult {
	processed: number;
	skipped: number;
	failed: number;
	stoppedForLimit: boolean;
	busy?: boolean;
}

const callsPerJob = (features: FeatureMap) => (job: QueueJob) =>
	job.kind === "media" ? 1 : (isOn(features, "ai.entities") ? 2 : 0) + (isOn(features, "ai.descriptions") ? 1 : 0) || 1;

/** Process due jobs. `maxJobs` overrides the per-tick setting (the admin's Run now uses 1). */
export async function tick(ctx: PluginContext, options: AiOptions, opts: { maxJobs?: number; budgetMs: number }): Promise<TickResult> {
	const result = await withLock(ctx, opts.budgetMs + 120_000, async () => {
		const out: TickResult = { processed: 0, skipped: 0, failed: 0, stoppedForLimit: false };
		const started = Date.now();
		const features = await ctxFeatures(ctx);
		const s = await readSettings(ctx, options);
		const entriesOn = isOn(features, "ai.entities") || isOn(features, "ai.descriptions");
		const imagesOn = isOn(features, "ai.imageText");

		for (const kind of ["entries", "media"] as const) {
			if (kind === "entries" ? !entriesOn : !imagesOn) continue;
			await advanceBulk(ctx, s, features, kind).catch((error) => ctx.log.warn("AI bulk scan failed", { kind, error: String(error) }));
		}

		const queue = col<QueueJob>(ctx, "aiQueue");
		// Each enabled kind is read separately, so a backlog of one can't hide the other.
		// Jobs for switched-off features wait in the queue until they're back on.
		const kinds = [entriesOn && "entry", imagesOn && "media"].filter(Boolean) as Array<QueueJob["kind"]>;
		const pages = await Promise.all(kinds.map((kind) => queue.query({ where: { kind, due: { lte: Date.now() } }, orderBy: { due: "asc" }, limit: 25 })));
		const runnable = pages.flatMap((p) => p.items);
		const budget: Budget = { used: 0, max: SUBREQUEST_BUDGET };
		// While Wikidata asks to slow down (one Retry-After, shared by every entry job), entry jobs wait for a later tick.
		let wikidataBusy = ((await ctx.kv.get<number>(WIKIDATA_BUSY_KEY)) ?? 0) > Date.now();
		const batch = planBatch(runnable, {
			now: Date.now(),
			perTick: opts.maxJobs ?? s.jobsPerTick,
			remainingCalls: s.maxCallsPerDay - (await callsToday(ctx)),
			callsPerJob: callsPerJob(features),
			subrequests: budget.max,
			subrequestsPerJob: (job) => WORST_CASE_SUBREQUESTS[job.kind],
		});
		if (runnable.length && !batch.length) out.stoppedForLimit = true;

		for (const { id, data: job } of batch) {
			if (Date.now() - started > opts.budgetMs) break;
			if (budget.used + WORST_CASE_SUBREQUESTS[job.kind] > budget.max) break;
			if (wikidataBusy && job.kind === "entry") continue;
			try {
				const status = job.kind === "media" ? await analyzeMedia(ctx, options, s, job, budget) : await analyzeEntry(ctx, options, s, features, job, budget);
				await queue.delete(id);
				if (status === "done") out.processed++;
				else out.skipped++;
			} catch (error) {
				if (error instanceof DailyLimitError) {
					out.stoppedForLimit = true;
					await queue.put(id, job); // Stays queued for tomorrow, with any outputs already paid for.
					break;
				}
				if (error instanceof WikidataBusyError) {
					wikidataBusy = true;
					await ctx.kv.set(WIKIDATA_BUSY_KEY, Date.now() + error.retryAfterMs);
					// Not a failure: run again once Wikidata's Retry-After has passed, without using up an attempt...
					const deferred = deferJob(job, Date.now(), error.retryAfterMs);
					if (deferred) {
						ctx.log.warn("AI job deferred: Wikidata asked to slow down", { job: id, retryAfterMs: error.retryAfterMs, deferrals: deferred.deferrals });
						await queue.put(id, { ...deferred, lastError: error.message });
						continue;
					}
					// ...unless it has been deferred MAX_DEFERRALS times in a row: then it counts as a failed attempt.
				}
				out.failed++;
				const message = String((error as Error)?.message ?? error).slice(0, 500);
				ctx.log.warn("AI job failed", { job: id, error: message });
				const next = retryAt(job, Date.now());
				if (next === null) {
					await queue.delete(id);
					await recordFailure(ctx, job, message);
				} else {
					// job.cache holds the stage outputs this attempt already paid for.
					await queue.put(id, { ...job, attempts: job.attempts + 1, deferrals: 0, due: next, lastError: message });
				}
			}
		}
		await pruneUsage(ctx).catch(() => undefined);
		return out;
	});
	return result ?? { processed: 0, skipped: 0, failed: 0, stoppedForLimit: false, busy: true };
}

async function recordFailure(ctx: PluginContext, job: QueueJob, error: string): Promise<void> {
	const updated = new Date().toISOString();
	if (job.kind === "media") {
		const records = col<MediaRecord>(ctx, "aiMedia");
		const prev = await records.get(job.mediaId!);
		await records.put(job.mediaId!, {
			mediaId: job.mediaId!,
			filename: prev?.filename ?? "",
			url: prev?.url ?? "",
			suggestion: prev?.suggestion ?? null,
			status: "error",
			written: prev?.written ?? [],
			error,
			updated,
		});
		return;
	}
	const records = col<EntryRecord>(ctx, "aiEntries");
	const key = entryKey(job.collection!, job.entryId!);
	const prev = await records.get(key);
	// Keep what earlier runs found; an empty hash makes the next save retry.
	await records.put(key, {
		collection: job.collection!,
		entryId: job.entryId!,
		title: prev?.title ?? "",
		hash: "",
		status: "error",
		error,
		entities: prev?.entities ?? [],
		description: prev?.description ?? "",
		descriptionStatus: prev?.descriptionStatus ?? "none",
		updated,
	});
}

export { queueId };

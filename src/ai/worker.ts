/**
 * AI Enrichment worker: analyzes entries (entities + meta descriptions) and
 * images (alt text + captions) from the queue. Runs on the cron tick (and the
 * admin's "Run now"), never inside a save: hooks only enqueue.
 */
import { siteName } from "../core/site.js";
import { workerEnv } from "../shared.js";
import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import { type FeatureMap, ctxFeatures, isOn } from "../core/features.js";
import {
	type Entity,
	type GroundedMention,
	type ImageText,
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
	type DraftRecord,
	type EntryRecord,
	type MediaRecord,
	TEXT_HASHES_KEY,
	type TextHashFillState,
	type UsageRow,
	WIKIDATA_BUSY_KEY,
	bindings,
	bulkKey,
	callsToday,
	col,
	enqueue,
	entryKey,
	logUsage,
	optionalCol,
	providerConfig,
	pruneDrafts,
	pruneEditorLocks,
	pruneUsage,
	readSettings,
	stagedCache,
	stagedSpent,
	takeCall,
	withLock,
} from "./store.js";
import { WikidataBusyError, entityDetails, searchCandidates } from "./wikidata.js";
import { BUSY_MS, changeCounts, linkEntry, linkMemos, markOwnPublish, retryDue, shouldLink, withRetry, withoutPendingNew } from "./glossary-linker.js";
import { checkGoneTerms, removeGoneOn } from "./glossary-gone.js";
import { VERSION } from "../version.js";

type Settings = AiSettings & { apiKey: string };

/** Image bytes sent to a model: at most this many (larger images are downscaled with the Images binding, or skipped). */
const MAX_IMAGE_BYTES = 3_670_016;
const MAX_EDGE = 1568;
const DIRECT_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export class SkipError extends Error {}

// ── Helpers ──────────────────────────────────────────────────────

const schemaCache = new Map<string, { info: CollectionSchemaInfo | null; at: number }>();

/** Tests only: read every collection's schema again. */
export function resetSchemaCacheForTests(): void {
	schemaCache.clear();
}

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

/** The provider and text model an analysis is made with: what AI Enrich staged under another is never reused (DraftRecord.model). */
export const modelSignature = (s: Pick<Settings, "provider" | "textModel">): string => `p:${s.provider}|m:${s.textModel}`;

function signature(s: Settings, features: FeatureMap): string {
	return `${modelSignature(s)}|ent:${isOn(features, "ai.entities") ? 1 : 0}|desc:${isOn(features, "ai.descriptions") ? 1 : 0}`;
}

export interface EntryText {
	title: string;
	text: string;
	/** Title, text and the settings that shape the analysis: a bulk run re-analyzes the entry when it changes. */
	hash: string;
	/** Title and text alone: a save re-analyzes the entry only when it changes, and glossary links run only then (not after a settings change). */
	textHash: string;
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
	return { title, text, info, hash: await sha256(`${title}\n${text}\n${signature(s, features)}`), textHash: await sha256(`${title}\n${text}`) };
}

const language = (ctx: PluginContext) => (ctx.site?.locale || "en").slice(0, 2).toLowerCase() || "en";
/**
 * Outbound requests (model calls and Wikidata lookups) per invocation. The
 * Workers Free plan allows 50 subrequests; this leaves room for the host's own.
 */
export const SUBREQUEST_BUDGET = 40;
/** Publishing glossary links runs other plugins' publish hooks (cache purge, IndexNow…): counted as 3. */
const LINK_SUBREQUESTS = 3;
/** Worst case for one job: entry = extraction + disambiguation + description + 12 searches + 1 details (+ glossary links' publish); image = 1 call. */
export const WORST_CASE_SUBREQUESTS = { entry: 16 + LINK_SUBREQUESTS, media: 1 } as const;

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

/**
 * For a person waiting on the result (the editor's AI Enrich button): each model call's timeout, and no new stage
 * after `deadline` (epoch ms). `paid`: called once a model call's output is in the cache, so the caller can save it
 * right away (a failure there is the caller's to handle; it never fails the stage). `oneAtATime`: runs an image's
 * read and resize, so images described at once don't hold several large files in memory together. describeImage
 * throws OutOfTimeError when the deadline passes before its file is read: no call is made for that image.
 */
export interface CallLimits {
	timeoutMs?: number;
	deadline?: number;
	paid?: () => Promise<void> | void;
	oneAtATime?: <T>(work: () => Promise<T>) => Promise<T>;
}

/** A stage wasn't started because the caller's deadline had passed (CallLimits). Outputs already paid for are in the cache. */
export class OutOfTimeError extends Error {
	constructor() {
		super("it took too long");
		this.name = "OutOfTimeError";
	}
}

const inTime = (limits: CallLimits | undefined) => {
	if (limits?.deadline !== undefined && Date.now() >= limits.deadline) throw new OutOfTimeError();
};

const paid = async (limits: CallLimits | undefined) => {
	try {
		await limits?.paid?.();
	} catch {
		// Saving early is the caller's extra: the stage goes on.
	}
};

export async function groundEntities(ctx: PluginContext, options: AiOptions, s: Settings, t: EntryText, ref: string, cache: StageCache, budget: Budget, limits?: CallLimits): Promise<Entity[]> {
	// The whole result, from an earlier attempt that got this far (or AI Enrich's, handed to the job at the publish).
	if (cache.entities) return cache.entities;
	// Stage 1 (cached on the job, so a retry doesn't pay for it twice).
	if (!cache.mentions) {
		inTime(limits);
		cache.mentions = parseMentions(
			await callModel(ctx, options, s, "entities", { system: EXTRACT_SYSTEM, user: articlePrompt(t.title, t.text), maxTokens: 2000, timeoutMs: limits?.timeoutMs }, ref, budget),
		);
		await paid(limits);
	}
	const mentions = cache.mentions;
	if (!mentions.length) return (cache.entities = []);
	const lang = language(ctx);
	const f = fetcher(ctx, budget);
	const ua = userAgent(VERSION, ctx.site?.url);
	// Stage 2: real candidates, one lookup at a time (Wikimedia's API etiquette).
	// With a deadline (AI Enrich), what was found is kept in the cache: the next round goes on after it. A lookup that
	// found nothing isn't (Wikidata may not have answered), so it's tried again.
	const known = limits?.deadline !== undefined ? (cache.candidates ??= {}) : null;
	const candidates = [];
	for (const m of mentions) {
		if (known && Object.hasOwn(known, m.name)) {
			candidates.push(known[m.name]);
			continue;
		}
		inTime(limits);
		const found = await searchCandidates(f, m.name, lang, ua);
		if (known && found.length) known[m.name] = found;
		candidates.push(found);
	}
	let { mentions: grounded, ambiguous } = attachCandidates(mentions, candidates);
	// Stage 3: the model chooses among real candidates only.
	if (ambiguous.length) {
		const subset: GroundedMention[] = ambiguous.map((i) => grounded[i]);
		if (!cache.choices) {
			inTime(limits);
			cache.choices = parseChoices(
				await callModel(ctx, options, s, "entities", { system: DISAMBIGUATE_SYSTEM, user: disambiguatePrompt(subset, t.title, t.text), maxTokens: 1000, timeoutMs: limits?.timeoutMs }, ref, budget),
			);
			await paid(limits);
		}
		grounded = applyChoices(grounded, ambiguous, cache.choices);
	}
	// Stage 4: type verification against P31.
	const resolved = grounded.filter((m) => m.qid);
	if (!resolved.length) return (cache.entities = []);
	inTime(limits);
	const details = await entityDetails(f, resolved.map((m) => m.qid), lang, ua);
	if (!details) throw new Error("Wikidata didn't answer, so the entities couldn't be verified. Retrying later.");
	return (cache.entities = verifyEntities(resolved, details));
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
	// A save's job runs only for a new title or text (it may have been changed back since); other jobs also for new settings.
	if (!job.force && previous?.status === "ok" && (previous.hash === t.hash || (job.source === "save" && previous.textHash === t.textHash))) {
		// An analysis made before 0.51.0 whose hash still matches is of this very title and text: its text hash is recorded (nothing else changes, not its date).
		if (!previous.textHash && previous.hash === t.hash) await records.put(key, { ...previous, textHash: t.textHash }).catch(() => undefined);
		return "skipped";
	}

	const ref = key;
	// Outputs from an earlier failed attempt on the same text are reused (the job is saved with them on failure), and
	// for a save's job what AI Enrich paid for this text: also what a click still running at the publish finished
	// after the job got the rest (it fills only what the job lacks). Never for a forced job: that pays for a fresh one.
	const drafts = optionalCol<DraftRecord>(ctx, "aiDrafts");
	const staged = await stagedFor(drafts, key, t);
	const paidFor = staged && job.source === "save" && !job.force && staged.model === modelSignature(s) ? stagedCache(staged, t.hash) : null;
	if (job.cache?.hash !== t.hash) job.cache = paidFor ?? { hash: t.hash };
	else if (paidFor) job.cache = { ...paidFor, ...job.cache };
	const cache = job.cache;
	const wantEntities = isOn(features, "ai.entities");
	const hasDescription = Boolean(item.seo?.description?.trim());
	const wantDescription = isOn(features, "ai.descriptions") && t.info.hasSeo && !hasDescription;

	const entities = wantEntities ? await groundEntities(ctx, options, s, t, ref, cache, budget) : (previous?.entities ?? []);

	let description = previous?.description ?? "";
	let descriptionStatus: EntryRecord["descriptionStatus"] = hasDescription && previous?.descriptionStatus !== "applied" ? "none" : (previous?.descriptionStatus ?? "none");
	// The live description is the one AI Enrich's review filled in (the staged analysis'): applied, as the publish would mark it.
	if (hasDescription && staged?.description.trim() && item.seo!.description!.trim() === staged.description.trim()) {
		description = staged.description;
		descriptionStatus = "applied";
	}
	if (wantDescription) {
		description = await suggestDescription(ctx, options, s, t, ref, cache, budget);
		descriptionStatus = description ? "suggested" : "none";
		if (description && s.descriptionsMode === "apply") {
			descriptionStatus = (await applyDescription(ctx, collection, id, description, false)) ? "applied" : "none";
		}
	}

	const record: EntryRecord = {
		collection,
		entryId: id,
		title: t.title,
		hash: t.hash,
		textHash: t.textHash,
		status: "ok",
		error: "",
		entities,
		description,
		descriptionStatus,
		updated: new Date().toISOString(),
	};
	await records.put(key, record);
	// What was staged for this text alone has had its publish, and the entry its analysis: the editor's panel stops saying it waits.
	if (staged && stagedSpent(staged, t)) await drafts!.delete(key).catch(() => undefined);
	if (wantEntities && isOn(features, "ai.glossaryLinks")) await afterAnalysis(ctx, options, record, previous, t.textHash, budget);
	return "done";
}

/** What AI Enrich staged for this title and text (src/ai/editor-enrich.ts); null when there's none. */
async function stagedFor(drafts: StorageCollection<DraftRecord> | undefined, key: string, t: EntryText): Promise<DraftRecord | null> {
	const staged = drafts ? await drafts.get(key).catch(() => null) : null;
	return staged?.textHashes?.includes(t.textHash) ? staged : null;
}

/** A meta description for the entry's text (cached with the other stage outputs, so a retry doesn't pay for it twice). */
export async function suggestDescription(ctx: PluginContext, options: AiOptions, s: Settings, t: EntryText, ref: string, cache: StageCache, budget: Budget, limits?: CallLimits): Promise<string> {
	if (cache.description === undefined) {
		inTime(limits);
		cache.description = cleanDescription(
			await callModel(ctx, options, s, "descriptions", { system: DESCRIBE_SYSTEM, user: articlePrompt(t.title, t.text), maxTokens: 300, timeoutMs: limits?.timeoutMs }, ref, budget),
		);
		await paid(limits);
	}
	return cache.description;
}

/**
 * glossary.io links after an analysis: after a first analysis, or one whose
 * text changed since the links last looked (never a re-analysis for new
 * settings). Otherwise the text hash is remembered, so the next text change
 * links. Never fails the analysis: a failure to link is tried again later.
 * Only that: a retry links without asking whether the text changed, so a
 * failure before linking was decided (the memo couldn't be read, or the text
 * couldn't be recorded) schedules none, and the next analysis decides again.
 */
export async function afterAnalysis(ctx: PluginContext, options: AiOptions, record: EntryRecord, previous: EntryRecord | null, textHash: string, budget: Budget): Promise<void> {
	const key = entryKey(record.collection, record.entryId);
	const memos = linkMemos(ctx);
	let linking = false;
	try {
		const memo = await memos.get(key);
		if (!record.entities.length || !shouldLink(memo, previous, textHash)) {
			// A memo made for an entry with nothing remembered (pendingNew: a possessives-only run's marker, a removal's) becomes an ordinary memo once the text is recorded with it: an edit still pending stays recognizable.
			if (memo?.textHash !== textHash || memo?.pendingNew) await memos.put(key, { ...withoutPendingNew(memo ?? { collection: record.collection, entryId: record.entryId, linked: [], updated: "" }), textHash, updated: new Date().toISOString() });
			return;
		}
		linking = true;
		budget.used += LINK_SUBREQUESTS;
		const linked = await linkEntry(ctx, options, record.collection, record.entryId, { record, textHash });
		if (linked.changes.length || linked.status !== "unchanged") ctx.log.info("glossary.io links", { entry: key, status: linked.status, ...changeCounts(linked.changes), ...(linked.dateKept === undefined ? {} : { dateKept: linked.dateKept }) });
	} catch (error) {
		if (!linking) {
			ctx.log.warn("glossary.io links: couldn't read or record what's remembered about the entry; nothing is linked", { entry: key, error: String(error) });
			return;
		}
		ctx.log.warn("glossary.io links failed; trying again later", { entry: key, error: String(error) });
		const memo = await memos.get(key).catch(() => null);
		await memos.put(key, withRetry({ ...withoutPendingNew(memo ?? { collection: record.collection, entryId: record.entryId, linked: [], updated: "" }), textHash }, "error")).catch(() => undefined);
	}
}

/**
 * Write a meta description into EmDash's SEO panel (a SEO-only update touches
 * nothing else). Unless `replace`, only when the entry still has none, so a
 * description an editor wrote meanwhile is never overwritten. The write is the
 * pack's own (markOwnPublish): its save hook settles nothing AI Enrich staged
 * or planned for a draft the entry's live revision doesn't have yet.
 */
export async function applyDescription(ctx: PluginContext, collection: string, id: string, description: string, replace: boolean): Promise<boolean> {
	const content = ctx.content;
	if (!content?.update) throw new Error("Content write access is unavailable.");
	const fresh = await content.get(collection, id);
	if (!fresh || fresh.seo === undefined) return false;
	if (!replace && fresh.seo.description?.trim()) return false;
	markOwnPublish(entryKey(collection, id), (fresh as { liveRevisionId?: string | null }).liveRevisionId ?? null);
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
		const storageKey = used.storageKey;
		return buildImageContext(title, fields.length ? fields : Object.values(data).filter(Array.isArray), mediaId, storageKey);
	} catch (error) {
		ctx.log.warn("AI: couldn't read the article an image is used in; it's described on its own", { media: mediaId, error: String(error).slice(0, 200) });
		return "";
	}
}

/**
 * One image's alt text, title and caption from the vision model. `articleContext`: the entry it's used in
 * (buildImageContext), read only once the image's bytes are ready. Throws SkipError when the image can't be sent.
 */
export async function describeImage(
	ctx: PluginContext,
	options: AiOptions,
	s: Settings,
	media: { id: string; filename: string; mimeType: string; width?: number | null; height?: number | null },
	articleContext: string | (() => Promise<string>),
	ref: string,
	budget: Budget,
	limits?: CallLimits,
): Promise<ImageText> {
	// The deadline is checked again when the image's turn to be read comes, and once it's read: the reads queue one
	// behind another, so the check before this call can be long past by then.
	const read = () => {
		inTime(limits);
		return imagePayload(ctx, options, media);
	};
	const payload = await (limits?.oneAtATime ? limits.oneAtATime(read) : read());
	inTime(limits);
	const raw = await callModel(
		ctx,
		options,
		s,
		"imageText",
		{
			system: IMAGE_SYSTEM,
			user: imagePrompt({ filename: media.filename, site: await siteName(ctx), locale: ctx.site?.locale || "en", extra: s.imageInstructions, articleContext: typeof articleContext === "string" ? articleContext : await articleContext() }),
			image: payload,
			maxTokens: 1024,
			timeoutMs: limits?.timeoutMs,
		},
		ref,
		budget,
	);
	return parseImageText(raw);
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

	let suggestion: ImageText;
	try {
		suggestion = await describeImage(ctx, options, s, media, () => imageArticleContext(ctx, id), `media:${id}`, budget);
	} catch (error) {
		if (!(error instanceof SkipError)) throw error;
		await records.put(id, { ...base, suggestion: null, status: "skipped", written: [], error: error.message });
		return "skipped";
	}

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

// ── Text hashes for analyses made before 0.51.0 ──────────────────

/** Why an analysis wasn't given a text hash. */
export type TextHashSkip =
	/** Not "<collection>:<id>". */
	| "bad key"
	/** No analysis for the key. */
	| "not analyzed"
	/** Its last analysis failed: the next save analyzes it anyway. */
	| "analysis failed"
	/** An analysis is queued: it records the text hash. */
	| "queued"
	/** The entry is gone. */
	| "missing"
	| "unpublished"
	/** A pending draft: its text may be about to change. */
	| "draft"
	/** Saved in the last two minutes: that save may still be queuing an analysis. */
	| "recently saved"
	| "no text"
	/** The title isn't the one analyzed, so the text changed since: its next save analyzes it. */
	| "title changed"
	/** The analysis changed while this ran. */
	| "changed meanwhile"
	| "error";

export interface TextHashFill {
	dryRun: boolean;
	/** Analyses given a text hash (in a dry run, the ones that would be). */
	filled: string[];
	skipped: Array<{ key: string; reason: TextHashSkip; error?: string }>;
	/** `checked`: analyses looked at; `alreadySet`: ones that had a text hash (not listed). */
	counts: { checked: number; filled: number; alreadySet: number; skipped: number };
	/** Pages of analyses (no `keys`): pass `cursor` back for the next page while `hasMore`. */
	cursor?: string;
	hasMore: boolean;
}

/** Analyses the scheduled run gives a text hash per run, at most (each reads its entry, which counts 1 against the run's budget). */
export const TEXT_HASH_FILL_PER_TICK = 10;

/** One analysis: its text hash from the entry as it is now, when nothing can have changed that text since without an analysis on the way. */
async function fillTextHash(
	ctx: PluginContext,
	s: Settings,
	features: FeatureMap,
	key: string,
	known: EntryRecord | undefined,
	opts: { dryRun: boolean; budget?: Budget },
): Promise<"filled" | "set" | { reason: TextHashSkip }> {
	const colon = key.indexOf(":");
	const collection = key.slice(0, colon);
	const id = key.slice(colon + 1);
	if (colon < 1 || !id) return { reason: "bad key" };
	const records = col<EntryRecord>(ctx, "aiEntries");
	const record = known ?? (await records.get(key));
	if (!record) return { reason: "not analyzed" };
	if (record.status !== "ok") return { reason: "analysis failed" };
	if (record.textHash) return "set";
	if (opts.budget) opts.budget.used++;
	if (await col<QueueJob>(ctx, "aiQueue").get(queueId({ kind: "entry", collection, entryId: id }))) return { reason: "queued" };
	if (!ctx.content) throw new Error("Content read access is unavailable.");
	const item = await ctx.content.get(collection, id);
	if (!item) return { reason: "missing" };
	if (item.status !== "published") return { reason: "unpublished" };
	if (item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId) return { reason: "draft" };
	const savedAt = Date.parse(item.updatedAt);
	if (Number.isFinite(savedAt) && Date.now() - savedAt < BUSY_MS) return { reason: "recently saved" };
	const t = await entryText(ctx, collection, item.data, s, features);
	if (!t) return { reason: "no text" };
	if (t.title !== record.title) return { reason: "title changed" };
	if (opts.dryRun) return "filled";
	// Only the text hash is added: the date and everything else stay (the AI page lists analyses by date).
	const fresh = await records.getVersioned(key);
	if (!fresh || fresh.value.status !== "ok" || fresh.value.textHash || fresh.value.hash !== record.hash) return { reason: "changed meanwhile" };
	const written = await records.compareAndSet(key, fresh.revision, { ...fresh.value, textHash: t.textHash });
	return written.applied ? "filled" : { reason: "changed meanwhile" };
}

/**
 * Before a possessives-only edit of an entry (the ai/glossary-links route with
 * `only`): its publish fires the save hooks (src/ai/pack.ts), which queue an
 * analysis when the entry's title or text isn't what its analysis saw, and
 * that analysis could link. So the edit goes ahead only when those hooks
 * would queue nothing for the entry as it is now. Null: go ahead. A reason:
 * the entry must be left alone.
 *
 * - An analysis made before 0.51.0 (no text hash) under other settings than
 *   today's would be queued for a paid re-analysis though its text is the
 *   same. It gets its text hash first, by fillTextHash's rules (in a dry
 *   run, nothing is written: it only tells whether it would). When none can
 *   be recorded and its hash isn't today's: "text hash not recorded (…)".
 * - An analysis whose text hash isn't the entry's current one (the text
 *   changed while no job could be queued: AI Enrichment off, the collection
 *   not covered, the queue cleared, a bulk run stopped) and whose hash isn't
 *   today's either: "text changed since its analysis", unless a job is
 *   already queued for the entry (that analysis runs with or without this
 *   edit).
 */
export async function textHashBeforeEdit(ctx: PluginContext, s: Settings, features: FeatureMap, key: string, record: EntryRecord | null | undefined, dryRun: boolean): Promise<string | null> {
	// No successful analysis: linkEntry skips the entry ("not analyzed").
	if (!record || record.status !== "ok") return null;
	const colon = key.indexOf(":");
	const collection = key.slice(0, colon);
	const id = key.slice(colon + 1);
	let now = record;
	let unfilled: string | null = null;
	if (!record.textHash) {
		const outcome = await fillTextHash(ctx, s, features, key, record, { dryRun });
		// Its text hash is (or, in a dry run, would be) the entry's current one.
		if (outcome === "filled") return null;
		if (outcome !== "set") unfilled = outcome.reason;
		now = (await col<EntryRecord>(ctx, "aiEntries").get(key)) ?? record;
		// It failed meanwhile: the save hooks queue a failed analysis whatever its hashes say.
		if (now.status !== "ok") return "not analyzed";
	}
	// The save hooks' own condition (onContent in src/ai/pack.ts), on the entry as it is now.
	const item = await ctx.content?.get(collection, id);
	const t = item ? await entryText(ctx, collection, item.data, s, features) : null;
	// No entry or no text: the save hooks queue nothing for it. The same hash or text hash: they skip it.
	if (!t || now.hash === t.hash || now.textHash === t.textHash) return null;
	if (!now.textHash) return `text hash not recorded (${unfilled ?? "changed meanwhile"})`;
	// A job that's already queued analyzes the entry anyway: this edit's publish adds no analysis.
	if (await col<QueueJob>(ctx, "aiQueue").get(queueId({ kind: "entry", collection, entryId: id }))) return null;
	return "text changed since its analysis";
}

/**
 * Give analyses made before 0.51.0 a text hash, so a save that leaves an
 * entry's title and text as they are stops re-analyzing it: from the entry's
 * current title and text, which is what was analyzed unless they changed
 * since without an analysis on the way. So an analysis is left alone when its
 * entry has a queued job (that analysis records the hash), a pending draft, a
 * save in the last two minutes (its job may not be queued yet), or another
 * title than the one analyzed; and when it isn't published or is gone. A left
 * analysis keeps today's behavior: its next save that changes anything
 * analyzes it, and records the hash. `keys` ("posts:<id>"), or a page of
 * analyses (`limit`, `cursor`). No model calls; `dryRun` writes nothing.
 * `budget`: each entry read counts 1, and none starts once it's used up;
 * `deadline` (epoch ms): none starts after it. `complete`: every analysis
 * on the page was looked at.
 */
export async function fillTextHashes(
	ctx: PluginContext,
	options: AiOptions,
	opts: { dryRun?: boolean; keys?: string[]; cursor?: string; limit?: number; budget?: Budget; deadline?: number },
): Promise<TextHashFill & { complete: boolean }> {
	const out: TextHashFill & { complete: boolean } = { dryRun: Boolean(opts.dryRun), filled: [], skipped: [], counts: { checked: 0, filled: 0, alreadySet: 0, skipped: 0 }, hasMore: false, complete: true };
	let list: Array<{ key: string; record?: EntryRecord }>;
	if (opts.keys) list = opts.keys.map((key) => ({ key }));
	else {
		const page = await col<EntryRecord>(ctx, "aiEntries").query({ where: { status: "ok" }, limit: opts.limit ?? 50, cursor: opts.cursor });
		list = page.items.map((i) => ({ key: i.id, record: i.data }));
		out.cursor = page.cursor;
		out.hasMore = page.hasMore;
	}
	const [s, features] = await Promise.all([readSettings(ctx, options), ctxFeatures(ctx)]);
	for (const { key, record } of list) {
		if ((opts.deadline !== undefined && Date.now() >= opts.deadline) || (opts.budget && opts.budget.used >= opts.budget.max && !record?.textHash)) {
			out.complete = false;
			break;
		}
		out.counts.checked++;
		let outcome: Awaited<ReturnType<typeof fillTextHash>> | { reason: "error"; error: string };
		try {
			outcome = await fillTextHash(ctx, s, features, key, record, { dryRun: out.dryRun, budget: opts.budget });
		} catch (error) {
			outcome = { reason: "error", error: String((error as Error)?.message ?? error).slice(0, 300) };
		}
		if (outcome === "set") out.counts.alreadySet++;
		else if (outcome === "filled") {
			out.counts.filled++;
			out.filled.push(key);
		} else {
			out.counts.skipped++;
			out.skipped.push({ key, ...outcome });
		}
	}
	return out;
}

/**
 * The scheduled run's share of fillTextHashes, so every site gets the text
 * hashes without anyone asking: one page per run (after the queue work and
 * glossary.io links), of at most TEXT_HASH_FILL_PER_TICK analyses and never
 * more than the run's budget has left. Where it got to is kept
 * (TEXT_HASHES_KEY) once a page is done, so a run that stops early looks at
 * the rest of that page next time. After the last page it never runs again:
 * every later analysis records its text hash.
 */
export async function fillTextHashesTick(ctx: PluginContext, options: AiOptions, budget: Budget, deadline: number): Promise<void> {
	const state = (await ctx.kv.get<TextHashFillState>(TEXT_HASHES_KEY)) ?? { filled: 0, skipped: 0, started: new Date().toISOString() };
	if (state.done) return;
	const room = Math.min(TEXT_HASH_FILL_PER_TICK, budget.max - budget.used);
	if (room <= 0 || Date.now() >= deadline) return;
	const run = await fillTextHashes(ctx, options, { cursor: state.cursor, limit: room, budget, deadline });
	// A page looked at again counts its skips once (filled ones are set by then).
	state.filled += run.counts.filled;
	if (run.complete) {
		state.skipped += run.counts.skipped;
		if (run.hasMore && run.cursor) state.cursor = run.cursor;
		else {
			delete state.cursor;
			state.done = new Date().toISOString();
			ctx.log.info("AI: text hashes recorded for analyses made before 0.51.0", { filled: state.filled, skipped: state.skipped });
		}
	}
	await ctx.kv.set(TEXT_HASHES_KEY, state);
}

// ── Tick ─────────────────────────────────────────────────────────

export interface TickResult {
	processed: number;
	skipped: number;
	failed: number;
	stoppedForLimit: boolean;
	busy?: boolean;
}

/**
 * A job's model calls at most. Outputs it already has (job.cache: an earlier attempt's, or AI Enrich's) aren't paid
 * for again. A save drops a queued job's outputs for another text (enqueue's `hash`), so they're of the entry's text;
 * after a change of model alone the count can be low, and takeCall still holds the day's limit.
 */
const callsPerJob = (features: FeatureMap) => (job: QueueJob) =>
	job.kind === "media" ? 1 : (isOn(features, "ai.entities") && !job.cache?.entities ? 2 : 0) + (isOn(features, "ai.descriptions") && job.cache?.description === undefined ? 1 : 0) || 1;

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
		// glossary.io links that waited (a draft, a busy or changed entry, no index yet): no model calls.
		if (isOn(features, "ai.glossaryLinks") && isOn(features, "ai.entities") && Date.now() - started < opts.budgetMs) {
			// Remove links to deleted glossary.io terms (src/ai/glossary-gone.ts): checked first, so the removals it
			// queues share the retry pass below. While it can't decide (no good index copy, a refused copy), the pass only links.
			let unlink = false;
			if (removeGoneOn(features)) {
				try {
					const gone = await checkGoneTerms(ctx, options, budget, { collections: await targetCollections(ctx, s), deadline: started + opts.budgetMs });
					unlink = !gone.paused;
				} catch (error) {
					ctx.log.warn("glossary.io links: checking for deleted glossary.io terms failed", { error: String(error) });
				}
			}
			const room = Math.min(3, Math.floor((budget.max - budget.used) / LINK_SUBREQUESTS));
			if (room > 0) await retryDue(ctx, options, room, { unlink }).catch((error) => ctx.log.warn("glossary.io links retry failed", { error: String(error) }));
		}
		// Text hashes for analyses made before 0.51.0 (no model calls), with what the run has left.
		if (entriesOn) await fillTextHashesTick(ctx, options, budget, started + opts.budgetMs).catch((error) => ctx.log.warn("AI: recording text hashes failed", { error: String(error) }));
		await pruneUsage(ctx).catch(() => undefined);
		await pruneDrafts(ctx).catch(() => undefined);
		await pruneEditorLocks(ctx).catch(() => undefined);
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

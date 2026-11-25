/**
 * AI Enrich (since 0.52.0): the button in the entry editor's AI suggestions
 * panel (src/admin/enrich.tsx). The panel sends the editor's draft as EmDash
 * 1.6's editorDraft.get() reads it, saved or not, never-published entries too,
 * and this route answers with one patch the panel shows for review, then
 * applies with editorDraft.patch():
 * - glossary.io links by the same rules as after publishing (planEntryLinks),
 *   possessives moved inside them;
 * - alt text and captions for the images that have none, in the entry's own
 *   image blocks and image fields. Text a person wrote is never replaced;
 * - the meta description (seo.description), only when the draft has none.
 *
 * The draft comes from an admin's browser, not from EmDash: every value is
 * checked by its field's type (anything else counts as absent, and the saved
 * value is used), and nothing from it is ever written to the entry. The route
 * only returns operations for the panel to apply.
 *
 * The analysis is staged (aiDrafts, DraftRecord), never written to aiEntries:
 * the publish whose title and text it analyzed uses it without paying for it
 * again (src/ai/pack.ts), and a second click reuses everything paid for. Each
 * model output is saved as soon as it's paid (a partial stage with its cache),
 * so a click that's cancelled or fails halfway loses none of it. The links it
 * proposed wait in the entry's memo (planned) until that publish; none count
 * as linked before then. Every failure is a toast: it never throws.
 */
import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import { type FeatureMap, ctxFeatures, isOn } from "../core/features.js";
import { afterResponse } from "../shared.js";
import { type ImageFill, type ImageSlot, LEFT_ALONE_REASON, REVIEW_HINT, imageSlots, jsonBytes, withImageText } from "./editor-images.js";
import { glossaryFor, isGlossarySite } from "./glossary.js";
import { type EntryLinkPlan, type LinkMemo, linkConfig, linkMemos, livePlanned, planEntryLinks, plannedApplied, unseenMemo } from "./glossary-linker.js";
import { glossarySlug, glossarySlugsIn } from "./glossary-links.js";
import { buildImageContext } from "./image-context.js";
import { type Entity, type ImageText, type QueueJob, type StageCache, queueId } from "./logic.js";
import {
	type AiOptions,
	type AiSettings,
	DailyLimitError,
	type DraftRecord,
	type EntryRecord,
	type MediaRecord,
	WIKIDATA_BUSY_KEY,
	callsToday,
	col,
	editorLockKey,
	entryKey,
	readSettings,
	withLock,
} from "./store.js";
import { WikidataBusyError } from "./wikidata.js";
import {
	type Budget,
	type CallLimits,
	OutOfTimeError,
	SUBREQUEST_BUDGET,
	SkipError,
	WORST_CASE_SUBREQUESTS,
	applyImageText,
	describeImage,
	entryText,
	groundEntities,
	modelSignature,
	suggestDescription,
	targetCollections,
} from "./worker.js";

type Settings = AiSettings & { apiKey: string };
type Toast = { message: string; type: "success" | "error" | "info" };

/** What the panel applies: whole-value sets, in the editor's field order, then seo.description. */
export type EnrichOperation = { op: "set"; field: string; value: unknown };

/** What the panel's review lists: exactly what the patch adds. */
export interface EnrichReview {
	/** Each term linked, with the field it's in (one per entity). `action`: a new link, or an existing link switched to glossary.io. */
	links: Array<{ name: string; slug: string; url: string; field: string; action: "add" | "switch" }>;
	/** Possessives moved inside their glossary.io link. */
	possessives: number;
	/** Each image use given text: only what's added. */
	images: Array<{ field: string; mediaId: string | null; filename: string; alt?: string; caption?: string }>;
	/** The meta description the patch fills (an empty one only). */
	description?: string;
	/** Image uses without text that AI Enrich leaves as they are (LEFT_ALONE_REASON). */
	leftAlone: number;
	/** Image uses still to describe (the per-request cap, or time): the next round does them. */
	remaining: number;
}

export interface EnrichAnswer {
	toast: Toast;
	patch?: { type: "editor-draft-patch"; operations: EnrichOperation[] };
	/** The draft revision the answer is for (the request's), so the panel can tell a late answer. */
	revision?: string;
	/** Only time or the per-request image cap stopped it: the panel asks again at once (a new round), which reuses everything paid for. */
	more?: true;
	/** Another request holds the entry's lock: the panel waits and asks again. */
	running?: true;
	review?: EnrichReview;
	progress?: { imagesDone: number; imagesTotal: number };
}

/**
 * A model call gives up after this long, and none starts after START_BY_MS (an image's is checked again once its
 * file is read), so a request answers in about 85 seconds at worst: a call started at the last moment (65 seconds),
 * an image file still being read then, and up to about 10 seconds for the scheduled run's lock before the state is
 * written. That's inside the 100 seconds after which the zone's proxy answers 524. A request usually ends in 20 to
 * 40 seconds; one stopped by time answers `more`, and the panel asks again.
 */
const CALL_TIMEOUT_MS = 40_000;
export const START_BY_MS = 25_000;
/**
 * The per-entry lock is held LOCK_MS at a time and renewed every LOCK_BEAT_MS while the request runs (never past
 * LOCK_MAX_MS), so a request that was cancelled (the browser went away) frees its entry LOCK_MS after its last
 * renewal: about 50 seconds, with the 30 the work may go on after the response (afterResponse). A run still going
 * past LOCK_MAX_MS plus LOCK_MS (none should: no model call starts after START_BY_MS) no longer keeps another
 * request out; it writes no state once that one has the lock (`held`).
 */
export const LOCK_MS = 20_000;
const LOCK_BEAT_MS = 5_000;
export const LOCK_MAX_MS = 110_000;
/** Images described per request, at most, and how many model calls for them run at once (their files are read one at a time). */
const MAX_VISION = 8;
const VISION_AT_ONCE = 3;
/** Distinct media items looked up per request, at most (one read each). */
const MAX_IMAGES = 200;
/**
 * The request body's cap, far above any real entry. The route declares it (src/ai/routes.ts), so EmDash answers a
 * larger body with 413 before this runs and the panel checks the size before sending; the check here is for a
 * caller that isn't the route.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** A staged analysis keeps this much of the title (it comes from the browser). */
const TITLE_MAX = 500;
/** EmDash's limit on seo.description (the editor refuses a longer one); the pack's own are 155 characters. */
const SEO_DESCRIPTION_MAX = 500;

/** Waits between tries for the AI lock, and the lock's renewal timer (tests replace them). */
export const enrichIo = {
	wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	/** Run `beat` every `ms` until the returned function is called. */
	every: (ms: number, beat: () => void): (() => void) => {
		const timer = setInterval(beat, ms);
		return () => clearInterval(timer);
	},
};

const toast = (type: Toast["type"], message: string): EnrichAnswer => ({ toast: { type, message } });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reasonOf = (error: unknown) =>
	error instanceof OutOfTimeError ? "it took too long" : String((error as Error)?.message ?? error).replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 160) || "unknown error";

export const TOASTS = {
	noDraft: "AI Enrich couldn't read the editor's draft. Reload the page and try again.",
	tooLarge: "This entry is too large for AI Enrich (over 2 MB).",
	off: "AI Enrichment is off for this site. Turn on glossary.io links or Image text under Coywolf Pack → Features.",
	noKey: "AI Enrichment has no API key. Add one on the AI Enrichment page.",
	notCovered: "AI Enrichment doesn't cover this collection.",
	unreadable: "This entry couldn't be read. Reload the page and try again.",
	running: "AI Enrich is already running for this entry. Wait for it to finish.",
	nothingThere: "There's no text or image to work on yet.",
	limit: "Today's AI call limit is reached. Raise it on the AI Enrichment page, or try again tomorrow (UTC).",
	noIndex: "The glossary.io index isn't loaded yet. Open any page on the site, then click again.",
	review: REVIEW_HINT,
	nothingToAdd: "Nothing to add: the links and image text are already in place.",
	noEntities: "No entities found in this text, so there are no glossary.io links to add.",
	outOfTime: "AI Enrich ran out of time before it was done. Click again to finish: what was already paid for is kept.",
	/** What a failed call's toast ends with: the outputs paid for before it are kept (the failed call itself may be billed). */
	retry: "Click again to retry: what was already paid for is kept.",
} as const;

/** Nothing to add, though images miss text: ones the button leaves alone. */
export const leftAlone = (n: number) =>
	`Nothing to add. ${n === 1 ? "1 image without alt text or a caption is left as it is" : `${n} images without alt text or a caption are left as they are`}: ${LEFT_ALONE_REASON}`;

/** `error`: a model call failed; `trouble`: something of the site's own did (`what` says which part). */
type Issue = { kind: "limit" } | { kind: "busy"; until: number } | { kind: "time" } | { kind: "error"; reason: string } | { kind: "trouble"; what: string; reason: string } | { kind: "no-index" };

/**
 * The editor's draft as the panel sends it (`{ collection, entryId, draft: { revision, fields, fieldDefinitions },
 * round }`): editorDraft.get()'s snapshot. `fields` keeps the collection's fields; the keys that aren't fields
 * (`slug`, `seo.title`, `seo.description`) are in `host`.
 */
interface Draft {
	collection: string;
	entryId: string;
	revision: string;
	fields: Record<string, unknown>;
	host: { slug?: unknown; seoTitle?: unknown; seoDescription?: unknown };
	/** The keys the editor takes in a patch (fieldDefinitions' slugs). */
	defined: Set<string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown) => typeof v === "string";
const arrayOf = (item: (v: unknown) => boolean) => (v: unknown) => Array.isArray(v) && v.every(item);

/**
 * A value's shape for its field's type, as EmDash's draft checks it (content-editor-draft.ts FIELD_TYPES). A value of
 * another shape (or a field of a type not listed) counts as absent: the saved value is used.
 */
const FIELD_SHAPES: Readonly<Record<string, (v: unknown) => boolean>> = {
	string: isText,
	slug: isText,
	text: isText,
	url: isText,
	datetime: isText,
	select: isText,
	reference: isText,
	number: (v) => typeof v === "number" && Number.isFinite(v),
	integer: (v) => Number.isInteger(v),
	boolean: (v) => v === true || v === false || v === 0 || v === 1,
	multiSelect: arrayOf(isText),
	portableText: arrayOf((b) => isRecord(b) && typeof b._type === "string"),
	repeater: arrayOf(isRecord),
	blocks: arrayOf(isRecord),
	image: isRecord,
	file: isRecord,
	json: () => true,
};

function parse(input: unknown): Draft | null {
	const body = isRecord(input) ? input : {};
	const { collection, entryId, draft } = body;
	if (typeof collection !== "string" || !collection || typeof entryId !== "string" || !entryId || !isRecord(draft) || !isRecord(draft.fields)) return null;
	const fields: Record<string, unknown> = {};
	const host: Draft["host"] = {};
	// The keys that aren't collection fields go first: EmDash reserves `slug`, and field slugs can't contain a dot.
	for (const [key, value] of Object.entries(draft.fields)) {
		if (key === "slug") host.slug = value;
		else if (key === "seo.title") host.seoTitle = value;
		else if (key === "seo.description") host.seoDescription = value;
		else if (!key.includes(".")) fields[key] = value;
	}
	const defined = new Set(Array.isArray(draft.fieldDefinitions) ? draft.fieldDefinitions.flatMap((d) => (isRecord(d) && typeof d.slug === "string" ? [d.slug] : [])) : []);
	return { collection, entryId, revision: typeof draft.revision === "string" ? draft.revision.slice(0, 200) : "", fields, host, defined };
}

/**
 * The draft's values for the collection's own fields, each checked by its type: a field the collection doesn't have,
 * or a value of another shape, is left out (the saved value is used). A null where nothing is saved is left out too,
 * so the overlay adds no keys; booleans stay 0 or 1 as the form holds them. What's left hashes as the publish will
 * once the editor saves it (entryText reads only the title, rich text, blocks and text fields).
 */
function checkedFields(info: CollectionSchemaInfo, supplied: Record<string, unknown>, saved: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of info.fields) {
		if (!Object.hasOwn(supplied, field.slug)) continue;
		const value = supplied[field.slug];
		if (value === null) {
			if (saved[field.slug] !== null && saved[field.slug] !== undefined) out[field.slug] = null;
			continue;
		}
		if (Object.hasOwn(FIELD_SHAPES, field.type) && FIELD_SHAPES[field.type](value)) out[field.slug] = value;
	}
	return out;
}

/** The fields the patch may set: the collection's rich text and image fields that the draft sent (checked), so no unsaved edit is overwritten. */
function patchableFields(info: CollectionSchemaInfo, checked: Record<string, unknown>): Set<string> {
	return new Set(info.fields.filter((f) => (f.type === "portableText" || f.type === "image") && Object.hasOwn(checked, f.slug) && checked[f.slug] !== null).map((f) => f.slug));
}

/** The saved entry the draft is on: its pending draft revision when it has one, so text outside the draft hashes as the publish will. */
async function savedData(ctx: PluginContext, collection: string, item: { id: string; data?: Record<string, unknown>; draftRevisionId?: string | null; liveRevisionId?: string | null }): Promise<Record<string, unknown>> {
	const data = { ...(item.data ?? {}) };
	if (!item.draftRevisionId || item.draftRevisionId === item.liveRevisionId || !ctx.content?.getRevision) return data;
	const revision = await ctx.content.getRevision(collection, item.id, item.draftRevisionId).catch(() => null);
	const own = (revision as { data?: Record<string, unknown> } | null)?.data;
	if (!isRecord(own)) return data;
	for (const [key, value] of Object.entries(own)) if (!key.startsWith("_")) data[key] = value;
	return data;
}

function classify(error: unknown): Issue {
	if (error instanceof DailyLimitError) return { kind: "limit" };
	// Past the click's deadline (START_BY_MS): no call was made for that stage.
	if (error instanceof OutOfTimeError) return { kind: "time" };
	return { kind: "error", reason: reasonOf(error) };
}

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) await work(items[next++]);
	}));
}

/**
 * Run `work` holding one entry's lock (see LOCK_MS); null when another click holds it. The lock is this click's own
 * (its token): one that outlived its lock never renews or releases a later click's. `held` (for the work): whether
 * no other click has taken the lock since.
 */
async function withEntryLock<T>(ctx: PluginContext, key: string, work: (held: () => Promise<boolean>) => Promise<T>): Promise<T | null> {
	const started = Date.now();
	const current = await ctx.kv.getVersioned<{ until: number; token: string }>(key);
	if (current?.value && current.value.until > started) return null;
	const token = crypto.randomUUID();
	if (!(await ctx.kv.compareAndSet(key, current?.revision ?? null, { until: started + LOCK_MS, token })).applied) return null;
	let renewing: Promise<unknown> = Promise.resolve();
	let cancel: (() => void) | undefined;
	const stop = () => {
		cancel?.();
		cancel = undefined;
	};
	cancel = enrichIo.every(LOCK_BEAT_MS, () => {
		// Past its time the timer goes too: nothing renews the lock again.
		if (Date.now() - started > LOCK_MAX_MS) return stop();
		renewing = renewing
			.then(async () => {
				const mine = await ctx.kv.getVersioned<{ token: string }>(key);
				if (mine?.value?.token === token) await ctx.kv.compareAndSet(key, mine.revision, { until: Date.now() + LOCK_MS, token });
			})
			.catch(() => undefined);
	});
	const held = async () => {
		const now = await ctx.kv.get<{ token?: string }>(key).catch(() => null);
		return !now || now.token === token;
	};
	try {
		return await work(held);
	} finally {
		stop();
		// A renewal still on its way would otherwise land after the release.
		await renewing;
		const mine = await ctx.kv.getVersioned<{ token: string }>(key).catch(() => null);
		if (mine?.value?.token === token) await ctx.kv.compareAndDelete(key, mine.revision).catch(() => undefined);
	}
}

/** Run AI Enrich for one editor draft (the ai/editor-enrich route). Every answer echoes the draft's revision. */
export async function editorEnrich(ctx: PluginContext, options: AiOptions, input: unknown): Promise<EnrichAnswer> {
	let revision = "";
	try {
		if (jsonBytes(input) > MAX_BODY_BYTES) return toast("error", TOASTS.tooLarge);
		const draft = parse(input);
		if (!draft) return toast("error", TOASTS.noDraft);
		revision = draft.revision;
		return { ...(await enrich(ctx, options, draft)), revision };
	} catch (error) {
		ctx.log.error("AI Enrich failed", { error: String(error).slice(0, 300) });
		return { ...toast("error", `AI Enrich didn't work: ${reasonOf(error)}. Click again to retry.`), ...(revision ? { revision } : {}) };
	}
}

async function enrich(ctx: PluginContext, options: AiOptions, draft: Draft): Promise<EnrichAnswer> {
	const [features, s] = await Promise.all([ctxFeatures(ctx), readSettings(ctx, options)]);
	let links = isOn(features, "ai.entities") && isOn(features, "ai.glossaryLinks");
	const images = isOn(features, "ai.imageText");
	if (!links && !images) return toast("info", TOASTS.off);
	if (s.provider === "workers-ai" ? !s.bindingAvailable : !s.apiKey) return toast("error", TOASTS.noKey);
	const { collection } = draft;
	if (!(await targetCollections(ctx, s)).includes(collection)) return toast("info", TOASTS.notCovered);
	const item = ctx.content?.get ? await ctx.content.get(collection, draft.entryId).catch(() => null) : null;
	const info = item ? await ctx.schema?.getCollection(collection) : null;
	if (!item || !info) return toast("error", TOASTS.unreadable);
	// Everything is kept under the entry's own id, whatever the request called it.
	const id = typeof item.id === "string" && item.id ? item.id : draft.entryId;

	const config = linkConfig(options, ctx.site?.url);
	let linksOff = "";
	if (links && isGlossarySite(ctx.site?.url)) linksOff = "glossary.io links don't run on glossary.io itself";
	else if (links && !config.siteHosts.length) linksOff = "the site's URL isn't known, so glossary.io links can't run";
	else if (links && item.slug && (config.skip.has(item.slug) || config.skip.has(`${collection}:${item.slug}`))) linksOff = "this entry is on the glossary.io links skip list";
	if (linksOff) links = false;
	if (!links && !images) return toast("info", `Nothing to add: ${linksOff}.`);

	const work = withEntryLock(ctx, editorLockKey(collection, id), (held) => enrichEntry(ctx, options, s, features, { draft, id, item, info, links, images, config, held }));
	// Kept alive a little past a request the browser gave up on, so a call in flight still ends and is saved.
	afterResponse(work.catch(() => undefined));
	return (await work) ?? { ...toast("info", TOASTS.running), running: true };
}

interface Run {
	draft: Draft;
	/** The entry's own id. */
	id: string;
	item: NonNullable<Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>>;
	info: CollectionSchemaInfo;
	links: boolean;
	images: boolean;
	config: ReturnType<typeof linkConfig>;
	/** Whether no other click has taken the entry's lock since this one did. */
	held: () => Promise<boolean>;
}

/** One image use's text. */
interface Fill extends ImageFill {
	slot: ImageSlot;
}

/** Whether a stage cache holds anything a model call or Wikidata gave. */
const hasOutputs = (cache: StageCache) => Boolean(cache.mentions || cache.choices || cache.entities || cache.description !== undefined);

async function enrichEntry(ctx: PluginContext, options: AiOptions, s: Settings, features: FeatureMap, run: Run): Promise<EnrichAnswer> {
	const { draft, item, info, id } = run;
	const { collection } = draft;
	const key = entryKey(collection, id);
	const started = Date.now();
	const bySort = [...info.fields].sort((a, b) => a.sortOrder - b.sortOrder);
	const ptFields = bySort.filter((f) => f.type === "portableText").map((f) => f.slug);
	const saved = await savedData(ctx, collection, item);
	const checked = checkedFields(info, draft.fields, saved);
	const patchable = patchableFields(info, checked);
	const data = { ...saved, ...checked };
	// The meta description the editor holds now (its SEO panel's, typed or saved); the saved one when the draft has no SEO keys.
	const { seoDescription } = draft.host;
	const heldDescription = typeof seoDescription === "string" ? seoDescription : seoDescription === null ? "" : (item.seo?.description ?? "");
	const noDescription = !heldDescription.trim();

	const t0 = await entryText(ctx, collection, data, s, features);
	const links = run.links && Boolean(t0);
	const slots = run.images
		? imageSlots(
				data,
				ptFields.filter((f) => patchable.has(f)),
				bySort.filter((f) => f.type === "image" && patchable.has(f.slug)).map((f) => f.slug),
			)
		: [];
	if (!t0 && !slots.length) return toast("info", TOASTS.nothingThere);

	const drafts = col<DraftRecord>(ctx, "aiDrafts");
	const [record, staged, memo, used, busyUntil] = await Promise.all([
		col<EntryRecord>(ctx, "aiEntries").get(key),
		drafts.get(key),
		linkMemos(ctx).get(key),
		callsToday(ctx),
		ctx.kv.get<number>(WIKIDATA_BUSY_KEY),
	]);
	const callsLeft = s.maxCallsPerDay - used;
	const budget: Budget = { used: 0, max: SUBREQUEST_BUDGET };

	// ── The analysis: reused from the live entry's or an earlier click's when it's of this text ──
	let entities: Entity[] | null = null;
	let description = "";
	let described = false;
	// The live entry's analysis only when it's of this text under today's settings (its hash): one made with Entities
	// or Meta descriptions off has the same text hash and none of what they find.
	const live = t0 && record?.status === "ok" && record.hash === t0.hash ? record : null;
	// An earlier click's, of this text before or after its patch (the captions it added don't change the entities),
	// made with today's provider and model: another's isn't passed on as today's.
	const model = modelSignature(s);
	const earlier = t0 && staged?.textHashes.includes(t0.textHash) && staged.model === model ? staged : null;
	const reusable = earlier && !earlier.partial ? earlier : null;
	if (live) {
		entities = live.entities;
		description = live.description;
		described = true;
	} else if (reusable) {
		entities = reusable.entities;
		description = reusable.description;
		described = reusable.described;
	}
	const cache: StageCache = t0 && staged?.cache && (staged.cache.hash === t0.hash || earlier) ? { ...structuredClone(staged.cache), hash: t0.hash } : { hash: t0?.hash ?? "" };
	// A complete earlier analysis stays whole in whatever is saved on the way (a description still to write).
	if (reusable && !cache.entities) cache.entities = reusable.entities;
	const describe = isOn(features, "ai.descriptions");
	if (!live && describe && !described && !(t0?.info.hasSeo && noDescription)) described = true;
	const wantDescription = links && describe && !described;

	// Whether this request got anything new (an output in the cache, an image's text): a round stopped by time asks for another only then.
	const cacheBefore = JSON.stringify(cache);
	let progressed = false;
	// Set by the tasks below (an object, so the checks after them aren't narrowed away).
	const issues: { entity?: Issue; description?: Issue; image?: Issue; links?: Issue } = {};

	// ── Saved as soon as it's paid: a partial stage with the outputs so far, one write after another ──
	const hashesSoFar = [...new Set([...(earlier?.textHashes ?? []), ...(t0 ? [t0.textHash] : [])])];
	const partialStage = (textHashes: string[]): DraftRecord => ({ collection, entryId: id, title: t0!.title.slice(0, TITLE_MAX), hash: t0!.hash, textHashes, entities: [], description: cache.description ?? "", described: false, partial: true, cache: structuredClone(cache), model, updated: new Date().toISOString() });
	let checkpointed = false;
	let saving: Promise<void> = Promise.resolve();
	const checkpoint = (): Promise<void> => {
		if (!t0) return saving;
		saving = saving
			.then(async () => {
				await drafts.put(key, partialStage(hashesSoFar));
				checkpointed = true;
			})
			.catch((error: unknown) => ctx.log.warn("AI Enrich: couldn't save what it has so far", { entry: key, error: String(error).slice(0, 300) }));
		return saving;
	};
	// An image's file is read (and resized) one at a time: three large ones at once could exhaust the Worker's memory.
	let reading: Promise<unknown> = Promise.resolve();
	const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
		const mine = reading.then(work);
		reading = mine.catch(() => undefined);
		return mine;
	};
	const limits: CallLimits = { timeoutMs: CALL_TIMEOUT_MS, deadline: started + START_BY_MS, paid: checkpoint, oneAtATime };

	const entityTask = async () => {
		if (!links || entities || !t0) return;
		if (callsLeft <= 0 && !cache.entities) return void (issues.entity = { kind: "limit" });
		if ((busyUntil ?? 0) > Date.now() && !cache.entities) return void (issues.entity = { kind: "busy", until: busyUntil! });
		try {
			const had = Boolean(cache.entities);
			entities = await groundEntities(ctx, options, s, t0, key, cache, budget, limits);
			if (!had) await checkpoint();
		} catch (error) {
			if (error instanceof WikidataBusyError) {
				const until = Date.now() + error.retryAfterMs;
				await ctx.kv.set(WIKIDATA_BUSY_KEY, until).catch(() => undefined);
				issues.entity = { kind: "busy", until };
			} else issues.entity = classify(error);
		}
	};
	const descriptionTask = async () => {
		if (!wantDescription || !t0) return;
		if (callsLeft <= 0 && cache.description === undefined) return void (issues.description = { kind: "limit" });
		try {
			description = await suggestDescription(ctx, options, s, t0, key, cache, budget, limits);
			described = true;
		} catch (error) {
			issues.description = classify(error);
		}
	};

	// ── Images ──
	const filled = new Map<ImageSlot, { alt?: string; caption?: string }>();
	const pendingIds = new Set<string>();
	const filenames = new Map<string, string>();
	const imageTask = async () => {
		if (!slots.length || !ctx.media) return;
		// A real entry has far fewer: the rest (a made-up request's) are left as they are.
		const ids = [...new Set(slots.map((slot) => slot.mediaId).filter((v): v is string => Boolean(v)))].slice(0, MAX_IMAGES);
		if (!ids.length) return;
		const mediaRecords = col<MediaRecord>(ctx, "aiMedia");
		const [items, stored] = await Promise.all([Promise.all(ids.map((mid) => ctx.media!.get(mid).catch(() => null))), mediaRecords.getMany(ids)]);
		const media = new Map(ids.map((mid, i) => [mid, items[i]] as const));
		for (const [mid, m] of media) if (m?.filename) filenames.set(mid, m.filename);
		const fresh = new Map<string, ImageText>();
		const suggestionOf = (mid: string) => fresh.get(mid) ?? (stored.get(mid)?.status === "dismissed" ? null : (stored.get(mid)?.suggestion ?? null));
		const raster = (mid: string) => {
			const m = media.get(mid);
			return Boolean(m && m.mimeType.startsWith("image/") && m.mimeType !== "image/svg+xml" && stored.get(mid)?.status !== "skipped");
		};
		const fill = () => {
			for (const slot of slots) {
				if (!slot.mediaId) continue;
				const m = media.get(slot.mediaId);
				const suggestion = suggestionOf(slot.mediaId);
				const alt = slot.needsAlt ? m?.alt?.trim() || suggestion?.alt?.trim() || "" : "";
				const caption = slot.needsCaption ? m?.caption?.trim() || suggestion?.caption?.trim() || "" : "";
				if (alt || caption) filled.set(slot, { ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) });
			}
		};
		try {
			// A vision call only when neither the library item nor a stored suggestion has what a use of the image lacks.
			const wanted = ids.filter((mid) => {
				const record = stored.get(mid);
				if (!raster(mid) || record?.status === "dismissed" || record?.suggestion) return false;
				const m = media.get(mid)!;
				return slots.some((slot) => slot.mediaId === mid && ((slot.needsAlt && !m.alt?.trim()) || (slot.needsCaption && !m.caption?.trim())));
			});
			// The entity and description calls come first out of what's left of today's calls.
			const perClick = Math.min(MAX_VISION, Math.floor((SUBREQUEST_BUDGET - WORST_CASE_SUBREQUESTS.entry - budget.used) / 2));
			const today = callsLeft - (links && !entities && !cache.entities ? 2 : 0) - (wantDescription && cache.description === undefined ? 1 : 0);
			const room = Math.max(0, Math.min(perClick, today));
			// Out of calls for today: say so. Otherwise the rest wait for the next click.
			if (wanted.length > room && today <= 0) issues.image ??= { kind: "limit" };
			else for (const mid of wanted.slice(room)) pendingIds.add(mid);
			const title = typeof data[info.titleField ?? "title"] === "string" ? (data[info.titleField ?? "title"] as string) : "";
			const fields = ptFields.map((f) => data[f]);
			let stop = false;
			await pool(wanted.slice(0, room), VISION_AT_ONCE, async (mid) => {
				if (stop) return;
				if (Date.now() >= limits.deadline!) return void pendingIds.add(mid);
				const m = media.get(mid)!;
				try {
					const suggestion = await describeImage(ctx, options, s, m, buildImageContext(title, fields, mid, null), `media:${mid}`, budget, limits);
					fresh.set(mid, suggestion);
					progressed = true;
					let written: string[] = [];
					if (s.imageMode === "apply") {
						written = await applyImageText(ctx, mid, suggestion, { caption: s.imageCaption, overwrite: false }).catch((error: unknown) => {
							ctx.log.warn("AI Enrich: couldn't write image text to the media library", { media: mid, error: String(error).slice(0, 200) });
							return [];
						});
					}
					const base = { mediaId: mid, filename: m.filename, url: m.url, updated: new Date().toISOString() };
					await mediaRecords.put(mid, { ...base, suggestion, status: written.length ? "applied" : "suggested", written, error: "" });
					// Its upload's job would pay for the same image again.
					const queue = col<QueueJob>(ctx, "aiQueue");
					const job = await queue.get(queueId({ kind: "media", mediaId: mid }));
					if (job && !job.force) await queue.delete(queueId({ kind: "media", mediaId: mid }));
				} catch (error) {
					if (error instanceof SkipError) {
						await mediaRecords.put(mid, { mediaId: mid, filename: m.filename, url: m.url, updated: new Date().toISOString(), suggestion: null, status: "skipped", written: [], error: error.message }).catch(() => undefined);
						return;
					}
					// Its file wasn't read in time, so no call was made: the next round's.
					if (error instanceof OutOfTimeError) return void pendingIds.add(mid);
					issues.image ??= classify(error);
					if (error instanceof DailyLimitError) stop = true;
				}
			});
		} finally {
			// Whatever went wrong above, the text that's there (the library's, stored suggestions, what was just paid for) is used.
			fill();
		}
	};
	/** A failure outside the per-image handling (the media library or its records couldn't be read) is the images' issue, never the click's. */
	const guardedImageTask = () =>
		imageTask().catch((error: unknown) => {
			ctx.log.warn("AI Enrich: the images couldn't be worked on", { entry: key, error: String(error).slice(0, 300) });
			issues.image ??= { kind: "trouble", what: "The images couldn't be worked on", reason: reasonOf(error) };
		});

	await Promise.all([entityTask(), descriptionTask(), guardedImageTask()]);
	await saving;

	// ── Links ──
	let plan: EntryLinkPlan | null = null;
	const found = entities as Entity[] | null;
	// A proposal of an earlier click that was applied to this draft (it has one of its links): what it handled stays
	// handled, so a link taken out by hand since isn't proposed again.
	const before = livePlanned(memo, started);
	const draftSlugs = before ? new Set(ptFields.flatMap((f) => [...glossarySlugsIn(data[f])])) : null;
	const applied = before && draftSlugs && plannedApplied(before, draftSlugs) ? before : null;
	if (links && found) {
		try {
			const index = await glossaryFor(ctx, ctx.site?.url, { anySwitch: true });
			if (found.length && !index) issues.links = { kind: "no-index" };
			else {
				const lookup = (qid: string) => {
					const term = index ? index(qid) : undefined;
					const slug = term ? glossarySlug(term.url) : null;
					return term && slug ? { slug, names: term.names ?? [] } : null;
				};
				plan = planEntryLinks(data, ptFields, found, lookup, run.config, [...new Set([...(memo?.linked ?? []), ...(applied?.qids ?? [])])], {
					onFixError: (field, error) => ctx.log.warn("AI Enrich: couldn't check a field's possessives; they stay as they are", { entry: key, field, error: String(error) }),
				});
			}
		} catch (error) {
			// The analysis is paid for and staged below either way.
			ctx.log.warn("AI Enrich: the links couldn't be planned", { entry: key, error: String(error).slice(0, 300) });
			issues.links = { kind: "trouble", what: "The links couldn't be planned", reason: reasonOf(error) };
			plan = null;
		}
	}

	// ── One patch: per field, its links and possessives, then its image text, in one set; then the meta description ──
	const order = new Map(bySort.map((f, i) => [f.slug, i]));
	const fills: Fill[] = slots.filter((slot) => filled.has(slot)).map((slot) => ({ slot, path: slot.path, ...filled.get(slot) }));
	const linkValues = new Map(Object.entries(plan?.patch ?? {}).filter(([field]) => patchable.has(field)));
	const current = new Map(
		[...new Set([...linkValues.keys(), ...fills.map((f) => f.slot.field)])]
			.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
			.map((field) => [field, withImageText(linkValues.has(field) ? linkValues.get(field) : data[field], fills.filter((f) => f.slot.field === field))] as const),
	);
	const ops: EnrichOperation[] = [...current].map(([field, value]) => ({ op: "set", field, value }));
	const termFields = plan ? plan.terms.map((c, i) => ({ c, field: plan!.termFields[i] })).filter((t) => linkValues.has(t.field)) : [];
	const terms = termFields.map((t) => t.c);
	const fixes = plan ? plan.fixes.filter((_, i) => linkValues.has(plan!.fixFields[i])) : [];
	// The meta description, only with the links (the button's line says so: it comes with their analysis), only into an
	// empty one, in a collection with SEO whose editor takes it (the draft lists it), and never one the person
	// dismissed, or removed after it was applied, while the live analysis is of this text.
	const liveTold = live && (live.descriptionStatus === "dismissed" || live.descriptionStatus === "applied");
	const fillDescription = links && describe && Boolean(t0?.info.hasSeo) && draft.defined.has("seo.description") && noDescription && !liveTold ? description.trim() : "";
	if (fillDescription && fillDescription.length <= SEO_DESCRIPTION_MAX) ops.push({ op: "set", field: "seo.description", value: fillDescription });
	const describedNow = ops.some((o) => o.field === "seo.description");

	// ── Staged for the publish ──
	const t1 = t0 ? await entryText(ctx, collection, { ...data, ...Object.fromEntries(current) }, s, features).catch(() => t0) : null;
	const now = new Date().toISOString();
	let stage: DraftRecord | null = null;
	if (links && t0 && issues.entity) {
		// Stopped early: what it paid for is kept for the next click and for the publish (src/ai/pack.ts hands it to the
		// entry's job). A click that paid for nothing leaves an earlier click's complete analysis of another version alone.
		if (hasOutputs(cache) || !staged || staged.partial) stage = partialStage([...new Set([...hashesSoFar, ...(t1 ? [t1.textHash] : [])])]);
	} else if (links && t0 && t1 && found && (!live || t1.textHash !== t0.textHash)) {
		// A description that failed leaves `described` false: the next click writes it, or the publish's job does (only that).
		// The texts an earlier click's analysis (reused here) was of stay in it.
		stage = { collection, entryId: id, title: t1.title.slice(0, TITLE_MAX), hash: t1.hash, textHashes: [...new Set([...hashesSoFar, t1.textHash])], entities: found, description, described, model, updated: now };
	}
	const forget = !stage && links && Boolean(found) && (Boolean(staged) || checkpointed);
	// The QIDs it adds, and the ones already linked in the draft (handled, not remembered yet): at the publish they
	// count as handled when the proposal was applied, so a link taken out by hand before then stays out. An applied
	// earlier proposal's links stay in it, so that still shows once this one adds none.
	const remembered = new Set(memo?.linked ?? []);
	let planned: NonNullable<LinkMemo["planned"]> | null = plan
		? {
				qids: [...new Set([...terms.map((c) => c.qid), ...[...plan.handled].filter((q) => !remembered.has(q))])].sort(),
				slugs: [...new Set([...terms.map((c) => c.slug), ...(applied?.slugs ?? [])])].sort(),
				at: Date.now(),
				// The text it's for, before and after the patch: a save of that text without the links isn't its publish (src/ai/pack.ts).
				...(t0 ? { texts: [...new Set([t0.textHash, ...(t1 ? [t1.textHash] : [])])] } : {}),
			}
		: null;
	if (planned && !planned.qids.length && !planned.slugs.length && !memo?.planned) planned = null;
	// A run that outlived its lock (see LOCK_MAX_MS) leaves the state to the click that has it now.
	if ((stage || forget || planned) && !(await run.held())) ctx.log.warn("AI Enrich: another click took over this entry; this one's analysis isn't staged", { entry: key });
	else if (stage || forget || planned) {
		await saveState(ctx, { key, collection, id, drafts, stage, forget, planned }).catch((error: unknown) =>
			ctx.log.warn("AI Enrich: couldn't stage the analysis; the next click or the publish uses what was saved on the way", { entry: key, error: String(error).slice(0, 300) }),
		);
	}

	// ── The toast and the review ──
	const imageTotal = slots.length;
	const alts = fills.filter((f) => f.alt).length;
	const captions = fills.filter((f) => f.caption).length;
	const left = slots.filter((slot) => slot.mediaId && pendingIds.has(slot.mediaId) && !fills.some((f) => f.slot === slot)).length;
	const names = [...new Set(terms.map((c) => c.entity))];
	const added = terms.filter((c) => c.action === "add").length;
	const switched = terms.length - added;
	const parts: string[] = [];
	if (terms.length) {
		const named = `(${names.slice(0, 6).join(", ")}${names.length > 6 ? `, and ${names.length - 6} more` : ""})`;
		const what = !switched ? `Added ${plural(added, "glossary.io link")}` : !added ? `Switched ${plural(switched, "link")} to glossary.io` : `Added ${plural(added, "glossary.io link")} and switched ${plural(switched, "link")} to glossary.io`;
		parts.push(`${what} ${named}.`);
	}
	if (fixes.length) parts.push(`Put ${plural(fixes.length, "possessive")} inside glossary.io links.`);
	if (describedNow) parts.push("Wrote a meta description.");
	if (fills.length || left) {
		parts.push(
			left
				? `Wrote image text for ${fills.length} of ${plural(imageTotal, "image")}. Click AI Enrich again for the rest.`
				: `Wrote alt text for ${alts} and captions for ${captions} of ${plural(imageTotal, "image")}.`,
		);
	}
	if (ops.length) parts.push(TOASTS.review);
	const what = parts.join(" ");
	const issue: Issue | undefined = issues.entity ?? issues.description ?? issues.image ?? issues.links;
	// Only time, or images past this request's cap, stopped it: the panel asks again, and that round starts where this one stopped.
	// A round that timed out with nothing new (Wikidata too slow for even one lookup) would only repeat itself.
	const more = issue?.kind === "time" ? progressed || JSON.stringify(cache) !== cacheBefore : !issue && left > 0;
	const review: EnrichReview = {
		links: termFields.map(({ c, field }) => ({ name: c.entity, slug: c.slug, url: c.href, field, action: c.action === "add" ? ("add" as const) : ("switch" as const) })),
		possessives: fixes.length,
		images: fills.map((f) => ({ field: f.slot.field, mediaId: f.slot.mediaId, filename: (f.slot.mediaId && filenames.get(f.slot.mediaId)) || "", ...(f.alt ? { alt: f.alt } : {}), ...(f.caption ? { caption: f.caption } : {}) })),
		...(describedNow ? { description: fillDescription } : {}),
		// With an image issue (the limit, an error) the message says why the rest have none.
		leftAlone: issues.image ? 0 : slots.filter((slot) => !filled.has(slot) && !(slot.mediaId && pendingIds.has(slot.mediaId))).length,
		remaining: left,
	};
	const answer = (type: Toast["type"], lead: string): EnrichAnswer => ({
		toast: { type, message: [lead, what].filter(Boolean).join(" ") },
		...(ops.length ? { patch: { type: "editor-draft-patch" as const, operations: ops }, review } : {}),
		...(more ? { more: true as const } : {}),
		...(imageTotal ? { progress: { imagesDone: fills.length, imagesTotal: fills.length + left } } : {}),
	});
	if (issue?.kind === "limit") return answer("error", TOASTS.limit);
	if (issue?.kind === "busy") return answer("info", `Wikidata asked to slow down. Try again in ${plural(Math.max(1, Math.ceil((issue.until - Date.now()) / 60_000)), "minute")}.`);
	if (issue?.kind === "time") return answer("info", TOASTS.outOfTime);
	if (issue?.kind === "error") return answer("error", `The AI service didn't answer: ${issue.reason}. ${TOASTS.retry}`);
	if (issue?.kind === "trouble") return answer("error", `${issue.what}: ${issue.reason}. ${TOASTS.retry}`);
	if (issue?.kind === "no-index") return answer("info", TOASTS.noIndex);
	if (links && found && !found.length) return answer("info", TOASTS.noEntities);
	if (ops.length) return answer("success", "");
	if (what) return answer("info", "");
	return toast("info", imageTotal ? leftAlone(imageTotal) : TOASTS.nothingToAdd);
}

/**
 * Write what the click staged, under the AI lock when it can be had within about 10 seconds (the scheduled run
 * links and writes memos too); otherwise anyway: the memo is merged with compareAndSet, so nothing in it is lost.
 */
async function saveState(
	ctx: PluginContext,
	s: { key: string; collection: string; id: string; drafts: StorageCollection<DraftRecord>; stage: DraftRecord | null; forget: boolean; planned: LinkMemo["planned"] | null },
): Promise<void> {
	const write = async () => {
		if (s.stage) await s.drafts.put(s.key, s.stage);
		else if (s.forget) await s.drafts.delete(s.key);
		if (s.planned && !(await savePlanned(ctx, s.key, s.collection, s.id, s.planned))) ctx.log.warn("AI Enrich: couldn't record the planned links; the publish links the entry as usual", { entry: s.key });
		return true;
	};
	for (let i = 0; i < 5; i++) {
		if (await withLock(ctx, 30_000, write)) return;
		await enrichIo.wait(2_000);
	}
	await write();
}

/**
 * Only `planned` changes in the stored memo (compareAndSet, three tries). A memo made here counts as nothing
 * remembered (unseenMemo), like a possessives-only run's: without a text hash, an ordinary one would read as a text
 * change, and the next analysis (a settings-only one too) would link the live entry. The publish that settles the
 * plan with a check makes it an ordinary one (settlePlanned); a first analysis still links.
 */
async function savePlanned(ctx: PluginContext, key: string, collection: string, id: string, planned: NonNullable<LinkMemo["planned"]>): Promise<boolean> {
	const memos = linkMemos(ctx);
	for (let i = 0; i < 3; i++) {
		const current = await memos.getVersioned(key);
		const memo: LinkMemo = { ...(current?.value ?? unseenMemo(collection, id)), planned, updated: new Date().toISOString() };
		if ((await memos.compareAndSet(key, current?.revision ?? null, memo)).applied) return true;
	}
	return false;
}

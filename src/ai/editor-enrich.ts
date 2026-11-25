/**
 * AI Enrich (since 0.52.0): the entry editor's toolbar button, through the
 * companion plugin (src/editor.ts) and the bridge (src/core/bridge.ts). It
 * works on the editor's current draft, saved or not, never-published entries
 * too, and answers with one patch the editor shows for review:
 * - glossary.io links by the same rules as after publishing (planEntryLinks),
 *   possessives moved inside them;
 * - alt text and captions for the images that have none, in the entry's own
 *   image blocks and image fields. Text a person wrote is never replaced.
 *
 * The analysis is staged (aiDrafts, DraftRecord), never written to aiEntries:
 * the publish whose title and text it analyzed promotes it without a model
 * call (src/ai/pack.ts), and a second click reuses everything paid for. The
 * links it proposed wait in the entry's memo (planned) until that publish;
 * none count as linked before then. Every failure is a toast: it never throws.
 */
import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import { type FeatureMap, ctxFeatures, isOn } from "../core/features.js";
import { ACTION_LIMITS, type ImageFill, type ImageSlot, imageSlots, jsonBytes, responseFits, withImageText } from "./editor-images.js";
import { glossaryFor, isGlossarySite } from "./glossary.js";
import { type EntryLinkPlan, type LinkMemo, linkConfig, linkMemos, planEntryLinks } from "./glossary-linker.js";
import { glossarySlug } from "./glossary-links.js";
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
	suggestDescription,
	targetCollections,
} from "./worker.js";

type Settings = AiSettings & { apiKey: string };
type Toast = { message: string; type: "success" | "error" | "info" };

export interface EnrichAnswer {
	toast: Toast;
	patch?: { type: "editor-draft-patch"; operations: Array<{ op: "set"; field: string; value: unknown }> };
}

/** A model call gives up after this long; no new one starts after START_BY_MS, so a click ends in about 75 seconds at most. */
const CALL_TIMEOUT_MS = 40_000;
const START_BY_MS = 50_000;
/** The per-entry lock outlasts any click. */
const LOCK_MS = 120_000;
/** Images described per click, at most (and as many at once). */
const MAX_VISION = 8;
const VISION_AT_ONCE = 3;
/** The toast's room in the answer's size checks. */
const TOAST_ROOM = { message: "x".repeat(1200), type: "success" };

/** Waits between tries for the AI lock (tests replace it). */
export const enrichIo = { wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

const toast = (type: Toast["type"], message: string): EnrichAnswer => ({ toast: { type, message } });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reasonOf = (error: unknown) =>
	error instanceof OutOfTimeError ? "it took too long" : String((error as Error)?.message ?? error).replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 160) || "unknown error";

export const TOASTS = {
	noDraft: "Save the entry once, then click AI Enrich again.",
	off: "AI Enrichment is off for this site. Turn on glossary.io links or Image text under Coywolf Pack → Features.",
	noKey: "AI Enrichment has no API key. Add one on the AI Enrichment page.",
	notCovered: "AI Enrichment doesn't cover this collection.",
	unreadable: "This entry couldn't be read. Reload the page and try again.",
	running: "AI Enrich is already running for this entry. Wait for it to finish.",
	nothingThere: "There's no text or image to work on yet.",
	limit: "Today's AI call limit is reached. Raise it on the AI Enrichment page, or try again tomorrow (UTC).",
	noIndex: "The glossary.io index isn't loaded yet. Open any page on the site, then click again.",
	tooBig: "The text is too large to add everything.",
	review: "Review the changes, then save.",
	nothingToAdd: "Nothing to add: the links and image text are already in place.",
	noEntities: "No entities found in this text, so there are no glossary.io links to add.",
} as const;

type Issue = { kind: "limit" } | { kind: "busy"; until: number } | { kind: "error"; reason: string } | { kind: "no-index" };

interface Selector {
	fields?: string[];
	translatable?: true;
}

interface Draft {
	collection: string;
	entryId: string;
	fields: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(input: unknown): { draft: Draft | null; patch?: Selector } {
	const body = isRecord(input) ? input : {};
	const d = body.draft;
	const draft = isRecord(d) && typeof d.collection === "string" && d.collection && typeof d.entryId === "string" && d.entryId && isRecord(d.fields) ? { collection: d.collection, entryId: d.entryId, fields: d.fields } : null;
	const p = body.patch;
	const patch = isRecord(p) ? { ...(Array.isArray(p.fields) ? { fields: p.fields.filter((f): f is string => typeof f === "string") } : {}), ...(p.translatable === true ? { translatable: true as const } : {}) } : undefined;
	return { draft, patch };
}

/** The fields the patch may set: the button's patch selector (as EmDash reads it), and only ones the draft sent, so no unsaved edit is overwritten. */
function patchableFields(info: CollectionSchemaInfo, selector: Selector | undefined, supplied: Record<string, unknown>): Set<string> {
	const known = new Set(info.fields.map((f) => f.slug));
	const wanted = selector ? new Set([...(selector.fields ?? []), ...(selector.translatable ? info.fields.filter((f) => f.translatable).map((f) => f.slug) : [])]) : new Set(Object.keys(supplied));
	return new Set([...wanted].filter((slug) => known.has(slug) && Object.hasOwn(supplied, slug)));
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
	return { kind: "error", reason: reasonOf(error) };
}

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) await work(items[next++]);
	}));
}

/** Run AI Enrich for one editor draft (the ai/editor-enrich route). */
export async function editorEnrich(ctx: PluginContext, options: AiOptions, input: unknown): Promise<EnrichAnswer> {
	try {
		return await enrich(ctx, options, input);
	} catch (error) {
		ctx.log.error("AI Enrich failed", { error: String(error).slice(0, 300) });
		return toast("error", `AI Enrich didn't work: ${reasonOf(error)}. Click again to retry.`);
	}
}

async function enrich(ctx: PluginContext, options: AiOptions, input: unknown): Promise<EnrichAnswer> {
	const { draft, patch: selector } = parse(input);
	if (!draft) return toast("error", TOASTS.noDraft);
	const [features, s] = await Promise.all([ctxFeatures(ctx), readSettings(ctx, options)]);
	let links = isOn(features, "ai.entities") && isOn(features, "ai.glossaryLinks");
	const images = isOn(features, "ai.imageText");
	if (!links && !images) return toast("info", TOASTS.off);
	if (s.provider === "workers-ai" ? !s.bindingAvailable : !s.apiKey) return toast("error", TOASTS.noKey);
	const { collection, entryId: id } = draft;
	if (!(await targetCollections(ctx, s)).includes(collection)) return toast("info", TOASTS.notCovered);
	const item = ctx.content?.get ? await ctx.content.get(collection, id).catch(() => null) : null;
	const info = item ? await ctx.schema?.getCollection(collection) : null;
	if (!item || !info) return toast("error", TOASTS.unreadable);

	const config = linkConfig(options, ctx.site?.url);
	let linksOff = "";
	if (links && isGlossarySite(ctx.site?.url)) linksOff = "glossary.io links don't run on glossary.io itself";
	else if (links && !config.siteHosts.length) linksOff = "the site's URL isn't known, so glossary.io links can't run";
	else if (links && item.slug && (config.skip.has(item.slug) || config.skip.has(`${collection}:${item.slug}`))) linksOff = "this entry is on the glossary.io links skip list";
	if (linksOff) links = false;
	if (!links && !images) return toast("info", `Nothing to add: ${linksOff}.`);

	const done = await withLock(ctx, LOCK_MS, () => enrichEntry(ctx, options, s, features, { draft, selector, item, info, links, images, config }), editorLockKey(collection, id));
	return done ?? toast("info", TOASTS.running);
}

interface Run {
	draft: Draft;
	selector?: Selector;
	item: NonNullable<Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>>;
	info: CollectionSchemaInfo;
	links: boolean;
	images: boolean;
	config: ReturnType<typeof linkConfig>;
}

/** One image use's text, and where it came from. */
interface Fill extends ImageFill {
	slot: ImageSlot;
}

async function enrichEntry(ctx: PluginContext, options: AiOptions, s: Settings, features: FeatureMap, run: Run): Promise<EnrichAnswer> {
	const { draft, item, info } = run;
	const { collection, entryId: id } = draft;
	const key = entryKey(collection, id);
	const started = Date.now();
	const limits: CallLimits = { timeoutMs: CALL_TIMEOUT_MS, deadline: started + START_BY_MS };
	const bySort = [...info.fields].sort((a, b) => a.sortOrder - b.sortOrder);
	const ptFields = bySort.filter((f) => f.type === "portableText").map((f) => f.slug);
	const patchable = patchableFields(info, run.selector, draft.fields);
	const data = { ...(await savedData(ctx, collection, item)), ...draft.fields };

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
	const live = t0 && record?.status === "ok" && (record.textHash === t0.textHash || record.hash === t0.hash) ? record : null;
	const reusable = t0 && staged && !staged.partial && staged.textHashes.includes(t0.textHash) ? staged : null;
	if (live) {
		entities = live.entities;
		description = live.description;
		described = true;
	} else if (reusable) {
		entities = reusable.entities;
		description = reusable.description;
		described = reusable.described;
	}
	const cache: StageCache = t0 && staged?.cache?.hash === t0.hash ? structuredClone(staged.cache) : { hash: t0?.hash ?? "" };
	const describe = isOn(features, "ai.descriptions");
	if (!live && describe && !described && !(t0?.info.hasSeo && !item.seo?.description?.trim())) described = true;
	const wantDescription = links && describe && !described;

	// Set by the tasks below (an object, so the checks after them aren't narrowed away).
	const issues: { entity?: Issue; description?: Issue; image?: Issue; links?: Issue } = {};

	const entityTask = async () => {
		if (!links || entities || !t0) return;
		if (callsLeft <= 0) return void (issues.entity = { kind: "limit" });
		if ((busyUntil ?? 0) > Date.now()) return void (issues.entity = { kind: "busy", until: busyUntil! });
		try {
			entities = await groundEntities(ctx, options, s, t0, key, cache, budget, limits);
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
		if (callsLeft <= 0) return void (issues.description = { kind: "limit" });
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
	const imageTask = async () => {
		if (!slots.length || !ctx.media) return;
		const ids = [...new Set(slots.map((slot) => slot.mediaId).filter((v): v is string => Boolean(v)))];
		if (!ids.length) return;
		const mediaRecords = col<MediaRecord>(ctx, "aiMedia");
		const [items, stored] = await Promise.all([Promise.all(ids.map((mid) => ctx.media!.get(mid).catch(() => null))), mediaRecords.getMany(ids)]);
		const media = new Map(ids.map((mid, i) => [mid, items[i]] as const));
		const fresh = new Map<string, ImageText>();
		const suggestionOf = (mid: string) => fresh.get(mid) ?? (stored.get(mid)?.status === "dismissed" ? null : (stored.get(mid)?.suggestion ?? null));
		const raster = (mid: string) => {
			const m = media.get(mid);
			return Boolean(m && m.mimeType.startsWith("image/") && m.mimeType !== "image/svg+xml" && stored.get(mid)?.status !== "skipped");
		};
		// A vision call only when neither the library item nor a stored suggestion has what a use of the image lacks.
		const wanted = ids.filter((mid) => {
			const record = stored.get(mid);
			if (!raster(mid) || record?.status === "dismissed" || record?.suggestion) return false;
			const m = media.get(mid)!;
			return slots.some((slot) => slot.mediaId === mid && ((slot.needsAlt && !m.alt?.trim()) || (slot.needsCaption && !m.caption?.trim())));
		});
		// The entity and description calls come first out of what's left of today's calls.
		const perClick = Math.min(MAX_VISION, Math.floor((SUBREQUEST_BUDGET - WORST_CASE_SUBREQUESTS.entry - budget.used) / 2));
		const today = callsLeft - (links && !entities ? 2 : 0) - (wantDescription ? 1 : 0);
		const room = Math.max(0, Math.min(perClick, today));
		if (wanted.length > room && today < perClick) issues.image ??= { kind: "limit" };
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
				issues.image ??= classify(error);
				if (error instanceof DailyLimitError) stop = true;
			}
		});
		for (const slot of slots) {
			if (!slot.mediaId) continue;
			const m = media.get(slot.mediaId);
			const suggestion = suggestionOf(slot.mediaId);
			const alt = slot.needsAlt ? m?.alt?.trim() || suggestion?.alt?.trim() || "" : "";
			const caption = slot.needsCaption ? m?.caption?.trim() || suggestion?.caption?.trim() || "" : "";
			if (alt || caption) filled.set(slot, { ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) });
		}
	};

	await Promise.all([entityTask(), descriptionTask(), imageTask()]);

	// ── Links ──
	let plan: EntryLinkPlan | null = null;
	const found = entities as Entity[] | null;
	if (links && found) {
		const index = await glossaryFor(ctx, ctx.site?.url, { anySwitch: true });
		if (found.length && !index) issues.links = { kind: "no-index" };
		else {
			const lookup = (qid: string) => {
				const term = index ? index(qid) : undefined;
				const slug = term ? glossarySlug(term.url) : null;
				return term && slug ? { slug, names: term.names ?? [] } : null;
			};
			plan = planEntryLinks(data, ptFields, found, lookup, run.config, memo?.linked ?? [], {
				onFixError: (field, error) => ctx.log.warn("AI Enrich: couldn't check a field's possessives; they stay as they are", { entry: key, field, error: String(error) }),
			});
		}
	}

	// ── One patch: links and possessives, then image text, trimmed to EmDash's limits ──
	const excluded = new Set<string>();
	const linkValues = new Map(Object.entries(plan?.patch ?? {}).filter(([field]) => patchable.has(field)));
	let fills: Fill[] = slots.filter((slot) => filled.has(slot)).map((slot) => ({ slot, path: slot.path, ...filled.get(slot) }));
	let trimmed = false;
	const values = () => {
		const out = new Map([...linkValues].filter(([field]) => !excluded.has(field)));
		for (const field of new Set(fills.map((f) => f.slot.field))) {
			if (excluded.has(field)) continue;
			out.set(field, withImageText(out.has(field) ? out.get(field) : data[field], fills.filter((f) => f.slot.field === field)));
		}
		return out;
	};
	/** Drop the last caption (in `field`, or anywhere), else the last alt text. False when there's none. */
	const dropOne = (field?: string) => {
		for (const prop of ["caption", "alt"] as const) {
			for (let i = fills.length - 1; i >= 0; i--) {
				const f = fills[i];
				if ((field && f.slot.field !== field) || !f[prop]) continue;
				const copy: Fill = { ...f };
				delete copy[prop];
				fills = copy.alt || copy.caption ? fills.map((x, j) => (j === i ? copy : x)) : fills.filter((_, j) => j !== i);
				trimmed = true;
				return true;
			}
		}
		return false;
	};
	const order = new Map(bySort.map((f, i) => [f.slug, i]));
	const operations = (map: Map<string, unknown>) => [...map].sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map(([field, value]) => ({ op: "set" as const, field, value }));
	let current = values();
	for (let guard = 0; guard < 5_000; guard++) {
		const big = [...current].find(([, value]) => jsonBytes(value) > ACTION_LIMITS.fieldBytes);
		if (big) {
			if (!dropOne(big[0])) {
				excluded.add(big[0]);
				trimmed = true;
			}
			current = values();
			continue;
		}
		const ops = operations(current);
		const patch = { type: "editor-draft-patch", operations: ops };
		if (!ops.length || (ops.length <= ACTION_LIMITS.operations && jsonBytes(patch) <= ACTION_LIMITS.patchBytes && responseFits({ toast: TOAST_ROOM, patch }))) break;
		if (!dropOne()) {
			const largest = [...current].sort(([, a], [, b]) => jsonBytes(b) - jsonBytes(a))[0];
			if (!largest) break;
			excluded.add(largest[0]);
			trimmed = true;
		}
		current = values();
	}
	const ops = operations(current);
	const kept = (field: string) => current.has(field) && linkValues.has(field);
	const terms = plan ? plan.terms.filter((_, i) => kept(plan!.termFields[i])) : [];
	const fixes = plan ? plan.fixes.filter((_, i) => kept(plan!.fixFields[i])) : [];

	// ── Staged for the publish ──
	const t1 = t0 ? await entryText(ctx, collection, { ...data, ...Object.fromEntries(current) }, s, features) : null;
	const now = new Date().toISOString();
	let stage: DraftRecord | null = null;
	if (links && t0 && issues.entity) {
		// Stopped early: what it paid for is kept for the next click, and the publish analyzes the entry as usual.
		stage = { collection, entryId: id, title: t0.title, hash: t0.hash, textHashes: [t0.textHash], entities: [], description: cache.description ?? "", described: false, partial: true, cache, updated: now };
	} else if (links && t0 && t1 && found && (!live || t1.textHash !== t0.textHash)) {
		// A description that failed leaves `described` false: the next click writes it; the publish analyzes the entry if none does.
		stage = { collection, entryId: id, title: t1.title, hash: t1.hash, textHashes: [...new Set([t0.textHash, t1.textHash])], entities: found, description, described, updated: now };
	}
	const forget = !stage && links && Boolean(found) && Boolean(staged);
	// The QIDs it adds, and the ones already linked in the draft (handled, not remembered yet): at the publish they
	// count as handled when the proposal was applied, so a link taken out by hand before then stays out.
	const remembered = new Set(memo?.linked ?? []);
	const planned = plan ? { qids: [...new Set([...terms.map((c) => c.qid), ...[...plan.handled].filter((q) => !remembered.has(q))])].sort(), slugs: [...new Set(terms.map((c) => c.slug))].sort(), at: Date.now() } : null;
	if (stage || forget || planned) {
		await saveState(ctx, { key, collection, id, drafts, stage, forget, planned }).catch((error: unknown) => ctx.log.warn("AI Enrich: couldn't stage the analysis; the publish analyzes the entry again", { entry: key, error: String(error).slice(0, 300) }));
	}

	// ── The toast ──
	const imageTotal = slots.length;
	const alts = fills.filter((f) => f.alt).length;
	const captions = fills.filter((f) => f.caption).length;
	const left = slots.filter((slot) => slot.mediaId && pendingIds.has(slot.mediaId) && !fills.some((f) => f.slot === slot)).length;
	const names = [...new Set(terms.map((c) => c.entity))];
	const parts: string[] = [];
	if (terms.length) parts.push(`Added ${plural(terms.length, "glossary.io link")} (${names.slice(0, 6).join(", ")}${names.length > 6 ? `, and ${names.length - 6} more` : ""}).`);
	if (fixes.length) parts.push(`Put ${plural(fixes.length, "possessive")} inside glossary.io links.`);
	if (imageTotal) {
		parts.push(
			left
				? `Wrote image text for ${fills.length} of ${plural(imageTotal, "image")}. Click AI Enrich again for the rest.`
				: `Wrote alt text for ${alts} and captions for ${captions} of ${plural(imageTotal, "image")}.`,
		);
	}
	if (ops.length) parts.push(TOASTS.review);
	const what = parts.join(" ");
	const answer = (type: Toast["type"], lead: string): EnrichAnswer => ({
		toast: { type, message: [lead, what].filter(Boolean).join(" ") },
		...(ops.length ? { patch: { type: "editor-draft-patch" as const, operations: ops } } : {}),
	});
	const issue: Issue | undefined = issues.entity ?? issues.description ?? issues.image ?? issues.links;
	if (issue?.kind === "limit") return answer("error", TOASTS.limit);
	if (issue?.kind === "busy") return answer("info", `Wikidata asked to slow down. Try again in ${plural(Math.max(1, Math.ceil((issue.until - Date.now()) / 60_000)), "minute")}.`);
	if (issue?.kind === "error") return answer("error", `The AI service didn't answer: ${issue.reason}. Nothing was charged twice; click again to retry.`);
	if (issue?.kind === "no-index") return answer("info", TOASTS.noIndex);
	if (trimmed) return answer("info", TOASTS.tooBig);
	if (links && found && !found.length) return answer("info", TOASTS.noEntities);
	if (ops.length) return answer("success", "");
	if (what) return answer("info", "");
	return toast("info", TOASTS.nothingToAdd);
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

/** Only `planned` changes in the stored memo (compareAndSet, three tries). A new memo is an ordinary one. */
async function savePlanned(ctx: PluginContext, key: string, collection: string, id: string, planned: NonNullable<LinkMemo["planned"]>): Promise<boolean> {
	const memos = linkMemos(ctx);
	for (let i = 0; i < 3; i++) {
		const current = await memos.getVersioned(key);
		const memo: LinkMemo = { ...(current?.value ?? { collection, entryId: id, linked: [] }), planned, updated: new Date().toISOString() };
		if ((await memos.compareAndSet(key, current?.revision ?? null, memo)).applied) return true;
	}
	return false;
}

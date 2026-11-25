/**
 * AI Enrichment module: Wikidata-grounded entities for Schema.org
 * (about/mentions/sameAs), AI meta descriptions, and AI image text (alt text
 * and captions). Saves and uploads only enqueue work; the cron tick does the
 * model calls, within a daily call limit.
 */
import type { PluginContext } from "emdash";

import { type FeatureMap, cachedCtxFeatures, ctxFeatures, isOn, registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { getEntryEntities } from "./entities.js";
import { GLOSSARY_HOST } from "./glossary.js";
import { REMOVE_GONE_FEATURE } from "./glossary-gone.js";
import { LINK_CHECK_MS, type LinkMemo, isOwnPublish, linkMemos, livePlanned, settlePlanned, shouldLink, withoutPendingNew, withoutPlanned } from "./glossary-linker.js";
import { glossarySlugsIn } from "./glossary-links.js";
import { PROVIDER_HOSTS } from "./providers.js";
import { aiRoutes } from "./routes.js";
import { type AiOptions, type DraftRecord, STORAGE, col, enqueue, entryKey, optionalCol, readSettings, stagedCache, stagedSpent, type EntryRecord } from "./store.js";
import { WIKIDATA_HOST, WIKIDATA_QUERY_HOST } from "./wikidata.js";
import { type StageCache, queueId } from "./logic.js";
import { type EntryText, entryText, modelSignature, targetCollections, tick } from "./worker.js";

export type { AiOptions } from "./store.js";
export { getEntryEntities, type EntryEntities } from "./entities.js";

const FEATURES = [
	{
		id: "ai",
		label: "AI Enrichment",
		description: "AI features powered by Workers AI or your own Anthropic, OpenAI, or Gemini key. Work runs in the background with a daily call limit.",
		default: false,
	},
	{
		id: "ai.entities",
		label: "Entities for schema",
		description: "Find the people, organizations, places, and things each page is about, verified against Wikidata, for Schema.org about/mentions.",
		default: false,
	},
	{
		id: "ai.entitiesStandalone",
		label: "Output entities on their own",
		description: "Add the entities to each page's JSON-LD by themselves. Only needed when Coywolf Schema isn't on.",
		default: false,
	},
	{
		id: "ai.glossary",
		label: "glossary.io definitions",
		description: "When an entity has a definition on glossary.io, add that page to its sameAs, use the definition as its description, and add glossary.io's other names for it (alternateName). Checks glossary.io about once a day.",
		default: true,
	},
	{
		id: "ai.glossaryLinks",
		label: "glossary.io links",
		description: "After an entry's entities are found, link each one that has a glossary.io definition to it, once per entry: an existing link to its home page, Wikipedia article or profile is switched, or its first mention is linked. Internal and affiliate links never change.",
		default: false,
	},
	REMOVE_GONE_FEATURE,
	{
		id: "ai.descriptions",
		label: "Meta descriptions",
		description: "Write meta descriptions for published entries that don't have one, as suggestions or filled in automatically.",
		default: false,
	},
	{
		id: "ai.imageText",
		label: "Image text",
		description: "Write alt text (and optionally captions) for images on upload and in bulk. Text people wrote is kept.",
		default: false,
	},
];
registerFeatures(FEATURES);

export const AI_TASK = "ai-queue";

export function aiPack(options: AiOptions = {}): PackModule {
	/**
	 * Queue an entry when its title or text changed since the last analysis (debounced). Never makes a model call.
	 * New settings alone (another model, a part switched on) don't re-analyze on a save: a bulk run applies them.
	 * An analysis made before 0.51.0 has no text hash yet, so its hash (text and settings) decides, as before.
	 * An analysis the editor's AI Enrich button staged for this title and text is used instead (useStaged), and the
	 * links it planned are settled (settleLinks). Not on this part's own publishes (a link edit, a removal): those
	 * change no text, and what a person's click staged or planned isn't theirs to settle.
	 */
	async function onContent(event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) {
		const content = event.content;
		const id = typeof content.id === "string" ? content.id : null;
		// Only live content: skip unpublished entries and draft saves (autosaves) of published ones,
		// whose pending draft differs from the live revision. Publishing the draft fires afterPublish.
		if (!id || content.status !== "published") return;
		if (typeof content.draftRevisionId === "string" && content.draftRevisionId && content.draftRevisionId !== content.liveRevisionId) return;
		const features = await ctxFeatures(ctx);
		if (!isOn(features, "ai.entities") && !isOn(features, "ai.descriptions")) return;
		const s = await readSettings(ctx, options);
		if (!(await targetCollections(ctx, s)).includes(event.collection)) return;
		const data = (content.data && typeof content.data === "object" ? content.data : content) as Record<string, unknown>;
		const t = await entryText(ctx, event.collection, data, s, features);
		if (!t) return;
		const key = entryKey(event.collection, id);
		const own = isOwnPublish(key, content.liveRevisionId);
		const prev = await col<EntryRecord>(ctx, "aiEntries").get(key);
		const exact = prev?.status === "ok" && prev.hash === t.hash;
		const current = prev?.status === "ok" && (exact || prev.textHash === t.textHash);
		// An analysis of this text under today's settings needs nothing from a click (what one staged for this text is
		// moot, and goes); one under other settings can take a click's newer one.
		const staged = own ? null : exact ? await forgetStaged(ctx, key, t) : await useStaged(ctx, event.collection, id, content, t, current ? prev : null, prev, features, s);
		if (isOn(features, "ai.glossaryLinks") && !own) {
			await settleLinks(ctx, event.collection, id, data, t, prev, staged?.record ?? (current ? "current" : "queued")).catch((error: unknown) =>
				ctx.log.warn("glossary.io links: couldn't settle AI Enrich's planned links", { entry: key, error: String(error) }),
			);
		}
		if (current || staged?.record) return;
		await enqueue(ctx, { kind: "entry", collection: event.collection, entryId: id, due: Date.now() + s.debounceMinutes * 60_000, source: "save", ...(staged?.cache ? { cache: staged.cache } : {}) }, t.hash);
		// Only once the job has it: a failed enqueue leaves what the click paid for where the next publish finds it.
		await staged?.handed?.();
	}

	/**
	 * An entry whose analysis is of the published text under today's settings: what AI Enrich staged for that text
	 * alone is deleted (the editor's panel would say it waits for a publish). One that also waits for its patch's
	 * text stays (stagedSpent).
	 */
	async function forgetStaged(ctx: PluginContext, key: string, t: EntryText): Promise<null> {
		const drafts = optionalCol<DraftRecord>(ctx, "aiDrafts");
		const staged = drafts ? await drafts.get(key).catch(() => null) : null;
		if (staged && stagedSpent(staged, t)) await drafts!.delete(key).catch(() => undefined);
		return null;
	}

	/**
	 * What the analysis AI Enrich staged (aiDrafts) gives a person's publish, with no model call; null when there's none
	 * for it. When it's of this title and text (before or after its patch):
	 * - `record`: complete, and nothing is left to write or fill in: it becomes the entry's analysis (promoted) and
	 *   nothing is queued. The description is handled as an analysis would (src/ai/worker.ts analyzeEntry).
	 * - `cache`: what it paid for goes to the queued job instead (rekeyed to the published text's hash; captions the
	 *   patch added don't change the entities), so the scheduled run pays only for what's missing: a click that stopped
	 *   early, a description that failed or wasn't asked for then, or one to fill in automatically (the run writes it
	 *   past the debounce, not seconds after a publish while the editor is open). `handed` deletes the staged row,
	 *   once the job is queued.
	 * `sameText` (the entry's analysis is of this text, under other settings): nothing is queued for it either way, so
	 * only a complete staged analysis is used, and no description is filled in.
	 * A staged analysis of another text, or made with another provider or model (a bulk run would skip an entry
	 * promoted under today's hash), is deleted: its publish has happened.
	 */
	async function useStaged(
		ctx: PluginContext,
		collection: string,
		id: string,
		content: Record<string, unknown>,
		t: EntryText,
		sameText: EntryRecord | null,
		prev: EntryRecord | null,
		features: FeatureMap,
		s: Awaited<ReturnType<typeof readSettings>>,
	): Promise<{ record?: EntryRecord; cache?: StageCache; handed?: () => Promise<void> } | null> {
		const drafts = optionalCol<DraftRecord>(ctx, "aiDrafts");
		const key = entryKey(collection, id);
		const staged = drafts ? await drafts.get(key).catch(() => null) : null;
		if (!staged || !isOn(features, "ai.entities")) return null;
		const forget = () => drafts!.delete(key).then(() => undefined, () => undefined);
		if (!staged.textHashes.includes(t.textHash) || staged.model !== modelSignature(s)) {
			await forget();
			return null;
		}
		const seoDescription = (content.seo as { description?: unknown } | null | undefined)?.description;
		const hasDescription = typeof seoDescription === "string" && seoDescription.trim().length > 0;
		const wantDescription = isOn(features, "ai.descriptions") && t.info.hasSeo && !hasDescription;
		const complete = !staged.partial;
		if (!sameText && (!complete || (wantDescription && (!staged.described || (Boolean(staged.description) && s.descriptionsMode === "apply"))))) {
			return { cache: stagedCache(staged, t.hash), handed: forget };
		}
		if (!complete) return null;
		let description = prev?.description ?? "";
		let descriptionStatus: EntryRecord["descriptionStatus"] = hasDescription && prev?.descriptionStatus !== "applied" ? "none" : (prev?.descriptionStatus ?? "none");
		if (wantDescription && staged.description && !(sameText && description)) {
			description = staged.description;
			descriptionStatus = "suggested";
		}
		const record: EntryRecord = { collection, entryId: id, title: t.title, hash: t.hash, textHash: t.textHash, status: "ok", error: "", entities: staged.entities, description, descriptionStatus, updated: new Date().toISOString() };
		await col<EntryRecord>(ctx, "aiEntries").put(key, record);
		await forget();
		ctx.log.info("AI: the analysis AI Enrich made in the editor is the published entry's now", { entry: key });
		return { record };
	}

	/**
	 * glossary.io links on a person's publish, with no model call. Links AI Enrich planned (memo.planned) are settled
	 * (settlePlanned), checked a few minutes later by the retry pass when the entry's analysis is of this text
	 * (`current`, or a promoted one). After a promoted analysis with nothing planned, the links are decided as after
	 * an analysis (afterAnalysis in src/ai/worker.ts), and made by the retry pass. When the entry is queued for a new
	 * analysis instead, only `planned` goes: that analysis links. Planned links that are out of date just go.
	 * Written with compareAndSet on the memo as it's stored then: a scheduled run or a site's own re-check may be
	 * writing it too (an edit in progress, links to take out, a retry).
	 */
	async function settleLinks(ctx: PluginContext, collection: string, id: string, data: Record<string, unknown>, t: EntryText, prev: EntryRecord | null, analysis: "current" | "queued" | EntryRecord): Promise<void> {
		const key = entryKey(collection, id);
		const memos = linkMemos(ctx);
		const settle = (memo: LinkMemo | null, now: number): LinkMemo | null => {
			if (memo?.planned) {
				// Out of date: they go, whatever else is decided.
				if (!livePlanned(memo, now)) return typeof analysis === "string" ? withoutPlanned(memo) : (decide(withoutPlanned(memo), now) ?? withoutPlanned(memo));
				const fields = t.info.fields.filter((f) => f.type === "portableText").map((f) => f.slug);
				const published = new Set(fields.flatMap((f) => [...glossarySlugsIn(data[f])]));
				return settlePlanned(memo, published, analysis === "queued" ? null : { textHash: t.textHash, now });
			}
			return typeof analysis === "string" ? null : decide(memo, now);
		};
		/** After a promoted analysis: as afterAnalysis decides. Null: nothing to write. */
		const decide = (memo: LinkMemo | null, now: number): LinkMemo | null => {
			if (typeof analysis === "string") return null;
			const base = withoutPendingNew(memo ?? { collection, entryId: id, linked: [], updated: "" });
			if (!analysis.entities.length || !shouldLink(memo, prev, t.textHash)) return memo?.textHash !== t.textHash || memo?.pendingNew ? { ...base, textHash: t.textHash } : null;
			return { ...base, textHash: t.textHash, retryAt: now + LINK_CHECK_MS, tries: 0 };
		};
		for (let i = 0; i < 4; i++) {
			const stored = await memos.getVersioned(key);
			const next = settle(stored?.value ?? null, Date.now());
			if (!next) return;
			if ((await memos.compareAndSet(key, stored?.revision ?? null, { ...next, updated: new Date().toISOString() })).applied) return;
		}
		throw new Error("the entry's memo kept changing");
	}

	return {
		id: "ai",
		label: "AI Enrichment",
		features: FEATURES,
		routes: aiRoutes(options),
		hooks: {
			"content:afterSave": onContent,
			"content:afterPublish": onContent,
			"content:afterRestore": onContent,
			/** Forget a deleted (or trashed) entry: its analysis, any queued job, and what AI Enrich staged. A restore queues it again. */
			"content:afterDelete": async (event: { id: string; collection: string }, ctx: PluginContext) => {
				await col<EntryRecord>(ctx, "aiEntries").delete(entryKey(event.collection, event.id));
				await col(ctx, "aiQueue").delete(queueId({ kind: "entry", collection: event.collection, entryId: event.id }));
				await optionalCol(ctx, "aiDrafts")?.delete(entryKey(event.collection, event.id));
			},
			"media:afterUpload": async (event: { media: { id: string; mimeType: string } }, ctx: PluginContext) => {
				const { id, mimeType } = event.media;
				if (!mimeType?.startsWith("image/") || mimeType === "image/svg+xml") return;
				await enqueue(ctx, { kind: "media", mediaId: id, due: Date.now() });
			},
			"page:metadata": async (event: { page: { content?: { collection: string; id: string }; canonical: string | null; url: string } }, ctx: PluginContext) => {
				const ref = event.page.content;
				if (!ref) return null;
				// The Schema & Social graph already carries these on its Article/WebPage node.
				if (isOn(await cachedCtxFeatures(ctx), "schema.graph")) return null;
				const { about, mentions } = await getEntryEntities(ctx, ref.collection, ref.id, undefined, { origin: ctx.site?.url ?? event.page.canonical ?? event.page.url });
				if (!about.length && !mentions.length) return null;
				const graph: Record<string, unknown> = { "@context": "https://schema.org", "@type": "WebPage", "@id": event.page.canonical ?? event.page.url };
				if (about.length) graph.about = about;
				if (mentions.length) graph.mentions = mentions;
				return { kind: "jsonld", id: "coywolf-ai-entities", graph };
			},
		},
		hookFeature: {
			"media:afterUpload": "ai.imageText",
			"page:metadata": "ai.entitiesStandalone",
		},
		tasks: [{ name: AI_TASK, schedule: "*/2 * * * *", handler: (ctx: PluginContext) => tick(ctx, options, { budgetMs: 8 * 60_000 }).then(() => undefined) }],
		adminPages: [{ path: "/ai", label: "AI Enrichment", icon: "sparkle" }],
		storage: STORAGE,
		capabilities: ["network:request", "content:read", "content:write", "content:revisions:read", "content:publish", "schema:read", "media:read", "media:bytes:read", "media:metadata:write"],
		allowedHosts: [...PROVIDER_HOSTS, WIKIDATA_HOST, WIKIDATA_QUERY_HOST, GLOSSARY_HOST],
	};
}

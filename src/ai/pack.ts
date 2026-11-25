/**
 * AI Enrichment module: Wikidata-grounded entities for Schema.org
 * (about/mentions/sameAs), AI meta descriptions, and AI image text (alt text
 * and captions). Saves and uploads only enqueue work; the cron tick does the
 * model calls, within a daily call limit.
 */
import type { PluginContext } from "emdash";

import { type FeatureMap, cachedCtxFeatures, ctxFeatures, isOn, registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { afterResponse } from "../shared.js";
import { getEntryEntities } from "./entities.js";
import { GLOSSARY_HOST } from "./glossary.js";
import { REMOVE_GONE_FEATURE } from "./glossary-gone.js";
import { LINK_CHECK_MS, linkMemos, settlePlanned, shouldLink, withoutPendingNew } from "./glossary-linker.js";
import { glossarySlugsIn } from "./glossary-links.js";
import { PROVIDER_HOSTS } from "./providers.js";
import { aiRoutes } from "./routes.js";
import { type AiOptions, type DraftRecord, STORAGE, col, enqueue, entryKey, optionalCol, readSettings, type EntryRecord } from "./store.js";
import { WIKIDATA_HOST, WIKIDATA_QUERY_HOST } from "./wikidata.js";
import { queueId } from "./logic.js";
import { type EntryText, applyDescription, entryText, targetCollections, tick } from "./worker.js";

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
	 * An analysis the editor's AI Enrich button staged for this title and text is promoted instead (promote), and
	 * the links it planned are settled (settleLinks).
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
		const prev = await col<EntryRecord>(ctx, "aiEntries").get(key);
		const current = prev?.status === "ok" && (prev.hash === t.hash || prev.textHash === t.textHash);
		const promoted = current ? null : await promote(ctx, event.collection, id, content, t, prev, features, s);
		if (isOn(features, "ai.glossaryLinks")) {
			await settleLinks(ctx, event.collection, id, data, t, prev, current ? "current" : (promoted ?? "queued")).catch((error: unknown) =>
				ctx.log.warn("glossary.io links: couldn't settle AI Enrich's planned links", { entry: key, error: String(error) }),
			);
		}
		if (current || promoted) return;
		await enqueue(ctx, { kind: "entry", collection: event.collection, entryId: id, due: Date.now() + s.debounceMinutes * 60_000, source: "save" });
	}

	/**
	 * The analysis AI Enrich staged (aiDrafts) becomes the entry's, when it's of this title and text (before or after
	 * its patch), complete, and made with the parts that are on now; null otherwise (the entry is queued as usual).
	 * No model call. The description is handled as an analysis would (src/ai/worker.ts analyzeEntry).
	 */
	async function promote(ctx: PluginContext, collection: string, id: string, content: Record<string, unknown>, t: EntryText, prev: EntryRecord | null, features: FeatureMap, s: Awaited<ReturnType<typeof readSettings>>): Promise<EntryRecord | null> {
		const drafts = optionalCol<DraftRecord>(ctx, "aiDrafts");
		const key = entryKey(collection, id);
		const staged = drafts ? await drafts.get(key).catch(() => null) : null;
		if (!staged || staged.partial || !staged.textHashes.includes(t.textHash) || !isOn(features, "ai.entities")) return null;
		const describe = isOn(features, "ai.descriptions");
		if (describe && !staged.described) return null;
		const seoDescription = (content.seo as { description?: unknown } | null | undefined)?.description;
		const hasDescription = typeof seoDescription === "string" && seoDescription.trim().length > 0;
		let description = prev?.description ?? "";
		let descriptionStatus: EntryRecord["descriptionStatus"] = hasDescription && prev?.descriptionStatus !== "applied" ? "none" : (prev?.descriptionStatus ?? "none");
		const wantDescription = describe && t.info.hasSeo && !hasDescription && Boolean(staged.description);
		if (wantDescription) {
			description = staged.description;
			descriptionStatus = "suggested";
		}
		const record: EntryRecord = { collection, entryId: id, title: t.title, hash: t.hash, textHash: t.textHash, status: "ok", error: "", entities: staged.entities, description, descriptionStatus, updated: new Date().toISOString() };
		const records = col<EntryRecord>(ctx, "aiEntries");
		await records.put(key, record);
		await drafts!.delete(key).catch(() => undefined);
		ctx.log.info("AI: the analysis AI Enrich made in the editor is the published entry's now", { entry: key });
		if (wantDescription && s.descriptionsMode === "apply") {
			afterResponse(
				applyDescription(ctx, collection, id, description, false)
					.then(async (applied) => {
						if (applied) await records.put(key, { ...record, descriptionStatus: "applied", updated: new Date().toISOString() });
					})
					.catch((error: unknown) => ctx.log.warn("AI: couldn't apply the meta description", { entry: key, error: String(error) })),
			);
		}
		return record;
	}

	/**
	 * glossary.io links on a publish, with no model call. Links AI Enrich planned (memo.planned) are settled
	 * (settlePlanned), checked a few minutes later by the retry pass when the entry's analysis is of this text
	 * (`current`, or a promoted one). After a promoted analysis with nothing planned, the links are decided as after
	 * an analysis (afterAnalysis in src/ai/worker.ts), and made by the retry pass. When the entry is queued for a new
	 * analysis instead, only `planned` goes: that analysis links.
	 */
	async function settleLinks(ctx: PluginContext, collection: string, id: string, data: Record<string, unknown>, t: EntryText, prev: EntryRecord | null, analysis: "current" | "queued" | EntryRecord): Promise<void> {
		const key = entryKey(collection, id);
		const memos = linkMemos(ctx);
		const memo = await memos.get(key);
		const now = Date.now();
		const updated = new Date().toISOString();
		if (memo?.planned) {
			const fields = t.info.fields.filter((f) => f.type === "portableText").map((f) => f.slug);
			const published = new Set(fields.flatMap((f) => [...glossarySlugsIn(data[f])]));
			await memos.put(key, { ...settlePlanned(memo, published, analysis === "queued" ? null : { textHash: t.textHash, now }), updated });
			return;
		}
		if (typeof analysis === "string") return;
		const base = withoutPendingNew(memo ?? { collection, entryId: id, linked: [], updated: "" });
		if (!analysis.entities.length || !shouldLink(memo, prev, t.textHash)) {
			if (memo?.textHash !== t.textHash || memo?.pendingNew) await memos.put(key, { ...base, textHash: t.textHash, updated });
			return;
		}
		await memos.put(key, { ...base, textHash: t.textHash, retryAt: now + LINK_CHECK_MS, tries: 0, updated });
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

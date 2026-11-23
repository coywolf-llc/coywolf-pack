/**
 * AI Enrichment module: Wikidata-grounded entities for Schema.org
 * (about/mentions/sameAs), AI meta descriptions, and AI image text (alt text
 * and captions). Saves and uploads only enqueue work; the cron tick does the
 * model calls, within a daily call limit.
 */
import type { PluginContext } from "emdash";

import { cachedCtxFeatures, ctxFeatures, isOn, registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { getEntryEntities } from "./entities.js";
import { GLOSSARY_HOST } from "./glossary.js";
import { PROVIDER_HOSTS } from "./providers.js";
import { aiRoutes } from "./routes.js";
import { type AiOptions, STORAGE, col, enqueue, entryKey, readSettings, type EntryRecord } from "./store.js";
import { WIKIDATA_HOST, WIKIDATA_QUERY_HOST } from "./wikidata.js";
import { queueId } from "./logic.js";
import { entryText, targetCollections, tick } from "./worker.js";

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
		description: "When an entity has a definition on glossary.io, add that page to its sameAs and use the definition as its description. Checks glossary.io about once a day.",
		default: true,
	},
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
	/** Queue an entry when its text changed since the last analysis (debounced). Never makes a model call. */
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
		const prev = await col<EntryRecord>(ctx, "aiEntries").get(entryKey(event.collection, id));
		if (prev?.status === "ok" && prev.hash === t.hash) return;
		await enqueue(ctx, { kind: "entry", collection: event.collection, entryId: id, due: Date.now() + s.debounceMinutes * 60_000 });
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
			/** Forget a deleted (or trashed) entry: its analysis and any queued job. A restore queues it again. */
			"content:afterDelete": async (event: { id: string; collection: string }, ctx: PluginContext) => {
				await col<EntryRecord>(ctx, "aiEntries").delete(entryKey(event.collection, event.id));
				await col(ctx, "aiQueue").delete(queueId({ kind: "entry", collection: event.collection, entryId: event.id }));
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
		capabilities: ["network:request", "content:read", "content:write", "schema:read", "media:read", "media:bytes:read", "media:metadata:write"],
		allowedHosts: [...PROVIDER_HOSTS, WIKIDATA_HOST, WIKIDATA_QUERY_HOST, GLOSSARY_HOST],
	};
}

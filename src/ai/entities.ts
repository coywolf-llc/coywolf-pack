/**
 * Read the grounded entities for an entry, for Schema.org output.
 *
 * The Schema module calls `getEntryEntities(ctx, collection, id)` (inside the
 * plugin context) or `getEntryEntities(db, collection, id)` with the site's
 * D1 database (outside it, e.g. an Astro component), and merges `about` and
 * `mentions` into its Article/WebPage node. Returns empty lists when the
 * "ai.entities" feature is off or nothing has been analyzed yet. With
 * "ai.glossary" on, entities that have a glossary.io definition link to it
 * (src/ai/glossary.ts; `origin` is the site's, so glossary.io itself is left
 * out). With a D1 database, only a copy the site already stored is used.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { PLUGIN_ID, cachedCtxFeatures, isOn, siteFeatures } from "../core/features.js";
import { noteReadFailure } from "../core/read-failures.js";
import { glossaryFor } from "./glossary.js";
import { type Entity, entityNodes } from "./logic.js";
import type { EntryRecord } from "./store.js";

export interface EntryEntities {
	entities: Entity[];
	about: Record<string, unknown>[];
	mentions: Record<string, unknown>[];
}

const EMPTY: EntryEntities = { entities: [], about: [], mentions: [] };

type Source = Pick<PluginContext, "storage" | "settings"> | D1Database;

function isD1(source: Source): source is D1Database {
	return typeof (source as D1Database).prepare === "function";
}

/**
 * `preloaded.record`: the entry's aiEntries doc, already read by the caller
 * (Schema & Social reads it with the entry's other docs), so nothing is read
 * here; the caller has checked the "ai.entities" switch.
 */
export async function getEntryEntities(source: Source, collection: string, id: string, preloaded?: { record: EntryRecord | null }, options: { origin?: string | null } = {}): Promise<EntryEntities> {
	try {
		let record: EntryRecord | null = null;
		if (preloaded) {
			record = preloaded.record ?? null;
		} else if (isD1(source)) {
			if (!isOn(await siteFeatures(), "ai.entities")) return EMPTY;
			const row = await source
				.prepare("SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?")
				.bind(PLUGIN_ID, "aiEntries", `${collection}:${id}`)
				.first<{ data: string }>();
			record = row?.data ? (JSON.parse(row.data) as EntryRecord) : null;
		} else {
			if (!isOn(await cachedCtxFeatures(source), "ai.entities")) return EMPTY;
			const entries = (source.storage as Record<string, StorageCollection>).aiEntries as StorageCollection<EntryRecord> | undefined;
			record = (await entries?.get(`${collection}:${id}`)) ?? null;
		}
		const entities = Array.isArray(record?.entities) ? record.entities : [];
		if (!entities.length) return EMPTY;
		// Never throws, and a glossary.io failure doesn't keep the page out of the edge cache.
		const glossary = await glossaryFor(source, options.origin);
		return { entities, ...entityNodes(entities, glossary) };
	} catch {
		noteReadFailure("AI entities"); // The page goes out without its entities: not into the edge cache.
		return EMPTY; // Schema output must never fail because of enrichment.
	}
}

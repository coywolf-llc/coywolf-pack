/**
 * Everything the pack stores about one entry, read for a page render in one
 * D1 round trip: its plugin-storage docs in several collections (Schema
 * overrides, the Videos embed index, AI entities…, all keyed
 * "<collection>:<entry id>") in a single query, plus, when asked, the
 * entry's own row (for blocks the theme didn't hand over), batched with it.
 *
 * Before, each module read its doc on its own (three to five queries per
 * page). Without a D1 binding (tests, other databases) it falls back to the
 * plugin context's storage and content APIs, one read each, at once.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { batchedAll, batchedFirst } from "./d1-batch.js";
import { PLUGIN_ID } from "./features.js";
import { noteReadFailure } from "./read-failures.js";
import { peekRequestMemo, seedRequestMemo } from "./request-memo.js";
import { workerEnv } from "../shared.js";

export interface EntryDocsRequest {
	collection: string;
	id: string;
	/** Plugin-storage collections whose doc for this entry (id "<collection>:<entry id>") is wanted. */
	collections: readonly string[];
	/** Also read the entry's own data (its row in ec_<collection>). */
	data?: boolean;
	/** D1 binding of the site database. Default "DB". */
	database?: string;
}

export interface EntryDocs {
	/** Storage collection → this entry's doc (null when there's none). */
	docs: Map<string, unknown>;
	/** The entry's fields (JSON fields parsed), when asked for; null when the entry doesn't exist. */
	data?: Record<string, unknown> | null;
}

/** ec_<collection> names EmDash accepts (validateIdentifier). */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

type Row = Record<string, unknown>;

/**
 * An entry row's fields: JSON text columns (Portable Text, objects, lists)
 * parsed. Only columns that look like JSON are parsed, and `mustContain`
 * skips parsing large columns that can't hold what the caller looks for.
 */
export function rowData(row: Row | null | undefined, mustContain?: string): Record<string, unknown> | null {
	if (!row) return null;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (typeof value === "string" && (value.startsWith("[") || value.startsWith("{"))) {
			if (mustContain && !value.includes(mustContain)) continue;
			try {
				out[key] = JSON.parse(value);
				continue;
			} catch {
				// Not JSON after all: keep the text.
			}
		}
		out[key] = value;
	}
	return out;
}

async function readFromD1(db: D1Database, req: EntryDocsRequest, mustContain?: string): Promise<EntryDocs> {
	const key = `${req.collection}:${req.id}`;
	const wantData = req.data && IDENTIFIER.test(req.collection);
	// Both go out with the page's other pack reads of this tick (one D1 batch).
	const [rows, entry] = await Promise.all([
		req.collections.length
			? batchedAll<{ collection: string; data: string | null }>(
					db,
					db
						.prepare(`SELECT collection, data FROM _plugin_storage WHERE plugin_id = ? AND id = ? AND collection IN (${req.collections.map(() => "?").join(",")})`)
						.bind(PLUGIN_ID, key, ...req.collections),
				)
			: [],
		wantData ? batchedFirst<Row>(db, db.prepare(`SELECT * FROM "ec_${req.collection}" WHERE id = ? AND deleted_at IS NULL LIMIT 1`).bind(req.id)) : null,
	]);
	const docs = new Map<string, unknown>(req.collections.map((c) => [c, null]));
	for (const row of rows) {
		try {
			docs.set(row.collection, row.data ? JSON.parse(row.data) : null);
		} catch {
			docs.set(row.collection, null);
		}
	}
	const out: EntryDocs = { docs };
	if (req.data) out.data = wantData ? rowData(entry, mustContain) : null;
	return out;
}

async function readFromContext(ctx: PluginContext, req: EntryDocsRequest): Promise<EntryDocs> {
	const key = `${req.collection}:${req.id}`;
	const storage = ctx.storage as Record<string, StorageCollection | undefined>;
	const [values, entry] = await Promise.all([
		Promise.all(req.collections.map((c) => storage[c]?.get(key) ?? null)),
		req.data && ctx.content
			? ctx.content.get(req.collection, req.id).catch(() => {
					noteReadFailure("entry data");
					return null;
				})
			: null,
	]);
	const out: EntryDocs = { docs: new Map(req.collections.map((c, i) => [c, values[i] ?? null])) };
	if (req.data) out.data = (entry?.data as Record<string, unknown> | undefined) ?? null;
	return out;
}

/**
 * Read an entry's docs (and data). One D1 batch when the site database is
 * bound; otherwise the plugin context's reads. `mustContain` (optional): only
 * JSON columns containing it are parsed from a D1 row.
 */
async function readUncached(ctx: PluginContext, req: EntryDocsRequest, mustContain?: string): Promise<EntryDocs> {
	let db: D1Database | undefined;
	try {
		db = (await workerEnv())[req.database ?? "DB"] as D1Database | undefined;
	} catch {
		db = undefined; // Not on Workers.
	}
	if (db && typeof db.prepare === "function") {
		try {
			return await readFromD1(db, req, mustContain);
		} catch (error) {
			ctx.log?.warn?.("coywolf-pack: entry docs read failed; reading them one by one", { error: String(error) });
			// Without content access the fallback can't read the entry's data (it reads as null).
			if (req.data && !ctx.content) noteReadFailure("entry data");
		}
	}
	return readFromContext(ctx, req);
}

const docKey = (req: EntryDocsRequest, collection: string) => `coywolf-entry-doc:${collection}:${req.collection}:${req.id}`;
const dataKey = (req: EntryDocsRequest, mustContain?: string) => `coywolf-entry-data:${req.collection}:${req.id}:${mustContain ?? ""}`;

/**
 * Read an entry's docs (and data), each at most once per request: callers
 * that ask for the same entry (the page:metadata hook run more than once,
 * modules' own hooks) share the reads. What isn't read yet in this request
 * is one D1 batch when the site database is bound; otherwise the plugin
 * context's reads. `mustContain` (optional): only JSON columns containing it
 * are parsed from a D1 row.
 */
export async function readEntryDocs(ctx: PluginContext, req: EntryDocsRequest, mustContain?: string): Promise<EntryDocs> {
	const known = new Map<string, Promise<unknown>>();
	const missing: string[] = [];
	for (const c of req.collections) {
		const hit = peekRequestMemo<unknown>(docKey(req, c));
		if (hit) known.set(c, hit);
		else missing.push(c);
	}
	const dataHit = req.data ? peekRequestMemo<Record<string, unknown> | null>(dataKey(req, mustContain)) : undefined;
	const wantData = Boolean(req.data && !dataHit);
	let data: Promise<Record<string, unknown> | null> | undefined = dataHit;
	if (missing.length || wantData) {
		const read = readUncached(ctx, { ...req, collections: missing, data: wantData }, mustContain);
		for (const c of missing) {
			const one = read.then((d) => d.docs.get(c) ?? null);
			seedRequestMemo(docKey(req, c), one);
			known.set(c, one);
		}
		if (wantData) {
			data = read.then((d) => d.data ?? null);
			seedRequestMemo(dataKey(req, mustContain), data);
		}
		await read;
	}
	const collections = [...known];
	const values = await Promise.all(collections.map(([, v]) => v));
	const out: EntryDocs = { docs: new Map(collections.map(([c], i) => [c, values[i]])) };
	if (req.data) out.data = (await data) ?? null;
	return out;
}

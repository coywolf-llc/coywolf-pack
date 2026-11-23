/**
 * glossary.io definitions for entities (AI Enrichment part "ai.glossary", on
 * by default).
 *
 * glossary.io publishes one index of its terms keyed by Wikidata ID
 * (https://glossary.io/api/entities.json: {v: 1, terms: {QID: [slug, definition]}}).
 * An entity in a page's Schema.org whose QID is listed gets
 * https://glossary.io/{slug}/ added to its sameAs (last) and the glossary's
 * short definition as its description (see entityNodes in logic.ts).
 *
 * Lookups: the whole index (about 1,000 terms, 80 KB compressed) comes in one
 * request and is stored on the site (plugin storage aiGlossary/index); each
 * isolate keeps it in memory for an hour, so a render reads the stored copy at
 * most once an hour per isolate and usually not at all. glossary.io is asked
 * only when the site has no copy yet (the first render that needs it, so pages
 * aren't cached without it) and, after the response, when the copy is a day
 * old: about one request a day per site, and none on days nothing renders.
 *
 * glossary.io failing never fails a page or keeps it out of the edge cache:
 * the page renders with the copy it has (or without glossary data), and that
 * isolate tries again 10 minutes later. Pages already in the edge cache keep
 * what they had until they render again. Not used on glossary.io itself,
 * whose term pages are the definitions.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { PLUGIN_ID, cachedCtxFeatures, isOn, siteFeatures } from "../core/features.js";
import { sharedRead, sharedSlot } from "../core/single-flight.js";
import { afterResponse } from "../shared.js";
import type { GlossaryLookup } from "./logic.js";

export const GLOSSARY_ORIGIN = "https://glossary.io";
export const GLOSSARY_HOST = "glossary.io";
const INDEX_URL = `${GLOSSARY_ORIGIN}/api/entities.json`;
export const GLOSSARY_COLLECTION = "aiGlossary";
const DOC_ID = "index";

/** A stored copy older than this is refreshed after the response. */
const REFRESH_MS = 24 * 60 * 60_000;
/** How long an isolate uses its in-memory copy before reading the stored one again (another isolate may have refreshed it). */
const MEMO_MS = 60 * 60_000;
/** After a failed fetch (or a read that found nothing), how long an isolate waits before trying again. */
const RETRY_MS = 10 * 60_000;
/** A render that has no copy at all waits this long for glossary.io (it's edge-cached there). */
const FILL_TIMEOUT_MS = 1_500;
/** A refresh after the response can take longer. */
const REFRESH_TIMEOUT_MS = 10_000;
/** Sanity limits on what glossary.io sends (today: about 1,000 terms, 220 KB). */
const MAX_BYTES = 4_000_000;
const MAX_TERMS = 50_000;
const MAX_DESCRIPTION = 500;

const QID = /^Q[1-9][0-9]{0,11}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export type GlossaryTerms = Record<string, [slug: string, description: string]>;

interface StoredIndex {
	fetchedAt: number;
	terms: GlossaryTerms;
}

/**
 * glossary.io's index, checked: only well-formed QIDs and slugs, and one-line
 * descriptions of at most 500 characters. Null when it isn't a version-1
 * index at all (a changed format is ignored, not guessed at).
 */
export function parseGlossaryIndex(value: unknown): GlossaryTerms | null {
	if (!value || typeof value !== "object") return null;
	const { v, terms } = value as { v?: unknown; terms?: unknown };
	if (v !== 1 || !terms || typeof terms !== "object" || Array.isArray(terms)) return null;
	const out: GlossaryTerms = {};
	let count = 0;
	for (const [qid, term] of Object.entries(terms as Record<string, unknown>)) {
		if (count >= MAX_TERMS) break;
		if (!QID.test(qid) || !Array.isArray(term)) continue;
		const [slug, description] = term as unknown[];
		if (typeof slug !== "string" || !SLUG.test(slug) || typeof description !== "string") continue;
		const text = description.replace(/\s+/g, " ").trim();
		if (!text || text.length > MAX_DESCRIPTION) continue;
		out[qid] = [slug, text];
		count++;
	}
	return out;
}

/** The lookup entityNodes uses: a QID → its glossary.io page and definition. */
export function glossaryLookup(terms: GlossaryTerms | null | undefined): GlossaryLookup | undefined {
	if (!terms) return undefined;
	return (qid) => {
		const term = Object.hasOwn(terms, qid) ? terms[qid] : undefined;
		return term ? { url: `${GLOSSARY_ORIGIN}/${term[0]}/`, description: term[1] } : undefined;
	};
}

/** True for glossary.io itself (and its www name), where the feature stays off. */
export function isGlossarySite(origin: string | null | undefined): boolean {
	if (!origin) return false;
	try {
		const host = new URL(origin).hostname.toLowerCase();
		return host === GLOSSARY_HOST || host === `www.${GLOSSARY_HOST}`;
	} catch {
		return false;
	}
}

// ── Loading ──────────────────────────────────────────────────────

type Source = Pick<PluginContext, "storage" | "settings"> | D1Database;
type Ctx = Pick<PluginContext, "storage" | "settings"> & { http?: { fetch: typeof fetch } | null };

function isD1(source: Source): source is D1Database {
	return typeof (source as D1Database).prepare === "function";
}

function store(ctx: Ctx): StorageCollection<StoredIndex> | undefined {
	return (ctx.storage as Record<string, StorageCollection>)[GLOSSARY_COLLECTION] as StorageCollection<StoredIndex> | undefined;
}

/** This isolate's copy: `terms` null when the site had none (kept RETRY_MS, then read again). */
interface Memo {
	terms: GlossaryTerms | null;
	fetchedAt: number;
	readAt: number;
}

let memo: Memo | null = null;
/** When this isolate last failed to fetch the index, and last started a refresh. */
let failedAt = 0;
let refreshStartedAt = 0;
const slot = sharedSlot<Memo>();

async function fetchIndex(ctx: Ctx, timeoutMs: number): Promise<StoredIndex> {
	const get = ctx.http ? ctx.http.fetch.bind(ctx.http) : fetch;
	const response = await get(INDEX_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`glossary.io index: HTTP ${response.status}`);
	const text = await response.text();
	if (text.length > MAX_BYTES) throw new Error("glossary.io index: too large");
	const terms = parseGlossaryIndex(JSON.parse(text));
	if (!terms) throw new Error("glossary.io index: unknown format");
	return { fetchedAt: Date.now(), terms };
}

function validStored(doc: unknown): StoredIndex | null {
	const value = doc as Partial<StoredIndex> | null | undefined;
	if (!value || typeof value.fetchedAt !== "number") return null;
	// Checked again (about a millisecond, once an hour per isolate), so a damaged row can't put bad URLs in pages.
	const terms = parseGlossaryIndex({ v: 1, terms: value.terms });
	return terms ? { fetchedAt: value.fetchedAt, terms } : null;
}

async function readStored(source: Source): Promise<StoredIndex | null> {
	if (isD1(source)) {
		const row = await source
			.prepare("SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?")
			.bind(PLUGIN_ID, GLOSSARY_COLLECTION, DOC_ID)
			.first<{ data: string }>();
		return row?.data ? validStored(JSON.parse(row.data)) : null;
	}
	return validStored(await store(source)?.get(DOC_ID));
}

/** Fetch and store the index; the stored write runs after the response. */
async function fetchAndStore(ctx: Ctx, timeoutMs: number): Promise<StoredIndex> {
	try {
		const fresh = await fetchIndex(ctx, timeoutMs);
		afterResponse(Promise.resolve(store(ctx)?.put(DOC_ID, fresh)).catch(() => undefined));
		return fresh;
	} catch (error) {
		failedAt = Date.now();
		throw error;
	}
}

/** The stored copy, or (plugin context only, at most every RETRY_MS) a fetched one when the site has none. */
async function readOrFill(source: Source): Promise<Memo> {
	const now = Date.now();
	let stored = await readStored(source);
	if (!stored && !isD1(source) && now - failedAt > RETRY_MS) stored = await fetchAndStore(source as Ctx, FILL_TIMEOUT_MS).catch(() => null);
	return { terms: stored?.terms ?? null, fetchedAt: stored?.fetchedAt ?? 0, readAt: Date.now() };
}

/**
 * The lookup for a page's entities, or undefined when the feature is off,
 * this is glossary.io, or there's no index. Never throws, and never marks the
 * page as a failed read: glossary data is a nice-to-have.
 */
export async function glossaryFor(source: Source, origin?: string | null): Promise<GlossaryLookup | undefined> {
	try {
		if (isGlossarySite(origin)) return undefined;
		const features = isD1(source) ? await siteFeatures() : await cachedCtxFeatures(source);
		if (!isOn(features, "ai.glossary")) return undefined;
		const now = Date.now();
		const expired = !memo || now - memo.readAt > (memo.terms ? MEMO_MS : RETRY_MS);
		if (expired) {
			try {
				memo = await sharedRead(slot, () => readOrFill(source), { anchor: afterResponse, label: "glossary.io index" });
			} catch {
				// A failed read keeps the copy this isolate has.
			}
		}
		const current = memo;
		if (current?.terms && now - current.fetchedAt > REFRESH_MS && !isD1(source) && now - refreshStartedAt > RETRY_MS && now - failedAt > RETRY_MS) {
			refreshStartedAt = now;
			afterResponse(
				fetchAndStore(source as Ctx, REFRESH_TIMEOUT_MS).then(
					(fresh) => void (memo = { terms: fresh.terms, fetchedAt: fresh.fetchedAt, readAt: Date.now() }),
					() => undefined,
				),
			);
		}
		return glossaryLookup(current?.terms);
	} catch {
		return undefined;
	}
}

/** Tests only: forget this isolate's copy and timers. */
export function resetGlossaryForTests(): void {
	memo = null;
	failedAt = 0;
	refreshStartedAt = 0;
	slot.flight = null;
}

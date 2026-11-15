/**
 * Buttondown Drafts: the work. The publish hooks' quick part (decide from the
 * record and the entry's terms, write the record, hand the job over), the job
 * (claim, look in Buttondown first, create or update, or delete an untouched
 * draft), failures and their retries, and the hourly task.
 *
 * Why there are no duplicate drafts and no lost ones:
 * - Two isolates, or a hook that fires twice: only one claim (compareAndSet) wins;
 *   the other marks the record dirty and the winner runs once more.
 * - A POST that landed but whose answer was lost: every create first looks for
 *   the Pack's key among the emails made through the API (drafts, and ones
 *   scheduled or sent since) and adopts what it finds. If the post leaves the
 *   site first, the delete step looks for that draft the same way and deletes
 *   it while it's untouched (createSentAt).
 * - A DELETE that landed but whose answer was lost: the email being gone
 *   afterwards counts as the Pack's own delete, so the next publish makes a
 *   new draft (deleteSentAt). Any other missing email was deleted in
 *   Buttondown, and is never made again on its own.
 * - A job that was dropped, or that ran out of passes: its record has a time
 *   for the hourly task (nextRetryAt), which finishes it.
 *
 * What it never does: send, schedule or publish (the client can't), write an
 * email that isn't a draft or that was changed in Buttondown (unless Refresh
 * draft from post asks, and still only a draft), or delete anything but an
 * untouched draft of a post that was unpublished, trashed or deleted.
 *
 * "Untouched" comes from Buttondown's own times only: the modification_date
 * the Pack recorded after its own last write, or (for a draft found by its
 * key) a modification time within a second of its creation time. Never from
 * the hash in the Pack's metadata, which an edit in Buttondown doesn't change.
 *
 * Refresh draft from post is one attempt, carried by the call and never by
 * the record: it writes only while Buttondown still shows the
 * modification_date the admin was shown before confirming, and a failure
 * leaves nothing behind that a retry could take for an order to overwrite.
 *
 * A read that fails (the post, its terms, the rules, the collection's fields,
 * the site's URL, and what the body is built from: the post's URL, the
 * Custom Blocks settings, File Downloads' files) is an error to retry
 * (ReadFailed). It never counts as "not published" or "doesn't match", and
 * never as a default to build a poorer email from, so nothing is deleted,
 * skipped or overwritten on it.
 *
 * Logs carry the entry, collection, email id, state, status and error code:
 * never the subject, the body, the description or the key.
 */
import type { CollectionSchemaInfo, PluginContext } from "emdash";

import { contextFetch } from "../core/cloudflare-api.js";
import { trackAfterResponse } from "../core/compose.js";
import { COLLECTION_SLUG, absoluteUrl, ancestorTrail, createEntryUrlResolver, entryTerms, termParentMaps, type UrlSource } from "../core/content-url.js";
import { cachedCtxFeatures, ctxFeatures, isCurrent, isOn, settingsEpoch } from "../core/features.js";
import { type DisclosureSettings, type PodcastSettings, normalizeDisclosureSettings, normalizePodcastSettings } from "../customBlocks/render.js";
import { PODCAST_SETTINGS_KEY, SETTINGS_KEY as DISCLOSURE_SETTINGS_KEY } from "../customBlocks/settings.js";
import { downloadPath } from "../files/format.js";
import { readSiteSettings as readFilesSettings, resolveFile } from "../files/site.js";
import { fileIdsIn } from "../files/walker.js";
import { workerEnv } from "../shared.js";
import type { EmailFile } from "./blocks.js";
import { type BuiltEmail, type EmailSource, buildEmail, entryKey, imageValueUrl, packMetadata, sha256Hex } from "./body.js";
import { type ButtondownClient, type ButtondownEmail, ButtondownError, ButtondownRefused, createButtondownClient, packKeyOf, safeDetail } from "./client.js";
import { BUTTONDOWN_FEATURES, BUTTONDOWN_KEY_SETTING, BUTTONDOWN_LIMITS } from "./keys.js";
import { records } from "./store.js";
import { BUTTONDOWN_DEFAULTS, type ButtondownRule, type ButtondownSettings, cachedSettings, ruleFor } from "./settings.js";
import {
	type ButtondownRecord,
	CLEARED,
	type EventKind,
	PRUNABLE,
	UNSENT,
	adoptable,
	claimHeld,
	classifyRemote,
	decideEvent,
	failure,
	isStuck,
	isUnsure,
	newRecord,
	readRecord,
	recordId,
} from "./sync-core.js";

// ── Dependencies (replaced in tests) ─────────────────────────────

export interface SyncDeps {
	now: () => number;
	/** The site database, or null (outside a Worker): reads then go through the plugin context. */
	db: () => Promise<D1Database | null>;
	/** The rules. Rejects when they can't be read (never "no rules"). */
	settings: (ctx: PluginContext) => Promise<ButtondownSettings>;
	/** The entry's term slugs in one taxonomy. Rejects when they can't be read (never "no terms"). */
	terms: (ctx: PluginContext, collection: string, id: string, taxonomy: string) => Promise<string[]>;
	/** Child term → parent term, for one taxonomy. Rejects when it can't be read. */
	termParents: (ctx: PluginContext, taxonomy: string) => Promise<ReadonlyMap<string, string>>;
	/** The published entry's absolute URL, or null. */
	postUrl: (ctx: PluginContext, collection: string, item: Item) => Promise<string | null>;
	/** File Downloads' files for the entry's file cards. Rejects when they can't be read (never "no files"). */
	files: (ctx: PluginContext, item: Item, siteUrl: string) => Promise<ReadonlyMap<string, EmailFile>>;
	/** Hand a job to the runtime (waitUntil, EmDash's deferred tasks). */
	background: (job: Promise<unknown>) => void;
	sleep: (ms: number) => Promise<void>;
}

/** An entry as ctx.content.get returns it. */
export interface Item {
	id: string;
	slug: string | null;
	status: string;
	locale?: string | null;
	publishedAt?: string | null;
	draftRevisionId?: string | null;
	data: Record<string, unknown>;
	seo?: { description?: string | null; image?: string | null } | null;
}

/** Child term parents per taxonomy, per isolate: kept five minutes and with the settings epoch. */
const parentsCache = new Map<string, { at: number; epoch: number; parents: ReadonlyMap<string, string> }>();

export function defaultDeps(database = "DB"): SyncDeps {
	const db = async () => ((await workerEnv().catch(() => ({}) as Record<string, unknown>))[database] as D1Database | undefined) ?? null;
	const source = async (ctx: PluginContext): Promise<UrlSource> => (await db()) ?? ctx;
	return {
		now: Date.now,
		db,
		settings: (ctx) => cachedSettings(ctx, database, true),
		terms: async (ctx, collection, id, taxonomy) => entryTerms(await source(ctx), collection, id, taxonomy, { strict: true }),
		termParents: async (ctx, taxonomy) => {
			const hit = parentsCache.get(taxonomy);
			if (hit && isCurrent(hit, 5 * 60_000)) return hit.parents;
			const epoch = settingsEpoch();
			const parents = (await termParentMaps(await source(ctx), [taxonomy], { strict: true })).get(taxonomy) ?? new Map<string, string>();
			parentsCache.set(taxonomy, { at: Date.now(), epoch, parents });
			return parents;
		},
		postUrl: async (ctx, collection, item) => {
			const path = await createEntryUrlResolver(ctx).url(collection, { id: item.id, slug: item.slug, status: "published", publishedAt: item.publishedAt ?? null, locale: item.locale ?? null });
			return path ? absoluteUrl(path, ctx.site.url) : null;
		},
		files: async (_ctx, item, siteUrl) => {
			const out = new Map<string, EmailFile>();
			const ids = fileIdsIn(item.data).slice(0, 20);
			const d1 = ids.length ? await db() : null;
			if (!d1) return out;
			// Strict: a failed read rejects. A file that isn't there is null, and its card links to the post.
			const settings = await readFilesSettings(d1, true);
			const base = settings.publicBaseUrl || siteUrl.replace(/\/+$/, "");
			for (const id of ids) {
				const file = await resolveFile(d1, id);
				if (file) out.set(id, { name: file.name, size: file.size, href: `${base}${downloadPath(settings.base, file.id, file.name)}` });
			}
			return out;
		},
		background: trackAfterResponse,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
}

// ── Records ──────────────────────────────────────────────────────


const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Read, change and write a record with compareAndSet, again from the fresh record when another writer got there
 * first. `change` returns the new record, or null to write nothing.
 */
async function updateRecord(ctx: Pick<PluginContext, "storage">, id: string, change: (current: ButtondownRecord | null) => ButtondownRecord | null): Promise<ButtondownRecord | null> {
	const store = records(ctx);
	for (let i = 0; i < 4; i++) {
		const read = await store.getVersioned(id);
		const current = readRecord(read?.value);
		const next = change(current);
		if (!next) return current;
		const result = await store.compareAndSet(id, read ? read.revision : null, next);
		if (result.applied) return next;
	}
	throw new Error("The record kept changing while it was being written.");
}

// ── The key ──────────────────────────────────────────────────────

/** The saved key, or null; `unreadable` when one is stored but can't be decrypted. */
export async function readKey(ctx: Pick<PluginContext, "settings">): Promise<{ key: string | null; unreadable: boolean }> {
	try {
		const key = await ctx.settings.get<string>(BUTTONDOWN_KEY_SETTING);
		return { key: typeof key === "string" && key.trim() ? key.trim() : null, unreadable: false };
	} catch {
		return { key: null, unreadable: true };
	}
}

/** 16 hex digits of a prefixed SHA-256 of the key: tells one key from another without keeping any of it. */
export async function keyFingerprint(key: string | null): Promise<string> {
	return key ? (await sha256Hex(`coywolf-pack:buttondown:${key}`)).slice(0, 16) : "none";
}

class KeyMissing extends Error {
	readonly unreadable: boolean;
	constructor(unreadable: boolean) {
		super(unreadable ? "The saved Buttondown API key can't be read: EMDASH_ENCRYPTION_KEY is missing or has changed. Save the key again on the Settings page." : "No Buttondown API key saved. Add it on the plugin's Settings page.");
		this.name = "KeyMissing";
		this.unreadable = unreadable;
	}
}

// ── Reads that can fail ──────────────────────────────────────────

/**
 * Something the job needs couldn't be read (the post, its terms, the rules, the collection's fields, the site's
 * URL, a setting or a file the body is built from). Never the same as "not published" or "doesn't match", and
 * never a default: the step fails, and it's tried again. The message names what, never the database's own words.
 */
export class ReadFailed extends Error {
	constructor(what: string) {
		super(`The site couldn't read ${what}. The Pack tries again.`);
		this.name = "ReadFailed";
	}
}

/** `read`, with any failure as a ReadFailed naming `what`. */
async function reading<T>(what: string, read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof ReadFailed) throw error;
		throw new ReadFailed(what);
	}
}

/** The site's URL without a trailing slash. EmDash leaves it empty when its own site read failed: then nothing is keyed or linked with it. */
function siteOrigin(ctx: Pick<PluginContext, "site">): string {
	const url = String(ctx.site?.url ?? "").replace(/\/+$/, "");
	if (!/^https?:\/\/[^/]+/i.test(url) || !URL.canParse(url)) throw new ReadFailed("the site's URL");
	return url;
}

// ── Matching ─────────────────────────────────────────────────────

/**
 * Whether the entry has one of the rule's terms, or a child term of one. Rejects (ReadFailed) when the terms can't be
 * read: that is never "doesn't match".
 */
export async function matchesRule(ctx: PluginContext, deps: SyncDeps, rule: ButtondownRule, collection: string, id: string): Promise<boolean> {
	const slugs = await reading("the post's terms", () => deps.terms(ctx, collection, id, rule.taxonomy));
	if (!slugs.length) return false;
	const wanted = new Set(rule.terms);
	if (slugs.some((s) => wanted.has(s))) return true;
	const parents = await reading("the taxonomy's terms", () => deps.termParents(ctx, rule.taxonomy));
	return slugs.some((s) => ancestorTrail(s, parents).some((a) => wanted.has(a)));
}

const timeOf = (value: unknown): number => {
	if (typeof value !== "string" || !value) return Number.NaN;
	let v = value.trim();
	if (v.includes(" ") && !v.includes("T")) v = v.replace(" ", "T");
	if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) v += "Z";
	return Date.parse(v);
};

/** First published at or after the rule was saved (an entry with no publish date counts as new). */
export function newEnough(publishedAt: unknown, rule: ButtondownRule): boolean {
	const published = timeOf(publishedAt);
	return !Number.isFinite(published) || published >= Date.parse(rule.since);
}

// ── Hooks ────────────────────────────────────────────────────────

/** Jobs under way in this isolate, by record id: a later event there only marks the record dirty. */
const running = new Map<string, Promise<void>>();

/** The entry an event is about: content:afterDelete (trash and delete) has only `id`, the others the entry as `content`. */
function eventEntry(kind: EventKind, event: { id?: unknown; collection?: unknown; content?: Record<string, unknown> }) {
	const collection = typeof event.collection === "string" ? event.collection : "";
	const id = kind === "delete" || kind === "trash" ? event.id : event.content?.id;
	return { collection, id: typeof id === "string" ? id : "" };
}

/**
 * A content hook: decide from the record and the entry, write the record and hand any job over. Quick: the
 * settings come with the feature switches, so a publish or save in a collection without a rule costs no query; a
 * matching publish costs the terms query, a record read and a write. An unpublish, trash, delete or restore reads
 * the entry's record once in any collection (a record can outlive its rule).
 *
 * A read that fails here is never "no rule" or "doesn't match": the job is queued all the same, and it reads again
 * and decides (or fails, and is tried again).
 */
export async function handleEvent(ctx: PluginContext, deps: SyncDeps, kind: EventKind, event: { id?: unknown; collection?: unknown; content?: Record<string, unknown>; permanent?: unknown }): Promise<void> {
	const { collection, id } = eventEntry(kind, event);
	if (!id || !COLLECTION_SLUG.test(collection) || id.length > 128) return;
	const publishing = kind === "publish" || kind === "save";
	const content = event.content ?? {};
	// A save of a draft revision (or of an entry that isn't published) doesn't change the live post.
	const live = kind === "publish" ? content.status === "published" : kind === "save" ? content.status === "published" && !content.draftRevisionId : false;
	if (publishing && !live) return;
	const rid = recordId(collection, id);
	let settings: ButtondownSettings | null = null;
	try {
		settings = await deps.settings(ctx);
	} catch {
		ctx.log.warn("buttondown: the rules couldn't be read in a hook; the job reads them again", { entry: rid });
	}
	/** The rules couldn't be read: whether one covers the entry isn't known here. */
	const unsure = settings === null;
	const rule = settings ? ruleFor(settings, collection) : null;
	if (publishing && !rule && !unsure) return;

	const existing = readRecord(await records(ctx).get(rid));
	const fresh = publishing && (rule ? newEnough(content.publishedAt, rule) : unsure);
	// No record: an unpublish, trash, delete or restore has nothing to do, and a post published before the rule waits for Create draft now.
	if (!existing && !fresh) return;
	let matches = publishing && unsure;
	if (publishing && rule) {
		try {
			matches = await matchesRule(ctx, deps, rule, collection, id);
		} catch {
			// Not "doesn't match": the job reads the terms again.
			matches = true;
			ctx.log.warn("buttondown: the post's terms couldn't be read in a hook; the job reads them again", { entry: rid });
		}
	}
	// A key Buttondown refused (or none saved) that's still the saved one: this event makes no call with it. Read only
	// for a record that carries such a failure.
	const sameRefusedKey = publishing && Boolean(existing?.authFingerprint) && existing?.state === "error" && existing.authFingerprint === (await keyFingerprint((await readKey(ctx)).key));
	const facts = { live, matches, newEnough: fresh, updatesOn: isOn(await cachedCtxFeatures(ctx).catch(() => ({})), BUTTONDOWN_FEATURES.updates), sameRefusedKey };
	const now = deps.now();
	const decided: { run: ButtondownRecord["job"] } = { run: null };
	await updateRecord(ctx, rid, (current) => {
		const decision = decideEvent(kind, current, facts);
		decided.run = decision.run;
		if (!decision.patch && !decision.run) return null;
		const base = current ?? newRecord(collection, id, now);
		const next: ButtondownRecord = { ...base, ...(decision.patch ?? {}), updatedAt: iso(now) };
		// A job holds it here or in another isolate: it checks the entry once more when it's done. Also for a publish
		// that only changes the record (a delete cancelled with Update drafts off): the running job may be that delete.
		if ((decision.run || publishing) && (running.has(rid) || claimHeld(base, "", now))) next.dirty = true;
		if (decision.run) {
			next.job = decision.run;
			if (!current) next.state = "pending";
			if (unsure) next.sinceUnchecked = true;
			// If the job is dropped or cut off, the hourly task runs it.
			next.nextRetryAt = iso(now + BUTTONDOWN_LIMITS.stuckMs);
		}
		return next;
	});
	if (decided.run && !running.has(rid)) startJob(ctx, deps, collection, id);
}

/** Run the entry's job after the response (at most one per entry in this isolate). */
export function startJob(ctx: PluginContext, deps: SyncDeps, collection: string, id: string): void {
	const rid = recordId(collection, id);
	if (running.has(rid)) return;
	const job = runEntry(ctx, deps, collection, id, deps.now() + BUTTONDOWN_LIMITS.jobMs)
		.then(() => undefined)
		.catch((error: unknown) => ctx.log.warn("buttondown: a job failed; the hourly task retries it", { entry: rid, error: error instanceof Error ? error.name : "error" }))
		.finally(() => running.delete(rid));
	running.set(rid, job);
	deps.background(job);
}

/** For tests: wait for this isolate's jobs. */
export async function settleJobsForTests(): Promise<void> {
	while (running.size) await Promise.all([...running.values()]);
}

/** For tests: forget this isolate's jobs, as when the runtime drops them (how many there were). */
export function dropJobsForTests(): number {
	const n = running.size;
	running.clear();
	return n;
}

// ── The job ──────────────────────────────────────────────────────

type Outcome = Partial<ButtondownRecord> & { deleteRecord?: true };

interface Run {
	ctx: PluginContext;
	deps: SyncDeps;
	record: ButtondownRecord;
	deadline: number;
	updatesOn: boolean;
	settings: ButtondownSettings;
	/**
	 * Refresh draft from post, for this one step: the modification_date the admin was shown before confirming. The
	 * draft may be overwritten only while Buttondown still shows it. Null: a plain step. Never stored on the record.
	 */
	seen: string | null;
	/**
	 * Written by the step (one object, shared by every copy of the run). `moved`: the draft had changed since the
	 * admin looked, so Refresh wrote nothing. `unkeyed`: the email no longer carries the Pack's key for the post, so
	 * Refresh wrote nothing. `ownDelete`: the step found the record's email gone after the Pack's own unanswered
	 * delete, and went on to make a new draft.
	 */
	out: { moved: boolean; unkeyed: boolean; ownDelete: boolean };
}

const settled = (patch: Partial<ButtondownRecord>): Outcome => ({ ...CLEARED, ...UNSENT, sinceUnchecked: false, ...patch });

let schemaCache: { at: number; list: Map<string, CollectionSchemaInfo> } | null = null;
/** The collection's fields. Rejects (ReadFailed) when they can't be read: an email is never built from no fields. */
async function collectionSchema(ctx: PluginContext, slug: string): Promise<CollectionSchemaInfo> {
	if (!schemaCache || Date.now() - schemaCache.at > 60_000) schemaCache = { at: Date.now(), list: new Map() };
	let info = schemaCache.list.get(slug) ?? null;
	if (!info) {
		info = (await reading("the collection's fields", async () => (ctx.schema ? ctx.schema.getCollection(slug) : null))) ?? null;
		if (!info) throw new ReadFailed("the collection's fields");
		schemaCache.list.set(slug, info);
	}
	return info;
}

/** For tests: forget the collections' fields read so far. */
export function clearSchemaCacheForTests(): void {
	schemaCache = null;
}

const isLiveItem = (item: Item | null): item is Item => Boolean(item && item.status === "published");

/** The entry, or null when EmDash says there's none. Rejects (ReadFailed) when it can't be read. */
async function getItem(ctx: PluginContext, collection: string, id: string): Promise<Item | null> {
	return reading("the post", async () => {
		if (!ctx.content) throw new Error("no content access");
		return ((await ctx.content.get(collection, id)) as Item | null) ?? null;
	});
}

/** Block types in the entry's Portable Text fields (to read the Custom Blocks settings only when they're used). */
function blockTypes(values: unknown[]): Set<string> {
	const out = new Set<string>();
	for (const value of values) if (Array.isArray(value)) for (const b of value) if (b && typeof b === "object" && typeof (b as { _type?: unknown })._type === "string") out.add((b as { _type: string })._type);
	return out;
}

/** The email for a published entry. */
async function emailFor(run: Run, item: Item): Promise<{ built: BuiltEmail; source: EmailSource }> {
	const { ctx, deps, record } = run;
	const siteUrl = siteOrigin(ctx);
	const schema = await collectionSchema(ctx, record.collection);
	const fields = schema.fields ?? [];
	const bodyFields = fields
		.filter((f) => f.type === "portableText")
		.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
		.map((f) => item.data[f.slug]);
	const titleField = schema.titleField ?? "title";
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const featured = fields
		.filter((f) => f.type === "image")
		.map((f) => imageValueUrl(item.data[f.slug]))
		.find((u): u is string => Boolean(u));
	// Null: the collection has no page of its own. A failed read isn't that.
	const postUrl = (await reading("the post's URL", () => deps.postUrl(ctx, record.collection, item))) ?? "";
	const types = blockTypes(bodyFields);
	// What the body is built from. A failed read is never a default: that would write a poorer body over the draft.
	const disclosure: DisclosureSettings | undefined = types.has("coywolf-disclosure") ? normalizeDisclosureSettings(await reading("the affiliate disclosure settings", () => ctx.settings.get(DISCLOSURE_SETTINGS_KEY))) : undefined;
	const podcast: PodcastSettings | undefined = types.has("coywolf-podcast") ? normalizePodcastSettings(await reading("the podcast settings", () => ctx.settings.get(PODCAST_SETTINGS_KEY))) : undefined;
	const files = types.has("coywolf-file") ? await reading("the post's files", () => deps.files(ctx, item, siteUrl)) : undefined;
	const source: EmailSource = {
		collection: record.collection,
		entryId: record.entryId,
		key: entryKey(siteUrl, record.collection, record.entryId),
		title: str(item.data[titleField]) || str(item.data.title) || str(item.slug),
		excerpt: str(item.data.excerpt),
		seoDescription: str(item.seo?.description),
		slug: item.slug,
		postUrl: postUrl || siteUrl,
		siteUrl,
		bodyFields,
		featuredImage: featured ?? (str(item.seo?.image) || null),
		footerLink: run.settings.footerLink && Boolean(postUrl),
		noSlug: record.noSlug,
		files,
		disclosure,
		podcast,
	};
	return { built: await buildEmail(source), source };
}

async function clientFor(run: Run): Promise<{ client: ButtondownClient }> {
	const { key, unreadable } = await readKey(run.ctx);
	if (!key) throw new KeyMissing(unreadable);
	return { client: createButtondownClient({ key, fetch: contextFetch(run.ctx), deadlineAt: run.deadline, now: run.deps.now }) };
}

/** A call, once more after a short Retry-After (at most 10 seconds) when Buttondown answers 429 and the job has time. */
async function patient<T>(run: Run, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (!(error instanceof ButtondownError) || error.status !== 429) throw error;
		const wait = Math.max(1, error.retryAfter ?? 1) * 1000;
		if (wait > BUTTONDOWN_LIMITS.retryAfterWaitMs || run.deps.now() + wait + BUTTONDOWN_LIMITS.callMs > run.deadline) throw error;
		await run.deps.sleep(wait);
		return call();
	}
}

/** Fields for a write, with the slug left out once Buttondown refused it (slug_invalid). */
async function withSlugRetry<T>(run: Run, item: Item, email: { built: BuiltEmail; source: EmailSource }, write: (email: { built: BuiltEmail; source: EmailSource }) => Promise<T>): Promise<{ result: T; email: { built: BuiltEmail; source: EmailSource }; noSlug: boolean }> {
	try {
		return { result: await patient(run, () => write(email)), email, noSlug: Boolean(email.source.noSlug) };
	} catch (error) {
		if (!(error instanceof ButtondownError) || error.status !== 400 || error.code !== "slug_invalid" || !email.built.fields.slug) throw error;
		const again = await emailFor({ ...run, record: { ...run.record, noSlug: true } }, item);
		return { result: await patient(run, () => write(again)), email: again, noSlug: true };
	}
}

const packHashOf = (email: ButtondownEmail) => {
	const mine = email.metadata.coywolf_pack;
	return mine && typeof mine === "object" && typeof (mine as { hash?: unknown }).hash === "string" ? (mine as { hash: string }).hash : null;
};

/**
 * Emails the Pack made for this entry, in any status, from Buttondown's list of emails made through the API
 * (returned oldest first). Not only drafts: one that was scheduled or sent since must be found too, or a retried
 * create would make a second email for the post.
 *
 * Bounded by time, and by three list calls. Buttondown lists newest first, and an email this record's jobs made
 * can't be older than the record. So the search ends at the first page that holds an email made over an hour (the
 * margin for the two clocks) before the record was: however many old emails the newsletter has, they cost no call.
 */
async function findEmails(run: Run, client: ButtondownClient, key: string): Promise<ButtondownEmail[]> {
	const out: ButtondownEmail[] = [];
	const since = (Date.parse(run.record.createdAt) || 0) - BUTTONDOWN_LIMITS.lookupMarginMs;
	for (let page = 1; page <= BUTTONDOWN_LIMITS.lookupPages; page++) {
		const { results, hasMore } = await patient(run, () => client.listApiEmails(page));
		out.push(...results.filter((e) => packKeyOf(e) === key && e.status !== "deleted"));
		if (!hasMore) break;
		// An email with no readable date doesn't end the search.
		if (results.some((e) => Date.parse(e.creationDate ?? "") < since)) break;
	}
	return out.sort((a, b) => (Date.parse(a.creationDate ?? "") || 0) - (Date.parse(b.creationDate ?? "") || 0));
}

const DUPLICATES = (n: number) => `Buttondown has ${n} drafts for this post: the Pack uses the oldest. Delete the others there.`;

const is404 = (error: unknown) => error instanceof ButtondownError && error.status === 404;

async function syncStep(run: Run): Promise<Outcome> {
	const { ctx, deps, record } = run;
	const item = await getItem(ctx, record.collection, record.entryId);
	if (!isLiveItem(item)) {
		// Not published (any more): an untouched draft goes as on an unpublish; a create that never happened is forgotten.
		if (record.emailId && record.state !== "edited" && record.state !== "gone" && record.state !== "stopped") return removeStep({ ...run, seen: null, record: { ...record, unpublished: record.unpublished || !record.trashed } });
		// A create that got no answer may have made a draft: the delete step looks for it.
		if (!record.emailId && record.createSentAt) return removeStep({ ...run, seen: null, record: { ...record, unpublished: record.unpublished || !record.trashed } });
		return record.emailId ? settled({}) : { deleteRecord: true };
	}
	const rule = ruleFor(run.settings, record.collection);
	if (!rule || !(await matchesRule(ctx, deps, rule, record.collection, record.entryId))) return record.emailId ? settled({ state: "stopped" }) : { deleteRecord: true };
	// Queued by a hook that couldn't read the rules: "published before the rule" is checked here instead.
	if (record.sinceUnchecked && !record.emailId && !record.manual && !newEnough(item.publishedAt, rule)) return { deleteRecord: true };

	const email = await emailFor(run, item);
	const { built, source } = email;
	const shown = { title: source.title.slice(0, 300), postUrl: source.postUrl || null, warnings: built.warnings };
	if (record.emailId && run.seen === null && record.state === "draft" && built.hash === record.hash) return settled({ ...shown, state: "draft" });

	const { client } = await clientFor(run);

	tracked: if (record.emailId) {
		const emailId = record.emailId;
		let remote: ButtondownEmail | null;
		try {
			remote = await patient(run, () => client.getEmail(emailId));
		} catch (error) {
			if (is404(error)) remote = null;
			else throw error;
		}
		const now = remote ? { status: remote.status, modificationDate: remote.modificationDate, key: packKeyOf(remote) } : null;
		let verdict = classifyRemote(now, record, source.key, run.seen);
		const refresh = run.seen !== null && verdict === "update";
		if (run.seen !== null && verdict === "edited") {
			// Changed in Buttondown since the admin looked, or no longer carrying the Pack's key for this post: Refresh
			// writes nothing. What the record says comes from the plain check.
			if (now && now.key !== source.key) run.out.unkeyed = true;
			else run.out.moved = true;
			verdict = classifyRemote(now, record, source.key);
			if (verdict === "update") return settled({ ...shown, state: "draft", remoteStatus: "draft" });
		}
		// Gone after the Pack's own delete got no answer: that delete landed. The post is live again, so it gets a new
		// draft below, as after any delete of the Pack's own (if it's new enough for its rule, or was made by hand).
		const ownDelete = verdict === "gone" && Boolean(record.deleteSentAt);
		if (ownDelete && !record.manual && !newEnough(item.publishedAt, rule)) return settled({ ...shown, state: "removed", emailId: null, hash: null, remoteModifiedAt: null, remoteStatus: "deleted" });
		if (ownDelete) {
			run.out.ownDelete = true;
			break tracked;
		}
		if (verdict === "gone") return settled({ ...shown, state: "gone", remoteStatus: null });
		if (verdict === "left") return settled({ ...shown, state: "left", remoteStatus: remote?.status ?? null });
		if (verdict === "edited") return settled({ ...shown, state: "edited", remoteStatus: "draft" });
		if (!run.updatesOn && !refresh) return settled({ ...shown, state: "draft", remoteStatus: "draft" });
		const current = remote as ButtondownEmail;
		let write: Awaited<ReturnType<typeof withSlugRetry<ButtondownEmail>>>;
		try {
			write = await withSlugRetry(run, item, email, (e) => client.updateDraft(emailId, { ...e.built.fields, metadata: packMetadata(e.source, e.built.hash, current.metadata) }));
		} catch (error) {
			// Deleted in Buttondown between the read and the write.
			if (is404(error)) return settled({ ...shown, state: "gone", remoteStatus: null });
			throw error;
		}
		return settled({ ...shown, warnings: write.email.built.warnings, state: "draft", hash: write.email.built.hash, remoteModifiedAt: write.result.modificationDate, remoteStatus: write.result.status, noSlug: write.noSlug });
	}

	// Create: look in Buttondown first, so a POST that landed (its answer lost) is adopted, not repeated.
	const found = await findEmails(run, client, source.key);
	const newest = found.at(-1);
	if (newest && newest.status !== "draft") {
		// Already scheduled or sent from Buttondown: the post has its email. No second one, and nothing of the Pack's
		// own to compare it with (remoteModifiedAt null), so it's never written or deleted.
		return settled({ ...shown, state: "left", emailId: newest.id, hash: null, remoteModifiedAt: null, remoteStatus: newest.status });
	}
	const drafts = found.filter((e) => e.status === "draft");
	if (drafts.length) {
		const oldest = drafts[0];
		const warnings = drafts.length > 1 ? [...built.warnings, DUPLICATES(drafts.length)] : built.warnings;
		// Changed in Buttondown since it was made (only its own times can say): kept as it is. No date is recorded, so
		// no later check can take it for the Pack's own write.
		if (!adoptable(oldest)) return settled({ ...shown, warnings, state: "edited", emailId: oldest.id, hash: null, remoteModifiedAt: null, remoteStatus: "draft" });
		// Untouched and already showing the post: no write needed.
		if (packHashOf(oldest) === built.hash) return settled({ ...shown, warnings, state: "draft", emailId: oldest.id, hash: built.hash, remoteModifiedAt: oldest.modificationDate, remoteStatus: "draft" });
		const write = await withSlugRetry(run, item, email, (e) => client.updateDraft(oldest.id, { ...e.built.fields, metadata: packMetadata(e.source, e.built.hash, oldest.metadata) }));
		return settled({ ...shown, warnings: drafts.length > 1 ? [...write.email.built.warnings, DUPLICATES(drafts.length)] : write.email.built.warnings, state: "draft", emailId: oldest.id, hash: write.email.built.hash, remoteModifiedAt: write.result.modificationDate, remoteStatus: write.result.status, noSlug: write.noSlug });
	}
	const write = await withSlugRetry(run, item, email, (e) => client.createDraft(e.built.fields));
	ctx.log.info("buttondown: draft created", { entry: recordId(record.collection, record.entryId), email: write.result.id });
	return settled({ ...shown, warnings: write.email.built.warnings, state: "draft", emailId: write.result.id, hash: write.email.built.hash, remoteModifiedAt: write.result.modificationDate, remoteStatus: write.result.status, noSlug: write.noSlug });
}

async function removeStep(run: Run): Promise<Outcome> {
	const { ctx, deps, record } = run;
	if (!record.deleted) {
		// A read that fails here rejects: the delete waits for one that works.
		const item = await getItem(ctx, record.collection, record.entryId);
		const rule = ruleFor(run.settings, record.collection);
		// Published again before the delete ran: no delete; the draft is updated as on a republish.
		if (isLiveItem(item) && !record.trashed) {
			if (rule && (await matchesRule(ctx, deps, rule, record.collection, record.entryId))) return { unpublished: false, ...(await syncStep({ ...run, record: { ...record, job: "sync", state: "draft", unpublished: false } })) };
			return settled({ state: "stopped", unpublished: false });
		}
	}
	const finalState = (state: ButtondownRecord["state"]) => (record.deleted ? "stopped" : state);
	const deleted = { emailId: null, hash: null, remoteModifiedAt: null, remoteStatus: "deleted" } as const;
	if (!record.emailId && !record.createSentAt) return settled({ state: finalState(record.state === "removing" ? "removed" : record.state) });
	const expectedKey = entryKey(siteOrigin(ctx), record.collection, record.entryId);
	const { client } = await clientFor(run);
	let emailId = record.emailId;
	let expectedModified = record.remoteModifiedAt;
	let warnings = record.warnings;
	if (!emailId) {
		// A create went out and got no answer, and the post left the site before a retry looked: the draft it may have
		// made is looked up by the Pack's key. Only one nobody changed since it was made is the Pack's to delete, and
		// only through deleteDraft's own read. One that was edited, scheduled or sent is named on the record and kept.
		const found = await findEmails(run, client, expectedKey);
		const newest = found.at(-1);
		if (newest && newest.status !== "draft") return settled({ state: finalState("left"), emailId: newest.id, hash: null, remoteModifiedAt: null, remoteStatus: newest.status });
		const drafts = found.filter((e) => e.status === "draft");
		// None: no draft was made (or the Pack's own delete of it, unanswered, landed).
		if (!drafts.length) return settled({ state: finalState(record.deleteSentAt ? "removed" : "stopped"), ...(record.deleteSentAt ? deleted : {}) });
		const oldest = drafts[0];
		if (drafts.length > 1) warnings = [...warnings.filter((w) => !w.startsWith("Buttondown has ")), DUPLICATES(drafts.length)];
		if (!adoptable(oldest)) return settled({ state: finalState("edited"), warnings, emailId: oldest.id, hash: null, remoteModifiedAt: null, remoteStatus: "draft" });
		emailId = oldest.id;
		expectedModified = oldest.modificationDate;
	}
	const target = emailId;
	const outcome = await patient(run, () => client.deleteDraft(target, expectedModified, expectedKey));
	ctx.log.info("buttondown: delete checked", { entry: recordId(record.collection, record.entryId), email: target, outcome: outcome.outcome });
	switch (outcome.outcome) {
		case "deleted":
			return settled({ state: finalState("removed"), warnings, ...deleted });
		case "gone":
			// Gone after the Pack's own delete got no answer: that delete landed, so it's the Pack's (the next publish
			// makes a new draft). Any other missing email was deleted in Buttondown, and isn't made again on its own.
			if (record.deleteSentAt) return settled({ state: finalState("removed"), ...deleted });
			return record.emailId ? settled({ state: finalState("gone"), remoteStatus: null }) : settled({ state: finalState("stopped") });
		case "left":
			return settled({ state: finalState("left"), emailId: target, remoteStatus: outcome.status, ...(record.emailId ? {} : { hash: null, remoteModifiedAt: null }) });
		case "edited":
			return settled({ state: finalState("edited"), emailId: target, remoteStatus: "draft", ...(record.emailId ? {} : { hash: null, remoteModifiedAt: null }) });
	}
}

/** A failed step as the record's error. Nothing in it asks a later try to overwrite: a failed Refresh is over. */
async function failed(run: Run, error: unknown): Promise<Outcome> {
	const { record } = run;
	const now = run.deps.now();
	const at = iso(now);
	let status = 0;
	let code: string | null = null;
	let message: string;
	let plan: ReturnType<typeof failure>;
	if (error instanceof KeyMissing) {
		code = "no_key";
		message = error.message;
		plan = failure({ status: 0, code, retryAfter: null }, record, now);
	} else if (error instanceof ReadFailed) {
		// Temporary: tried again with the backoff of a call that got no answer.
		code = "read_failed";
		message = error.message;
		plan = failure({ status: 0, code, retryAfter: null }, record, now);
	} else if (error instanceof ButtondownError) {
		status = error.status;
		code = error.code;
		plan = failure({ status, code, retryAfter: error.retryAfter }, record, now);
		message =
			plan.kind === "auth"
				? `Buttondown refused the key (${status}). Check it on the plugin's Settings page: it needs Emails and drafts → Write.${plan.nextRetryAt ? ` The Pack tries once more at ${plan.nextRetryAt.slice(11, 16)} UTC, because Buttondown also answers 403 when it's busy.` : ""}${error.detail ? ` Buttondown said: ${error.detail}` : ""}`
				: plan.kind === "rate"
					? `Buttondown asked the Pack to slow down (429). It tries again ${plan.nextRetryAt ? `after ${new Date(plan.nextRetryAt).toISOString().slice(11, 16)} UTC` : "later"}.`
					: error.message;
	} else if (error instanceof ButtondownRefused) {
		code = "refused";
		message = error.message;
		plan = failure({ status: 0, code, retryAfter: null, refused: true }, record, now);
	} else {
		message = safeDetail(error instanceof Error ? error.message : String(error));
		plan = failure({ status: 0, code: null, retryAfter: null }, record, now);
	}
	const fingerprint = plan.kind === "auth" ? await keyFingerprint((await readKey(run.ctx)).key) : null;
	// A write that went out and got no answer may have landed: the record remembers it (see removeStep and syncStep).
	const unanswered = error instanceof ButtondownError ? error.unanswered : null;
	run.ctx.log.warn("buttondown: a step failed", { entry: recordId(record.collection, record.entryId), email: record.emailId, job: record.job, status, code, unanswered });
	return {
		state: "error",
		job: record.job ?? "sync",
		attempts: record.attempts + 1,
		errorSince: record.errorSince ?? at,
		lastError: { at, status, code, message: safeDetail(message) },
		nextRetryAt: plan.nextRetryAt,
		authFingerprint: fingerprint,
		// The email the record named is gone, by the Pack's own delete: a failure while making the new draft doesn't bring it back.
		...(run.out.ownDelete ? { emailId: null, hash: null, remoteModifiedAt: null, remoteStatus: "deleted", deleteSentAt: null } : {}),
		...(unanswered === "create" && (!record.emailId || run.out.ownDelete) ? { createSentAt: record.createSentAt ?? at } : {}),
		...(unanswered === "delete" ? { deleteSentAt: record.deleteSentAt ?? at } : {}),
	};
}

export interface JobResult {
	record: ButtondownRecord | null;
	/** Another job held the record: this one did nothing (that job checks the entry once more when it's done). */
	busy: boolean;
	/** Refresh draft from post only: the draft had changed since the admin looked, so nothing was written. */
	moved: boolean;
	/** Refresh draft from post only: the email no longer carries the Pack's key for this post, so nothing was written. */
	unkeyed: boolean;
}

/**
 * The entry's job: claim the record, do its step (create or update, or delete), write the outcome, and once more
 * when an event marked it dirty meanwhile (at most three passes; work left after that goes to the hourly task).
 *
 * `seen` (Refresh draft from post) applies to the first step this call runs and to nothing else: it isn't written
 * to the record, so no retry, later pass or other job can inherit it.
 */
async function runJob(ctx: PluginContext, deps: SyncDeps, collection: string, entryId: string, deadline: number, seen: string | null = null): Promise<JobResult> {
	const rid = recordId(collection, entryId);
	const store = records(ctx);
	const token = crypto.randomUUID();
	let last: ButtondownRecord | null = null;
	let seenLeft = seen;
	const told = { moved: false, unkeyed: false };
	for (let pass = 0; pass < 3; pass++) {
		const read = await store.getVersioned(rid);
		const record = readRecord(read?.value);
		if (!read || !record || !record.job) return { record, busy: false, ...told };
		const now = deps.now();
		if (claimHeld(record, token, now)) {
			// Another job has it: it runs once more when it's done.
			if (!record.dirty) await store.compareAndSet(rid, read.revision, { ...record, dirty: true, updatedAt: iso(now) });
			return { record, busy: true, ...told };
		}
		const claimed: ButtondownRecord = { ...record, claimToken: token, claimedAt: iso(now), dirty: false, updatedAt: iso(now), state: record.job === "sync" && !record.emailId ? "creating" : record.state };
		if (!(await store.compareAndSet(rid, read.revision, claimed)).applied) continue;
		const run: Run = { ctx, deps, record: claimed, deadline, updatesOn: false, settings: BUTTONDOWN_DEFAULTS, seen: seenLeft, out: { moved: false, unkeyed: false, ownDelete: false } };
		seenLeft = null;
		let outcome: Outcome;
		try {
			// The rules, read again here: unreadable is a failed step, never "no rule".
			const [settings, features] = await Promise.all([reading("the Buttondown Drafts rules", () => deps.settings(ctx)), ctxFeatures(ctx).catch(() => ({}))]);
			run.settings = settings;
			run.updatesOn = isOn(features, BUTTONDOWN_FEATURES.updates);
			outcome = claimed.job === "remove" ? await removeStep(run) : await syncStep(run);
		} catch (error) {
			outcome = await failed(run, error);
		}
		told.moved = told.moved || run.out.moved;
		told.unkeyed = told.unkeyed || run.out.unkeyed;
		if (outcome.deleteRecord) {
			// A create that never happened, for an entry that isn't published or doesn't match: the record goes.
			const fresh = await store.getVersioned(rid);
			const current = readRecord(fresh?.value);
			if (!fresh || !current || current.claimToken !== token) return { record: current, busy: false, ...told };
			if (!current.dirty && (await store.compareAndDelete(rid, fresh.revision)).applied) return { record: null, busy: false, ...told };
			// An event arrived meanwhile, so the record stays for the next pass. "Published before the rule" is still
			// unchecked if it was: that pass (or any later job) checks it again before it creates anything.
			outcome = { ...settled({ state: "stopped" }), sinceUnchecked: claimed.sinceUnchecked || current.sinceUnchecked };
		}
		let again = false;
		const result = outcome;
		const lastPass = pass === 2;
		last = await updateRecord(ctx, rid, (current) => {
			if (!current) return null;
			if (current.claimToken !== token) {
				// Taken over (this job ran past its claim): the other job's outcome stands. A draft this job made that the
				// record doesn't name is a second one: noted, so the page says to delete it.
				const made = result.emailId;
				if (made && made !== current.emailId && !current.extraEmails.includes(made)) return { ...current, extraEmails: [...current.extraEmails, made].slice(-5) };
				return null;
			}
			again = current.dirty;
			const { deleteRecord: _drop, ...patch } = result;
			const next: ButtondownRecord = { ...current, ...patch, claimToken: null, claimedAt: null, dirty: false, updatedAt: iso(deps.now()) };
			if (again) {
				// An event arrived meanwhile: check the entry once more (delete the draft if it was unpublished, else update).
				const leaving = next.unpublished || next.trashed || next.deleted;
				const live = Boolean(next.emailId) && !["gone", "removed", "edited", "stopped"].includes(next.state);
				// A create that got no answer may have made a draft the record doesn't name: the delete step looks for it.
				const orphan = !next.emailId && Boolean(next.createSentAt) && next.state === "error";
				next.job = leaving ? (live || orphan ? "remove" : null) : "sync";
				if (!next.job) {
					again = false;
					// The post left the site while its create was failing: nothing left to make, or to report.
					if (next.state === "error" && !next.emailId) Object.assign(next, CLEARED, UNSENT, { state: "stopped" });
				} else if (lastPass) {
					// Out of passes with work left: the hourly task's, now.
					next.nextRetryAt = iso(deps.now());
				} else if (next.state !== "error") {
					next.nextRetryAt = iso(deps.now() + BUTTONDOWN_LIMITS.stuckMs);
				}
			}
			return next;
		});
		if (!again) return { record: last, busy: false, ...told };
	}
	// Out of passes (the last one lost its claim to another writer, or events kept coming): a record that still has
	// work and no time for the hourly task gets one, so nothing is left that no one runs.
	const left = await updateRecord(ctx, rid, (current) => (current && current.job && !current.nextRetryAt && !claimHeld(current, token, deps.now()) ? { ...current, nextRetryAt: iso(deps.now()) } : null));
	return { record: left ?? last, busy: false, ...told };
}

/** The entry's job (see runJob), for the hooks and the hourly task: a plain step, never a forced write. */
export async function runEntry(ctx: PluginContext, deps: SyncDeps, collection: string, entryId: string, deadline: number): Promise<ButtondownRecord | null> {
	return (await runJob(ctx, deps, collection, entryId, deadline)).record;
}

// ── Manual actions (routes) ──────────────────────────────────────

export type ManualAction = "create" | "refresh" | "retry";

const UNREAD = "The post couldn't be read just now. Try again in a moment.";

/** Why an action can't run now, or null when it can. `seen` (refresh): the draft's modification_date the admin was shown. */
export async function manualRefusal(ctx: PluginContext, deps: SyncDeps, action: ManualAction, collection: string, id: string, record: ButtondownRecord | null, seen?: string | null): Promise<string | null> {
	if (action === "retry") return record && (record.state === "error" || isStuck(record, deps.now()) || record.state === "pending") ? null : "There's nothing to retry.";
	try {
		const item = await getItem(ctx, collection, id);
		if (!isLiveItem(item)) return "Publish the post first. Drafts are made from the published post.";
		const rule = ruleFor(await reading("the Buttondown Drafts rules", () => deps.settings(ctx)), collection);
		if (!rule) return "No rule covers this collection. Add one on the Buttondown Drafts page.";
		if (!(await matchesRule(ctx, deps, rule, collection, id))) return "The post doesn't have one of the rule's terms.";
	} catch (error) {
		if (error instanceof ReadFailed) return UNREAD;
		throw error;
	}
	if (action === "create") {
		if (record && !["gone", "stopped", "removed"].includes(record.state) && !(record.state === "error" && !record.emailId)) return "This post already has a draft.";
		return null;
	}
	if (!record || !record.emailId || !(record.state === "draft" || record.state === "edited")) return "Only a draft the Pack made can be refreshed.";
	if (!seen) return "The draft has to be read from Buttondown first. Select Refresh draft from post again.";
	return null;
}

/**
 * Refresh draft from post: write the post over the draft, changes made in Buttondown included, once, and only while
 * Buttondown still shows the modification_date the admin was shown before confirming (`seen`). The route waits for
 * it. Nothing about it is stored: when it fails, or another job holds the record, it's over, and the admin asks again.
 */
export async function refreshDraft(ctx: PluginContext, deps: SyncDeps, collection: string, id: string, seen: string): Promise<JobResult> {
	if (typeof seen !== "string" || !seen) throw new Error("Refresh needs the modification date the admin saw.");
	const rid = recordId(collection, id);
	const now = deps.now();
	// The time is for the hourly task, should this run find the record held by a job that then dies: a plain check, never this overwrite.
	await updateRecord(ctx, rid, (current) => (current ? { ...current, job: "sync", nextRetryAt: iso(now + BUTTONDOWN_LIMITS.stuckMs), updatedAt: iso(now) } : null));
	return runJob(ctx, deps, collection, id, now + 20_000, seen);
}

/** Queue the action on the record and run it now (the route waits for it). */
export async function runManual(ctx: PluginContext, deps: SyncDeps, action: ManualAction, collection: string, id: string, options: { seen?: string | null } = {}): Promise<ButtondownRecord | null> {
	if (action === "refresh") return (await refreshDraft(ctx, deps, collection, id, options.seen ?? "")).record;
	const rid = recordId(collection, id);
	const now = deps.now();
	let kept = false;
	const queueCreate = (base: ButtondownRecord, keep: boolean): ButtondownRecord => ({
		...base,
		...CLEARED,
		...UNSENT,
		state: "pending",
		job: "sync",
		...(keep ? {} : { emailId: null, hash: null, remoteModifiedAt: null, remoteStatus: null }),
		manual: true,
		sinceUnchecked: false,
		unpublished: false,
		trashed: false,
		deleted: false,
		updatedAt: iso(now),
	});
	await updateRecord(ctx, rid, (current) => {
		const base = current ?? newRecord(collection, id, now);
		if (action === "create") {
			// A stopped record still names its draft: that one is checked against the date the Pack recorded for it
			// (never looked up afresh, where an edit there couldn't be told from the Pack's own update).
			kept = base.state === "stopped" && Boolean(base.emailId);
			return queueCreate(base, kept);
		}
		return { ...base, job: base.job ?? "sync", nextRetryAt: iso(now + BUTTONDOWN_LIMITS.stuckMs), claimToken: null, claimedAt: null, updatedAt: iso(now) };
	});
	const out = await runEntry(ctx, deps, collection, id, now + 20_000);
	// That draft turned out to be deleted in Buttondown: Create draft now makes a new one, as for any deleted draft.
	if (action === "create" && kept && out?.state === "gone") {
		await updateRecord(ctx, rid, (current) => (current && current.state === "gone" ? queueCreate(current, false) : null));
		return runEntry(ctx, deps, collection, id, now + 20_000);
	}
	return out;
}

// ── The hourly task ──────────────────────────────────────────────

/**
 * Retry what's due (nextRetryAt passed), finish what was dropped (pending or claimed for 5 minutes), retry a refused
 * key once it's been changed, at most five records a run; forget failed records of collections that turned out to
 * have no rule; then prune records nothing has changed for 180 days (finished ones, and failures nobody retried).
 */
export async function retryDue(ctx: PluginContext, deps: SyncDeps, deadline = deps.now() + 3 * 60_000): Promise<{ retried: number; pruned: number }> {
	const store = records(ctx);
	const now = deps.now();
	const picked = new Map<string, ButtondownRecord>();
	const take = (items: Array<{ id: string; data: unknown }>, keep: (r: ButtondownRecord) => boolean) => {
		for (const { id, data } of items) {
			const r = readRecord(data);
			if (r && keep(r) && picked.size < BUTTONDOWN_LIMITS.retriesPerRun) picked.set(id, r);
		}
	};
	take((await store.query({ where: { nextRetryAt: { lte: iso(now) } }, orderBy: { nextRetryAt: "asc" }, limit: BUTTONDOWN_LIMITS.retriesPerRun })).items, (r) => r.state === "error" || Boolean(r.job));
	if (picked.size < BUTTONDOWN_LIMITS.retriesPerRun) take((await store.query({ where: { state: { in: ["pending", "creating", "removing"] } }, orderBy: { updatedAt: "asc" }, limit: 20 })).items, (r) => isStuck(r, now));
	if (picked.size < BUTTONDOWN_LIMITS.retriesPerRun) {
		const errors = (await store.query({ where: { state: "error" }, orderBy: { updatedAt: "asc" }, limit: 50 })).items;
		const refused = errors.map((e) => readRecord(e.data)).filter((r): r is ButtondownRecord => Boolean(r?.authFingerprint));
		if (refused.length) {
			const current = await keyFingerprint((await readKey(ctx)).key);
			if (current !== "none") take(errors, (r) => Boolean(r.authFingerprint) && r.authFingerprint !== current);
		}
		// Queued by a hook that couldn't read the rules, never made, and (now that the rules read) in a collection
		// with no rule: nothing to make, retry or report. Forgotten here, so such a record can't outlive its retries.
		const unsure = errors.filter(({ id, data }) => {
			const r = readRecord(data);
			return Boolean(r && isUnsure(r) && !picked.has(id) && !claimHeld(r, "", now));
		});
		if (unsure.length) {
			const settings = await deps.settings(ctx).catch(() => null);
			const strays = settings ? unsure.filter(({ data }) => !ruleFor(settings, (readRecord(data) as ButtondownRecord).collection)).map(({ id }) => id) : [];
			if (strays.length) await store.deleteMany(strays);
		}
	}
	let retried = 0;
	for (const r of picked.values()) {
		if (deps.now() + BUTTONDOWN_LIMITS.jobMs > deadline) break;
		// The time stays ahead of the run (the outcome replaces it), so a run that's cut off here is picked up again.
		await updateRecord(ctx, recordId(r.collection, r.entryId), (current) => (current ? { ...current, job: current.job ?? "sync", nextRetryAt: iso(now + BUTTONDOWN_LIMITS.stuckMs), claimToken: isStuck(current, now) ? null : current.claimToken, updatedAt: iso(now) } : null));
		await runEntry(ctx, deps, r.collection, r.entryId, Math.min(deadline, deps.now() + BUTTONDOWN_LIMITS.jobMs)).catch((error: unknown) => ctx.log.warn("buttondown: a retry failed", { entry: recordId(r.collection, r.entryId), error: error instanceof Error ? error.name : "error" }));
		retried++;
	}
	const cutoff = iso(now - BUTTONDOWN_LIMITS.pruneAfterMs);
	const old = await store.query({ where: { state: { in: [...PRUNABLE] }, updatedAt: { lt: cutoff } }, limit: 50 });
	const pruned = old.items.length ? await store.deleteMany(old.items.map((i) => i.id)) : 0;
	return { retried, pruned };
}

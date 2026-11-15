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
 *   the Pack's key in Buttondown's draft list and adopts what it finds.
 * - A job that was dropped: its record is already pending, and the hourly task
 *   finishes it.
 *
 * What it never does: send, schedule or publish (the client can't), write an
 * email that isn't a draft or that was changed in Buttondown (unless Refresh
 * draft from post asks, and still only a draft), or delete anything but an
 * untouched draft of a post that was unpublished, trashed or deleted.
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
import { type ButtondownRule, type ButtondownSettings, cachedSettings, ruleFor } from "./settings.js";
import {
	type ButtondownRecord,
	type EventKind,
	PRUNABLE,
	adoptable,
	claimHeld,
	classifyRemote,
	decideEvent,
	failure,
	isStuck,
	newRecord,
	readRecord,
	recordId,
} from "./sync-core.js";

// ── Dependencies (replaced in tests) ─────────────────────────────

export interface SyncDeps {
	now: () => number;
	/** The site database, or null (outside a Worker): reads then go through the plugin context. */
	db: () => Promise<D1Database | null>;
	settings: (ctx: PluginContext) => Promise<ButtondownSettings>;
	/** The entry's term slugs in one taxonomy. */
	terms: (ctx: PluginContext, collection: string, id: string, taxonomy: string) => Promise<string[]>;
	/** Child term → parent term, for one taxonomy. */
	termParents: (ctx: PluginContext, taxonomy: string) => Promise<ReadonlyMap<string, string>>;
	/** The published entry's absolute URL, or null. */
	postUrl: (ctx: PluginContext, collection: string, item: Item) => Promise<string | null>;
	/** File Downloads' files for the entry's file cards. */
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
		settings: (ctx) => cachedSettings(ctx, database),
		terms: async (ctx, collection, id, taxonomy) => entryTerms(await source(ctx), collection, id, taxonomy),
		termParents: async (ctx, taxonomy) => {
			const hit = parentsCache.get(taxonomy);
			if (hit && isCurrent(hit, 5 * 60_000)) return hit.parents;
			const epoch = settingsEpoch();
			const parents = (await termParentMaps(await source(ctx), [taxonomy])).get(taxonomy) ?? new Map<string, string>();
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
			const settings = await readFilesSettings(d1);
			const base = settings.publicBaseUrl || siteUrl.replace(/\/+$/, "");
			for (const id of ids) {
				const file = await resolveFile(d1, id).catch(() => null);
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

// ── Matching ─────────────────────────────────────────────────────

/** Whether the entry has one of the rule's terms, or a child term of one. */
export async function matchesRule(ctx: PluginContext, deps: SyncDeps, rule: ButtondownRule, collection: string, id: string): Promise<boolean> {
	const slugs = await deps.terms(ctx, collection, id, rule.taxonomy);
	if (!slugs.length) return false;
	const wanted = new Set(rule.terms);
	if (slugs.some((s) => wanted.has(s))) return true;
	const parents = await deps.termParents(ctx, rule.taxonomy);
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
 * settings come with the feature switches, so an entry of a collection without a rule costs no query; a matching
 * publish costs the terms query, a record read and a write.
 */
export async function handleEvent(ctx: PluginContext, deps: SyncDeps, kind: EventKind, event: { id?: unknown; collection?: unknown; content?: Record<string, unknown>; permanent?: unknown }): Promise<void> {
	const { collection, id } = eventEntry(kind, event);
	if (!id || !COLLECTION_SLUG.test(collection) || id.length > 128) return;
	const publishing = kind === "publish" || kind === "save";
	const settings = await deps.settings(ctx);
	const rule = ruleFor(settings, collection);
	const content = event.content ?? {};
	// A save of a draft revision (or of an entry that isn't published) doesn't change the live post.
	const live = kind === "publish" ? content.status === "published" : kind === "save" ? content.status === "published" && !content.draftRevisionId : false;
	if (publishing && (!rule || !live)) return;

	const rid = recordId(collection, id);
	const existing = readRecord(await records(ctx).get(rid));
	// No record: an unpublish, trash, delete or restore has nothing to do, and a post published before the rule waits for Create draft now.
	if (!existing && (!publishing || !newEnough(content.publishedAt, rule as ButtondownRule))) return;
	const facts = {
		live,
		matches: publishing && rule ? await matchesRule(ctx, deps, rule, collection, id) : false,
		newEnough: publishing && rule ? newEnough(content.publishedAt, rule) : false,
		updatesOn: isOn(await cachedCtxFeatures(ctx).catch(() => ({})), BUTTONDOWN_FEATURES.updates),
	};
	const now = deps.now();
	const decided: { run: ButtondownRecord["job"] } = { run: null };
	await updateRecord(ctx, rid, (current) => {
		const decision = decideEvent(kind, current, facts);
		decided.run = decision.run;
		if (!decision.patch && !decision.run) return null;
		const base = current ?? newRecord(collection, id, now);
		const next: ButtondownRecord = { ...base, ...(decision.patch ?? {}), updatedAt: iso(now) };
		if (decision.run) {
			next.job = decision.run;
			if (!current) next.state = "pending";
			// A job holds it here or in another isolate: it runs once more when it's done.
			if (running.has(rid) || claimHeld(base, "", now)) next.dirty = true;
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

// ── The job ──────────────────────────────────────────────────────

type Outcome = Partial<ButtondownRecord> & { deleteRecord?: true };

interface Run {
	ctx: PluginContext;
	deps: SyncDeps;
	record: ButtondownRecord;
	deadline: number;
	updatesOn: boolean;
	settings: ButtondownSettings;
}

const settled = (patch: Partial<ButtondownRecord>): Outcome => ({ attempts: 0, nextRetryAt: null, errorSince: null, lastError: null, authFingerprint: null, job: null, ...patch });

let schemaCache: { at: number; list: Map<string, CollectionSchemaInfo> } | null = null;
async function collectionSchema(ctx: PluginContext, slug: string): Promise<CollectionSchemaInfo | null> {
	if (!schemaCache || Date.now() - schemaCache.at > 60_000) schemaCache = { at: Date.now(), list: new Map() };
	if (!schemaCache.list.has(slug)) {
		const info = (await ctx.schema?.getCollection(slug).catch(() => null)) ?? null;
		if (!info) return null;
		schemaCache.list.set(slug, info);
	}
	return schemaCache.list.get(slug) ?? null;
}

const isLiveItem = (item: Item | null): item is Item => Boolean(item && item.status === "published");

async function getItem(ctx: PluginContext, collection: string, id: string): Promise<Item | null> {
	return ((await ctx.content?.get(collection, id).catch(() => null)) as Item | null) ?? null;
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
	const schema = await collectionSchema(ctx, record.collection);
	const fields = schema?.fields ?? [];
	const bodyFields = fields
		.filter((f) => f.type === "portableText")
		.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
		.map((f) => item.data[f.slug]);
	const titleField = schema?.titleField ?? "title";
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const featured = fields
		.filter((f) => f.type === "image")
		.map((f) => imageValueUrl(item.data[f.slug]))
		.find((u): u is string => Boolean(u));
	const siteUrl = ctx.site.url.replace(/\/+$/, "");
	const postUrl = (await deps.postUrl(ctx, record.collection, item).catch(() => null)) ?? "";
	const types = blockTypes(bodyFields);
	const disclosure: DisclosureSettings | undefined = types.has("coywolf-disclosure") ? normalizeDisclosureSettings(await ctx.settings.get(DISCLOSURE_SETTINGS_KEY).catch(() => null)) : undefined;
	const podcast: PodcastSettings | undefined = types.has("coywolf-podcast") ? normalizePodcastSettings(await ctx.settings.get(PODCAST_SETTINGS_KEY).catch(() => null)) : undefined;
	const files = types.has("coywolf-file") ? await deps.files(ctx, item, siteUrl).catch(() => new Map<string, EmailFile>()) : undefined;
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

/** Drafts the Pack made for this entry, from the first pages of Buttondown's draft list (oldest first). */
async function findDrafts(run: Run, client: ButtondownClient, key: string): Promise<ButtondownEmail[]> {
	const out: ButtondownEmail[] = [];
	for (let page = 1; page <= BUTTONDOWN_LIMITS.lookupPages; page++) {
		const { results, hasMore } = await patient(run, () => client.listApiDrafts(page));
		out.push(...results.filter((e) => packKeyOf(e) === key));
		if (!hasMore) break;
	}
	return out.sort((a, b) => (Date.parse(a.creationDate ?? "") || 0) - (Date.parse(b.creationDate ?? "") || 0));
}

const DUPLICATES = (n: number) => `Buttondown has ${n} drafts for this post: the Pack uses the oldest. Delete the others there.`;

async function syncStep(run: Run): Promise<Outcome> {
	const { ctx, deps, record } = run;
	const item = await getItem(ctx, record.collection, record.entryId);
	if (!isLiveItem(item)) {
		// Not published (any more): an untouched draft goes as on an unpublish; a create that never happened is forgotten.
		if (record.emailId && record.state !== "edited" && record.state !== "gone" && record.state !== "stopped") return removeStep({ ...run, record: { ...record, unpublished: record.unpublished || !record.trashed } });
		return record.emailId ? settled({}) : { deleteRecord: true };
	}
	const rule = ruleFor(run.settings, record.collection);
	if (!rule || !(await matchesRule(ctx, deps, rule, record.collection, record.entryId))) return record.emailId ? settled({ state: "stopped" }) : { deleteRecord: true };

	const email = await emailFor(run, item);
	const { built, source } = email;
	const shown = { title: source.title.slice(0, 300), postUrl: source.postUrl || null, warnings: built.warnings };
	if (record.emailId && !record.force && record.state === "draft" && built.hash === record.hash) return settled({ ...shown, state: "draft" });

	const { client } = await clientFor(run);

	if (record.emailId) {
		let remote: ButtondownEmail | null;
		try {
			remote = await patient(run, () => client.getEmail(record.emailId as string));
		} catch (error) {
			if (error instanceof ButtondownError && error.status === 404) remote = null;
			else throw error;
		}
		const verdict = classifyRemote(remote ? { status: remote.status, modificationDate: remote.modificationDate, key: packKeyOf(remote) } : null, record, source.key, record.force);
		if (verdict === "gone") return settled({ ...shown, state: "gone", remoteStatus: null, force: false });
		if (verdict === "left") return settled({ ...shown, state: "left", remoteStatus: remote?.status ?? null, force: false });
		if (verdict === "edited") return settled({ ...shown, state: "edited", remoteStatus: "draft", force: false });
		if (!run.updatesOn && !record.force) return settled({ ...shown, state: "draft", remoteStatus: "draft" });
		const current = remote as ButtondownEmail;
		const write = await withSlugRetry(run, item, email, (e) => client.updateDraft(record.emailId as string, { ...e.built.fields, metadata: packMetadata(e.source, e.built.hash, current.metadata) }));
		return settled({ ...shown, warnings: write.email.built.warnings, state: "draft", hash: write.email.built.hash, remoteModifiedAt: write.result.modificationDate, remoteStatus: write.result.status, noSlug: write.noSlug, force: false });
	}

	// Create: look in Buttondown first, so a POST that landed (its answer lost) is adopted, not repeated.
	const found = await findDrafts(run, client, source.key);
	if (found.length) {
		const oldest = found[0];
		const warnings = found.length > 1 ? [...built.warnings, DUPLICATES(found.length)] : built.warnings;
		const sameHash = packHashOf(oldest) === built.hash;
		if (sameHash) return settled({ ...shown, warnings, state: "draft", emailId: oldest.id, hash: built.hash, remoteModifiedAt: oldest.modificationDate, remoteStatus: "draft" });
		if (!adoptable(oldest, false)) return settled({ ...shown, warnings, state: "edited", emailId: oldest.id, hash: null, remoteModifiedAt: oldest.modificationDate, remoteStatus: "draft" });
		const write = await withSlugRetry(run, item, email, (e) => client.updateDraft(oldest.id, { ...e.built.fields, metadata: packMetadata(e.source, e.built.hash, oldest.metadata) }));
		return settled({ ...shown, warnings: found.length > 1 ? [...write.email.built.warnings, DUPLICATES(found.length)] : write.email.built.warnings, state: "draft", emailId: oldest.id, hash: write.email.built.hash, remoteModifiedAt: write.result.modificationDate, remoteStatus: write.result.status, noSlug: write.noSlug });
	}
	const write = await withSlugRetry(run, item, email, (e) => client.createDraft(e.built.fields));
	ctx.log.info("buttondown: draft created", { entry: recordId(record.collection, record.entryId), email: write.result.id });
	return settled({ ...shown, warnings: write.email.built.warnings, state: "draft", emailId: write.result.id, hash: write.email.built.hash, remoteModifiedAt: write.result.modificationDate, remoteStatus: write.result.status, noSlug: write.noSlug, force: false });
}

async function removeStep(run: Run): Promise<Outcome> {
	const { ctx, deps, record } = run;
	if (!record.deleted) {
		const item = await getItem(ctx, record.collection, record.entryId);
		const rule = ruleFor(run.settings, record.collection);
		// Published again before the delete ran: no delete; the draft is updated as on a republish.
		if (isLiveItem(item) && !record.trashed) {
			if (rule && (await matchesRule(ctx, deps, rule, record.collection, record.entryId))) return { unpublished: false, ...(await syncStep({ ...run, record: { ...record, job: "sync", state: "draft", unpublished: false } })) };
			return settled({ state: "stopped", unpublished: false });
		}
	}
	const finalState = (state: ButtondownRecord["state"]) => (record.deleted ? "stopped" : state);
	if (!record.emailId) return settled({ state: finalState(record.state === "removing" ? "removed" : record.state) });
	const { client } = await clientFor(run);
	const expectedKey = entryKey(ctx.site.url, record.collection, record.entryId);
	const outcome = await patient(run, () => client.deleteDraft(record.emailId as string, record.remoteModifiedAt, expectedKey));
	ctx.log.info("buttondown: delete checked", { entry: recordId(record.collection, record.entryId), email: record.emailId, outcome: outcome.outcome });
	switch (outcome.outcome) {
		case "deleted":
			return settled({ state: finalState("removed"), emailId: null, hash: null, remoteModifiedAt: null, remoteStatus: "deleted" });
		case "gone":
			return settled({ state: finalState("gone"), remoteStatus: null });
		case "left":
			return settled({ state: finalState("left"), remoteStatus: outcome.status });
		case "edited":
			return settled({ state: finalState("edited"), remoteStatus: "draft" });
	}
}

/** A failed step as the record's error. */
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
	} else if (error instanceof ButtondownError) {
		status = error.status;
		code = error.code;
		plan = failure({ status, code, retryAfter: error.retryAfter }, record, now);
		message =
			plan.kind === "auth"
				? `Buttondown refused the key (${status}). Check it on the plugin's Settings page: it needs Emails and drafts → Write.${error.detail ? ` Buttondown said: ${error.detail}` : ""}`
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
	run.ctx.log.warn("buttondown: a step failed", { entry: recordId(record.collection, record.entryId), email: record.emailId, job: record.job, status, code });
	return {
		state: "error",
		job: record.job ?? "sync",
		attempts: record.attempts + 1,
		errorSince: record.errorSince ?? at,
		lastError: { at, status, code, message: safeDetail(message) },
		nextRetryAt: plan.nextRetryAt,
		authFingerprint: fingerprint,
	};
}

/**
 * The entry's job: claim the record, do its step (create or update, or delete), write the outcome, and once more
 * when an event marked it dirty meanwhile (at most three passes).
 */
export async function runEntry(ctx: PluginContext, deps: SyncDeps, collection: string, entryId: string, deadline: number): Promise<ButtondownRecord | null> {
	const rid = recordId(collection, entryId);
	const store = records(ctx);
	const token = crypto.randomUUID();
	let last: ButtondownRecord | null = null;
	for (let pass = 0; pass < 3; pass++) {
		const read = await store.getVersioned(rid);
		const record = readRecord(read?.value);
		if (!read || !record || !record.job) return record;
		const now = deps.now();
		if (claimHeld(record, token, now)) {
			// Another job has it: it runs once more when it's done.
			if (!record.dirty) await store.compareAndSet(rid, read.revision, { ...record, dirty: true, updatedAt: iso(now) });
			return record;
		}
		const claimed: ButtondownRecord = { ...record, claimToken: token, claimedAt: iso(now), dirty: false, updatedAt: iso(now), state: record.job === "sync" && !record.emailId ? "creating" : record.state };
		if (!(await store.compareAndSet(rid, read.revision, claimed)).applied) continue;
		const [settings, features] = await Promise.all([deps.settings(ctx), ctxFeatures(ctx).catch(() => ({}))]);
		const run: Run = { ctx, deps, record: claimed, deadline, updatesOn: isOn(features, BUTTONDOWN_FEATURES.updates), settings };
		let outcome: Outcome;
		try {
			outcome = claimed.job === "remove" ? await removeStep(run) : await syncStep(run);
		} catch (error) {
			outcome = await failed(run, error);
		}
		if (outcome.deleteRecord) {
			// A create that never happened, for an entry that isn't published or doesn't match: the record goes.
			const fresh = await store.getVersioned(rid);
			const current = readRecord(fresh?.value);
			if (!fresh || !current || current.claimToken !== token) return current;
			if (!current.dirty && (await store.compareAndDelete(rid, fresh.revision)).applied) return null;
			outcome = settled({ state: "stopped" });
		}
		let again = false;
		const result = outcome;
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
				next.job = leaving ? (live ? "remove" : null) : "sync";
				if (!next.job) again = false;
			}
			return next;
		});
		if (!again) return last;
	}
	return last;
}

// ── Manual actions (routes) ──────────────────────────────────────

export type ManualAction = "create" | "refresh" | "retry";

/** Why an action can't run now, or null when it can. */
export async function manualRefusal(ctx: PluginContext, deps: SyncDeps, action: ManualAction, collection: string, id: string, record: ButtondownRecord | null): Promise<string | null> {
	if (action === "retry") return record && (record.state === "error" || isStuck(record, deps.now()) || record.state === "pending") ? null : "There's nothing to retry.";
	const item = await getItem(ctx, collection, id);
	if (!isLiveItem(item)) return "Publish the post first. Drafts are made from the published post.";
	const rule = ruleFor(await deps.settings(ctx), collection);
	if (!rule) return "No rule covers this collection. Add one on the Buttondown Drafts page.";
	if (!(await matchesRule(ctx, deps, rule, collection, id))) return "The post doesn't have one of the rule's terms.";
	if (action === "create") {
		if (record && !["gone", "stopped", "removed"].includes(record.state) && !(record.state === "error" && !record.emailId)) return "This post already has a draft.";
		return null;
	}
	if (!record || !(record.state === "draft" || record.state === "edited")) return "Only a draft the Pack made can be refreshed.";
	return null;
}

/** Queue the action on the record and run it now (the route waits for it). */
export async function runManual(ctx: PluginContext, deps: SyncDeps, action: ManualAction, collection: string, id: string): Promise<ButtondownRecord | null> {
	const rid = recordId(collection, id);
	const now = deps.now();
	await updateRecord(ctx, rid, (current) => {
		const base = current ?? newRecord(collection, id, now);
		if (action === "create") return { ...base, state: "pending", job: "sync", emailId: null, hash: null, remoteModifiedAt: null, remoteStatus: null, manual: true, force: false, attempts: 0, nextRetryAt: null, errorSince: null, lastError: null, unpublished: false, trashed: false, deleted: false, updatedAt: iso(now) };
		if (action === "refresh") return { ...base, job: "sync", force: true, nextRetryAt: null, updatedAt: iso(now) };
		return { ...base, job: base.job ?? "sync", nextRetryAt: null, claimToken: null, claimedAt: null, updatedAt: iso(now) };
	});
	return runEntry(ctx, deps, collection, id, now + 20_000);
}

// ── The hourly task ──────────────────────────────────────────────

/**
 * Retry what's due (nextRetryAt passed), finish what was dropped (pending or claimed for 5 minutes), retry a refused
 * key once it's been changed, at most five records a run; then prune finished records older than 180 days.
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
	}
	let retried = 0;
	for (const r of picked.values()) {
		if (deps.now() + BUTTONDOWN_LIMITS.jobMs > deadline) break;
		await updateRecord(ctx, recordId(r.collection, r.entryId), (current) => (current ? { ...current, job: current.job ?? "sync", nextRetryAt: null, claimToken: isStuck(current, now) ? null : current.claimToken, updatedAt: iso(now) } : null));
		await runEntry(ctx, deps, r.collection, r.entryId, Math.min(deadline, deps.now() + BUTTONDOWN_LIMITS.jobMs)).catch((error: unknown) => ctx.log.warn("buttondown: a retry failed", { entry: recordId(r.collection, r.entryId), error: error instanceof Error ? error.name : "error" }));
		retried++;
	}
	const cutoff = iso(now - BUTTONDOWN_LIMITS.pruneAfterMs);
	const old = await store.query({ where: { state: { in: [...PRUNABLE] }, updatedAt: { lt: cutoff } }, limit: 50 });
	const pruned = old.items.length ? await store.deleteMany(old.items.map((i) => i.id)) : 0;
	return { retried, pruned };
}

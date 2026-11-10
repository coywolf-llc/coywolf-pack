/**
 * Content audit runs: page through the published entries of the audited
 * collections in bounded steps (scheduled ticks and the admin page's Run now
 * share them, one step at a time, through a lease), check each entry
 * (checks.ts), and store the results in chunks of one page each
 * (`audit_chunks` in plugin storage: one write per page of entries). Once
 * every entry is checked, one more step finds duplicate titles and
 * descriptions and broken internal links (Link Manager's data) across the
 * site, writes the summary report (with the previous run's counts, for
 * trends) and drops the older run's chunks.
 *
 * D1 work per page of PAGE entries: the content list (a few statements), one
 * read of the generated social images when that module is on, and one chunk
 * write. Each step stops at its statement budget or its deadline and records
 * where it got to, so a big site finishes over several ticks.
 */
import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import { getManyBatched } from "../core/storage.js";
import { Ops, chunked, queryAll, queryIn, refs, urls } from "../links/store.js";
import { AUDIT_DEFAULTS, type AuditSettings, CHECKS, type CheckId, type CollectionShape, type Issue, checkEntry, checkOn, duplicateGroups, effectiveTitle, normalizeAuditSettings, textKey } from "./checks.js";

export const RUN_KEY = "audit:run";
export const REPORT_KEY = "audit:report";
export const SETTINGS_KEY = "auditSettings";
const LEASE_KEY = "audit:lease";
export const CHUNKS = "audit_chunks";
/** The storage collection Social Images keeps its records in (src/social/store.ts), read when that module is on. */
const SOCIAL_IMAGES = "socialImages";

export const AUDIT_STORAGE = { [CHUNKS]: { indexes: ["runId"] } };

/** Entries per content page (and per chunk). */
const PAGE = 50;
/** Statements one page may take (the list, the social image lookup, the chunk write, the state write). */
const PAGE_RESERVE = 8;

export interface ChunkItem {
	c: string;
	id: string;
	title: string;
	updatedAt: string | null;
	/** Keys of the title and the meta description, for finding duplicates (checks.ts textKey). */
	t: string | null;
	d: string | null;
	issues: Issue[];
}

export interface Chunk {
	runId: string;
	n: number;
	items: ChunkItem[];
}

export interface RunState {
	status: "idle" | "running";
	runId: string | null;
	source: "scheduled" | "admin" | null;
	startedAt: string | null;
	finishedAt: string | null;
	phase: "entries" | "finish";
	collections: string[];
	index: number;
	cursor: string | null;
	/** The next chunk's number. */
	chunk: number;
	processed: number;
	settings: AuditSettings;
	error?: string;
}

export const IDLE_RUN: RunState = {
	status: "idle",
	runId: null,
	source: null,
	startedAt: null,
	finishedAt: null,
	phase: "entries",
	collections: [],
	index: 0,
	cursor: null,
	chunk: 0,
	processed: 0,
	settings: AUDIT_DEFAULTS,
};

export type Counts = Record<CheckId, number>;

export interface AuditReport {
	runId: string;
	startedAt: string;
	finishedAt: string;
	entries: number;
	entriesWithIssues: number;
	counts: Counts;
	/** Checks that were off for this run (their counts are 0). */
	off: CheckId[];
	/** Whether Link Manager's data was there for the broken links check. */
	linksChecked: boolean;
	previous: { runId: string; finishedAt: string; entries: number; counts: Counts } | null;
}

const zeroCounts = (): Counts => Object.fromEntries(CHECKS.map((c) => [c, 0])) as Counts;

export const chunks = (ctx: PluginContext) => ctx.storage[CHUNKS] as StorageCollection<Chunk>;

export async function readAuditSettings(ctx: PluginContext): Promise<AuditSettings> {
	return normalizeAuditSettings(await ctx.settings.get(SETTINGS_KEY).catch(() => null));
}

export async function getRun(ctx: PluginContext): Promise<RunState> {
	const state = await ctx.kv.get<RunState>(RUN_KEY);
	return state ? { ...IDLE_RUN, ...state } : { ...IDLE_RUN };
}

export async function getReport(ctx: PluginContext): Promise<AuditReport | null> {
	return (await ctx.kv.get<AuditReport>(REPORT_KEY)) ?? null;
}

// ── Collections ──────────────────────────────────────────────────

let schemaCache: { at: number; list: CollectionSchemaInfo[] } | null = null;

/** Collections with public pages (routable, not hidden), cached per isolate for a minute. */
export async function pageCollectionSchemas(ctx: PluginContext): Promise<CollectionSchemaInfo[]> {
	if (schemaCache && Date.now() - schemaCache.at < 60_000) return schemaCache.list;
	const list = ((await ctx.schema?.listCollections()) ?? []).filter((c) => c.routable !== false && !c.hidden);
	schemaCache = { at: Date.now(), list };
	return list;
}

export function resetAuditSchemaCache(): void {
	schemaCache = null;
}

function shapeOf(c: CollectionSchemaInfo): CollectionShape {
	return { slug: c.slug, hasSeo: c.hasSeo, titleField: c.titleField, fields: c.fields.map((f) => ({ slug: f.slug, type: f.type })) };
}

function entryTitle(c: CollectionSchemaInfo, item: { data: Record<string, unknown>; slug: string | null; id: string }): string {
	const candidates = [c.titleField ? item.data[c.titleField] : undefined, item.data.title, item.data.name, item.slug, item.id];
	return String(candidates.find((v) => typeof v === "string" && v.trim()) ?? item.id).trim().slice(0, 200);
}

// ── Lease (one step at a time) ───────────────────────────────────

async function acquireLease(ctx: PluginContext, owner: string, ttlMs: number): Promise<boolean> {
	const current = await ctx.kv.getVersioned<{ owner: string; expires: number }>(LEASE_KEY);
	if (current?.value && current.value.owner !== owner && current.value.expires > Date.now()) return false;
	return (await ctx.kv.compareAndSet(LEASE_KEY, current?.revision ?? null, { owner, expires: Date.now() + ttlMs })).applied;
}

async function releaseLease(ctx: PluginContext, owner: string): Promise<void> {
	const current = await ctx.kv.getVersioned<{ owner: string; expires: number }>(LEASE_KEY);
	if (current?.value?.owner === owner) await ctx.kv.compareAndDelete(LEASE_KEY, current.revision);
}

// ── Runs ─────────────────────────────────────────────────────────

/** Start a run (unless one is under way): the settings as they are now, and the collections to audit. */
export async function startRun(ctx: PluginContext, source: "scheduled" | "admin"): Promise<RunState> {
	const current = await getRun(ctx);
	if (current.status === "running") return current;
	const settings = await readAuditSettings(ctx);
	const available = (await pageCollectionSchemas(ctx)).map((c) => c.slug);
	const collections = settings.collections.length ? available.filter((c) => settings.collections.includes(c)) : available;
	const state: RunState = { ...IDLE_RUN, status: "running", runId: new Date().toISOString(), source, startedAt: new Date().toISOString(), collections, settings, finishedAt: current.finishedAt };
	await ctx.kv.set(RUN_KEY, state);
	return state;
}

/** Forget a run in progress (its chunks are dropped by the next run that finishes). */
export async function cancelRun(ctx: PluginContext): Promise<RunState> {
	const current = await getRun(ctx);
	const state: RunState = { ...IDLE_RUN, finishedAt: current.finishedAt };
	await ctx.kv.set(RUN_KEY, state);
	return state;
}

export interface StepOptions {
	/** Social Images is on: entries it made an image for don't count as missing one. */
	socialImages: boolean;
	/** Link Manager is on: its broken internal links are reported. */
	links: boolean;
	now?: number;
}

/**
 * One step of the run in progress, within `ops` (statements and deadline).
 * Returns the state, with `busy` when another step holds the run.
 */
export async function auditStep(ctx: PluginContext, ops: Ops, options: StepOptions): Promise<RunState & { busy?: boolean; report?: AuditReport }> {
	const owner = crypto.randomUUID();
	const leaseMs = Number.isFinite(ops.deadline) ? Math.max(30_000, ops.deadline - Date.now() + 30_000) : 120_000;
	if (!(await acquireLease(ctx, owner, leaseMs))) return { ...(await getRun(ctx)), busy: true };
	try {
		const state = await getRun(ctx);
		if (state.status !== "running" || !state.runId || !ctx.content) return state;
		delete state.error;
		ops.spend(3);
		const schemas = new Map((await pageCollectionSchemas(ctx)).map((c) => [c.slug, c]));

		while (state.phase === "entries" && state.index < state.collections.length && ops.has(PAGE_RESERVE)) {
			const schema = schemas.get(state.collections[state.index]);
			if (!schema) {
				Object.assign(state, { index: state.index + 1, cursor: null });
				continue;
			}
			let page: Awaited<ReturnType<NonNullable<PluginContext["content"]>["list"]>>;
			try {
				ops.spend(3);
				page = await ctx.content.list(schema.slug, { limit: PAGE, cursor: state.cursor ?? undefined, where: { status: "published" } });
			} catch (error) {
				ctx.log.warn("audit: could not list a collection; skipping it", { collection: schema.slug, error: String(error) });
				Object.assign(state, { index: state.index + 1, cursor: null });
				continue;
			}
			const items = page.items.filter((i) => i.status === "published");
			let generated = new Set<string>();
			if (options.socialImages && items.length) {
				ops.spend(1);
				const docs = await getManyBatched(ctx.storage[SOCIAL_IMAGES] as StorageCollection<unknown>, items.map((i) => `${schema.slug}:${i.id}`)).catch(() => new Map());
				generated = new Set(docs.keys());
			}
			const shape = shapeOf(schema);
			const chunk: Chunk = {
				runId: state.runId,
				n: state.chunk,
				items: items.map((item) => {
					const entry = { collection: schema.slug, id: item.id, title: entryTitle(schema, item), data: item.data, seo: item.seo ?? null, updatedAt: item.updatedAt ?? null };
					return {
						c: schema.slug,
						id: item.id,
						title: entry.title,
						updatedAt: entry.updatedAt,
						t: checkOn(state.settings, "titleDuplicate") ? textKey(effectiveTitle(entry)) : null,
						d: schema.hasSeo && checkOn(state.settings, "descriptionDuplicate") ? textKey(item.seo?.description) : null,
						issues: checkEntry(entry, shape, state.settings, { now: options.now, hasGeneratedImage: generated.has(`${schema.slug}:${item.id}`) }),
					};
				}),
			};
			if (chunk.items.length) {
				ops.spend(1);
				await chunks(ctx).put(`${state.runId}:${String(state.chunk).padStart(5, "0")}`, chunk);
				state.chunk++;
			}
			state.processed += chunk.items.length;
			if (page.hasMore && page.cursor) state.cursor = page.cursor;
			else Object.assign(state, { index: state.index + 1, cursor: null });
		}
		if (state.phase === "entries" && state.index >= state.collections.length) state.phase = "finish";

		let report: AuditReport | undefined;
		if (state.phase === "finish" && ops.has(PAGE_RESERVE)) {
			report = await finishRun(ctx, state, ops, options);
			Object.assign(state, { status: "idle", phase: "entries", finishedAt: report.finishedAt, cursor: null });
			ctx.log.info("audit: run finished", { entries: report.entries, withIssues: report.entriesWithIssues });
		}
		ops.spend(1);
		await ctx.kv.set(RUN_KEY, state);
		return report ? { ...state, report } : state;
	} catch (error) {
		const state = await getRun(ctx);
		state.error = String(error).slice(0, 300);
		await ctx.kv.set(RUN_KEY, state);
		throw error;
	} finally {
		await releaseLease(ctx, owner);
	}
}

/** Every chunk of a run, in order. */
export async function runChunks(ctx: PluginContext, runId: string, ops?: Ops): Promise<Chunk[]> {
	const rows = await queryAll(chunks(ctx), { runId }, { ops, max: 100_000 });
	return rows.map((r) => r.data).sort((a, b) => a.n - b.n);
}

/** The id of a run's extra chunk: the findings that need the whole site (duplicates, broken links). */
const extraId = (runId: string) => `${runId}:extra`;

/**
 * The run's last step: duplicates across every chunk, broken internal links
 * from Link Manager, the counts, and the report; then the older runs' chunks
 * are dropped.
 */
async function finishRun(ctx: PluginContext, state: RunState, ops: Ops, options: StepOptions): Promise<AuditReport> {
	const runId = state.runId as string;
	// The entries' chunks (a retried last step may find its own extra chunk already there).
	const all = (await runChunks(ctx, runId, ops)).filter((c) => c.n >= 0);
	const items = all.flatMap((c) => c.items);
	const extra = new Map<string, ChunkItem>();
	const add = (item: ChunkItem, issue: Issue) => {
		const key = `${item.c}/${item.id}`;
		const e = extra.get(key) ?? { ...item, issues: [] };
		e.issues.push(issue);
		extra.set(key, e);
	};
	const byKey = new Map(items.map((i) => [`${i.c}/${i.id}`, i]));
	const describe = (group: number[], self: number) => {
		const others = group.filter((i) => i !== self).map((i) => items[i].title);
		return `Same as “${others[0]?.slice(0, 80)}”${others.length > 1 ? ` and ${others.length - 1} more` : ""}`;
	};
	if (checkOn(state.settings, "titleDuplicate")) {
		for (const group of duplicateGroups(items.map((i) => i.t)).values()) for (const i of group) add(items[i], ["titleDuplicate", describe(group, i)]);
	}
	if (checkOn(state.settings, "descriptionDuplicate")) {
		for (const group of duplicateGroups(items.map((i) => i.d)).values()) for (const i of group) add(items[i], ["descriptionDuplicate", describe(group, i)]);
	}

	let linksChecked = false;
	if (options.links && checkOn(state.settings, "brokenLinks")) {
		try {
			const broken = await queryAll(urls(ctx), { status: "broken", internal: true, ignored: false }, { ops, max: 2_000 });
			const usage = broken.length ? await queryIn(refs(ctx), "urlId", broken.map((b) => b.id), ops) : [];
			const href = new Map(broken.map((b) => [b.id, b.data.url]));
			const perEntry = new Map<string, string[]>();
			for (const { data } of usage) {
				const list = perEntry.get(data.entryKey) ?? [];
				const url = href.get(data.urlId);
				if (url && !list.includes(url)) list.push(url);
				perEntry.set(data.entryKey, list);
			}
			for (const [key, list] of perEntry) {
				const item = byKey.get(key);
				if (item) add(item, ["brokenLinks", `${list.length === 1 ? "1 link" : `${list.length} links`}: ${list.slice(0, 3).join(", ")}${list.length > 3 ? ", …" : ""}`]);
			}
			linksChecked = true;
		} catch (error) {
			ctx.log.warn("audit: couldn't read Link Manager's broken links", { error: String(error) });
		}
	}
	const extraItems = [...extra.values()].slice(0, 5_000);
	ops.spend(1);
	await chunks(ctx).put(extraId(runId), { runId, n: -1, items: extraItems });

	const counts = zeroCounts();
	const flagged = new Set<string>();
	for (const item of [...items, ...extraItems]) {
		const seen = new Set<CheckId>();
		for (const [check] of item.issues) if (!seen.has(check)) seen.add(check);
		for (const check of seen) counts[check]++;
		if (item.issues.length) flagged.add(`${item.c}/${item.id}`);
	}
	const latest = await getReport(ctx);
	// A retried last step finds its own report: compare with the one before it, as the first try did.
	const previous = latest?.runId === runId ? latest.previous : latest;
	const finishedAt = new Date().toISOString();
	const report: AuditReport = {
		runId,
		startedAt: state.startedAt ?? runId,
		finishedAt,
		entries: items.length,
		entriesWithIssues: flagged.size,
		counts,
		off: state.settings.off,
		linksChecked,
		previous: previous ? { runId: previous.runId, finishedAt: previous.finishedAt, entries: previous.entries, counts: previous.counts } : null,
	};
	ops.spend(1);
	await ctx.kv.set(REPORT_KEY, report);

	// The runs before this one: their chunks are no longer read.
	try {
		const old = await queryAll(chunks(ctx), { runId: { lt: runId } }, { ops, max: 10_000 });
		for (const part of chunked(old.map((r) => r.id))) {
			ops.spend(1);
			await chunks(ctx).deleteMany(part);
		}
	} catch (error) {
		ctx.log.warn("audit: couldn't drop the previous run's results; the next run tries again", { error: String(error) });
	}
	return report;
}

// ── Reading the report ───────────────────────────────────────────

export interface Finding {
	collection: string;
	id: string;
	title: string;
	updatedAt: string | null;
	check: CheckId;
	detail: string;
}

/** Every finding of the latest finished run (optionally one check's), sorted by title. */
export async function findings(ctx: PluginContext, check?: CheckId): Promise<Finding[]> {
	const report = await getReport(ctx);
	if (!report) return [];
	const all = await runChunks(ctx, report.runId);
	const out: Finding[] = [];
	for (const chunk of all) {
		for (const item of chunk.items) {
			for (const [c, detail] of item.issues) {
				if (check && c !== check) continue;
				out.push({ collection: item.c, id: item.id, title: item.title, updatedAt: item.updatedAt, check: c, detail });
			}
		}
	}
	return out.sort((a, b) => a.title.localeCompare(b.title, "en-US") || a.check.localeCompare(b.check));
}

/** Change per check since the previous run (positive: more entries with the problem). */
export function trend(report: AuditReport): Partial<Record<CheckId, number>> {
	if (!report.previous) return {};
	const out: Partial<Record<CheckId, number>> = {};
	for (const check of CHECKS) {
		if (report.off.includes(check)) continue;
		const delta = report.counts[check] - (report.previous.counts?.[check] ?? 0);
		if (delta) out[check] = delta;
	}
	return out;
}

/** Whether the latest run found more of any problem than the one before it. */
export function worsened(report: AuditReport | null): Array<{ check: CheckId; before: number; now: number }> {
	if (!report?.previous) return [];
	return Object.entries(trend(report))
		.filter(([, delta]) => (delta ?? 0) > 0)
		.map(([check]) => ({ check: check as CheckId, before: report.previous?.counts?.[check as CheckId] ?? 0, now: report.counts[check as CheckId] }));
}

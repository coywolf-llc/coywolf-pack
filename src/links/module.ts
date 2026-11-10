/**
 * Link Manager: routes, hooks and scheduled jobs.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, requireFeature } from "../core/features.js";
import { parseInput, workerEnv } from "../shared.js";
import { BudgetExhausted, type Budget, checkUrl } from "./check.js";
import { type IgnoreRule, IgnoreRuleError, type LinkStatus, nextCheckAt, normalizeIgnore } from "./classify.js";
import { type LinkEdit, isAllowedTarget, transformEntry } from "./pt.js";
import { readOnlyRoute } from "../core/routes.js";
import {
	IDLE_SCAN,
	IGNORES_KEY,
	Ops,
	type RefRow,
	STATUS_RANK,
	type UrlRow,
	fixUnresolved,
	getCounts,
	getIgnores,
	getMany,
	getScan,
	indexEntry,
	invalidateCounts,
	latestData,
	linkCollections,
	putMany,
	queryIn,
	reapplyIgnores,
	refs,
	removeEntry,
	scanStep,
	startScan,
	urls,
} from "./store.js";

/** No build-time options yet; settings live on the Link Manager page. */
// An empty type: reserved for future options.
export type LinksOptions = {};

export const LINKS_SCAN_TASK = "links-scan";
export const LINKS_CHECK_TASK = "links-check";
const PAGE_SIZE = 50;
const CONCURRENCY = 6;
const STATUSES = Object.keys(STATUS_RANK) as LinkStatus[];

/** Per admin request: statements (D1 calls count as subrequests) and wall time. */
const REQUEST_OPS = 150;
const REQUEST_MS = 25_000;
/** Per scheduled scan run. */
const SCAN_OPS = 200;
const SCAN_MS = 60_000;

/**
 * Link checking settings, edited on the Link Manager page. Not in the
 * plugin's settingsSchema (that holds secrets only), so reads supply defaults.
 */
export const LINKS_DEFAULTS = { checkBudget: 40, checkInternal: true, userAgent: "", frequency: "weekly" } as const;

/** How often a scheduled run (a full scan, then checking the links that are due) starts while Scheduled link checking is on. */
export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
const FREQUENCY_DAYS: Record<Frequency, number> = { daily: 1, weekly: 7, monthly: 30 };
const isFrequency = (v: unknown): v is Frequency => typeof v === "string" && (FREQUENCIES as readonly string[]).includes(v);

async function readLinksSettings(ctx: PluginContext) {
	const [budget, internal, userAgent, frequency] = await Promise.all([
		ctx.settings.get<number>("linksCheckBudget"),
		ctx.settings.get<boolean>("linksCheckInternal"),
		ctx.settings.get<string>("linksUserAgent"),
		ctx.settings.get<string>("linksFrequency"),
	]);
	return {
		checkBudget: typeof budget === "number" && Number.isFinite(budget) ? budget : LINKS_DEFAULTS.checkBudget,
		checkInternal: typeof internal === "boolean" ? internal : LINKS_DEFAULTS.checkInternal,
		userAgent: typeof userAgent === "string" ? userAgent : LINKS_DEFAULTS.userAgent,
		frequency: isFrequency(frequency) ? frequency : LINKS_DEFAULTS.frequency,
	};
}

const linksSettingsInput = z.object({
	checkBudget: z.number().int().min(10, "Use at least 10 subrequests per run.").max(900, "Use at most 900 subrequests per run."),
	checkInternal: z.boolean(),
	userAgent: z.string().trim().max(500),
	frequency: z.enum(FREQUENCIES).optional(),
});

// ── Schedule ─────────────────────────────────────────────────────

/** The scheduled run in progress, or the last one (plugin KV). */
export const RUN_KEY = "links:scheduledRun";
export interface ScheduledRun {
	startedAt: string;
	phase: "scan" | "check" | "done";
	finishedAt?: string | null;
}

/** Cron ticks drift by seconds to minutes, so a run is due a little before the full interval has passed. */
const DUE_SLACK_MS = 5 * 60_000;

/** Whether a new scheduled run should start: never ran, or the last one started at least `frequency` ago. */
export function isRunDue(frequency: Frequency, lastStartedAt: string | null | undefined, now = Date.now()): boolean {
	if (!lastStartedAt) return true;
	const started = Date.parse(lastStartedAt);
	if (!Number.isFinite(started)) return true;
	return now - started >= FREQUENCY_DAYS[frequency] * 86_400_000 - DUE_SLACK_MS;
}

// ── Helpers ──────────────────────────────────────────────────────

type Content = NonNullable<PluginContext["content"]>;
type WritableContent = Content & { update: NonNullable<Content["update"]> };

function writable(ctx: PluginContext): WritableContent {
	const content = ctx.content;
	if (!content?.update) throw PluginRouteError.badRequest("Link Manager needs the content:write capability.");
	return content as WritableContent;
}

const requestOps = () => new Ops(REQUEST_OPS, Date.now() + REQUEST_MS);

// ── Checking ─────────────────────────────────────────────────────

export interface CheckRun {
	checked: number;
	/** Links that were due when the run started (up to 100). */
	due: number;
	byStatus: Partial<Record<LinkStatus, number>>;
	exhausted: boolean;
}

/**
 * Check due links (or `ids`) within a subrequest budget (HTTP requests and
 * database statements together) and a wall-clock deadline.
 */
/** Service binding to the site's own Worker, used to check internal links. */
export const SELF_BINDING = "SELF";

async function selfBinding(): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> } | null> {
	try {
		const env = await workerEnv();
		const binding = env[SELF_BINDING] as { fetch?: unknown } | undefined;
		return binding && typeof binding.fetch === "function" ? (binding as { fetch(url: string, init?: RequestInit): Promise<Response> }) : null;
	} catch {
		return null;
	}
}

export async function runChecks(ctx: PluginContext, options: { ids?: string[]; budget?: number; deadline?: number } = {}): Promise<CheckRun> {
	const settings = await readLinksSettings(ctx);
	const budget: Budget = { left: options.budget ?? settings.checkBudget };
	const checkInternal = settings.checkInternal;
	const userAgent = settings.userAgent.trim() || undefined;
	budget.left -= 5; // The four settings reads and the candidate query.
	const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
	const now = Date.now();
	// A Worker can't fetch its own custom domain over HTTP (Cloudflare answers 522), so
	// internal links go through a service binding to the site's own Worker when there is one.
	const self = await selfBinding();
	const siteHost = (() => {
		try {
			return ctx.site.url ? new URL(ctx.site.url).host : "";
		} catch {
			return "";
		}
	})();
	const fetcher = (url: string, init: RequestInit) =>
		self && siteHost && new URL(url).host === siteHost ? self.fetch(url, init) : fetch(url, init);

	let candidates: Array<{ id: string; data: UrlRow }>;
	if (options.ids) {
		const ops = new Ops();
		const found = await getMany(urls(ctx), options.ids, ops);
		budget.left -= ops.used - 1;
		candidates = [...found].map(([id, data]) => ({ id, data }));
	} else {
		const page = await urls(ctx).query({
			where: { ignored: false, nextCheckAt: { lte: new Date(now).toISOString() } },
			orderBy: { nextCheckAt: "asc" },
			limit: 100,
		});
		candidates = page.items;
	}

	const run: CheckRun = { checked: 0, due: candidates.length, byStatus: {}, exhausted: false };
	const queue = [...candidates];
	const worker = async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			// Room for the write plus a HEAD and a GET.
			if (budget.left < 3 || Date.now() >= deadline) {
				run.exhausted = true;
				return;
			}
			const { id, data } = next;
			budget.left--; // The row write below.
			const checkedAt = new Date().toISOString();
			if (!data.resolved || (data.internal && (!checkInternal || !self))) {
				await urls(ctx).put(id, {
					...data,
					note: !data.resolved
						? "Can't be resolved to a web address."
						: !checkInternal
							? "Internal links aren't checked (Link Manager → Settings)."
							: `Internal links need a "${SELF_BINDING}" service binding to the site's own Worker (see docs/links.md in the Coywolf Pack repository).`,
					nextCheckAt: nextCheckAt("ok", now),
				});
				continue;
			}
			try {
				const outcome = await checkUrl(new URL(data.resolved), budget, { userAgent, siteUrl: ctx.site.url, fetcher });
				await urls(ctx).put(id, {
					...data,
					status: outcome.status,
					rank: STATUS_RANK[outcome.status],
					code: outcome.code || null,
					finalUrl: outcome.finalUrl,
					chain: outcome.chain.slice(0, 8),
					note: outcome.note.slice(0, 300),
					checkedAt,
					nextCheckAt: nextCheckAt(outcome.status, Date.now()),
				});
				run.checked++;
				run.byStatus[outcome.status] = (run.byStatus[outcome.status] ?? 0) + 1;
			} catch (error) {
				if (error instanceof BudgetExhausted) {
					run.exhausted = true;
					return;
				}
				ctx.log.warn("links: check failed", { url: data.url, error: String(error) });
			}
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	if (run.checked) await invalidateCounts(ctx);
	return run;
}

// ── Editing ──────────────────────────────────────────────────────

export interface EditResult {
	entries: number;
	links: number;
	published: number;
	/** Fixed in the entry's draft only (it had unpublished changes, or is scheduled). */
	staged: number;
	scheduled: number;
	skipped: number;
	/** Entries changed by someone else while this ran; retry them. */
	conflicts: number;
	failed: Array<{ entry: string; error: string }>;
	/** Entry keys after `next` still to process; call again with `after: next`. */
	remaining: number;
	next: string | null;
}

const EMPTY_EDIT: EditResult = {
	entries: 0,
	links: 0,
	published: 0,
	staged: 0,
	scheduled: 0,
	skipped: 0,
	conflicts: 0,
	failed: [],
	remaining: 0,
	next: null,
};

/** Statements one entry edit may take (reads, update, publish, re-index). */
const EDIT_RESERVE = 30;

const versionOf = (item: { version?: number; updatedAt?: string; draftRevisionId?: string | null }) =>
	`${item.version ?? ""}|${item.updatedAt ?? ""}|${item.draftRevisionId ?? ""}`;

/**
 * Apply link edits to every entry that uses the given URLs. An entry with
 * unpublished changes is edited in its draft only; a published entry with no
 * pending draft is republished so the fix goes live. An entry that changes
 * while it's being edited is skipped and reported, never overwritten.
 */
async function applyEdits(ctx: PluginContext, plan: Map<string, LinkEdit>, ids: string[], after: string | null): Promise<EditResult> {
	const ops = requestOps();
	const content = writable(ctx);
	const collections = await linkCollections(ctx);
	const usage = await queryIn(refs(ctx), "urlId", ids, ops);
	const keys = [...new Set(usage.map((r) => r.data.entryKey))].sort().filter((k) => !after || k > after);
	const result: EditResult = { ...EMPTY_EDIT, failed: [] };
	let done = 0;

	for (const key of keys) {
		if (!ops.has(EDIT_RESERVE)) break;
		done++;
		result.next = key;
		const slash = key.indexOf("/");
		const collection = key.slice(0, slash);
		const id = key.slice(slash + 1);
		try {
			const info = collections.get(collection);
			ops.spend(2);
			const item = await content.get(collection, id);
			if (!item || !info) {
				await removeEntry(ctx, collection, id, ops);
				continue;
			}
			const hadDraft = Boolean(item.draftRevisionId);
			let data = await latestData(ctx, collection, item, ops);
			const patch: Record<string, unknown> = {};
			let changed = 0;
			for (const [href, edit] of plan) {
				const step = transformEntry(data, info.fields, (h) => h === href, edit);
				changed += step.changed;
				result.skipped += step.skipped;
				Object.assign(patch, step.patch);
				data = { ...data, ...step.patch };
			}
			if (changed && Object.keys(patch).length) {
				// Re-read right before writing: if anyone saved in between, leave the entry alone.
				ops.spend(2);
				const fresh = await content.get(collection, id);
				if (!fresh || versionOf(fresh) !== versionOf(item)) {
					result.conflicts++;
					result.failed.push({ entry: key, error: "Changed while being edited. Run the action again for this link." });
					continue;
				}
				ops.spend(5);
				await content.update(collection, id, patch);
				result.entries++;
				result.links += changed;
				if (item.status === "scheduled") result.scheduled++;
				if (info.revisions && item.status === "published") {
					let published = false;
					if (!hadDraft && content.getVersioned && content.publish) {
						ops.spend(2);
						const versioned = await content.getVersioned(collection, id);
						// Publish only the draft this edit created: exactly one version after the one read.
						if (versioned && versioned.item.version === (fresh.version ?? 0) + 1) {
							ops.spend(5);
							await content.publish(collection, id, { _rev: versioned._rev });
							published = true;
						}
					}
					if (published) result.published++;
					else result.staged++;
				} else if (info.revisions && item.status === "scheduled") {
					result.staged++;
				}
			}
			await indexEntry(ctx, collection, { ...item, data }, { ops });
		} catch (error) {
			result.failed.push({ entry: key, error: String(error).slice(0, 200) });
			ctx.log.error("links: edit failed", { entry: key, error: String(error) });
		}
	}
	result.remaining = keys.length - done;
	await invalidateCounts(ctx);
	return result;
}

// ── Listing ──────────────────────────────────────────────────────

const listInput = z.object({
	status: z.enum(["all", "ignored", ...STATUSES] as [string, ...string[]]).optional(),
	scope: z.enum(["all", "internal", "external"]).optional(),
	host: z.string().max(253).optional(),
	q: z.string().max(500).optional(),
	cursor: z.string().max(2000).nullish(),
	sort: z.enum(["status", "url", "checked"]).optional(),
});

/** One page of links, filtered and sorted by indexed storage queries. */
async function list(ctx: PluginContext, input: z.infer<typeof listInput>) {
	const status = input.status ?? "all";
	const where: Record<string, unknown> = { ignored: status === "ignored" };
	if (status !== "all" && status !== "ignored") where.status = status;
	if (input.scope === "internal") where.internal = true;
	if (input.scope === "external") where.internal = false;
	const host = input.host?.trim().toLowerCase().replace(/^www\./, "");
	if (host) where.host = host;
	const q = input.q?.trim();
	if (q) {
		// Storage matches prefixes: a URL or path searches URLs, anything else searches domains.
		if (/^(https?:|\/)/i.test(q)) where.url = { startsWith: q };
		else if (!host) where.host = { startsWith: q.toLowerCase().replace(/^www\./, "") };
	}
	const sort = input.sort ?? "status";
	const orderBy: Record<string, "asc" | "desc"> = sort === "url" ? { url: "asc" } : sort === "checked" ? { checkedAt: "desc" } : { rank: "asc" };

	// any: WhereClause is EmDash's.
	const page = await urls(ctx).query({ where: where as any, orderBy, limit: PAGE_SIZE, cursor: input.cursor ?? undefined });
	// any: WhereClause is EmDash's.
	const total = await urls(ctx).count(where as any);
	const usage = await queryIn(
		refs(ctx),
		"urlId",
		page.items.map((r) => r.id),
	);
	const byUrl = new Map<string, RefRow[]>();
	for (const { data } of usage) byUrl.set(data.urlId, [...(byUrl.get(data.urlId) ?? []), data]);

	return {
		items: page.items.map(({ id, data }) => {
			const used = (byUrl.get(id) ?? []).sort((a, b) => a.title.localeCompare(b.title));
			return {
				id,
				...data,
				refs: used.length,
				usedIn: used.map((r) => ({
					collection: r.collection,
					entryId: r.entryId,
					title: r.title,
					status: r.entryStatus,
					kinds: r.kinds,
					anchors: r.anchors,
					count: r.count,
				})),
			};
		}),
		total,
		pageSize: PAGE_SIZE,
		nextCursor: page.hasMore ? (page.cursor ?? null) : null,
		counts: await getCounts(ctx, 60_000),
	};
}

// ── Module ───────────────────────────────────────────────────────

const ids = z.array(z.string().regex(/^[0-9a-f]{24}$/)).min(1).max(500);
const targetUrl = z
	.string()
	.trim()
	.min(1, "Enter the new URL.")
	.max(2048)
	.refine(isAllowedTarget, "Use an http(s) URL, a path starting with a single /, mailto: or tel:. Protocol-relative URLs (//host) aren't allowed.");

export function linksModule() {
	const guard = (ctx: PluginContext, feature = "links") => requireFeature(ctx, feature);

	const routes = {
		"links/list": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(listInput, ctx.input ?? {});
				const features = await ctxFeatures(ctx);
				return {
					...(await list(ctx, input)),
					scan: (await getScan(ctx)) ?? IDLE_SCAN,
					checking: features["links.check"] ?? false,
					siteUrlKnown: Boolean(ctx.site?.url),
					ignores: await getIgnores(ctx),
				};
			},
		})),

		/** Link checking settings (the page's Settings dialog). */
		"links/settings": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await guard(ctx);
				return readLinksSettings(ctx);
			},
		},

		"links/settings/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(linksSettingsInput, ctx.input);
				await ctx.settings.set("linksCheckBudget", input.checkBudget);
				await ctx.settings.set("linksCheckInternal", input.checkInternal);
				await ctx.settings.set("linksUserAgent", input.userAgent);
				if (input.frequency) await ctx.settings.set("linksFrequency", input.frequency);
				ctx.log.info("Link Manager settings saved", { checkBudget: input.checkBudget, checkInternal: input.checkInternal, frequency: input.frequency });
				return readLinksSettings(ctx);
			},
		}),

		"links/summary": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await guard(ctx);
				return { counts: await getCounts(ctx), scan: (await getScan(ctx)) ?? IDLE_SCAN };
			},
		},

		/** Start (with `restart`, or when never scanned) or continue a full scan, one bounded step per call. */
		"links/scan": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const { restart } = parseInput(z.object({ restart: z.boolean().optional() }), ctx.input ?? {});
				if (restart || !(await getScan(ctx))) await startScan(ctx);
				return scanStep(ctx, requestOps());
			},
		}),

		"links/recheck": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx, "links.check");
				const input = parseInput(z.object({ ids: ids.max(50).optional() }), ctx.input ?? {});
				const run = await runChecks(ctx, { ids: input.ids, budget: 45, deadline: Date.now() + REQUEST_MS });
				// Whatever didn't fit is queued for the next scheduled run.
				if (input.ids && run.exhausted) {
					const ops = requestOps();
					const left = await getMany(urls(ctx), input.ids, ops);
					const queued = [...left].filter(([, d]) => !d.checkedAt || Date.now() - Date.parse(d.checkedAt) > REQUEST_MS * 2);
					await putMany(
						urls(ctx),
						queued.map(([id, data]) => ({ id, data: { ...data, nextCheckAt: "" } })),
						ops,
					);
				}
				return run;
			},
		}),

		"links/replace": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(z.object({ ids, to: targetUrl, after: z.string().max(600).nullish() }), ctx.input);
				const found = await getMany(urls(ctx), input.ids);
				const plan = new Map<string, LinkEdit>();
				for (const row of found.values()) if (row.url !== input.to) plan.set(row.url, { type: "replace", to: input.to });
				if (!plan.size) return { ...EMPTY_EDIT };
				const result = await applyEdits(ctx, plan, input.ids, input.after ?? null);
				ctx.log.info("links: replaced", { from: [...plan.keys()].slice(0, 10), to: input.to, entries: result.entries });
				return result;
			},
		}),

		"links/unlink": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(z.object({ ids, after: z.string().max(600).nullish() }), ctx.input);
				const found = await getMany(urls(ctx), input.ids);
				const plan = new Map<string, LinkEdit>([...found.values()].map((row) => [row.url, { type: "unlink" }]));
				const result = await applyEdits(ctx, plan, input.ids, input.after ?? null);
				ctx.log.info("links: unlinked", { urls: [...plan.keys()].slice(0, 10), entries: result.entries });
				return result;
			},
		}),

		"links/ignore": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(
					z.object({
						add: z.array(z.object({ type: z.enum(["domain", "url", "wildcard", "regex"]), value: z.string().max(1024) })).max(100).optional(),
						remove: z.array(z.string().max(64)).max(500).optional(),
					}),
					ctx.input,
				);
				let rules = await getIgnores(ctx);
				if (input.remove?.length) rules = rules.filter((r) => !input.remove?.includes(r.id));
				for (const rule of input.add ?? []) {
					let value: string;
					try {
						value = normalizeIgnore(rule.type, rule.value);
					} catch (error) {
						if (error instanceof IgnoreRuleError) throw PluginRouteError.badRequest(error.message);
						throw error;
					}
					if (rules.some((r) => r.type === rule.type && r.value === value)) continue;
					rules.push({ id: crypto.randomUUID().slice(0, 8), type: rule.type, value } satisfies IgnoreRule);
				}
				if (rules.length > 1000) throw PluginRouteError.badRequest("That's too many ignore rules (1,000 at most).");
				await ctx.kv.set(IGNORES_KEY, rules);
				const changed = await reapplyIgnores(ctx, rules);
				return { ignores: rules, changed };
			},
		}),
	};

	const reindex = async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
		const c = event.content as { id?: string; slug?: string | null; status?: string; data?: Record<string, unknown> };
		if (!c.id || !c.data) return;
		await indexEntry(ctx, event.collection, { id: c.id, slug: c.slug, status: c.status, data: c.data });
		await invalidateCounts(ctx);
	};

	const hooks = {
		"content:afterSave": reindex,
		"content:afterRestore": reindex,
		"content:afterDelete": async (event: { id: string; collection: string }, ctx: PluginContext) => {
			await removeEntry(ctx, event.collection, event.id);
			await invalidateCounts(ctx);
		},
	};

	/**
	 * Scheduled runs. Both tasks run hourly, only while Scheduled link checking
	 * (`links.check`) is on (src/core/compose.ts gates them), so nothing is read
	 * while it's off. Each tick reads one KV row (and, between runs, the frequency); a run starts once the chosen
	 * frequency has passed, scans the content (continuing over the next ticks),
	 * then checks the links that are due until none are left.
	 */
	async function scanTask(ctx: PluginContext) {
		const run = await ctx.kv.get<ScheduledRun>(RUN_KEY);
		if (run?.phase === "check") return;
		if (run?.phase !== "scan") {
			const frequency = await ctx.settings.get<string>("linksFrequency");
			if (!isRunDue(isFrequency(frequency) ? frequency : LINKS_DEFAULTS.frequency, run?.startedAt)) return;
			if (!ctx.site?.url) {
				ctx.log.warn("links: the site URL isn't set (Settings → General or astro.config `site`); scanning waits for it.");
				return;
			}
			await ctx.kv.set(RUN_KEY, { startedAt: new Date().toISOString(), phase: "scan", finishedAt: null } satisfies ScheduledRun);
			if ((await getScan(ctx))?.status !== "running") await startScan(ctx);
		}
		const ops = new Ops(SCAN_OPS, Date.now() + SCAN_MS);
		await fixUnresolved(ctx, ops);
		const state = await scanStep(ctx, ops);
		if (state.status !== "running" && !state.busy) {
			const current = await ctx.kv.get<ScheduledRun>(RUN_KEY);
			if (current) await ctx.kv.set(RUN_KEY, { ...current, phase: "check" } satisfies ScheduledRun);
		}
	}

	async function checkTask(ctx: PluginContext) {
		const current = await ctx.kv.get<ScheduledRun>(RUN_KEY);
		if (current?.phase !== "check") return;
		const run = await runChecks(ctx, { deadline: Date.now() + 10 * 60_000 });
		if (run.checked) ctx.log.info("links: checked", run);
		// Done when everything due fit in this tick; otherwise the next tick continues, but never
		// past the next run's start (a site with many failing links, rechecked daily, would never drain).
		const frequency = await ctx.settings.get<string>("linksFrequency");
		const overdue = isRunDue(isFrequency(frequency) ? frequency : LINKS_DEFAULTS.frequency, current.startedAt);
		if ((!run.exhausted && run.due < 100) || overdue) await ctx.kv.set(RUN_KEY, { ...current, phase: "done", finishedAt: new Date().toISOString() } satisfies ScheduledRun);
	}

	return { routes, hooks, scanTask, checkTask };
}

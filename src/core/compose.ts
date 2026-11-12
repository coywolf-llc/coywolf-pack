/**
 * Combine Coywolf Pack modules into one EmDash plugin definition.
 */
import type { PluginContext } from "emdash";

import { type FeatureMap, cachedCtxFeatures, ctxFeatures, isOn, recordDefaults } from "./features.js";
import type { PackModule, TaskDef } from "./module.js";
import { noteReadFailure } from "./read-failures.js";
import { requestStore } from "./request-memo.js";
import { withOutcome } from "./task-health.js";
import { afterResponse } from "../shared.js";

/**
 * Capability EmDash requires before it registers each hook
 * (emdash/src/plugins/hooks.ts HOOK_REQUIRED_CAPABILITY). A hook without its
 * capability is silently skipped, so the pack declares these automatically.
 */
const HOOK_CAPABILITY: Record<string, string> = {
	"email:beforeSend": "hooks.email-events:register",
	"email:afterSend": "hooks.email-events:register",
	"email:deliver": "hooks.email-transport:register",
	"content:beforeSave": "content:write",
	"content:afterSave": "content:read",
	"content:beforeDelete": "content:read",
	"content:afterDelete": "content:read",
	"content:beforePublish": "hooks.content-policy:register",
	"content:beforeSchedule": "hooks.content-policy:register",
	"content:beforeUnpublish": "hooks.content-policy:register",
	"content:afterPublish": "content:read",
	"content:afterUnpublish": "content:read",
	"content:afterRestore": "content:read",
	"content:afterSchedule": "content:read",
	"content:afterUnschedule": "content:read",
	"media:beforeUpload": "media:write",
	"media:afterUpload": "media:read",
	"comment:beforeCreate": "users:read",
	"comment:moderate": "users:read",
	"comment:afterCreate": "users:read",
	"comment:afterModerate": "users:read",
	"byline:afterSave": "bylines:read",
	"byline:afterDelete": "bylines:read",
	"page:fragments": "hooks.page-fragments:register",
};

/** Capabilities the modules' hooks need. */
export function hookCapabilities(modules: PackModule[]): string[] {
	const caps = new Set<string>();
	for (const module of modules) {
		for (const name of Object.keys(module.hooks ?? {})) {
			const cap = HOOK_CAPABILITY[name];
			if (cap) caps.add(cap);
		}
	}
	return [...caps];
}

/** Hooks whose results are collected from every module. */
const COLLECTING = new Set(["page:metadata", "page:fragments"]);

/**
 * EmDash gives a hook 5 seconds (define-plugin.ts), then renders the page
 * without its part and only logs it. A page hook still running just before
 * that (D1 slow, not failing) has its page kept out of the edge cache, like
 * one whose read failed (src/core/read-failures.ts).
 */
const PAGE_HOOK_DEADLINE_MS = 4_500;
function noteIfLate(run: Handler): Handler {
	return async (event, ctx) => {
		const late = setTimeout(() => noteReadFailure("a page hook near EmDash's timeout"), PAGE_HOOK_DEADLINE_MS);
		try {
			return await run(event, ctx);
		} finally {
			clearTimeout(late);
		}
	};
}
/**
 * Hooks EmDash runs without waiting for them. media:afterUpload is fired and
 * forgotten right before the upload's response goes out (emdash-runtime
 * handleMediaCreate), so the composed hook hands the whole job (the feature
 * check, then each participant) to waitUntil at once, before anything async:
 * awaiting anything first (the other hooks start with a settings read) let the
 * request finish, which dropped the work without a trace. Participants are
 * gated by hookFeature like everywhere else, inside the job.
 */
const BACKGROUND = new Set(["media:afterUpload"]);

/** EmDash's deferred-task tracker for the current request (its request context, found through the pack's request memo). */
function deferredTasks(): { track<T>(promise: Promise<T>): Promise<T> } | undefined {
	const store = requestStore() as { deferredTasks?: { track?: <T>(promise: Promise<T>) => Promise<T> } } | undefined;
	return typeof store?.deferredTasks?.track === "function" ? (store.deferredTasks as { track<T>(promise: Promise<T>): Promise<T> }) : undefined;
}
/** Scheduled jobs can take far longer than EmDash's 5-second hook default (Workers cron allows 15 minutes). */
const CRON_TIMEOUT_MS = 14 * 60_000;
/** plugin:activate schedules every task (one D1 write each); a boot-time failure would disable the plugin. */
const ACTIVATE_TIMEOUT_MS = 60_000;

const mainFeature = (module: PackModule) => module.features[0]?.id ?? module.id;

function hookFeature(module: PackModule, hook: string): string {
	return module.hookFeature?.[hook as keyof typeof module.hookFeature] ?? mainFeature(module);
}

// any: events differ per hook.
type Handler = (event: any, ctx: PluginContext) => Promise<unknown>;

/**
 * content:afterSave per module and entry, one run at a time. With co-editing on (EmDash 1.5+) an open editor saves
 * the entry every 2 to 10 seconds, and each save fires afterSave: a save that arrives while the same module is still
 * handling the same entry doesn't start a second run; that run goes once more when it ends, with the newest event,
 * so the last save is never lost and a burst costs at most two runs. Per isolate (saves of one room land in one).
 */
const afterSaveRuns = new Map<string, { again: boolean; latest: unknown; startedAt: number }>();
/**
 * A run older than this no longer holds later saves back: on Workers a request that's canceled never settles what it
 * started, and its entry must not stop being handled in this isolate (src/core/single-flight.ts has the same rule).
 */
export const AFTER_SAVE_HOLD_MS = 60_000;

export async function coalesced<E>(moduleId: string, event: E, run: (event: E) => Promise<unknown>): Promise<void> {
	const content = (event as { content?: { id?: unknown }; collection?: unknown }).content;
	const collection = (event as { collection?: unknown }).collection;
	const id = content?.id;
	if (typeof id !== "string" || !id || typeof collection !== "string") {
		await run(event);
		return;
	}
	const key = `${moduleId}\u0000${collection}\u0000${id}`;
	const running = afterSaveRuns.get(key);
	if (running && Date.now() - running.startedAt < AFTER_SAVE_HOLD_MS) {
		running.again = true;
		running.latest = event;
		return;
	}
	const state = { again: false, latest: event as unknown, startedAt: Date.now() };
	afterSaveRuns.set(key, state);
	try {
		await run(event);
		while (state.again && afterSaveRuns.get(key) === state) {
			state.again = false;
			await run(state.latest as E);
		}
	} finally {
		// Only its own entry: a stale run that ends late mustn't remove the one that replaced it.
		if (afterSaveRuns.get(key) === state) afterSaveRuns.delete(key);
	}
}

/** Discovery's daily Bing task from 0.35.17, cleaned up by 0.35.18–0.37.x; cancelled if it still fires. */
const LEGACY_BING_TASK = "discovery-bing-drain";

export function composeHooks(modules: PackModule[], extra: { tasks: TaskDef[] }) {
	const names = new Set<string>();
	for (const module of modules) for (const name of Object.keys(module.hooks ?? {})) names.add(name);

	const hooks: Record<string, Handler | { handler: Handler; timeout?: number; priority?: number }> = {};

	for (const name of names) {
		if (name === "cron" || name === "plugin:activate" || name === "plugin:install") continue; // Composed below.
		const participants = modules.filter((m) => m.hooks?.[name as keyof NonNullable<PackModule["hooks"]>]);
		if (BACKGROUND.has(name)) {
			// Priority 0 (EmDash's default is 100, lower runs first): the pipeline runs plugins' handlers one
			// after another, so this registration comes before another plugin's handler can keep EmDash waiting.
			hooks[name] = { priority: 0, handler: (event, ctx) => {
				const job = (async () => {
					try {
						const features = await cachedCtxFeatures(ctx);
						for (const module of participants) {
							if (!isOn(features, hookFeature(module, name))) continue;
							try {
								await module.hooks?.[name as "media:afterUpload"]?.(event, ctx);
							} catch (error) {
								console.error(`coywolf-pack: ${module.id}: ${name} failed`, error);
							}
						}
					} catch (error) {
						console.error(`coywolf-pack: ${name} failed`, error);
					}
				})();
				// Synchronous: nothing has been awaited yet. Tracked as one of EmDash's deferred tasks too (as its
				// own after() does), so a request-scoped database with a close() stays open until the job is done.
				afterResponse(deferredTasks()?.track(job) ?? job);
				return Promise.resolve();
			} };
			continue;
		}
		const run: Handler = async (event, ctx) => {
			const features = await cachedCtxFeatures(ctx);
			if (COLLECTING.has(name)) {
				const out: unknown[] = [];
				for (const module of participants) {
					if (!isOn(features, hookFeature(module, name))) continue;
					try {
						const result = await module.hooks?.[name as "page:metadata"]?.(event, ctx);
						if (Array.isArray(result)) out.push(...result);
						else if (result) out.push(result);
					} catch (error) {
						ctx.log.error(`${module.id}: ${name} failed`, { error: String(error) });
						// The page goes out without this module's part (its schema, its video player…): not into the edge cache.
						noteReadFailure(`${module.id}: ${name}`);
					}
				}
				return out;
			}
			if (name === "content:beforeSave") {
				let content = event.content as Record<string, unknown>;
				let changed = false;
				for (const module of participants) {
					if (!isOn(features, hookFeature(module, name))) continue;
					const result = (await module.hooks?.["content:beforeSave"]?.({ ...event, content }, ctx)) as Record<string, unknown> | undefined;
					if (result) {
						content = result;
						changed = true;
					}
				}
				return changed ? content : undefined;
			}
			for (const module of participants) {
				if (!isOn(features, hookFeature(module, name))) continue;
				const call = (latest: typeof event) =>
					Promise.resolve(module.hooks?.[name as "content:afterSave"]?.(latest, ctx)).catch((error: unknown) => {
						ctx.log.error(`${module.id}: ${name} failed`, { error: String(error) });
					});
				if (name === "content:afterSave") await coalesced(module.id, event, call);
				else await call(event);
			}
			return undefined;
		};
		hooks[name] = COLLECTING.has(name) ? noteIfLate(run) : run;
	}

	const tasks = [...extra.tasks, ...modules.flatMap((m) => (m.tasks ?? []).map((t) => ({ ...t, feature: t.feature ?? mainFeature(m) })))];

	// EmDash 1.2.0 runs install → activate once at boot for a config plugin with no _plugin_state row, and a
	// hook that fails (its 5-second default timeout included) disables the plugin until an admin re-enables
	// it. Scheduling a dozen tasks is a dozen D1 writes: give it room.
	//
	// plugin:install runs only then, on a site that has never had the pack (or lost EmDash's record of it):
	// a site with nothing of the pack's stored yet takes the 0.36.0 defaults (Redirect Manager, Slug changes
	// and Backups off); anything else is recorded as an existing site (src/core/features.ts recordDefaults).
	hooks["plugin:install"] = {
		timeout: ACTIVATE_TIMEOUT_MS,
		// Never throws, like plugin:activate. Unrecorded, the switches keep the pre-0.36.0 defaults (on).
		handler: async (_event, ctx) => {
			try {
				await recordDefaults(ctx, { fresh: true });
			} catch (error) {
				ctx.log.error("plugin:install: recording the feature defaults failed; they're recorded when the Features page opens", { error: String(error) });
			}
		},
	};

	hooks["plugin:activate"] = {
		timeout: ACTIVATE_TIMEOUT_MS,
		// Never throws: EmDash leaves a plugin whose activation fails turned off, and a brief D1 error here
		// shouldn't switch off the whole pack. Each step is logged; tasks are scheduled again whenever the
		// Features page loads (features/list), and module steps run again on the next activation.
		handler: async (event, ctx) => {
			try {
				await ensureTasks(ctx, tasks, await ctxFeatures(ctx).catch(() => null));
			} catch (error) {
				ctx.log.error("plugin:activate: scheduling tasks failed; they're scheduled again when the Features page opens", { error: String(error) });
			}
			try {
				// After plugin:install on a new site this finds the defaults recorded; on an existing one it records them.
				await recordDefaults(ctx);
			} catch (error) {
				ctx.log.error("plugin:activate: recording the feature defaults failed; they're recorded when the Features page opens", { error: String(error) });
			}
			for (const module of modules) {
				try {
					await module.hooks?.["plugin:activate"]?.(event, ctx);
				} catch (error) {
					ctx.log.error(`${module.id}: plugin:activate failed`, { error: String(error) });
				}
			}
		},
	};

	hooks.cron = {
		timeout: CRON_TIMEOUT_MS,
		handler: async (event: { name: string }, ctx) => {
			const task = tasks.find((t) => t.name === event.name);
			if (!task) {
				// A task an earlier version scheduled: its module cleans up and cancels it.
				const retired = modules.find((m) => m.retiredTasks?.[event.name])?.retiredTasks?.[event.name];
				if (retired) await retired(ctx);
				// Discovery's Bing task (0.35.17) on a site that skipped the releases that cleaned it up: it only goes.
				else if (event.name === LEGACY_BING_TASK) await ctx.cron?.cancel(event.name).catch(() => undefined);
				return;
			}
			const features: FeatureMap = await ctxFeatures(ctx);
			if (task.feature && !isOn(features, task.feature)) {
				// Off: a task that runs only while on stops firing until the switch is turned on again (features/save schedules it).
				if (task.onlyWhileOn) await ctx.cron?.cancel(task.name).catch(() => undefined);
				return;
			}
			if (task.recordOutcome) await withOutcome(ctx.kv, task.name, () => task.handler(ctx));
			else await task.handler(ctx);
		},
	};

	return { hooks, tasks };
}

/**
 * Config-registered native plugins don't get plugin:activate at boot, so
 * routes call this too. schedule() is an upsert. A task marked `onlyWhileOn`
 * is scheduled only while its feature is on and cancelled while it's off,
 * when `features` is known (unknown: scheduled, and its handler stays gated).
 */
export async function ensureTasks(
	ctx: {
		cron?: { schedule(name: string, opts: { schedule: string }): Promise<void>; cancel?(name: string): Promise<void> };
		log?: { error(msg: string, data?: unknown): void };
	},
	tasks: TaskDef[],
	features?: FeatureMap | null,
): Promise<Array<{ task: string; scheduling: boolean; error: string }>> {
	// One bad task must not break the routes that call this (e.g. the Features page): failures are logged and returned.
	const failures: Array<{ task: string; scheduling: boolean; error: string }> = [];
	for (const task of tasks) {
		const cancel = Boolean(task.onlyWhileOn && features && task.feature && !isOn(features, task.feature));
		try {
			if (cancel) await ctx.cron?.cancel?.(task.name);
			else await ctx.cron?.schedule(task.name, { schedule: task.schedule });
		} catch (error) {
			ctx.log?.error(`coywolf-pack: could not ${cancel ? "cancel" : "schedule"} task ${task.name}`, { error: String(error) });
			failures.push({ task: task.name, scheduling: !cancel, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return failures;
}

/** EmDash's task-name rule (emdash/src/plugins/cron.ts validateTaskName). */
export const TASK_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

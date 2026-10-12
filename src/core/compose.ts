/**
 * Combine Coywolf Pack modules into one EmDash plugin definition.
 */
import type { PluginContext } from "emdash";

import { type FeatureMap, cachedCtxFeatures, ctxFeatures, isOn } from "./features.js";
import type { PackModule, TaskDef } from "./module.js";
import { requestStore } from "./request-memo.js";
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

// biome-ignore lint/suspicious/noExplicitAny: events differ per hook.
type Handler = (event: any, ctx: PluginContext) => Promise<unknown>;

export function composeHooks(modules: PackModule[], extra: { tasks: TaskDef[] }) {
	const names = new Set<string>();
	for (const module of modules) for (const name of Object.keys(module.hooks ?? {})) names.add(name);

	const hooks: Record<string, Handler | { handler: Handler; timeout?: number; priority?: number }> = {};

	for (const name of names) {
		if (name === "cron" || name === "plugin:activate") continue; // Composed below.
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
		hooks[name] = async (event, ctx) => {
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
				try {
					await module.hooks?.[name as "content:afterSave"]?.(event, ctx);
				} catch (error) {
					ctx.log.error(`${module.id}: ${name} failed`, { error: String(error) });
				}
			}
			return undefined;
		};
	}

	const tasks = [...extra.tasks, ...modules.flatMap((m) => (m.tasks ?? []).map((t) => ({ ...t, feature: t.feature ?? mainFeature(m) })))];

	// EmDash 1.2.0 runs install → activate once at boot for a config plugin with no _plugin_state row, and a
	// hook that fails (its 5-second default timeout included) disables the plugin until an admin re-enables
	// it. Scheduling a dozen tasks is a dozen D1 writes: give it room.
	hooks["plugin:activate"] = {
		timeout: ACTIVATE_TIMEOUT_MS,
		handler: async (event, ctx) => {
			await ensureTasks(ctx, tasks);
			for (const module of modules) await module.hooks?.["plugin:activate"]?.(event, ctx);
		},
	};

	hooks.cron = {
		timeout: CRON_TIMEOUT_MS,
		handler: async (event: { name: string }, ctx) => {
			const task = tasks.find((t) => t.name === event.name);
			if (!task) return;
			const features: FeatureMap = await ctxFeatures(ctx);
			if (task.feature && !isOn(features, task.feature)) return;
			await task.handler(ctx);
		},
	};

	return { hooks, tasks };
}

/**
 * Config-registered native plugins don't get plugin:activate at boot, so
 * routes call this too. schedule() is an upsert.
 */
export async function ensureTasks(
	ctx: { cron?: { schedule(name: string, opts: { schedule: string }): Promise<void> }; log?: { error(msg: string, data?: unknown): void } },
	tasks: TaskDef[],
) {
	// One bad task must not break the routes that call this (e.g. the Features page).
	for (const task of tasks) {
		try {
			await ctx.cron?.schedule(task.name, { schedule: task.schedule });
		} catch (error) {
			ctx.log?.error(`coywolf-pack: could not schedule task ${task.name}`, { error: String(error) });
		}
	}
}

/** EmDash's task-name rule (emdash/src/plugins/cron.ts validateTaskName). */
export const TASK_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

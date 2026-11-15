/**
 * Buttondown Drafts: when a post in a chosen category is published, the Pack
 * makes one Buttondown email draft from it. You review and send it in
 * Buttondown: the Pack never sends, schedules or publishes an email. With the
 * Updates part on, publishing the post again updates the draft while it's
 * still an untouched draft; unpublishing or trashing the post deletes the
 * draft only while it's untouched. See docs/buttondown.md.
 *
 * The API key is the plugin's fifth Settings-page secret (buttondownApiKey,
 * src/core/secrets.ts). The module's page only ever learns whether one is saved.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { contextFetch } from "../core/cloudflare-api.js";
import { COLLECTION_SLUG } from "../core/content-url.js";
import { ctxFeatures, isOn, registerFeatures, rememberSiteSetting, requireFeature } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { readOnlyRoute } from "../core/routes.js";
import { parseInput } from "../shared.js";
import { siteHost } from "./body.js";
import { createButtondownClient } from "./client.js";
import { BUTTONDOWN_FEATURES as F, BUTTONDOWN_HOST, BUTTONDOWN_SETTINGS_KEY, BUTTONDOWN_TASK } from "./keys.js";
import { loadSettings, normalizeSettings, ruleFor, settingsInput, stampRules } from "./settings.js";
import { BUTTONDOWN_STORAGE_CONFIG, recentRecords, recordView, records } from "./store.js";
import { type ManualAction, type SyncDeps, defaultDeps, handleEvent, manualRefusal, matchesRule, readKey, retryDue, runManual } from "./sync.js";
import { type EventKind, readRecord, recordId } from "./sync-core.js";

export interface ButtondownOptions {
	/** D1 binding of the site database (the entry's terms, File Downloads' files). Default "DB". */
	database?: string;
}

export const BUTTONDOWN_FEATURE_DEFS = [
	{
		id: F.main,
		label: "Buttondown Drafts",
		description: "Create a Buttondown email draft when a post in a chosen category is published. Never sends: you review and send it in Buttondown.",
		default: false,
	},
	{
		id: F.updates,
		label: "Update drafts",
		description: "Update the draft when the post is published again, while it's still an untouched draft in Buttondown.",
		default: false,
	},
];
registerFeatures(BUTTONDOWN_FEATURE_DEFS);

const entryInput = z.object({ collection: z.string().regex(COLLECTION_SLUG), id: z.string().min(1).max(128) });
const actionInput = entryInput.extend({ action: z.enum(["create", "refresh"]) });

interface TermOption {
	slug: string;
	label: string;
	depth: number;
}

/**
 * The collections with their taxonomies and terms, for the rule pickers (EmDash's own reads). `taxonomiesFailed`:
 * EmDash's taxonomies couldn't be read, so every collection shows none (the page says so).
 */
async function pickerData(ctx: PluginContext): Promise<{ collections: Array<{ slug: string; label: string; taxonomies: Array<{ name: string; label: string; hierarchical: boolean; terms: TermOption[] }> }>; taxonomiesFailed: boolean }> {
	const collections = ((await ctx.schema?.listCollections().catch(() => [])) ?? []).filter((c) => c.routable !== false);
	let defs: Array<{ name: string; label: string; hierarchical: boolean; collections: string[] }> = [];
	const terms = new Map<string, TermOption[]>();
	let taxonomiesFailed = false;
	try {
		const emdash = await import("emdash");
		defs = (await emdash.getTaxonomyDefs()).map((d) => ({ name: d.name, label: d.label, hierarchical: d.hierarchical, collections: d.collections }));
		type Node = { slug: string; label: string; children?: Node[] };
		for (const def of defs) {
			if (!collections.some((c) => def.collections.includes(c.slug))) continue;
			const out: TermOption[] = [];
			const walk = (nodes: Node[], depth: number) => {
				for (const n of nodes) {
					if (out.length >= 500 || depth > 8) return;
					out.push({ slug: n.slug, label: n.label || n.slug, depth });
					if (n.children?.length) walk(n.children, depth + 1);
				}
			};
			walk((await emdash.getTaxonomyTerms(def.name, { includeCounts: false }).catch(() => [])) as Node[], 0);
			terms.set(def.name, out);
		}
	} catch (error) {
		ctx.log.warn("buttondown: couldn't read the taxonomies for the rule pickers", { error: error instanceof Error ? error.name : "error" });
		defs = [];
		taxonomiesFailed = true;
	}
	return {
		taxonomiesFailed,
		collections: collections.map((c) => ({
			slug: c.slug,
			label: c.label,
			taxonomies: defs.filter((d) => d.collections.includes(c.slug)).map((d) => ({ name: d.name, label: d.label, hierarchical: d.hierarchical, terms: terms.get(d.name) ?? [] })),
		})),
	};
}

export function buttondownPack(options: ButtondownOptions = {}): PackModule {
	const database = options.database ?? "DB";
	const deps: SyncDeps = defaultDeps(database);

	const on = (kind: EventKind) => async (event: { id?: unknown; collection?: unknown; content?: Record<string, unknown>; permanent?: unknown }, ctx: PluginContext) => handleEvent(ctx, deps, kind, event);

	const status = async (ctx: PluginContext) => {
		const [settings, key, features, recent, pickers] = await Promise.all([loadSettings(ctx), readKey(ctx), ctxFeatures(ctx), recentRecords(ctx, 20), pickerData(ctx)]);
		return {
			settings,
			keySaved: Boolean(key.key),
			keyUnreadable: key.unreadable,
			updatesOn: isOn(features, F.updates),
			siteHost: siteHost(ctx.site.url),
			collections: pickers.collections,
			taxonomiesFailed: pickers.taxonomiesFailed,
			recent: recent.map(recordView),
		};
	};

	const manual = async (ctx: PluginContext, action: ManualAction, collection: string, id: string) => {
		const record = readRecord(await records(ctx).get(recordId(collection, id)));
		const refusal = await manualRefusal(ctx, deps, action, collection, id, record);
		if (refusal) throw PluginRouteError.badRequest(refusal);
		const after = await runManual(ctx, deps, action, collection, id);
		return { record: after ? recordView(after) : null };
	};

	const routes = {
		/** Settings, whether a key is saved (never the key), the pickers' lists and the last 20 records. */
		"buttondown/status": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					return status(ctx);
				},
			}),
		),

		// The routes below change only this module's own settings and records, which no page shows: read-only for the page cache.

		/** The rules and the footer link. A new or changed rule is stamped with the time it was saved (since). */
		"buttondown/settings/save": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const input = parseInput(settingsInput, ctx.input);
					const previous = await loadSettings(ctx);
					let rules;
					try {
						rules = stampRules(input.rules, previous.rules);
					} catch (error) {
						throw PluginRouteError.badRequest(error instanceof Error ? error.message : "Check the rules.");
					}
					const settings = normalizeSettings({ rules, footerLink: input.footerLink });
					await ctx.settings.set(BUTTONDOWN_SETTINGS_KEY, settings);
					// This isolate's hooks use the new rules at once; other isolates within five minutes.
					rememberSiteSetting(BUTTONDOWN_SETTINGS_KEY, settings);
					return { settings };
				},
			}),
		),

		/** Which areas the saved key reaches, by status code only (the answers' bodies are never read). */
		"buttondown/key/check": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const { key, unreadable } = await readKey(ctx);
					if (!key) return { keySaved: false, keyUnreadable: unreadable, check: null };
					const check = await createButtondownClient({ key, fetch: contextFetch(ctx) }).checkKey();
					return { keySaved: true, keyUnreadable: false, check, tooBroad: check.newsletters === 200 || check.subscribers === 200 };
				},
			}),
		),

		/** The entry editor panel: the entry's record and what can be done with it. */
		"buttondown/entry": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const { collection, id } = parseInput(entryInput, ctx.input);
					const settings = await loadSettings(ctx);
					const rule = ruleFor(settings, collection);
					if (!rule) return { covered: false };
					const [record, item, key] = await Promise.all([records(ctx).get(recordId(collection, id)).then(readRecord), ctx.content?.get(collection, id).catch(() => null), readKey(ctx)]);
					const published = (item as { status?: string } | null)?.status === "published";
					const matches = published ? await matchesRule(ctx, deps, rule, collection, id).catch(() => false) : false;
					const state = record?.state ?? null;
					return {
						covered: true,
						published,
						matches,
						keySaved: Boolean(key.key),
						record: record ? recordView(record) : null,
						canCreate: published && matches && (!record || state === "gone" || state === "stopped" || state === "removed" || (state === "error" && !record.emailId)),
						canRefresh: published && matches && (state === "draft" || state === "edited"),
						canRetry: state === "error",
					};
				},
			}),
		),

		/** Create draft now, or Refresh draft from post (overwrites changes made in Buttondown; still only a draft). */
		"buttondown/sync": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const { collection, id, action } = parseInput(actionInput, ctx.input);
					return manual(ctx, action, collection, id);
				},
			}),
		),

		/** Try a failed record again now. */
		"buttondown/retry": readOnlyRoute(
			definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F.main);
					const { collection, id } = parseInput(entryInput, ctx.input);
					return manual(ctx, "retry", collection, id);
				},
			}),
		),
	};

	return {
		id: F.main,
		label: "Buttondown Drafts",
		features: BUTTONDOWN_FEATURE_DEFS,
		routes,
		hooks: {
			"content:afterPublish": on("publish"),
			// A live edit (a collection without revisions) or a live-metadata save; draft saves do nothing.
			"content:afterSave": on("save"),
			"content:afterUnpublish": on("unpublish"),
			"content:afterDelete": async (event: { id?: unknown; collection?: unknown; permanent?: unknown }, ctx: PluginContext) => handleEvent(ctx, deps, event.permanent === true ? "delete" : "trash", event),
			"content:afterRestore": on("restore"),
		},
		tasks: [
			{
				name: BUTTONDOWN_TASK,
				schedule: "@hourly",
				// Scheduled only while Buttondown Drafts is on. With nothing to retry: four indexed queries an hour.
				onlyWhileOn: true,
				handler: async (ctx: PluginContext) => {
					const result = await retryDue(ctx, deps);
					if (result.retried || result.pruned) ctx.log.info("buttondown: hourly run", result);
				},
			},
		],
		adminPages: [{ path: "/buttondown", label: "Buttondown Drafts", icon: "envelope-simple" }],
		storage: BUTTONDOWN_STORAGE_CONFIG,
		capabilities: ["content:read", "schema:read", "network:request"],
		allowedHosts: [BUTTONDOWN_HOST],
	};
}

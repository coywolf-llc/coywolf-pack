/**
 * Redirects module: the admin side of Coywolf redirects (rules are served by
 * the middleware in ./middleware.ts).
 */
import { type PluginContext, PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { parseInput, workerEnv } from "../shared.js";
import { VERSION } from "../version.js";
import { invalidateRedirectCache } from "./middleware.js";
import { readOnlyRoute } from "../core/routes.js";
import {
	REDIRECT_TYPES,
	RedirectValidationError,
	compile,
	deleteRule,
	listRules,
	match,
	canonicalizeSources,
	saveRule,
	validate,
} from "./rules.js";

export interface RedirectsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
}

const ruleInput = z.object({
	id: z.string().optional(),
	source: z.string().max(2000),
	target: z.string().max(2000).optional(),
	type: z.number().int().optional(),
	isRegex: z.boolean().optional(),
	enabled: z.boolean().optional(),
	note: z.string().max(500).nullish(),
});

/** The pack version whose spelling rewrite ran (KV), so the Redirect Manager page runs it once per update. */
const CANONICAL_MARKER = "state:redirects:canonicalVersion";

/**
 * Exact sources saved in another spelling before 0.38.0 get their key (src/redirects/paths.ts), once per pack
 * version, when the Redirect Manager page lists the rules (EmDash runs plugin:activate only at first install).
 */
async function canonicalizeOnce(ctx: PluginContext, database: D1Database): Promise<void> {
	try {
		if ((await ctx.kv.get<string>(CANONICAL_MARKER)) === VERSION) return;
		const rewritten = await canonicalizeSources(database);
		if (rewritten) {
			invalidateRedirectCache();
			ctx.log.info("Redirects: rewrote exact sources to one spelling", { rewritten });
		}
		await ctx.kv.set(CANONICAL_MARKER, VERSION);
	} catch (error) {
		ctx.log.warn("Redirects: couldn't rewrite exact sources to one spelling; tried again next time", { error: String(error).slice(0, 200) });
	}
}

export function redirectsModule(options: RedirectsOptions) {
	async function db() {
		const env = await workerEnv();
		const database = env[options.database ?? "DB"] as D1Database | undefined;
		if (!database) throw PluginRouteError.badRequest("Redirects: missing database binding.");
		return database;
	}

	/** Turn rule validation errors into readable 400s. */
	async function guarded<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			if (error instanceof RedirectValidationError) throw PluginRouteError.badRequest(error.message);
			throw error;
		}
	}

	const routes = {
		"redirects/list": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				const database = await db();
				await canonicalizeOnce(ctx, database);
				return { items: await listRules(database), types: REDIRECT_TYPES };
			},
		},

		"redirects/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(ruleInput, ctx.input);
				const rule = await guarded(() => db().then((d) => saveRule(d, input)));
				invalidateRedirectCache();
				ctx.log.info("Redirect saved", { source: rule.source, target: rule.target });
				return rule;
			},
		}),

		"redirects/delete": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const { id } = parseInput(z.object({ id: z.string() }), ctx.input);
				const deleted = await deleteRule(await db(), id);
				invalidateRedirectCache();
				return { deleted };
			},
		}),

		/** Add or update many rules (matched by source). Every rule is validated before any is saved. */
		"redirects/import": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json", maxBytes: 2 * 1024 * 1024 },
			handler: async (ctx) => {
				const { rules } = parseInput(z.object({ rules: z.array(ruleInput.omit({ id: true })).max(5000) }), ctx.input);
				const errors: string[] = [];
				// Patterns already saved as they are (an export imported again) skip the speed check, as editing them does.
				const database = await db();
				const saved = new Set((await listRules(database)).filter((r) => r.isRegex).map((r) => r.source));
				rules.forEach((rule, i) => {
					try {
						validate(rule, { unchangedPattern: rule.isRegex === true && saved.has(rule.source.trim()) });
					} catch (error) {
						errors.push(`Row ${i + 1} (${rule.source}): ${(error as Error).message}`);
					}
				});
				if (errors.length) throw PluginRouteError.badRequest(errors.slice(0, 10).join("\n"));
				for (const rule of rules) await saveRule(database, rule);
				invalidateRedirectCache();
				ctx.log.info("Redirects imported", { count: rules.length });
				return { imported: rules.length };
			},
		}),

		/** Which rule (if any) a URL would hit. */
		"redirects/test": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const { url } = parseInput(z.object({ url: z.string().min(1).max(2000) }), ctx.input);
				const parsed = new URL(url, "https://example.invalid");
				const found = match(compile(await listRules(await db())), parsed.pathname, parsed.search);
				return found ? { matched: true, rule: found.rule, location: found.location } : { matched: false };
			},
		})),
	};

	return { routes };
}

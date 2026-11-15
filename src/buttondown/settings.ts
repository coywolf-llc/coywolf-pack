/**
 * Buttondown Drafts' settings: when to make a draft (one rule per collection:
 * a taxonomy and its terms, and the time the rule was saved) and the footer
 * link. One plain setting, edited on the module's page, read with the feature
 * switches (no query of its own when an unrelated entry is published).
 */
import type { PluginContext } from "emdash";
import { z } from "zod";

import { COLLECTION_SLUG } from "../core/content-url.js";
import { readSiteSetting, registerSiteSetting } from "../core/features.js";
import { BUTTONDOWN_LIMITS, BUTTONDOWN_SETTINGS_KEY } from "./keys.js";

registerSiteSetting(BUTTONDOWN_SETTINGS_KEY);

export const TAXONOMY_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const TERM_SLUG = /^[A-Za-z0-9_.-]{1,200}$/;

export interface ButtondownRule {
	collection: string;
	taxonomy: string;
	/** Term slugs. Entries with one of them, or a child term of one, match. */
	terms: string[];
	/** ISO time the rule was saved: only entries first published since then get a draft on their own. */
	since: string;
}

export interface ButtondownSettings {
	rules: ButtondownRule[];
	/** "Read it on <site>" at the bottom of each email. */
	footerLink: boolean;
}

export const BUTTONDOWN_DEFAULTS: ButtondownSettings = { rules: [], footerLink: true };

const validTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Stored settings, cleaned: bad rules dropped, one rule per collection, defaults filled in. */
export function normalizeSettings(raw: unknown): ButtondownSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as { rules?: unknown; footerLink?: unknown };
	const rules: ButtondownRule[] = [];
	for (const rule of Array.isArray(r.rules) ? r.rules : []) {
		if (!rule || typeof rule !== "object") continue;
		const { collection, taxonomy, terms, since } = rule as Record<string, unknown>;
		if (typeof collection !== "string" || !COLLECTION_SLUG.test(collection) || rules.some((x) => x.collection === collection)) continue;
		if (typeof taxonomy !== "string" || !TAXONOMY_NAME.test(taxonomy) || !validTime(since)) continue;
		const slugs = [...new Set(Array.isArray(terms) ? terms.filter((t): t is string => typeof t === "string" && TERM_SLUG.test(t)) : [])].slice(0, BUTTONDOWN_LIMITS.terms);
		if (!slugs.length) continue;
		rules.push({ collection, taxonomy, terms: slugs, since: new Date(since).toISOString() });
		if (rules.length >= BUTTONDOWN_LIMITS.rules) break;
	}
	return { rules, footerLink: r.footerLink !== false };
}

/** The page's save: rules without `since` (the server stamps it). */
export const settingsInput = z.object({
	rules: z
		.array(
			z.object({
				collection: z.string().regex(COLLECTION_SLUG, "Choose a collection."),
				taxonomy: z.string().regex(TAXONOMY_NAME, "Choose a taxonomy."),
				terms: z.array(z.string().regex(TERM_SLUG)).min(1, "Choose at least one term for each rule.").max(BUTTONDOWN_LIMITS.terms),
			}),
		)
		.max(BUTTONDOWN_LIMITS.rules),
	footerLink: z.boolean(),
});

const sameTerms = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * The rules to store: a rule that's the same as before (collection, taxonomy and terms) keeps its `since`; a new or
 * changed one is stamped `now`, so entries published before it never get a draft on their own (decision D8).
 * Entries that already have a draft keep theirs either way.
 */
export function stampRules(input: Array<Omit<ButtondownRule, "since">>, previous: ButtondownRule[], now = new Date()): ButtondownRule[] {
	const out: ButtondownRule[] = [];
	for (const rule of input) {
		if (out.some((r) => r.collection === rule.collection)) throw new Error(`Only one rule per collection (${rule.collection}).`);
		const terms = [...new Set(rule.terms)];
		const before = previous.find((p) => p.collection === rule.collection && p.taxonomy === rule.taxonomy && sameTerms(p.terms, terms));
		out.push({ collection: rule.collection, taxonomy: rule.taxonomy, terms, since: before?.since ?? now.toISOString() });
	}
	return out;
}

export function ruleFor(settings: ButtondownSettings, collection: string): ButtondownRule | null {
	return settings.rules.find((r) => r.collection === collection) ?? null;
}

/**
 * Through the plugin context (routes, the page). `strict`: reject when the setting can't be read, for the hooks and
 * the job, where "no rules" would mean "stop watching this post".
 */
export async function loadSettings(ctx: Pick<PluginContext, "settings">, strict = false): Promise<ButtondownSettings> {
	return normalizeSettings(strict ? await ctx.settings.get(BUTTONDOWN_SETTINGS_KEY) : await ctx.settings.get(BUTTONDOWN_SETTINGS_KEY).catch(() => null));
}

let memo: { raw: unknown; settings: ButtondownSettings } | null = null;

/**
 * In the publish hooks: from the feature switches' read and per-isolate cache (no query of its own most of the time),
 * else through the plugin context when D1 can't be read here (tests, Node). `strict`: reject when neither read
 * works, instead of answering with no rules.
 */
export async function cachedSettings(ctx: Pick<PluginContext, "settings">, database = "DB", strict = false): Promise<ButtondownSettings> {
	const read = await readSiteSetting(BUTTONDOWN_SETTINGS_KEY, database).catch(() => null);
	if (!read) return loadSettings(ctx, strict);
	if (memo && memo.raw === read.value) return memo.settings;
	memo = { raw: read.value, settings: normalizeSettings(read.value) };
	return memo.settings;
}

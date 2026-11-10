/**
 * Speculation Rules: the `<script type="speculationrules">` the pack adds to
 * the head of every public page (developer.chrome.com/docs/web-platform/
 * prerender-pages). Browsers that support it (Chrome, Edge and other
 * Chromium browsers) fetch a same-site page as soon as a visitor is about to
 * open it, so the next page shows almost at once; others ignore it.
 *
 * Cloudflare's Speed Brain does the same from the zone, but "will not
 * prefetch on routes that run Workers" (developers.cloudflare.com/speed/
 * optimization/content/speed-brain/), which is every page of an EmDash site
 * on Workers. Prefetched pages come from the edge cache like any visit.
 *
 * Kept free of EmDash imports so tests can load it directly.
 */
import { z } from "zod";

/** The plugin setting (read with the feature switches, so a page costs no query of its own). */
export const SPECULATION_SETTING = "speculationRules";

/** When a link is fetched: on press (conservative), on hover or press (moderate), or as soon as it's seen (eager). */
export const EAGERNESS = ["conservative", "moderate", "eager"] as const;
export type Eagerness = (typeof EAGERNESS)[number];
/** Prerendering, when on, runs the page too (scripts included): never eager. */
export const PRERENDER = ["off", "conservative", "moderate"] as const;

/**
 * A path the site adds to the exclusions: a URL pattern path such as
 * `/visit/*` (`*` matches anything, `/` included). Only plain path
 * characters and `*`, so a typo can't make the browser reject the whole
 * rule set (URL pattern groups, named parts and modifiers aren't accepted).
 */
const EXCLUDE_PATTERN = /^\/(?:[A-Za-z0-9\-._~/*]|%[0-9A-Fa-f]{2})*$/;

export const speculationSettingsSchema = z.object({
	eagerness: z.enum(EAGERNESS).default("moderate"),
	prerender: z.enum(PRERENDER).default("off"),
	exclude: z
		.array(
			z
				.string()
				.trim()
				.max(200, "Keep each excluded path under 200 characters.")
				.regex(EXCLUDE_PATTERN, "Excluded paths start with / and use letters, numbers, - . _ ~ / and * only (for example /visit/*)."),
		)
		.max(50, "At most 50 excluded paths.")
		.default([]),
});

export type SpeculationSettings = z.infer<typeof speculationSettingsSchema>;

export const SPECULATION_DEFAULTS: SpeculationSettings = speculationSettingsSchema.parse({});

/** The stored settings, or the defaults when there are none or they don't parse. */
export function parseSpeculationSettings(raw: unknown): SpeculationSettings {
	const parsed = speculationSettingsSchema.safeParse(raw ?? {});
	return parsed.success ? parsed.data : SPECULATION_DEFAULTS;
}

/** Never fetched ahead: EmDash's admin, API and previews, and Astro's own assets. */
export const ALWAYS_EXCLUDED = ["/_emdash", "/_emdash/*", "/_astro/*"];
/** Any URL with a query string: search results, previews, filters, tracking links. */
export const QUERY_EXCLUDED = "/*\\?(.+)";
/** Files a link may point at directly: fetching them on hover would download them for nothing. */
export const FILE_EXTENSIONS = ["pdf", "zip", "gz", "dmg", "exe", "csv", "json", "xml", "rss", "txt", "md", "jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "mp3", "mp4", "m4a", "mov", "webm"];
/** Links never fetched ahead: nofollow and sponsored (affiliate) links, downloads, and anything marked .no-prefetch. */
export const SKIPPED_LINKS = 'a[rel~="nofollow"], a[rel~="sponsored"], a[download], .no-prefetch, .no-prefetch a';
/** Links fetched ahead but never prerendered (the class the hand-copied theme rules used). */
export const NOT_PRERENDERED = ".no-prerender, .no-prerender a";

export interface SpeculationContext {
	/** File Downloads' URL base when that module is on (`download` → `/download/*` is excluded). */
	downloadBase?: string | null;
}

/**
 * The file-link pattern: `/*.(pdf|zip|…)`, each extension in either case
 * (`[pP][dD][fF]`: URL patterns in speculation rules take no flags).
 */
export const FILE_PATTERN = `/*.(${FILE_EXTENSIONS.map((ext) => [...ext].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join("")).join("|")})`;

/** The URL paths never fetched ahead, in order: the built-in ones, then the site's. */
export function excludedPaths(settings: SpeculationSettings, context: SpeculationContext = {}): string[] {
	const paths = [...ALWAYS_EXCLUDED, QUERY_EXCLUDED, FILE_PATTERN];
	if (context.downloadBase) paths.push(`/${context.downloadBase}/*`);
	for (const path of settings.exclude) if (!paths.includes(path)) paths.push(path);
	return paths;
}

interface Rule {
	source: "document";
	where: { and: unknown[] };
	eagerness: string;
}

/** The rule set (the script's JSON), for these settings. */
export function speculationRules(settings: SpeculationSettings, context: SpeculationContext = {}): { prefetch: Rule[]; prerender?: Rule[] } {
	const base = [{ href_matches: "/*" }, { not: { href_matches: excludedPaths(settings, context) } }, { not: { selector_matches: SKIPPED_LINKS } }];
	const rules: { prefetch: Rule[]; prerender?: Rule[] } = { prefetch: [{ source: "document", where: { and: base }, eagerness: settings.eagerness }] };
	if (settings.prerender !== "off") {
		rules.prerender = [{ source: "document", where: { and: [...base, { not: { selector_matches: NOT_PRERENDERED } }] }, eagerness: settings.prerender }];
	}
	return rules;
}

/** The `<script type="speculationrules">` element for the page head. `<` is escaped, so nothing in it can end the script early. */
export function speculationScript(settings: SpeculationSettings, context: SpeculationContext = {}): string {
	const json = JSON.stringify(speculationRules(settings, context)).replaceAll("<", "\\u003c");
	return `<script type="speculationrules">${json}</script>`;
}

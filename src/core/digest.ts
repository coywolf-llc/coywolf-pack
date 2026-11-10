/**
 * What other modules add to Alerts' weekly digest email: a small interface,
 * so the digest can include numbers it doesn't compute itself (Insights:
 * traffic, Web Vitals, search terms) without depending on those modules.
 *
 * A module registers a source when it loads (module scope, like
 * registerFeatures):
 *
 * ```ts
 * registerDigestSource({
 *   id: "insights.traffic",
 *   feature: "insights.traffic",
 *   read: async (ctx) => {
 *     const stored = await ctx.kv.get<TrafficSummary>("cache:insights:traffic");
 *     if (!stored) return null;
 *     return { title: "Traffic", lines: [`${stored.visits.toLocaleString("en-US")} visits in the last 7 days`], page: "/insights" };
 *   },
 * });
 * ```
 *
 * `read` should use what the module already stored (no network calls): the
 * digest gives each source 5 seconds, leaves out a source whose feature is
 * off, that returns null, throws or runs out of time, and sends the rest.
 *
 * Kept free of EmDash imports so tests can load it directly.
 */

export interface DigestSection {
	/** The section's heading ("Traffic"). */
	title: string;
	/** Plain-text lines, each a short sentence or fact (no HTML). */
	lines: string[];
	/** A pack admin page with more ("/insights"), linked from the email. */
	page?: string;
}

/** The parts of the plugin context a source may use. */
// any: the plugin context, kept loose so this file has no EmDash import.
export type DigestContext = any;

export interface DigestSource {
	/** Unique id, e.g. "insights.traffic". */
	id: string;
	/** The feature switch that must be on for the source to be read. */
	feature: string;
	read(ctx: DigestContext): Promise<DigestSection | null>;
}

const sources = new Map<string, DigestSource>();

/** Add a source to the weekly digest (a later registration with the same id replaces it). */
export function registerDigestSource(source: DigestSource): void {
	sources.set(source.id, source);
}

export function digestSources(): DigestSource[] {
	return [...sources.values()];
}

/** How long one source may take. */
export const DIGEST_SOURCE_MS = 5_000;

/** Clean a section a source returned: text only, a sane size, or null when there's nothing in it. */
export function cleanSection(section: unknown): DigestSection | null {
	if (!section || typeof section !== "object") return null;
	const s = section as Partial<DigestSection>;
	const title = typeof s.title === "string" ? s.title.trim().slice(0, 80) : "";
	const lines = Array.isArray(s.lines) ? s.lines.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim().slice(0, 300)).slice(0, 12) : [];
	if (!title || !lines.length) return null;
	const page = typeof s.page === "string" && /^\/[a-z0-9-/]*$/.test(s.page) ? s.page : undefined;
	return { title, lines, ...(page ? { page } : {}) };
}

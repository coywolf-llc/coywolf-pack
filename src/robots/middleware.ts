/**
 * Serves /robots.txt from the saved rules (through the pack middleware), so
 * turning the feature off falls straight back to EmDash's own robots.txt
 * (the saved rules stay for next time).
 *
 * Turning the feature on takes over seamlessly: if nothing is saved yet, the
 * first request (or the first admin page load, whichever comes first) turns
 * the robots.txt EmDash was serving into equivalent rules and saves them
 * with an insert-if-absent, so concurrent first requests can't import twice.
 */
import { PLUGIN_ID, siteFeatures } from "../core/features.js";
import { noteReadFailure } from "../core/read-failures.js";
import { emdashRobots, importRobots } from "./importer.js";
import { type RobotsConfig, automaticFrom, generate, normalizeConfig } from "./rules.js";

export const CONFIG_SETTING = "robots.config";
export const CONFIG_OPTION = `plugin:${PLUGIN_ID}:settings:${CONFIG_SETTING}`;
const TTL_MS = 60_000;

let cache: { config: RobotsConfig | null; siteUrl: string | null; at: number } | null = null;
let importing: Promise<RobotsConfig | null> | null = null;

/** Drop the cached rules so the next request reloads them (called after saving). */
export function invalidateRobotsCache(): void {
	cache = null;
}

async function readOption<T>(db: D1Database, name: string): Promise<T | null> {
	const row = await db.prepare("SELECT value FROM options WHERE name = ?").bind(name).first<{ value: string }>();
	return row?.value ? (JSON.parse(row.value) as T) : null;
}

/**
 * EmDash's custom robots.txt (SEO settings), or null when it serves its
 * default. Throws when the setting can't be read, so a transient database
 * error never makes the takeover import EmDash's default file instead.
 */
export async function readEmdashCustomRobots(db: D1Database): Promise<string | null> {
	const seo = await readOption<{ robotsTxt?: string }>(db, "site:seo");
	return seo?.robotsTxt?.trim() ? seo.robotsTxt : null;
}

/** Site origin the way EmDash's robots.txt computes it: the Site URL setting, else the request origin. */
export function siteOrigin(settingUrl: string | null | undefined, requestUrl: URL): string {
	return (settingUrl?.trim() || requestUrl.origin).replace(/\/+$/, "");
}

/** Insert the config only if no row exists yet; returns whatever is stored afterwards. */
async function insertIfAbsent(db: D1Database, config: RobotsConfig): Promise<RobotsConfig> {
	const value = JSON.stringify(config);
	try {
		await db.prepare("INSERT INTO options (name, value, revision) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING").bind(CONFIG_OPTION, value, crypto.randomUUID()).run();
	} catch {
		// Databases from before EmDash's revision column.
		await db.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").bind(CONFIG_OPTION, value).run();
	}
	const stored = await readOption<Partial<RobotsConfig>>(db, CONFIG_OPTION);
	return stored ? normalizeConfig(stored) : config;
}

/** Import EmDash's robots.txt once (per isolate, and atomically in D1). */
async function importOnce(db: D1Database, siteUrl: string): Promise<RobotsConfig | null> {
	if (!importing) {
		importing = (async () => {
			let custom: string | null;
			try {
				custom = await readEmdashCustomRobots(db);
			} catch (error) {
				// Can't tell what EmDash serves: keep serving EmDash's file and try again on a later request.
				console.error("coywolf robots: could not read EmDash's robots.txt; not importing yet", error);
				noteReadFailure("robots.txt import");
				return null;
			}
			const { config } = importRobots(emdashRobots(custom, siteUrl), siteUrl);
			try {
				return await insertIfAbsent(db, config);
			} catch (error) {
				console.error("coywolf robots: could not save the imported rules", error);
				noteReadFailure("robots.txt import");
				return null;
			}
		})().finally(() => {
			importing = null;
		});
	}
	return importing;
}

export async function serveRobots(url: URL, method: string, env: Record<string, unknown>, database = "DB"): Promise<Response | undefined> {
	if (url.pathname !== "/robots.txt" || (method !== "GET" && method !== "HEAD")) return undefined;
	const db = env[database] as D1Database | undefined;
	if (!db) return undefined;

	if (!cache || Date.now() - cache.at > TTL_MS) {
		try {
			// Both rows in one query. The rules can be large and are only needed here, so they
			// stay out of the feature switches' per-request read (core/features.ts).
			const { results } = await db
				.prepare("SELECT name, value FROM options WHERE name IN (?, ?)")
				.bind(CONFIG_OPTION, "site:url")
				.all<{ name: string; value: string }>();
			const parse = (name: string): unknown => {
				const value = results.find((r) => r.name === name)?.value;
				if (!value) return null;
				try {
					return JSON.parse(value);
				} catch (error) {
					// An unreadable Site URL falls back to the request origin; unreadable rules fail the load.
					if (name === CONFIG_OPTION) throw error;
					return null;
				}
			};
			const stored = parse(CONFIG_OPTION) as Partial<RobotsConfig> | null;
			const siteUrl = parse("site:url");
			const site = typeof siteUrl === "string" ? siteUrl : null;
			const config = stored ? normalizeConfig(stored) : await importOnce(db, siteOrigin(site, url));
			// Import deferred (it failed, and said so): EmDash's robots.txt is served, and nothing is cached, here or at the edge.
			if (!config) return undefined;
			cache = { config, siteUrl: site, at: Date.now() };
		} catch (error) {
			console.error("coywolf robots: could not load rules", error);
			// EmDash's own robots.txt answers instead: keep it out of the edge cache.
			noteReadFailure("robots.txt rules");
			return undefined;
		}
	}
	if (!cache.config) return undefined;

	// Discovery and Videos add lines (llms.txt/Markdown allowances, their sitemaps) while their features are on.
	const automatic = automaticFrom(await siteFeatures(database).catch(() => ({})));
	const body = generate({ ...cache.config, automatic }, { siteUrl: siteOrigin(cache.siteUrl, url) });
	return new Response(method === "HEAD" ? null : body, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
			"X-Robots-Tag": "noindex",
		},
	});
}

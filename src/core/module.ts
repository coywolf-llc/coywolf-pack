/**
 * The shape every Coywolf Pack module implements. src/index.ts composes the
 * modules into one EmDash plugin: routes are merged, hooks run in module
 * order (skipping modules whose feature is off), and admin pages, widgets,
 * Portable Text blocks and storage collections are concatenated.
 */
import type { MiddlewareHandler } from "astro";
import type { PluginContext, PluginHooks } from "emdash";

/** A switch on the Features page. */
export interface FeatureDef {
	/** Stable key, e.g. "codeBlocks" or "schema.breadcrumbs". Stored in the "features" setting. */
	id: string;
	label: string;
	description: string;
	/** Default when the site hasn't chosen. Keep new features off so installing changes nothing. */
	default?: boolean;
	/**
	 * Legacy ids this feature took over (e.g. a sub-feature that became its own
	 * module). When the stored map has no value for `id`, the first legacy id
	 * found there decides, so existing sites keep their choice.
	 */
	replaces?: string[];
}

export interface AdminPageDef {
	path: string;
	label: string;
	icon?: string;
	/** Admin sidebar folder (EmDash 1.2.0+). The pack puts every page in the "Coywolf Pack" folder (see sidebar() in src/index.ts). */
	group?: string;
}

export interface WidgetDef {
	id: string;
	title: string;
	size: "full" | "half" | "third";
	/** Listed on the dashboard only while this returns true (read on every admin manifest request; must be synchronous). */
	when?: () => boolean;
}

/** A scheduled job. `schedule` is cron syntax or @hourly/@daily/@weekly. */
export interface TaskDef {
	name: string;
	schedule: string;
	/** Feature that must be on for the task to run (defaults to the module's main feature; "" runs it always, for a module without switches). */
	feature?: string;
	handler: (ctx: PluginContext) => Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: hook handler signatures vary per hook name.
type AnyHandler = (event: any, ctx: PluginContext) => Promise<unknown> | unknown;

export interface PackModule {
	/** Module id; also the main feature id unless `features` says otherwise. */
	id: string;
	label: string;
	/** Feature switches. The first one is the module's main switch; the rest are sub-features. */
	features: FeatureDef[];
	/** Plugin routes, served at /_emdash/api/plugins/coywolf-pack/<name>. Prefix names with the module id. */
	// biome-ignore lint/suspicious/noExplicitAny: route definitions are opaque here.
	routes?: Record<string, any>;
	/**
	 * Hook handlers. Return values follow EmDash: content:beforeSave may return
	 * modified content (passed to the next module); page:metadata and
	 * page:fragments return contributions (concatenated).
	 * Each handler runs only when `hookFeature` (or the main feature) is on.
	 */
	hooks?: Partial<Record<keyof PluginHooks, AnyHandler>>;
	/** Feature gating a hook, when it isn't the main feature. Keyed by hook name. */
	hookFeature?: Partial<Record<keyof PluginHooks, string>>;
	tasks?: TaskDef[];
	/**
	 * Tasks an earlier version scheduled and this one no longer has, by name. EmDash keeps firing a
	 * scheduled task until it's cancelled, so when one fires its handler runs (whatever the switches say)
	 * to clean up after the removed feature, and cancels the task (ctx.cron.cancel).
	 */
	retiredTasks?: Record<string, (ctx: PluginContext) => Promise<void>>;
	adminPages?: AdminPageDef[];
	widgets?: WidgetDef[];
	/**
	 * Secret settings (API keys and tokens) only, prefixed with the module id;
	 * other fields are dropped. Prefer adding secrets to src/core/secrets.ts.
	 * Non-secret settings aren't declared: edit them on the module's own admin
	 * page (ctx.settings.get/set) and give every read its default in code.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: SettingField shape is EmDash's.
	settingsSchema?: Record<string, any>;
	/** Portable Text block types this module adds to the editor (render components live in src/astro). */
	// biome-ignore lint/suspicious/noExplicitAny: PortableTextBlockConfig shape is EmDash's.
	portableTextBlocks?: any[];
	/** Plugin storage collections ({ name: { indexes, uniqueIndexes } }). */
	// biome-ignore lint/suspicious/noExplicitAny: storage config shape is EmDash's.
	storage?: Record<string, any>;
	/** Capabilities this module needs (e.g. "network:request", "email:send"). */
	capabilities?: string[];
	/** Hosts for network:request, if any. */
	allowedHosts?: string[];
}

/**
 * Site-level middleware a module contributes (see src/middleware.ts). Runs
 * only when `feature` is on. Return a Response to answer the request, or
 * undefined to pass it on.
 */
export interface PackMiddleware {
	module: string;
	feature: string;
	/** Sets its own edge caching (context.cache) on the responses it returns; others' are never edge-cached. */
	ownsCache?: boolean;
	handle: (context: Parameters<MiddlewareHandler>[0], env: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void) => Promise<Response | undefined> | Response | undefined;
}

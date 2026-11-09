/**
 * Coywolf Pack for EmDash: one native plugin with Coywolf's features for
 * EmDash sites on Cloudflare. Register it in astro.config.mjs:
 *
 * ```js
 * import { coywolfPlugin } from "@coywolf/emdash";
 * emdash({ plugins: [coywolfPlugin({ backups: { name: "mysite" } })] });
 * ```
 *
 * and add `coywolfPack()` from "@coywolf/emdash/middleware" to the site's
 * middleware. Every feature can be turned on or off under Plugins → Coywolf Pack.
 */
import type { PluginCapability, PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

import { composeHooks, hookCapabilities } from "./core/compose.js";
import { configureContentUrls } from "./core/content-url.js";
import { PLUGIN_ID, isOn, knownFeatures } from "./core/features.js";
import { featuresRoutes } from "./core/features-module.js";
import type { AdminPageDef, PackModule, WidgetDef } from "./core/module.js";
import { readOnlyRouteNames } from "./core/routes.js";
import { secretSettingsSchema } from "./core/secrets.js";
import { MODULES } from "./modules.js";
import type { CoywolfOptions } from "./options.js";
import { registerReadOnlyRoutes } from "./pageCache/lib.js";
import { VERSION } from "./version.js";

export type { BackupsOptions } from "./backups/module.js";
export type { RedirectsOptions } from "./redirects/module.js";
export type { VideosOptions } from "./videos/module.js";
export type { RobotsOptions } from "./robots/module.js";
export type { CoywolfOptions } from "./options.js";
export type { PrivateFormUploadsOptions } from "./formUploads/pack.js";
export { privateFormUploads } from "./formUploads/pack.js";
export type { ContentUrlOptions, TrailingSlash } from "./core/content-url.js";

const PACKAGE = "@coywolf/emdash";

/** The admin sidebar folder holding every pack page (EmDash 1.2.0+ keeps the pages' order inside it). */
const SIDEBAR_GROUP = "Coywolf Pack";
/** First in the folder (its icon is the folder's). Labeled "Features", not "Coywolf Pack": the folder already says that. */
const FEATURES_PAGE = { path: "/features", label: "Features", icon: "toggle-right" };
/** Always on (not a feature), listed right below Coywolf Pack. */
const PERFORMANCE_PAGE = { path: "/performance", label: "Performance", icon: "lightning" };
/** Module pages listed right after Performance (when their feature is on), ahead of the rest. */
const AFTER_PERFORMANCE = ["/images"];

function sidebar(modules: PackModule[]): AdminPageDef[] {
	const pages = modules.flatMap((m) => m.adminPages ?? []);
	const early = AFTER_PERFORMANCE.flatMap((path) => pages.filter((p) => p.path === path));
	return [FEATURES_PAGE, PERFORMANCE_PAGE, ...early, ...pages.filter((p) => !early.includes(p))].map((p) => ({ ...p, group: SIDEBAR_GROUP }));
}

function buildModules(options: CoywolfOptions): PackModule[] {
	// Module-level, like the search rate limit: createPlugin() runs when the Worker isolate
	// starts (virtual:emdash/plugins), so middleware and Astro components see it too.
	configureContentUrls({ urls: options.urls, trailingSlash: options.trailingSlash, termParents: options.termParents, pageParents: options.pageParents });
	return MODULES.map((factory) => factory(options)).filter((m): m is PackModule => m !== null);
}

/** A widget as EmDash lists it (without the pack's `when`). */
const widgetEntry = ({ when: _when, ...widget }: WidgetDef) => widget;

function surfaces(modules: PackModule[]) {
	return {
		pages: sidebar(modules),
		widgets: modules.flatMap((m) => m.widgets ?? []).map(widgetEntry),
		blocks: modules.flatMap((m) => m.portableTextBlocks ?? []),
		settingsSchema: secretSettingsSchema(modules.map((m) => m.settingsSchema)),
		storage: Object.assign({}, ...modules.map((m) => m.storage ?? {})),
		capabilities: [...new Set([...modules.flatMap((m) => m.capabilities ?? []), ...hookCapabilities(modules)])] as PluginCapability[],
		allowedHosts: [...new Set(modules.flatMap((m) => m.allowedHosts ?? []))],
	};
}

/** `displayName` and `description` arrived in EmDash's descriptor after 1.4; declared here until its types have them. */
type Descriptor = PluginDescriptor<CoywolfOptions> & { displayName?: string; description?: string };

export function coywolfPlugin(options: CoywolfOptions = {}): PluginDescriptor<CoywolfOptions> {
	const s = surfaces(buildModules(options));
	const descriptor: Descriptor = {
		id: PLUGIN_ID,
		// Shown in EmDash's Plugins list (EmDash 1.5+; earlier versions ignore them).
		displayName: "Coywolf Pack",
		description: "Enhances EmDash's features and adds ones it doesn't have: performance, backups, redirects, schema, discovery, robots.txt and more.",
		version: VERSION,
		format: "native",
		entrypoint: PACKAGE,
		adminEntry: `${PACKAGE}/admin`,
		componentsEntry: `${PACKAGE}/astro`,
		options,
		adminPages: s.pages,
		adminWidgets: s.widgets,
		portableTextBlocks: s.blocks,
		...(s.capabilities.length ? { capabilities: s.capabilities } : {}),
	};
	return descriptor;
}

/**
 * The admin definition, with `pages` and `widgets` computed on read: EmDash
 * builds the admin manifest (sidebar, dashboard) from them on every admin
 * request, so a module whose main feature is off drops out of the sidebar.
 * The Features and Performance pages always stay. Before the switches have been read in this
 * isolate, everything is listed.
 */
function liveAdmin<T extends object>(modules: PackModule[], base: T) {
	const on = (module: PackModule) => {
		// A module without switches (Performance) is always on.
		if (!module.features.length) return true;
		const features = knownFeatures();
		return !features || isOn(features, module.features[0]?.id ?? module.id);
	};
	return Object.defineProperties(base, {
		pages: {
			enumerable: true,
			get: () => sidebar(modules.filter(on)),
		},
		widgets: {
			enumerable: true,
			get: () =>
				modules
					.filter(on)
					.flatMap((m) => m.widgets ?? [])
					.filter((w) => !w.when || w.when())
					.map(widgetEntry),
		},
	}) as T & { pages: PackModule["adminPages"]; widgets: PackModule["widgets"] };
}

export function createPlugin(options: CoywolfOptions = {}) {
	const modules = buildModules(options);
	const s = surfaces(modules);
	const { hooks, tasks } = composeHooks(modules, { tasks: [] });
	const routes: Record<string, unknown> = Object.assign({}, featuresRoutes(modules, tasks), ...modules.map((m) => m.routes ?? {}));
	// Routes that only read (readOnlyRoute): the page cache middleware leaves the cache and the settings generation alone after them.
	registerReadOnlyRoutes(readOnlyRouteNames(routes));

	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		...(s.capabilities.length ? { capabilities: s.capabilities } : {}),
		...(s.allowedHosts.length ? { allowedHosts: s.allowedHosts } : {}),
		storage: s.storage,
		admin: liveAdmin(modules, {
			entry: `${PACKAGE}/admin`,
			settingsSchema: s.settingsSchema,
			...(s.blocks.length ? { portableTextBlocks: s.blocks } : {}),
		}),
		// biome-ignore lint/suspicious/noExplicitAny: composed handlers match EmDash's hook types at runtime.
		hooks: hooks as any,
		routes: routes as Parameters<typeof definePlugin>[0]["routes"],
	});
}

export default createPlugin;

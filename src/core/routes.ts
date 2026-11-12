/**
 * Route classification the page cache reads (src/pageCache/lib.ts).
 *
 * Every successful POST to a pack route that isn't public is taken for an
 * admin save: the page cache is cleared, a new settings generation is
 * recorded (every isolate drops what it derived from settings, and the cache
 * is cleared once more when they have), and warming starts again. A route
 * that only reads (a preview, a picker's list, a connection test) must not do
 * that, so it's declared here, where the route is defined:
 *
 * ```ts
 * routes["schema/preview"] = readOnlyRoute(definePluginRoute({ … }));
 * ```
 *
 * createPlugin() registers the names of the marked routes with the page cache
 * (registerReadOnlyRoutes) when it composes the plugin, before EmDash routes
 * any plugin request to it (src/core/ready.ts). An unmarked route keeps the safe
 * default: it clears the cache. src/pageCache/lib.test.mjs lists the marked
 * routes, so adding one is a deliberate change.
 */

const READ_ONLY = new WeakSet<object>();

/**
 * Mark a route as read-only: it changes nothing a page or a cache shows (it
 * reads, previews or tests; a cache of its own, such as a video library
 * listing, doesn't count). Returns the route unchanged.
 */
export function readOnlyRoute<T extends object>(route: T): T {
	READ_ONLY.add(route);
	return route;
}

export const isReadOnlyRoute = (route: unknown): boolean => typeof route === "object" && route !== null && READ_ONLY.has(route);

/** The names of the read-only routes among a plugin's routes. */
export function readOnlyRouteNames(routes: Record<string, unknown>): string[] {
	return Object.entries(routes)
		.filter(([, route]) => isReadOnlyRoute(route))
		.map(([name]) => name);
}

/**
 * EmDash's admin router, for the pack's pages: in-admin links that don't
 * reload the app, and the unsaved-changes guard on in-app navigation.
 *
 * EmDash's admin is a TanStack Router app, but it doesn't export the router
 * or useBlocker to plugins, and an import of @tanstack/react-router from the
 * pack could resolve to a second copy with its own React context. TanStack's
 * Router sets itself on `window.__TSR_ROUTER__` when it's created in a
 * browser (router-core's Router constructor), so the pack takes it from there
 * and checks it's the admin's (its basepath). Without it, links fall back to
 * plain page loads and the guard to the browser's own prompt on reload or
 * close. test/emdash-contract.test.mjs checks both assumptions.
 *
 * Kept free of JSX so tests can load it directly.
 */

/** EmDash's admin, where every admin path starts. */
export const ADMIN_BASE = "/_emdash/admin";

/** A location as TanStack's history passes it to a blocker. */
export interface HistoryLocationLike {
	pathname: string;
	search?: string;
	hash?: string;
	href?: string;
}

export type HistoryAction = "PUSH" | "REPLACE" | "FORWARD" | "BACK" | "GO";

export interface BlockerArgs {
	currentLocation: HistoryLocationLike;
	nextLocation: HistoryLocationLike;
	action: HistoryAction;
}

/** The part of TanStack Router the pack uses. */
export interface AdminRouter {
	history: {
		/** True from blockerFn blocks the navigation. Returns the unblock function. */
		block(blocker: { blockerFn: (args: BlockerArgs) => boolean | Promise<boolean>; enableBeforeUnload?: boolean | (() => boolean) }): () => void;
	};
	navigate(options: { to: string }): unknown;
	options?: { basepath?: string };
}

/** The admin's router, or null when it isn't there (outside the admin, or an admin that no longer uses TanStack Router). */
export function adminRouter(scope: { __TSR_ROUTER__?: unknown } = globalThis as { __TSR_ROUTER__?: unknown }): AdminRouter | null {
	const router = scope.__TSR_ROUTER__ as Partial<AdminRouter> | undefined;
	if (!router || typeof router.navigate !== "function" || typeof router.history?.block !== "function") return null;
	// Some other TanStack Router on the page isn't the admin's.
	const basepath = router.options?.basepath;
	if (basepath !== undefined && basepath.replace(/\/+$/, "") !== ADMIN_BASE) return null;
	return router as AdminRouter;
}

/** The full URL path of an admin path ("/plugins/coywolf-pack/features" → "/_emdash/admin/plugins/coywolf-pack/features"). */
export function adminHref(to: string): string {
	return `${ADMIN_BASE}${to.startsWith("/") ? to : `/${to}`}`;
}

/** The admin path of a pack page ("/features" → "/plugins/coywolf-pack/features"). */
export function packPagePath(page: string): string {
	return `/plugins/coywolf-pack${page.startsWith("/") ? page : `/${page}`}`;
}

/**
 * Go to an admin path inside the app (no reload) when the router is there;
 * otherwise load it. Blockers (unsaved changes) still apply.
 */
export function goTo(to: string, scope?: { __TSR_ROUTER__?: unknown; location?: { assign(url: string): void } }): void {
	const router = adminRouter(scope);
	if (router) {
		void router.navigate({ to });
		return;
	}
	(scope?.location ?? globalThis.location)?.assign(adminHref(to));
}

/** A click the browser should handle itself (new tab or window, download, a modifier or another button). */
export function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

/**
 * While registered, asks before an in-app navigation leaves the current page
 * (a different path; changing only the query or hash doesn't count). `ask`
 * resolves true to leave. Several guards on one page ask once: the first
 * answer to "Leave" lets the same navigation through the others.
 * Returns the function that removes the guard.
 */
export function guardNavigation(router: AdminRouter, ask: (next: HistoryLocationLike) => Promise<boolean>): () => void {
	return router.history.block({
		// The pack keeps its own beforeunload listener (it works without the router too).
		enableBeforeUnload: false,
		blockerFn: async ({ currentLocation, nextLocation }) => {
			if (currentLocation.pathname === nextLocation.pathname) return false;
			const key = targetKey(nextLocation);
			if (leaving === key) return false;
			const leave = await ask(nextLocation);
			if (!leave) return true;
			leaving = key;
			// Cleared once this navigation's blockers have all run (they run one after another, awaited).
			setTimeout(() => {
				if (leaving === key) leaving = null;
			}, 0);
			return false;
		},
	});
}

/** The navigation a "Leave" answer applies to. */
let leaving: string | null = null;
const targetKey = (location: HistoryLocationLike) => location.href ?? `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`;

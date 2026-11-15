/**
 * When the pack's entry editor panels and content-list column show.
 *
 * EmDash 1.4 picks a plugin's panels and columns with a synchronous
 * `collections` predicate, re-run whenever the admin's manifest changes (its
 * memo depends on manifest.plugins). The manifest lists the pack's admin
 * pages for the modules that are on (src/index.ts liveAdmin), so a panel
 * shows exactly while its module's page is in the sidebar: turning the module
 * off on the Features page refreshes the manifest, and the panel goes with
 * the page. The predicate reads that same manifest from the admin's React
 * Query client, which EmDash's createAdminRouter puts on the router's
 * context (test/emdash-contract.test.mjs checks both).
 *
 * When the router or the manifest can't be read, nothing shows: a panel for a
 * module that's off would only show an error.
 *
 * Kept free of JSX so tests can load it directly.
 */
import { adminRouter } from "./router.js";

const PACK_ID = "coywolf-pack";

interface ManifestLike {
	plugins?: Record<string, { enabled?: boolean; adminPages?: Array<{ path?: string }> } | undefined>;
	collections?: Record<string, { fields?: Record<string, { kind?: string } | undefined> } | undefined>;
}

/** The admin's manifest, from its React Query cache (["manifest"]), or null. */
export function adminManifest(scope?: { __TSR_ROUTER__?: unknown }): ManifestLike | null {
	const client = adminRouter(scope)?.options?.context?.queryClient;
	if (typeof client?.getQueryData !== "function") return null;
	const manifest = client.getQueryData(["manifest"]);
	return manifest && typeof manifest === "object" ? (manifest as ManifestLike) : null;
}

/**
 * Refetch the admin's manifest (the sidebar, the dashboard widgets, these
 * panels) in place, through the admin's own React Query client. EmDash's
 * admin keeps its own copy of React Query, so the pack's useQueryClient()
 * can't reach that client on a site. The page stays mounted and keeps its
 * scroll position (the admin shows its loading screen only before the first
 * manifest: test/emdash-contract.test.mjs). False when the client isn't there.
 */
export function refreshAdminManifest(scope?: { __TSR_ROUTER__?: unknown }): boolean {
	const client = adminRouter(scope)?.options?.context?.queryClient;
	if (typeof client?.invalidateQueries !== "function") return false;
	void Promise.resolve(client.invalidateQueries({ queryKey: ["manifest"] })).catch(() => undefined);
	return true;
}

/** Whether the pack's page `page` ("/schema") is in the admin's sidebar right now: its module is on. */
export function packPageOn(page: string, scope?: { __TSR_ROUTER__?: unknown }): boolean {
	const plugin = adminManifest(scope)?.plugins?.[PACK_ID];
	if (!plugin || plugin.enabled === false || !Array.isArray(plugin.adminPages)) return false;
	return plugin.adminPages.some((p) => p?.path === page);
}

/** Whether a collection has a reference field `field` in the admin's manifest (Child Pages: parent_page). */
export function collectionHasField(collection: string, field: string, scope?: { __TSR_ROUTER__?: unknown }): boolean {
	return adminManifest(scope)?.collections?.[collection]?.fields?.[field]?.kind === "reference";
}

/** The field a panel or column needs on the collection, besides its module's page in the sidebar. */
export const NEEDS_FIELD: Readonly<Record<string, string>> = { childPages: "parent_page", parent: "parent_page" };

/** Whether a panel or column shows for a collection: its module is on and the collection has the field it needs. */
export function extensionShows(id: string, page: string, collection: string, scope?: { __TSR_ROUTER__?: unknown }): boolean {
	if (!packPageOn(page, scope)) return false;
	const field = NEEDS_FIELD[id];
	return !field || collectionHasField(collection, field, scope);
}

/** EmDash's admin role for plugins:manage, which the pack's routes need: the panels and the column show to admins only. */
export const ADMIN_ROLE = 50;

/**
 * The entry editor panels: each shows while `page` is in the sidebar. Lower
 * `order` first among plugin panels (EmDash's own sections come before).
 * The components are in editor-panels.tsx.
 */
export const EDITOR_PANELS = [
	{ id: "childPages", title: "Child pages", page: "/child-pages", minRole: ADMIN_ROLE, order: 49 },
	{ id: "schema", title: "Schema & Social", page: "/schema", minRole: ADMIN_ROLE, order: 50 },
	{ id: "ai", title: "AI suggestions", page: "/ai", minRole: ADMIN_ROLE, order: 51 },
	{ id: "links", title: "Link status", page: "/links", minRole: ADMIN_ROLE, order: 52 },
] as const;

/**
 * The content-list columns: each listed entry's parent page (Child Pages, in collections with the
 * Parent page field), and its broken and blocked links (Link Manager).
 */
export const LIST_COLUMNS = [
	{ id: "parent", label: "Parent", page: "/child-pages", minRole: ADMIN_ROLE, order: 49, align: "start" },
	{ id: "links", label: "Links", page: "/links", minRole: ADMIN_ROLE, order: 50, align: "end" },
] as const;

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
}

/** The admin's manifest, from its React Query cache (["manifest"]), or null. */
export function adminManifest(scope?: { __TSR_ROUTER__?: unknown }): ManifestLike | null {
	const client = adminRouter(scope)?.options?.context?.queryClient;
	if (typeof client?.getQueryData !== "function") return null;
	const manifest = client.getQueryData(["manifest"]);
	return manifest && typeof manifest === "object" ? (manifest as ManifestLike) : null;
}

/** Whether the pack's page `page` ("/schema") is in the admin's sidebar right now: its module is on. */
export function packPageOn(page: string, scope?: { __TSR_ROUTER__?: unknown }): boolean {
	const plugin = adminManifest(scope)?.plugins?.[PACK_ID];
	if (!plugin || plugin.enabled === false || !Array.isArray(plugin.adminPages)) return false;
	return plugin.adminPages.some((p) => p?.path === page);
}

/** EmDash's admin role for plugins:manage, which the pack's routes need: the panels and the column show to admins only. */
export const ADMIN_ROLE = 50;

/**
 * The entry editor panels: each shows while `page` is in the sidebar. Lower
 * `order` first among plugin panels (EmDash's own sections come before).
 * The components are in editor-panels.tsx.
 */
export const EDITOR_PANELS = [
	{ id: "schema", title: "Schema & Social", page: "/schema", minRole: ADMIN_ROLE, order: 50 },
	{ id: "ai", title: "AI suggestions", page: "/ai", minRole: ADMIN_ROLE, order: 51 },
	{ id: "links", title: "Link status", page: "/links", minRole: ADMIN_ROLE, order: 52 },
] as const;

/** The content-list column: each listed entry's broken and blocked links (Link Manager). */
export const LIST_COLUMNS = [{ id: "links", label: "Links", page: "/links", minRole: ADMIN_ROLE, order: 50, align: "end" }] as const;

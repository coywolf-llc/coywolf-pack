/**
 * Refreshing EmDash's admin manifest (the sidebar and the dashboard widgets)
 * from a pack page, in place: the Features page after a module is switched,
 * the update card after Dismiss.
 *
 * EmDash's admin brings its own React Query, so on a site the pack's
 * useQueryClient() can be another copy with no client. The admin's own
 * client, on the router's context (refreshAdminManifest), comes first; the
 * pack's is used only when it's there (the same copy).
 *
 * Kept free of JSX so tests can load it directly.
 */
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { refreshAdminManifest } from "./extensions.js";

/** The pack's React Query client: the admin's only when both use the same copy (null if not). */
function usePackQueryClient() {
	try {
		return useQueryClient();
	} catch {
		return null;
	}
}

/** Returns `refresh()`: true when the manifest is being refetched in place, false when it can't be (reload instead). */
export function useManifestRefresh(scope?: { __TSR_ROUTER__?: unknown }): () => boolean {
	const packClient = usePackQueryClient();
	return React.useCallback(() => {
		if (refreshAdminManifest(scope)) return true;
		if (!packClient) return false;
		void Promise.resolve(packClient.invalidateQueries({ queryKey: ["manifest"] })).catch(() => undefined);
		return true;
	}, [packClient, scope]);
}

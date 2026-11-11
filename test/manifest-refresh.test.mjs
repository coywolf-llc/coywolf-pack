// Run: node --test test/manifest-refresh.test.mjs
//
// Refreshing EmDash's admin manifest from a pack page (src/admin/manifest.ts useManifestRefresh), used by the
// Features page and the update card's Dismiss (src/admin/update-notice.tsx). On a site the admin's React Query is
// another copy than the pack's, so the pack's useQueryClient() finds no client: the admin's own client, on the
// router's context, must still be reached. Rendered with React in happy-dom.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import "./ts-resolve.mjs";

let window;
before(async () => {
	const { Window } = await import("happy-dom");
	window = new Window({ url: "https://example.com/_emdash/admin/" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => {
	await window?.happyDOM.close();
});

const { useManifestRefresh } = await import("../src/admin/manifest.ts");

/** The admin's router with its own React Query client on its context (EmDash's createAdminRouter). */
function adminRouter() {
	const calls = [];
	const queryClient = { getQueryData: () => undefined, invalidateQueries: (filters) => (calls.push(filters), Promise.resolve()) };
	return { calls, scope: { __TSR_ROUTER__: { navigate() {}, history: { block: () => () => {} }, options: { basepath: "/_emdash/admin", context: { queryClient } } } } };
}

/** Renders a component that calls the hook, optionally inside the pack's own QueryClientProvider; returns refresh(). */
async function refreshIn({ scope, packClient } = {}) {
	const React = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { QueryClientProvider } = await import("@tanstack/react-query");
	const h = React.createElement;
	let refresh;
	function Probe() {
		refresh = useManifestRefresh(scope);
		return null;
	}
	const container = window.document.createElement("div");
	const root = createRoot(container);
	await React.act(async () => root.render(packClient ? h(QueryClientProvider, { client: packClient }, h(Probe)) : h(Probe)));
	return { refresh, unmount: () => React.act(async () => root.unmount()) };
}

test("two copies of React Query (no client in the pack's): the admin's own client, from the router's context, is refreshed", async () => {
	const admin = adminRouter();
	const r = await refreshIn({ scope: admin.scope });
	try {
		assert.equal(r.refresh(), true);
		assert.deepEqual(admin.calls, [{ queryKey: ["manifest"] }]);
	} finally {
		await r.unmount();
	}
});

test("the same copy (the pack's client is the admin's) and no router: through the pack's client", async () => {
	const { QueryClient } = await import("@tanstack/react-query");
	const packClient = new QueryClient();
	const invalidated = [];
	packClient.invalidateQueries = async (filters) => void invalidated.push(filters);
	const r = await refreshIn({ scope: {}, packClient });
	try {
		assert.equal(r.refresh(), true);
		assert.deepEqual(invalidated, [{ queryKey: ["manifest"] }]);
	} finally {
		await r.unmount();
	}
});

test("neither client: false, so the caller reloads instead", async () => {
	const r = await refreshIn({ scope: {} });
	try {
		assert.equal(r.refresh(), false);
	} finally {
		await r.unmount();
	}
});

test("update-notice.tsx: Dismiss refreshes the dashboard in place through the shared hook, and reloads only when it can't", () => {
	const src = readFileSync(new URL("../src/admin/update-notice.tsx", import.meta.url), "utf8");
	// The old way: the pack's own useQueryClient(), which finds no client when the admin has its own copy, so the card stayed.
	assert.doesNotMatch(src, /useQueryClient|@tanstack\/react-query/);
	assert.match(src, /import \{ useManifestRefresh \} from "\.\/manifest\.js";/);
	assert.match(src, /const refreshManifest = useManifestRefresh\(\);/);
	assert.match(src, /if \(!refreshManifest\(\) && options\.reloadAfterDismiss\) window\.location\.reload\(\);/);
	// No second copy of the helper anywhere in the admin pages.
	const features = readFileSync(new URL("../src/admin/features.tsx", import.meta.url), "utf8");
	assert.doesNotMatch(features, /useQueryClient/);
});

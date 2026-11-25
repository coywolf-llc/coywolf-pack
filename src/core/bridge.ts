/**
 * The pack's routes, called in process: for the companion plugin of the
 * editor's AI Enrich button (src/editor.ts), whose plugin context EmDash scopes
 * to its own id, so it can't read the pack's storage, KV or settings. It asks
 * EmDash's own route dispatcher (`locals.emdash.handlePluginApiRoute`, the one
 * EmDash's plugin and MCP routes use), which the pack's middleware remembers on
 * every request (rememberDispatch). No HTTP request to the site itself: EmDash
 * has already checked who's asking before the companion's route runs.
 *
 * Per request (EmDash's request context, src/core/request-memo.ts), with the
 * last one seen as the fallback: the dispatcher is bound to the isolate's one
 * EmDash runtime, so any request's works for every other.
 */
import { requestStore } from "./request-memo.js";

/** What EmDash's runtime answers for a plugin route (`{ success, data }` or `{ success: false, error }`). */
export interface DispatchResult {
	success: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}

export type PackDispatch = (pluginId: string, method: string, path: string, request: Request, user?: unknown) => Promise<DispatchResult>;

const perRequest = new WeakMap<object, PackDispatch>();
let latest: PackDispatch | null = null;

/** Remember EmDash's dispatcher for this request (called by coywolfPack() on every request; anything else is ignored). */
export function rememberDispatch(dispatch: unknown): void {
	if (typeof dispatch !== "function") return;
	latest = dispatch as PackDispatch;
	const store = requestStore();
	if (store) perRequest.set(store, latest);
}

/** EmDash's dispatcher, or null before the pack's middleware has seen a request in this isolate. */
export function packDispatch(): PackDispatch | null {
	const store = requestStore();
	return (store && perRequest.get(store)) || latest;
}

/** Tests only. */
export function resetDispatchForTests(): void {
	latest = null;
}

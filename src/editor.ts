/**
 * The AI Enrich button in EmDash's entry editor (since 0.52.0): a small
 * companion plugin next to Coywolf Pack, because EmDash lists editor actions
 * only for plugins without a React admin entry, and the pack has one. Add it
 * after coywolfPlugin() in astro.config.mjs:
 *
 * ```js
 * import { coywolfPlugin } from "@coywolf/emdash";
 * import { coywolfEditorPlugin } from "@coywolf/emdash/editor";
 * emdash({ plugins: [coywolfPlugin({ … }), coywolfEditorPlugin()] });
 * ```
 *
 * The button sends the editor's unsaved draft to the pack's ai/editor-enrich
 * route (src/ai/editor-enrich.ts) through EmDash's own dispatcher (src/core/bridge.ts,
 * which needs coywolfPack() in the site's middleware) and returns the pack's
 * answer: a toast, and a patch the editor shows for review. Admins only, like the
 * pack's other routes: EmDash shows the button to everyone who can edit the
 * entry, and answers anyone else's click with its own "Plugin action failed".
 * It's always listed: with AI Enrichment or its parts off, a click says so. (A
 * list that followed the switches went by each isolate's last read of them, up
 * to five minutes old, and EmDash answers a click on an action that isn't
 * listed with a 404.)
 *
 * Fields: by default the button reads and patches the collection's translatable
 * fields; `read` and `patch` name them instead (fields a collection lacks are
 * ignored). The patch only sets fields the draft sent, so every `patch` field
 * is read too, named in `read` or not.
 */
import type { PluginDescriptor } from "emdash";
import { definePlugin, definePluginRoute } from "emdash";

import { packDispatch } from "./core/bridge.js";
import { PLUGIN_ID } from "./core/features.js";
import { VERSION } from "./version.js";

export interface EditorOptions {
	/** Fields the button reads from the editor's draft. Default: the collection's translatable fields. */
	read?: string[];
	/** Fields its patch may set (Portable Text for links and image blocks, image fields); they're read too. Default: the translatable fields. */
	patch?: string[];
}

export const EDITOR_PLUGIN_ID = "coywolf-pack-editor";
/** The pack's route the button's route hands the draft to. */
export const ENRICH_ROUTE = "ai/editor-enrich";
const ENTRYPOINT = "@coywolf/emdash/editor";
const CAPABILITIES = ["admin.editor-draft:read", "admin.editor-draft:patch"] as const;

const selector = (fields: string[] | undefined) => (fields?.length ? { fields: [...fields] } : { translatable: true as const });

/** What the button reads: `read` (or the translatable fields), and always the fields it may patch (a field that isn't read is never patched). */
function readSelector(options: EditorOptions): { fields?: string[]; translatable?: true } {
	const patch = options.patch ?? [];
	if (options.read?.length) return { fields: [...new Set([...options.read, ...patch])] };
	return patch.length ? { translatable: true, fields: [...patch] } : { translatable: true };
}

/** The companion plugin, for astro.config.mjs (see the file comment). */
export function coywolfEditorPlugin(options: EditorOptions = {}): PluginDescriptor<EditorOptions> {
	return {
		id: EDITOR_PLUGIN_ID,
		displayName: "Coywolf Pack AI Enrich",
		description: "The AI Enrich button in the entry editor: glossary.io links, and alt text and captions for images without them, for review before saving.",
		version: VERSION,
		format: "native",
		entrypoint: ENTRYPOINT,
		options,
		capabilities: [...CAPABILITIES],
	};
}

export function createPlugin(options: EditorOptions = {}) {
	const patch = selector(options.patch);
	const action = {
		id: "ai-enrich",
		label: "AI Enrich",
		route: "enrich",
		placement: "toolbar" as const,
		draft: { read: readSelector(options), patch },
	};
	return definePlugin({
		id: EDITOR_PLUGIN_ID,
		version: VERSION,
		capabilities: [...CAPABILITIES],
		admin: { editorActions: [action] },
		routes: {
			enrich: definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (rc) => {
					const dispatch = packDispatch();
					if (!dispatch) return { toast: { type: "error", message: "AI Enrich needs Coywolf Pack's middleware (coywolfPack()) in the site's middleware." } };
					const draft = (rc.input as { draft?: unknown } | null)?.draft;
					const request = new Request(rc.request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft, patch }) });
					try {
						const result = await dispatch(PLUGIN_ID, "POST", ENRICH_ROUTE, request, rc.user ?? null);
						if (result.success && result.data && typeof result.data === "object") return result.data;
						rc.log.warn("AI Enrich: Coywolf Pack's route didn't answer", { error: result.error });
						return { toast: { type: "error", message: `AI Enrich didn't work: ${result.error?.message ?? "Coywolf Pack didn't answer"}. Click again to retry.` } };
					} catch (error) {
						rc.log.error("AI Enrich failed", { error: String(error).slice(0, 300) });
						return { toast: { type: "error", message: "AI Enrich didn't work. Click again to retry." } };
					}
				},
			}),
		},
	});
}

export default createPlugin;

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
 * pack's other routes. It's listed while AI Enrichment is on with glossary.io
 * links (and entities) or Image text.
 *
 * Fields: by default the button reads and patches the collection's translatable
 * fields; `read` and `patch` name them instead (fields a collection lacks are
 * ignored). The patch only sets fields the draft sent.
 */
import type { PluginDescriptor } from "emdash";
import { definePlugin, definePluginRoute } from "emdash";

import { packDispatch } from "./core/bridge.js";
import { PLUGIN_ID, isOn, knownFeatures } from "./core/features.js";
import { VERSION } from "./version.js";

export interface EditorOptions {
	/** Fields the button reads from the editor's draft. Default: the collection's translatable fields. */
	read?: string[];
	/** Fields its patch may set (Portable Text for links and image blocks, image fields). Default: the translatable fields. */
	patch?: string[];
}

export const EDITOR_PLUGIN_ID = "coywolf-pack-editor";
/** The pack's route the button's route hands the draft to. */
export const ENRICH_ROUTE = "ai/editor-enrich";
const ENTRYPOINT = "@coywolf/emdash/editor";
const CAPABILITIES = ["admin.editor-draft:read", "admin.editor-draft:patch"] as const;

const selector = (fields: string[] | undefined) => (fields?.length ? { fields: [...fields] } : { translatable: true as const });

/** Whether the button has anything to do: AI Enrichment with glossary.io links (and entities) or Image text. Listed until the switches are known. */
export function enrichShows(features = knownFeatures()): boolean {
	if (!features) return true;
	return (isOn(features, "ai.entities") && isOn(features, "ai.glossaryLinks")) || isOn(features, "ai.imageText");
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
		draft: { read: selector(options.read), patch },
	};
	// Read on every manifest build and click (definePlugin keeps admin as it is): the button goes when its parts are off.
	const admin = Object.defineProperty({}, "editorActions", { enumerable: true, get: () => (enrichShows() ? [action] : []) }) as { editorActions: (typeof action)[] };
	return definePlugin({
		id: EDITOR_PLUGIN_ID,
		version: VERSION,
		capabilities: [...CAPABILITIES],
		admin,
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

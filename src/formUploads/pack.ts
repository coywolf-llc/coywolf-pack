/**
 * Private Form Uploads module: the feature switch and the Private Form Uploads admin
 * page. The work happens in the Forms plugin itself, wrapped by
 * privateFormUploads() (see ./wrap.ts), so the page talks to routes on the
 * Forms plugin (/_emdash/api/plugins/emdash-forms/coywolf-private-uploads/*).
 */
import type { PluginDescriptor } from "emdash";

import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { FEATURE, WRAP_OPTION, type PrivateFormUploadsOptions } from "./wrap.js";

export type { PrivateFormUploadsOptions } from "./wrap.js";

export const FEATURES = [
	{
		id: FEATURE,
		label: "Private Form Uploads",
		description:
			"Files sent through Forms plugin forms go to a private storage bucket that only admins can open, instead of the public media library.",
		default: false,
	},
];
registerFeatures(FEATURES);

export function formUploadsPack(): PackModule {
	return {
		id: "formUploads",
		label: "Private Form Uploads",
		features: FEATURES,
		adminPages: [{ path: "/form-uploads", label: "Private Form Uploads", icon: "lock" }],
	};
}

/**
 * Wrap the Forms plugin's descriptor so its file uploads can be kept private:
 *
 * ```js
 * import { coywolfPlugin, privateFormUploads } from "@coywolf/emdash";
 * import { formsPlugin } from "@emdash-cms/plugin-forms";
 * plugins: [coywolfPlugin({...}), privateFormUploads(formsPlugin())]
 * ```
 *
 * The plugin keeps its id, storage, admin pages and settings; only its code
 * entry changes to "@coywolf/emdash/forms", which runs the Forms plugin with
 * private uploads. Nothing changes until the feature is turned on.
 */
export function privateFormUploads<T extends object>(forms: PluginDescriptor<T>, options: PrivateFormUploadsOptions = {}): PluginDescriptor<T> {
	if (forms.id !== "emdash-forms") throw new Error(`privateFormUploads() wraps the EmDash Forms plugin (emdash-forms), not "${forms.id}".`);
	return {
		...forms,
		entrypoint: "@coywolf/emdash/forms",
		options: { ...(forms.options ?? {}), [WRAP_OPTION]: options } as T,
	};
}

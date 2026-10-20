import type { PluginContext } from "emdash";

import { isOn, registerFeatures, siteFeatures } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { CLEANUP_TASK, COUNTS_FEATURE, FILES_FEATURE, LARGE_UPLOADS_FEATURE, type FilesOptions, filesModule, filesStorage, abortStaleUploads, indexEntry, unindexEntry } from "./module.js";
import { serveDownload } from "./serve.js";
import { BLOCK_TYPE } from "./walker.js";

const FEATURES = [
	{
		id: FILES_FEATURE,
		label: "File Downloads",
		description: "A download card block for any file, stable download URLs (/download/<id>/<name>), and a Files page.",
		default: false,
	},
	{
		id: COUNTS_FEATURE,
		label: "Download counts",
		description: "Count downloads per file (written after the response, batched).",
		default: false,
	},
	{
		id: LARGE_UPLOADS_FEATURE,
		label: "Large uploads",
		description: "Upload files up to 50 GB of any type to R2 through the site (needs R2 API credentials).",
		default: false,
	},
];
registerFeatures(FEATURES);

/** Toggles default to on; a block can hide each part of its card. */
const toggle = (action_id: string, label: string) => ({ type: "toggle" as const, action_id, label, initial_value: true });

export function filesPack(options: FilesOptions): PackModule {
	return {
		id: "files",
		label: "File Downloads",
		features: FEATURES,
		routes: filesModule(options).routes,
		hooks: {
			"content:afterSave": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
				await indexEntry(ctx, event.collection, event.content);
			},
			"content:afterDelete": async (event: { id: string; collection: string }, ctx: PluginContext) => {
				await unindexEntry(ctx, event.collection, event.id);
			},
		},
		tasks: [
			{
				name: CLEANUP_TASK,
				schedule: "@daily",
				feature: LARGE_UPLOADS_FEATURE,
				handler: async (ctx: PluginContext) => {
					await abortStaleUploads(ctx);
				},
			},
		],
		adminPages: [{ path: "/files", label: "Files", icon: "file-arrow-down" }],
		storage: filesStorage,
		capabilities: ["content:read", "schema:read", "media:read", "network:request"],
		allowedHosts: ["*.r2.cloudflarestorage.com"],
		portableTextBlocks: [
			{
				type: BLOCK_TYPE,
				label: "File download",
				icon: "file",
				category: "Media",
				description: "A download card for a file from the Media Library or a large upload",
				fields: [
					{ type: "select", action_id: "id", label: "File", options: [], optionsRoute: "files/options" },
					{ type: "text_input", action_id: "title", label: "Title (optional; defaults to the file name)" },
					{ type: "text_input", action_id: "description", label: "Description (optional)", multiline: true },
					toggle("showIcon", "Show the file-type icon"),
					toggle("showDescription", "Show the description"),
					toggle("showMeta", "Show type, size and upload date"),
					toggle("showDownload", "Show the Download button"),
					toggle("showCopyLink", "Show the Copy link button"),
				],
			},
		],
	};
}

/** Serves /<base>/<id>/<name> downloads. Bindings: DB, MEDIA, and FILES when large uploads use their own bucket. */
export const filesMiddleware: PackMiddleware = {
	module: "files",
	feature: FILES_FEATURE,
	handle: async (context, env, waitUntil) => {
		const count = isOn(await siteFeatures(), COUNTS_FEATURE);
		return serveDownload(context.request, context.url, env, waitUntil, { count });
	},
};

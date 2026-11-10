import type { PluginContext } from "emdash";

import { CLOUDFLARE_API_HOST } from "../core/cloudflare-api.js";
import { registerFeatures } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { configureBackupDownloads, serveBackupDownload } from "./download.js";
import { BACKUPS_TASK, type BackupsOptions, backupsModule } from "./module.js";

const FEATURES = [
	// On by default before 0.36.0: sites set up earlier keep it on (recordDefaults in src/core/features.ts).
	{ id: "backups", label: "Backups", description: "Database and media backups, rewind, and restore.", default: false, legacyDefault: true },
];
registerFeatures(FEATURES);

export function backupsPack(options: BackupsOptions): PackModule {
	// Module-level so the site middleware can find the backup bucket (createPlugin() runs at isolate start).
	configureBackupDownloads(options);
	const backups = backupsModule(options);
	return {
		id: "backups",
		label: "Backups",
		features: FEATURES,
		routes: backups.routes,
		// recordOutcome: Alerts reports a failed run (src/core/task-health.ts).
		tasks: [{ name: BACKUPS_TASK, schedule: "@daily", recordOutcome: true, handler: (ctx: PluginContext) => backups.daily(ctx) }],
		adminPages: [{ path: "/backups", label: "Backups", icon: "database" }],
		widgets: [{ id: "backup-status", title: "Backups", size: "third" }],
		// Restores and Retention on Cloudflare call Cloudflare's API (through ctx.http where the route has it).
		capabilities: ["network:request"],
		allowedHosts: [CLOUDFLARE_API_HOST],
	};
}

/** Streams backup downloads at the links the Backups page creates (see ./download.ts). */
export const backupsDownloadMiddleware: PackMiddleware = {
	module: "backups",
	feature: "backups",
	handle: (context, env) => serveBackupDownload(context.request, context.url, env),
};

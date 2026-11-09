/**
 * Backups module: D1 dumps + R2 media mirror, with rewind (D1 Time Travel),
 * undo, restore to a new database, and missing-media restore.
 */
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { type CronScheduler, type SettingsReader, parseInput, secret, workerEnv } from "../shared.js";
import { createDownloadLink } from "./download.js";
import { dumpLines } from "./dump.js";
import {
	type RestoreConfig,
	currentBookmark,
	getUndo,
	restoreMissingMedia,
	restoreToNewDatabase,
	rewind,
	undoRewind,
} from "./restore.js";
import { FILE, type Manifest, STAMP, listBackups, makeStamp, mirrorBucket, mirrorMedia, pruneBackups, writeDumpStream, writeManifest } from "./store.js";
import { readOnlyRoute } from "../core/routes.js";

export interface BackupsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** R2 binding of the media bucket. Default "MEDIA". */
	media?: string;
	/** R2 binding of the backup bucket (use a separate, private bucket). Default "BACKUPS". */
	backups?: string;
	/**
	 * R2 binding of the private form uploads bucket (Coywolf Pack → Private form
	 * uploads), mirrored to uploads/ in the backup bucket. Default "FORM_UPLOADS";
	 * skipped when the site has no such binding. false leaves uploads out.
	 */
	uploads?: string | false;
	/** Dump file name prefix (e.g. "mysite" -> mysite.sql.gz). Default "database". */
	name?: string;
	/**
	 * Restore via the Cloudflare API: the account and D1 database IDs, plus a
	 * Worker secret with an API token (Account → D1 → Edit). These live outside
	 * the database on purpose: a rewind rolls back plugin settings too.
	 */
	restore?: { accountId: string; databaseId: string; tokenSecret?: string };
}

/**
 * Schedule and retention, edited on the Backups page. Not in the plugin's
 * settingsSchema (that holds secrets only), so every read supplies its default.
 */
export const BACKUPS_DEFAULTS = { scheduled: false, retentionDays: 30, staleAfterHours: 36 } as const;

const backupsSettingsInput = z.object({
	scheduled: z.boolean(),
	retentionDays: z.number().int().min(1, "Keep backups for at least 1 day.").max(365, "Keep backups for at most 365 days."),
	staleAfterHours: z.number().int().min(1, "Warn after at least 1 hour.").max(720, "Warn after at most 720 hours (30 days)."),
});

async function settings(ctx: SettingsReader) {
	return {
		scheduled: (await ctx.settings.get<boolean>("backupsScheduled")) ?? BACKUPS_DEFAULTS.scheduled,
		retentionDays: (await ctx.settings.get<number>("backupsRetentionDays")) ?? BACKUPS_DEFAULTS.retentionDays,
		staleAfterHours: (await ctx.settings.get<number>("backupsStaleAfterHours")) ?? BACKUPS_DEFAULTS.staleAfterHours,
	};
}

/** Daily task for scheduled backups and retention. schedule() is an upsert, so it's safe to repeat. */
export const BACKUPS_TASK = "backups-daily";
export async function ensureBackupsTask(ctx: CronScheduler) {
	await ctx.cron?.schedule(BACKUPS_TASK, { schedule: "@daily" });
}

const confirmed = (word: string) => z.literal(word, { message: `Type ${word} to confirm.` });

export function backupsModule(options: BackupsOptions) {
	const name = options.name ?? "database";

	async function bindings() {
		const env = await workerEnv();
		const db = env[options.database ?? "DB"] as D1Database | undefined;
		const media = env[options.media ?? "MEDIA"] as R2Bucket | undefined;
		const backups = env[options.backups ?? "BACKUPS"] as R2Bucket | undefined;
		const uploads = options.uploads === false ? undefined : (env[options.uploads ?? "FORM_UPLOADS"] as R2Bucket | undefined);
		const missing = [!db && "database", !media && "media", !backups && "backups"].filter(Boolean);
		if (missing.length) throw PluginRouteError.badRequest(`Backups: missing ${missing.join(", ")} binding (see README).`);
		const tokenName = options.restore?.tokenSecret ?? "BACKUPS_API_TOKEN";
		const token = secret(env, tokenName);
		const restore: RestoreConfig | null =
			options.restore && token ? { token, accountId: options.restore.accountId, databaseId: options.restore.databaseId } : null;
		const restoreStatus = restore
			? { enabled: true as const }
			: {
					enabled: false as const,
					reason: options.restore
						? `Set the ${tokenName} Worker secret to an API token with D1 Edit permission.`
						: "Add the backups.restore option (accountId, databaseId) in astro.config.mjs.",
				};
		return { db: db!, media: media!, backups: backups!, uploads, restore, restoreStatus };
	}

	async function readDump(backups: R2Bucket, stamp: string): Promise<{ manifest: Manifest; sql: string }> {
		const manifestObject = await backups.get(`d1/${stamp}/manifest.json`);
		if (!manifestObject) throw PluginRouteError.notFound("Backup not found");
		const manifest = (await manifestObject.json()) as Manifest;
		const dump = await backups.get(`d1/${stamp}/${manifest.file}`);
		if (!dump) throw PluginRouteError.notFound("Backup file not found");
		return { manifest, sql: await new Response(dump.body.pipeThrough(new DecompressionStream("gzip"))).text() };
	}

	async function runBackup(source: "admin" | "scheduled") {
		const { db, media, backups, uploads, restore } = await bindings();
		const stamp = makeStamp();
		const timeTravelBookmark = restore ? await currentBookmark(restore).catch(() => undefined) : undefined;
		const file = `${name}.sql.gz`;
		// Streamed: rows are read a page at a time and gzipped straight into the bucket.
		const counts = { tables: 0, rows: 0 };
		const written = await writeDumpStream(backups, stamp, file, dumpLines(db, counts));
		const extra = { database: name, source, timeTravelBookmark, tables: counts.tables, rows: counts.rows };
		// Save the database first so a media problem can't cost the dump.
		const manifest = await writeManifest(backups, stamp, file, written, extra);
		let result = manifest;
		try {
			const mediaResult = await mirrorMedia(media, backups, stamp);
			result = await writeManifest(backups, stamp, file, written, { ...extra, media: mediaResult });
		} catch (error) {
			console.error("coywolf backups: media mirror failed; the database backup was saved", error);
		}
		if (uploads) {
			try {
				const uploadsResult = await mirrorBucket(uploads, backups, stamp, "uploads");
				result = await writeManifest(backups, stamp, file, written, { ...result, uploads: uploadsResult });
			} catch (error) {
				console.error("coywolf backups: form uploads mirror failed; the database backup was saved", error);
			}
		}
		return result;
	}

	async function daily(ctx: SettingsReader & { log: { info(msg: string, data?: unknown): void } }) {
		const s = await settings(ctx);
		if (s.scheduled) {
			const manifest = await runBackup("scheduled");
			ctx.log.info("Scheduled backup complete", { stamp: manifest.stamp, bytes: manifest.bytes });
		}
		const { backups } = await bindings();
		const pruned = await pruneBackups(backups, s.retentionDays);
		if (pruned) ctx.log.info("Pruned old backups", { pruned });
	}

	const routes = {
		"backups/list": {
			permission: "plugins:manage" as const,
			handler: async (ctx: SettingsReader & CronScheduler) => {
				await ensureBackupsTask(ctx);
				const { backups, restoreStatus } = await bindings();
				return { items: await listBackups(backups), ...(await settings(ctx)), restore: restoreStatus, undo: await getUndo(backups) };
			},
		},

		/** Schedule and retention (the Backups page's Settings section). */
		"backups/settings/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(backupsSettingsInput, ctx.input);
				await ctx.settings.set("backupsScheduled", input.scheduled);
				await ctx.settings.set("backupsRetentionDays", input.retentionDays);
				await ctx.settings.set("backupsStaleAfterHours", input.staleAfterHours);
				await ensureBackupsTask(ctx);
				ctx.log.info("Backup settings saved", input);
				return settings(ctx);
			},
		}),

		"backups/run": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "none" },
			handler: async (ctx) => {
				await ensureBackupsTask(ctx);
				const manifest = await runBackup("admin");
				ctx.log.info("Backup complete", { stamp: manifest.stamp, bytes: manifest.bytes });
				const { backups } = await bindings();
				await pruneBackups(backups, (await settings(ctx)).retentionDays);
				return manifest;
			},
		}),

		"backups/rewind": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(z.object({ stamp: z.string().regex(STAMP), confirm: confirmed("REWIND") }), ctx.input);
				const { backups, restore } = await bindings();
				if (!restore) throw PluginRouteError.badRequest("Restore isn't configured.");
				const manifestObject = await backups.get(`d1/${input.stamp}/manifest.json`);
				const manifest = manifestObject ? ((await manifestObject.json()) as Manifest) : undefined;
				const undo = await rewind(restore, backups, { stamp: input.stamp, bookmark: manifest?.timeTravelBookmark });
				ctx.log.warn("Database rewound", { to: input.stamp, undoBookmark: undo.bookmark });
				return undo;
			},
		}),

		"backups/undo": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				parseInput(z.object({ confirm: confirmed("UNDO") }), ctx.input);
				const { backups, restore } = await bindings();
				if (!restore) throw PluginRouteError.badRequest("Restore isn't configured.");
				const undo = await undoRewind(restore, backups);
				ctx.log.warn("Rewind undone", { bookmark: undo.bookmark });
				return undo;
			},
		}),

		"backups/restore-new": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(z.object({ stamp: z.string().regex(STAMP), confirm: confirmed("RESTORE") }), ctx.input);
				const { backups, restore } = await bindings();
				if (!restore) throw PluginRouteError.badRequest("Restore isn't configured.");
				const { sql } = await readDump(backups, input.stamp);
				const result = await restoreToNewDatabase(restore, `${name}-restore-${input.stamp.toLowerCase()}`, sql);
				ctx.log.warn("Backup restored to a new database", { stamp: input.stamp, database: result.databaseName });
				return result;
			},
		}),

		"backups/restore-media": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "none" },
			handler: async (ctx) => {
				// Media first, then private form uploads, in batches; the admin calls again while anything is pending.
				const { media, backups, uploads } = await bindings();
				const result = await restoreMissingMedia(media, backups);
				const fromUploads =
					uploads && !result.pending ? await restoreMissingMedia(uploads, backups, 200, "uploads") : { restored: 0, checked: 0, pending: 0 };
				const combined = {
					restored: result.restored + fromUploads.restored,
					checked: result.checked + fromUploads.checked,
					// Uploads aren't looked at until media is done, so count them as pending meanwhile.
					pending: result.pending + (uploads && result.pending ? 1 : fromUploads.pending),
					media: result,
					uploads: uploads ? fromUploads : undefined,
				};
				ctx.log.info("Missing media restored", combined);
				return combined;
			},
		}),

		/**
		 * A ten-minute link that streams one backup file (see ./download.ts).
		 * The file is a gzipped SQL dump that restores into any D1 database.
		 */
		"backups/download-link": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(z.object({ stamp: z.string().regex(STAMP), file: z.string().regex(FILE) }), ctx.input);
				const { backups } = await bindings();
				const link = await createDownloadLink(backups, input.stamp, input.file);
				if (!link) throw PluginRouteError.notFound("Backup file not found");
				ctx.log.info("Backup download link created", { stamp: input.stamp, file: input.file });
				return link;
			},
		})),
	};

	return { routes, daily };
}

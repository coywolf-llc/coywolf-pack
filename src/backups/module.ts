/**
 * Backups module: D1 dumps + R2 media mirror, with rewind (D1 Time Travel),
 * undo, restore to a new database, and missing-media restore.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { CloudflareApiError, contextFetch } from "../core/cloudflare-api.js";
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
import {
	PROBE_PREFIX,
	type RetentionAccess,
	type RetentionStatus,
	bucketHasKey,
	getLifecycle,
	getLocks,
	lockRules,
	mergeRules,
	pruningRedundant,
	putLifecycle,
	putLocks,
	retentionRules,
	retentionStatus,
} from "./retention.js";
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

/**
 * Retention on Cloudflare (the Backups page's card): where the account ID and
 * bucket name are saved (plain settings), the optional saved token (a secret,
 * src/core/secrets.ts), and what the last look at the bucket found (KV).
 */
export const RETENTION_SETTINGS = { accountId: "backupsAccountId", bucket: "backupsBucketName", token: "backupsCloudflareToken" } as const;
export const RETENTION_STATE_KEY = "backups:cloudflare";

/** What the last look at the backup bucket's rules found. */
export interface RetentionState {
	checkedAt: string;
	bucket: string;
	retentionDays: number;
	status: RetentionStatus;
}

const DAY_MS = 86_400_000;
/** The daily task re-reads the bucket's rules once this old (when it has a token), and stops trusting a look older than RETENTION_TRUST_MS. */
const RETENTION_RECHECK_MS = DAY_MS;
const RETENTION_TRUST_MS = 7 * DAY_MS;

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

	/**
	 * `writeOnce`: the backup bucket has a lock on d1/, which refuses to overwrite a manifest, so it's
	 * written once, after the mirrors (their counts in it), instead of first and again after each mirror.
	 */
	async function runBackup(source: "admin" | "scheduled", writeOnce = false) {
		const { db, media, backups, uploads, restore } = await bindings();
		const stamp = makeStamp();
		const timeTravelBookmark = restore ? await currentBookmark(restore).catch(() => undefined) : undefined;
		const file = `${name}.sql.gz`;
		// Streamed: rows are read a page at a time and gzipped straight into the bucket.
		const counts = { tables: 0, rows: 0 };
		const written = await writeDumpStream(backups, stamp, file, dumpLines(db, counts));
		const extra: Partial<Manifest> = { database: name, source, timeTravelBookmark, tables: counts.tables, rows: counts.rows };
		// Save the database first so a media problem can't cost the dump (unless the manifest can be written only once).
		let result = writeOnce ? ({ ...extra } as Manifest) : await writeManifest(backups, stamp, file, written, extra);
		try {
			const mediaResult = await mirrorMedia(media, backups, stamp);
			result = writeOnce ? { ...result, media: mediaResult } : await writeManifest(backups, stamp, file, written, { ...extra, media: mediaResult });
		} catch (error) {
			console.error("coywolf backups: media mirror failed; the database backup was saved", error);
		}
		if (uploads) {
			try {
				const uploadsResult = await mirrorBucket(uploads, backups, stamp, "uploads");
				result = writeOnce ? { ...result, uploads: uploadsResult } : await writeManifest(backups, stamp, file, written, { ...result, uploads: uploadsResult });
			} catch (error) {
				console.error("coywolf backups: form uploads mirror failed; the database backup was saved", error);
			}
		}
		if (writeOnce) result = await writeManifest(backups, stamp, file, written, result);
		return result;
	}

	// ── Retention on Cloudflare ─────────────────────────────────────

	const retentionInput = z.object({
		accountId: z
			.string()
			.trim()
			.regex(/^([0-9a-f]{32})?$/i, "The account ID is 32 letters and numbers (0-9, a-f).")
			.optional(),
		bucket: z
			.string()
			.trim()
			.regex(/^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])?$/, "Bucket names use lowercase letters, numbers and hyphens (3-63 characters).")
			.optional(),
		token: z.string().trim().max(400).optional(),
	});

	const tokenSecretName = () => options.restore?.tokenSecret ?? "BACKUPS_API_TOKEN";

	/** The token, account and bucket: the request's, then the saved ones, then Worker secrets (the restore token, which can carry R2 Edit too). */
	async function retentionAccess(ctx: PluginContext, input: z.infer<typeof retentionInput> = {}): Promise<RetentionAccess> {
		const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
		const saved = async (key: string) => ((await ctx.settings.get<string>(key).catch(() => null)) ?? "").trim();
		const token = input.token || (await saved(RETENTION_SETTINGS.token)) || secret(env, tokenSecretName()) || secret(env, "CLOUDFLARE_API_TOKEN") || "";
		const accountId =
			input.accountId || (await saved(RETENTION_SETTINGS.accountId)) || options.restore?.accountId || secret(env, "CF_ACCOUNT_ID") || secret(env, "CLOUDFLARE_ACCOUNT_ID") || "";
		const bucket = input.bucket || (await saved(RETENTION_SETTINGS.bucket));
		const missing = [!accountId && "Cloudflare account ID", !bucket && "backup bucket name", !token && "Cloudflare API token"].filter(Boolean);
		if (missing.length) throw PluginRouteError.badRequest(`Enter the ${missing.join(", ")} first.`);
		return { token, accountId, bucket, fetch: contextFetch(ctx) };
	}

	/**
	 * Make sure the named bucket is the one bound as the backup bucket: write a small probe through the
	 * binding and look for it through Cloudflare's API (the sites share an account, so another site's
	 * backup bucket is one typo away). The probe is deleted again.
	 */
	async function verifyBucket(access: RetentionAccess): Promise<void> {
		const { backups } = await bindings();
		const key = `${PROBE_PREFIX}${crypto.randomUUID()}.txt`;
		await backups.put(key, "Coywolf Pack checks which bucket this is. Safe to delete.");
		try {
			if (!(await bucketHasKey(access, key))) {
				throw PluginRouteError.badRequest(
					`The bucket ${access.bucket} isn't the one bound as ${options.backups ?? "BACKUPS"} in wrangler.jsonc. Check its bucket_name there.`,
				);
			}
		} finally {
			await backups.delete(key).catch(() => undefined);
		}
	}

	async function readRetentionState(ctx: { kv: PluginContext["kv"] }): Promise<RetentionState | null> {
		return ((await ctx.kv.get<RetentionState>(RETENTION_STATE_KEY).catch(() => null)) ?? null) as RetentionState | null;
	}

	/** Read the bucket's lifecycle and lock rules, and remember what they do for `retentionDays`. */
	async function inspectRetention(ctx: PluginContext, access: RetentionAccess, retentionDays: number): Promise<RetentionState> {
		const [lifecycle, locks] = await Promise.all([getLifecycle(access), getLocks(access)]);
		const state: RetentionState = { checkedAt: new Date().toISOString(), bucket: access.bucket, retentionDays, status: retentionStatus(lifecycle, locks, retentionDays) };
		await ctx.kv.set(RETENTION_STATE_KEY, state);
		return state;
	}

	const cloudflareError = (error: unknown): never => {
		if (error instanceof CloudflareApiError) throw PluginRouteError.badRequest(error.message);
		throw error;
	};

	/** Save the account and bucket that worked (and the token, when asked to). */
	async function rememberAccess(ctx: PluginContext, input: z.infer<typeof retentionInput> & { saveToken?: boolean }, access: RetentionAccess) {
		if (input.accountId) await ctx.settings.set(RETENTION_SETTINGS.accountId, access.accountId);
		if (input.bucket) await ctx.settings.set(RETENTION_SETTINGS.bucket, access.bucket);
		if (input.saveToken && input.token) await ctx.settings.set(RETENTION_SETTINGS.token, input.token);
	}

	/**
	 * Whether today's pruning can be skipped: the bucket's lifecycle rule deletes every prefix that ages
	 * out, at the retention days or sooner, as last seen within RETENTION_TRUST_MS. The rules are read
	 * again once a day when a token is available (saved or a Worker secret); without one, a look from the
	 * Backups page counts for a week, then the pack prunes again (redundant, never harmful).
	 */
	async function pruningSkippable(ctx: PluginContext, retentionDays: number): Promise<{ skip: boolean; state: RetentionState | null }> {
		let state = await readRetentionState(ctx);
		if (state && Date.now() - Date.parse(state.checkedAt) > RETENTION_RECHECK_MS) {
			const access = await retentionAccess(ctx).catch(() => null);
			if (access) {
				state = await inspectRetention(ctx, access, retentionDays).catch((error: unknown) => {
					ctx.log.warn("Backups: couldn't read the backup bucket's lifecycle rules", { error: String(error).slice(0, 300) });
					return state;
				});
			}
		}
		const fresh = Boolean(state && Date.now() - Date.parse(state.checkedAt) <= RETENTION_TRUST_MS);
		return { skip: fresh && pruningRedundant(state?.status, retentionDays), state };
	}

	async function daily(ctx: PluginContext) {
		const s = await settings(ctx);
		const retention = await pruningSkippable(ctx, s.retentionDays);
		if (s.scheduled) {
			const manifest = await runBackup("scheduled", retention.state?.status.d1Locked === true);
			ctx.log.info("Scheduled backup complete", { stamp: manifest.stamp, bytes: manifest.bytes });
		}
		// The backup bucket's lifecycle rule deletes old backups itself: pruning here would only repeat it.
		if (retention.skip) return;
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
				const state = await readRetentionState(ctx);
				const manifest = await runBackup("admin", state?.status.d1Locked === true);
				ctx.log.info("Backup complete", { stamp: manifest.stamp, bytes: manifest.bytes });
				const { retentionDays } = await settings(ctx);
				if (!pruningRedundant(state?.status, retentionDays)) {
					const { backups } = await bindings();
					await pruneBackups(backups, retentionDays);
				}
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

		/** Retention on Cloudflare: what's saved and what the last look at the bucket found (no Cloudflare call). */
		"backups/cloudflare": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
				const saved = async (key: string) => ((await ctx.settings.get<string>(key).catch(() => null)) ?? "").trim();
				const { retentionDays } = await settings(ctx);
				return {
					accountId: (await saved(RETENTION_SETTINGS.accountId)) || options.restore?.accountId || "",
					bucket: await saved(RETENTION_SETTINGS.bucket),
					suggestedBucket: `${name}-backups`,
					tokenSaved: Boolean(await saved(RETENTION_SETTINGS.token)),
					envToken: Boolean(secret(env, tokenSecretName()) || secret(env, "CLOUDFLARE_API_TOKEN")),
					envTokenName: tokenSecretName(),
					envAccountId: Boolean(options.restore?.accountId || secret(env, "CF_ACCOUNT_ID") || secret(env, "CLOUDFLARE_ACCOUNT_ID")),
					retentionDays,
					state: await readRetentionState(ctx),
				};
			},
		},

		/** Look at the backup bucket's lifecycle and lock rules (after checking it's the bound bucket). Changes nothing on Cloudflare. */
		"backups/cloudflare/check": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(retentionInput, ctx.input ?? {});
				const access = await retentionAccess(ctx, input);
				const { retentionDays } = await settings(ctx);
				try {
					await verifyBucket(access);
					const state = await inspectRetention(ctx, access, retentionDays);
					await rememberAccess(ctx, input, access);
					return state;
				} catch (error) {
					return cloudflareError(error);
				}
			},
		})),

		/**
		 * Set the lifecycle rule to the retention days, and the lock to match (`lock`: on) or remove the
		 * pack's lock (off). The bucket's other rules are kept. Turning the lock on takes LOCK typed.
		 * Nothing a page shows changes, so no cache is cleared.
		 */
		"backups/cloudflare/apply": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(
					retentionInput.extend({ saveToken: z.boolean().optional(), lock: z.boolean(), confirm: z.string().optional() }).refine((v) => !v.lock || v.confirm === "LOCK", {
						message: "Type LOCK to confirm the bucket lock.",
					}),
					ctx.input,
				);
				const access = await retentionAccess(ctx, input);
				const { retentionDays } = await settings(ctx);
				try {
					await verifyBucket(access);
					const [lifecycle, locks] = await Promise.all([getLifecycle(access), getLocks(access)]);
					await putLifecycle(access, mergeRules(lifecycle, retentionRules(retentionDays)));
					const hadLock = locks.some((rule) => rule.id.startsWith("coywolf-pack-backups-"));
					if (input.lock || hadLock) await putLocks(access, mergeRules(locks, input.lock ? lockRules(retentionDays) : []));
					await rememberAccess(ctx, input, access);
					const state = await inspectRetention(ctx, access, retentionDays);
					ctx.log.info("Backups: retention set on the backup bucket", { bucket: access.bucket, days: retentionDays, lock: input.lock });
					return state;
				} catch (error) {
					return cloudflareError(error);
				}
			},
		})),

		/** Remove the pack's lifecycle and lock rules from the backup bucket (the pack prunes again from the next day). */
		"backups/cloudflare/remove": readOnlyRoute(definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				const input = parseInput(retentionInput, ctx.input ?? {});
				const access = await retentionAccess(ctx, input);
				const { retentionDays } = await settings(ctx);
				try {
					const [lifecycle, locks] = await Promise.all([getLifecycle(access), getLocks(access)]);
					await putLifecycle(access, mergeRules(lifecycle, []));
					if (locks.some((rule) => rule.id.startsWith("coywolf-pack-backups-"))) await putLocks(access, mergeRules(locks, []));
					const state = await inspectRetention(ctx, access, retentionDays);
					ctx.log.info("Backups: the pack's retention rules were removed from the backup bucket", { bucket: access.bucket });
					return state;
				} catch (error) {
					return cloudflareError(error);
				}
			},
		})),

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

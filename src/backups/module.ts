/**
 * Backups module: D1 dumps + R2 media mirror, with rewind (D1 Time Travel),
 * undo, restore to a new database, and missing-media restore.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { CloudflareApiError, contextFetch } from "../core/cloudflare-api.js";
import { UNREADABLE_TOKEN_MESSAGE, cloudflareAccountId, cloudflareToken, noAccountMessage, sharedTokenState, tokenName } from "../core/cloudflare-token.js";
import { boundBucket, bucketMissText, findBoundBucket, jurisdictionMessage } from "../core/worker-bindings.js";
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
	BUCKET_MARKER,
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
import { FILE, type Manifest, STAMP, listBackups, makeStamp, mirrorBucket, mirrorMedia, newestStamp, pruneBackups, stampToDate, writeDumpStream, writeManifest, writeMirrorCounts } from "./store.js";
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
	 * The database is saved first, with its manifest, so a media problem (or a run cut off in the middle
	 * of the mirrors) can't cost the dump: it's listed and restorable at once. The mirror counts are added
	 * by rewriting the manifest, except when d1/ is locked (`locked`: R2 refuses to overwrite a locked
	 * object), when they go to mirrors/<stamp>.json instead (outside every locked prefix).
	 */
	async function runBackup(source: "admin" | "scheduled", locked = false) {
		const { db, media, backups, uploads, restore } = await bindings();
		const stamp = makeStamp();
		const timeTravelBookmark = restore ? await currentBookmark(restore).catch(() => undefined) : undefined;
		const file = `${name}.sql.gz`;
		// Streamed: rows are read a page at a time and gzipped straight into the bucket.
		const counts = { tables: 0, rows: 0 };
		const written = await writeDumpStream(backups, stamp, file, dumpLines(db, counts));
		const extra: Partial<Manifest> = { database: name, source, timeTravelBookmark, tables: counts.tables, rows: counts.rows };
		const manifest = await writeManifest(backups, stamp, file, written, extra);
		let result: Manifest = manifest;
		const record = async (next: Manifest) => (locked ? next : writeManifest(backups, stamp, file, written, next));
		try {
			result = await record({ ...result, media: await mirrorMedia(media, backups, stamp) });
		} catch (error) {
			console.error("coywolf backups: media mirror failed; the database backup was saved", error);
		}
		if (uploads) {
			try {
				result = await record({ ...result, uploads: await mirrorBucket(uploads, backups, stamp, "uploads") });
			} catch (error) {
				console.error("coywolf backups: form uploads mirror failed; the database backup was saved", error);
			}
		}
		if (locked && (result.media || result.uploads)) {
			await writeMirrorCounts(backups, stamp, { media: result.media, uploads: result.uploads }).catch((error: unknown) =>
				console.error("coywolf backups: couldn't record the mirror counts; the backup was saved", error),
			);
		}
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

	/** The backup bucket's R2 binding. */
	const backupsBinding = () => options.backups ?? "BACKUPS";

	/**
	 * The token, account and bucket. The token: the request's, else the Cloudflare API token, the older saved
	 * retention token, the restore token's Worker secret (it can carry R2 Edit too), then CLOUDFLARE_API_TOKEN
	 * (src/core/cloudflare-token.ts). The account: the request's, the saved one, backups.restore's, else
	 * CF_ACCOUNT_ID or the token's own. The bucket: the request's, the saved one, else the one bound as BACKUPS
	 * (found with the token, src/core/worker-bindings.ts); verifyBucket checks it either way. Restores themselves
	 * never use this token (bindings() above).
	 */
	async function retentionAccess(ctx: PluginContext, input: z.infer<typeof retentionInput> = {}): Promise<RetentionAccess> {
		const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
		const saved = async (key: string) => ((await ctx.settings.get<string>(key).catch(() => null)) ?? "").trim();
		const resolved = await cloudflareToken(ctx, env, "backupsRetention", { typed: input.token, olderEnv: [tokenSecretName()] });
		const { token, unreadable } = resolved;
		let bucket = input.bucket || (await saved(RETENTION_SETTINGS.bucket));
		if (!token && unreadable) throw PluginRouteError.badRequest(UNREADABLE_TOKEN_MESSAGE);
		const missing = [!bucket && "backup bucket name", !token && "Cloudflare API token (on the plugin's Settings page)"].filter(Boolean);
		if (!token) throw PluginRouteError.badRequest(`Enter the ${missing.join(", ")} first.`);
		const own = input.accountId || (await saved(RETENTION_SETTINGS.accountId)) || options.restore?.accountId || "";
		const fetch = contextFetch(ctx);
		const accountId = await cloudflareAccountId(ctx, env, { token, fetch }, own);
		if (!accountId) throw PluginRouteError.badRequest(noAccountMessage("Advanced"));
		if (!bucket) {
			const lookup = await boundBucket(ctx, env, backupsBinding(), { token, fetch, accountId, tokenName: tokenName(resolved) });
			if (!lookup.bucket) throw PluginRouteError.badRequest(`Enter the backup bucket name first. ${bucketMissText(lookup)}`);
			if (lookup.jurisdiction) {
				throw PluginRouteError.badRequest(
					jurisdictionMessage(lookup, "Retention on Cloudflare", "Set the rule by hand in the Cloudflare dashboard instead (How to set the retention rule by hand, on this card)."),
				);
			}
			bucket = lookup.bucket;
		}
		return { token, accountId, bucket, fetch, tokenName: tokenName(resolved) };
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
					`The bucket ${access.bucket} isn't the one bound as ${backupsBinding()} in wrangler.jsonc. Check its bucket_name there.`,
				);
			}
		} finally {
			await backups.delete(key).catch(() => undefined);
		}
		// Which bucket was checked, readable through the binding alone (bucketMatches).
		try {
			await backups.put(BUCKET_MARKER, JSON.stringify({ bucket: access.bucket, at: new Date().toISOString() }), { httpMetadata: { contentType: "application/json" } });
		} catch {
			// R2 refuses to overwrite a locked object: only a lock rule that isn't the pack's reaches coywolf-pack/.
			throw PluginRouteError.badRequest(
				`The bucket ${access.bucket} has a bucket lock rule that covers ${BUCKET_MARKER} (a lock on the whole bucket, most likely), so the pack can't record which bucket it checked. Narrow that lock to d1/, media/changed/ and uploads/changed/ in the Cloudflare dashboard (R2 → the bucket → Settings → Bucket lock rules), then try again. A whole-bucket lock also stops the media mirror from updating.`,
			);
		}
	}

	/** Whether the BACKUPS binding still writes to the bucket the rule was checked on (the marker verifyBucket left there). */
	async function bucketMatches(bucket: string): Promise<boolean> {
		try {
			const { backups } = await bindings();
			const object = await backups.get(BUCKET_MARKER);
			const marker = object ? ((await object.json()) as { bucket?: unknown }) : null;
			return marker?.bucket === bucket;
		} catch {
			return false;
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
	 * Whether pruning can be skipped: the bucket's lifecycle rule deletes every prefix that ages out at
	 * exactly the retention days (pruningRedundant), as last seen within RETENTION_TRUST_MS, on the bucket
	 * the BACKUPS binding still writes to (its marker). With `recheck`, rules older than a day are read
	 * again first when a token is available (saved or a Worker secret); without one, a look from the
	 * Backups page counts for a week, then the pack prunes again (it deletes the same backups the rule
	 * would, so nothing is lost either way).
	 */
	async function pruningSkippable(ctx: PluginContext, retentionDays: number, recheck = true): Promise<{ skip: boolean; state: RetentionState | null }> {
		let state = await readRetentionState(ctx);
		if (recheck && state && Date.now() - Date.parse(state.checkedAt) > RETENTION_RECHECK_MS) {
			const access = await retentionAccess(ctx).catch(() => null);
			if (access) {
				state = await inspectRetention(ctx, access, retentionDays).catch((error: unknown) => {
					ctx.log.warn("Backups: couldn't read the backup bucket's lifecycle rules", { error: String(error).slice(0, 300) });
					return state;
				});
			}
		}
		const fresh = Boolean(state && Date.now() - Date.parse(state.checkedAt) <= RETENTION_TRUST_MS);
		const skip = fresh && pruningRedundant(state?.status, retentionDays) && (await bucketMatches(state?.bucket ?? ""));
		return { skip, state };
	}

	/**
	 * The lifecycle rule deletes by age whether or not new backups are being made: after `retentionDays`
	 * of failed backups none is left. Warn in the log once the newest is older than half that.
	 */
	async function warnIfBackupsStopped(ctx: PluginContext, retentionDays: number) {
		const { backups } = await bindings();
		const newest = await newestStamp(backups).catch(() => null);
		const ageDays = newest ? (Date.now() - stampToDate(newest).getTime()) / DAY_MS : Number.POSITIVE_INFINITY;
		if (ageDays > retentionDays / 2) {
			ctx.log.warn("Backups: the newest backup is older than half the retention days, and the bucket's lifecycle rule keeps deleting old ones", {
				newest,
				retentionDays,
			});
		}
	}

	/** What to say when the pack's lock would get shorter (or go): only the Backups card's LOCK confirmation does that. */
	const lockShortening = (current: number, next: number | null) =>
		`Backups are locked for ${current} days. ${next == null ? "Removing the lock" : `Shortening it to ${next} days`} unlocks older backups (and the lifecycle rule would delete them), so it needs the LOCK confirmation: use Retention on Cloudflare on the Backups page. Until then the rule and the lock keep ${current} days.`;

	/**
	 * After Keep backups for changes: move the pack's rule (and its lock) to the new days, when the site
	 * has a token (saved or a Worker secret). The bucket's rules are read again first, so a rule or lock
	 * removed in the Cloudflare dashboard isn't put back. A lock is never shortened here: lowering the
	 * days with a lock in place changes nothing on Cloudflare and says the card's LOCK confirmation is
	 * needed. Lengthening is automatic. Returns a warning when the rule wasn't moved, or null.
	 */
	async function followRetention(ctx: PluginContext, retentionDays: number): Promise<string | null> {
		const saved = await readRetentionState(ctx);
		if (!saved?.status.ours || pruningRedundant(saved.status, retentionDays)) return null;
		const ruleDays = (status: RetentionStatus) => Math.min(...Object.values(status.byPrefix).filter((d): d is number => d !== null));
		const stale = (status: RetentionStatus) =>
			`The backup bucket's lifecycle rule still deletes backups after ${ruleDays(status)} days. Update it under Retention on Cloudflare, so it matches Keep backups for.`;
		const access = await retentionAccess(ctx).catch(() => null);
		// No token: nothing is (re)created on Cloudflare; the card shows the mismatch.
		if (!access) return saved.status.lockDays != null && retentionDays < saved.status.lockDays ? lockShortening(saved.status.lockDays, retentionDays) : stale(saved.status);
		try {
			const live = await inspectRetention(ctx, access, saved.retentionDays);
			// Removed in the dashboard since: don't put it back.
			if (!live.status.ours) return null;
			if (live.status.lockDays != null && retentionDays < live.status.lockDays) return lockShortening(live.status.lockDays, retentionDays);
			await applyRules(ctx, access, retentionDays, live.status.lockDays != null);
			return null;
		} catch (error) {
			ctx.log.warn("Backups: couldn't update the lifecycle rule to the new retention days", { error: String(error).slice(0, 300) });
			return stale(saved.status);
		}
	}

	/**
	 * Set the pack's lifecycle rule to `retentionDays` (keeping the bucket's other rules), and its lock with
	 * `lock`. Shortening or removing the pack's lock unlocks backups, so it needs `confirmed` (LOCK typed on
	 * the Backups card): without it nothing is changed. Lengthening it, or setting the same days, doesn't.
	 */
	async function applyRules(ctx: PluginContext, access: RetentionAccess, retentionDays: number, lock: boolean, confirmed = false): Promise<RetentionState> {
		await verifyBucket(access);
		const [lifecycle, locks] = await Promise.all([getLifecycle(access), getLocks(access)]);
		const current = retentionStatus(lifecycle, locks, retentionDays).lockDays;
		if (current != null && (!lock || retentionDays < current) && !confirmed) {
			throw PluginRouteError.badRequest(lockShortening(current, lock ? retentionDays : null));
		}
		await putLifecycle(access, mergeRules(lifecycle, retentionRules(retentionDays)));
		const hadLock = locks.some((rule) => rule.id.startsWith("coywolf-pack-backups-"));
		if (lock || hadLock) await putLocks(access, mergeRules(locks, lock ? lockRules(retentionDays) : []));
		const state = await inspectRetention(ctx, access, retentionDays);
		ctx.log.info("Backups: retention set on the backup bucket", { bucket: access.bucket, days: retentionDays, lock });
		return state;
	}

	async function daily(ctx: PluginContext) {
		const s = await settings(ctx);
		const retention = await pruningSkippable(ctx, s.retentionDays);
		try {
			if (s.scheduled) {
				const manifest = await runBackup("scheduled", retention.state?.status.d1Locked === true);
				ctx.log.info("Scheduled backup complete", { stamp: manifest.stamp, bytes: manifest.bytes });
			}
		} finally {
			// With the lifecycle rule deleting by age, say so when backups have stopped, also when this one failed.
			if (retention.skip) await warnIfBackupsStopped(ctx, s.retentionDays).catch(() => undefined);
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
				// The pack's lifecycle rule follows Keep backups for (or the page says it couldn't).
				const retentionWarning = await followRetention(ctx, input.retentionDays);
				return { ...(await settings(ctx)), ...(retentionWarning ? { retentionWarning } : {}) };
			},
		}),

		"backups/run": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "none" },
			handler: async (ctx) => {
				await ensureBackupsTask(ctx);
				const { retentionDays } = await settings(ctx);
				// The same rule as the daily task (trust window, bucket marker), without reading Cloudflare's API here.
				const retention = await pruningSkippable(ctx, retentionDays, false);
				const manifest = await runBackup("admin", retention.state?.status.d1Locked === true);
				ctx.log.info("Backup complete", { stamp: manifest.stamp, bytes: manifest.bytes });
				if (!retention.skip) {
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

		/**
		 * Retention on Cloudflare: what's saved, what the last look at the bucket found, and the bucket bound as
		 * BACKUPS (found with the token, remembered per deploy: src/core/worker-bindings.ts). Nothing else asks Cloudflare.
		 */
		"backups/cloudflare": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				const env = await workerEnv().catch(() => ({}) as Record<string, unknown>);
				const saved = async (key: string) => ((await ctx.settings.get<string>(key).catch(() => null)) ?? "").trim();
				const { retentionDays } = await settings(ctx);
				const accountId = (await saved(RETENTION_SETTINGS.accountId)) || options.restore?.accountId || "";
				const resolved = await cloudflareToken(ctx, env, "backupsRetention", { olderEnv: [tokenSecretName()] });
				return {
					accountId,
					bucket: await saved(RETENTION_SETTINGS.bucket),
					detectedBucket: await findBoundBucket(ctx, env, backupsBinding(), { resolved, fetch: contextFetch(ctx), account: accountId || null }),
					suggestedBucket: `${name}-backups`,
					tokenSaved: Boolean(await saved(RETENTION_SETTINGS.token)),
					envToken: Boolean(secret(env, tokenSecretName()) || secret(env, "CLOUDFLARE_API_TOKEN")),
					/** The Cloudflare API token is the one in use: the card shows no token field of its own. */
					...sharedTokenState(resolved),
					envTokenName: tokenSecretName(),
					envAccountId: Boolean(options.restore?.accountId || secret(env, "CF_ACCOUNT_ID") || secret(env, "CLOUDFLARE_ACCOUNT_ID")),
					retentionDays,
					state: await readRetentionState(ctx),
					newestBackup: await bindings()
						.then(({ backups }) => newestStamp(backups))
						.then((stamp) => (stamp ? stampToDate(stamp).toISOString() : null))
						.catch(() => null),
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
					// Shortening or removing an existing lock needs LOCK too (applyRules checks against the live lock).
					ctx.input,
				);
				const access = await retentionAccess(ctx, input);
				const { retentionDays } = await settings(ctx);
				try {
					const state = await applyRules(ctx, access, retentionDays, input.lock, input.confirm === "LOCK");
					await rememberAccess(ctx, input, access);
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
				const input = parseInput(retentionInput.extend({ confirm: z.string().optional() }), ctx.input ?? {});
				const access = await retentionAccess(ctx, input);
				const { retentionDays } = await settings(ctx);
				try {
					await verifyBucket(access);
					const [lifecycle, locks] = await Promise.all([getLifecycle(access), getLocks(access)]);
					const current = retentionStatus(lifecycle, locks, retentionDays).lockDays;
					if (current != null && input.confirm !== "LOCK") throw PluginRouteError.badRequest(lockShortening(current, null));
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

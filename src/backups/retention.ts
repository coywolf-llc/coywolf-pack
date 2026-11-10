/**
 * Backup retention on Cloudflare's side: an R2 lifecycle rule on the backup
 * bucket that deletes old backups after the pack's retention days, and an
 * optional bucket lock that keeps them from being deleted or overwritten
 * before then. Set from the Backups page (Retention on Cloudflare) with a
 * Cloudflare API token, through the pack's shared Cloudflare client.
 *
 * Only the prefixes that age out are covered: database backups (d1/) and the
 * copies of replaced or deleted media and uploads (media/changed/,
 * uploads/changed/). The mirrors (media/current/, uploads/current/), rewind
 * undo points (restore/undo/) and download links (downloads/) are never in a
 * rule. Rules the bucket already has are kept as they are; the pack only adds,
 * changes or removes its own (matched by id), since the API replaces the whole
 * list on every write.
 *
 * With the lifecycle rule in place (deleting at the retention days or sooner),
 * the pack's own daily pruning is redundant, so it stops (see backupsModule's
 * daily task). Kept free of EmDash imports so tests can load it directly.
 */
import { type CloudflareCall, cloudflareApi } from "../core/cloudflare-api.js";

/** Where backups age out (the layout in docs/backups.md). */
export const RETENTION_PREFIXES = ["d1/", "media/changed/", "uploads/changed/"] as const;
/** Prefixes no rule of the pack's touches, and that a delete or lock rule must not cover either (the mirrors are rewritten every run). */
export const MIRROR_PREFIXES = ["media/current/", "uploads/current/"] as const;

const DAY_SECONDS = 86_400;
/** R2's default for abandoned multipart uploads; the pack's rule on d1/ repeats it, so a dump upload cut off midway is cleaned up even if the bucket's default rule was removed. */
const ABORT_MULTIPART_SECONDS = 7 * DAY_SECONDS;

const lifecycleId = (prefix: string) => `coywolf-pack-backups-retention:${prefix}`;
const lockId = (prefix: string) => `coywolf-pack-backups-lock:${prefix}`;
const isOurs = (id: string) => id.startsWith("coywolf-pack-backups-");

type AgeCondition = { type: "Age"; maxAge: number };
type DateCondition = { type: "Date"; date: string };

/** A lifecycle rule as Cloudflare's API takes and returns it. */
export interface LifecycleRule {
	id: string;
	enabled: boolean;
	conditions: { prefix: string };
	deleteObjectsTransition?: { condition: AgeCondition | DateCondition };
	abortMultipartUploadsTransition?: { condition: AgeCondition };
	storageClassTransitions?: unknown[];
}

/** A bucket lock rule as Cloudflare's API takes and returns it. */
export interface LockRule {
	id: string;
	enabled: boolean;
	prefix?: string;
	condition: { type: "Age"; maxAgeSeconds: number } | DateCondition | { type: "Indefinite" };
}

/** Mirror counts kept beside locked manifests (store.ts MIRRORS_PREFIX): aged out with the backups, never locked. */
const SIDECAR_PREFIX = "mirrors/";

/** The pack's lifecycle rules for `days` of retention. */
export function retentionRules(days: number): LifecycleRule[] {
	return [...RETENTION_PREFIXES, SIDECAR_PREFIX].map((prefix) => ({
		id: lifecycleId(prefix),
		enabled: true,
		conditions: { prefix },
		deleteObjectsTransition: { condition: { type: "Age", maxAge: days * DAY_SECONDS } },
		...(prefix === "d1/" ? { abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: ABORT_MULTIPART_SECONDS } } } : {}),
	}));
}

/** The pack's lock rules for `days`. */
export function lockRules(days: number): LockRule[] {
	return RETENTION_PREFIXES.map((prefix) => ({ id: lockId(prefix), enabled: true, prefix, condition: { type: "Age", maxAgeSeconds: days * DAY_SECONDS } }));
}

/** The bucket's rules with the pack's replaced by `ours` (none removes them). Everyone else's are kept, in order. */
export function mergeRules<T extends { id: string }>(existing: T[], ours: T[]): T[] {
	return [...existing.filter((rule) => !isOurs(rule.id)), ...ours];
}

/** Whether a rule's prefix covers keys under `prefix` ("" covers the whole bucket). */
const covers = (rulePrefix: string | undefined, prefix: string) => prefix.startsWith(rulePrefix ?? "");

/**
 * Days after which an enabled lifecycle rule deletes keys under `prefix` (the soonest of the rules that do),
 * or null. A rule that deletes on a fixed date isn't counted: it doesn't keep the retention days (see dateDeletes).
 */
function deleteDays(rules: LifecycleRule[], prefix: string): number | null {
	let soonest: number | null = null;
	for (const rule of rules) {
		const condition = rule.deleteObjectsTransition?.condition;
		if (!rule.enabled || condition?.type !== "Age" || !covers(rule.conditions?.prefix, prefix)) continue;
		const days = condition.maxAge / DAY_SECONDS;
		soonest = soonest === null ? days : Math.min(soonest, days);
	}
	return soonest;
}

export interface RetentionStatus {
	/**
	 * "on": every prefix that ages out is deleted at exactly the retention days; "different": every one
	 * is deleted, at other days; "partial": only some are; "off": none is.
	 */
	lifecycle: "on" | "different" | "partial" | "off";
	/** Days per prefix after which a lifecycle rule deletes it (null: none does). */
	byPrefix: Record<string, number | null>;
	/** The longest of those when every prefix is covered: backups older than this are surely gone. */
	coveredDays: number | null;
	/** Whether the pack's own rules are there. */
	ours: boolean;
	/** Other lifecycle rules on the bucket (kept as they are). */
	otherRules: number;
	/** A delete rule that reaches the mirrors (media/current/, uploads/current/): it would delete live copies. */
	mirrorDeleted: boolean;
	/** The pack's lock, in days, when every prefix has it (null: no lock of the pack's). */
	lockDays: number | null;
	/** Other lock rules that reach the mirrors or the whole bucket: the mirror can't update locked files. */
	mirrorLocked: boolean;
	/** Any lock (the pack's or not) on database backups: a manifest can be written once only. */
	d1Locked: boolean;
	/** A rule that deletes backups on a fixed date: whatever the retention days, they go then. */
	dateDeletes: boolean;
	/** Other lock rules on the bucket. */
	otherLocks: number;
}

/** What the bucket's rules do to the pack's backups, for `retentionDays`. */
export function retentionStatus(lifecycle: LifecycleRule[], locks: LockRule[], retentionDays: number): RetentionStatus {
	const byPrefix = Object.fromEntries(RETENTION_PREFIXES.map((prefix) => [prefix, deleteDays(lifecycle, prefix)])) as Record<string, number | null>;
	const values = Object.values(byPrefix);
	const covered = values.filter((v): v is number => v !== null);
	const state = covered.length === 0 ? "off" : covered.length < values.length ? "partial" : covered.every((v) => v === retentionDays) ? "on" : "different";
	const ourLocks = locks.filter((rule) => isOurs(rule.id) && rule.enabled && rule.condition.type === "Age");
	const lockDays =
		RETENTION_PREFIXES.every((prefix) => ourLocks.some((rule) => rule.prefix === prefix)) && ourLocks.length
			? Math.max(...ourLocks.map((rule) => (rule.condition as { maxAgeSeconds: number }).maxAgeSeconds / DAY_SECONDS))
			: null;
	return {
		lifecycle: state,
		byPrefix,
		coveredDays: covered.length === values.length ? Math.max(...covered) : null,
		ours: lifecycle.some((rule) => isOurs(rule.id)),
		otherRules: lifecycle.filter((rule) => !isOurs(rule.id)).length,
		mirrorDeleted: MIRROR_PREFIXES.some((prefix) => deleteDays(lifecycle, prefix) !== null),
		lockDays,
		mirrorLocked: locks.some((rule) => !isOurs(rule.id) && rule.enabled && MIRROR_PREFIXES.some((prefix) => covers(rule.prefix, prefix))),
		d1Locked: locks.some((rule) => rule.enabled && covers(rule.prefix, "d1/")),
		dateDeletes: lifecycle.some(
			(rule) => rule.enabled && rule.deleteObjectsTransition?.condition?.type === "Date" && RETENTION_PREFIXES.some((prefix) => covers(rule.conditions?.prefix, prefix)),
		),
		otherLocks: locks.filter((rule) => !isOurs(rule.id)).length,
	};
}

/**
 * Whether the pack's daily pruning is redundant: a lifecycle rule deletes every prefix that ages out at
 * exactly the retention days. Any other rule doesn't count: one that deletes later leaves pruning to the
 * pack, and one that deletes sooner than the setting (Keep backups for raised after the rule was set) is a
 * mismatch the Backups page warns about (Cloudflare deletes them anyway; pruning again changes nothing).
 */
export function pruningRedundant(status: Pick<RetentionStatus, "byPrefix"> | null | undefined, retentionDays: number): boolean {
	return Boolean(status) && RETENTION_PREFIXES.every((prefix) => status?.byPrefix[prefix] === retentionDays);
}

/** The rule deletes backups sooner than Keep backups for: some are lost before the setting says. */
export function deletesSooner(status: Pick<RetentionStatus, "byPrefix"> | null | undefined, retentionDays: number): boolean {
	return Boolean(status) && RETENTION_PREFIXES.some((prefix) => {
		const days = status?.byPrefix[prefix];
		return days != null && days < retentionDays;
	});
}

// ── Cloudflare API ───────────────────────────────────────────────

export interface RetentionAccess {
	token: string;
	accountId: string;
	bucket: string;
	fetch?: CloudflareCall["fetch"];
}

const PERMISSION = "Account → Workers R2 Storage → Edit";
const bucketPath = (access: RetentionAccess) => `/accounts/${encodeURIComponent(access.accountId)}/r2/buckets/${encodeURIComponent(access.bucket)}`;
const call = (access: RetentionAccess, label: string, extra: Partial<CloudflareCall> = {}): CloudflareCall => ({ token: access.token, fetch: access.fetch, permission: PERMISSION, label, ...extra });

export async function getLifecycle(access: RetentionAccess): Promise<LifecycleRule[]> {
	const { result } = await cloudflareApi<{ rules?: LifecycleRule[] } | null>(`${bucketPath(access)}/lifecycle`, call(access, "R2 lifecycle rules"));
	return Array.isArray(result?.rules) ? result.rules : [];
}

export async function putLifecycle(access: RetentionAccess, rules: LifecycleRule[]): Promise<void> {
	await cloudflareApi(`${bucketPath(access)}/lifecycle`, call(access, "R2 lifecycle rules", { method: "PUT", body: { rules } }));
}

export async function getLocks(access: RetentionAccess): Promise<LockRule[]> {
	const { result } = await cloudflareApi<{ rules?: LockRule[] } | null>(`${bucketPath(access)}/lock`, call(access, "R2 bucket lock rules"));
	return Array.isArray(result?.rules) ? result.rules : [];
}

export async function putLocks(access: RetentionAccess, rules: LockRule[]): Promise<void> {
	await cloudflareApi(`${bucketPath(access)}/lock`, call(access, "R2 bucket lock rules", { method: "PUT", body: { rules } }));
}

/**
 * Whether `key` is in the named bucket, by Cloudflare's documented R2 "List Objects" REST endpoint
 * (GET /accounts/{account_id}/r2/buckets/{bucket_name}/objects with `prefix` and `per_page`; the
 * Cloudflare API reference, R2 → Buckets → Objects → List, and Cloudflare's OpenAPI schema). The
 * Worker's binding wrote the key a moment ago, so finding it means it's the same bucket. Fails safe:
 * an error, another shape, or no match counts as "not this bucket", and the caller refuses to go on.
 */
export async function bucketHasKey(access: RetentionAccess, key: string): Promise<boolean> {
	const { result } = await cloudflareApi<Array<{ key?: string }> | null>(
		`${bucketPath(access)}/objects?prefix=${encodeURIComponent(key)}&per_page=1`,
		call(access, "R2 bucket check"),
	);
	return Array.isArray(result) && result.some((object) => object.key === key);
}

/** The probe the bucket check writes through the binding (outside every prefix a rule covers). */
export const PROBE_PREFIX = "coywolf-pack/bucket-check/";
/**
 * Written through the binding when the bucket check passes: which bucket the rule was checked on. The
 * daily task reads it through the binding, so a BACKUPS binding pointed at another bucket since (no
 * marker there) makes the site prune again, without a token.
 */
export const BUCKET_MARKER = "coywolf-pack/retention-bucket.json";

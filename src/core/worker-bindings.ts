/**
 * This site's own Worker on Cloudflare, and the R2 buckets its bindings name, so a feature that needs a bucket's
 * name (large uploads, Set up media host, Retention on Cloudflare) reads it from the Worker's own configuration
 * instead of asking the owner to type it.
 *
 * The Worker is the account's script whose current deployment runs the version this isolate runs
 * (CF_VERSION_METADATA): GET /accounts/{account_id}/workers/scripts, most recently changed first, then each one's
 * /deployments. Its bindings are `result.bindings` of GET /accounts/{account_id}/workers/scripts/{script_name}/settings
 * ("Get Worker Script and Version Settings",
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/).
 * There an R2 binding is { type: "r2_bucket", name, bucket_name, jurisdiction? } (jurisdiction: eu, fedramp,
 * fedramp-high or us) and a D1 binding { type: "d1", name, database_id } (`id` is its deprecated name). All three
 * calls accept the "Workers Metadata Read-Only" token permission (Workers → Metadata Read-Only in Cloudflare's token
 * editor), which the Cloudflare usage card already asks for. Cloudflare usage (src/pageCache/usage.ts) finds the
 * site's D1 database with the same two lookups.
 *
 * A bucket lookup that read the Worker's settings is remembered in plugin KV for that Worker version, account and
 * token (its fingerprint, src/core/cloudflare-token.ts): a deploy that changes wrangler.jsonc runs a new version, so
 * it's read again, starting with the Worker found before. Only answers are remembered, as with the token's account:
 * a Worker that wasn't found for five minutes per isolate, a refusal (the token lacks the permission) or a Cloudflare
 * that didn't answer not at all.
 *
 * It runs only where a bucket is needed (admin routes, large uploads, Set up media host, Retention on Cloudflare),
 * never on a page render. Kept free of EmDash imports so tests can load it directly.
 */
import { CloudflareApiError, type Fetch, cloudflareApi } from "./cloudflare-api.js";
import { type ResolvedToken, UNREADABLE_TOKEN_MESSAGE, cloudflareAccountId, noAccountMessage, noTokenMessage, tokenFingerprint, tokenName } from "./cloudflare-token.js";
import { CLOUDFLARE_PERMISSIONS } from "./guide-content.js";
import { DEADLINES } from "./single-flight.js";
import { versionId } from "../pageCache/lib.js";

/** One of a Worker's bindings as the settings endpoint returns it (only the fields the pack reads). */
export interface WorkerBinding {
	type?: string;
	name?: string;
	/** r2_bucket */
	bucket_name?: string;
	/** r2_bucket: the bucket's jurisdiction, when it has one. */
	jurisdiction?: string;
	/** d1 */
	database_id?: string;
	/** d1, deprecated name of database_id */
	id?: string;
}

/** How to call Cloudflare's API for one account. `deadlineMs`: per call (default DEADLINES.cloudflareApiMs). */
export interface WorkerApi {
	token: string;
	fetch?: Fetch;
	accountId: string;
	deadlineMs?: number;
}

const read = async <T>(a: WorkerApi, path: string): Promise<T> => (await cloudflareApi<T>(path, { token: a.token, fetch: a.fetch, deadlineMs: a.deadlineMs })).result;

/**
 * The script whose current deployment runs `version` (a gradual deployment's two versions both count): `hint` first
 * (the Worker found before), then the account's scripts, most recently changed first (the first 50). Null when none
 * does. Throws when the scripts can't be listed; a script whose deployments can't be read is skipped.
 */
export async function findWorkerScript(a: WorkerApi & { version: string; hint?: string | null }): Promise<string | null> {
	const runsVersion = async (script: string) => {
		const answer = await read<{ deployments?: Array<{ versions?: Array<{ version_id?: string }> }> } | null>(a, `/accounts/${a.accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`).catch(() => null);
		return Boolean(answer?.deployments?.[0]?.versions?.some((v) => v.version_id === a.version));
	};
	if (a.hint && (await runsVersion(a.hint))) return a.hint;
	const listed = await read<Array<{ id?: string; modified_on?: string }> | null>(a, `/accounts/${a.accountId}/workers/scripts`);
	const scripts = (Array.isArray(listed) ? listed : []).filter((s): s is { id: string; modified_on?: string } => typeof s?.id === "string" && s.id !== "" && s.id !== a.hint);
	// The Worker deployed most recently first: usually this one.
	scripts.sort((x, y) => (Date.parse(y.modified_on ?? "") || 0) - (Date.parse(x.modified_on ?? "") || 0));
	for (const script of scripts.slice(0, 50)) if (await runsVersion(script.id)) return script.id;
	return null;
}

/** The script's bindings, from its settings. Throws when they can't be read. */
export async function workerBindings(a: WorkerApi & { script: string }): Promise<WorkerBinding[]> {
	const settings = await read<{ bindings?: WorkerBinding[] } | null>(a, `/accounts/${a.accountId}/workers/scripts/${encodeURIComponent(a.script)}/settings`);
	return Array.isArray(settings?.bindings) ? settings.bindings.filter((b) => b && typeof b === "object") : [];
}

// ── Buckets ──────────────────────────────────────────────────

/** Why a bucket wasn't found. */
export type BucketMiss = "no-token" | "unreadable-token" | "no-account" | "no-version" | "forbidden" | "not-found" | "no-binding" | "unavailable";

/**
 * A bucket looked up from the Worker's binding. `bucket`: its name, or null with `miss` and `message` (one sentence
 * on what's in the way). `jurisdiction`: the bucket's, when it has one (the pack's R2 calls don't support those yet:
 * see jurisdictionMessage). `worker`: the site's Worker, when it was found.
 */
export interface BucketLookup {
	binding: string;
	bucket: string | null;
	jurisdiction: string | null;
	worker: string | null;
	miss: BucketMiss | null;
	message: string | null;
}

interface Remembered {
	version: string;
	fp: string;
	accountId: string;
	worker: string;
	/** Every R2 binding of that version: its name → the bucket. */
	buckets: Record<string, { bucket: string; jurisdiction: string | null }>;
}

const BUCKETS_KEY = "state:cloudflare:buckets";
/** Versions remembered (a gradual deployment runs two at once; a site may have the new token and an older one in use). */
const REMEMBERED = 4;
const MISS_RETRY_MS = 5 * 60_000;
/** Workers that weren't found for a version, account and token, per isolate, so a page that asks often doesn't scan each time. */
const workerMisses = new Map<string, number>();

/** Forget the isolate's misses (tests). */
export function resetBucketMisses(): void {
	workerMisses.clear();
}

/** The permission that reads the Worker's settings, as Cloudflare's token editor names it. */
const PERMISSION = CLOUDFLARE_PERMISSIONS.workersMetadata.name;

function missed(binding: string, miss: BucketMiss, o: { name?: string; worker?: string | null; detail?: string } = {}): BucketLookup {
	const messages: Record<BucketMiss, string> = {
		"no-token": noTokenMessage(PERMISSION),
		"unreadable-token": UNREADABLE_TOKEN_MESSAGE,
		"no-account": noAccountMessage(),
		"no-version": `The Worker has no CF_VERSION_METADATA binding, so the pack can't tell which Worker this site is. Add "version_metadata": { "binding": "CF_VERSION_METADATA" } to wrangler.jsonc and deploy.`,
		forbidden: `The ${o.name ?? "Cloudflare API token"} can't read this site's Worker: it needs ${PERMISSION}.`,
		"not-found": "This site's Worker wasn't found among the account's Workers.",
		"no-binding": `This site's Worker (${o.worker ?? "?"}) has no R2 binding named ${binding} in wrangler.jsonc.`,
		unavailable: `Cloudflare didn't answer${o.detail ? ` (${o.detail.replace(/\.$/, "")})` : ""}. Try again in a moment.`,
	};
	return { binding, bucket: null, jurisdiction: null, worker: o.worker ?? null, miss, message: messages[miss] };
}

function fromRemembered(entry: Remembered, binding: string): BucketLookup {
	const found = entry.buckets?.[binding];
	if (!found?.bucket) return missed(binding, "no-binding", { worker: entry.worker });
	return { binding, bucket: found.bucket, jurisdiction: found.jurisdiction ?? null, worker: entry.worker, miss: null, message: null };
}

interface BucketCtx {
	kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<void> };
}

/**
 * The bucket bound as `binding` (MEDIA, BACKUPS, FILES…) in this site's Worker, with the token and account the
 * feature already uses (`tokenName`: for the message when the token is refused). Remembered as described at the
 * top of this file.
 */
export async function boundBucket(ctx: BucketCtx, env: Record<string, unknown>, binding: string, a: { token: string; fetch?: Fetch; accountId: string; tokenName?: string }): Promise<BucketLookup> {
	const version = versionId(env);
	if (!version) return missed(binding, "no-version");
	const fp = await tokenFingerprint(a.token);
	const stored = await ctx.kv.get<{ entries?: Remembered[] }>(BUCKETS_KEY).catch(() => null);
	const entries = (Array.isArray(stored?.entries) ? stored.entries : []).filter((e) => e && typeof e === "object");
	const same = (e: Remembered) => e.fp === fp && e.accountId === a.accountId;
	const hit = entries.find((e) => same(e) && e.version === version);
	if (hit) return fromRemembered(hit, binding);
	const missKey = `${version}|${fp}|${a.accountId}`;
	if ((workerMisses.get(missKey) ?? 0) > Date.now()) return missed(binding, "not-found");

	const api: WorkerApi = { token: a.token, fetch: a.fetch, accountId: a.accountId, deadlineMs: DEADLINES.cloudflareReadMs };
	let worker: string | null;
	let bindings: WorkerBinding[];
	try {
		// The Worker found for an earlier version first: a deploy keeps the Worker's name.
		worker = await findWorkerScript({ ...api, version, hint: entries.find(same)?.worker ?? null });
		if (!worker) {
			workerMisses.set(missKey, Date.now() + MISS_RETRY_MS);
			return missed(binding, "not-found");
		}
		bindings = await workerBindings({ ...api, script: worker });
	} catch (error) {
		if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) return missed(binding, "forbidden", { name: a.tokenName });
		return missed(binding, "unavailable", { detail: error instanceof Error ? error.message : String(error) });
	}
	const buckets: Remembered["buckets"] = {};
	for (const b of bindings) {
		if (b.type !== "r2_bucket" || typeof b.name !== "string" || typeof b.bucket_name !== "string" || !b.bucket_name) continue;
		buckets[b.name] = { bucket: b.bucket_name, jurisdiction: typeof b.jurisdiction === "string" && b.jurisdiction ? b.jurisdiction : null };
	}
	const entry: Remembered = { version, fp, accountId: a.accountId, worker, buckets };
	await ctx.kv.set(BUCKETS_KEY, { entries: [entry, ...entries.filter((e) => !(same(e) && e.version === version))].slice(0, REMEMBERED) }).catch(() => undefined);
	return fromRemembered(entry, binding);
}

/**
 * The same, from the token a feature resolved (src/core/cloudflare-token.ts) and its account override: for pages
 * and readiness checks, which say why when there's no token or account. Asks Cloudflare nothing without
 * CF_VERSION_METADATA.
 */
export async function findBoundBucket(
	ctx: Parameters<typeof cloudflareAccountId>[0],
	env: Record<string, unknown>,
	binding: string,
	o: { resolved: ResolvedToken; fetch?: Fetch; account?: string | null },
): Promise<BucketLookup> {
	const { token } = o.resolved;
	if (!token) return missed(binding, o.resolved.unreadable ? "unreadable-token" : "no-token");
	if (!versionId(env)) return missed(binding, "no-version");
	const accountId = await cloudflareAccountId(ctx, env, { token, fetch: o.fetch }, o.account);
	if (!accountId) return missed(binding, "no-account");
	return boundBucket(ctx, env, binding, { token, fetch: o.fetch, accountId, tokenName: tokenName(o.resolved) });
}

/** For an error where the bucket name is needed: why it wasn't found from the binding. */
export const bucketMissText = (lookup: BucketLookup) => `The pack couldn't find it from the ${lookup.binding} binding. ${lookup.message ?? ""}`.trim();

/**
 * A bucket with a jurisdiction (EU, FedRAMP…) needs a jurisdiction header on R2's API and its own S3 endpoint,
 * which the pack's calls don't use yet: `feature` says so, and `instead` what to do.
 */
export const jurisdictionMessage = (lookup: Pick<BucketLookup, "binding" | "bucket" | "jurisdiction">, feature: string, instead: string) =>
	`The ${lookup.binding} binding's bucket ${lookup.bucket} is in the ${lookup.jurisdiction} jurisdiction, which ${feature} can't use yet. ${instead}`;

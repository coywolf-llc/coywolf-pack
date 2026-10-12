/**
 * Media host setup and checks through the Cloudflare API, plus the live check
 * of a media host. The API token is only ever sent to api.cloudflare.com: it
 * is never logged, returned, or included in error messages.
 */
import { type CustomDomain, type RulesetRule, type SetupPlan, type SetupState, hostnameOf, planMediaHostSetup, zoneCandidates } from "./setup.js";

export const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const API = `https://${CLOUDFLARE_API_HOST}/client/v4`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CloudflareConfig {
	token: string;
	accountId: string;
	fetch?: Fetch;
}

export class CloudflareApiError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** What each step of the setup needs, for error messages when the token lacks it. */
const PERMISSION_HINT: Record<string, string> = {
	zone: "Zone → Zone → Read",
	transformations: "Zone → Zone Settings → Edit",
	domain: "Account → Workers R2 Storage → Edit and Zone → DNS → Edit",
	rules: "Zone → Transform Rules → Edit (and Account → Account Rulesets → Read)",
	purge: "Zone → Cache Purge → Purge",
	cacheRules: "Zone → Cache Rules → Edit",
};

async function cf<T>(config: CloudflareConfig, path: string, init: RequestInit = {}, step?: string): Promise<{ status: number; result: T | null }> {
	const doFetch = config.fetch ?? fetch;
	const res = await doFetch(`${API}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
	const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> };
	if (!res.ok || body.success === false) {
		const detail = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || res.statusText;
		const hint = (res.status === 401 || res.status === 403) && step ? ` The API token needs ${PERMISSION_HINT[step]}.` : "";
		throw new CloudflareApiError(`Cloudflare API ${res.status}: ${detail}.${hint}`, res.status);
	}
	return { status: res.status, result: body.result ?? null };
}

/**
 * Clear everything Cloudflare's zone cache holds for one host name (the media
 * host: originals and resized copies). Purge by hostname works on every plan.
 */
export async function purgeHost(config: CloudflareConfig, hostname: string): Promise<void> {
	const zone = await findZone(config, hostname);
	await cf(config, `/zones/${zone.id}/purge_cache`, { method: "POST", body: JSON.stringify({ hosts: [hostname] }) }, "purge");
}

/** Description that marks the media host's cache rule as the pack's own. */
export const MEDIA_CACHE_RULE = "Coywolf Pack: media host";
const YEAR = 31536000;

interface CacheRule {
	id?: string;
	description?: string;
	expression?: string;
	action?: string;
	action_parameters?: { cache?: boolean; edge_ttl?: { default?: number }; browser_ttl?: { default?: number } };
	enabled?: boolean;
}

function mediaCacheRule(hostname: string): CacheRule {
	return {
		description: `${MEDIA_CACHE_RULE} (file names never change)`,
		expression: `(http.host eq "${hostname}")`,
		action: "set_cache_settings",
		action_parameters: { cache: true, edge_ttl: { mode: "override_origin", default: YEAR }, browser_ttl: { mode: "override_origin", default: YEAR } } as CacheRule["action_parameters"],
		enabled: true,
	};
}

/**
 * The media host's Cache Rule, if any: a zone cache rule for exactly this host
 * name that caches it (made by the pack or by hand).
 */
export async function readMediaCacheRule(config: CloudflareConfig, hostname: string): Promise<{ zone: string; rule: { edgeTtl?: number; browserTtl?: number; enabled: boolean } | null }> {
	const zone = await findZone(config, hostname);
	let rules: CacheRule[] = [];
	try {
		const { result } = await cf<{ rules?: CacheRule[] }>(config, `/zones/${zone.id}/rulesets/phases/http_request_cache_settings/entrypoint`, {}, "cacheRules");
		rules = result?.rules ?? [];
	} catch (error) {
		if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
	}
	const rule = rules.find((r) => r.action === "set_cache_settings" && r.action_parameters?.cache === true && r.expression?.includes(`"${hostname}"`));
	return {
		zone: zone.name,
		rule: rule ? { edgeTtl: rule.action_parameters?.edge_ttl?.default, browserTtl: rule.action_parameters?.browser_ttl?.default, enabled: rule.enabled !== false } : null,
	};
}

/**
 * Cache the media host at the edge and in browsers for a year (its file names
 * are unique, so a changed file always has a new name). Adds the rule to the
 * zone's cache rules, or updates the pack's earlier one; other rules are kept.
 */
export async function applyMediaCacheRule(config: CloudflareConfig, hostname: string): Promise<string> {
	const zone = await findZone(config, hostname);
	const phase = `/zones/${zone.id}/rulesets/phases/http_request_cache_settings/entrypoint`;
	let ruleset: { id: string; rules?: CacheRule[] } | null = null;
	try {
		ruleset = (await cf<{ id: string; rules?: CacheRule[] }>(config, phase, {}, "cacheRules")).result;
	} catch (error) {
		if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
	}
	const rule = mediaCacheRule(hostname);
	if (!ruleset) {
		await cf(config, phase, { method: "PUT", body: JSON.stringify({ rules: [rule] }) }, "cacheRules");
		return zone.name;
	}
	const existing = ruleset.rules?.find((r) => r.description?.startsWith(MEDIA_CACHE_RULE) && r.expression?.includes(`"${hostname}"`));
	if (existing?.id) {
		await cf(config, `/zones/${zone.id}/rulesets/${ruleset.id}/rules/${existing.id}`, { method: "PATCH", body: JSON.stringify(rule) }, "cacheRules");
	} else {
		await cf(config, `/zones/${zone.id}/rulesets/${ruleset.id}/rules`, { method: "POST", body: JSON.stringify(rule) }, "cacheRules");
	}
	return zone.name;
}

/** The zone that holds a host name, looked up in the account (most specific name first). */
export async function findZone(config: CloudflareConfig, hostname: string): Promise<{ id: string; name: string; plan?: string }> {
	for (const name of zoneCandidates(hostname)) {
		const { result } = await cf<Array<{ id: string; name: string; plan?: { name?: string } }>>(
			config,
			`/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(config.accountId)}`,
			{},
			"zone",
		);
		const zone = result?.find((z) => z.name === name);
		if (zone) return { id: zone.id, name: zone.name, plan: zone.plan?.name };
	}
	throw new CloudflareApiError(
		`No zone for ${hostname} in this Cloudflare account. Add the site's domain to the account, or check the account ID. The API token needs ${PERMISSION_HINT.zone}.`,
		404,
	);
}

async function readRules(config: CloudflareConfig, zoneId: string): Promise<RulesetRule[] | null> {
	try {
		const { result } = await cf<{ rules?: RulesetRule[] }>(config, `/zones/${zoneId}/rulesets/phases/http_request_transform/entrypoint`, {}, "rules");
		return result?.rules ?? [];
	} catch (error) {
		if (error instanceof CloudflareApiError && error.status === 404) return null;
		throw error;
	}
}

export interface SetupTarget {
	host: string;
	bucket: string;
}

export interface SetupContext {
	zone: { id: string; name: string; plan?: string };
	state: SetupState;
	plan: SetupPlan;
}

/** Read the current state and plan the setup (changes nothing). */
export async function planSetup(config: CloudflareConfig, target: SetupTarget): Promise<SetupContext> {
	const hostname = hostnameOf(target.host);
	const zone = await findZone(config, hostname);
	const [transformations, domains, rules] = await Promise.all([
		cf<{ value?: string }>(config, `/zones/${zone.id}/settings/transformations`, {}, "transformations").then((r) => r.result?.value ?? null),
		cf<{ domains?: CustomDomain[] }>(config, `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(target.bucket)}/domains/custom`, {}, "domain").then(
			(r) => r.result?.domains ?? [],
		),
		readRules(config, zone.id),
	]);
	const state: SetupState = { transformations, domains, rules };
	return { zone, state, plan: planMediaHostSetup(state, { host: hostname, zoneName: zone.name, bucket: target.bucket }) };
}

export interface StepResult {
	id: string;
	ok: boolean;
	message: string;
}

/** Apply the steps that need it, in order; stops at the first failure. */
export async function applySetup(config: CloudflareConfig, target: SetupTarget): Promise<{ zone: string; results: StepResult[] }> {
	const { zone, plan } = await planSetup(config, target);
	const bucket = encodeURIComponent(target.bucket);
	const results: StepResult[] = [];
	for (const step of plan.steps) {
		if (step.action === "none") {
			results.push({ id: step.id, ok: true, message: step.label });
			continue;
		}
		try {
			if (step.id === "transformations") {
				await cf(config, `/zones/${zone.id}/settings/transformations`, { method: "PATCH", body: JSON.stringify({ value: "on" }) }, "transformations");
				results.push({ id: step.id, ok: true, message: `Turned on Image Transformations for ${zone.name}.` });
			} else if (step.id === "domain" && step.action === "add") {
				await cf(
					config,
					`/accounts/${config.accountId}/r2/buckets/${bucket}/domains/custom`,
					{ method: "POST", body: JSON.stringify({ domain: plan.host, zoneId: zone.id, enabled: true, minTLS: "1.2" }) },
					"domain",
				);
				results.push({ id: step.id, ok: true, message: `Connected ${plan.host} to ${target.bucket}. Its certificate can take a few minutes.` });
			} else if (step.id === "domain") {
				await cf(
					config,
					`/accounts/${config.accountId}/r2/buckets/${bucket}/domains/custom/${encodeURIComponent(plan.host)}`,
					{ method: "PUT", body: JSON.stringify({ enabled: true, minTLS: "1.2" }) },
					"domain",
				);
				results.push({ id: step.id, ok: true, message: `Turned on ${plan.host} for ${target.bucket}.` });
			} else if (step.id === "rules") {
				await cf(
					config,
					`/zones/${zone.id}/rulesets/phases/http_request_transform/entrypoint`,
					{ method: "PUT", body: JSON.stringify({ rules: plan.rules }) },
					"rules",
				);
				results.push({ id: step.id, ok: true, message: `Saved the URL rewrite rules for ${plan.host}.` });
			}
		} catch (error) {
			results.push({ id: step.id, ok: false, message: error instanceof Error ? error.message : "Failed." });
			break;
		}
	}
	return { zone: zone.name, results };
}

// ── Live check of a media host ───────────────────────────────────

export interface CheckItem {
	id: "reachable" | "original" | "resize" | "cached";
	ok: boolean;
	label: string;
	detail: string;
}

/** Pure: turn the two fetches' outcomes into check items (exported for tests). */
export function checkItems(input: {
	file: string;
	original: { status: number; type: string } | { error: string };
	resized: { status: number; type: string; cfResized: string | null; cache: string | null } | { error: string };
}): CheckItem[] {
	const items: CheckItem[] = [];
	const o = input.original;
	const r = input.resized;
	const reached = !("error" in o) || !("error" in r);
	items.push({
		id: "reachable",
		ok: reached,
		label: "Host reachable",
		detail: reached ? "The media host answered." : `Couldn't connect: ${"error" in o ? o.error : ""}. Check the custom domain on the bucket and its DNS.`,
	});
	const originalOk = !("error" in o) && o.status === 200 && o.type.startsWith("image/");
	items.push({
		id: "original",
		ok: originalOk,
		label: "Original served",
		detail:
			"error" in o
				? "No answer."
				: originalOk
					? `${input.file} (${o.type}).`
					: o.status === 404
						? `${input.file} wasn't found (404). Is the custom domain on the bucket bound as MEDIA?`
						: `Answered ${o.status}${o.type ? ` (${o.type})` : ""}.`,
	});
	const resizeOk = !("error" in r) && r.status === 200 && (Boolean(r.cfResized) || r.type.startsWith("image/"));
	items.push({
		id: "resize",
		ok: resizeOk,
		label: "Resize works",
		detail:
			"error" in r
				? "No answer."
				: resizeOk
					? `/s/64x64/ answered ${r.type || "an image"}${r.cfResized ? " (resized by Cloudflare)" : ""}.`
					: r.status === 404
						? originalOk
							? "/s/64x64/ wasn't found (404) from inside the Worker. A Worker's request to a host on its own zone can reach the bucket without the zone's URL rewrite rules, so this alone doesn't mean the rules are missing: the Clean Image URLs page checks again from your browser."
							: "/s/64x64/ wasn't found (404): the URL rewrite rules are missing, or don't match this host."
						: `/s/64x64/ answered ${r.status}. Are Image Transformations on for the zone?`,
	});
	const cache = "error" in r ? null : (r.cache ?? "").toUpperCase();
	const cached = cache === "HIT" || cache === "REVALIDATED" || cache === "STALE" || cache === "UPDATING";
	items.push({
		id: "cached",
		ok: cached,
		label: "Cached at the edge",
		detail: cache ? `Second request: cf-cache-status ${cache}.` : "No cf-cache-status header (normal for the first few requests after setup).",
	});
	return items;
}

/** Fetch a file and a 64×64 copy from the media host (the copy twice, to see the cache). */
export async function checkMediaHost(host: string, file: string, doFetch: Fetch = fetch): Promise<CheckItem[]> {
	const accept = "image/avif,image/webp,image/*,*/*;q=0.8";
	const get = async (url: string) => {
		try {
			const res = await doFetch(url, { headers: { Accept: accept }, redirect: "follow" });
			await res.body?.cancel().catch(() => undefined);
			return { status: res.status, type: (res.headers.get("content-type") ?? "").split(";")[0].trim(), cfResized: res.headers.get("cf-resized"), cache: res.headers.get("cf-cache-status") };
		} catch (error) {
			return { error: error instanceof Error ? error.message : "network error" };
		}
	};
	const original = await get(`${host}/${file}`);
	const first = await get(`${host}/s/64x64/${file}`);
	const resized = "error" in first || first.status !== 200 ? first : await get(`${host}/s/64x64/${file}`);
	return checkItems({ file, original, resized });
}

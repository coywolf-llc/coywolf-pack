/**
 * Cloudflare Checkup's calls to Cloudflare's API, through the shared client
 * (src/core/cloudflare-api.ts: deadlines, ctx.http, no token in errors).
 *
 * Reading uses the read-only token the Performance page already has (Zone →
 * Read finds the zone; Zone Settings → Read, Bot Management → Read and DNS →
 * Read are needed for the settings, the bot rows and the zone's other
 * hostnames, and each part that can't be read says which one is missing).
 * The fixes use a separate setup token (Zone Settings → Edit) and change
 * exactly one zone setting each, only when it isn't already set: nothing
 * else in the zone is touched.
 */
import { CloudflareApiError, type Fetch, cloudflareApi } from "../core/cloudflare-api.js";
import { DEADLINES } from "../core/single-flight.js";
import { type CrawlerHintsProblem, readCrawlerHints, zoneCandidates } from "../discovery/crawler-hints.js";
import { type BotSettings, CHECKUP_SETTINGS, type CheckupInput, type CheckupRow, type CheckupZone, FIXES, type FixId, checkupRows, otherHostnames } from "./checkup-core.js";

export interface CheckupResult {
	host: string;
	zone: CheckupZone | null;
	/** Why the zone couldn't be read at all (no token, a token Cloudflare refuses, no zone). */
	problem?: { kind: CrawlerHintsProblem; message: string };
	rows: CheckupRow[];
	/** Proxied hostnames in the zone besides the site's; null when they couldn't be read (otherHostsProblem). */
	otherHosts: string[] | null;
	/** The zone has more proxied records than one page (DNS_PAGE): otherHosts may be incomplete. */
	otherHostsMore?: boolean;
	otherHostsProblem?: string;
	checkedAt: string;
}

export interface CheckupDeps {
	token: string | null;
	fetch: Fetch;
	knownZone?: CheckupZone | null;
	trackingWrapper: boolean;
	trackingState?: CheckupInput["trackingState"];
	speculationOn: boolean;
	robotsOn: boolean;
	now?: () => number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const refused = (error: unknown) => error instanceof CloudflareApiError && (error.status === 401 || error.status === 403 || error.codes.some((c) => c === 10000 || c === 9109));

async function read<T>(deps: { token: string; fetch: Fetch }, path: string): Promise<T> {
	return (await cloudflareApi<T>(path, { token: deps.token, fetch: deps.fetch, deadlineMs: DEADLINES.cloudflareReadMs, label: "Cloudflare's API" })).result;
}

/**
 * The zone settings the rows need: one bulk read, then one read per setting it
 * left out. When the bulk read fails for another reason than permissions (a
 * timeout, a server error), each setting is read on its own instead.
 */
async function readSettings(deps: { token: string; fetch: Fetch }, zoneId: string): Promise<{ settings: Map<string, unknown> | null; problem?: string; refused?: boolean }> {
	const settings = new Map<string, unknown>();
	let bulkError: unknown = null;
	try {
		const all = (await read<Array<{ id?: string; value?: unknown }>>(deps, `/zones/${encodeURIComponent(zoneId)}/settings`)) ?? [];
		for (const s of Array.isArray(all) ? all : []) if (typeof s?.id === "string") settings.set(s.id, s.value);
	} catch (error) {
		if (refused(error)) {
			return { settings: null, refused: true, problem: "The read-only token can't read this zone's settings. Add Zone → Zone Settings → Read to it (the steps are below)." };
		}
		bulkError = error;
	}
	const missing = CHECKUP_SETTINGS.filter((id) => !settings.has(id));
	await Promise.all(
		missing.map(async (id) => {
			try {
				const one = await read<{ value?: unknown }>(deps, `/zones/${encodeURIComponent(zoneId)}/settings/${id}`);
				if (one && "value" in one) settings.set(id, one.value);
			} catch {
				// Left out: its row says it couldn't be read.
			}
		}),
	);
	if (bulkError && settings.size === 0) return { settings: null, problem: `Couldn't read the zone's settings: ${message(bulkError)}` };
	return { settings };
}

async function readBots(deps: { token: string; fetch: Fetch }, zoneId: string): Promise<{ bots: BotSettings | null; problem?: string }> {
	try {
		return { bots: (await read<BotSettings>(deps, `/zones/${encodeURIComponent(zoneId)}/bot_management`)) ?? {} };
	} catch (error) {
		return {
			bots: null,
			problem: refused(error) ? "Add Zone → Bot Management → Read to the read-only token to see the bot settings here." : `Couldn't read the bot settings: ${message(error)}`,
		};
	}
}

/** Proxied DNS records read for the zone's other hostnames: one page of them (a zone with more is said to have more). */
export const DNS_PAGE = 500;

async function readOtherHosts(deps: { token: string; fetch: Fetch }, zoneId: string, host: string): Promise<{ hosts: string[] | null; more?: boolean; problem?: string }> {
	try {
		const records = await read<Array<{ name?: string; type?: string; proxied?: boolean }>>(deps, `/zones/${encodeURIComponent(zoneId)}/dns_records?proxied=true&per_page=${DNS_PAGE}`);
		const list = Array.isArray(records) ? records : [];
		return { hosts: otherHostnames(list, host), ...(list.length >= DNS_PAGE ? { more: true } : {}) };
	} catch (error) {
		return {
			hosts: null,
			problem: refused(error)
				? "Add Zone → DNS → Read to the read-only token to list the zone's other hostnames here."
				: `Couldn't list the zone's hostnames: ${message(error)}`,
		};
	}
}

/**
 * Read the zone's settings for the checkup. Never throws: what couldn't be
 * read is in `problem` (nothing could) or in each row.
 */
export async function readCheckup(host: string, deps: CheckupDeps): Promise<CheckupResult> {
	const checkedAt = new Date((deps.now ?? Date.now)()).toISOString();
	// Finds the zone (or says why it can't) and reads Crawler Hints, as the Discovery page does.
	const hints = await readCrawlerHints(host, { token: deps.token, fetch: deps.fetch, knownZone: deps.knownZone ?? null, now: deps.now });
	const local = { trackingWrapper: deps.trackingWrapper, trackingState: deps.trackingState ?? null, speculationOn: deps.speculationOn, robotsOn: deps.robotsOn };
	if (!hints.zone || !deps.token) {
		// Only what doesn't need Cloudflare: the tracking-parameter row.
		const rows = checkupRows({ zone: null, settings: null, bots: null, crawlerHints: null, ...local }).filter((r) => !r.zoneWide);
		const problem =
			!deps.token || hints.problem?.kind === "no-token"
				? {
						kind: "no-token" as const,
						message:
							"To read the zone's settings, the pack needs a read-only Cloudflare API token with Zone → Read and Zone Settings → Read. The Performance page's Cloudflare usage token works once those permissions are added to it.",
					}
				: (hints.problem ?? { kind: "error" as const, message: "Couldn't find the site's zone." });
		return { host, zone: null, problem, rows, otherHosts: null, checkedAt };
	}
	const zone: CheckupZone = hints.zone;
	const access = { token: deps.token, fetch: deps.fetch };
	const [settings, bots, others] = await Promise.all([readSettings(access, zone.id), readBots(access, zone.id), readOtherHosts(access, zone.id, host)]);
	const rows = checkupRows({
		zone,
		settings: settings.settings,
		settingsProblem: settings.problem,
		bots: bots.bots,
		botsProblem: bots.problem,
		crawlerHints: hints.enabled,
		crawlerHintsProblem: hints.problem?.message,
		...local,
	});
	return {
		host,
		zone,
		// A token that finds the zone but can't read its settings: the page shows the steps to add the permission.
		...(settings.problem ? { problem: { kind: settings.refused ? ("no-access" as const) : ("error" as const), message: settings.problem } } : {}),
		rows,
		otherHosts: others.hosts,
		...(others.more ? { otherHostsMore: true } : {}),
		...(others.problem ? { otherHostsProblem: others.problem } : {}),
		checkedAt,
	};
}

/** The zone that holds `host`, looked up with `token` (Zone → Read), most specific name first. */
export async function findZone(host: string, deps: { token: string; fetch: Fetch }): Promise<CheckupZone | null> {
	for (const name of zoneCandidates(host)) {
		const found = await read<Array<{ id?: string; name?: string; account?: { id?: string } }>>(deps, `/zones?name=${encodeURIComponent(name)}&per_page=5`);
		const zone = (Array.isArray(found) ? found : []).find((z) => z.name === name && typeof z.id === "string");
		if (zone?.id) return { id: zone.id, name, accountId: zone.account?.id ?? null };
	}
	return null;
}

export interface FixResult {
	fix: FixId;
	zone: string;
	setting: string;
	changed: boolean;
	before: unknown;
	after: unknown;
	message: string;
}

/**
 * Apply one fix: read the setting, and change it only when it isn't already
 * where the fix puts it. One zone setting, nothing else. Throws
 * CloudflareApiError (without the token) when Cloudflare refuses.
 */
export async function applyFix(fix: FixId, zone: CheckupZone, deps: { token: string; fetch: Fetch }): Promise<FixResult> {
	const def = FIXES[fix];
	const path = `/zones/${encodeURIComponent(zone.id)}/settings/${def.setting}`;
	const call = { token: deps.token, fetch: deps.fetch, permission: "Zone → Zone Settings → Edit, for this zone", label: "Cloudflare's API" };
	const before = (await cloudflareApi<{ value?: unknown } | null>(path, { ...call, deadlineMs: DEADLINES.cloudflareReadMs })).result?.value;
	if (!def.needed(before)) {
		return { fix, zone: zone.name, setting: def.setting, changed: false, before, after: before, message: `Nothing to change: ${def.setting} is already ${String(before)} on ${zone.name}.` };
	}
	const after = (await cloudflareApi<{ value?: unknown } | null>(path, { ...call, method: "PATCH", body: { value: def.target } })).result?.value;
	if (after !== def.target) {
		throw new CloudflareApiError(`Cloudflare accepted the change but reports ${def.setting} as ${String(after)}. Check it in the dashboard.`, 200);
	}
	return { fix, zone: zone.name, setting: def.setting, changed: true, before, after, message: `Done: ${def.change(before)} on ${zone.name}.` };
}

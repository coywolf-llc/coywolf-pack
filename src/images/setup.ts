/**
 * Media host setup on Cloudflare: the zone's URL-rewrite rules and a pure
 * planner that compares what's there with what's needed. No I/O and no
 * imports, so tests can load it directly; the API calls are in cloudflare.ts.
 *
 * The three steps, each skipped when already done:
 *   1. Image Transformations on for the zone (zone setting `transformations`).
 *   2. The media host as a custom domain on the media bucket (R2).
 *   3. Two URL-rewrite rules (phase http_request_transform) mapping
 *      /s/<w>x<h>/<file> and /s/<w>/<file> to /cdn-cgi/image/… on that host.
 *      Other rules in the phase are kept as they are.
 */

/** A rule in a ruleset, as the API returns it (only the fields we read or send back). */
export interface RulesetRule {
	id?: string;
	ref?: string;
	description?: string;
	expression?: string;
	action?: string;
	action_parameters?: Record<string, unknown>;
	enabled?: boolean;
	logging?: unknown;
	[key: string]: unknown;
}

export interface CustomDomain {
	domain: string;
	enabled?: boolean;
	zoneId?: string;
	zoneName?: string;
	status?: { ownership?: string; ssl?: string };
}

/** What's on Cloudflare now. `rules` is null when the zone has no http_request_transform ruleset yet. */
export interface SetupState {
	transformations: string | null;
	domains: CustomDomain[];
	rules: RulesetRule[] | null;
	/** Smart Tiered Cache ("on"/"off"), or null when it couldn't be read (the step then tries to turn it on). */
	tieredCache?: string | null;
}

export type StepAction = "none" | "enable" | "add" | "update";

export interface SetupStep {
	id: "transformations" | "domain" | "rules" | "tieredCache";
	action: StepAction;
	/** Plain-language summary, e.g. "Turn on Image Transformations for example.com". */
	label: string;
}

export interface SetupPlan {
	host: string;
	steps: SetupStep[];
	/** The full rule list to PUT when the rules step isn't "none" (unrelated rules first, in their order). */
	rules: RulesetRule[];
	/** True when nothing needs to change. */
	done: boolean;
}

const TAG = "(Coywolf Pack clean image URLs)";

/** The two URL-rewrite rules for a media host name (e.g. "media.example.com"). */
export function mediaHostRules(hostname: string): RulesetRule[] {
	const host = `http.host eq "${hostname}"`;
	return [
		{
			description: `${hostname}: /s/<W>x<H>/<file> → cropped resize ${TAG}`,
			expression: `(${host} and http.request.uri.path wildcard "/s/*x*/*")`,
			action: "rewrite",
			action_parameters: {
				uri: { path: { expression: 'wildcard_replace(http.request.uri.path, "/s/*x*/*", "/cdn-cgi/image/width=${1},height=${2},fit=cover,format=auto,quality=85/${3}")' } },
			},
			enabled: true,
		},
		{
			description: `${hostname}: /s/<W>/<file> → resize to width ${TAG}`,
			expression: `(${host} and http.request.uri.path wildcard "/s/*/*" and not http.request.uri.path wildcard "/s/*x*/*")`,
			action: "rewrite",
			action_parameters: {
				uri: { path: { expression: 'wildcard_replace(http.request.uri.path, "/s/*/*", "/cdn-cgi/image/width=${1},format=auto,quality=85/${2}")' } },
			},
			enabled: true,
		},
	];
}

/** Is this one of our rules for `hostname` (matched by description)? */
export function isOurRule(rule: RulesetRule, hostname: string): boolean {
	const d = rule.description ?? "";
	return d.startsWith(`${hostname}: `) && d.endsWith(TAG);
}

/** Fields the API accepts back for a rule we keep (it rejects or ignores read-only ones like version and last_updated). */
const KEEP_FIELDS = ["id", "ref", "action", "action_parameters", "description", "enabled", "expression", "logging", "ratelimit", "exposed_credential_check"];

export function sendableRule(rule: RulesetRule): RulesetRule {
	const out: RulesetRule = {};
	for (const key of KEEP_FIELDS) if (rule[key] !== undefined) out[key] = rule[key];
	return out;
}

const pathExpression = (rule: RulesetRule) =>
	((rule.action_parameters as { uri?: { path?: { expression?: string } } } | undefined)?.uri?.path?.expression ?? "").trim();

function sameRule(a: RulesetRule, b: RulesetRule): boolean {
	return (
		a.description === b.description &&
		(a.expression ?? "").trim() === (b.expression ?? "").trim() &&
		a.action === b.action &&
		pathExpression(a) === pathExpression(b) &&
		a.enabled !== false
	);
}

/** The host name of a media host origin or bare name ("https://media.example.com" → "media.example.com"). */
export function hostnameOf(host: string): string {
	return host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

/**
 * Zone names to try for a host, most specific first: media.blog.example.co.uk →
 * blog.example.co.uk, example.co.uk, co.uk. (The API answers only for zones
 * in the account, so the first match is the zone.)
 */
export function zoneCandidates(hostname: string): string[] {
	const labels = hostname.split(".");
	const out: string[] = [];
	for (let i = 1; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
	return out;
}

/** Compare the current state with what the media host needs. */
export function planMediaHostSetup(state: SetupState, input: { host: string; zoneName: string; bucket: string }): SetupPlan {
	const hostname = hostnameOf(input.host);
	const steps: SetupStep[] = [];

	steps.push(
		state.transformations === "on"
			? { id: "transformations", action: "none", label: `Image Transformations are already on for ${input.zoneName}.` }
			: { id: "transformations", action: "enable", label: `Turn on Image Transformations for ${input.zoneName}.` },
	);

	const domain = state.domains.find((d) => d.domain.toLowerCase() === hostname);
	steps.push(
		!domain
			? { id: "domain", action: "add", label: `Connect ${hostname} to the R2 bucket ${input.bucket} as a custom domain.` }
			: domain.enabled === false
				? { id: "domain", action: "enable", label: `Turn on ${hostname}, already connected to the R2 bucket ${input.bucket}.` }
				: { id: "domain", action: "none", label: `${hostname} is already connected to the R2 bucket ${input.bucket}.` },
	);

	const wanted = mediaHostRules(hostname);
	const existing = state.rules ?? [];
	const ours = existing.filter((r) => isOurRule(r, hostname));
	const upToDate = ours.length === wanted.length && wanted.every((w) => ours.some((o) => sameRule(o, w)));
	let rules: RulesetRule[] = [];
	if (upToDate) {
		steps.push({ id: "rules", action: "none", label: `The 2 URL rewrite rules for ${hostname} are already in place.` });
	} else {
		// Keep every unrelated rule where it is; ours go where the first old one of ours was, or at the end.
		const firstOurs = existing.findIndex((r) => isOurRule(r, hostname));
		const others = existing.filter((r) => !isOurRule(r, hostname)).map(sendableRule);
		const at = firstOurs === -1 ? others.length : existing.slice(0, firstOurs).filter((r) => !isOurRule(r, hostname)).length;
		rules = [...others.slice(0, at), ...wanted, ...others.slice(at)];
		steps.push(
			ours.length
				? { id: "rules", action: "update", label: `Update the URL rewrite rules for ${hostname} (other rules stay as they are).` }
				: {
						id: "rules",
						action: "add",
						label: `Add 2 URL rewrite rules for ${hostname}${others.length ? ` (the zone's ${others.length} other rule${others.length === 1 ? "" : "s"} stay as they are)` : ""}.`,
					},
		);
	}

	// Smart Tiered Cache: a data center that hasn't cached an image yet asks a nearby upper-tier
	// Cloudflare cache (placed near the R2 bucket) before going back to R2. Free on every plan.
	// (Pages don't need it: Workers Cache is always tiered.) Only ever turned on, never off.
	steps.push(
		state.tieredCache === "on"
			? { id: "tieredCache", action: "none", label: `Smart Tiered Cache is already on for ${input.zoneName}.` }
			: {
					id: "tieredCache",
					action: "enable",
					label: `Turn on Smart Tiered Cache for ${input.zoneName}, so a data center that hasn't cached an image yet gets it from a nearby Cloudflare cache instead of R2.`,
				},
	);

	return { host: hostname, steps, rules, done: steps.every((s) => s.action === "none") };
}

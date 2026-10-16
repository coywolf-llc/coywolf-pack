/**
 * Robots.txt rules: the stored model, rendering each rule to directive lines,
 * resolving which lines each crawler ends up with (RFC 9309 group selection),
 * and generating the served robots.txt with EmDash's own lines kept intact.
 *
 * Only imports ./rep.ts (no runtime dependencies), so the tests run it under
 * plain Node.
 */
import { type Directive, escapePattern, evaluateParsed, matchRaw, parse, toBytes } from "./rep.js";

/**
 * Stored rule kinds. The admin's guided flow offers a smaller set of plain
 * choices (everything / a section / one page / a kind of file / links with
 * parameters / an advanced pattern) that map onto these; the rest stay for
 * rules saved by earlier versions and for imported files.
 */
export const RULE_KINDS = [
	"entire_site",
	"folder",
	"prefix",
	"single_page",
	"exact_url",
	"filetype",
	"filetype_in_folder",
	"contains",
	"any_depth",
	"query_any",
	"query_param",
	"wildcard_prefix",
	"allow_exception",
	"custom",
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export interface RobotsRule {
	id: string;
	/** Plain-English name, written as a comment above the group. */
	name: string;
	description?: string;
	enabled: boolean;
	/** robots.txt product tokens ("*" for every crawler). */
	agents: string[];
	/** Disallow (block) or Allow. `allow_exception` always writes both. */
	directive: "allow" | "disallow";
	kind: RuleKind;
	path?: string;
	/** Legacy single extension (filetype kinds). */
	ext?: string;
	/** Extensions for the filetype kinds (wins over `ext`). */
	exts?: string[];
	/** Query parameter names for `query_param` (wins over `path`); a trailing `*` matches any name starting with it. */
	params?: string[];
	/** For `allow_exception`: the item to allow inside the blocked folder. */
	allow?: string;
	/** For `single_page`: append `$` so nothing past the path matches. */
	strict?: boolean;
	/** For `folder`: also match a folder with this name at any depth (`/*\/name/`). */
	anyDepth?: boolean;
	/** For blocking rules: paths inside the blocked area that stay allowed (written as more specific Allow lines). */
	except?: string[];
	/** The crawler group picked in the guided flow (see CRAWLER_GROUPS), for plain-English summaries. */
	group?: string;
	/** Where the rule came from. */
	source?: "user" | "import" | "template" | "legacy";
}

export interface RobotsConfig {
	/** 2 since Coywolf Pack 0.7.0; missing on configs saved by earlier versions. */
	version?: number;
	rules: RobotsRule[];
	/** Write EmDash's `Sitemap: <site>/sitemap.xml` line. */
	includeSitemap: boolean;
	/** More sitemap URLs (absolute, or site-relative paths). */
	sitemaps: string[];
	/** Let crawlers fetch media files, which EmDash serves from /_emdash/api/media/. */
	allowMedia: boolean;
	/** Write each rule's name as a comment. */
	comments: boolean;
	/** Raw lines appended before the sitemaps (e.g. a Content-Signal line). */
	extra: string;
	/**
	 * Crawlers named in a rule also keep the rules for all crawlers (copied
	 * into their group), except where their own rules say otherwise. Without
	 * this, RFC 9309 makes a named crawler ignore every `User-agent: *` rule.
	 */
	inheritGeneral: boolean;
	/** Keep EmDash's admin and API (/_emdash/) out for every crawler. */
	emdashLines: boolean;
	/** Set when the rules were created from EmDash's robots.txt. */
	importedAt?: string;
	importMode?: "rules" | "verbatim";
	/** What the import did, in plain English (shown with "What's being served"). */
	importNotes?: string[];
	/** Keep discovery files (/.well-known/, llms.txt, and `discoveryPaths`) reachable for every crawler. */
	discoveryAllowances: boolean;
	/** More discovery paths to keep reachable (site-relative). */
	discoveryPaths: string[];
	/**
	 * Not stored: what other modules' features add, filled in at generation
	 * time from the feature switches (see automaticFrom).
	 */
	automatic?: AutomaticInfo;
}

export interface AutomaticInfo {
	/** discovery.llms is on (Discovery serves /llms.txt). */
	llms: boolean;
	/** EmDash's Settings > SEO "Disallow AI training" is on: its AI-training lines are added (EMDASH_AI_TRAINING). */
	aiTraining?: boolean;
}

/** Machine-discovery locations kept reachable by default (RFC 8615 well-known URIs cover security.txt, ai-plugin.json and future manifests). */
export const WELL_KNOWN_PATH = "/.well-known/";
/** Only llms.txt by default: llms-full.txt carries the full site text, so adding it is the owner's call (a discovery path). */
export const LLMS_PATHS = ["/llms.txt"];

/** What the pack's other features (and EmDash's "Disallow AI training" setting) add to robots.txt. */
export function automaticFrom(features: Record<string, boolean | undefined>, aiTraining = false): AutomaticInfo {
	return { llms: Boolean(features["discovery.llms"]), aiTraining };
}

/** AI training crawlers and opt-out tokens EmDash's "Disallow AI training" names (emdash/src/astro/routes/robots.txt.ts, 1.3.0). */
export const EMDASH_AI_TRAINING_CRAWLERS = ["Amazonbot", "Applebot-Extended", "Bytespider", "CCBot", "ClaudeBot", "Google-Extended", "GPTBot", "meta-externalagent"];

/**
 * The lines EmDash adds to its robots.txt when "Disallow AI training" is on,
 * word for word, so the setting does the same while the pack serves the file.
 * The empty Disallow closes the `*` group (Content-Signal isn't a rule).
 */
export const EMDASH_AI_TRAINING = [
	"# Disallow AI training",
	"User-agent: *",
	"Content-Signal: search=yes, ai-train=no",
	"Disallow:",
	...EMDASH_AI_TRAINING_CRAWLERS.flatMap((agent) => ["", `User-agent: ${agent}`, "Disallow: /"]),
].join("\n");

/** The discovery paths every crawler keeps (empty when the allowance is off). */
export function discoveryPathsFor(config: Pick<RobotsConfig, "discoveryAllowances" | "discoveryPaths" | "automatic">): string[] {
	if (!config.discoveryAllowances) return [];
	const own = (config.discoveryPaths ?? []).map((p) => encodeValue(clean(p))).filter((p) => p.startsWith("/") && p.length > 1);
	return [...new Set([WELL_KNOWN_PATH, ...(config.automatic?.llms ? LLMS_PATHS : []), ...own])];
}

export const CONFIG_VERSION = 2;

export const DEFAULT_CONFIG: RobotsConfig = {
	version: CONFIG_VERSION,
	rules: [],
	includeSitemap: true,
	sitemaps: [],
	allowMedia: true,
	comments: true,
	extra: "",
	inheritGeneral: true,
	emdashLines: true,
	discoveryAllowances: true,
	discoveryPaths: [],
};

export const EMDASH_ADMIN_PATH = "/_emdash/";
export const EMDASH_MEDIA_PATH = "/_emdash/api/media/";
/** Longest Allow/Disallow value accepted (longer than any real URL). */
export const MAX_VALUE_LENGTH = 2083;

/** A robots.txt product token: letters, digits, `.`, `_`, `-` (or `*`). */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidToken(token: string): boolean {
	return token === "*" || TOKEN_RE.test(token);
}

export class RobotsValidationError extends Error {}

const lead = (p: string) => {
	const t = p.trim();
	return !t || t.startsWith("/") || t.startsWith("*") ? t : `/${t}`;
};
const dirPath = (p: string) => {
	const t = lead(p);
	if (!t) return "/";
	return t.endsWith("/") ? t : `${t}/`;
};
const ensureStar = (p: string) => (p.endsWith("*") ? p : `${p}*`);
/** robots.txt values can't contain whitespace or comments. */
const clean = (v: string) => v.replace(/[\s#]+/g, "");
/** Percent-encode non-ASCII bytes and uppercase %xx escapes, as crawlers compare them. */
export const encodeValue = (v: string) => escapePattern(toBytes(v));

/**
 * Normalize what a person typed or pasted as a path: strip a full URL down to
 * its path and query, drop a #fragment, encode spaces and non-ASCII, and add
 * the leading slash. Keeps `*` and `$` (pattern characters).
 */
export function normalizePathInput(input: string, siteUrl = ""): { value: string; notes: string[] } {
	const notes: string[] = [];
	let v = input.trim();
	const m = /^(https?:)?\/\/([^/?#]+)(.*)$/i.exec(v);
	if (m) {
		const host = m[2].toLowerCase();
		const siteHost = (/^https?:\/\/([^/?#]+)/i.exec(siteUrl)?.[1] ?? "").toLowerCase();
		const bare = (h: string) => h.replace(/^www\./, "");
		if (siteHost && bare(host) !== bare(siteHost)) notes.push(`That address is on ${host}, not this site; only its path is used.`);
		v = m[3] || "/";
	}
	const hash = v.indexOf("#");
	if (hash !== -1) {
		v = v.slice(0, hash);
		notes.push("The #part of an address is never sent to servers, so it was left out.");
	}
	if (/\s/.test(v)) {
		v = v.replace(/\s/g, "%20");
		notes.push("Spaces are written as %20, the way browsers send them.");
	}
	const encoded = encodeValue(v);
	if (encoded !== v && /[^\x00-\x7f]/.test(v)) notes.push(`Written as ${encoded} (the way browsers send it).`);
	return { value: lead(encoded), notes };
}

export interface DirectiveLine {
	directive: "Allow" | "Disallow";
	value: string;
}

/** File extensions for the filetype kinds. */
export function ruleExts(rule: Pick<RobotsRule, "ext" | "exts">): string[] {
	const list = rule.exts?.length ? rule.exts : rule.ext ? [rule.ext] : [];
	return [...new Set(list.map((e) => clean(e).replace(/^\.+/, "").toLowerCase()).filter(Boolean))];
}

/** Query parameter names for `query_param`. */
export function ruleParams(rule: Pick<RobotsRule, "params" | "path">): string[] {
	const list = rule.params?.length ? rule.params : rule.path ? [rule.path] : [];
	return [...new Set(list.map((p) => clean(p).replace(/^[?&]+/, "").replace(/=+$/, "")).filter(Boolean))];
}

/** The directive line(s) a rule writes (no User-agent lines). */
export function directives(rule: RobotsRule): DirectiveLine[] {
	const path = clean(rule.path ?? "");
	const allow = clean(rule.allow ?? "");
	const dir: DirectiveLine["directive"] = rule.directive === "allow" ? "Allow" : "Disallow";
	const line = (value: string, d = dir): DirectiveLine => ({ directive: d, value: encodeValue(value) });
	let out: DirectiveLine[];
	switch (rule.kind) {
		case "entire_site":
			out = [line("/")];
			break;
		case "folder": {
			const folder = dirPath(path);
			out = [line(folder)];
			if (rule.anyDepth && folder !== "/") out.push(line(`/*${folder}`));
			break;
		}
		case "prefix":
			out = [line(lead(path))];
			break;
		case "single_page":
			out = [line(lead(path).replace(/\$+$/, "") + (rule.strict ? "$" : ""))];
			break;
		case "exact_url":
			out = [line(`${lead(path).replace(/\$+$/, "")}$`)];
			break;
		case "filetype":
			out = ruleExts(rule).map((ext) => line(`/*.${ext}$`));
			break;
		case "filetype_in_folder":
			out = ruleExts(rule).map((ext) => line(`${dirPath(path)}*.${ext}$`));
			break;
		case "contains":
			out = [line(`/*${path.replace(/^\/+/, "")}`)];
			break;
		case "any_depth":
			out = [line(`/*/${path.replace(/^\/+|\/+$/g, "")}/`)];
			break;
		case "query_any":
			out = [line("/*?")];
			break;
		case "query_param":
			out = ruleParams(rule).flatMap((p) => {
				const name = p.endsWith("*") ? p.replace(/\*+$/, "") : `${p}=`;
				return [line(`/*?${name}`), line(`/*&${name}`)];
			});
			break;
		case "wildcard_prefix":
			out = [line(ensureStar(lead(path)))];
			break;
		case "allow_exception":
			out = allow ? [line(dirPath(path), "Disallow"), line(lead(allow), "Allow")] : [line(dirPath(path), "Disallow")];
			break;
		default:
			out = [line(path)];
	}
	if (rule.directive === "disallow" && rule.except?.length) {
		for (const e of rule.except) {
			const v = clean(e);
			if (v) out.push(line(lead(v), "Allow"));
		}
	}
	const seen = new Set<string>();
	return out.filter((l) => {
		const k = `${l.directive}:${l.value}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/** Throws RobotsValidationError when a rule can't produce a sensible directive. */
export function validateRule(rule: RobotsRule): void {
	if (!rule.name.trim()) throw new RobotsValidationError("Give the rule a name.");
	if (!rule.agents.length) throw new RobotsValidationError("Pick at least one crawler (or * for all).");
	for (const agent of rule.agents) {
		if (!isValidToken(agent)) {
			throw new RobotsValidationError(
				`"${agent}" isn't a robots.txt user-agent token (letters, digits, dot, dash and underscore, no spaces).`,
			);
		}
	}
	const needsPath = !["entire_site", "query_any", "filetype", "query_param"].includes(rule.kind);
	if (needsPath && !clean(rule.path ?? "")) throw new RobotsValidationError("This rule type needs a path.");
	if (rule.kind === "filetype" || rule.kind === "filetype_in_folder") {
		const exts = ruleExts(rule);
		if (!exts.length || exts.some((e) => !/^[A-Za-z0-9]+$/.test(e))) throw new RobotsValidationError("Enter a file extension such as pdf.");
	}
	if (rule.kind === "query_param") {
		const params = ruleParams(rule);
		if (!params.length) throw new RobotsValidationError("Enter a parameter name such as utm_source.");
		for (const p of params) {
			if (!/^[A-Za-z0-9._~%[\]-]+\*?$/.test(p)) throw new RobotsValidationError(`"${p}" isn't a query parameter name (letters, digits, . _ ~ - and %, optionally ending in *).`);
		}
	}
	if (rule.kind === "custom" && !/^[/*]/.test(clean(rule.path ?? ""))) {
		throw new RobotsValidationError("A custom value must start with / or *.");
	}
	for (const d of directives(rule)) {
		if (d.value.length > MAX_VALUE_LENGTH) {
			throw new RobotsValidationError(`"${d.value.slice(0, 40)}…" is ${d.value.length} characters long; the most is ${MAX_VALUE_LENGTH}.`);
		}
	}
}

const oneLine = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** Values that must stay on one line and can't contain spaces (URLs, tokens): drop all whitespace, including CR/LF. */
const singleLine = (s: string | undefined) => (s ?? "").replace(/\s+/g, "");

function uniq(list: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of list) {
		const key = item.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			out.push(item);
		}
	}
	return out;
}

/** Paths a whole-site block must cover: the home page, any page, and EmDash media. */
const WHOLE_SITE_PROBES = ["/", "/any/page.html?x=1", `${EMDASH_MEDIA_PATH}file/a.jpg`];

/** Whether a Disallow value blocks every URL (`/`, `/*`, `*`, `/**`…), unlike e.g. `/$` (home page only). */
export function blocksWholeSite(value: string): boolean {
	return value !== "" && WHOLE_SITE_PROBES.every((p) => matchRaw(value, p));
}

/* ------------------------------------------------------------------ *
 * Sample URLs: paths a pattern is meant to match (used by the
 * inheritance logic, the validator and the self-check).
 * ------------------------------------------------------------------ */

/** Concrete paths that a (normalized) pattern matches, a few per pattern. */
export function samplePaths(pattern: string): string[] {
	if (!pattern) return [];
	const anchored = pattern.endsWith("$");
	const body = anchored ? pattern.slice(0, -1) : pattern;
	const out = new Set<string>();
	for (const fill of ["x", "a/b", ""]) {
		let p = body.replace(/\*/g, fill);
		if (!p.startsWith("/")) p = `/${p}`;
		out.add(p);
		if (anchored) continue;
		out.add(p.endsWith("/") ? `${p}deep/page.html` : `${p}/deep/page.html`);
		out.add(`${p}${p.includes("?") ? "&" : "?"}q=1`);
	}
	return [...out].filter((p) => !p.startsWith("//") && matchRaw(pattern, p)).slice(0, 8);
}

/* ------------------------------------------------------------------ *
 * Which lines each crawler ends up with.
 * ------------------------------------------------------------------ */

export interface ResolvedLine extends DirectiveLine {
	/** Rule ids that produced this line; empty for EmDash's own lines. */
	ruleIds: string[];
	system?: boolean;
	/** Copied from the rules for all crawlers. */
	inherited?: boolean;
	/** Added because another feature is on (Discovery's llms.txt and Markdown). */
	auto?: boolean;
}

export interface ResolvedGroup {
	agents: string[];
	lines: ResolvedLine[];
}

/** A token no rule names, standing in for "any other crawler". */
export const PROBE_AGENT = "CoywolfPackProbeBot";

const priority = (value: string) => value.length;

/** Longest match wins; Allow wins ties (Google). Lines must be normalized. */
export function decide(lines: DirectiveLine[], path: string): { allowed: boolean; line: DirectiveLine | null } {
	let best: DirectiveLine | null = null;
	for (const l of lines) {
		if (!l.value || !matchRaw(l.value, path)) continue;
		if (
			!best ||
			priority(l.value) > priority(best.value) ||
			(priority(l.value) === priority(best.value) && l.directive === "Allow" && best.directive === "Disallow")
		) {
			best = l;
		}
	}
	return { allowed: !best || best.directive === "Allow", line: best };
}

/** Whether line `s` matches every sample path of line `g` (so it governs where g would apply). */
function covers(s: DirectiveLine, g: DirectiveLine): boolean {
	const samples = samplePaths(g.value);
	return samples.length > 0 && samples.every((p) => matchRaw(s.value, p));
}

function enabledRules(config: RobotsConfig) {
	return config.rules
		.filter((r) => r.enabled)
		.map((r) => ({ ...r, agents: r.agents.map(singleLine).filter(isValidToken) }))
		.filter((r) => r.agents.length);
}

function addLine(list: ResolvedLine[], line: DirectiveLine, ruleId: string | null, extra: Partial<ResolvedLine> = {}) {
	const have = list.find((l) => l.directive === line.directive && l.value === line.value);
	if (have) {
		if (ruleId && !have.ruleIds.includes(ruleId)) have.ruleIds.push(ruleId);
		return;
	}
	list.push({ ...line, ruleIds: ruleId ? [ruleId] : [], ...extra });
}

/**
 * The lines each crawler follows. `*` gets the rules for all crawlers; each
 * named crawler gets its own rules plus (when `inheritGeneral` is on) the
 * general rules its own rules don't already decide; EmDash's admin block
 * (and the media Allow) go to everyone not blocked from the whole site.
 * Returns a map keyed by lowercased token ("*" for the general group).
 */
export function resolveAgents(config: RobotsConfig): Map<string, { token: string; lines: ResolvedLine[]; order: number }> {
	const rules = enabledRules(config);
	const out = new Map<string, { token: string; lines: ResolvedLine[]; order: number }>();
	const general: ResolvedLine[] = [];
	let order = 0;
	rules.forEach((rule) => {
		const lines = directives(rule);
		for (const agent of uniq(rule.agents)) {
			const key = agent.toLowerCase();
			if (key === "*") {
				for (const l of lines) addLine(general, l, rule.id);
				if (!out.has("*")) out.set("*", { token: "*", lines: general, order: order++ });
				continue;
			}
			let entry = out.get(key);
			if (!entry) {
				entry = { token: agent, lines: [], order: order++ };
				out.set(key, entry);
			}
			for (const l of lines) addLine(entry.lines, l, rule.id);
		}
	});

	if (config.inheritGeneral) {
		for (const [key, entry] of out) {
			if (key === "*") continue;
			const own = [...entry.lines];
			const ownAllows = own.some((l) => l.directive === "Allow");
			for (const g of general) {
				if (own.some((s) => s.value === g.value)) continue;
				const decided = own.some((s) => covers(s, g) && (s.directive !== g.directive || !ownAllows));
				if (decided) continue;
				entry.lines.push({ ...g, ruleIds: [...g.ruleIds], inherited: true });
			}
		}
	}

	if (config.emdashLines && !out.has("*")) out.set("*", { token: "*", lines: general, order: order++ });
	for (const entry of out.values()) {
		const blocked = WHOLE_SITE_PROBES.slice(0, 2).every((p) => !decide(entry.lines, p).allowed);
		if (blocked) continue;
		const mediaBlocked = !decide(entry.lines, WHOLE_SITE_PROBES[2]).allowed;
		if (config.allowMedia && (config.emdashLines || mediaBlocked)) addLine(entry.lines, { directive: "Allow", value: EMDASH_MEDIA_PATH }, null, { system: true });
		if (config.emdashLines) addLine(entry.lines, { directive: "Disallow", value: EMDASH_ADMIN_PATH }, null, { system: true });
	}
	// Discovery files: any crawler that would be blocked from one gets an Allow for it.
	const discovery = discoveryPathsFor(config);
	for (const entry of out.values()) {
		for (const value of discovery) {
			const probe = samplePaths(value)[0] ?? value;
			if (!decide(entry.lines, probe).allowed) addLine(entry.lines, { directive: "Allow", value }, null, { system: true, auto: true });
		}
	}
	return out;
}

/** The lines a crawler follows according to the rules (the model the self-check compares the file against). */
export function linesForAgent(resolved: ReturnType<typeof resolveAgents>, token: string): ResolvedLine[] {
	return resolved.get(token.toLowerCase())?.lines ?? resolved.get("*")?.lines ?? [];
}

/** Most specific lines first (so first-match crawlers agree with longest-match ones); Allow first on ties. */
function sortLines(lines: ResolvedLine[]): ResolvedLine[] {
	return lines
		.map((l, i) => ({ l, i }))
		.sort((a, b) => priority(b.l.value) - priority(a.l.value) || (a.l.directive === b.l.directive ? 0 : a.l.directive === "Allow" ? -1 : 1) || a.i - b.i)
		.map((x) => x.l);
}

/** Crawlers with identical lines share one group, in the order they first appear in the rules. */
export function resolveGroups(config: RobotsConfig): ResolvedGroup[] {
	const resolved = resolveAgents(config);
	const groups = new Map<string, ResolvedGroup & { order: number }>();
	for (const entry of [...resolved.values()].sort((a, b) => a.order - b.order)) {
		if (!entry.lines.length) continue;
		const lines = sortLines(entry.lines);
		const key = lines.map((l) => `${l.directive}:${l.value}`).join("\n");
		const g = groups.get(key);
		if (g) {
			g.agents.push(entry.token);
			for (const l of lines) {
				const mine = g.lines.find((x) => x.directive === l.directive && x.value === l.value);
				if (mine) for (const id of l.ruleIds) if (!mine.ruleIds.includes(id)) mine.ruleIds.push(id);
			}
		} else groups.set(key, { agents: [entry.token], lines: lines.map((l) => ({ ...l, ruleIds: [...l.ruleIds] })), order: entry.order });
	}
	return [...groups.values()].sort((a, b) => a.order - b.order).map(({ agents, lines }) => ({ agents, lines }));
}

export interface GenerateOptions {
	/** Site origin without a trailing slash, e.g. "https://wellbeing.io". */
	siteUrl: string;
}

/**
 * Build robots.txt: one group per set of crawlers that follow the same lines
 * (most specific line first), then Extra lines, then sitemaps.
 */
export function generate(config: RobotsConfig, options: GenerateOptions): string {
	const siteUrl = singleLine(options.siteUrl).replace(/\/+$/, "");
	const rules = enabledRules(config);
	const names = new Map(rules.map((r) => [r.id, oneLine(r.name)]));
	const out: string[] = config.comments ? ["# robots.txt managed by Coywolf Pack (Robots.txt Rules): https://github.com/coywolf-llc/coywolf-pack", ""] : [];

	for (const group of resolveGroups(config)) {
		if (config.comments) {
			const labels = uniq(group.lines.filter((l) => !l.inherited).flatMap((l) => l.ruleIds.map((id) => names.get(id) ?? "")).filter(Boolean));
			if (group.lines.some((l) => l.inherited)) labels.push("rules for all crawlers");
			if (group.lines.some((l) => l.auto)) labels.push("discovery files stay readable");
			if (group.lines.some((l) => l.system && !l.auto)) labels.push(config.allowMedia ? "EmDash admin and API (media stays crawlable)" : "EmDash admin and API");
			if (labels.length) out.push(`# ${labels.join("; ")}`);
		}
		for (const agent of group.agents) out.push(`User-agent: ${agent}`);
		for (const l of group.lines) out.push(`${l.directive}: ${l.value}`);
		out.push("");
	}

	const extra = config.extra.trim();
	if (extra) out.push(extra, "");

	// After everything else, as EmDash adds it after its whole file: Extra lines without a User-agent of their own stay with the group they follow.
	if (config.automatic?.aiTraining) out.push(EMDASH_AI_TRAINING, "");

	for (const s of sitemapUrls(config, siteUrl)) out.push(`Sitemap: ${s}`);

	return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** The Sitemap URLs a config writes. */
export function sitemapUrls(config: Pick<RobotsConfig, "includeSitemap" | "sitemaps">, siteUrl: string): string[] {
	const site = singleLine(siteUrl).replace(/\/+$/, "");
	const sitemaps: string[] = [];
	if (config.includeSitemap) sitemaps.push(`${site}/sitemap.xml`);
	for (const s of config.sitemaps) {
		const t = singleLine(s);
		if (!t) continue;
		sitemaps.push(/^https?:\/\//i.test(t) ? t : `${site}${lead(t)}`);
	}
	return uniq(sitemaps);
}

/* ------------------------------------------------------------------ *
 * Stored config: normalizing and migrating.
 * ------------------------------------------------------------------ */

const EQUIV_PATHS = ["/", "/a-post/", "/private/x", "/_emdash/admin", "/_emdash/api/content/x", `${EMDASH_MEDIA_PATH}file/a.jpg`, "/x.pdf", "/?q=1"];

/** Whether two robots.txt bodies give every listed crawler the same verdict on every listed path (plus each line's samples). */
export function sameVerdicts(a: string, b: string, agents: string[], extraPaths: string[] = []): boolean {
	const da = parse(a).directives;
	const db = parse(b).directives;
	const paths = new Set([...EQUIV_PATHS, ...extraPaths]);
	for (const d of [...da, ...db]) if (d.type === "allow" || d.type === "disallow") for (const p of samplePaths(d.value)) paths.add(p);
	for (const agent of agents) {
		for (const p of paths) {
			if (evaluateParsed(da, [agent], p).allowed !== evaluateParsed(db, [agent], p).allowed) return false;
		}
	}
	return true;
}

/**
 * Normalize untrusted stored/posted config (missing fields get defaults).
 * Configs saved before 0.7.0 (no `version`) never copied general rules into
 * named crawlers' groups; they turn that on only when it changes nothing.
 */
export function normalizeConfig(input: Partial<RobotsConfig> | null | undefined): RobotsConfig {
	const config: RobotsConfig = {
		version: CONFIG_VERSION,
		rules: Array.isArray(input?.rules) ? input.rules.map(normalizeRule) : [],
		includeSitemap: input?.includeSitemap ?? DEFAULT_CONFIG.includeSitemap,
		sitemaps: Array.isArray(input?.sitemaps) ? input.sitemaps.filter((s) => typeof s === "string") : [],
		allowMedia: input?.allowMedia ?? DEFAULT_CONFIG.allowMedia,
		comments: input?.comments ?? DEFAULT_CONFIG.comments,
		extra: typeof input?.extra === "string" ? input.extra : "",
		inheritGeneral: typeof input?.inheritGeneral === "boolean" ? input.inheritGeneral : true,
		emdashLines: typeof input?.emdashLines === "boolean" ? input.emdashLines : true,
		discoveryAllowances: typeof input?.discoveryAllowances === "boolean" ? input.discoveryAllowances : true,
		discoveryPaths: Array.isArray(input?.discoveryPaths) ? input.discoveryPaths.filter((p) => typeof p === "string") : [],
		...(input?.importedAt ? { importedAt: input.importedAt } : {}),
		...(input?.importMode ? { importMode: input.importMode } : {}),
		...(Array.isArray(input?.importNotes) ? { importNotes: input.importNotes.filter((n) => typeof n === "string") } : {}),
	};
	if (input && !input.version && typeof input.inheritGeneral !== "boolean") {
		const legacy = { ...config, inheritGeneral: false, comments: false };
		const modern = { ...legacy, inheritGeneral: true };
		const site = { siteUrl: "https://example.com" };
		const agents = [PROBE_AGENT, ...new Set(config.rules.flatMap((r) => r.agents))].filter((a) => a !== "*");
		config.inheritGeneral = sameVerdicts(generate(legacy, site), generate(modern, site), agents);
	}
	return config;
}

function normalizeRule(rule: RobotsRule): RobotsRule {
	return {
		...rule,
		name: typeof rule.name === "string" ? rule.name : "",
		enabled: rule.enabled !== false,
		agents: Array.isArray(rule.agents) ? rule.agents.filter((a) => typeof a === "string") : [],
		directive: rule.directive === "allow" ? "allow" : "disallow",
		kind: (RULE_KINDS as readonly string[]).includes(rule.kind) ? rule.kind : "custom",
	};
}

/* ------------------------------------------------------------------ *
 * Crawler groups, presets and templates.
 * ------------------------------------------------------------------ */

export interface CrawlerGroup {
	id: string;
	label: string;
	/** Lowercase phrase for sentences ("AI training crawlers"). */
	phrase: string;
	description: string;
	/**
	 * Members: bundled bots whose documented purpose matches and whose token
	 * is verified (see src/robots/data/verified.json → purposes; a test keeps
	 * this list and the data in step). Radar-only bots never join a group.
	 */
	tokens: string[];
	/** Purposes this group stands for; verified custom bots with one of these join it too. */
	purposes: string[];
}

export const CRAWLER_GROUPS: CrawlerGroup[] = [
	{
		id: "search_engines",
		label: "Search engines",
		phrase: "search engines",
		description: "Google, Bing, Apple, DuckDuckGo, Yandex, Baidu and Huawei Petal Search. Blocking them removes pages from search results.",
		tokens: ["Googlebot", "Googlebot-Image", "Googlebot-Video", "Googlebot-News", "bingbot", "Applebot", "DuckDuckBot", "YandexBot", "Baiduspider", "PetalBot"],
		purposes: ["search-engine"],
	},
	{
		id: "ai_training",
		label: "AI training",
		phrase: "AI training crawlers",
		description: "Crawlers whose operators say they collect pages to train AI models (GPTBot, ClaudeBot, Google-Extended, CCBot, Amazonbot…). Blocking them doesn't affect search.",
		tokens: [
			"GPTBot",
			"ClaudeBot",
			"Google-Extended",
			"Applebot-Extended",
			"CCBot",
			"meta-externalagent",
			"Bytespider",
			"Amazonbot",
			"MistralAI-Training",
			"Webzio-Extended",
		],
		purposes: ["training"],
	},
	{
		id: "ai_search",
		label: "AI search and assistants",
		phrase: "AI search and assistant crawlers",
		description: "AI answer engines and assistants that fetch pages to answer questions and cite them (ChatGPT search, Perplexity, Claude…). Their operators say they don't train on them.",
		tokens: [
			"OAI-SearchBot",
			"Claude-SearchBot",
			"PerplexityBot",
			"Amzn-SearchBot",
			"MistralAI-Index",
			"ChatGPT-User",
			"Claude-User",
			"Perplexity-User",
			"meta-externalfetcher",
			"MistralAI-User",
			"DuckAssistBot",
			"Amzn-User",
		],
		purposes: ["ai-search", "ai-assistant"],
	},
	{
		id: "seo_tools",
		label: "SEO tools",
		phrase: "SEO tool crawlers",
		description: "Backlink and site-audit crawlers (Ahrefs, Semrush, Majestic, Moz…). They don't send visitors.",
		tokens: ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "BLEXBot", "DataForSeoBot", "Barkrowler"],
		purposes: ["seo"],
	},
];

export interface DirectoryBot {
	token: string;
	category: string;
	status: string;
	purpose?: string;
	origin?: string;
}

/** The tokens in a crawler group: its curated members plus verified custom bots (added on this site) with a matching purpose. */
export function groupTokens(group: CrawlerGroup, bots: DirectoryBot[] = []): string[] {
	const custom = bots.filter((b) => b.origin === "custom" && b.status === "verified" && b.purpose && group.purposes.includes(b.purpose)).map((b) => b.token);
	return uniq([...group.tokens, ...custom]).filter(isValidToken);
}

/** Which crawler group a token list covers (all of the group's documented tokens), if any. */
export function matchGroup(agents: string[]): CrawlerGroup | undefined {
	const set = new Set(agents.map((a) => a.toLowerCase()));
	return CRAWLER_GROUPS.find((g) => g.tokens.every((t) => set.has(t.toLowerCase())));
}

/** Crawler lists the presets wrote before 0.7.0, so rules made from them can follow the presets now. */
const LEGACY_PRESET_TOKENS: Record<string, string[]> = {
	ai_training: ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended", "CCBot", "meta-externalagent", "Bytespider", "Amazonbot", "MistralAI-Training", "Webzio-Extended", "ImagesiftBot"],
	ai_search: ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "meta-externalfetcher", "MistralAI-User", "DuckAssistBot", "Amzn-User"],
	search_engines: ["Googlebot", "bingbot", "Applebot", "DuckDuckBot", "YandexBot", "Baiduspider"],
	seo_tools: ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "BLEXBot", "DataForSeoBot", "Barkrowler"],
};

export interface GroupChange {
	ruleId: string;
	ruleName: string;
	group: string;
	added: string[];
	removed: string[];
}

/**
 * Rules whose crawlers came from a preset (they carry its id, or match a
 * pre-0.7.0 preset list exactly) get the preset's current members.
 */
export function refreshGroups(config: RobotsConfig, bots: DirectoryBot[] = []): { config: RobotsConfig; changes: GroupChange[] } {
	const changes: GroupChange[] = [];
	const rules = config.rules.map((rule) => {
		let groupId = rule.group;
		if (!groupId) {
			const set = new Set(rule.agents.map((a) => a.toLowerCase()));
			groupId = Object.keys(LEGACY_PRESET_TOKENS).find((id) => {
				const list = LEGACY_PRESET_TOKENS[id];
				return list.length === set.size && list.every((t) => set.has(t.toLowerCase()));
			});
		}
		const group = groupId ? CRAWLER_GROUPS.find((g) => g.id === groupId) : undefined;
		if (!group) return rule;
		const next = groupTokens(group, bots);
		const have = new Set(rule.agents.map((a) => a.toLowerCase()));
		const want = new Set(next.map((a) => a.toLowerCase()));
		const added = next.filter((t) => !have.has(t.toLowerCase()));
		const removed = rule.agents.filter((t) => !want.has(t.toLowerCase()));
		if (!added.length && !removed.length && rule.group === group.id) return rule;
		if (added.length || removed.length) changes.push({ ruleId: rule.id, ruleName: rule.name, group: group.id, added, removed });
		return { ...rule, agents: next, group: group.id };
	});
	return { config: { ...config, rules }, changes };
}

const groupById = (id: string) => CRAWLER_GROUPS.find((g) => g.id === id) as CrawlerGroup;

/**
 * Starting points offered in the admin ("named rules"). Tokens are checked against operators' documentation.
 * No AI-training preset: EmDash's Settings > SEO "Disallow AI training" covers it (see EMDASH_AI_TRAINING).
 */
export const PRESETS: Array<Omit<RobotsRule, "id" | "enabled">> = [
	{
		name: "Block AI search and assistants",
		description: "Keep AI answer engines and on-demand AI fetchers out. Your pages won't be cited in their answers.",
		directive: "disallow",
		kind: "entire_site",
		agents: [...groupById("ai_search").tokens],
		group: "ai_search",
	},
	{
		name: "Allow search engines",
		description: "Explicitly allow the major search engines everywhere EmDash allows them.",
		directive: "allow",
		kind: "entire_site",
		agents: [...groupById("search_engines").tokens],
		group: "search_engines",
	},
	{
		name: "Block SEO tool crawlers",
		description: "Stop backlink and SEO-audit crawlers that don't send visitors.",
		directive: "disallow",
		kind: "entire_site",
		agents: [...groupById("seo_tools").tokens],
		group: "seo_tools",
	},
];

export interface Template {
	id: string;
	name: string;
	description: string;
	rules: (bots: DirectoryBot[]) => Array<Omit<RobotsRule, "id">>;
}

/** One-click starting points. They replace the rule list and go through the same checks as any change. */
export const TEMPLATES: Template[] = [
	{
		id: "allow-everything",
		name: "Allow everything",
		description: "Every crawler can crawl every page. EmDash's admin stays private and media stays crawlable.",
		rules: () => [],
	},
	{
		id: "search-only",
		name: "Block everything except search engines",
		description: "Only search engines can crawl the site. Every other crawler, including AI crawlers and SEO tools, is blocked.",
		rules: (bots) => [
			{
				name: "Block all crawlers",
				description: "Everything is closed to crawlers that aren't search engines.",
				enabled: true,
				directive: "disallow",
				kind: "entire_site",
				agents: ["*"],
				source: "template",
			},
			{
				name: "Let search engines in",
				description: "Search engines can crawl the whole site.",
				enabled: true,
				directive: "allow",
				kind: "entire_site",
				agents: groupTokens(groupById("search_engines"), bots),
				group: "search_engines",
				source: "template",
			},
		],
	},
];

export type { Directive };

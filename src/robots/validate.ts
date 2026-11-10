/**
 * Real-time validation of a rule against the existing rules, and the
 * self-check that proves the generated file does what the rules say.
 *
 * Findings have a severity:
 * - error: can't be saved (the server refuses it too);
 * - warning: valid but risky or surprising; the admin must confirm ("Add it anyway");
 * - info: an explanation of how the rule interacts with others.
 *
 * Verdicts come from the real matcher (./rep.ts) on the generated text, so
 * the checks see exactly what crawlers will see.
 */
import { type Directive, evaluateParsed, matchRaw, parse } from "./rep.js";
import { describeRule, listPhrase } from "./explain.js";
import {
	CRAWLER_GROUPS,
	type DirectoryBot,
	EMDASH_ADMIN_PATH,
	EMDASH_MEDIA_PATH,
	discoveryPathsFor,
	MAX_VALUE_LENGTH,
	PROBE_AGENT,
	type RobotsConfig,
	type RobotsRule,
	RobotsValidationError,
	blocksWholeSite,
	decide,
	directives,
	generate,
	isValidToken,
	linesForAgent,
	resolveAgents,
	samplePaths,
	validateRule,
} from "./rules.js";

export type Severity = "error" | "warning" | "info";

export type FixAction =
	| { type: "addAgents"; agents: string[] }
	| { type: "turnOnInherit" }
	| { type: "editRule"; ruleId: string }
	| { type: "mergeInto"; ruleId: string };

export interface Finding {
	code: string;
	severity: Severity;
	message: string;
	fix?: { label: string; action: FixAction };
}

/** Search engine tokens checked by the "you'd vanish from search" warnings. */
export const SEARCH_ENGINES = (CRAWLER_GROUPS.find((g) => g.id === "search_engines") as { tokens: string[] }).tokens;

const RENDER_ASSETS = ["/_astro/index.css", "/_astro/page.js", "/assets/site.css", "/scripts/app.js", "/images/photo.jpg", "/favicon.ico"];
const MEDIA_SAMPLE = `${EMDASH_MEDIA_PATH}file/photo.jpg`;
const ADMIN_SAMPLE = `${EMDASH_ADMIN_PATH}admin/`;
const SITEMAP_SAMPLES = ["/sitemap.xml", "/sitemap-index.xml"];

const key = (a: string) => a.toLowerCase();
const agentsOf = (rule: Pick<RobotsRule, "agents">) => [...new Set(rule.agents.map(key))];
/** The tokens to test a rule with: its own, with `*` standing in as a crawler no rule names. */
const testAgents = (rule: Pick<RobotsRule, "agents">) => rule.agents.map((a) => (a === "*" ? PROBE_AGENT : a));

class Verdicts {
	private parsed: Directive[];
	text: string;
	constructor(text: string) {
		this.text = text;
		this.parsed = parse(text).directives;
	}
	allowed(agent: string, path: string): boolean {
		return evaluateParsed(this.parsed, [agent], path).allowed;
	}
	line(agent: string, path: string) {
		return evaluateParsed(this.parsed, [agent], path);
	}
}

const SITE = { siteUrl: "https://example.com" };

/** Shape errors for one rule (empty when fine). */
export function shapeFindings(rule: RobotsRule): Finding[] {
	const out: Finding[] = [];
	const raw = [rule.path ?? "", rule.allow ?? "", ...(rule.except ?? []), ...(rule.params ?? []), ...(rule.exts ?? [])];
	for (const v of raw) {
		// Control characters in the pattern: rejecting control characters.
		if (/[\u0000-\u001f\u007f]/.test(v)) out.push({ code: "bad-chars", severity: "error", message: "Remove the line break or control character; each rule must stay on one line." });
		else if (v.includes("#")) out.push({ code: "bad-chars", severity: "error", message: "Remove the #. Everything after # is a comment in robots.txt, and the #part of an address never reaches the server." });
	}
	for (const a of rule.agents) {
		if (!isValidToken(a)) out.push({ code: "bad-token", severity: "error", message: `“${a}” isn't a crawler token. Tokens use letters, digits, dot, dash and underscore, with no spaces (like GPTBot).` });
	}
	if ((rule.kind === "custom" || rule.kind === "prefix" || rule.kind === "wildcard_prefix") && rule.path && !/^[/*]/.test(rule.path.trim())) {
		out.push({ code: "leading-slash", severity: "error", message: "A pattern must start with / (a path on your site) or * (anything)." });
	}
	try {
		validateRule(rule);
	} catch (error) {
		if (error instanceof RobotsValidationError && !out.length) out.push({ code: "invalid", severity: "error", message: error.message });
	}
	// "Except…" items must sit inside the area the rule blocks, and mustn't reopen all of it.
	if (rule.directive === "disallow" && rule.except?.some((e) => e.trim())) {
		const lines = safeDirectives({ ...rule, except: [] }).filter((d) => d.directive === "Disallow");
		const blockSamples = [...new Set(lines.flatMap((d) => samplePaths(d.value)))];
		for (const raw of rule.except.filter((e) => e.trim())) {
			const e = safeDirectives({ ...rule, kind: "custom", path: "/x/", except: [raw] }).find((d) => d.directive === "Allow")?.value ?? raw;
			const own = samplePaths(e);
			const inside = own.length > 0 && own.every((p) => lines.some((d) => matchRaw(d.value, p)));
			const neutralizes = blockSamples.length > 0 && blockSamples.every((p) => matchRaw(e, p));
			if (neutralizes) out.push({ code: "except-everything", severity: "error", message: `The exception “${raw}” would reopen everything this rule blocks. Remove it, or turn the rule off instead.` });
			else if (!inside) out.push({ code: "except-outside", severity: "error", message: `The exception “${raw}” isn't inside the area this rule blocks, so it would open something else. Exceptions must be inside ${lines.map((d) => d.value).join(" or ")}.` });
		}
	}
	for (const d of safeDirectives(rule)) {
		if (d.value.length > MAX_VALUE_LENGTH) out.push({ code: "too-long", severity: "error", message: `That pattern is ${d.value.length} characters long. The most is ${MAX_VALUE_LENGTH}; real addresses are shorter.` });
	}
	const seen = new Set<string>();
	return out.filter((f) => (seen.has(f.message) ? false : (seen.add(f.message), true)));
}

function safeDirectives(rule: RobotsRule) {
	try {
		return directives(rule);
	} catch {
		return [];
	}
}

const ruleName = (r: RobotsRule) => `“${r.name || describeRule(r)}”`;

/**
 * Everything worth saying about adding (or editing) `draft` in `config`.
 * `bots` (optional) adds token checks against the crawler directory.
 */
export function analyzeRule(config: RobotsConfig, draft: RobotsRule, options: { siteUrl?: string; bots?: Array<DirectoryBot & { name?: string; custom?: boolean }> } = {}): Finding[] {
	const findings = shapeFindings(draft);
	if (findings.some((f) => f.severity === "error")) return findings;
	const siteUrl = options.siteUrl || SITE.siteUrl;
	const others = config.rules.filter((r) => r.id !== draft.id && r.enabled);
	const before: RobotsConfig = { ...config, rules: config.rules.filter((r) => r.id !== draft.id) };
	const after: RobotsConfig = { ...config, rules: [...before.rules, { ...draft, enabled: true }] };
	const draftLines = directives(draft);
	const draftAgents = agentsOf(draft);

	// Duplicates and contradictions with rules for the same crawlers.
	for (const other of others) {
		const shared = agentsOf(other).filter((a) => draftAgents.includes(a));
		if (!shared.length) continue;
		const who = shared.includes("*") ? "all crawlers" : listPhrase(shared.map((s) => other.agents.find((a) => key(a) === s) ?? s));
		const otherLines = directives(other);
		const same = draftLines.filter((d) => otherLines.some((o) => o.value === d.value && o.directive === d.directive));
		const opposite = draftLines.filter((d) => otherLines.some((o) => o.value === d.value && o.directive !== d.directive));
		if (opposite.length) {
			findings.push({
				code: "contradiction",
				severity: "error",
				message: `${ruleName(other)} already ${opposite[0].directive === "Allow" ? "blocks" : "allows"} ${opposite[0].value} for ${who}. A rule can't both allow and block the same thing; change or turn off that rule instead.`,
				fix: { label: `Edit ${ruleName(other)}`, action: { type: "editRule", ruleId: other.id } },
			});
		} else if (same.length === draftLines.length && shared.length === draftAgents.length) {
			findings.push({
				code: "duplicate",
				severity: "error",
				message: `${ruleName(other)} already does exactly this for ${who}.`,
				fix: { label: `Edit ${ruleName(other)}`, action: { type: "editRule", ruleId: other.id } },
			});
		} else if (same.length === draftLines.length && other.directive === draft.directive && other.kind === draft.kind && (other.path ?? "") === (draft.path ?? "")) {
			findings.push({
				code: "duplicate-partial",
				severity: "info",
				message: `${ruleName(other)} already does this for ${who}. You could add the other crawlers to that rule instead of keeping two.`,
				fix: { label: `Merge into ${ruleName(other)}`, action: { type: "mergeInto", ruleId: other.id } },
			});
		}
	}
	if (findings.some((f) => f.severity === "error")) return findings;

	const vb = new Verdicts(generate(before, { siteUrl }));
	const va = new Verdicts(generate(after, { siteUrl }));
	const intended = draft.directive === "allow";
	const resolvedBefore = resolveAgents(before);
	const resolvedAfter = resolveAgents(after);
	const agents = testAgents(draft);
	const samples = [...new Set(draftLines.filter((d) => d.directive === (intended ? "Allow" : "Disallow")).flatMap((d) => samplePaths(d.value)))];

	// What the rule actually changes for its own crawlers.
	let changed = 0;
	let unchanged = 0;
	const overriddenBy = new Map<string, Set<string>>();
	for (const agent of agents) {
		for (const p of samples) {
			const b = vb.allowed(agent, p);
			const a = va.allowed(agent, p);
			if (a !== b) changed++;
			else unchanged++;
			if (a !== intended) {
				const d = decide(linesForAgent(resolvedAfter, agent), p).line as { ruleIds?: string[]; system?: boolean; directive?: string } | null;
				const by = d?.system ? (d.directive === "Allow" ? "the “Keep media crawlable” setting" : "EmDash's admin protection") : (d?.ruleIds ?? []).map((id) => config.rules.find((r) => r.id === id)).filter(Boolean).map((r) => ruleName(r as RobotsRule))[0];
				if (by) {
					const set = overriddenBy.get(by) ?? new Set<string>();
					set.add(p);
					overriddenBy.set(by, set);
				}
			}
		}
	}
	if (samples.length && !changed) {
		if (intended) {
			findings.push({
				code: "allow-no-effect",
				severity: "warning",
				message: `Nothing blocks ${describeRule(draft).replace(/^Let /, "").replace(/ crawl /, " from ")} now, so this rule changes nothing today. It's harmless, and it can matter later if you block a wider area.`,
			});
		} else if (agents.some((a) => samples.some((p) => (decide(linesForAgent(resolvedAfter, a), p).line as { system?: boolean } | null)?.system))) {
			findings.push({
				code: "media",
				severity: "warning",
				message: `Your media library (${EMDASH_MEDIA_PATH}) stays crawlable because “Keep media crawlable” is on in Settings, so this rule changes nothing. Turn that setting off to block media.`,
			});
		} else {
			const by = [...overriddenBy.keys()];
			const cover = coveringRule(config, others, draft, samples, resolvedBefore);
			findings.push({
				code: "redundant-block",
				severity: "warning",
				message: cover ? `${ruleName(cover)} already blocks this for these crawlers, so this rule changes nothing.` : `These crawlers are already blocked here${by.length ? ` by ${by[0]}` : ""}, so this rule changes nothing.`,
				...(cover ? { fix: { label: `Edit ${ruleName(cover)}`, action: { type: "editRule" as const, ruleId: cover.id } } } : {}),
			});
		}
	} else if (overriddenBy.size) {
		for (const [by, paths] of overriddenBy) {
			findings.push({
				code: "overridden",
				severity: "info",
				message: `On ${listPhrase([...paths].slice(0, 2))}, ${by} still decides, because it's more specific (longer match wins in robots.txt).`,
			});
		}
	}

	// An allow carved out of a block: valid, explain it.
	if (intended && changed) {
		const blockers = new Set<string>();
		for (const agent of agents) {
			for (const p of samples) {
				if (vb.allowed(agent, p)) continue;
				const d = decide(linesForAgent(resolvedBefore, agent), p).line as { ruleIds?: string[] } | null;
				for (const id of d?.ruleIds ?? []) {
					const r = config.rules.find((x) => x.id === id);
					if (r) blockers.add(ruleName(r));
				}
			}
		}
		if (blockers.size) {
			findings.push({
				code: "nested-allow",
				severity: "info",
				message: `This opens a gap inside ${listPhrase([...blockers])}. That's fine: the more specific line wins, so these crawlers can fetch this part and stay blocked from the rest.`,
			});
		}
	}

	// RFC 9309 group selection: naming a crawler takes it out of the `*` group.
	const generalRules = others.filter((r) => r.agents.includes("*"));
	const newlyNamed = draft.agents.filter((a) => a !== "*" && !resolvedBefore.has(key(a)));
	if (newlyNamed.length && generalRules.length) {
		const affected = newlyNamed.filter((a) => generalRules.some((g) => directives(g).some((d) => samplePaths(d.value).some((p) => vb.allowed(a, p) !== va.allowed(a, p) && !samples.includes(p)))));
		if (affected.length) {
			findings.push(
				config.inheritGeneral
					? {
							code: "group-selection",
							severity: "info",
							message: `Naming ${listPhrase(affected)} here gives ${affected.length === 1 ? "it its own group" : "them their own group"}; this rule decides where it overlaps the rules for all crawlers (${listPhrase(generalRules.map(ruleName))}).`,
						}
					: {
							code: "group-selection",
							severity: "warning",
							message: `Crawlers named in a rule ignore every rule for all crawlers (RFC 9309). ${listPhrase(affected)} would stop following ${listPhrase(generalRules.map(ruleName))}.`,
							fix: { label: "Keep the general rules for named crawlers", action: { type: "turnOnInherit" } },
						},
			);
		}
	}

	// A rule for all crawlers that some named crawlers won't follow.
	if (draft.agents.includes("*")) {
		const skip: string[] = [];
		for (const [k, entry] of resolvedAfter) {
			if (k === "*" || draftAgents.includes(k)) continue;
			if (samples.some((p) => va.allowed(entry.token, p) !== intended && va.allowed(PROBE_AGENT, p) === intended)) skip.push(entry.token);
		}
		if (skip.length) {
			findings.push({
				code: "general-overridden",
				severity: "warning",
				message: `${listPhrase(skip)} ${skip.length === 1 ? "has its own rule" : "have their own rules"} for this part of the site, so ${skip.length === 1 ? "it" : "they"} won't follow this one.`,
				fix: { label: `Also apply it to ${skip.length === 1 ? skip[0] : `these ${skip.length} crawlers`}`, action: { type: "addAgents", agents: skip } },
			});
		}
	}

	// Discovery files stay readable; a rule aimed at one has no effect while the allowance is on.
	if (!intended) {
		const hit = discoveryPathsFor(config).filter((path) => {
			const probe = samplePaths(path)[0] ?? path;
			return draftLines.some((d) => d.directive === "Disallow" && !blocksWholeSite(d.value) && matchRaw(d.value, probe));
		});
		if (hit.length) {
			findings.push({
				code: "discovery-path",
				severity: "warning",
				message: `${listPhrase(hit)} ${hit.length === 1 ? "is a discovery file" : "are discovery files"} that Coywolf Pack keeps readable for every crawler, so this rule won't block ${hit.length === 1 ? "it" : "them"}. To block ${hit.length === 1 ? "it" : "them"}, turn off “Keep discovery files readable” in Settings and history.`,
			});
		}
	}

	findings.push(...riskFindings(vb, va, [...new Set([...agents, ...SEARCH_ENGINES, PROBE_AGENT])]));

	if (options.bots) {
		const byToken = new Map(options.bots.map((b) => [key(b.token), b]));
		const unknown = draft.agents.filter((a) => a !== "*" && !byToken.has(key(a)));
		const unverified = draft.agents.filter((a) => byToken.get(key(a))?.status === "unverified");
		if (unknown.length) findings.push({ code: "unknown-token", severity: "info", message: `${listPhrase(unknown)} ${unknown.length === 1 ? "isn't" : "aren't"} in the crawler directory. A rule only works if the crawler uses exactly that token.` });
		if (unverified.length) findings.push({ code: "unverified-token", severity: "info", message: `${listPhrase(unverified)}: the token isn't confirmed by the operator's documentation, so the crawler may not follow it.` });
	}
	if (draft.path && /[A-Z]/.test(draft.path) && draft.kind !== "custom") {
		findings.push({ code: "case", severity: "info", message: "Addresses are case-sensitive: this won't cover the same address written in lowercase." });
	}
	return findings;
}

function coveringRule(config: RobotsConfig, others: RobotsRule[], draft: RobotsRule, samples: string[], resolved: ReturnType<typeof resolveAgents>): RobotsRule | undefined {
	for (const agent of testAgents(draft)) {
		const d = decide(linesForAgent(resolved, agent), samples[0] ?? "/").line as { ruleIds?: string[] } | null;
		const id = d?.ruleIds?.[0];
		const r = id ? others.find((x) => x.id === id) : undefined;
		if (r) return r;
	}
	return config.rules.length ? undefined : undefined;
}

/** Consequences of a change that hurt sites in ways people don't expect. */
export function riskFindings(vb: { allowed(a: string, p: string): boolean }, va: { allowed(a: string, p: string): boolean }, agents: string[]): Finding[] {
	const out: Finding[] = [];
	const newly = (a: string, p: string) => vb.allowed(a, p) && !va.allowed(a, p);
	const search = agents.filter((a) => SEARCH_ENGINES.includes(a) || a === PROBE_AGENT);
	const goneFromSearch = search.filter((a) => newly(a, "/") || newly(a, "/some-page/"));
	if (goneFromSearch.length) {
		const named = goneFromSearch.filter((a) => a !== PROBE_AGENT);
		out.push({
			code: "search-whole-site",
			severity: "warning",
			message: named.length
				? `${listPhrase(named)} would be blocked from your pages, so your site would drop out of their search results.`
				: "Every crawler without its own rule would be blocked from the whole site, including search engines that aren't named in a rule.",
		});
	}
	const stillOpen = search.filter((a) => va.allowed(a, "/some-page/"));
	const assets = stillOpen.filter((a) => RENDER_ASSETS.some((p) => newly(a, p)));
	if (assets.length) {
		out.push({
			code: "render-assets",
			severity: "warning",
			message: "This blocks CSS, JavaScript or images that search engines need to render your pages. Pages may look broken to Google and rank worse.",
		});
	}
	const media = stillOpen.filter((a) => newly(a, MEDIA_SAMPLE));
	if (media.length) {
		out.push({
			code: "media",
			severity: "warning",
			message: `This blocks your media library (EmDash serves uploads from ${EMDASH_MEDIA_PATH}), so your images won't show up in image search.`,
		});
	}
	if (agents.some((a) => SITEMAP_SAMPLES.some((p) => newly(a, p)) && va.allowed(a, "/some-page/"))) {
		out.push({ code: "sitemap", severity: "warning", message: "This blocks your sitemap, which tells search engines what to crawl." });
	}
	if (agents.some((a) => !vb.allowed(a, ADMIN_SAMPLE) && va.allowed(a, ADMIN_SAMPLE))) {
		out.push({ code: "admin", severity: "warning", message: `This opens EmDash's admin and API (${EMDASH_ADMIN_PATH}) to crawlers. They can't sign in, but there's nothing there worth crawling.` });
	}
	return out;
}

/** Warnings for replacing the whole config (templates, restores, resets). */
export function analyzeConfigChange(before: RobotsConfig, after: RobotsConfig, siteUrl = SITE.siteUrl): Finding[] {
	const vb = new Verdicts(generate(before, { siteUrl }));
	const va = new Verdicts(generate(after, { siteUrl }));
	const agents = [...new Set([...SEARCH_ENGINES, PROBE_AGENT, ...after.rules.flatMap((r) => r.agents).filter((a) => a !== "*")])];
	return riskFindings(vb, va, agents);
}

export interface SelfCheckFailure {
	ruleId: string;
	ruleName: string;
	agent: string;
	path: string;
	expected: boolean;
	actual: boolean;
	/** The robots.txt line that decided it. */
	decidedBy: string;
	reason: string;
}

/**
 * Proves the generated file does what the rules say. For every enabled rule:
 * 1. each of its crawlers (a stand-in for `*`) gets, on URLs the rule targets,
 *    the verdict the rule model gives (the rule's action, unless a more
 *    specific rule decides);
 * 2. crawlers the rule doesn't name get the same verdict on those URLs with
 *    and without the rule.
 * The file is parsed and evaluated with the real matcher, so Extra lines,
 * grouping and encoding are all covered.
 */
export function selfCheck(config: RobotsConfig, siteUrl = SITE.siteUrl, limit = 5): { ok: boolean; failures: SelfCheckFailure[] } {
	const text = generate(config, { siteUrl });
	const v = new Verdicts(text);
	const lines = text.split("\n");
	const resolved = resolveAgents(config);
	const failures: SelfCheckFailure[] = [];
	const enabled = config.rules.filter((r) => r.enabled);
	const bystanders = [PROBE_AGENT, "Googlebot", ...new Set(enabled.flatMap((r) => r.agents).filter((a) => a !== "*"))];

	for (const rule of enabled) {
		if (failures.length >= limit) break;
		const ruleLines = safeDirectives(rule);
		const samples = [...new Set(ruleLines.flatMap((d) => samplePaths(d.value)))];
		const own = testAgents(rule).filter(isValidToken);
		for (const agent of own) {
			for (const p of samples) {
				const expected = decide(linesForAgent(resolved, agent), p).allowed;
				const verdict = v.line(agent, p);
				if (verdict.allowed !== expected) {
					const decidedBy = verdict.matchedLine ? (lines[verdict.matchedLine - 1] ?? "").trim() : "no line";
					failures.push({
						ruleId: rule.id,
						ruleName: rule.name,
						agent: agent === PROBE_AGENT ? "*" : agent,
						path: p,
						expected,
						actual: verdict.allowed,
						decidedBy,
						reason: `${agent === PROBE_AGENT ? "Crawlers" : agent} should be ${expected ? "allowed" : "blocked"} on ${p}, but the file ${verdict.allowed ? "allows" : "blocks"} it (decided by “${decidedBy}”${config.extra.trim() ? "; check Extra lines" : ""}).`,
					});
					break;
				}
			}
			if (failures.length >= limit) break;
		}
		const others = bystanders.filter((a) => !rule.agents.some((x) => key(x) === key(a)) && !(rule.agents.includes("*") && !resolved.has(key(a))));
		if (!others.length || rule.agents.includes("*")) continue;
		const without = new Verdicts(generate({ ...config, rules: config.rules.filter((r) => r.id !== rule.id) }, { siteUrl }));
		for (const agent of others) {
			const p = samples.find((s) => without.allowed(agent, s) !== v.allowed(agent, s));
			if (p) {
				failures.push({
					ruleId: rule.id,
					ruleName: rule.name,
					agent: agent === PROBE_AGENT ? "*" : agent,
					path: p,
					expected: without.allowed(agent, p),
					actual: v.allowed(agent, p),
					decidedBy: "",
					reason: `This rule is only for ${listPhrase(rule.agents)}, but it changes what ${agent === PROBE_AGENT ? "other crawlers" : agent} may fetch on ${p}.`,
				});
				break;
			}
		}
	}
	// Automatic lines (Discovery): every crawler that got one must really be able to fetch that file.
	for (const [k, entry] of resolved) {
		if (failures.length >= limit) break;
		const agent = k === "*" ? PROBE_AGENT : entry.token;
		for (const l of entry.lines.filter((x) => x.auto)) {
			const p = samplePaths(l.value)[0];
			if (p && !v.allowed(agent, p)) {
				failures.push({
					ruleId: "",
					ruleName: "Discovery files",
					agent: k === "*" ? "*" : entry.token,
					path: p,
					expected: true,
					actual: false,
					decidedBy: (lines[v.line(agent, p).matchedLine - 1] ?? "").trim(),
					reason: `${k === "*" ? "Crawlers" : entry.token} should be able to read ${p} because it's a discovery file, but the file blocks it${config.extra.trim() ? "; check Extra lines" : ""}.`,
				});
				break;
			}
		}
	}
	return { ok: failures.length === 0, failures };
}

/** Risks that Extra lines add (e.g. a raw `Disallow: /` for everyone). Shown, but they don't block saving. */
export function extraLineWarnings(config: RobotsConfig, siteUrl = SITE.siteUrl): Finding[] {
	if (!config.extra.trim()) return [];
	return analyzeConfigChange({ ...config, extra: "" }, config, siteUrl).map((f) => ({ ...f, message: `Extra lines: ${f.message}` }));
}

/** Server-side gate before saving: shape errors, contradictions, and the self-check. */
export function checkConfig(config: RobotsConfig, siteUrl = SITE.siteUrl): string | null {
	const enabled = config.rules.filter((r) => r.enabled);
	for (const rule of enabled) {
		const error = shapeFindings(rule).find((f) => f.severity === "error");
		if (error) return `${ruleName(rule)}: ${error.message}`;
	}
	for (let i = 0; i < enabled.length; i++) {
		for (let j = i + 1; j < enabled.length; j++) {
			const a = enabled[i];
			const b = enabled[j];
			if (!agentsOf(a).some((x) => agentsOf(b).includes(x))) continue;
			const la = directives(a);
			const lb = directives(b);
			const clash = la.find((d) => lb.some((o) => o.value === d.value && o.directive !== d.directive));
			if (clash) return `${ruleName(a)} and ${ruleName(b)} both allow and block ${clash.value} for the same crawlers. Change or turn off one of them.`;
		}
	}
	const check = selfCheck(config, siteUrl, 1);
	if (!check.ok) {
		const f = check.failures[0];
		return `Self-check failed for “${f.ruleName}”: ${f.reason}`;
	}
	return null;
}

/**
 * Custom markup for Schema & Social: JSON-LD an editor writes for one page,
 * added to the page the way EmDash adds all JSON-LD: as a page:metadata
 * contribution `{ kind: "jsonld", id: "coywolf-custom:<rule>", graph }`,
 * which EmDash dedupes by id (the first contribution wins) and serializes
 * safely for a <script> element. A theme or another plugin can replace a
 * rule's markup by contributing the same id first.
 *
 * A rule targets what EmDash's page context describes: an entry
 * (`content.collection` + `content.id`, set in the entry's Overrides, so it
 * follows the entry when its slug changes) or an exact path (`path`, for
 * pages in the site's code such as a hardcoded home page). An entry's rule
 * wins over a path rule for the same page.
 *
 * Pure (only type imports from emdash): parsing, validation, path matching
 * and reference resolution, shared by the save routes, the page hook and
 * the admin page, which runs the same checks live before saving.
 */
import { type LintWarning, lintNodes } from "./custom-lint.js";

export type { LintWarning } from "./custom-lint.js";

type Node = Record<string, unknown>;
export type TrailingSlash = "always" | "never" | "ignore";

// ── Stored shapes ────────────────────────────────────────────────

/** A page's custom markup, as stored. */
export interface CustomMarkup {
	/** JSON-LD source text: one node, an array of nodes, or { "@graph": [...] }. "@context" is optional (schema.org only). */
	markup: string;
	/** Off: kept but not output. */
	enabled: boolean;
	/** With the Schema.org graph on, the page's WebPage points at the first node with mainEntity. */
	mainEntity?: boolean;
}

/** A path rule (schemaDocs "custom"). Entry rules are CustomMarkup on the entry's override (schemaEntries, `custom`). */
export interface PathRule extends CustomMarkup {
	/** Stable id: the contribution id is "coywolf-custom:<id>". */
	id: string;
	/** Name in the list. */
	label: string;
	/** Exact path on this site, normalized ("/" is the home page). */
	path: string;
	updatedAt?: string;
}

export interface CustomDoc {
	rules: PathRule[];
	updatedAt?: string;
}

export const CUSTOM_DOC_ID = "custom";
export const CONTRIBUTION_PREFIX = "coywolf-custom:";
export const MAX_MARKUP_BYTES = 32 * 1024;
export const MAX_NODES = 50;
export const MAX_PATH_RULES = 100;
const MAX_DEPTH = 24;
export const RULE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const pathContributionId = (ruleId: string) => `${CONTRIBUTION_PREFIX}${ruleId}`;
export const entryContributionId = (collection: string, entryId: string) => `${CONTRIBUTION_PREFIX}entry:${collection}:${entryId}`;

const isObj = (v: unknown): v is Node => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const code = (s: string) => `\`${s}\``;

// ── Parsing ──────────────────────────────────────────────────────

const SCHEMA_CONTEXTS = new Set(["https://schema.org", "https://schema.org/", "http://schema.org", "http://schema.org/"]);

export interface ParsedMarkup {
	/** The nodes (with @context and null values taken out), also when there are errors, so they can still be linted. */
	nodes: Node[];
	errors: string[];
}

const validType = (t: unknown) =>
	(typeof t === "string" && Boolean(t.trim())) || (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string" && x.trim()));

/**
 * Parse an editor's JSON-LD: one node, an array of nodes, or an object with
 * @graph. Every @context must be schema.org (it's taken out: the
 * contribution adds its own); null values are dropped.
 */
export function parseMarkup(source: unknown): ParsedMarkup {
	const text = typeof source === "string" ? source : "";
	const fail = (error: string): ParsedMarkup => ({ nodes: [], errors: [error] });
	if (!text.trim()) return fail("Add the JSON-LD markup.");
	const bytes = new TextEncoder().encode(text).length;
	if (bytes > MAX_MARKUP_BYTES) return fail(`The markup is ${Math.ceil(bytes / 1024)} KB; the limit is ${MAX_MARKUP_BYTES / 1024} KB.`);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return fail(`This isn't valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
	}
	const errors = new Set<string>();
	const context = (v: unknown) => {
		if (v === undefined) return;
		const ok = typeof v === "string" ? SCHEMA_CONTEXTS.has(v.trim()) : Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && SCHEMA_CONTEXTS.has(x.trim()));
		if (!ok) errors.add('Only "https://schema.org" can be the @context. You can leave @context out: it\'s added for you.');
	};
	const clean = (v: unknown, depth: number): unknown => {
		if (depth > MAX_DEPTH) {
			errors.add(`The markup is nested more than ${MAX_DEPTH} levels deep.`);
			return undefined;
		}
		if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
		if (isObj(v)) {
			const out: Node = {};
			for (const [key, x] of Object.entries(v)) {
				if (key === "@context") context(x);
				else if (x !== null) {
					const c = clean(x, depth + 1);
					if (c !== undefined) out[key] = c;
				}
			}
			return out;
		}
		return v === null ? undefined : v;
	};

	let items: unknown[];
	if (Array.isArray(value)) items = value;
	else if (isObj(value) && "@graph" in value) {
		const extra = Object.keys(value).filter((k) => k !== "@graph" && k !== "@context");
		if (extra.length) errors.add(`Next to @graph, only @context is allowed: move ${extra.map(code).join(", ")} into a node.`);
		if (!Array.isArray(value["@graph"])) return fail("@graph must be an array of nodes.");
		context(value["@context"]);
		items = value["@graph"];
	} else if (isObj(value)) items = [value];
	else return fail("The markup must be a JSON object (one node), an array of nodes, or an object with @graph.");

	const nodes: Node[] = [];
	items.forEach((item, i) => {
		const label = items.length > 1 ? `Node ${i + 1}` : "The node";
		if (!isObj(item)) {
			errors.add(`${label} isn't an object.`);
			return;
		}
		const node = clean(item, 1) as Node;
		if (!validType(node["@type"])) errors.add(`${label} needs a @type, like "Service" (a string, or a list of strings).`);
		nodes.push(node);
	});
	if (!items.length) errors.add("Add at least one node.");
	if (items.length > MAX_NODES) errors.add(`A rule can have at most ${MAX_NODES} nodes.`);
	return { nodes, errors: [...errors] };
}

// ── The pack's own @ids ──────────────────────────────────────────

/**
 * Fragments of the @ids the pack's graph gives its nodes: the WebSite and
 * publisher at the site root, the WebPage, primary image, breadcrumbs and
 * Article at the page URL, authors (#person-<slug>) and videos (#video-…).
 * Custom markup links to them ({"@id": "#organization"}) but can't define them.
 */
export const PACK_FRAGMENTS = ["website", "organization", "publisher", "person", "webpage", "primaryimage", "breadcrumb", "article", "author"];
const PACK_PREFIXES = /^(person|video)-/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Resolve a relative IRI against a base (the page URL), as a JSON-LD processor would. */
export function resolveIri(value: string, base: string): string {
	const v = value.trim();
	if (SCHEME.test(v)) return v;
	try {
		return new URL(v, base).href;
	} catch {
		return v;
	}
}

export interface IdCheckOptions {
	/** The site's origin (https://example.com): ids on another site never collide. */
	origin?: string;
	/** What relative ids resolve against (the page URL); defaults to the site root. */
	base?: string;
	/** Absolute ids the pack uses on this site beyond the fixed fragments (a publisher @id from Site details). */
	reserved?: Iterable<string>;
}

function isPackId(id: string, options: IdCheckOptions, reserved: Set<string>): boolean {
	const base = options.base ?? (options.origin ? `${options.origin}/` : "https://site.invalid/");
	if (reserved.has(id) || reserved.has(resolveIri(id, base))) return true;
	const hashAt = id.indexOf("#");
	if (hashAt === -1) return false;
	const fragment = id.slice(hashAt + 1);
	if (!PACK_FRAGMENTS.includes(fragment) && !PACK_PREFIXES.test(fragment)) return false;
	const before = id.slice(0, hashAt).trim();
	if (!SCHEME.test(before) && !before.startsWith("//")) return true; // Relative: on this site.
	if (!options.origin) return true;
	try {
		return new URL(before, base).origin === new URL(options.origin).origin;
	} catch {
		return false;
	}
}

/** A reference: only @id (and @type), nothing that defines the entity. */
export const isReference = (node: Node) => typeof node["@id"] === "string" && Object.keys(node).every((k) => k === "@id" || k === "@type");

/** Errors for @ids that aren't strings, or that would redefine one of the pack's own nodes. */
export function idProblems(nodes: Node[], options: IdCheckOptions = {}): string[] {
	const reserved = new Set(options.reserved ?? []);
	const errors = new Set<string>();
	const walk = (value: unknown, depth: number) => {
		if (depth > MAX_DEPTH) return;
		if (Array.isArray(value)) return value.forEach((v) => walk(v, depth + 1));
		if (!isObj(value)) return;
		const id = value["@id"];
		if (id !== undefined && typeof id !== "string") errors.add("An @id must be a string: a URL, a path or a #name.");
		if (typeof id === "string" && !isReference(value) && isPackId(id, options, reserved)) {
			const short = id.includes("#") ? id.slice(id.indexOf("#")) : id;
			errors.add(`${code(id)} is one of the pack's own @ids. Link to it with {"@id": "${short}"} and nothing else, or give this node another @id.`);
		}
		for (const [key, v] of Object.entries(value)) if (key !== "@id") walk(v, depth + 1);
	};
	walk(nodes, 0);
	return [...errors];
}

// ── Checks (save routes and the editor) ─────────────────────────

export interface CheckOptions extends IdCheckOptions {
	/** The Schema.org graph is on (lint notes about nodes it already has). */
	graph?: boolean;
}

export interface MarkupCheck {
	nodes: Node[];
	/** Refuse the save. */
	errors: string[];
	/** Shown, never blocking. */
	warnings: LintWarning[];
}

/** Everything a save checks: parsing, @ids, and the rich-result lint. */
export function checkMarkup(markup: unknown, options: CheckOptions = {}): MarkupCheck {
	const parsed = parseMarkup(markup);
	const errors = [...parsed.errors];
	if (parsed.nodes.length) errors.push(...idProblems(parsed.nodes, options));
	const warnings = parsed.nodes.length ? lintNodes(parsed.nodes, { graph: options.graph }) : [];
	const defined = new Set<string>();
	for (const node of parsed.nodes) {
		const id = node["@id"];
		if (typeof id !== "string" || isReference(node)) continue;
		if (defined.has(id)) warnings.push({ at: String(node["@type"] ?? "Node"), message: `Two nodes have the @id ${code(id)}: only the first is used.` });
		defined.add(id);
	}
	return { nodes: parsed.nodes, errors: [...new Set(errors)], warnings };
}

// ── Paths ────────────────────────────────────────────────────────

/**
 * A rule's path as stored: a path on this site with a leading slash, no
 * query string, anchor or wildcard, and a trailing slash the site's way
 * (Astro's trailingSlash: "always" adds one, "never" removes it, "ignore"
 * keeps what was typed). "/" is the home page.
 */
export function normalizeRulePath(raw: unknown, policy?: TrailingSlash): { path: string } | { error: string } {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value) return { error: "Enter a path, like / for the home page or /pricing/." };
	if (SCHEME.test(value) || value.startsWith("//")) return { error: "Enter a path on this site, like /pricing/, not a full URL." };
	if (/[?#]/.test(value)) return { error: "Leave out the query string and #anchor: rules match the path only." };
	if (value.includes("*")) return { error: "Paths match exactly: wildcards aren't supported." };
	if (/\s/.test(value)) return { error: "A path can't contain spaces (write %20)." };
	if (value.length > 500) return { error: "That path is too long." };
	let path = (value.startsWith("/") ? value : `/${value}`).replace(/\/{2,}/g, "/");
	if (path.split("/").some((s) => s === "." || s === "..")) return { error: "A path can't contain . or .. segments." };
	if (path !== "/") {
		const bare = path.replace(/\/+$/, "");
		path = policy === "always" || (policy !== "never" && path.endsWith("/")) ? `${bare}/` : bare;
	}
	return { path };
}

/** What a path is matched by: decoded, without repeated or trailing slashes ("/" stays "/"). The request path is keyed the same way. */
export function pathKey(path: string): string {
	let p = path.split(/[?#]/)[0] || "/";
	try {
		p = decodeURI(p);
	} catch {
		// Keep it encoded.
	}
	p = p.replace(/\/{2,}/g, "/");
	if (p.length > 1) p = p.replace(/\/+$/, "");
	return p.startsWith("/") ? p || "/" : `/${p}`;
}

/** Errors for path rules that would apply to the same page (only enabled rules count). */
export function pathRuleConflicts(rules: Array<Pick<PathRule, "id" | "label" | "path" | "enabled">>): string[] {
	const byKey = new Map<string, Pick<PathRule, "label" | "path">>();
	const errors: string[] = [];
	for (const rule of rules) {
		if (!rule.enabled) continue;
		const key = pathKey(rule.path);
		const other = byKey.get(key);
		if (other) errors.push(`"${other.label || other.path}" and "${rule.label || rule.path}" are both on ${rule.path}. Turn one off, or put all the markup in one rule.`);
		else byKey.set(key, rule);
	}
	return errors;
}

// ── Matching ─────────────────────────────────────────────────────

/** A rule ready to output: its contribution id and parsed nodes. */
export interface CompiledRule {
	contributionId: string;
	label: string;
	nodes: Node[];
	mainEntity: boolean;
}

/** Enabled path rules by path key, parsed once (cached with the module's config). Rules that don't parse are left out. */
export function compilePathRules(doc: CustomDoc | null | undefined): Map<string, CompiledRule> {
	const out = new Map<string, CompiledRule>();
	for (const rule of doc?.rules ?? []) {
		if (!rule?.enabled || typeof rule.path !== "string" || typeof rule.id !== "string") continue;
		const key = pathKey(rule.path);
		if (out.has(key)) continue;
		const { nodes, errors } = parseMarkup(rule.markup);
		if (errors.length || !nodes.length) continue;
		out.set(key, { contributionId: pathContributionId(rule.id), label: rule.label || rule.path, nodes, mainEntity: Boolean(rule.mainEntity) });
	}
	return out;
}

/** An entry's rule (from its override), or null when it has none, it's off, or it doesn't parse. */
export function compileEntryRule(collection: string, entryId: string, custom: CustomMarkup | null | undefined): CompiledRule | null {
	if (!custom?.enabled) return null;
	const { nodes, errors } = parseMarkup(custom.markup);
	if (errors.length || !nodes.length) return null;
	return { contributionId: entryContributionId(collection, entryId), label: `${collection}:${entryId}`, nodes, mainEntity: Boolean(custom.mainEntity) };
}

/** The request path of a page context: `path`, else the URL's. */
export function requestPath(page: { path?: string | null; url?: string | null }): string {
	if (page.path) return page.path;
	try {
		return new URL(page.url ?? "").pathname;
	} catch {
		return "/";
	}
}

/** The rule for a page: the entry's own (it wins), else the path rule for its path. */
export function pageRule(page: { path?: string | null; url?: string | null }, pathRules: Map<string, CompiledRule> | null | undefined, entryRule?: CompiledRule | null): CompiledRule | null {
	return entryRule ?? pathRules?.get(pathKey(requestPath(page))) ?? null;
}

// ── Output ───────────────────────────────────────────────────────

/** Properties whose relative values (/path, #name) are URLs, resolved like @id. */
const URL_KEYS = new Set([
	"url", "item", "image", "logo", "sameAs", "thumbnailUrl", "contentUrl", "embedUrl", "downloadUrl", "installUrl", "screenshot",
	"mainEntityOfPage", "serviceUrl", "hasMap", "discussionUrl", "softwareHelp", "urlTemplate", "target", "termsOfService", "publishingPrinciples",
]);
const looksRelative = (v: string) => v.startsWith("/") || v.startsWith("#") || v.startsWith("./") || v.startsWith("../");
/** References to the pack's site-level nodes (the WebSite, the publisher, authors without an author page). */
const SITE_FRAGMENT = /^#(website|organization|publisher|person(-.+)?)$/;

/**
 * Short names for the pack's graph nodes: every node's fragment at the site
 * root or the page URL ("#website", "#webpage", "#primaryimage",
 * "#person-jon"…), "#organization" and "#publisher" for the publisher
 * (whatever its @id), and "#author" for the article's first author.
 */
export function packAliases(graph: Node[], pageUrl: string, publisherId?: string | null): Map<string, string> {
	const aliases = new Map<string, string>();
	let root = "";
	try {
		root = `${new URL(pageUrl).origin}/`;
	} catch {
		// No origin: page-URL aliases only.
	}
	const page = pageUrl.split("#")[0];
	const ids = graph.map((n) => n["@id"]).filter((id): id is string => typeof id === "string" && id.includes("#"));
	for (const id of ids) if (id.startsWith(root) && id.slice(0, id.indexOf("#")) === root) aliases.set(id.slice(id.indexOf("#")), id);
	for (const id of ids) if (id.slice(0, id.indexOf("#")) === page) aliases.set(id.slice(id.indexOf("#")), id);
	if (publisherId) {
		aliases.set("#organization", publisherId);
		aliases.set("#publisher", publisherId);
	}
	const article = graph.find((n) => typeof n["@id"] === "string" && (n["@id"] as string).endsWith("#article"));
	const author = Array.isArray(article?.author) ? article.author[0] : article?.author;
	if (isObj(author) && typeof author["@id"] === "string") aliases.set("#author", author["@id"]);
	return aliases;
}

export interface RenderOptions {
	/** The page's URL (canonical, else the request URL without query): relative @id and url values resolve against it. */
	pageUrl: string;
	/** The pack's graph nodes, when the Schema.org graph is on: references to them resolve to their real @ids, and they can't be redefined. */
	graph?: Node[] | null;
	/** The publisher's @id (graph on), for "#organization". */
	publisherId?: string | null;
}

export interface CustomOutput {
	contribution: { kind: "jsonld"; id: string; graph: Record<string, unknown> };
	/** The first node's @id, for the WebPage's mainEntity (graph on and the rule asks for it). */
	mainEntityId?: string;
}

const firstType = (node: Node) => {
	const t = node["@type"];
	return (Array.isArray(t) ? t[0] : t) as string | undefined;
};

/**
 * A rule's contribution for one page: a copy of its nodes with relative
 * @ids and URLs made absolute (references to the pack's nodes resolved to
 * them when the graph is on, and nested copies of them reduced to
 * references), nodes the graph already has and repeated @ids dropped, and,
 * when the rule's first node is the page's main entity (graph on), an @id
 * on it (`<page URL>#<type>`). Null when nothing is left.
 */
export function customOutput(rule: CompiledRule, options: RenderOptions): CustomOutput | null {
	const base = options.pageUrl.split("#")[0];
	const graph = options.graph ?? null;
	const aliases = graph ? packAliases(graph, base, options.publisherId) : new Map<string, string>();
	const packIds = new Set(graph?.map((n) => n["@id"]).filter((id): id is string => typeof id === "string") ?? []);
	let root = base;
	try {
		root = `${new URL(base).origin}/`;
	} catch {
		// Not a URL: resolve against it as it is.
	}
	// The pack's site-level ids live at the site root, so a reference to one that isn't in the graph still points there.
	const ref = (v: string) => aliases.get(v.trim()) ?? resolveIri(v, SITE_FRAGMENT.test(v.trim()) ? root : base);
	const resolve = (value: unknown, key: string | null, depth: number): unknown => {
		if (typeof value === "string") return key === "@id" || (key && URL_KEYS.has(key) && looksRelative(value.trim())) ? ref(value) : value;
		if (Array.isArray(value)) return value.map((v) => resolve(v, key, depth + 1));
		if (!isObj(value)) return value;
		const out: Node = {};
		for (const [k, v] of Object.entries(value)) out[k] = resolve(v, k, depth + 1);
		// A nested copy of one of the pack's nodes: a reference to it.
		if (depth > 0 && typeof out["@id"] === "string" && packIds.has(out["@id"])) return { "@id": out["@id"] };
		return out;
	};
	const seen = new Set<string>();
	const nodes: Node[] = [];
	for (const raw of rule.nodes) {
		const node = resolve(raw, null, 0) as Node;
		const id = node["@id"];
		if (typeof id === "string") {
			if (packIds.has(id) || seen.has(id)) continue;
			seen.add(id);
		}
		nodes.push(node);
	}
	if (!nodes.length) return null;
	let mainEntityId: string | undefined;
	if (graph && rule.mainEntity) {
		const first = nodes[0];
		if (typeof first["@id"] === "string") mainEntityId = first["@id"];
		else {
			const slug = (firstType(first) ?? "entity").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "entity";
			let id = `${base}#${slug}`;
			for (let n = 2; packIds.has(id) || seen.has(id); n++) id = `${base}#${slug}-${n}`;
			const { "@type": type, ...rest } = first;
			nodes[0] = { "@type": type, "@id": id, ...rest };
			mainEntityId = id;
		}
	}
	const doc = nodes.length === 1 ? { "@context": "https://schema.org", ...nodes[0] } : { "@context": "https://schema.org", "@graph": nodes };
	return { contribution: { kind: "jsonld", id: rule.contributionId, graph: doc }, ...(mainEntityId ? { mainEntityId } : {}) };
}

/**
 * JSON for a <script type="application/ld+json"> element, escaped the way
 * EmDash's safeJsonLdSerialize does it (<, >, U+2028 and U+2029 as \u
 * escapes, so no string can close the element). For the admin's live
 * preview only: on pages, EmDash serializes the contribution itself.
 */
export function scriptJson(value: unknown, space?: string): string {
	return JSON.stringify(value, null, space)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

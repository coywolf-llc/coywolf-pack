/**
 * Glossary links: link an entry's Schema.org entities to their glossary.io
 * definitions in the entry's Portable Text body. Pure logic, no I/O.
 *
 * For each entity that has a glossary.io term, at most one link per entry:
 * 1. The body already links to the term: nothing to do.
 * 2. Otherwise the first existing link whose text is one of the entity's names
 *    is switched to the glossary page when it's an identity link: the entity's
 *    Wikipedia article or Wikidata item, its own site (a deep page only when
 *    the path names it, like yoast.com/wordpress/plugins/seo/), a site's home
 *    page, a social profile, or a site named after it. Internal and affiliate
 *    links never change, nor citations (docs, articles, issues, sign-up and
 *    store subdomains, queries, fragments), a link whose text is a domain
 *    ("create an account at mastodon.social"), a name inside a longer name
 *    (Shopify in "Shopify Unite"), or a profile link in a list.
 * 3. Otherwise the first plain mention in a paragraph or list item is linked,
 *    with the text as written (plurals and hyphenated spellings count):
 *    whole words, not in headings, blockquotes, code or other links, and not
 *    part of a longer name (Google in "Google Search Console", SMTP in
 *    "Gravity SMTP") or an abbreviation after an expansion ("(NLP)"). A
 *    mention at the start of a sentence or inside quotation marks is used only
 *    when there's no other.
 * An entity named by an affiliate link gets no glossary link in that entry.
 */

export interface LinkEntity {
	name: string;
	type?: string;
	qid: string;
	wikipedia?: string;
	website?: string;
	primary?: boolean;
}

export interface GlossaryTarget {
	slug: string;
	names: string[];
}

export type TargetLookup = (qid: string) => GlossaryTarget | null | undefined;

export interface LinkChange {
	action: "switch" | "add";
	qid: string;
	entity: string;
	slug: string;
	href: string;
	anchor: string;
	block: string;
	oldHref?: string;
	why: string;
	context: string;
}

export interface LinkSkip {
	qid: string;
	entity: string;
	slug: string;
	why: "linked" | "excluded" | "affiliate" | "no-mention" | "taken";
	detail?: string;
}

export type KeptWhy = LinkKind | "domain" | "part-of-name" | "list" | "not-a-name";

export interface LinkPlan {
	/** The new body (a copy), or the input itself when nothing changed. */
	content: unknown[];
	changes: LinkChange[];
	skipped: LinkSkip[];
	/** Existing links that name an entity but stay as they are. */
	kept: Array<{ qid: string; entity: string; anchor: string; href: string; why: KeptWhy }>;
}

export interface PlanOptions {
	/** The site's own hosts, never switched (see hostIn: "coywolf.*" matches coywolf.com, coywolf.pro…). */
	siteHosts: readonly string[];
	/** The site's own short-link hosts for affiliate redirects (coywolf.io): treated as affiliate links. */
	shortHosts?: readonly string[];
	/** QIDs never to link in this entry (already handled once, or removed by hand). */
	exclude?: ReadonlySet<string>;
	/** New span and markDef keys (made unique within the block). */
	newKey?: () => string;
	glossaryOrigin?: string;
}

type Span = { _type: "span"; _key?: string; text: string; marks?: string[] };
type MarkDef = { _type: string; _key: string; href?: string; blank?: boolean; [k: string]: unknown };
type Block = { _type: "block"; _key?: string; style?: string; listItem?: string; children: unknown[]; markDefs?: MarkDef[] };

interface Run {
	block: number;
	children: number[];
	defKeys: string[];
	href: string;
	text: string;
	start: number;
}

export interface TextBlock {
	index: number;
	key: string;
	block: Block;
	text: string;
	/** Start offset of each child in `text` (-1 for non-span children). */
	offsets: number[];
	links: Map<string, MarkDef>;
	/** Link mark key on each child (null when not linked). */
	linkOf: Array<string | null>;
	/** Paragraphs and list items (not headings or blockquotes). */
	eligible: boolean;
	listItem: boolean;
}

export interface Occurrence {
	entity: number;
	block: number;
	child: number;
	start: number;
	end: number;
	text: string;
	/** Why it can't be linked, or null. */
	reject: string | null;
	/** Usable only when the entity has no better mention. */
	fallback: boolean;
}

const GLOSSARY = "https://glossary.io";
const WORD = /[\p{L}\p{N}]/u;
const UPPER_START = /^[\p{Lu}\p{N}]/u;
const SPACES = "[ \\u00a0]+";
/** A sentence or clause starts after these (or at the start of the block). */
const SENTENCE_BREAK = /(^|[.!?:;"\u201c\u201d(\[\u2014\u2013\u2022])\s*$/u;
/** Capitalized words at the start of a sentence that aren't part of the name after them. */
const STARTERS = new Set(
	"a an the this that these those today yesterday tomorrow now then last next in on at by for from with without when while after before since if but and or so also however recently earlier later meanwhile unlike like as both even only just all some many most every each why how what where who which there here it its my our your their his her we i you they he she use using try get see read check install open visit sign add set go make let according unfortunately fortunately luckily sadly thankfully interestingly surprisingly notably additionally finally first second third plus yes no not because although though until once over under between during about via per to of instead perhaps maybe currently previously ultimately eventually overall".split(" "),
);
/** Titles that can come right before a person's name (CEO Tim Cook, Dr. Jane Doe). */
const TITLES = new Set("ceo cto coo cfo cmo cpo cio ciso vp svp evp dr mr mrs ms mx prof president founder cofounder co-founder chairman chair director editor engineer developer analyst reporter journalist author host senator".split(" "));
const SOCIAL_HOSTS = ["twitter.com", "x.com", "linkedin.com", "facebook.com", "instagram.com", "threads.net", "threads.com", "bsky.app", "github.com", "youtube.com", "tiktok.com", "medium.com", "flipboard.com", "about.me"];
/** Subdomains whose pages are about something specific (docs, sign-up, stores), not the entity itself. */
const CITATION_HOST_PREFIX =
	/^(docs|doc|developer|developers|dev|support|help|helpcenter|kb|blog|blogs|news|community|forum|forums|bugzilla|bugs|issues|status|press|newsroom|investor|investors|ir|learn|answers|discuss|get|merchant|merchants|business|partner|partners|seller|sellers|sell|ads|advertising|enterprise|signup|accounts|account|my|dashboard|console|portal|login|auth|careers|jobs|events|shop|store|download|downloads)\./;
const CITATION_PATH = /\/(issues|pull|commit|commits|blob|tree|releases|wiki|answer|answers|article|articles|post|posts|news|blog|docs|documentation|reference|guide|guides|status|p|watch|video|videos|detail|details|dp|gp|item|itm|listing|show_bug\.cgi)(\/|$)|\/(19|20)\d\d\/|\.pdf$/i;
/** Affiliate networks and their link shorteners (a host or any subdomain of it: automattic.pxf.io). */
const AFFILIATE_HOSTS = ["amzn.to", "amzn.com", "geni.us", "shareasale.com", "skimresources.com", "linksynergy.com", "pjtra.com", "pjatr.com", "anrdoezrs.net", "jdoqocy.com", "tkqlhce.com", "dpbolvw.net", "kqzyfj.com", "awin1.com", "sjv.io", "pxf.io", "evyy.net", "ojrq.net", "7eer.net", "mkr3.net", "prf.hn", "audw.net", "avantlink.com", "partnerstack.com", "clkbank.com", "clickbank.net", "go2cloud.org", "refersion.com"];
const AFFILIATE_PARAM = /[?&](ref|ref_id|aff|aff_id|aff_c|affiliate|affiliate_id|via|tag|partner|fpr|irclickid|irgwc|clickid|clickref|a_aid|sscid|ssaid|sjid|kaid|ranmid|raneaid|ransiteid|coupon)=/i;
/** Referral fragments some programs use (Backblaze: #af0118). */
const AFFILIATE_FRAGMENT = /^#(af|aff|ref)[-_]?[0-9a-z]+$/i;
const AFFILIATE_PATH = /\/(visit|go|recommends|refer|ref|aff|affiliate)\//i;
const STOP_TOKENS = new Set(["the", "and", "for", "with", "inc", "corp", "llc", "app", "apps", "social", "network", "search", "online", "web", "website", "project", "foundation", "protocol", "service", "studio", "media", "group", "labs", "com", "org", "net"]);

/** The glossary.io slug a link points at, or null. */
export function glossarySlug(href: string, origin = GLOSSARY): string | null {
	const u = parse(href);
	if (!u || bareHost(u.hostname) !== bareHost(new URL(origin).hostname)) return null;
	const m = /^\/([a-z0-9][a-z0-9-]*)\/?$/.exec(u.pathname);
	return m ? m[1] : null;
}

export function glossaryUrl(slug: string, origin = GLOSSARY): string {
	return `${origin}/${slug}/`;
}

/** The glossary.io slugs a Portable Text body already links to. */
export function linkedGlossarySlugs(content: unknown, origin = GLOSSARY): Set<string> {
	const out = new Set<string>();
	for (const tb of textBlocks(Array.isArray(content) ? content : [])) {
		for (const d of tb.links.values()) {
			const slug = glossarySlug(d.href!, origin);
			if (slug) out.add(slug);
		}
	}
	return out;
}

function parse(href: string): URL | null {
	try {
		return new URL(href, "https://relative.invalid");
	} catch {
		return null;
	}
}

function bareHost(host: string): string {
	return host.toLowerCase().replace(/^(www|m|mobile)\./, "");
}

/** Comparable form of a URL: host without www/m, path without a trailing slash, no query or fragment. */
function comparable(href: string): string {
	const u = parse(href);
	if (!u) return href;
	let path = u.pathname.replace(/\/+$/, "");
	try {
		path = decodeURIComponent(path);
	} catch {
		/* keep */
	}
	return `${bareHost(u.hostname)}${path}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `host` is one of `hosts`: a domain matches itself and its
 * subdomains; "name.*" matches that name under any suffix, and its subdomains
 * (coywolf.* is coywolf.com, coywolf.pro, forum.coywolf.com).
 */
export function hostIn(host: string, hosts: readonly string[]): boolean {
	const h = bareHost(host);
	return hosts.some((raw) => {
		const entry = bareHost(raw.trim());
		if (!entry) return false;
		if (entry.endsWith(".*")) return new RegExp(`(^|\\.)${escapeRe(entry.slice(0, -2))}\\.[a-z0-9.-]+$`).test(h);
		return h === entry || h.endsWith(`.${entry}`);
	});
}

/** Normalized text for comparing with names: no possessive, edge punctuation, case, hyphens or extra spaces. */
export function normalizeName(s: string): string {
	return s
		.normalize("NFKC")
		.replace(/[\u2018\u2019\u02bc]/g, "'")
		.replace(/[\u00a0\s\u2010\u2011-]+/g, " ")
		.trim()
		.replace(/^["'\u201c\u201d\u00ab\u00bb([{\s]+|["'\u201c\u201d\u00ab\u00bb)\]},.:;!?\s]+$/g, "")
		.replace(/'s$/i, "")
		.toLowerCase();
}

export type LinkKind = "internal" | "affiliate" | "glossary" | "wikipedia" | "wikidata" | "website" | "home" | "social" | "named" | "citation" | "other";

/** Lowercase tokens of a name (at least `min` characters, minus generic words). */
function nameTokens(name: string, min: number): string[] {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\p{L}\p{N} ]/gu, " ")
		.split(/\s+/)
		.filter((t) => t.length >= min && !STOP_TOKENS.has(t));
}

/** What kind of link `href` is, for the entity it names. */
export function classifyLink(href: string, entity: LinkEntity, siteHosts: readonly string[], shortHosts: readonly string[] = []): LinkKind {
	if (/^(mailto|tel|sms|javascript):/i.test(href) || href.startsWith("#")) return "other";
	const u = parse(href);
	if (!u) return "other";
	const host = bareHost(u.hostname);
	if (hostIn(host, shortHosts)) return "affiliate";
	if (host === "relative.invalid" || hostIn(host, siteHosts)) return /^\/(visit|go|recommends)\//.test(u.pathname) ? "affiliate" : "internal";
	if (host === bareHost(new URL(GLOSSARY).hostname)) return "glossary";
	if (hostIn(host, AFFILIATE_HOSTS) || AFFILIATE_PARAM.test(u.search) || AFFILIATE_FRAGMENT.test(u.hash) || AFFILIATE_PATH.test(u.pathname)) return "affiliate";
	if (host.endsWith("wikipedia.org") && u.pathname.startsWith("/wiki/")) {
		return entity.wikipedia && !u.hash && comparable(href) === comparable(entity.wikipedia) ? "wikipedia" : "citation";
	}
	if (host === "wikidata.org") return new RegExp(`^/(wiki|entity)/${escapeRe(entity.qid)}/?$`).test(u.pathname) ? "wikidata" : "citation";
	const path = u.pathname.replace(/\/+$/, "");
	const segments = path.split("/").filter(Boolean);
	const site = entity.website ? parse(entity.website) : null;
	const siteHost = site && site.hostname !== "relative.invalid" ? bareHost(site.hostname) : "";
	if (siteHost && host === siteHost && !u.hash && !u.search && comparable(href) === comparable(entity.website!)) return "website";
	if (hostIn(host, SOCIAL_HOSTS) || /^\/@[^/]+$/.test(path)) {
		const profile = /^\/(@[^/]+|in\/[^/]+|company\/[^/]+|profile\/[^/]+|c\/[^/]+|channel\/[^/]+|user\/[^/]+|[A-Za-z0-9_.-]+)$/.test(path);
		return profile && !u.search && !u.hash ? "social" : "citation";
	}
	const article = segments.some((s) => /^\d{5,}$/.test(s) || s.split(/[-_]/).length >= 6);
	if (u.search || u.hash || CITATION_HOST_PREFIX.test(host) || CITATION_PATH.test(path) || segments.length > 3 || article) return "citation";
	if (segments.length === 0 || (segments.length === 1 && /^(about|about-us|home|index\.html?|en|en-us)$/i.test(segments[0]))) return "home";
	// A deeper page counts only when its path names the entity (/apple-music/, /wordpress/plugins/seo/).
	const compactPath = path.toLowerCase().replace(/[^a-z0-9]/g, "");
	const pathNames = nameTokens(entity.name, 3).some((t) => compactPath.includes(t.replace(/[^a-z0-9]/g, "")));
	if (siteHost && (host === siteHost || host.endsWith(`.${siteHost}`))) return pathNames ? "website" : "citation";
	const compactHost = host.replace(/[^a-z0-9]/g, "");
	if (nameTokens(entity.name, 4).some((t) => compactHost.includes(t))) return pathNames ? "named" : "citation";
	return "other";
}

const IDENTITY: ReadonlySet<LinkKind> = new Set(["wikipedia", "wikidata", "website", "home", "social", "named"]);

/** Whether a link of `kind` may become the glossary link. */
export const switchable = (kind: LinkKind) => IDENTITY.has(kind);

const isAcronym = (s: string) => /^[\p{Lu}\p{N}&.+-]{2,}$/u.test(s) && /\p{Lu}/u.test(s);
const isConcept = (name: string) => name === name.toLowerCase() && /\p{L}/u.test(name);

/** The entity's names to look for, longest first. */
export function surfaces(entity: LinkEntity, target: GlossaryTarget | null): string[] {
	const out = new Map<string, string>();
	for (const raw of [entity.name, ...(target?.names ?? [])]) {
		const name = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
		if (name.length < 2) continue;
		const k = normalizeName(name);
		if (k && !out.has(k)) out.set(k, name);
	}
	return [...out.values()].sort((a, b) => b.length - a.length);
}

/** A name as a pattern: spaces and hyphens interchangeable, an optional plural ending. Group 1 is the name itself. */
function namePattern(name: string): RegExp {
	const body = name
		.split(/[\s\u00a0\u2010\u2011-]+/)
		.filter(Boolean)
		.map(escapeRe)
		.join("[\\s\\u00a0\\u2010\\u2011-]+");
	return new RegExp(`(${body})${/\p{L}$/u.test(name) ? "(?:e?s)?" : ""}`, "giu");
}

/** Whether `found` (the name as written in the body) is `surface`, given how names are capitalized. */
function caseMatches(found: string, surface: string, concept: boolean): boolean {
	const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
	if (letters(found) === letters(surface)) return true;
	if (isAcronym(surface)) return false; // SEO, CSS: exact case only
	if (concept) return true;
	// Sentence-case names of concepts ("Search engine optimization") read either way.
	const words = surface.split(/\s+/);
	if (words.length > 1 && words.slice(1).every((w) => w === w.toLowerCase())) return true;
	// Proper nouns: both start with a capital (PixelFed for Pixelfed), never "google" for Google.
	return UPPER_START.test(found) && UPPER_START.test(surface);
}

/** Whether the text right before a name is a capitalized word that belongs to a longer name (Gravity SMTP, Microsoft Bing). */
function joinsBefore(before: string): boolean {
	const m = new RegExp(`([\\p{Lu}][\\p{L}\\p{N}'\\u2019.&-]*)${SPACES}$`, "u").exec(before);
	if (!m) return false;
	const word = m[1];
	if (/['\u2019]s$/i.test(word)) return false; // a possessive: Google's Gemini
	const bare = word.toLowerCase().replace(/\.$/, "");
	if (TITLES.has(bare)) return false;
	// A period ends the sentence before (…StumbleUpon. Google), except after initials (J. K. Rowling, U.S. Steel).
	if (word.endsWith(".") && !/^(\p{Lu}\.)+$/u.test(word)) return false;
	const head = before.slice(0, before.length - m[0].length);
	return !(SENTENCE_BREAK.test(head) && STARTERS.has(bare));
}

/** Whether the text right after a name continues it with a capitalized word (Google Search Console, Shopify Unite). */
const joinsAfter = (after: string) => new RegExp(`^${SPACES}\\p{Lu}`, "u").test(after) && !new RegExp(`^${SPACES}I\\b`).test(after);

function insideQuotes(before: string): boolean {
	const open = (before.match(/\u201c/g) ?? []).length;
	const close = (before.match(/\u201d/g) ?? []).length;
	return open > close || (before.match(/"/g) ?? []).length % 2 === 1;
}

export function textBlocks(content: unknown[]): TextBlock[] {
	const out: TextBlock[] = [];
	content.forEach((raw, index) => {
		const block = raw as Block;
		if (!block || block._type !== "block" || !Array.isArray(block.children)) return;
		const links = new Map<string, MarkDef>();
		for (const d of block.markDefs ?? []) if (d && d._type === "link" && typeof d._key === "string" && typeof d.href === "string") links.set(d._key, d);
		let text = "";
		const offsets: number[] = [];
		const linkOf: Array<string | null> = [];
		for (const c of block.children) {
			const span = c as Span;
			if (span && span._type === "span" && typeof span.text === "string") {
				offsets.push(text.length);
				text += span.text;
				linkOf.push((span.marks ?? []).find((m) => links.has(m)) ?? null);
			} else {
				offsets.push(-1);
				linkOf.push(null);
			}
		}
		const style = block.style ?? "normal";
		out.push({ index, key: block._key ?? String(index), block, text, offsets, links, linkOf, eligible: style === "normal", listItem: Boolean(block.listItem) });
	});
	return out;
}

/** Link runs: adjacent spans with links to the same address (EmDash sometimes saves one link in pieces). */
function linkRuns(tb: TextBlock): Run[] {
	const runs: Run[] = [];
	let cur: Run | null = null;
	tb.block.children.forEach((_, i) => {
		const key = tb.linkOf[i];
		const def = key ? tb.links.get(key) : null;
		if (!def) {
			cur = null;
			return;
		}
		const text = (tb.block.children[i] as Span).text;
		if (cur && cur.href === def.href && cur.children[cur.children.length - 1] === i - 1) {
			cur.children.push(i);
			if (!cur.defKeys.includes(def._key)) cur.defKeys.push(def._key);
			cur.text += text;
		} else {
			cur = { block: tb.index, children: [i], defKeys: [def._key], href: def.href!, text, start: tb.offsets[i] };
			runs.push(cur);
		}
	});
	return runs;
}

/** Every mention of the names in a block (also ones that can't be linked: they still hold their text against shorter names). */
export function findOccurrences(tb: TextBlock, entityIndex: number, names: string[], concept: boolean): Occurrence[] {
	const out: Occurrence[] = [];
	for (const name of names) {
		for (const m of tb.text.matchAll(namePattern(name))) {
			const start = m.index!;
			const found = m[0];
			const end = start + found.length;
			if (!caseMatches(m[1], name, concept)) continue;
			if ((start > 0 && WORD.test(tb.text[start - 1])) || (end < tb.text.length && WORD.test(tb.text[end]))) continue;
			const before = tb.text.slice(0, start);
			const after = tb.text.slice(end);
			const child = childAt(tb, start, end);
			let reject: string | null = null;
			// Handles, hashtags, paths, file names and domains (@Google, #SEO, /wp-admin, style.css, Pixelfed.social).
			if (/[@#/\\._~-]$/.test(before) || /^[._~@/\\-][\p{L}\p{N}]/u.test(after)) reject = "handle-or-path";
			else if (child < 0) reject = "spans";
			else if (tb.linkOf[child]) reject = "linked";
			else if (((tb.block.children[child] as Span).marks ?? []).includes("code")) reject = "code";
			else if (joinsAfter(after) || joinsBefore(before)) reject = "part-of-name";
			else if (isAcronym(name) && /\(\s*$/.test(before)) reject = "abbreviation"; // "neuro-linguistic programming (NLP)"
			const sentenceStart = SENTENCE_BREAK.test(before);
			const fallback = insideQuotes(before) || (!/[\s\u00a0\u2010\u2011-]/.test(found) && sentenceStart && !isAcronym(name));
			out.push({ entity: entityIndex, block: tb.index, child, start, end, text: found, reject, fallback });
		}
	}
	return out;
}

function childAt(tb: TextBlock, start: number, end: number): number {
	for (let i = 0; i < tb.offsets.length; i++) {
		const o = tb.offsets[i];
		if (o < 0) continue;
		const len = (tb.block.children[i] as Span).text.length;
		if (start >= o && end <= o + len) return i;
		if (start < o + len) return -1;
	}
	return -1;
}

function context(text: string, start: number, end: number): string {
	const a = Math.max(0, start - 70);
	const b = Math.min(text.length, end + 70);
	return `${a > 0 ? "\u2026" : ""}${text.slice(a, start)}[[${text.slice(start, end)}]]${text.slice(end, b)}${b < text.length ? "\u2026" : ""}`.replace(/\s+/g, " ");
}

function defaultKey(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Plan (and apply, on a copy) the glossary links for one entry body.
 * `entities` are all of the entry's stored entities, so names of entities
 * without a glossary term still keep shorter names out of them.
 */
export function planGlossaryLinks(content: unknown, entities: LinkEntity[], lookup: TargetLookup, options: PlanOptions): LinkPlan {
	const body = Array.isArray(content) ? content : [];
	const origin = options.glossaryOrigin ?? GLOSSARY;
	const newKey = options.newKey ?? defaultKey;
	const plan: LinkPlan = { content: body, changes: [], skipped: [], kept: [] };
	if (!body.length || !entities.length) return plan;

	const blocks = textBlocks(body);
	const byIndex = new Map(blocks.map((b) => [b.index, b]));
	const runs = blocks.flatMap(linkRuns);
	const linkedSlugs = new Set(runs.map((r) => glossarySlug(r.href, origin)).filter((s): s is string => Boolean(s)));

	const all = entities.map((e) => {
		const target = lookup(e.qid) ?? null;
		return { entity: e, target, names: surfaces(e, target), concept: isConcept(e.name) };
	});
	const occurrences: Occurrence[] = [];
	all.forEach((a, i) => {
		for (const tb of blocks) occurrences.push(...findOccurrences(tb, i, a.names, a.concept));
	});
	// A mention inside a longer mention of another entity belongs to that one (Google in Google Analytics).
	const live = occurrences.filter((o) => !occurrences.some((p) => p.entity !== o.entity && p.block === o.block && p.end - p.start > o.end - o.start && p.start < o.end && o.start < p.end));

	type Edit = { kind: "add"; child: number; start: number; end: number; href: string } | { kind: "switch"; run: Run; href: string };
	const edits = new Map<number, Edit[]>();
	const taken: Array<{ block: number; start: number; end: number }> = [];
	const switched = new Set<Run>();
	const seenSlugs = new Set<string>();
	const push = (block: number, e: Edit) => edits.set(block, [...(edits.get(block) ?? []), e]);

	all.forEach((a, i) => {
		const { entity, target } = a;
		if (!target || seenSlugs.has(target.slug)) return;
		seenSlugs.add(target.slug);
		const skip = (why: LinkSkip["why"], detail?: string) => plan.skipped.push({ qid: entity.qid, entity: entity.name, slug: target.slug, why, detail });
		if (linkedSlugs.has(target.slug)) return skip("linked");
		if (options.exclude?.has(entity.qid)) return skip("excluded");
		const href = glossaryUrl(target.slug, origin);
		const nameSet = new Set(a.names.map(normalizeName));
		const isName = (text: string) => {
			const n = normalizeName(text);
			return nameSet.has(n) || nameSet.has(n.replace(/e?s$/, ""));
		};

		// 2. An existing link that names the entity.
		let affiliate = false;
		for (const run of runs) {
			if (switched.has(run)) continue;
			const named = isName(run.text);
			const kind = classifyLink(run.href, entity, options.siteHosts, options.shortHosts);
			if (!named && kind !== "wikipedia" && kind !== "wikidata") continue;
			if (kind === "glossary") continue;
			const tb = byIndex.get(run.block)!;
			const keep = (why: KeptWhy) => plan.kept.push({ qid: entity.qid, entity: entity.name, anchor: run.text, href: run.href, why });
			if (!named) {
				keep("not-a-name"); // a Wikipedia link on a claim ("released in the mid-nineties") cites it
				continue;
			}
			if (!switchable(kind)) {
				if (kind === "affiliate") affiliate = true;
				keep(kind);
				continue;
			}
			const end = run.start + run.text.length;
			if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(run.text.trim())) keep("domain");
			else if (joinsAfter(tb.text.slice(end)) || joinsBefore(tb.text.slice(0, run.start))) keep("part-of-name");
			else if (kind === "social" && tb.listItem) keep("list");
			else {
				switched.add(run);
				push(run.block, { kind: "switch", run, href });
				taken.push({ block: run.block, start: run.start, end });
				plan.changes.push({ action: "switch", qid: entity.qid, entity: entity.name, slug: target.slug, href, anchor: run.text, block: tb.key, oldHref: run.href, why: kind, context: context(tb.text, run.start, end) });
				return;
			}
		}
		if (affiliate) return skip("affiliate", "named by an affiliate link");

		// 3. The first plain mention in a paragraph or list item.
		const mine = live
			.filter((o) => o.entity === i && !o.reject && byIndex.get(o.block)!.eligible)
			.sort((x, y) => x.block - y.block || x.start - y.start || y.end - x.end);
		if (!mine.length) return skip("no-mention");
		const free = (o: Occurrence) => !taken.some((t) => t.block === o.block && t.start < o.end && o.start < t.end);
		const pick = mine.find((o) => !o.fallback && free(o)) ?? mine.find(free) ?? null;
		if (!pick) return skip("taken", mine.map((o) => o.text).join(", "));
		const tb = byIndex.get(pick.block)!;
		const childStart = tb.offsets[pick.child];
		push(pick.block, { kind: "add", child: pick.child, start: pick.start - childStart, end: pick.end - childStart, href });
		taken.push({ block: pick.block, start: pick.start, end: pick.end });
		const why = `${normalizeName(pick.text) === normalizeName(entity.name) ? "name" : "alias"}${pick.fallback ? " (fallback)" : ""}`;
		plan.changes.push({ action: "add", qid: entity.qid, entity: entity.name, slug: target.slug, href, anchor: pick.text, block: tb.key, why, context: context(tb.text, pick.start, pick.end) });
	});

	if (!plan.changes.length) return plan;

	// Apply on a copy, block by block (adds from the end of each span backwards).
	const copy = structuredClone(body) as unknown[];
	for (const [index, list] of edits) {
		const block = copy[index] as Block;
		block.markDefs = Array.isArray(block.markDefs) ? block.markDefs : [];
		const used = new Set<string>([...block.markDefs.map((d) => d._key), ...block.children.map((c) => (c as Span)._key ?? "")]);
		const fresh = () => {
			let k = newKey();
			while (used.has(k)) k = newKey();
			used.add(k);
			return k;
		};
		for (const e of list) {
			if (e.kind !== "switch") continue;
			const shared = block.children.some((c, i) => !e.run.children.includes(i) && ((c as Span).marks ?? []).some((m) => e.run.defKeys.includes(m)));
			if (shared || e.run.defKeys.length > 1) {
				// One new link for the whole run; markDefs nothing uses any more are dropped.
				const def = block.markDefs.find((d) => d._key === e.run.defKeys[0])!;
				const key = fresh();
				block.markDefs.push({ ...def, _key: key, href: e.href });
				for (const ci of e.run.children) {
					const span = block.children[ci] as Span;
					span.marks = (span.marks ?? []).map((m) => (e.run.defKeys.includes(m) ? key : m)).filter((m, j, arr) => arr.indexOf(m) === j);
				}
				const stillUsed = new Set(block.children.flatMap((c) => (c as Span).marks ?? []));
				block.markDefs = block.markDefs.filter((d) => d._type !== "link" || stillUsed.has(d._key));
			} else {
				block.markDefs.find((d) => d._key === e.run.defKeys[0])!.href = e.href;
			}
		}
		const adds = list.filter((e): e is Extract<Edit, { kind: "add" }> => e.kind === "add").sort((x, y) => y.child - x.child || y.start - x.start);
		for (const e of adds) {
			const span = block.children[e.child] as Span;
			const key = fresh();
			block.markDefs.push({ _type: "link", _key: key, href: e.href });
			const marks = span.marks ?? [];
			const pieces: Span[] = [];
			if (e.start > 0) pieces.push({ ...span, text: span.text.slice(0, e.start) });
			pieces.push({ ...span, _key: e.start > 0 ? fresh() : span._key, text: span.text.slice(e.start, e.end), marks: [...marks, key] });
			if (e.end < span.text.length) pieces.push({ ...span, _key: fresh(), text: span.text.slice(e.end), marks: [...marks] });
			block.children.splice(e.child, 1, ...pieces);
		}
	}
	plan.content = copy;
	return plan;
}

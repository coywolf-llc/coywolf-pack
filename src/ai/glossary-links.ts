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
 *    when there's no other. A possessive right after the mention is linked
 *    with it ("Google's", "Threads’"); a switched link keeps its text.
 * An entity named by an affiliate link gets no glossary link in that entry.
 *
 * linkPossessives (since 0.51.0) moves the possessive after any glossary.io
 * link inside it ("[Google]'s" becomes "[Google's]"): only marks change.
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

/** A glossary link the rules make (add) or an existing link they switch to glossary.io. */
export interface TermLinkChange {
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

/**
 * A glossary.io link that now includes the possessive right after it
 * ("[Google]'s" became "[Google's]"; the text is unchanged). The term's QID
 * and entity are null when the site's index doesn't know the link's slug.
 */
export interface PossessiveChange {
	action: "possessive";
	qid: string | null;
	entity: string | null;
	slug: string | null;
	href: string;
	/** The link's whole text now ("Google's"). */
	anchor: string;
	block: string;
	/** What moved into the link ("'s", "’s" or "’"). */
	why: string;
	context: string;
}

export type LinkChange = TermLinkChange | PossessiveChange;

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
	changes: TermLinkChange[];
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
	/** Matched with a plural ending ("Threads" for Thread): an exact name at the same place wins. */
	plural: boolean;
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
/** Social sites whose profiles are a bare first path segment (x.com/name); elsewhere a profile is /@name, /in/name… */
const BARE_PROFILE_HOSTS = ["twitter.com", "x.com", "facebook.com", "instagram.com", "github.com", "about.me"];
/** Subdomains whose pages are about something specific (docs, sign-up, stores), not the entity itself. */
const CITATION_HOST_PREFIX =
	/^(docs|doc|developer|developers|dev|support|help|helpcenter|kb|blog|blogs|news|community|forum|forums|bugzilla|bugs|issues|status|press|newsroom|investor|investors|ir|learn|answers|discuss|get|merchant|merchants|business|partner|partners|seller|sellers|sell|ads|advertising|enterprise|signup|accounts|account|my|dashboard|console|portal|login|auth|careers|jobs|events|shop|store|download|downloads)\./;
const CITATION_PATH = /\/(issues|pull|commit|commits|blob|tree|releases|wiki|answer|answers|article|articles|post|posts|news|blog|docs|documentation|reference|guide|guides|status|p|watch|video|videos|detail|details|dp|gp|item|itm|listing|show_bug\.cgi)(\/|$)|\/(19|20)\d\d\/|\.pdf$/i;
/** Affiliate networks and their link shorteners (a host or any subdomain of it: automattic.pxf.io). */
const AFFILIATE_HOSTS = ["amzn.to", "amzn.com", "a.co", "geni.us", "shareasale.com", "shrsl.com", "skimresources.com", "linksynergy.com", "pjtra.com", "pjatr.com", "anrdoezrs.net", "jdoqocy.com", "tkqlhce.com", "dpbolvw.net", "kqzyfj.com", "awin1.com", "sjv.io", "pxf.io", "evyy.net", "ojrq.net", "7eer.net", "mkr3.net", "prf.hn", "audw.net", "avantlink.com", "partnerstack.com", "clkbank.com", "clickbank.net", "go2cloud.org", "refersion.com", "viglink.com", "tidd.ly", "rstyle.me", "fave.co", "bit.ly", "t.co", "ow.ly", "buff.ly", "dlvr.it"];
/** Stores whose links can be for any product (amazon.com/dp/…?tag=…): their brand counts as unknown. */
const MARKETPLACES = /(^|\.)(amazon|ebay|walmart|bestbuy|target|etsy|aliexpress|newegg|bhphotovideo|costco|homedepot|lowes)\.[a-z.]+$/;
const AFFILIATE_PARAM = /[?&](ref|ref_|ref_id|referral|aff|aff_id|aff_c|affiliate|affiliate_id|afmc|via|tag|partner|ps_partner_key|ps_xid|gspk|gsxid|fpr|fp_ref|rfsn|lmref|awc|cjevent|cjdata|irclickid|irgwc|clickid|clickref|a_aid|sscid|ssaid|sjid|kaid|ranmid|raneaid|ransiteid|coupon)=/i;
/** Subdomains used for affiliate and promo landing pages (try.shopify.com, go.nordvpn.net). */
const AFFILIATE_HOST_PREFIX = /^(try|go|click|track|trk|refer|referral|aff|affiliate|affiliates|promo|deal|deals|offer|offers)\.[a-z0-9-]+\.[a-z0-9.-]+$/;
/** Referral fragments some programs use (Backblaze: #af0118). */
const AFFILIATE_FRAGMENT = /^#(af|aff|ref)[-_]?[0-9a-z]+$/i;
const AFFILIATE_PATH = /^\/(visit|go|recommends|refer|ref|aff|affiliate)\//i;
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

/** A Portable Text body's text blocks as plain text (one line per block). */
export function bodyText(content: unknown): string {
	return textBlocks(Array.isArray(content) ? content : []).map((t) => t.text).join("\n");
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
	if (hostIn(host, AFFILIATE_HOSTS) || AFFILIATE_HOST_PREFIX.test(host) || AFFILIATE_PARAM.test(u.search) || AFFILIATE_FRAGMENT.test(u.hash) || AFFILIATE_PATH.test(u.pathname)) return "affiliate";
	if (host.endsWith("wikipedia.org") && u.pathname.startsWith("/wiki/")) {
		return entity.wikipedia && !u.hash && comparable(href) === comparable(entity.wikipedia) ? "wikipedia" : "citation";
	}
	if (host === "wikidata.org") return new RegExp(`^/(wiki|entity)/${escapeRe(entity.qid)}/?$`).test(u.pathname) ? "wikidata" : "citation";
	const path = u.pathname.replace(/\/+$/, "");
	const segments = path.split("/").filter(Boolean);
	const site = entity.website ? parse(entity.website) : null;
	const siteHost = site && site.hostname !== "relative.invalid" ? bareHost(site.hostname) : "";
	if (siteHost && host === siteHost && !u.hash && !u.search && comparable(href) === comparable(entity.website!)) return "website";
	const homePath = segments.length === 0 || (segments.length === 1 && /^(about|about-us|home|index\.html?|en|en-us)$/i.test(segments[0]));
	if (homePath && !u.search && !u.hash && !CITATION_HOST_PREFIX.test(host)) return "home";
	if (hostIn(host, SOCIAL_HOSTS) || /^\/@[^/]+$/.test(path)) {
		const profile =
			/^\/(@[^/]+|in\/[^/]+|company\/[^/]+|profile\/[^/]+|c\/[^/]+|channel\/[^/]+|user\/[^/]+)$/.test(path) || (hostIn(host, BARE_PROFILE_HOSTS) && /^\/[A-Za-z0-9_.-]+$/.test(path));
		const slugLike = path.split("/").some((s) => s.split(/[-_]/).length >= 6);
		return profile && !slugLike && !u.search && !u.hash ? "social" : "citation";
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

/** Host labels that say nothing about the brand (go.nordvpn.net is NordVPN's). */
const GENERIC_LABELS = new Set(["www", "m", "about", "go", "try", "click", "track", "trk", "refer", "referral", "aff", "affiliate", "affiliates", "promo", "deal", "deals", "offer", "offers", "get", "shop", "store", "app", "link", "links"]);

/**
 * The brand an affiliate link is for, as lowercase letters and digits, or ""
 * when the URL doesn't say (amzn.to/abc can be any product): the site's own
 * redirect target (/visit/yubico, coywolf.io/shopify), a network subdomain
 * (shopify.pxf.io, macpaw.audw.net), or the brand's own domain
 * (usefathom.com/ref/…, try.shopify.com, go.nordvpn.net).
 */
export function affiliateBrand(href: string, siteHosts: readonly string[] = [], shortHosts: readonly string[] = []): string {
	const u = parse(href);
	if (!u) return "";
	const host = bareHost(u.hostname);
	const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const segments = u.pathname.split("/").filter(Boolean);
	if (host === "relative.invalid" || hostIn(host, siteHosts) || hostIn(host, shortHosts)) {
		const i = /^(visit|go|recommends)$/i.test(segments[0] ?? "") ? 1 : 0;
		return compact(segments[i] ?? "");
	}
	if (MARKETPLACES.test(host)) return "";
	const network = AFFILIATE_HOSTS.find((n) => host === n || host.endsWith(`.${n}`));
	if (network) return host === network ? "" : compact(host.slice(0, -network.length - 1).split(".").pop() ?? "");
	const labels = host.split(".").filter((l) => !GENERIC_LABELS.has(l));
	const n = labels.length;
	// brand.co.uk, brand.com.au: the label before the two-part suffix.
	if (n >= 3 && /^(co|com|org|net|ac|gov)$/.test(labels[n - 2])) return compact(labels[n - 3]);
	return compact(n > 1 ? labels[n - 2] : (labels[0] ?? ""));
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
const joinsAfter = (after: string) => new RegExp(`^${SPACES}\\p{Lu}`, "u").test(after) && !new RegExp(`^${SPACES}I(${SPACES}\\p{Ll}|['\\u2019])`, "u").test(after);

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
		out.push(textBlockOf(block, index));
	});
	return out;
}

function textBlockOf(block: Block, index: number): TextBlock {
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
	return { index, key: block._key ?? String(index), block, text, offsets, links, linkOf, eligible: style === "normal", listItem: Boolean(block.listItem) };
}

// ── Possessives ──────────────────────────────────────────────────

/** A span's marks (none when they aren't a list). */
const marksOf = (span: { marks?: unknown } | null | undefined): string[] => (Array.isArray(span?.marks) ? (span!.marks as string[]) : []);

/** What a possessive never comes before: a letter, a digit or a hyphen ("Google’sfoo", "'s5", "'s-Hertogenbosch"). */
const NOT_AFTER = "(?![\\p{L}\\p{N}\\-\u2010\u2011])";
const POSSESSIVE_S = new RegExp(`^['\u2019\u02bc][sS]${NOT_AFTER}`, "u");
const POSSESSIVE_BARE = new RegExp(`^['\u2019\u02bc]${NOT_AFTER}`, "u");

/**
 * The possessive right after a name or link text (text[start, end)), or "":
 * "'s" or "’s" (or with the letter apostrophe "ʼ") before anything but a
 * letter, a digit or a hyphen, or the end ("Google's", "Anthropic’s."); "'S"
 * only after a name in capitals ("GOOGLE'S"). Or, after a name ending in "s",
 * a bare apostrophe before the same ("Threads’ growth"), unless it can be a
 * closing quotation mark or part of code: a quotation of any kind (' ‘ “ ")
 * opened before the name in the block and not closed ("‘Threads’"), or a "=",
 * "/" or quotation mark right before the name ("href='/users'"). Nothing after
 * a space ("[Google ]'s"), or when the text already ends with one, so a fix is
 * never made twice.
 */
function possessiveAfter(text: string, start: number, end: number): string {
	const anchor = text.slice(start, end);
	if (!/\S$/u.test(anchor) || /['\u2019\u02bc][sS]?$/.test(anchor)) return "";
	const after = text.slice(end);
	const full = POSSESSIVE_S.exec(after);
	if (full) return full[0].endsWith("S") && !(/\p{Lu}/u.test(anchor) && !/\p{Ll}/u.test(anchor)) ? "" : full[0];
	if (!/[sS]$/.test(anchor) || !POSSESSIVE_BARE.test(after)) return "";
	const before = text.slice(0, start);
	if (/[=/'"`\u2018\u2019\u201c\u201d\u02bc]$/.test(before) || insideQuotes(before) || insideSingleQuotes(before)) return "";
	return after[0];
}

/**
 * Whether the text ends inside single quotation marks: after an opening ‘ (or
 * a ' at the start or after a space or an opening mark), with no closing ’ or
 * ' after it (one after a non-space and before a non-letter: not the
 * apostrophe in "don’t").
 */
function insideSingleQuotes(before: string): boolean {
	let open = -1;
	for (const m of before.matchAll(/\u2018|(?<=^|[\s(\["\u201c\u00ab\u2014\u2013])'/gu)) open = m.index!;
	return open >= 0 && !/(?<=\S)['\u2019](?!\p{L})/u.test(before.slice(open + 1));
}

/** The possessive after a mention the rules link ("" when none), and whether it's in the mention's own span (else it starts the next one). */
function possessiveFor(tb: TextBlock, child: number, start: number, end: number): { text: string; inSpan: boolean } {
	const none = { text: "", inSpan: true };
	const text = possessiveAfter(tb.text, start, end);
	if (!text) return none;
	const spanEnd = tb.offsets[child] + (tb.block.children[child] as Span).text.length;
	if (end + text.length <= spanEnd) return { text, inSpan: true };
	const next = tb.block.children[child + 1];
	if (end === spanEnd && isSpan(next) && !tb.linkOf[child + 1] && !marksOf(next).includes("code") && next.text.length >= text.length) return { text, inSpan: false };
	return none;
}

/** A span's marks without links, and its other properties (not its key or text): two spans with the same shape can be one. */
const plainShape = (span: Span, linkKeys: ReadonlySet<string>) => spanShape({ ...span, marks: (span.marks ?? []).filter((m) => !linkKeys.has(m)) });

/**
 * Move the first `length` characters of the span after `last` (a link's last
 * span) into that link: onto the end of that span when both have the same
 * other marks and properties, or else as a new span with the next span's marks
 * and the link's mark `key`. The next span goes when nothing is left of it.
 * The block's text stays exactly as it was.
 */
function absorbPossessive(block: Block, last: number, length: number, key: string, linkKeys: ReadonlySet<string>, fresh: () => string): void {
	const span = block.children[last] as Span;
	const next = block.children[last + 1] as Span;
	const moved = next.text.slice(0, length);
	const rest = next.text.slice(length);
	const tail: Span[] = rest ? [{ ...next, text: rest }] : [];
	if (plainShape(span, linkKeys) === plainShape(next, linkKeys)) {
		span.text += moved;
		block.children.splice(last + 1, 1, ...tail);
		return;
	}
	const piece: Span = { ...next, text: moved, marks: [...(next.marks ?? []), key] };
	if (rest) piece._key = fresh();
	block.children.splice(last + 1, 1, piece, ...tail);
}

/** New keys for spans and markDefs, unique within the block. */
function keyMaker(block: Block, newKey: () => string): () => string {
	const used = new Set<string>([...(Array.isArray(block.markDefs) ? block.markDefs : []).map((d) => d?._key), ...block.children.map((c) => (c as Span)?._key ?? "")]);
	return () => {
		let k = newKey();
		while (used.has(k)) k = newKey();
		used.add(k);
		return k;
	};
}

/** A glossary.io link that now has the possessive after it inside it ("[Google]'s" became "[Google's]"). */
export interface PossessiveFix {
	href: string;
	/** The glossary.io term's slug, or null for another glossary.io page. */
	slug: string | null;
	/** The link's whole text now. */
	anchor: string;
	/** What moved into the link ("'s", "’s" or "’"). */
	moved: string;
	block: string;
	context: string;
}

const isGlossaryHref = (href: string, origin: string) => {
	const u = parse(href);
	return Boolean(u) && u!.hostname !== "relative.invalid" && bareHost(u!.hostname) === bareHost(new URL(origin).hostname);
};

/**
 * One block's glossary.io links with a possessive right after them, at the
 * start of the next span (which is in no link and isn't code). None in a block
 * with a span whose marks aren't a list: a malformed block is left as it is.
 */
function possessivesIn(block: Block, origin: string) {
	if (!Array.isArray(block.markDefs) || !block.markDefs.length) return [];
	if (block.children.some((c) => isSpan(c) && c.marks != null && !Array.isArray(c.marks))) return [];
	const tb = textBlockOf(block, 0);
	const out: Array<{ last: number; key: string; moved: string; href: string; start: number; end: number; anchor: string }> = [];
	for (const run of linkRuns(tb)) {
		if (!isGlossaryHref(run.href, origin)) continue;
		const last = run.children[run.children.length - 1];
		const next = block.children[last + 1];
		if (!isSpan(next) || tb.linkOf[last + 1] || marksOf(next).includes("code")) continue;
		const end = run.start + run.text.length;
		const moved = possessiveAfter(tb.text, run.start, end);
		if (!moved || next.text.length < moved.length) continue;
		out.push({ last, key: tb.linkOf[last]!, moved, href: run.href, start: run.start, end, anchor: run.text + moved });
	}
	return out;
}

/**
 * Move the possessive right after each glossary.io link (any of them: made by
 * the rules, switched, or by hand) inside that link, in every block (nested
 * ones too): "[Google]'s" becomes "[Google's]", "[Threads]’ growth" becomes
 * "[Threads’] growth". Only when the possessive starts the span right after
 * the link and that span is in no other link and isn't code. Same other marks: the
 * characters join the link's last span; different ones (bold, say): they
 * become a span of their own with those marks and the link. A span left empty
 * goes. Only marks change, never the text, and other links are never touched.
 * Returns a copy (the input itself when there's nothing to fix) and the fixes.
 */
export function linkPossessives(content: unknown, origin = GLOSSARY, newKey: () => string = defaultKey): { content: unknown; fixes: PossessiveFix[] } {
	let found = false;
	eachBlock(content, (block) => {
		if (!found && possessivesIn(block, origin).length) found = true;
	});
	if (!found) return { content, fixes: [] };
	const copy = structuredClone(content);
	const fixes: PossessiveFix[] = [];
	eachBlock(copy, (block) => {
		const list = possessivesIn(block, origin);
		if (!list.length) return;
		const text = textBlockOf(block, 0).text;
		const linkKeys = new Set(block.markDefs!.filter((d) => d && d._type === "link").map((d) => d._key));
		const fresh = keyMaker(block, newKey);
		// From the last link back, so the spans before each one stay where they are.
		for (const p of [...list].reverse()) absorbPossessive(block, p.last, p.moved.length, p.key, linkKeys, fresh);
		for (const p of list) fixes.push({ href: p.href, slug: glossarySlug(p.href, origin), anchor: p.anchor, moved: p.moved, block: block._key ?? "", context: context(text, p.start, p.end + p.moved.length) });
	});
	return { content: copy, fixes };
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
			out.push({ entity: entityIndex, block: tb.index, child, start, end, text: found, reject, fallback, plural: found.length > m[1].length });
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
	const beats = (p: Occurrence, o: Occurrence) => p.end - p.start > o.end - o.start || (p.end - p.start === o.end - o.start && !p.plural && o.plural);
	const live = occurrences.filter((o) => !occurrences.some((p) => p.entity !== o.entity && p.block === o.block && p.start < o.end && o.start < p.end && beats(p, o)));

	/** An add's `possessive`: the length of a possessive at the start of the next span, moved into the link after it's made. */
	type Edit = { kind: "add"; child: number; start: number; end: number; href: string; possessive: number } | { kind: "switch"; run: Run; href: string };
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
			if (nameSet.has(n)) return true;
			// A plural only for concepts and abbreviations ("PWAs"): "Threads" isn't the protocol "Thread".
			const bases = [text.trim().replace(/s$/, ""), text.trim().replace(/es$/, "")];
			const plurals = [n.replace(/s$/, ""), n.replace(/es$/, "")];
			return (a.concept || a.names.some((name) => isAcronym(name) && bases.includes(name))) && plurals.some((p) => nameSet.has(p));
		};
		// A mention inside link text, as a whole name ("Shopify free"; not "WP" in "WP Engine").
		const mentions = (text: string) => a.names.some((name) => [...text.matchAll(namePattern(name))].some((m) => {
			const s = m.index!;
			const e = s + m[0].length;
			return caseMatches(m[1], name, a.concept) && !(s > 0 && WORD.test(text[s - 1])) && !(e < text.length && WORD.test(text[e])) && !joinsAfter(text.slice(e)) && !joinsBefore(text.slice(0, s));
		}));
		const siteBrand = entity.website ? affiliateBrand(entity.website) : "";
		const tokens = [...new Set([...a.names.flatMap((n) => nameTokens(n, 4)), ...(siteBrand ? [siteBrand] : [])].map((t) => t.replace(/[^a-z0-9]/g, "")).filter((t) => t.length >= 4))];
		/** Whether an affiliate link is for this entity: its brand matches a name (shopify.pxf.io, /visit/yubico), or it's unknown (an Amazon short link). */
		const forEntity = (href: string) => {
			const brand = affiliateBrand(href, options.siteHosts, options.shortHosts);
			// A brand too short to compare ("hp") counts as unknown.
			return brand.length < 4 || tokens.some((t) => brand.includes(t) || t.includes(brand) || t.slice(0, 4) === brand.slice(0, 4));
		};

		// 2a. An affiliate link that names the entity, or mentions it and is for it ("Shopify free"), rules out a glossary link.
		for (const run of runs) {
			if (classifyLink(run.href, entity, options.siteHosts, options.shortHosts) !== "affiliate") continue;
			if (!isName(run.text) && !(mentions(run.text) && forEntity(run.href))) continue;
			plan.kept.push({ qid: entity.qid, entity: entity.name, anchor: run.text, href: run.href, why: "affiliate" });
			return skip("affiliate", "named by an affiliate link");
		}

		// 2b. An existing link that names the entity.
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
		// A possessive right after the mention is linked with it ("Google's", "Threads’").
		const possessive = possessiveFor(tb, pick.child, pick.start, pick.end);
		const end = pick.end + possessive.text.length;
		push(pick.block, { kind: "add", child: pick.child, start: pick.start - childStart, end: (possessive.inSpan ? end : pick.end) - childStart, href, possessive: possessive.inSpan ? 0 : possessive.text.length });
		taken.push({ block: pick.block, start: pick.start, end });
		const why = `${normalizeName(pick.text) === normalizeName(entity.name) ? "name" : "alias"}${pick.fallback ? " (fallback)" : ""}`;
		plan.changes.push({ action: "add", qid: entity.qid, entity: entity.name, slug: target.slug, href, anchor: pick.text + possessive.text, block: tb.key, why, context: context(tb.text, pick.start, end) });
	});

	if (!plan.changes.length) return plan;

	// Apply on a copy, block by block (adds from the end of each span backwards).
	const copy = structuredClone(body) as unknown[];
	for (const [index, list] of edits) {
		const block = copy[index] as Block;
		block.markDefs = Array.isArray(block.markDefs) ? block.markDefs : [];
		const fresh = keyMaker(block, newKey);
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
		const possessives: Array<{ key: string; length: number }> = [];
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
			if (e.possessive) possessives.push({ key, length: e.possessive });
		}
		if (possessives.length) {
			// A possessive that starts the next span joins the new link (from the last link back, so the spans before stay put).
			const linkKeys = new Set(block.markDefs.filter((d) => d._type === "link").map((d) => d._key));
			const at = (key: string) => block.children.findIndex((c) => ((c as Span).marks ?? []).includes(key));
			for (const p of possessives.map((p) => ({ ...p, index: at(p.key) })).sort((x, y) => y.index - x.index)) absorbPossessive(block, p.index, p.length, p.key, linkKeys, fresh);
		}
	}
	plan.content = copy;
	return plan;
}

// ── Removing links (glossary.io terms that are gone) ─────────────

/** How deep nested blocks are looked for (columns, callouts…), as portableTextToPlain (src/ai/logic.ts) does. */
const MAX_DEPTH = 8;

/** Every Portable Text block in a value, nested ones too. */
function eachBlock(value: unknown, visit: (block: Block) => void, depth = 0): void {
	if (depth > MAX_DEPTH || value == null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const v of value) eachBlock(v, visit, depth + 1);
		return;
	}
	const node = value as Record<string, unknown>;
	if (node._type === "block" && Array.isArray(node.children)) {
		visit(node as unknown as Block);
		return;
	}
	for (const [key, child] of Object.entries(node)) {
		if (key.startsWith("_") || key === "markDefs") continue;
		if (child && typeof child === "object") eachBlock(child, visit, depth + 1);
	}
}

/** The glossary.io slugs a Portable Text value links to anywhere, nested blocks included. */
export function glossarySlugsIn(content: unknown, origin = GLOSSARY): Set<string> {
	const out = new Set<string>();
	eachBlock(content, (block) => {
		for (const d of Array.isArray(block.markDefs) ? block.markDefs : []) {
			if (!d || d._type !== "link" || typeof d.href !== "string") continue;
			const slug = glossarySlug(d.href, origin);
			if (slug) out.add(slug);
		}
	});
	return out;
}

/** Every link address in a Portable Text value, nested blocks included (one per link markDef). */
export function linkHrefsIn(content: unknown): string[] {
	const out: string[] = [];
	eachBlock(content, (block) => {
		for (const d of Array.isArray(block.markDefs) ? block.markDefs : []) if (d && d._type === "link" && typeof d.href === "string") out.push(d.href);
	});
	return out;
}

/**
 * A copy of a Portable Text value as it is apart from its links: in every
 * block (nested ones too) the link markDefs and their marks are gone, spans
 * have no keys, and neighboring spans with the same marks are one. Two values
 * that differ only in their links (which text is linked, and where to) give
 * equal copies; any other difference (text, formatting, a block added, an
 * image changed) shows.
 */
export function withoutLinks(content: unknown): unknown {
	const copy = structuredClone(content);
	eachBlock(copy, (block) => {
		const defs = Array.isArray(block.markDefs) ? block.markDefs : [];
		const linkKeys = new Set(defs.filter((d) => d && d._type === "link").map((d) => d._key));
		block.markDefs = defs.filter((d) => !(d && d._type === "link"));
		const all = new Set<number>();
		block.children.forEach((child, i) => {
			all.add(i);
			if (!isSpan(child)) return;
			delete child._key;
			if (Array.isArray(child.marks)) child.marks = child.marks.filter((m) => !linkKeys.has(m));
		});
		block.children = mergeSpans(block.children, all);
	});
	return copy;
}

/** A span's marks and other properties (not its key or text), to tell whether two spans can be one. */
function spanShape(span: Span): string {
	const { _key: _k, text: _t, marks, ...rest } = span as Span & Record<string, unknown>;
	const props = Object.keys(rest)
		.sort()
		.map((k) => [k, (rest as Record<string, unknown>)[k]]);
	return JSON.stringify([[...(marks ?? [])].sort(), props]);
}

const isSpan = (c: unknown): c is Span => Boolean(c) && (c as Span)._type === "span" && typeof (c as Span).text === "string";

/** Adjacent spans that now have the same marks (and nothing else different) become one, where one of them just lost a link. */
function mergeSpans(children: unknown[], touched: ReadonlySet<number>): unknown[] {
	const out: unknown[] = [];
	let lastTouched = false;
	children.forEach((child, i) => {
		const prev = out[out.length - 1];
		const changed = touched.has(i);
		if ((lastTouched || changed) && isSpan(prev) && isSpan(child) && spanShape(prev) === spanShape(child)) {
			prev.text += child.text;
			lastTouched = true;
			return;
		}
		out.push(child);
		lastTouched = changed;
	});
	return out;
}

/**
 * Take the links to these glossary.io slugs out of a Portable Text value and
 * keep their text: in every block (nested ones too), each link markDef whose
 * glossary slug is one of `slugs` is dropped and its key taken out of every
 * span's marks. The text, other marks and other links are untouched, and
 * neighboring spans left with the same marks are merged. Returns a copy (the
 * input itself when there's nothing to remove), how many links went, and how
 * many per slug.
 */
export function removeGlossaryLinks(content: unknown, slugs: Iterable<string>, origin = GLOSSARY): { content: unknown; removed: number; bySlug: Record<string, number> } {
	const wanted = new Set(slugs);
	const bySlug: Record<string, number> = {};
	if (!wanted.size || ![...glossarySlugsIn(content, origin)].some((s) => wanted.has(s))) return { content, removed: 0, bySlug };
	const copy = structuredClone(content);
	let removed = 0;
	eachBlock(copy, (block) => {
		const defs = Array.isArray(block.markDefs) ? block.markDefs : [];
		const drop = new Set<string>();
		for (const d of defs) {
			if (!d || d._type !== "link" || typeof d.href !== "string" || typeof d._key !== "string") continue;
			const slug = glossarySlug(d.href, origin);
			if (!slug || !wanted.has(slug)) continue;
			drop.add(d._key);
			bySlug[slug] = (bySlug[slug] ?? 0) + 1;
			removed++;
		}
		if (!drop.size) return;
		block.markDefs = defs.filter((d) => !(d && drop.has(d._key)));
		const touched = new Set<number>();
		block.children.forEach((child, i) => {
			if (!isSpan(child) || !child.marks?.some((m) => drop.has(m))) return;
			child.marks = child.marks.filter((m) => !drop.has(m));
			touched.add(i);
		});
		block.children = mergeSpans(block.children, touched);
	});
	return { content: copy, removed, bySlug };
}

/**
 * Unit tests for glossary.io links: the rules (src/ai/glossary-links.ts) and
 * the entry edit (src/ai/glossary-linker.ts).
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/glossary-links.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as GL from "./glossary-links.ts";
// @ts-ignore -- as above.
import * as LK from "./glossary-linker.ts";
// @ts-ignore -- as above.
import * as G from "./glossary.ts";
// @ts-ignore -- as above.
import * as F from "../core/features.ts";

const links = GL as typeof import("./glossary-links.js");
const linker = LK as typeof import("./glossary-linker.js");
const glossary = G as typeof import("./glossary.js");
const features = F as typeof import("../core/features.js");

features.registerFeatures([
	{ id: "ai", label: "AI Enrichment", description: "", default: false },
	{ id: "ai.glossary", label: "glossary.io definitions", description: "", default: true },
	{ id: "ai.glossaryLinks", label: "glossary.io links", description: "", default: false },
]);

// ── Helpers ──────────────────────────────────────────────────────

type Part = string | { t: string; href: string; marks?: string[] } | { t: string; marks: string[] };
let keyN = 0;
/** A block from text parts; a part with `href` is a link. */
function block(parts: Part[], extra: Record<string, unknown> = {}) {
	const markDefs: Array<{ _type: string; _key: string; href: string }> = [];
	const children = parts.map((p) => {
		const part = typeof p === "string" ? { t: p } : p;
		const marks = [...(("marks" in part && part.marks) || [])];
		if ("href" in part) {
			const k = `m${++keyN}`;
			markDefs.push({ _type: "link", _key: k, href: part.href });
			marks.push(k);
		}
		return { _type: "span", _key: `s${++keyN}`, text: part.t, marks };
	});
	return { _type: "block", _key: `b${++keyN}`, style: "normal", children, markDefs, ...extra };
}

const TERMS: Record<string, { slug: string; names: string[] }> = {
	Q911595: { slug: "stumbleupon", names: ["StumbleUpon"] },
	Q68342360: { slug: "yoast-seo", names: ["Yoast SEO"] },
	Q5220864: { slug: "danny-sullivan", names: ["Danny Sullivan"] },
	Q40463886: { slug: "activitypub", names: ["ActivityPub"] },
	Q95: { slug: "google", names: ["Google"] },
	Q17107778: { slug: "open-graph-protocol", names: ["Open Graph protocol", "Open Graph"] },
	Q1: { slug: "fastmail", names: ["Fastmail"] },
	Q2: { slug: "cloudflare", names: ["Cloudflare"] },
	Q3: { slug: "adobe-flash", names: ["Adobe Flash", "Flash"] },
	Q4: { slug: "mastodon-social", names: ["mastodon.social"] },
	Q5: { slug: "shopify", names: ["Shopify"] },
	Q6: { slug: "smtp", names: ["Simple Mail Transfer Protocol", "SMTP"] },
	Q7: { slug: "nlp", names: ["natural language processing", "NLP"] },
	Q8: { slug: "foss", names: ["free and open-source software", "FOSS"] },
	Q9: { slug: "pwa", names: ["progressive web app", "PWA"] },
	Q10: { slug: "seo", names: ["SEO", "Search engine optimization"] },
	Q11: { slug: "signal", names: ["Signal"] },
	Q12: { slug: "fathom-analytics", names: ["Fathom Analytics"] },
	Q21: { slug: "thread", names: ["Thread"] },
	Q22: { slug: "wordpress", names: ["WordPress", "WP"] },
	Q23: { slug: "mac-mini", names: ["Mac mini"] },
	Q25: { slug: "database", names: ["database"] },
	Q26: { slug: "threads", names: ["Threads"] },
};
const lookup = (qid: string) => TERMS[qid] ?? null;
const ent = (qid: string, name: string, more: Record<string, unknown> = {}) => ({ qid, name, type: "Thing", description: "", wikipedia: "", website: "", primary: false, ...more });
const OPTS = { siteHosts: ["coywolf.*", "methodseo.*"], shortHosts: ["coywolf.io"], newKey: () => `k${++keyN}` };

/** The links in a body: [text, href] per link run. */
function linksOf(content: unknown[]): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const b of content as Array<{ children?: Array<{ text: string; marks?: string[] }>; markDefs?: Array<{ _key: string; href: string }> }>) {
		if (!b.children) continue;
		const defs = new Map((b.markDefs ?? []).map((d) => [d._key, d.href]));
		let cur: [string, string] | null = null;
		for (const c of b.children) {
			const href = (c.marks ?? []).map((m) => defs.get(m)).find(Boolean);
			if (href && cur && cur[1] === href) cur[0] += c.text;
			else if (href) out.push((cur = [c.text, href]));
			else cur = null;
		}
	}
	return out;
}
const plain = (content: unknown[]) => (content as Array<{ children?: Array<{ text: string }> }>).map((b) => (b.children ?? []).map((c) => c.text).join("")).join("\n");

function plan(content: unknown[], entities: ReturnType<typeof ent>[], options: Partial<typeof OPTS> & { exclude?: Set<string> } = {}) {
	const result = links.planGlossaryLinks(content, entities, lookup, { ...OPTS, ...options });
	assert.equal(plain(result.content), plain(content), "the text never changes");
	return result;
}

// ── Rules ────────────────────────────────────────────────────────

test("the web-surfing article: identity links switch, mentions get linked, an existing glossary link stays", () => {
	const body = [
		block(["Inspired by the nostalgia of ", { t: "StumbleUpon", href: "https://en.wikipedia.org/wiki/StumbleUpon" }, ", I started collecting sites."]),
		block(["If you're using a plugin like ", { t: "Yoast SEO", href: "https://yoast.com/wordpress/plugins/seo/" }, ", it reinforces the site name to Google on every page."]),
		block(["On October 14, 2022, ", { t: "Danny Sullivan", href: "https://dannysullivan.com/" }, ", Google Search's Public Liaison, said so."]),
		block(["A bright spot is the ", { t: "ActivityPub", href: "https://glossary.io/activitypub/" }, " protocol."]),
		block(["The extension checked for Open Graph metadata."]),
	];
	const r = plan(body, [
		ent("Q911595", "StumbleUpon", { wikipedia: "https://en.wikipedia.org/wiki/StumbleUpon" }),
		ent("Q68342360", "Yoast SEO", { website: "https://wordpress.org/plugins/wordpress-seo/" }),
		ent("Q5220864", "Danny Sullivan", { type: "Person" }),
		ent("Q40463886", "ActivityPub"),
		ent("Q95", "Google", { type: "Organization", website: "https://about.google/" }),
		ent("Q17107778", "Open Graph Protocol"),
	]);
	assert.deepEqual(linksOf(r.content), [
		["StumbleUpon", "https://glossary.io/stumbleupon/"],
		["Yoast SEO", "https://glossary.io/yoast-seo/"],
		["Google", "https://glossary.io/google/"],
		["Danny Sullivan", "https://glossary.io/danny-sullivan/"],
		["ActivityPub", "https://glossary.io/activitypub/"],
		["Open Graph", "https://glossary.io/open-graph-protocol/"],
	]);
	assert.deepEqual(r.changes.map((c) => [c.action, c.why]), [
		["switch", "wikipedia"],
		["switch", "named"],
		["switch", "home"],
		["add", "name"],
		["add", "alias"],
	]);
	assert.deepEqual(r.skipped.map((s) => [s.slug, s.why]), [["activitypub", "linked"]]);
});

test("affiliate and internal links never change; an affiliate-named entity gets no glossary link", () => {
	for (const href of ["/visit/fastmail", "https://coywolf.io/fastmail", "https://usefathom.com/ref/AANN81", "https://amzn.to/3gbTYZI", "https://www.backblaze.com/cloud-backup.html#af0118", "https://fastmail.sjv.io/x1", "https://fastmail.com/?via=jon"]) {
		const r = plan([block(["Try ", { t: "Fastmail", href }, "."]), block(["Fastmail is great."])], [ent("Q1", "Fastmail", { website: "https://www.fastmail.com/" })]);
		assert.equal(r.changes.length, 0, href);
		assert.equal(r.skipped[0]?.why, "affiliate", href);
	}
	const internal = plan([block(["Read my ", { t: "Fastmail", href: "https://coywolf.com/news/email/fastmail/" }, " review."]), block(["Fastmail is great."])], [ent("Q1", "Fastmail")]);
	assert.deepEqual(linksOf(internal.content), [
		["Fastmail", "https://coywolf.com/news/email/fastmail/"],
		["Fastmail", "https://glossary.io/fastmail/"],
	]);
	assert.equal(internal.kept[0].why, "internal");
	assert.equal(links.classifyLink("https://forum.coywolf.com/t/x", ent("Q1", "Fastmail"), OPTS.siteHosts), "internal");
	assert.equal(links.classifyLink("https://methodseo.guide/disambiguation/", ent("Q1", "Fastmail"), OPTS.siteHosts), "internal");
});

test("citations stay: deep pages that don't name the entity, docs, articles, sign-up subdomains, claims", () => {
	const cf = ent("Q2", "Cloudflare", { website: "https://www.cloudflare.com/" });
	assert.equal(links.classifyLink("https://www.cloudflare.com/products/registrar/", cf, []), "citation");
	assert.equal(links.classifyLink("https://developers.cloudflare.com/dns/", cf, []), "citation");
	assert.equal(links.classifyLink("https://www.cloudflare.com/", cf, []), "website");
	assert.equal(links.classifyLink("https://workers.cloudflare.com/", ent("Q2", "Cloudflare Workers"), []), "home");
	assert.equal(links.classifyLink("https://www.fastcompany.com/91347003/wordpress-veterans-launch-fair", ent("Q2", "Fast Company"), []), "citation");
	assert.equal(links.classifyLink("https://get.grubhub.com/", ent("Q2", "Grubhub"), []), "citation");
	assert.equal(links.classifyLink("https://www.apple.com/apple-music/", ent("Q2", "Apple Music"), []), "named");
	assert.equal(links.classifyLink("https://www.linkedin.com/in/someone/", ent("Q2", "Some One", { type: "Person" }), []), "social");
	assert.equal(links.classifyLink("https://mastodon.social/@dannysullivan", ent("Q2", "Danny Sullivan", { type: "Person" }), []), "social");

	// A Wikipedia link on a claim cites it; the entity is linked at a plain mention instead.
	const flash = plan(
		[block(["Older games built with Flash, which was ", { t: "released in the mid-nineties", href: "https://en.wikipedia.org/wiki/Adobe_Flash" }, ", are affected."])],
		[ent("Q3", "Adobe Flash", { wikipedia: "https://en.wikipedia.org/wiki/Adobe_Flash" })],
	);
	assert.deepEqual(linksOf(flash.content), [
		["Flash", "https://glossary.io/adobe-flash/"],
		["released in the mid-nineties", "https://en.wikipedia.org/wiki/Adobe_Flash"],
	]);
	assert.equal(flash.kept[0].why, "not-a-name");
});

test("a domain as link text, a name inside a longer name, and a profile in a list stay as they are", () => {
	const domain = plan([block(["Go create an account at ", { t: "mastodon.social", href: "https://mastodon.social" }, "."])], [ent("Q4", "mastodon.social", { website: "https://mastodon.social/" })]);
	assert.equal(domain.changes.length, 0);
	assert.equal(domain.kept[0].why, "domain");

	const unite = plan([block(["Shopify announced more at ", { t: "Shopify", href: "https://www.shopify.com/" }, " Unite 2019."])], [ent("Q5", "Shopify", { website: "https://www.shopify.com/" })]);
	assert.deepEqual(linksOf(unite.content), [
		["Shopify", "https://glossary.io/shopify/"],
		["Shopify", "https://www.shopify.com/"],
	]);
	assert.equal(unite.kept[0].why, "part-of-name");

	const list = plan([block([{ t: "Danny Sullivan", href: "https://mastodon.social/@dannysullivan" }, " (Google)"], { listItem: "bullet", level: 1 })], [ent("Q5220864", "Danny Sullivan", { type: "Person" })]);
	assert.equal(list.changes.length, 0);
	assert.equal(list.kept[0].why, "list");
});

test("mentions: whole words, not inside longer names, abbreviations after another expansion, or the wrong case", () => {
	const google = plan(
		[block(["Check Google Search Console, then google it. Microsoft and Google agree."])],
		[ent("Q95", "Google", { type: "Organization" }), ent("Q999", "Google Search Console")],
	);
	assert.deepEqual(linksOf(google.content), [["Google", "https://glossary.io/google/"]]);
	assert.match(google.changes[0].context, /Microsoft and \[\[Google\]\] agree/);

	const smtp = plan([block(["Gravity SMTP launched. It sends via SMTP servers."])], [ent("Q6", "Simple Mail Transfer Protocol")]);
	assert.match(smtp.changes[0].context, /via \[\[SMTP\]\] servers/);

	const nlp = plan([block(["It uses neuro-linguistic programming (NLP) to work."])], [ent("Q7", "natural language processing")]);
	assert.equal(nlp.changes.length, 0);
	assert.equal(nlp.skipped[0].why, "no-mention");

	const foss = plan([block(["Because of the free and open source software (FOSS) approach, it grew."])], [ent("Q8", "free and open-source software")]);
	assert.deepEqual(linksOf(foss.content), [["free and open source software", "https://glossary.io/foss/"]]);

	const pwa = plan([block(["Progressive Web Apps (PWA) are designed to work offline."])], [ent("Q9", "progressive web app")]);
	assert.deepEqual(linksOf(pwa.content), [["Progressive Web Apps", "https://glossary.io/pwa/"]]);

	const seo = plan([block(["Not seo-friendly, but good for SEO."])], [ent("Q10", "search engine optimization")]);
	assert.deepEqual(linksOf(seo.content), [["SEO", "https://glossary.io/seo/"]]);
});

test("headings, blockquotes and code aren't linked; a sentence start or a quote is only a fallback", () => {
	const body = [
		block(["Signal"], { style: "h2" }),
		block(["Signal is private."], { style: "blockquote" }),
		block([{ t: "Signal", marks: ["code"] }, " in code."]),
		block(["Signal is free. I use Signal daily."]),
	];
	const r = plan(body, [ent("Q11", "Signal")]);
	assert.deepEqual(linksOf(r.content), [["Signal", "https://glossary.io/signal/"]]);
	assert.match(r.changes[0].context, /I use \[\[Signal\]\] daily/);

	const only = plan([block(["Signal is free."])], [ent("Q11", "Signal")]);
	assert.equal(only.changes[0].why, "name (fallback)");

	const quoted = plan([block(["The post “Why Google wins” says Google is big."])], [ent("Q95", "Google")]);
	assert.match(quoted.changes[0].context, /says \[\[Google\]\] is big/);
});

test("one link per entity, excluded QIDs, and entities without a glossary term", () => {
	const r = plan([block(["Google, then Google again, and Google once more."])], [ent("Q95", "Google")]);
	assert.equal(linksOf(r.content).length, 1);
	const ex = plan([block(["Google is here."])], [ent("Q95", "Google")], { exclude: new Set(["Q95"]) });
	assert.equal(ex.changes.length, 0);
	assert.equal(ex.skipped[0].why, "excluded");
	const none = plan([block(["Nothing about Zed."])], [ent("Q404", "Zed")]);
	assert.equal(none.changes.length, 0);
	assert.equal(none.content, none.content);
});

test("applying: a link saved in pieces is switched as one; marks and keys are kept", () => {
	const b = {
		_type: "block",
		_key: "b1",
		style: "normal",
		markDefs: [
			{ _type: "link", _key: "a", href: "https://en.wikipedia.org/wiki/StumbleUpon" },
			{ _type: "link", _key: "b", href: "https://en.wikipedia.org/wiki/StumbleUpon" },
		],
		children: [
			{ _type: "span", _key: "s1", text: "I miss ", marks: [] },
			{ _type: "span", _key: "s2", text: "Stumble", marks: ["a"] },
			{ _type: "span", _key: "s3", text: "Upon", marks: ["b", "strong"] },
			{ _type: "span", _key: "s4", text: " and the **bold** Google era.", marks: ["em"] },
		],
	};
	const r = plan([b], [ent("Q911595", "StumbleUpon", { wikipedia: "https://en.wikipedia.org/wiki/StumbleUpon" }), ent("Q95", "Google")]);
	const out = r.content[0] as typeof b;
	assert.deepEqual(linksOf(r.content), [
		["StumbleUpon", "https://glossary.io/stumbleupon/"],
		["Google", "https://glossary.io/google/"],
	]);
	assert.equal(out.markDefs.filter((d) => d.href.includes("wikipedia")).length, 0, "unused markDefs are dropped");
	assert.ok(out.children.find((c) => c.text === "Upon")!.marks.includes("strong"));
	const google = out.children.find((c) => c.text === "Google")!;
	assert.ok(google.marks.includes("em"), "the split span keeps its marks");
	const keys = out.children.map((c) => c._key);
	assert.equal(new Set(keys).size, keys.length, "span keys stay unique");
	assert.equal((b.children[3] as { text: string }).text, " and the **bold** Google era.", "the input isn't changed");
});

test("hostIn and linkedGlossarySlugs", () => {
	assert.equal(links.hostIn("coywolf.com", ["coywolf.*"]), true);
	assert.equal(links.hostIn("forum.coywolf.com", ["coywolf.*"]), true);
	assert.equal(links.hostIn("coywolf.co.uk", ["coywolf.*"]), true);
	assert.equal(links.hostIn("notcoywolf.com", ["coywolf.*"]), false);
	assert.equal(links.hostIn("www.recollect.fyi", ["recollect.fyi"]), true);
	assert.deepEqual([...links.linkedGlossarySlugs([block([{ t: "x", href: "https://glossary.io/seo/" }, " ", { t: "y", href: "https://glossary.io/" }])])], ["seo"]);
});

// ── Review round: affiliates first, stricter profiles, edge names ─────

test("an affiliate link naming the entity rules out a glossary link, whichever comes first", () => {
	const shop = ent("Q5", "Shopify", { website: "https://www.shopify.com/" });
	const identityFirst = plan([block(["See ", { t: "Shopify", href: "https://www.shopify.com/" }, "."]), block(["Start a ", { t: "Shopify", href: "https://shopify.pxf.io/je22rv" }, " trial."])], [shop]);
	const affiliateFirst = plan([block(["Start a ", { t: "Shopify", href: "https://coywolf.io/shopify" }, " trial."]), block(["See ", { t: "Shopify", href: "https://www.shopify.com/" }, "."])], [shop]);
	const looseAnchor = plan([block(["Try ", { t: "Shopify free", href: "https://shopify.pxf.io/x" }, "."]), block(["Shopify is big."])], [shop]);
	for (const r of [identityFirst, affiliateFirst, looseAnchor]) {
		assert.equal(r.changes.length, 0);
		assert.equal(r.skipped[0].why, "affiliate");
	}
	assert.equal(links.classifyLink("https://try.shopify.com/", shop, []), "affiliate");
	assert.equal(links.classifyLink("https://bit.ly/3abc", shop, []), "affiliate");
	assert.equal(links.classifyLink("https://shop.example.com/?rfsn=123", shop, []), "affiliate");
	assert.equal(links.classifyLink("https://go.dev/", ent("Q20", "Go"), []), "home", "go.dev is a site, not an affiliate subdomain");

	// A loose mention counts only when the affiliate link is for the entity (or its destination is unknown).
	const wp = ent("Q22", "WordPress");
	const hosting = plan([block(["Use ", { t: "Pressable WordPress hosting", href: "/visit/pressable" }, "."]), block(["WordPress runs the web."])], [wp]);
	assert.deepEqual(linksOf(hosting.content)[1], ["WordPress", "https://glossary.io/wordpress/"]);
	const mac = plan([block(["I use a ", { t: "headless Mac mini", href: "https://amzn.to/32SaMzI" }, "."]), block(["The Mac mini is quiet."])], [ent("Q23", "Mac mini")]);
	assert.equal(mac.skipped[0].why, "affiliate", "an Amazon short link can be for the Mac mini itself");
	assert.equal(links.affiliateBrand("https://shopify.pxf.io/x"), "shopify");
	assert.equal(links.affiliateBrand("/visit/yubico/"), "yubico");
	assert.equal(links.affiliateBrand("https://coywolf.io/fastmail", [], ["coywolf.io"]), "fastmail");
	assert.equal(links.affiliateBrand("https://usefathom.com/ref/AANN81"), "usefathom");
	assert.equal(links.affiliateBrand("https://go.nordvpn.net/aff_c?offer_id=15"), "nordvpn");
	assert.equal(links.affiliateBrand("https://amzn.to/3gbTYZI"), "");
	assert.equal(links.affiliateBrand("https://shop.brand.co.uk/?ref=1"), "brand");
	assert.equal(links.affiliateBrand("https://www.amazon.com/dp/B0D?tag=x-20"), "", "a store's link can be for any product");
	const store = plan([block(["A ", { t: "refurbished Mac mini", href: "https://www.amazon.com/dp/B0D?tag=x-20" }, "."]), block(["The Mac mini is quiet."])], [ent("Q23", "Mac mini")]);
	assert.equal(store.skipped[0].why, "affiliate");
	const maker = plan([block(["A ", { t: "headless Mac mini", href: "https://apple.sjv.io/x" }, "."]), block(["The Mac mini is quiet."])], [ent("Q23", "Mac mini", { website: "https://www.apple.com/mac-mini/" })]);
	assert.equal(maker.skipped[0].why, "affiliate", "the maker's affiliate link is for its product");
	assert.notEqual(links.classifyLink("https://github.com/golang/go/", ent("Q20", "Go"), []), "affiliate", "/go/ deeper in a path isn't a redirect");
});

test("social profiles: a bare segment only where that's a profile; article slugs aren't profiles", () => {
	const g = ent("Q95", "Google");
	assert.equal(links.classifyLink("https://medium.com/some-long-article-slug-about-it-1a2b3c", g, []), "citation");
	assert.equal(links.classifyLink("https://x.com/google", g, []), "social");
	assert.equal(links.classifyLink("https://medium.com/@google", g, []), "social");
});

test("Google I/O isn't Google; a plural anchor only matches concepts and abbreviations", () => {
	const io = plan([block(["At Google I/O, the keynote ran long. I think Google won."])], [ent("Q95", "Google")]);
	assert.match(io.changes[0].context, /I think \[\[Google\]\] won/);
	const sentence = plan([block(["We trust Google I think."])], [ent("Q95", "Google")]);
	const contraction = plan([block(["The minimalist Google I\u2019m launching is small."])], [ent("Q95", "Google")]);
	assert.equal(contraction.changes.length, 1, "\"I\u2019m\" after a name isn't part of it");
	assert.equal(links.classifyLink("https://www.tiktok.com/about", ent("Q24", "TikTok"), []), "home");
	assert.equal(sentence.changes.length, 1, "\"I use\" after a name isn't part of it");
	const threads = plan([block(["Post on ", { t: "Threads", href: "https://en.wikipedia.org/wiki/Thread_(network_protocol)" }, "."])], [ent("Q21", "Thread", { wikipedia: "https://en.wikipedia.org/wiki/Thread_(network_protocol)" })]);
	assert.equal(threads.kept[0]?.why, "not-a-name");
	const pwas = plan([block(["Install ", { t: "PWAs", href: "https://en.wikipedia.org/wiki/Progressive_web_app" }, " today."])], [ent("Q9", "progressive web app", { wikipedia: "https://en.wikipedia.org/wiki/Progressive_web_app" })]);
	assert.equal(pwas.changes[0]?.action, "switch");
	const dbs = plan([block(["Read about ", { t: "databases", href: "https://en.wikipedia.org/wiki/Database" }, "."])], [ent("Q25", "database", { wikipedia: "https://en.wikipedia.org/wiki/Database" })]);
	assert.equal(dbs.changes[0]?.action, "switch", "\"databases\" is the plural of \"database\"");
	const both = plan([block(["Meta's Threads is not the Thread protocol."])], [ent("Q21", "Thread"), ent("Q26", "Threads")]);
	assert.deepEqual(linksOf(both.content), [["Threads", "https://glossary.io/threads/"], ["Thread", "https://glossary.io/thread/"]]);
});

// ── The entry edit ───────────────────────────────────────────────

function fakeSite(opts: { draft?: string | null; version?: number; bumpBeforeWrite?: boolean; bumpDuringUpdate?: boolean; publishConflict?: boolean; updateThrows?: boolean; draftBody?: unknown[]; slug?: string; updatedAt?: string; memo?: Record<string, unknown>; siteUrl?: string } = {}) {
	const body = [block(["I miss ", { t: "StumbleUpon", href: "https://en.wikipedia.org/wiki/StumbleUpon" }, ". Google agrees."])];
	type Item = { id: string; slug: string; status: string; data: Record<string, unknown>; version: number; updatedAt: string; draftRevisionId: string | null; liveRevisionId: string | null };
	let item: Item = { id: "E1", slug: opts.slug ?? "joy", status: "published", data: { title: "Joy", content: body }, version: opts.version ?? 3, updatedAt: opts.updatedAt ?? "2026-10-04T23:01:54.489Z", draftRevisionId: opts.draft ?? null, liveRevisionId: "R1" };
	const calls = { update: 0, publish: [] as string[] };
	let reads = 0;
	const record = {
		collection: "posts",
		entryId: "E1",
		title: "Joy",
		hash: "h",
		status: "ok",
		error: "",
		entities: [ent("Q911595", "StumbleUpon", { wikipedia: "https://en.wikipedia.org/wiki/StumbleUpon" }), ent("Q95", "Google")],
		description: "",
		descriptionStatus: "none",
		updated: "2026-11-23T00:00:00.000Z",
	};
	const entries = new Map<string, unknown>([["posts:E1", record]]);
	const memos = new Map<string, Record<string, unknown>>();
	if (opts.memo) memos.set("posts:E1", { collection: "posts", entryId: "E1", linked: [], updated: "", ...opts.memo });
	const ctx = {
		site: { url: opts.siteUrl ?? "https://coywolf.com" },
		settings: { get: async () => null },
		log: { info() {}, warn() {}, error() {} },
		schema: { getCollection: async () => ({ slug: "posts", supports: ["revisions", "drafts"], fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "content", type: "portableText", sortOrder: 1 }] }) },
		storage: {
			aiEntries: { get: async (k: string) => entries.get(k) ?? null, put: async (k: string, v: unknown) => void entries.set(k, v) },
			aiLinks: {
				get: async (k: string) => memos.get(k) ?? null,
				put: async (k: string, v: Record<string, unknown>) => void memos.set(k, structuredClone(v)),
				query: async () => ({ items: [...memos].filter(([, v]) => typeof v.retryAt === "number" && (v.retryAt as number) <= Date.now()).map(([id, data]) => ({ id, data })), hasMore: false }),
			},
			aiGlossary: { get: async () => ({ fetchedAt: Date.now(), format: 2, terms: { Q911595: ["stumbleupon", "A defunct discovery service.", ["StumbleUpon"]], Q95: ["google", "A technology company.", ["Google"]] } }), put: async () => {} },
		},
		http: { fetch: async () => new Response("{}", { status: 500 }) },
		content: {
			get: async () => {
				reads++;
				if (opts.bumpBeforeWrite && reads === 2) item = { ...item, version: item.version + 1 };
				return structuredClone(item);
			},
			getRevision: async () => ({ data: { title: "Joy", content: opts.draftBody ?? body } }),
			update: async (_c: string, _id: string, patch: Record<string, unknown>) => {
				calls.update++;
				if (opts.updateThrows) throw new Error("D1 is busy");
				// Someone's autosave lands right before this write: two versions, the last one theirs.
				item = { ...item, data: { ...item.data, ...patch }, version: item.version + (opts.bumpDuringUpdate ? 2 : 1), draftRevisionId: "R2" };
			},
			getVersioned: async () => ({ item: structuredClone(item), _rev: `rev-${item.version}` }),
			publish: async (_c: string, _id: string, o: { _rev: string }) => {
				if (opts.publishConflict) throw Object.assign(new Error("Content has been modified"), { code: "CONFLICT" });
				calls.publish.push(o._rev);
				item = { ...item, draftRevisionId: null, liveRevisionId: item.draftRevisionId };
			},
		},
	};
	return { ctx: ctx as never, calls, memos, item: () => item };
}

test("linkEntry links, publishes only its own draft, and remembers what it linked", async () => {
	glossary.resetGlossaryForTests();
	const site = fakeSite();
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1", { textHash: "th" });
	assert.equal(out.status, "linked");
	assert.equal(site.calls.update, 1);
	assert.deepEqual(site.calls.publish, ["rev-4"]);
	assert.deepEqual(linksOf(site.item().data.content as unknown[]), [
		["StumbleUpon", "https://glossary.io/stumbleupon/"],
		["Google", "https://glossary.io/google/"],
	]);
	const memo = site.memos.get("posts:E1")!;
	assert.deepEqual(memo.linked, ["Q911595", "Q95"]);
	assert.equal(memo.textHash, "th");
	assert.equal(memo.pending, undefined);
	assert.equal(memo.draft, undefined);
	assert.equal(memo.retryAt, undefined);

	// Running again finds nothing to do and writes nothing.
	const again = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(again.status, "unchanged");
	assert.equal(site.calls.update, 1);
});

test("linkEntry leaves drafts, busy entries, conflicts, skipped entries and removed links alone; a dry run writes nothing", async () => {
	glossary.resetGlossaryForTests();
	const draft = fakeSite({ draft: "R9" });
	assert.equal((await linker.linkEntry(draft.ctx, {}, "posts", "E1")).status, "draft");
	assert.equal(draft.calls.update, 0);
	assert.equal(typeof draft.memos.get("posts:E1")!.retryAt, "number", "a draft is tried again later");

	const busy = fakeSite({ updatedAt: new Date(Date.now() - 30_000).toISOString() });
	assert.equal((await linker.linkEntry(busy.ctx, {}, "posts", "E1")).status, "busy");
	assert.equal(busy.calls.update, 0);

	const conflict = fakeSite({ bumpBeforeWrite: true });
	assert.equal((await linker.linkEntry(conflict.ctx, {}, "posts", "E1")).status, "conflict");
	assert.equal(conflict.calls.update, 0);

	const skipped = fakeSite({ slug: "privacy-policy" });
	assert.equal((await linker.linkEntry(skipped.ctx, { glossaryLinks: { skip: ["privacy-policy"] } }, "posts", "E1")).status, "skipped");

	const noHost = fakeSite({ siteUrl: "" });
	assert.equal((await linker.linkEntry(noHost.ctx, {}, "posts", "E1")).status, "skipped");

	const removed = fakeSite({ memo: { linked: ["Q911595", "Q95"] } });
	assert.equal((await linker.linkEntry(removed.ctx, {}, "posts", "E1")).status, "unchanged");
	assert.equal(removed.calls.update, 0);

	const dry = fakeSite();
	const planned = await linker.linkEntry(dry.ctx, {}, "posts", "E1", { dryRun: true, exclude: ["Q95"] });
	assert.equal(planned.status, "planned");
	assert.deepEqual(planned.changes.map((c) => c.slug), ["stumbleupon"]);
	assert.equal(dry.calls.update, 0);
	assert.equal(dry.memos.size, 0, "a dry run remembers nothing");
});

test("linkEntry: a publish conflict is staged and retried; a save during the write is a collision; an unpublished edit of its own is finished", async () => {
	glossary.resetGlossaryForTests();
	const site = fakeSite({ publishConflict: true });
	assert.equal((await linker.linkEntry(site.ctx, {}, "posts", "E1")).status, "staged");
	const staged = site.memos.get("posts:E1")!;
	assert.deepEqual(staged.linked, [], "links that may not have stuck aren't remembered");
	assert.equal(typeof staged.retryAt, "number");

	const collided = fakeSite({ bumpDuringUpdate: true });
	assert.equal((await linker.linkEntry(collided.ctx, {}, "posts", "E1")).status, "collided");
	assert.deepEqual(collided.calls.publish, [], "nothing is published over someone's save");
	assert.equal(collided.memos.get("posts:E1")!.retryAt, undefined, "a collision waits for a person");

	// An edit whose publish never happened: a draft one version after the marker, with the live text and the edit's links.
	const linkedBody = [block(["I miss ", { t: "StumbleUpon", href: "https://glossary.io/stumbleupon/" }, ". Google agrees."])];
	const marker = { pending: 3, pendingQids: ["Q911595"], pendingSlugs: ["stumbleupon"], linked: [] };
	const own = fakeSite({ draft: "R7", version: 4, memo: marker, draftBody: linkedBody });
	const finished = await linker.linkEntry(own.ctx, {}, "posts", "E1");
	assert.equal(finished.status, "linked");
	assert.deepEqual(own.calls.publish, ["rev-4"]);
	assert.equal(own.memos.get("posts:E1")!.pending, undefined);
	assert.deepEqual(own.memos.get("posts:E1")!.linked, ["Q911595"], "what it published is remembered");

	// Same version, but an editor's draft (no glossary links, or other text): never published, and the stale marker is dropped.
	const editors = fakeSite({ draft: "R7", version: 4, memo: marker });
	assert.equal((await linker.linkEntry(editors.ctx, {}, "posts", "E1")).status, "draft");
	assert.deepEqual(editors.calls.publish, []);
	assert.equal(editors.memos.get("posts:E1")!.pending, undefined);
	const edited = fakeSite({ draft: "R7", version: 4, memo: marker, draftBody: [block(["I miss ", { t: "StumbleUpon", href: "https://glossary.io/stumbleupon/" }, ". Google disagrees."])] });
	assert.equal((await linker.linkEntry(edited.ctx, {}, "posts", "E1")).status, "draft");
	assert.deepEqual(edited.calls.publish, []);

	const theirs = fakeSite({ draft: "R7", version: 6, memo: marker, draftBody: linkedBody });
	assert.equal((await linker.linkEntry(theirs.ctx, {}, "posts", "E1")).status, "draft");
	assert.deepEqual(theirs.calls.publish, []);

	// An update that fails without writing drops its marker.
	const failing = fakeSite({ updateThrows: true });
	await assert.rejects(linker.linkEntry(failing.ctx, {}, "posts", "E1"));
	assert.equal(failing.memos.get("posts:E1")!.pending, undefined);

	// Exclusions are remembered even when the entry has to wait.
	const waiting = fakeSite({ draft: "R9" });
	await linker.linkEntry(waiting.ctx, {}, "posts", "E1", { exclude: ["Q95"] });
	assert.deepEqual(waiting.memos.get("posts:E1")!.linked, ["Q95"]);
});

test("retryDue links entries whose wait is over", async () => {
	glossary.resetGlossaryForTests();
	const site = fakeSite({ memo: { linked: [], retryAt: Date.now() - 1000, tries: 1 } });
	assert.equal(await linker.retryDue(site.ctx, {}, 3), 1);
	assert.equal(site.calls.update, 1);
	assert.equal(site.memos.get("posts:E1")!.retryAt, undefined);
});

test("shouldLink and withRetry", () => {
	const ok = { status: "ok" as const, title: "Joy", entities: [ent("Q95", "Google")] };
	assert.equal(linker.shouldLink(null, null, "a"), true, "a first analysis links");
	assert.equal(linker.shouldLink(null, ok, "a"), false, "an entry analyzed before the part was on waits");
	assert.equal(linker.shouldLink(null, { status: "error" as const, title: "", entities: [] }, "a"), true, "a first analysis that failed before still links");
	assert.equal(linker.shouldLink(null, { status: "error" as const, title: "Joy", entities: ok.entities }, "a"), false, "a failed re-analysis of an old entry doesn't");
	assert.equal(linker.shouldLink({ textHash: "a" }, ok, "a"), false, "same text: a settings re-analysis");
	assert.equal(linker.shouldLink({ textHash: "a" }, ok, "b"), true, "the text changed");
	const memo = { collection: "posts", entryId: "E1", linked: [], updated: "" };
	let m = linker.withRetry(memo, "draft", 0);
	assert.equal(m.retryAt, 30 * 60_000);
	for (let i = 0; i < linker.MAX_TRIES; i++) m = linker.withRetry(m, "busy", 0);
	assert.equal(m.retryAt, undefined, "it stops after the last try");
	assert.equal(linker.withRetry({ ...memo, retryAt: 5, tries: 2 }, "linked").retryAt, undefined);
});

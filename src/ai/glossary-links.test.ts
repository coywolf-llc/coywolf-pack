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

// ── The entry edit ───────────────────────────────────────────────

function fakeSite(opts: { draft?: string | null; bumpBeforeWrite?: boolean; publishConflict?: boolean; slug?: string; record?: Record<string, unknown> } = {}) {
	const body = [block(["I miss ", { t: "StumbleUpon", href: "https://en.wikipedia.org/wiki/StumbleUpon" }, ". Google agrees."])];
	type Item = { id: string; slug: string; status: string; data: Record<string, unknown>; version: number; updatedAt: string; draftRevisionId: string | null; liveRevisionId: string | null };
	let item: Item = { id: "E1", slug: opts.slug ?? "joy", status: "published", data: { title: "Joy", content: body }, version: 3, updatedAt: "2026-10-04T23:01:54.489Z", draftRevisionId: opts.draft ?? null, liveRevisionId: "R1" };
	const calls = { update: 0, publish: [] as string[] };
	let reads = 0;
	const records = new Map<string, Record<string, unknown>>();
	records.set("posts:E1", {
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
		...opts.record,
	});
	const ctx = {
		site: { url: "https://coywolf.com" },
		settings: { get: async () => null },
		log: { info() {}, warn() {}, error() {} },
		schema: { getCollection: async () => ({ slug: "posts", supports: ["revisions", "drafts"], fields: [{ slug: "title", type: "string", sortOrder: 0 }, { slug: "content", type: "portableText", sortOrder: 1 }] }) },
		storage: {
			aiEntries: { get: async (k: string) => records.get(k) ?? null, put: async (k: string, v: Record<string, unknown>) => void records.set(k, v) },
			aiGlossary: { get: async () => ({ fetchedAt: Date.now(), format: 2, terms: { Q911595: ["stumbleupon", "A defunct discovery service.", ["StumbleUpon"]], Q95: ["google", "A technology company.", ["Google"]] } }), put: async () => {} },
		},
		http: { fetch: async () => new Response("{}", { status: 500 }) },
		content: {
			get: async () => {
				reads++;
				if (opts.bumpBeforeWrite && reads === 2) item = { ...item, version: 4 };
				return structuredClone(item);
			},
			update: async (_c: string, _id: string, patch: Record<string, unknown>) => {
				calls.update++;
				item = { ...item, data: { ...item.data, ...patch }, version: item.version + 1, draftRevisionId: "R2" };
			},
			getVersioned: async () => ({ item: structuredClone(item), _rev: `rev-${item.version}` }),
			publish: async (_c: string, _id: string, o: { _rev: string }) => {
				if (opts.publishConflict) throw Object.assign(new Error("Content has been modified"), { code: "CONFLICT" });
				calls.publish.push(o._rev);
				item = { ...item, draftRevisionId: null, liveRevisionId: item.draftRevisionId };
			},
		},
	};
	return { ctx: ctx as never, calls, records, item: () => item };
}

test("linkEntry links, publishes only its own draft, and remembers what it linked", async () => {
	glossary.resetGlossaryForTests();
	const site = fakeSite();
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1", { hashText: async () => "th" });
	assert.equal(out.status, "linked");
	assert.equal(site.calls.update, 1);
	assert.deepEqual(site.calls.publish, ["rev-4"]);
	assert.deepEqual(linksOf(site.item().data.content as unknown[]), [
		["StumbleUpon", "https://glossary.io/stumbleupon/"],
		["Google", "https://glossary.io/google/"],
	]);
	const rec = site.records.get("posts:E1")!;
	assert.deepEqual(rec.glossaryLinked, ["Q911595", "Q95"]);
	assert.equal(rec.textHash, "th");
	assert.equal(rec.glossaryDraft, undefined);
	assert.equal(rec.updated, "2026-11-23T00:00:00.000Z", "the analysis date isn't touched");

	// Running again finds nothing to do and writes nothing.
	const again = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(again.status, "unchanged");
	assert.equal(site.calls.update, 1);
});

test("linkEntry leaves drafts, conflicts, skipped entries and removed links alone; a dry run writes nothing", async () => {
	glossary.resetGlossaryForTests();
	const draft = fakeSite({ draft: "R9" });
	assert.equal((await linker.linkEntry(draft.ctx, {}, "posts", "E1")).status, "draft");
	assert.equal(draft.calls.update, 0);

	const conflict = fakeSite({ bumpBeforeWrite: true });
	assert.equal((await linker.linkEntry(conflict.ctx, {}, "posts", "E1")).status, "conflict");
	assert.equal(conflict.calls.update, 0);

	const skipped = fakeSite({ slug: "privacy-policy" });
	assert.equal((await linker.linkEntry(skipped.ctx, { glossaryLinks: { skip: ["privacy-policy"] } }, "posts", "E1")).status, "skipped");

	const removed = fakeSite({ record: { glossaryLinked: ["Q911595", "Q95"] } });
	assert.equal((await linker.linkEntry(removed.ctx, {}, "posts", "E1")).status, "unchanged");
	assert.equal(removed.calls.update, 0);

	const dry = fakeSite();
	const planned = await linker.linkEntry(dry.ctx, {}, "posts", "E1", { dryRun: true, exclude: ["Q95"] });
	assert.equal(planned.status, "planned");
	assert.deepEqual(planned.changes.map((c) => c.slug), ["stumbleupon"]);
	assert.equal(dry.calls.update, 0);
	assert.equal(dry.records.get("posts:E1")!.glossaryLinked, undefined);
});

test("linkEntry: a publish conflict leaves the edit staged and the new links unremembered; its own failed draft is published next time", async () => {
	glossary.resetGlossaryForTests();
	const site = fakeSite({ publishConflict: true });
	const out = await linker.linkEntry(site.ctx, {}, "posts", "E1");
	assert.equal(out.status, "staged");
	assert.deepEqual(site.records.get("posts:E1")!.glossaryLinked, []);

	const own = fakeSite({ draft: "R7", record: { glossaryDraft: "R7" } });
	const finished = await linker.linkEntry(own.ctx, {}, "posts", "E1");
	assert.equal(finished.status, "linked");
	assert.deepEqual(own.calls.publish, ["rev-3"]);
	assert.equal(own.records.get("posts:E1")!.glossaryDraft, undefined);
});

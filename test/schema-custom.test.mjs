// Run: node --import ./test/ts-resolve.mjs --test test/schema-custom.test.mjs
// Schema & Social's custom markup: parsing, save-time errors, the rich-result
// lint (the old recollect.fyi markup's problems), paths, reference
// resolution, and the page:metadata contributions EmDash prints.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const custom = await import("../src/schema/custom.ts");
const { lintNodes } = await import("../src/schema/custom-lint.ts");
const { MARKUP_TEMPLATES, templateText } = await import("../src/schema/custom-templates.ts");
await import("../src/schema/pack.ts"); // Registers the schema switches (the routes check them).
const { schemaContributions, schemaModule, invalidateSchemaConfig } = await import("../src/schema/module.ts");
const { resolvePageMetadata, renderPageMetadata, safeJsonLdSerialize } = await import("emdash/page");

const ORIGIN = "https://recollect.fyi";
const OLD_MARKUP = readFileSync(new URL("./fixtures/recollect-old-markup.json", import.meta.url), "utf8");

const at = (warnings, where) => warnings.filter((w) => w.at === where).map((w) => w.message);
const has = (warnings, where, text) => at(warnings, where).some((m) => m.includes(text));

// ── Parsing ──────────────────────────────────────────────────────

test("parses one node, an array, or @graph; @context is optional and stripped", () => {
	const one = custom.parseMarkup('{"@context":"https://schema.org","@type":"Service","name":"A"}');
	assert.deepEqual(one, { nodes: [{ "@type": "Service", name: "A" }], errors: [] });
	const list = custom.parseMarkup('[{"@type":"Service","name":"A"},{"@type":"Person","name":"B","@context":"http://schema.org/"}]');
	assert.deepEqual(list.nodes.map((n) => n.name), ["A", "B"]);
	assert.deepEqual(list.errors, []);
	const graph = custom.parseMarkup('{"@context":"https://schema.org/","@graph":[{"@type":"Service"},{"@type":["Product","Thing"]}]}');
	assert.equal(graph.nodes.length, 2);
	assert.deepEqual(graph.errors, []);
	assert.ok(!JSON.stringify(graph.nodes).includes("@context"));
	// Null values are dropped (validators prefer a missing key).
	assert.deepEqual(custom.parseMarkup('{"@type":"Service","name":null,"x":[null,1]}').nodes, [{ "@type": "Service", x: [1] }]);
});

test("refuses what isn't JSON-LD for schema.org", () => {
	const err = (src) => custom.parseMarkup(src).errors.join(" ");
	assert.match(err("{ nope"), /isn't valid JSON/);
	assert.match(err('"text"'), /must be a JSON object/);
	assert.match(err("42"), /must be a JSON object/);
	assert.match(err(""), /Add the JSON-LD/);
	assert.match(err("[]"), /at least one node/);
	assert.match(err('{"name":"No type"}'), /needs a @type/);
	assert.match(err('{"@type":""}'), /needs a @type/);
	assert.match(err('{"@type":[]}'), /needs a @type/);
	assert.match(err('[{"@type":"Service"}, 5]'), /Node 2 isn't an object/);
	assert.match(err('{"@context":"https://example.com/vocab","@type":"Service"}'), /Only "https:\/\/schema.org"/);
	assert.match(err('{"@type":"Service","provider":{"@context":{"@vocab":"x"},"name":"A"}}'), /Only "https:\/\/schema.org"/);
	assert.match(err('{"@graph":{"@type":"Service"}}'), /@graph must be an array/);
	assert.match(err('{"@graph":[{"@type":"Service"}],"name":"x"}'), /only @context is allowed/);
	assert.match(err(JSON.stringify({ "@type": "Service", description: "x".repeat(33 * 1024) })), /limit is 32 KB/);
	let deep = '{"@type":"Thing","a":1}';
	for (let i = 0; i < 30; i++) deep = `{"@type":"Thing","n":${deep}}`;
	assert.match(err(deep), /nested more than/);
});

test("@id collisions with the pack's own ids are errors; references are fine", () => {
	const errors = (src, options = {}) => custom.checkMarkup(src, { origin: ORIGIN, base: `${ORIGIN}/`, ...options }).errors;
	assert.match(errors('{"@type":"Organization","@id":"#organization","name":"Another"}').join(), /one of the pack's own @ids/);
	assert.match(errors('{"@type":"WebPage","@id":"https://recollect.fyi/#webpage","name":"x"}').join(), /one of the pack's own @ids/);
	assert.match(errors('{"@type":"Person","@id":"#person-jon","name":"Jon"}').join(), /own @ids/);
	assert.match(errors('{"@type":"Service","provider":{"@id":"#website","name":"x"}}').join(), /own @ids/);
	// Pure references (with or without @type) link to the pack's nodes.
	assert.deepEqual(errors('{"@type":"Service","provider":{"@id":"#organization"},"isPartOf":{"@type":"WebSite","@id":"#website"}}'), []);
	// Another site's #organization is that site's.
	assert.deepEqual(errors('{"@type":"Service","provider":{"@type":"Organization","@id":"https://coywolf.llc/#organization","name":"Coywolf"}}'), []);
	// The publisher's own @id from Site details.
	assert.match(errors('{"@type":"Organization","@id":"#org","name":"x"}', { reserved: [`${ORIGIN}/#org`] }).join(), /own @ids/);
	assert.match(errors('{"@type":"Service","@id":5}').join(), /must be a string/);
});

// ── Lint ─────────────────────────────────────────────────────────

test("the old recollect.fyi markup: every problem is reported", () => {
	const check = custom.checkMarkup(OLD_MARKUP, { origin: ORIGIN, base: `${ORIGIN}/`, graph: true });
	// Nothing in it is a hard error (it parses, and its ids aren't the pack's).
	assert.deepEqual(check.errors, []);
	const w = check.warnings;
	assert.ok(has(w, "WebApplication.screenshot", "`screenshot` is empty"), JSON.stringify(w, null, 1));
	assert.ok(has(w, "WebApplication.thumbnail", "`thumbnail` is empty"));
	assert.ok(has(w, "WebApplication.aggregateRating", "ratingValue 0 is outside 1–5"));
	assert.ok(has(w, "WebApplication.aggregateRating", "ratingCount is 0"));
	assert.ok(has(w, "WebApplication.offers.priceSpecification[0].pricecurrency", "`pricecurrency` should be `priceCurrency`"));
	assert.ok(has(w, "WebApplication.offers.priceSpecification[1].pricecurrency", "`pricecurrency` should be `priceCurrency`"));
	// With the graph on, the page already has a WebSite.
	assert.ok(has(w, "WebSite", "already has the site's WebSite"));
	// The miscased priceCurrency isn't also reported as missing.
	assert.ok(!w.some((x) => x.at.startsWith("WebApplication.offers.priceSpecification") && x.message.startsWith("Add priceCurrency")));
});

test("rich-result rules for apps, offers, products, ratings, FAQs, breadcrumbs, events", () => {
	const lint = (node, options) => lintNodes([node], options);
	let w = lint({ "@type": "WebApplication", name: "App", offers: { "@type": "Offer", price: "$9.99", priceCurrency: "usd" } });
	assert.ok(has(w, "WebApplication", "Add aggregateRating or review"));
	assert.ok(has(w, "WebApplication", "applicationCategory is recommended"));
	assert.ok(has(w, "WebApplication.offers.price", "should be a number"));
	assert.ok(has(w, "WebApplication.offers.priceCurrency", "in capitals: USD"));
	w = lint({ "@type": "SoftwareApplication", name: "A", applicationCategory: "Notes", offers: { "@type": "Offer", price: 0, priceCurrency: "XYZ" }, aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5, ratingCount: 12 } });
	assert.ok(has(w, "SoftwareApplication.applicationCategory", "isn't a value Google accepts"));
	assert.ok(has(w, "SoftwareApplication.offers.priceCurrency", "isn't an ISO 4217"));
	assert.ok(!at(w, "SoftwareApplication.aggregateRating").length);
	w = lint({ "@type": "Product", name: "P" });
	assert.ok(has(w, "Product", "Add offers or review or aggregateRating"));
	w = lint({ "@type": "Product", name: "P", offers: { "@type": "AggregateOffer", lowPrice: "10", highPrice: "5", priceCurrency: "USD", offerCount: "two" } });
	assert.ok(has(w, "Product.offers", "lowPrice (10) is higher than highPrice (5)"));
	assert.ok(has(w, "Product.offers.offerCount", "whole number"));
	w = lint({ "@type": "Product", name: "P", offers: { name: "No type", price: "1", priceCurrency: "USD" } });
	assert.ok(has(w, "Product.offers", 'Add "@type": "Offer"'));
	w = lint({ "@type": "Product", name: "P", aggregateRating: { "@type": "AggregateRating", ratingValue: 9, bestRating: 10, worstRating: 0, reviewCount: 3 } });
	assert.ok(!at(w, "Product.aggregateRating").length, JSON.stringify(w));
	w = lint({ "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?" }, { "@type": "Answer", text: "x" }] });
	assert.ok(has(w, "FAQPage.mainEntity[0]", "Add acceptedAnswer or suggestedAnswer"));
	assert.ok(has(w, "FAQPage.mainEntity[1]", "should be a Question"));
	assert.ok(w.some((x) => x.note && x.message.includes("government and health")));
	w = lint({ "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home" }, { "@type": "ListItem", position: 3, name: "Here" }] });
	assert.ok(has(w, "BreadcrumbList.itemListElement[0]", "Add item"));
	assert.ok(has(w, "BreadcrumbList.itemListElement[1]", "position should be 2"));
	w = lint({ "@type": "Event", name: "E", startDate: "next Tuesday", eventStatus: "scheduled" });
	assert.ok(has(w, "Event", "Add location"));
	assert.ok(has(w, "Event.startDate", "ISO 8601"));
	assert.ok(has(w, "Event.eventStatus", "isn't a value Google accepts"));
	w = lint({ "@type": "webapplication", name: "x", URL: "recollect.fyi", sameAs: ["", "https://x.com/a"] });
	assert.ok(has(w, "webapplication", "should be `WebApplication`"));
	assert.ok(has(w, "webapplication.URL", "`URL` should be `url`"));
	assert.ok(has(w, "webapplication.sameAs[0]", "This item is empty"));
	w = lint({ "@type": "Service", name: "S", url: "recollect.fyi" });
	assert.ok(has(w, "Service.url", "should be a full URL"));
});

test("every template parses, has no hard errors, and links to the publisher", () => {
	for (const key of Object.keys(MARKUP_TEMPLATES)) {
		const check = custom.checkMarkup(templateText(key), { origin: ORIGIN, base: `${ORIGIN}/`, graph: true });
		assert.deepEqual(check.errors, [], key);
	}
	assert.ok(templateText("Service").includes('"@id": "#organization"'));
});

// ── Paths ────────────────────────────────────────────────────────

test("paths: normalized the site's way, matched exactly", () => {
	const norm = (p, policy) => custom.normalizeRulePath(p, policy);
	assert.deepEqual(norm("/", "always"), { path: "/" });
	assert.deepEqual(norm("pricing", "always"), { path: "/pricing/" });
	assert.deepEqual(norm("/pricing/", "never"), { path: "/pricing" });
	assert.deepEqual(norm("/pricing/", "ignore"), { path: "/pricing/" });
	assert.deepEqual(norm("/pricing", "ignore"), { path: "/pricing" });
	assert.deepEqual(norm("//a//b/"), { error: "Enter a path on this site, like /pricing/, not a full URL." });
	assert.deepEqual(norm("/a//b/", "always"), { path: "/a/b/" });
	for (const bad of ["", "https://recollect.fyi/", "/pricing?x=1", "/#top", "/blog/*", "/a b", "/a/../b"]) assert.ok("error" in norm(bad), bad);
	assert.equal(custom.pathKey("/pricing/"), "/pricing");
	assert.equal(custom.pathKey("/pricing"), "/pricing");
	assert.equal(custom.pathKey("/"), "/");
	assert.equal(custom.pathKey("/caf%C3%A9/"), "/café");
	assert.equal(custom.pathKey("/a/?x=1"), "/a");
	const rules = [
		{ id: "a", label: "A", path: "/pricing/", enabled: true },
		{ id: "b", label: "B", path: "/pricing", enabled: true },
		{ id: "c", label: "C", path: "/pricing/", enabled: false },
	];
	assert.equal(custom.pathRuleConflicts(rules).length, 1);
	assert.deepEqual(custom.pathRuleConflicts([rules[0], rules[2]]), []);
});

// ── Output ───────────────────────────────────────────────────────

const PACK_GRAPH = [
	{ "@type": "WebPage", "@id": `${ORIGIN}/pricing/#webpage`, url: `${ORIGIN}/pricing/` },
	{ "@type": "ImageObject", "@id": `${ORIGIN}/pricing/#primaryimage` },
	{ "@type": "BlogPosting", "@id": `${ORIGIN}/pricing/#article`, author: { "@id": `${ORIGIN}/author/jon/#person` } },
	{ "@type": "WebSite", "@id": `${ORIGIN}/#website` },
	{ "@type": "Organization", "@id": `${ORIGIN}/#org`, name: "Recollect" },
	{ "@type": "Person", "@id": `${ORIGIN}/author/jon/#person`, name: "Jon" },
];
const rule = (nodes, mainEntity = false) => ({ contributionId: "coywolf-custom:r-test", label: "Test", nodes, mainEntity });

test("relative @id and url values resolve against the page; pack references to the real ids (graph on)", () => {
	const nodes = custom.parseMarkup(
		JSON.stringify({
			"@type": "Service",
			"@id": "#service",
			url: "/pricing/",
			name: "Recollect",
			description: "#not-a-url stays text",
			provider: { "@id": "#organization" },
			isPartOf: { "@id": "#website" },
			mainEntityOfPage: { "@id": "#webpage" },
			image: { "@id": "#primaryimage" },
			author: { "@id": "#author" },
			sameAs: ["https://x.com/recollect", "/about/"],
			subjectOf: { "@type": "WebPage", "@id": "#webpage", name: "a copy of the pack's WebPage" },
		}),
	).nodes;
	const out = custom.customOutput(rule(nodes), { pageUrl: `${ORIGIN}/pricing/`, graph: PACK_GRAPH, publisherId: `${ORIGIN}/#org` });
	const g = out.contribution.graph;
	assert.equal(out.contribution.kind, "jsonld");
	assert.equal(out.contribution.id, "coywolf-custom:r-test");
	assert.equal(g["@context"], "https://schema.org");
	assert.equal(g["@id"], `${ORIGIN}/pricing/#service`);
	assert.equal(g.url, `${ORIGIN}/pricing/`);
	assert.equal(g.description, "#not-a-url stays text");
	assert.deepEqual(g.provider, { "@id": `${ORIGIN}/#org` }); // The publisher, whatever its @id.
	assert.deepEqual(g.isPartOf, { "@id": `${ORIGIN}/#website` });
	assert.deepEqual(g.mainEntityOfPage, { "@id": `${ORIGIN}/pricing/#webpage` });
	assert.deepEqual(g.image, { "@id": `${ORIGIN}/pricing/#primaryimage` });
	assert.deepEqual(g.author, { "@id": `${ORIGIN}/author/jon/#person` });
	assert.deepEqual(g.sameAs, ["https://x.com/recollect", `${ORIGIN}/about/`]);
	// A nested copy of a pack node becomes a reference to it.
	assert.deepEqual(g.subjectOf, { "@id": `${ORIGIN}/pricing/#webpage` });
	assert.equal(out.mainEntityId, undefined);
});

test("graph off: no pack aliases, no mainEntity; ids still absolute", () => {
	const nodes = custom.parseMarkup('{"@type":"Service","provider":{"@id":"#organization"},"url":"/"}').nodes;
	const out = custom.customOutput(rule(nodes, true), { pageUrl: `${ORIGIN}/`, graph: null });
	assert.deepEqual(out.contribution.graph, { "@context": "https://schema.org", "@type": "Service", provider: { "@id": `${ORIGIN}/#organization` }, url: `${ORIGIN}/` });
	assert.equal(out.mainEntityId, undefined);
});

test("mainEntity: the first node gets <page URL>#<type> when it has no @id; repeated @ids and pack nodes are dropped", () => {
	const nodes = custom.parseMarkup(
		JSON.stringify([
			{ "@type": "WebApplication", name: "Recollect" },
			{ "@type": "Organization", "@id": "#brand", name: "One" },
			{ "@type": "Organization", "@id": "#brand", name: "Two" },
			{ "@type": "Organization", "@id": `${ORIGIN}/#org`, name: "Redefined" },
		]),
	).nodes;
	const out = custom.customOutput(rule(nodes, true), { pageUrl: `${ORIGIN}/pricing/`, graph: PACK_GRAPH, publisherId: `${ORIGIN}/#org` });
	const g = out.contribution.graph["@graph"];
	assert.equal(out.mainEntityId, `${ORIGIN}/pricing/#webapplication`);
	assert.deepEqual(Object.keys(g[0]).slice(0, 2), ["@type", "@id"]);
	assert.deepEqual(g.map((n) => n.name), ["Recollect", "One"]);
	// An existing @id is kept as the main entity.
	const own = custom.customOutput(rule(custom.parseMarkup('{"@type":"Service","@id":"#app"}').nodes, true), { pageUrl: `${ORIGIN}/`, graph: [] });
	assert.equal(own.mainEntityId, `${ORIGIN}/#app`);
	// Nothing left: no contribution.
	assert.equal(custom.customOutput(rule([{ "@type": "WebSite", "@id": `${ORIGIN}/#website`, name: "x" }]), { pageUrl: `${ORIGIN}/`, graph: PACK_GRAPH }), null);
});

test("pageRule: the entry's rule wins; path rules match the request path exactly", () => {
	const doc = {
		rules: [
			{ id: "home", label: "Home", path: "/", enabled: true, markup: '{"@type":"Service","name":"Home"}' },
			{ id: "post", label: "Post", path: "/my-post/", enabled: true, markup: '{"@type":"Service","name":"Path"}' },
			{ id: "off", label: "Off", path: "/off/", enabled: false, markup: '{"@type":"Service"}' },
			{ id: "bad", label: "Broken", path: "/broken/", enabled: true, markup: "{" },
		],
	};
	const byPath = custom.compilePathRules(doc);
	assert.deepEqual([...byPath.keys()], ["/", "/my-post"]);
	const home = custom.pageRule({ path: "/", url: `${ORIGIN}/` }, byPath);
	assert.equal(home.contributionId, "coywolf-custom:home");
	assert.equal(custom.pageRule({ path: "/my-post", url: `${ORIGIN}/my-post` }, byPath).contributionId, "coywolf-custom:post");
	assert.equal(custom.pageRule({ path: "/other/" }, byPath), null);
	assert.equal(custom.pageRule({ path: "/off/" }, byPath), null);
	const entry = custom.compileEntryRule("posts", "e1", { markup: '{"@type":"Service","name":"Entry"}', enabled: true });
	assert.equal(custom.pageRule({ path: "/my-post/" }, byPath, entry).contributionId, "coywolf-custom:entry:posts:e1");
	assert.equal(custom.compileEntryRule("posts", "e1", { markup: '{"@type":"Service"}', enabled: false }), null);
});

test("scriptJson escapes like EmDash's safeJsonLdSerialize", () => {
	const value = { text: "</script><script>alert(1)</script> <!-- \u2028 \u2029 >" };
	assert.equal(custom.scriptJson(value), safeJsonLdSerialize(value));
});

// ── The page hook ────────────────────────────────────────────────

/** An in-memory plugin storage collection. */
function memoryStore(rows = {}) {
	const data = new Map(Object.entries(rows));
	return {
		data,
		get: async (id) => data.get(id) ?? null,
		getMany: async (ids) => new Map(ids.filter((id) => data.has(id)).map((id) => [id, data.get(id)])),
		put: async (id, value) => void data.set(id, structuredClone(value)),
		delete: async (id) => data.delete(id),
		query: async () => ({ items: [...data].map(([id, value]) => ({ id, data: value })), hasMore: false }),
	};
}

function fakeCtx({ docs = {}, entries = {}, features = {}, site = {} } = {}) {
	const storage = { schemaDocs: memoryStore(docs), schemaEntries: memoryStore(entries), schemaAuthors: memoryStore() };
	const log = [];
	return {
		storage,
		log: { warn: (msg, data) => log.push(`${msg} ${JSON.stringify(data)}`), info() {}, error() {} },
		logged: log,
		site: { url: ORIGIN, name: "Recollect", locale: "en-US", ...site },
		settings: { list: async () => [], get: async (key) => (key === "features" ? features : null), set: async () => {} },
		content: {
			get: async (collection, id) => (id === "e1" ? { id, slug: "my-post", data: { title: "My post" }, status: "published" } : null),
		},
	};
}

const RECOLLECT_ORG = {
	publisherType: "organization",
	orgRows: [
		{ prop: "name", value: "Recollect" },
		{ prop: "url", value: "https://recollect.fyi/" },
		{ prop: "logo", value: "https://media.recollect.fyi/logo.png" },
	],
};

const WEB_APPLICATION = JSON.stringify(
	{
		"@type": "WebApplication",
		"@id": "#app",
		name: "Recollect",
		url: "https://app.recollect.fyi/",
		applicationCategory: "BusinessApplication",
		operatingSystem: "Any",
		browserRequirements: "Requires JavaScript",
		creator: { "@id": "#organization" },
		offers: [
			{ "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
			{ "@type": "Offer", name: "Premium", price: "24", priceCurrency: "USD" },
		],
	},
	null,
	"\t",
);

const homePage = {
	url: `${ORIGIN}/`,
	path: "/",
	locale: "en-US",
	kind: "custom",
	pageType: "website",
	title: "Recollect",
	pageTitle: "Recollect",
	description: "Notes that sync.",
	canonical: `${ORIGIN}/`,
	image: null,
	siteName: "Recollect",
	siteUrl: ORIGIN,
};
const GRAPH = { schema: true, "schema.graph": true, "schema.custom": true };

test("home page (no entry): the rule is its own contribution, linked to the publisher, and the WebPage's main entity", async () => {
	invalidateSchemaConfig();
	const ctx = fakeCtx({ docs: { site: RECOLLECT_ORG, custom: { rules: [{ id: "recollect-app", label: "Recollect app", path: "/", enabled: true, mainEntity: true, markup: WEB_APPLICATION }] } } });
	const out = await schemaContributions(ctx, homePage, {}, GRAPH);
	const primary = out.find((c) => c.id === "primary");
	const app = out.find((c) => c.id === "coywolf-custom:recollect-app");
	assert.ok(primary && app, JSON.stringify(out.map((c) => c.id)));
	assert.equal(app.kind, "jsonld");
	assert.equal(app.graph["@id"], `${ORIGIN}/#app`);
	assert.deepEqual(app.graph.creator, { "@id": `${ORIGIN}/#organization` });
	const webpage = primary.graph["@graph"].find((n) => n["@id"] === `${ORIGIN}/#webpage`);
	assert.deepEqual(webpage.mainEntity, { "@id": `${ORIGIN}/#app` });
	assert.ok(primary.graph["@graph"].some((n) => n["@id"] === `${ORIGIN}/#organization`));
	// What EmDash prints in the head.
	const html = renderPageMetadata(resolvePageMetadata(out));
	assert.equal((html.match(/application\/ld\+json/g) ?? []).length, 2);
	if (process.env.SHOW_JSONLD) console.log(JSON.stringify(out.filter((c) => c.kind === "jsonld"), null, 2));
	assert.deepEqual(ctx.logged, []);
});

test("feature off (or the module off): no custom output, the rest unchanged", async () => {
	const rules = { rules: [{ id: "r1", label: "x", path: "/", enabled: true, mainEntity: true, markup: WEB_APPLICATION }] };
	invalidateSchemaConfig();
	const without = await schemaContributions(fakeCtx({ docs: { site: RECOLLECT_ORG } }), homePage, {}, { schema: true, "schema.graph": true });
	invalidateSchemaConfig();
	const off = await schemaContributions(fakeCtx({ docs: { site: RECOLLECT_ORG, custom: rules } }), homePage, {}, { schema: true, "schema.graph": true, "schema.custom": false });
	assert.deepEqual(off, without);
	assert.ok(!off.some((c) => String(c.id).startsWith("coywolf-custom:")));
	invalidateSchemaConfig();
	assert.deepEqual(await schemaContributions(fakeCtx({ docs: { custom: rules } }), homePage, {}, { schema: false, "schema.custom": true }), []);
});

test("other paths get nothing; the trailing slash doesn't matter", async () => {
	invalidateSchemaConfig();
	const ctx = fakeCtx({ docs: { custom: { rules: [{ id: "p", label: "Pricing", path: "/pricing/", enabled: true, markup: '{"@type":"Service","name":"Plans"}' }] } } });
	const ids = async (path) => (await schemaContributions(ctx, { ...homePage, path, url: `${ORIGIN}${path}`, canonical: `${ORIGIN}${path}` }, {}, GRAPH)).map((c) => c.id).filter(Boolean);
	assert.deepEqual(await ids("/pricing"), ["primary", "coywolf-custom:p"]);
	assert.deepEqual(await ids("/pricing/"), ["primary", "coywolf-custom:p"]);
	assert.deepEqual(await ids("/"), ["primary"]);
	assert.deepEqual(await ids("/pricing/more/"), ["primary"]);
});

test("graph off: the rule still prints as its own contribution with @context, without mainEntity", async () => {
	invalidateSchemaConfig();
	const ctx = fakeCtx({ docs: { custom: { rules: [{ id: "r1", label: "x", path: "/", enabled: true, mainEntity: true, markup: WEB_APPLICATION }] } } });
	const out = await schemaContributions(ctx, homePage, {}, { schema: true, "schema.custom": true });
	assert.deepEqual(out.map((c) => c.id), ["coywolf-custom:r1"]);
	assert.equal(out[0].graph["@context"], "https://schema.org");
	assert.equal(out[0].graph["@id"], `${ORIGIN}/#app`);
	// No pack graph: #organization is just resolved against the page.
	assert.deepEqual(out[0].graph.creator, { "@id": `${ORIGIN}/#organization` });
});

test("an entry's rule beats the path rule for its page; a disabled one doesn't", async () => {
	const page = { ...homePage, url: `${ORIGIN}/my-post/`, path: "/my-post/", canonical: `${ORIGIN}/my-post/`, kind: "content", pageType: "article", content: { collection: "posts", id: "e1", slug: "my-post" } };
	const docs = { custom: { rules: [{ id: "path", label: "x", path: "/my-post/", enabled: true, markup: '{"@type":"Service","name":"From the path"}' }] } };
	const entry = (enabled) => ({ "posts:e1": { collection: "posts", entryId: "e1", custom: { markup: '{"@type":"Service","name":"From the entry"}', enabled, mainEntity: true } } });
	for (const features of [GRAPH, { schema: true, "schema.custom": true }]) {
		invalidateSchemaConfig();
		let out = await schemaContributions(fakeCtx({ docs, entries: entry(true) }), page, {}, features);
		const mine = out.filter((c) => String(c.id).startsWith("coywolf-custom:"));
		assert.deepEqual(mine.map((c) => [c.id, c.graph.name]), [["coywolf-custom:entry:posts:e1", "From the entry"]]);
		if (features["schema.graph"]) {
			const webpage = out.find((c) => c.id === "primary").graph["@graph"].find((n) => n["@id"] === `${ORIGIN}/my-post/#webpage`);
			assert.deepEqual(webpage.mainEntity, { "@id": `${ORIGIN}/my-post/#service` });
		}
		invalidateSchemaConfig();
		out = await schemaContributions(fakeCtx({ docs, entries: entry(false) }), page, {}, features);
		assert.deepEqual(out.filter((c) => String(c.id).startsWith("coywolf-custom:")).map((c) => c.graph.name), ["From the path"]);
	}
});

test("EmDash prints the markup escaped (no </script> breakout) and dedupes by contribution id (first wins)", async () => {
	invalidateSchemaConfig();
	const markup = JSON.stringify({ "@type": "Service", name: "</script><script>alert(1)</script>", description: "<!-- x -->" });
	const ctx = fakeCtx({ docs: { custom: { rules: [{ id: "r1", label: "x", path: "/", enabled: true, markup }] } } });
	const out = await schemaContributions(ctx, homePage, {}, GRAPH);
	const html = renderPageMetadata(resolvePageMetadata(out));
	assert.ok(!html.includes("<script>alert"), html);
	assert.ok(html.includes("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)"));
	assert.equal(html.match(/<\/script>/g).length, html.match(/<script/g).length);
	// A theme (or another plugin) that contributes the same id first replaces the rule.
	const theme = { kind: "jsonld", id: "coywolf-custom:r1", graph: { "@context": "https://schema.org", "@type": "Service", name: "The theme's" } };
	const resolved = resolvePageMetadata([theme, ...out]);
	assert.equal(resolved.jsonld.filter((j) => j.id === "coywolf-custom:r1").length, 1);
	assert.ok(resolved.jsonld.find((j) => j.id === "coywolf-custom:r1").json.includes("The theme's"));
});

// ── Routes ───────────────────────────────────────────────────────

const routes = schemaModule({}).routes;
const call = async (name, ctx, input) => routes[name].handler({ ...ctx, input });
const ON = { schema: true, "schema.graph": true, "schema.custom": true };

test("save: refuses errors, normalizes the path, makes an id, and the page uses the rule", async () => {
	invalidateSchemaConfig();
	const ctx = fakeCtx({ features: ON, docs: { site: RECOLLECT_ORG }, site: { trailingSlash: "always" } });
	await assert.rejects(call("schema/custom/save", ctx, { rule: { path: "/", markup: "{ nope" } }), /isn't valid JSON/);
	await assert.rejects(call("schema/custom/save", ctx, { rule: { path: "/", markup: '{"@type":"Organization","@id":"#organization","name":"x"}' } }), /own @ids/);
	await assert.rejects(call("schema/custom/save", ctx, { rule: { path: "/pricing?x=1", markup: '{"@type":"Service"}' } }), /query string/);
	await assert.rejects(call("schema/custom/save", ctx, { rule: { id: "Bad Id", path: "/", markup: '{"@type":"Service"}' } }), /rule id/);
	const saved = await call("schema/custom/save", ctx, { rule: { label: "Pricing", path: "pricing", markup: { "@type": "Service", name: "Plans" } } });
	assert.equal(saved.rule.path, "/pricing/");
	assert.match(saved.rule.id, /^r-[0-9a-f]{8}$/);
	assert.equal(JSON.parse(saved.rule.markup).name, "Plans"); // JSON sent as an object is stored as text.
	assert.ok(saved.warnings.some((w) => w.message.includes("provider is recommended")));
	// Another enabled rule on the same page is refused; a disabled one is fine.
	await assert.rejects(call("schema/custom/save", ctx, { rule: { path: "/pricing", markup: '{"@type":"Service"}' } }), /both on/);
	await call("schema/custom/save", ctx, { rule: { path: "/pricing", enabled: false, markup: '{"@type":"Service"}' } });
	const home = await call("schema/custom/save", ctx, { rule: { id: "recollect-app", label: "Recollect app", path: "/", mainEntity: true, markup: WEB_APPLICATION } });
	assert.equal(home.rules.length, 3);
	// Saved rules reach the page (the save drops the cached config).
	const out = await schemaContributions(ctx, homePage, {}, ON);
	assert.ok(out.some((c) => c.id === "coywolf-custom:recollect-app"));
	// Edit in place by id, then delete.
	const edited = await call("schema/custom/save", ctx, { rule: { ...home.rule, enabled: false } });
	assert.equal(edited.rules.length, 3);
	assert.equal(edited.rules.find((r) => r.id === "recollect-app").enabled, false);
	const deleted = await call("schema/custom/delete", ctx, { id: "recollect-app" });
	assert.equal(deleted.deleted, true);
	assert.equal(deleted.rules.length, 2);
	const config = await routes["schema/config"].handler(ctx);
	assert.equal(config.custom.trailingSlash, "always");
	assert.equal(config.custom.publisherId, `${ORIGIN}/#organization`);
	assert.equal(config.features["schema.custom"], true);
});

test("save needs the Custom markup switch; entry overrides keep, replace or remove their markup", async () => {
	invalidateSchemaConfig();
	const off = fakeCtx({ features: { schema: true } });
	await assert.rejects(call("schema/custom/save", off, { rule: { path: "/", markup: '{"@type":"Service"}' } }), /turned off/);
	const ctx = fakeCtx({ features: ON });
	const markup = '{"@type":"Service","name":"Entry"}';
	await assert.rejects(call("schema/entries/save", ctx, { collection: "posts", entryId: "e1", custom: { markup: '{"name":"x"}' } }), /needs a @type/);
	const saved = await call("schema/entries/save", ctx, { collection: "posts", entryId: "e1", custom: { markup, mainEntity: true } });
	assert.deepEqual(saved.item.custom, { markup, enabled: true, mainEntity: true });
	// Left out: kept (the override has nothing else, and isn't deleted).
	const kept = await call("schema/entries/save", ctx, { collection: "posts", entryId: "e1", pageType: "AboutPage" });
	assert.deepEqual(kept.item.custom, saved.item.custom);
	assert.equal(kept.item.pageType, "AboutPage");
	// null: removed; with nothing else left, the override goes.
	const removed = await call("schema/entries/save", ctx, { collection: "posts", entryId: "e1", pageType: "AboutPage", custom: null });
	assert.equal(removed.item.custom, undefined);
	assert.equal(removed.item.pageType, "AboutPage");
	assert.deepEqual(await call("schema/entries/save", ctx, { collection: "posts", entryId: "e1", custom: null }), { deleted: true });
	// With the switch off, markup can't be added.
	await assert.rejects(call("schema/entries/save", fakeCtx({ features: { schema: true } }), { collection: "posts", entryId: "e1", custom: { markup } }), /turned off/);
});

test("references to the pack's site-level ids point at the site root on any page, with or without the graph", () => {
	const nodes = custom.parseMarkup('{"@type":"Service","provider":{"@id":"#organization"},"isPartOf":{"@id":"#website"},"@id":"#service"}').nodes;
	const off = custom.customOutput(rule(nodes), { pageUrl: `${ORIGIN}/pricing/`, graph: null }).contribution.graph;
	assert.deepEqual(off.provider, { "@id": `${ORIGIN}/#organization` });
	assert.deepEqual(off.isPartOf, { "@id": `${ORIGIN}/#website` });
	// Other #names belong to the page.
	assert.equal(off["@id"], `${ORIGIN}/pricing/#service`);
});

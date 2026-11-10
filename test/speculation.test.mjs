// Run: node --test test/speculation.test.mjs
//
// Speculation Rules (src/speculation/): the rule set the pack puts in every public page's head,
// what it never fetches ahead, the settings it accepts, and the page:fragments hook.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { SPECULATION_DEFAULTS, QUERY_EXCLUDED, parseSpeculationSettings, speculationRules, speculationScript, speculationSettingsSchema } = await import("../src/speculation/rules.ts");
const { speculationPack } = await import("../src/speculation/pack.ts");
const { featureCatalog } = await import("../src/core/features.ts");

test("off by default, with one switch and no page of its own", () => {
	const pack = speculationPack();
	assert.deepEqual(pack.features.map((f) => [f.id, f.default]), [["speculation", false]]);
	assert.equal(featureCatalog().find((f) => f.id === "speculation")?.default, false);
	assert.deepEqual(pack.adminPages, []);
	assert.equal(typeof pack.hooks["page:fragments"], "function");
});

test("defaults: prefetch same-site links on hover, no prerender, nothing extra excluded", () => {
	assert.deepEqual(SPECULATION_DEFAULTS, { eagerness: "moderate", prerender: "off", exclude: [] });
	const rules = speculationRules(SPECULATION_DEFAULTS);
	assert.deepEqual(Object.keys(rules), ["prefetch"]);
	const [rule] = rules.prefetch;
	assert.equal(rule.source, "document");
	assert.equal(rule.eagerness, "moderate");
	const [same, paths, links] = rule.where.and;
	assert.deepEqual(same, { href_matches: "/*" });
	const excluded = paths.not.href_matches;
	for (const path of ["/_emdash/*", "/_astro/*", QUERY_EXCLUDED]) assert.ok(excluded.includes(path), path);
	assert.ok(excluded.some((p) => p.startsWith("/*.(") && p.includes("pdf")), "file links");
	// The same query-string pattern the hand-copied theme rules use.
	assert.equal(QUERY_EXCLUDED, "/*\\?(.+)");
	for (const selector of ['a[rel~="nofollow"]', 'a[rel~="sponsored"]', "a[download]", ".no-prefetch"]) assert.ok(links.not.selector_matches.includes(selector), selector);
});

test("prerender is optional, never eager, and skips .no-prerender links", () => {
	const rules = speculationRules({ ...SPECULATION_DEFAULTS, prerender: "conservative" });
	assert.equal(rules.prerender.length, 1);
	assert.equal(rules.prerender[0].eagerness, "conservative");
	assert.ok(JSON.stringify(rules.prerender[0].where).includes(".no-prerender"));
	assert.ok(!JSON.stringify(rules.prefetch[0].where).includes(".no-prerender"), "prefetch still fetches .no-prerender links");
	assert.equal(speculationSettingsSchema.safeParse({ prerender: "eager" }).success, false);
});

test("the site's exclusions and File Downloads' URL base are added, once each", () => {
	const settings = speculationSettingsSchema.parse({ exclude: ["/visit/*", " /go/* ", "/visit/*"] });
	assert.deepEqual(settings.exclude, ["/visit/*", "/go/*", "/visit/*"]);
	const excluded = speculationRules(settings, { downloadBase: "download" }).prefetch[0].where.and[1].not.href_matches;
	assert.equal(excluded.filter((p) => p === "/visit/*").length, 1);
	assert.ok(excluded.includes("/go/*"));
	assert.ok(excluded.includes("/download/*"));
	assert.ok(!speculationRules(settings).prefetch[0].where.and[1].not.href_matches.includes("/download/*"), "only while File Downloads is on");
});

test("exclusions that could break the rule set are refused", () => {
	for (const bad of ["visit/*", "/visit/:id", "/(a|b)", "/a b", '/a"b', "/a?b=1", "/a{b}", "/a+"]) {
		assert.equal(speculationSettingsSchema.safeParse({ exclude: [bad] }).success, false, bad);
	}
	assert.equal(speculationSettingsSchema.safeParse({ exclude: ["/visit/*", "/caf%C3%A9/*", "/a-b_c.~/*"] }).success, true);
	assert.equal(speculationSettingsSchema.safeParse({ exclude: Array.from({ length: 51 }, (_, i) => `/p${i}`) }).success, false);
	assert.equal(speculationSettingsSchema.safeParse({ eagerness: "always" }).success, false);
	// A stored value that doesn't parse falls back to the defaults.
	assert.deepEqual(parseSpeculationSettings({ eagerness: "always" }), SPECULATION_DEFAULTS);
	assert.deepEqual(parseSpeculationSettings(null), SPECULATION_DEFAULTS);
});

test("the script is valid JSON in a speculationrules script that can't be closed early", () => {
	const html = speculationScript(SPECULATION_DEFAULTS);
	const match = html.match(/^<script type="speculationrules">(.*)<\/script>$/s);
	assert.ok(match);
	assert.deepEqual(JSON.parse(match[1]), speculationRules(SPECULATION_DEFAULTS));
	// The schema refuses "<", but even a value that skipped it can't end the script early.
	const tricky = speculationScript({ ...SPECULATION_DEFAULTS, exclude: ["/</script><img src=x>"] });
	assert.equal(tricky.match(/<\/script>/g).length, 1, "only the element's own end tag");
	assert.ok(tricky.includes("\\u003c/script>\\u003cimg"));
	assert.ok(JSON.parse(tricky.slice('<script type="speculationrules">'.length, -"</script>".length)).prefetch[0].where.and[1].not.href_matches.includes("/</script><img src=x>"));
});

function ctxWith(stored) {
	return { settings: { get: async (key) => stored[key] ?? null } };
}

test("page:fragments adds one head script built from the saved settings (only rendered while the switch is on)", async () => {
	const pack = speculationPack();
	const hook = pack.hooks["page:fragments"];
	const out = await hook({ page: { kind: "custom", url: "https://coywolf.com/" } }, ctxWith({ features: { speculation: true }, speculationRules: { eagerness: "conservative", prerender: "off", exclude: ["/visit/*"] } }));
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, "html");
	assert.equal(out[0].placement, "head");
	assert.equal(out[0].key, "coywolf-speculation-rules");
	const rules = JSON.parse(out[0].html.replace(/^<script type="speculationrules">|<\/script>$/g, ""));
	assert.equal(rules.prefetch[0].eagerness, "conservative");
	assert.ok(rules.prefetch[0].where.and[1].not.href_matches.includes("/visit/*"));
	// The hook composer runs it only while "speculation" is on (src/core/compose.ts gates every hook on its module's main switch).
	assert.equal(pack.hookFeature, undefined);
	assert.equal(pack.features[0].id, "speculation");
});

test("saving goes through the settings schema; the route purges like any pack save", async () => {
	const pack = speculationPack();
	const stored = new Map();
	const ctx = { input: { eagerness: "eager", prerender: "moderate", exclude: ["/visit/*"] }, settings: { get: async (k) => stored.get(k) ?? null, set: async (k, v) => stored.set(k, v) } };
	const route = pack.routes["speculation/save"];
	const result = await route.handler(ctx);
	assert.deepEqual(stored.get("speculationRules"), { eagerness: "eager", prerender: "moderate", exclude: ["/visit/*"] });
	assert.equal(result.rules.prerender[0].eagerness, "moderate");
	await assert.rejects(route.handler({ ...ctx, input: { exclude: ["no-slash"] } }), /start with \//);
	const { purgesAfter, purgeScope } = await import("../src/pageCache/lib.ts");
	assert.equal(purgesAfter("POST", "/_emdash/api/plugins/coywolf-pack/speculation/save"), true);
	assert.deepEqual(purgeScope("/_emdash/api/plugins/coywolf-pack/speculation/save"), { purgeEverything: true });
});

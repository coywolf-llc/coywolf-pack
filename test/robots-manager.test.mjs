// Robots.txt manager: rule rendering, group resolution, import/equivalence, the validator and the self-check.
import "./ts-resolve.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";

const rules = await import("../src/robots/rules.ts");
const rep = await import("../src/robots/rep.ts");
const imp = await import("../src/robots/importer.ts");
const val = await import("../src/robots/validate.ts");
const ex = await import("../src/robots/explain.ts");
const bots = await import("../src/robots/bots.ts");

const SITE = "https://example.com";
let n = 0;
const rule = (r) => ({ id: `t${++n}`, name: r.name ?? `Rule ${n}`, enabled: true, agents: ["*"], directive: "disallow", kind: "entire_site", ...r });
const cfg = (list, extra = {}) => ({ ...rules.DEFAULT_CONFIG, rules: list, ...extra });
const gen = (c) => rules.generate(c, { siteUrl: SITE });
const allowed = (txt, agent, path) => rep.evaluate(txt, [agent], path).allowed;
const codes = (findings) => findings.map((f) => f.code);
const sev = (findings, code) => findings.find((f) => f.code === code)?.severity;

const AI = rules.CRAWLER_GROUPS.find((g) => g.id === "ai_training").tokens;
const blockAi = () => rule({ name: "Block AI training crawlers", agents: [...AI], group: "ai_training" });

/* ---------------- rendering ---------------- */

test("guided choices render the right lines", () => {
	const d = (r) => rules.directives(rule(r)).map((l) => `${l.directive}: ${l.value}`);
	assert.deepEqual(d({ kind: "folder", path: "/recipes", anyDepth: true }), ["Disallow: /recipes/", "Disallow: /*/recipes/"]);
	assert.deepEqual(d({ kind: "folder", path: "/members/", except: ["/members/welcome/", "/members/*.pdf$"] }), [
		"Disallow: /members/",
		"Allow: /members/welcome/",
		"Allow: /members/*.pdf$",
	]);
	assert.deepEqual(d({ kind: "filetype", exts: ["pdf", ".DOCX", "pdf"] }), ["Disallow: /*.pdf$", "Disallow: /*.docx$"]);
	assert.deepEqual(d({ kind: "filetype_in_folder", path: "/files", exts: ["zip"] }), ["Disallow: /files/*.zip$"]);
	assert.deepEqual(d({ kind: "query_param", params: ["utm_*", "fbclid"] }), ["Disallow: /*?utm_", "Disallow: /*&utm_", "Disallow: /*?fbclid=", "Disallow: /*&fbclid="]);
	assert.deepEqual(d({ kind: "exact_url", path: "/search" }), ["Disallow: /search$"]);
	assert.deepEqual(d({ kind: "single_page", path: "/café" }), ["Disallow: /caf%C3%A9"]);
	assert.deepEqual(d({ kind: "custom", path: "/a%2fb" }), ["Disallow: /a%2Fb"]);
	assert.deepEqual(d({ kind: "folder", path: "/x/", directive: "allow", except: ["/x/y/"] }), ["Allow: /x/"]);
});

test("normalizePathInput: pasted URLs, fragments, spaces, non-ASCII", () => {
	assert.equal(rules.normalizePathInput("https://example.com/recipes/?a=1#top", SITE).value, "/recipes/?a=1");
	const other = rules.normalizePathInput("https://other.test/x", SITE);
	assert.equal(other.value, "/x");
	assert.match(other.notes.join(" "), /other\.test/);
	assert.equal(rules.normalizePathInput("my folder/", SITE).value, "/my%20folder/");
	assert.equal(rules.normalizePathInput("/über/", SITE).value, "/%C3%BCber/");
	assert.equal(rules.normalizePathInput("*.pdf$", SITE).value, "*.pdf$");
	assert.equal(rules.normalizePathInput("//www.example.com", SITE).value, "/");
});

test("samplePaths only returns paths the pattern matches", () => {
	for (const p of ["/", "/a/", "/*.pdf$", "/*?utm_", "/*/print/", "/x$", "/a*b", "*"]) {
		const s = rules.samplePaths(p);
		assert.ok(s.length > 0, p);
		for (const x of s) assert.ok(rep.matchRaw(p, x), `${p} ${x}`);
	}
});

/* ---------------- group resolution ---------------- */

test("allow a folder anywhere while AI training bots are blocked: their group gets both Allows plus Disallow: /", () => {
	const c = cfg([blockAi(), rule({ name: "Docs anywhere", agents: [...AI], directive: "allow", kind: "folder", path: "/docs/", anyDepth: true })]);
	const txt = gen(c);
	const group = txt.slice(txt.indexOf("User-agent: GPTBot"));
	const lines = group.slice(0, group.indexOf("\n\n")).split("\n").filter((l) => !l.startsWith("User-agent"));
	assert.deepEqual(lines, ["Allow: /.well-known/", "Allow: /*/docs/", "Allow: /docs/", "Disallow: /"]);
	for (const bot of AI) {
		assert.equal(allowed(txt, bot, "/docs/a"), true, bot);
		assert.equal(allowed(txt, bot, "/en/docs/a"), true, bot);
		assert.equal(allowed(txt, bot, "/blog/"), false, bot);
	}
	assert.equal(allowed(txt, "Googlebot", "/blog/"), true);
});

test("named crawlers keep the general rules when inheritGeneral is on, and lose them when off (RFC 9309)", () => {
	const list = [rule({ name: "No private", kind: "folder", path: "/private/" }), rule({ name: "GPT no tmp", agents: ["GPTBot"], kind: "folder", path: "/tmp/" })];
	const on = gen(cfg(list));
	assert.equal(allowed(on, "GPTBot", "/private/x"), false);
	assert.equal(allowed(on, "GPTBot", "/tmp/x"), false);
	const off = gen(cfg(list, { inheritGeneral: false }));
	assert.equal(allowed(off, "GPTBot", "/private/x"), true);
	assert.equal(allowed(off, "GPTBot", "/tmp/x"), false);
	assert.equal(allowed(off, "Other", "/private/x"), false);
});

test("a specific rule that covers a general one wins (specific beats general)", () => {
	const c = cfg([rule({ name: "No private", kind: "folder", path: "/private/" }), rule({ name: "Google everywhere", agents: ["Googlebot"], directive: "allow" })]);
	const txt = gen(c);
	assert.equal(allowed(txt, "Googlebot", "/private/x"), true);
	assert.equal(allowed(txt, "Googlebot", "/_emdash/admin"), false);
	assert.equal(allowed(txt, "bingbot", "/private/x"), false);
	const c2 = cfg([rule({ name: "Docs open", directive: "allow", kind: "folder", path: "/docs/" }), rule({ name: "Closed for GPT", agents: ["GPTBot"] }), rule({ name: "Block all", agents: ["*"], kind: "folder", path: "/docs/x/" })]);
	const t2 = gen(c2);
	assert.equal(allowed(t2, "GPTBot", "/docs/a"), false);
	assert.equal(allowed(t2, "Other", "/docs/a"), true);
	assert.equal(allowed(t2, "Other", "/docs/x/a"), false);
});

test("media Allow: kept for named bots that aren't blocked from the whole site; added without EmDash lines when needed", () => {
	const txt = gen(cfg([blockAi(), rule({ name: "Bing drafts", agents: ["bingbot"], kind: "folder", path: "/drafts/" })]));
	assert.equal(allowed(txt, "bingbot", "/_emdash/api/media/f/a.jpg"), true);
	assert.equal(allowed(txt, "GPTBot", "/_emdash/api/media/f/a.jpg"), false);
	const noEm = gen(cfg([rule({ name: "Block emdash", kind: "folder", path: "/_emdash/" })], { emdashLines: false }));
	assert.equal(allowed(noEm, "x", "/_emdash/api/media/f/a.jpg"), true);
	assert.equal(allowed(noEm, "x", "/_emdash/admin"), false);
	const noMedia = gen(cfg([], { allowMedia: false }));
	assert.equal(allowed(noMedia, "x", "/_emdash/api/media/f/a.jpg"), false);
});

test("lines are written most specific first (first-match crawlers agree)", () => {
	const txt = gen(cfg([rule({ kind: "folder", path: "/a/", except: ["/a/b/c/"] })]));
	const star = txt.slice(txt.indexOf("User-agent: *"));
	const lines = star.slice(0, star.indexOf("\n\n")).split("\n").slice(1);
	const lens = lines.map((l) => l.split(": ")[1].length);
	assert.deepEqual([...lens].sort((a, b) => b - a), lens);
});

test("legacy config (no version) keeps working: wellbeing.io's single AI rule", () => {
	const legacy = { rules: [{ id: "abc", name: "Block AI training crawlers", enabled: true, agents: [...AI], directive: "disallow", kind: "entire_site" }], includeSitemap: true, sitemaps: [], allowMedia: true, comments: true, extra: "" };
	const c = rules.normalizeConfig(legacy);
	assert.equal(c.version, 2);
	assert.equal(c.emdashLines, true);
	assert.equal(c.inheritGeneral, true);
	const txt = gen(c);
	for (const bot of AI) assert.equal(allowed(txt, bot, "/any/"), false, bot);
	assert.equal(allowed(txt, "Googlebot", "/any/"), true);
	assert.equal(allowed(txt, "Googlebot", "/_emdash/admin"), false);
	assert.equal(allowed(txt, "Googlebot", "/_emdash/api/media/x.jpg"), true);
	assert.equal(val.selfCheck(c, SITE).ok, true);
	assert.equal(val.checkConfig(c, SITE), null);
});

test("legacy config with general + named rules keeps legacy semantics (inheritGeneral off)", () => {
	const legacy = { rules: [{ id: "a", name: "A", enabled: true, agents: ["*"], directive: "disallow", kind: "folder", path: "/p/" }, { id: "b", name: "B", enabled: true, agents: ["GPTBot"], directive: "disallow", kind: "folder", path: "/q/" }], includeSitemap: true, sitemaps: [], allowMedia: true, comments: true, extra: "" };
	const c = rules.normalizeConfig(legacy);
	assert.equal(c.inheritGeneral, false);
	assert.equal(allowed(gen(c), "GPTBot", "/p/x"), true);
});

/* ---------------- import ---------------- */

const IMPORTS = [
	["EmDash default", imp.emdashDefaultRobots(SITE)],
	["general + blocked bot", "User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n"],
	["crawl-delay group", "User-agent: *\nDisallow: /private/\n\nUser-agent: Googlebot\nDisallow: /tmp/\nCrawl-delay: 5\n"],
	["WordPress style", "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /*?s=\nDisallow: /*.pdf$\n\nUser-agent: Bingbot\nDisallow:\nSitemap: https://example.com/sitemap_index.xml"],
	["consecutive UAs", "User-agent: a\nUser-agent: b\nDisallow: /x/\nUser-agent: c\nDisallow: /y/\n"],
	["contradiction", "User-agent: *\nDisallow: /a/\nAllow: /a/\nDisallow: /b/\n"],
	["no-colon typos + comments", "User-agent *\nDisalow: /old/ # gone\n# note\nAllow /old/keep\n"],
	["wildcards", "User-agent: *\nDisallow: /*/print/\nDisallow: /tag-*\nDisallow: /*preview=\nDisallow: /search$\nDisallow: /a*b$\n"],
	["everything blocked", "User-agent: *\nDisallow: /\n"],
	["emdash custom with media", "User-agent: *\nAllow: /_emdash/api/media/\nDisallow: /_emdash/\nDisallow: /drafts/\n\nUser-agent: CCBot\nDisallow: /\n"],
	["orphans and odd lines", "Disallow: /ignored/\nContent-Signal: search=yes\nUser-agent: *\nDisallow: /a b\nNoindex: /x\n"],
	["non-ASCII", "User-agent: *\nDisallow: /café/\nDisallow: /%e2%82%ac\n"],
	["empty file", ""],
	["BOM + CRLF", "﻿User-agent: *\r\nDisallow: /x/\r\n\r\nUser-agent: GPTBot\r\nAllow: /\r\n"],
];

const agentsFor = (text) => [...new Set([...rep.parse(text).directives.filter((d) => d.type === "user-agent").map((d) => rep.extractProductToken(d.value)).filter(Boolean), "Googlebot", "bingbot", "GPTBot", "CCBot", rules.PROBE_AGENT])];

for (const [label, text] of IMPORTS) {
	test(`import is equivalent: ${label}`, () => {
		const original = imp.emdashRobots(text || null, SITE);
		const r = imp.importRobots(original, SITE, "2026-10-04T00:00:00Z");
		const txt = gen(r.config);
		assert.ok(imp.equivalent(original, txt, agentsFor(original)), `${label}:\n${txt}`);
		// Media is opened for crawlers that can crawl pages.
		if (allowed(txt, rules.PROBE_AGENT, "/some-page/")) assert.equal(allowed(txt, rules.PROBE_AGENT, "/_emdash/api/media/f/a.jpg"), true, label);
		assert.equal(val.selfCheck(r.config, SITE).ok, true, label);
		assert.equal(val.checkConfig(r.config, SITE), null, label);
		assert.ok(r.config.importNotes?.length, label);
		// Importing is idempotent: importing the generated file again gives the same verdicts.
		const again = imp.importRobots(txt, SITE);
		assert.ok(imp.equivalent(txt, gen(again.config), agentsFor(txt)), `${label} (re-import)`);
	});
}

test("import: EmDash default keeps its explicit Allow: /, admin lines, sitemap, media opened (and says so)", () => {
	const r = imp.importRobots(imp.emdashDefaultRobots(SITE), SITE);
	assert.equal(r.mode, "rules");
	assert.equal(r.config.rules.length, 1);
	assert.deepEqual(rules.directives(r.config.rules[0]).map((l) => `${l.directive}: ${l.value}`), ["Allow: /"]);
	assert.deepEqual(r.config.rules[0].agents, ["*"]);
	assert.ok(imp.equivalent(imp.emdashDefaultRobots(SITE), gen(r.config), agentsFor(imp.emdashDefaultRobots(SITE))));
	assert.equal(r.config.emdashLines, true);
	assert.equal(r.config.includeSitemap, true);
	assert.equal(r.config.allowMedia, true);
	assert.match(r.notes.join(" "), /media library/);
});

test("import: consolidates identical lines across bots and recognizes crawler groups", () => {
	const text = `${AI.map((a) => `User-agent: ${a}`).join("\n")}\nDisallow: /\n\nUser-agent: *\nDisallow: /_emdash/\n`;
	const r = imp.importRobots(emdashRobotsSafe(text), SITE);
	assert.equal(r.config.rules.length, 1);
	assert.equal(r.config.rules[0].group, "ai_training");
	assert.match(r.config.rules[0].name, /AI training crawlers/);
});
function emdashRobotsSafe(t) {
	return imp.emdashRobots(t, SITE);
}

test("import: classify round-trips every value it recognizes", () => {
	for (const v of ["/", "/a/", "/a", "/a.html", "/a$", "/*.pdf$", "/d/*.zip$", "/*/print/", "/*?", "/*x=", "/pa_*", "/a*b", "*", "/a$b"]) {
		const c = imp.classify("Disallow", v);
		const out = rules.directives({ id: "x", name: "x", enabled: true, agents: ["*"], ...c });
		assert.deepEqual(out.map((l) => l.value), [v], `${v} → ${c.kind}`);
	}
});

test("import falls back to verbatim when rules can't express the file, still equivalent", () => {
	// Google merges the two * groups; a group naming only a bot with a value containing a space can't round-trip.
	const text = "User-agent: *\nDisallow: /a b/\nUser-agent: X\nDisallow: /c d\n";
	const r = imp.importRobots(text, SITE);
	assert.ok(imp.equivalent(text, gen(r.config), ["X", rules.PROBE_AGENT, "Googlebot"]));
	assert.equal(val.selfCheck(r.config, SITE).ok, true);
});

/* ---------------- validator ---------------- */

const findings = (config, draft, opts = {}) => val.analyzeRule(config, draft, { siteUrl: SITE, ...opts });

test("validator: shape errors", () => {
	const base = cfg([]);
	assert.ok(codes(findings(base, rule({ agents: [] }))).includes("invalid"));
	assert.ok(codes(findings(base, rule({ agents: ["Bad Bot"] }))).includes("bad-token"));
	assert.ok(codes(findings(base, rule({ kind: "folder", path: "" }))).includes("invalid"));
	assert.ok(codes(findings(base, rule({ kind: "custom", path: "x" }))).includes("leading-slash"));
	assert.ok(codes(findings(base, rule({ kind: "folder", path: "/a#b" }))).includes("bad-chars"));
	assert.ok(codes(findings(base, rule({ kind: "folder", path: "/a\nAllow: /" }))).includes("bad-chars"));
	assert.ok(codes(findings(base, rule({ kind: "custom", path: `/${"a".repeat(2100)}` }))).includes("too-long"));
	assert.ok(codes(findings(base, rule({ kind: "filetype", exts: ["p.d"] }))).includes("invalid"));
	assert.ok(codes(findings(base, rule({ kind: "query_param", params: ["a=b"] }))).includes("invalid"));
	for (const f of findings(base, rule({ agents: ["Bad Bot"] }))) assert.equal(f.severity, "error");
});

test("validator: contradiction (same crawlers, same path, opposite action) is an error with an edit fix", () => {
	const existing = rule({ name: "No private", kind: "folder", path: "/private/" });
	const f = findings(cfg([existing]), rule({ kind: "folder", path: "/private", directive: "allow" }));
	assert.equal(sev(f, "contradiction"), "error");
	assert.deepEqual(f.find((x) => x.code === "contradiction").fix.action, { type: "editRule", ruleId: existing.id });
	// Different crawlers: no contradiction.
	assert.ok(!codes(findings(cfg([existing]), rule({ agents: ["GPTBot"], kind: "folder", path: "/private/", directive: "allow" }))).includes("contradiction"));
});

test("validator: exact duplicate is an error; same rule for more crawlers suggests merging", () => {
	const existing = rule({ name: "AI out", agents: ["GPTBot"] });
	assert.equal(sev(findings(cfg([existing]), rule({ agents: ["gptbot"] })), "duplicate"), "error");
	const f = findings(cfg([existing]), rule({ agents: ["GPTBot", "CCBot"] }));
	assert.equal(sev(f, "duplicate-partial"), "info");
	assert.equal(f.find((x) => x.code === "duplicate-partial").fix.action.type, "mergeInto");
	// Editing a rule doesn't conflict with itself.
	assert.ok(!codes(findings(cfg([existing]), { ...existing, name: "renamed" })).includes("duplicate"));
});

test("validator: allow with nothing to undo warns; allow inside a block is explained", () => {
	assert.equal(sev(findings(cfg([]), rule({ directive: "allow", kind: "folder", path: "/docs/" })), "allow-no-effect"), "warning");
	const f = findings(cfg([rule({ name: "Members", kind: "folder", path: "/members/" })]), rule({ directive: "allow", kind: "folder", path: "/members/welcome/" }));
	assert.equal(sev(f, "nested-allow"), "info");
	assert.ok(!codes(f).includes("allow-no-effect"));
});

test("validator: a block already covered by a wider block is redundant (with the covering rule named)", () => {
	const wide = rule({ name: "Everything for GPT", agents: ["GPTBot"] });
	const f = findings(cfg([wide]), rule({ agents: ["GPTBot"], kind: "folder", path: "/private/" }));
	assert.equal(sev(f, "redundant-block"), "warning");
	assert.match(f.find((x) => x.code === "redundant-block").message, /Everything for GPT/);
	// Not redundant when an Allow reopens part of the area.
	const withAllow = cfg([wide, rule({ agents: ["GPTBot"], directive: "allow", kind: "folder", path: "/private/" })]);
	assert.ok(!codes(findings(withAllow, rule({ agents: ["GPTBot"], kind: "folder", path: "/private/secret/" }))).includes("redundant-block"));
});

test("validator: naming a bot when general rules exist (group selection)", () => {
	const general = rule({ name: "No private", kind: "folder", path: "/private/" });
	const draft = rule({ agents: ["GPTBot"], kind: "folder", path: "/tmp/" });
	const off = findings(cfg([general], { inheritGeneral: false }), draft);
	assert.equal(sev(off, "group-selection"), "warning");
	assert.deepEqual(off.find((x) => x.code === "group-selection").fix.action, { type: "turnOnInherit" });
	// With inheritance on, GPTBot keeps /private/ blocked: nothing to warn about.
	assert.ok(!codes(findings(cfg([general]), draft)).includes("group-selection"));
	// A specific allow over a general block: the bot stops following it there (info).
	const g2 = findings(cfg([general]), rule({ agents: ["Googlebot"], directive: "allow" }));
	assert.ok(!codes(g2).includes("search-whole-site"));
});

test("validator: a rule for everyone that named bots won't follow offers to apply it to them", () => {
	const f = findings(cfg([blockAi()]), rule({ directive: "allow", kind: "folder", path: "/docs/", anyDepth: true }));
	const g = f.find((x) => x.code === "general-overridden");
	assert.equal(g?.severity, "warning");
	assert.equal(g.fix.action.type, "addAgents");
	assert.ok(g.fix.action.agents.includes("GPTBot"));
});

test("validator: risky consequences (search engines, render assets, media, sitemap, admin)", () => {
	assert.equal(sev(findings(cfg([]), rule({})), "search-whole-site"), "warning");
	assert.equal(sev(findings(cfg([]), rule({ agents: ["Googlebot"] })), "search-whole-site"), "warning");
	assert.ok(!codes(findings(cfg([]), rule({ agents: ["GPTBot"] }))).includes("search-whole-site"));
	assert.equal(sev(findings(cfg([]), rule({ kind: "folder", path: "/_astro/" })), "render-assets"), "warning");
	assert.equal(sev(findings(cfg([]), rule({ kind: "filetype", exts: ["css"] })), "render-assets"), "warning");
	assert.equal(sev(findings(cfg([]), rule({ kind: "folder", path: "/_emdash/api/media/" })), "media"), "warning");
	assert.equal(sev(findings(cfg([]), rule({ kind: "filetype", exts: ["jpg"] })), "render-assets"), "warning");
	assert.equal(sev(findings(cfg([]), rule({ kind: "single_page", path: "/sitemap.xml" })), "sitemap"), "warning");
	assert.equal(sev(findings(cfg([]), rule({ directive: "allow", kind: "folder", path: "/_emdash/admin/" })), "admin"), "warning");
	// Blocking a normal section is quiet.
	const quiet = findings(cfg([]), rule({ kind: "folder", path: "/drafts/" }));
	assert.deepEqual(quiet.filter((f) => f.severity !== "info"), []);
});

test("validator: token checks against the directory", () => {
	const directory = [{ token: "GPTBot", category: "AI_CRAWLER", status: "verified" }, { token: "OddBot", category: "OTHER", status: "unverified" }];
	const f = findings(cfg([]), rule({ agents: ["OddBot", "NewBot"], kind: "folder", path: "/x/" }), { bots: directory });
	assert.ok(codes(f).includes("unknown-token"));
	assert.ok(codes(f).includes("unverified-token"));
});

test("validator: permutations of crawler sets × targets × actions never crash and errors are consistent with checkConfig", () => {
	const agentSets = [["*"], ["GPTBot"], ["GPTBot", "CCBot"], ["Googlebot"], [...AI]];
	const targets = [
		{ kind: "entire_site" },
		{ kind: "folder", path: "/a/" },
		{ kind: "folder", path: "/a/", anyDepth: true },
		{ kind: "folder", path: "/a/b/" },
		{ kind: "single_page", path: "/a/page" },
		{ kind: "exact_url", path: "/a/" },
		{ kind: "filetype", exts: ["pdf"] },
		{ kind: "filetype_in_folder", path: "/a/", exts: ["pdf"] },
		{ kind: "query_param", params: ["utm_*"] },
		{ kind: "query_any" },
		{ kind: "custom", path: "/*a" },
	];
	const existingSets = [[], [blockAi()], [rule({ name: "A out", kind: "folder", path: "/a/" })], [rule({ name: "A open", directive: "allow", kind: "folder", path: "/a/" }), rule({ name: "All out" })]];
	let checked = 0;
	for (const existing of existingSets) {
		for (const agents of agentSets) {
			for (const t of targets) {
				for (const directive of ["allow", "disallow"]) {
					const draft = rule({ agents, directive, ...t });
					const c = cfg(existing);
					const f = findings(c, draft);
					const hasError = f.some((x) => x.severity === "error");
					const after = { ...c, rules: [...existing, draft] };
					const server = val.checkConfig(after, SITE);
					if (!hasError) assert.equal(server, null, `${JSON.stringify(t)} ${directive} ${agents}: ${server}`);
					if (codes(f).includes("contradiction")) assert.notEqual(server, null);
					checked++;
				}
			}
		}
	}
	assert.ok(checked > 400);
});

/* ---------------- self-check ---------------- */

test("self-check passes for every generated permutation", () => {
	const list = [
		blockAi(),
		rule({ name: "Private", kind: "folder", path: "/private/", except: ["/private/open/"] }),
		rule({ name: "Docs for AI", agents: [...AI], directive: "allow", kind: "folder", path: "/docs/", anyDepth: true }),
		rule({ name: "PDFs", kind: "filetype", exts: ["pdf", "docx"] }),
		rule({ name: "UTM", kind: "query_param", params: ["utm_*", "fbclid"] }),
		rule({ name: "Bing drafts", agents: ["bingbot"], kind: "folder", path: "/drafts/" }),
		rule({ name: "Exact", kind: "exact_url", path: "/search" }),
	];
	for (const inheritGeneral of [true, false]) {
		for (const emdashLines of [true, false]) {
			for (const allowMedia of [true, false]) {
				const c = cfg(list, { inheritGeneral, emdashLines, allowMedia });
				const r = val.selfCheck(c, SITE);
				assert.equal(r.ok, true, `${inheritGeneral}/${emdashLines}/${allowMedia}: ${JSON.stringify(r.failures)}`);
			}
		}
	}
});

test("self-check catches Extra lines that hijack a rule, naming the rule and the deciding line", () => {
	const c = cfg([rule({ name: "Private", kind: "folder", path: "/private/" })], { extra: "User-agent: *\nAllow: /private/deep" });
	const r = val.selfCheck(c, SITE);
	assert.equal(r.ok, false);
	assert.equal(r.failures[0].ruleName, "Private");
	assert.match(r.failures[0].reason, /Extra lines/);
	assert.match(val.checkConfig(c, SITE), /Self-check failed for “Private”/);
});

test("checkConfig rejects contradictions across saved rules", () => {
	const c = cfg([rule({ name: "A", kind: "folder", path: "/a/" }), rule({ name: "B", directive: "allow", kind: "folder", path: "/a/" })]);
	assert.match(val.checkConfig(c, SITE), /both allow and block/);
});

/* ---------------- templates and summaries ---------------- */

test("templates pass the checks and do what they say", () => {
	const directory = [];
	for (const t of rules.TEMPLATES) {
		const c = cfg(t.rules(directory).map((r, i) => ({ ...r, id: `${t.id}-${i}` })));
		assert.equal(val.checkConfig(c, SITE), null, t.id);
		const txt = gen(c);
		if (t.id === "search-only") {
			assert.equal(allowed(txt, "Googlebot", "/x/"), true);
			assert.equal(allowed(txt, "Googlebot", "/_emdash/admin"), false);
			assert.equal(allowed(txt, "GPTBot", "/x/"), false);
			assert.equal(allowed(txt, "Random", "/x/"), false);
		}
		if (t.id === "allow-everything") assert.equal(allowed(txt, "GPTBot", "/x/"), true);
	}
});

test("plain-English rule sentences and file summary", () => {
	assert.equal(ex.describeRule(blockAi()), "Block AI training crawlers (10) from the whole site");
	assert.equal(ex.describeRule(rule({ kind: "folder", path: "/private/" })), "Block all crawlers from the /private/ section and everything in it");
	assert.equal(ex.describeRule(rule({ directive: "allow", agents: ["GPTBot"], kind: "filetype", exts: ["pdf", "docx"] })), "Let GPTBot crawl PDF and Word files anywhere on the site");
	assert.match(ex.describeRule(rule({ kind: "folder", path: "/m/", except: ["/m/hi/"] })), /except \/m\/hi\//);
	const lines = ex.summaryText(ex.summarize(cfg([blockAi()]), SITE));
	assert.ok(lines.includes("Search engines can crawl everything."), lines.join("\n"));
	assert.ok(lines.includes("AI training crawlers are blocked from the whole site."), lines.join("\n"));
});

/* ---------------- crawler directory overrides ---------------- */

test("bot overrides: verify, rename and custom bots merge over the directory", () => {
	const dir = [{ slug: "a", name: "A Bot", operator: "", category: "OTHER", description: "", token: "ABot", status: "unverified", evidence: "heuristic", origin: "radar" }];
	const merged = bots.applyOverrides(dir, [
		{ slug: "a", name: "Renamed", verified: { sourceUrl: "https://a.test/docs", at: "2026-10-04", by: "Jon" } },
		{ slug: bots.customSlug("MyBot"), name: "My Bot", custom: { token: "MyBot", category: "AI_CRAWLER", createdAt: "2026-10-04" } },
	]);
	const a = merged.find((b) => b.slug === "a");
	assert.equal(a.name, "Renamed");
	assert.equal(a.originalName, "A Bot");
	assert.equal(a.token, "ABot");
	assert.equal(a.status, "verified");
	assert.equal(a.evidence, "manual");
	assert.equal(a.verifiedBy, "Jon");
	const mine = merged.find((b) => b.token === "MyBot");
	assert.equal(mine.origin, "custom");
	assert.equal(mine.status, "unverified");
});

/* ---------------- guided flow ---------------- */

const guided = await import("../src/robots/guided.ts");

test("guided choices map to stored rules and back without changing the lines", () => {
	const mk = (patch) => ({ ...guided.blankDraft("g"), name: "x", ...patch });
	const cases = [
		mk({ area: "everything" }),
		mk({ area: "section", section: "https://example.com/recipes", anyDepth: true, except: ["/recipes/free/"] }),
		mk({ area: "page", page: "/thank-you/", exact: true }),
		mk({ area: "page", page: "/about" }),
		mk({ area: "files", fileTypes: ["pdf", "word"], otherExt: ".key" }),
		mk({ area: "files", fileTypes: ["zip"], filesIn: "/downloads" }),
		mk({ area: "params", params: ["utm", "fbclid"], otherParam: "?campaign" }),
		mk({ area: "params", anyQuery: true }),
		mk({ area: "advanced", pattern: "/tag-*" }),
		mk({ area: "section", section: "/members/", action: "allow", who: "ai_training" }),
		mk({ area: "everything", who: "specific", agents: ["GPTBot", "MyBot"] }),
	];
	for (const d of cases) {
		const r = guided.draftToRule(d, [], SITE);
		assert.deepEqual(val.shapeFindings(r), [], JSON.stringify(d));
		const back = guided.draftToRule(guided.ruleToDraft(r), [], SITE);
		assert.deepEqual(rules.directives(back), rules.directives(r), JSON.stringify(d));
		assert.deepEqual(back.agents, r.agents);
	}
	const sec = guided.draftToRule(cases[1], [], SITE);
	assert.deepEqual(rules.directives(sec).map((l) => l.value), ["/recipes/", "/*/recipes/", "/recipes/free/"]);
});

test("every legacy kind can be edited in the guided flow without changing its lines", () => {
	const legacy = [
		{ kind: "prefix", path: "/draft" },
		{ kind: "contains", path: "preview=" },
		{ kind: "any_depth", path: "print" },
		{ kind: "wildcard_prefix", path: "/pa_" },
		{ kind: "allow_exception", path: "/members/", allow: "/members/hi" },
		{ kind: "single_page", path: "/a.html", strict: true },
		{ kind: "filetype", ext: "pdf" },
		{ kind: "query_param", path: "session" },
		{ kind: "custom", path: "/*?replytocom=" },
	];
	for (const l of legacy) {
		const r = rule({ ...l, agents: ["GPTBot"] });
		const back = guided.draftToRule(guided.ruleToDraft(r), [], SITE);
		assert.deepEqual(rules.directives(back), rules.directives(r), l.kind);
	}
});

test("smart reading of pasted input", () => {
	assert.equal(guided.inferInput("https://example.com/recipes/", SITE).area, "section");
	assert.equal(guided.inferInput("/recipes", SITE, ["/recipes/"]).value, "/recipes/");
	assert.equal(guided.inferInput("/about", SITE).area, "page");
	assert.equal(guided.inferInput("/files/report.pdf", SITE).area, "page");
	assert.match(guided.inferInput("/files/report.pdf", SITE).message, /kind of file/);
	assert.equal(guided.inferInput("/*.pdf$", SITE).area, "advanced");
	assert.equal(guided.inferInput("https://example.com/?utm_source=x", SITE).area, "params");
	assert.equal(guided.inferInput("https://example.com/", SITE).area, "everything");
	assert.equal(guided.inferInput("/shop?sort=price", SITE).area, "params");
	assert.equal(guided.inferInput("/shop?sort=price", SITE).value, "sort");
});

test("match examples come from the real matcher", () => {
	const r = guided.draftToRule({ ...guided.blankDraft("e"), area: "section", section: "/recipes/" }, [], SITE);
	const ex1 = guided.matchExamples(r);
	assert.ok(ex1.matches.includes("/recipes/"));
	assert.ok(ex1.misses.includes("/recipes"));
	assert.ok(ex1.misses.every((p) => !rep.matchRaw("/recipes/", p)));
	const r2 = guided.draftToRule({ ...guided.blankDraft("e"), area: "section", section: "/m/", except: ["/m/free/"] }, [], SITE);
	assert.ok(guided.matchExamples(r2).misses.some((p) => p.startsWith("/m/free/")));
});

/* ---------------- automatic discovery allowances ---------------- */

test("automaticFrom reads the llms switch; no sitemap or IndexNow lines are added", () => {
	assert.deepEqual(rules.automaticFrom({ "discovery.llms": true, "discovery.newsSitemap": true, "videos.sitemap": true }), { llms: true, aiTraining: false });
	const txt = gen(cfg([], { automatic: rules.automaticFrom({ "discovery.newsSitemap": true, "videos.sitemap": true }) }));
	assert.ok(!txt.includes("news-sitemap") && !txt.includes("video-sitemap"));
});

test("discovery files stay readable for crawlers blocked from the whole site", () => {
	const automatic = rules.automaticFrom({ "discovery.llms": true });
	const c = cfg([blockAi(), rule({ name: "Private", kind: "folder", path: "/private/" })], { automatic, discoveryPaths: ["/agents.json"] });
	const txt = gen(c);
	for (const bot of ["GPTBot", "CCBot"]) {
		for (const p of ["/llms.txt", "/.well-known/security.txt", "/.well-known/ai-plugin.json", "/agents.json"]) assert.equal(allowed(txt, bot, p), true, `${bot} ${p}`);
		// llms-full.txt carries the full text: only when the owner adds it.
		assert.equal(allowed(txt, bot, "/llms-full.txt"), false, bot);
		assert.equal(allowed(txt, bot, "/a-post/"), false, bot);
		assert.equal(allowed(txt, bot, "/a-post/index.html.md"), false, bot);
		assert.equal(allowed(txt, bot, "/_emdash/api/media/f/a.jpg"), false, bot);
	}
	// Nothing is added where nothing blocks the files.
	const star = txt.slice(txt.indexOf("User-agent: *"));
	assert.ok(!star.slice(0, star.indexOf("\n\n")).includes("well-known"));
	assert.equal(allowed(txt, "Googlebot", "/private/x"), false);
	assert.equal(val.selfCheck(c, SITE).ok, true);
	// llms.txt only while Discovery's llms.txt is on; /.well-known/ always.
	const noLlms = gen({ ...c, automatic: rules.automaticFrom({}) });
	assert.equal(allowed(noLlms, "GPTBot", "/llms.txt"), false);
	assert.equal(allowed(noLlms, "GPTBot", "/.well-known/security.txt"), true);
	// Allowance off: nothing.
	const off = gen({ ...c, discoveryAllowances: false });
	assert.equal(allowed(off, "GPTBot", "/llms.txt"), false);
	assert.equal(allowed(off, "GPTBot", "/.well-known/security.txt"), false);
});

test("a rule that blocks a discovery file is warned about and doesn't take effect", () => {
	const automatic = rules.automaticFrom({ "discovery.llms": true });
	const txt = gen(cfg([rule({ name: "Closed" })], { automatic }));
	assert.equal(allowed(txt, "AnyBot", "/llms.txt"), true);
	assert.equal(allowed(txt, "AnyBot", "/x/"), false);
	assert.equal(sev(findings(cfg([], { automatic }), rule({ kind: "single_page", path: "/llms.txt" })), "discovery-path"), "warning");
	assert.equal(sev(findings(cfg([]), rule({ kind: "folder", path: "/.well-known/" })), "discovery-path"), "warning");
	assert.ok(!codes(findings(cfg([]), rule({ kind: "single_page", path: "/llms.txt" }))).includes("discovery-path"));
	assert.ok(!codes(findings(cfg([], { discoveryAllowances: false }), rule({ kind: "folder", path: "/.well-known/" }))).includes("discovery-path"));
});

test("self-check catches Extra lines that block a discovery file", () => {
	const c = cfg([rule({ name: "GPT out", agents: ["GPTBot"] })], { extra: "User-agent: GPTBot\nDisallow: /.well-known/$" });
	const r = val.selfCheck(c, SITE);
	assert.equal(r.ok, false);
	assert.equal(r.failures[0].ruleName, "Discovery files");
});

test("saved includeSitemap:false (production) is respected; missing defaults on", () => {
	assert.equal(rules.normalizeConfig({ rules: [], includeSitemap: false, sitemaps: [], allowMedia: true, comments: true, extra: "" }).includeSitemap, false);
	assert.equal(rules.normalizeConfig({ rules: [] }).includeSitemap, true);
	assert.equal(imp.importRobots(imp.emdashDefaultRobots(SITE), SITE).config.includeSitemap, true);
});

/* ---------------- presets by purpose ---------------- */

import { readFileSync } from "node:fs";
const BUNDLED = JSON.parse(readFileSync(new URL("../src/robots/data/bots.json", import.meta.url), "utf8")).bots;
const VERIFIED = JSON.parse(readFileSync(new URL("../src/robots/data/verified.json", import.meta.url), "utf8"));

test("the bundled directory loads on first use, once", async () => {
	const directory = await import("../src/robots/directory.ts");
	const bots = await directory.baselineBots();
	assert.deepEqual(bots, BUNDLED);
	assert.equal(await directory.baselineBots(), bots, "loaded once per isolate");
	assert.match(await directory.baselineDate(), /^\d{4}-\d{2}-\d{2}/);
});

test("preset membership snapshot", () => {
	const members = Object.fromEntries(rules.CRAWLER_GROUPS.map((g) => [g.id, rules.groupTokens(g, BUNDLED)]));
	assert.deepEqual(members, {
		search_engines: ["Googlebot", "Googlebot-Image", "Googlebot-Video", "Googlebot-News", "bingbot", "Applebot", "DuckDuckBot", "YandexBot", "Baiduspider", "PetalBot"],
		ai_training: ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended", "CCBot", "meta-externalagent", "Bytespider", "Amazonbot", "MistralAI-Training", "Webzio-Extended"],
		ai_search: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Amzn-SearchBot", "MistralAI-Index", "ChatGPT-User", "Claude-User", "Perplexity-User", "meta-externalfetcher", "MistralAI-User", "DuckAssistBot", "Amzn-User"],
		seo_tools: ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "BLEXBot", "DataForSeoBot", "Barkrowler"],
	});
});

test("every preset member is a bundled, verified bot with a matching documented purpose and source", () => {
	for (const g of rules.CRAWLER_GROUPS) {
		for (const t of g.tokens) {
			const b = BUNDLED.find((x) => x.token.toLowerCase() === t.toLowerCase());
			assert.ok(b, `${g.id}: ${t} missing`);
			assert.equal(b.status, "verified", `${g.id}: ${t}`);
			assert.ok(g.purposes.includes(b.purpose), `${g.id}: ${t} is ${b.purpose}`);
			assert.match(VERIFIED.purposes[b.slug]?.sourceUrl ?? "", /^https?:\/\//, `${t} source`);
		}
		// And no bundled bot with that purpose is left out.
		for (const b of BUNDLED.filter((x) => g.purposes.includes(x.purpose) && x.status === "verified" && VERIFIED.purposes[x.slug]?.inPresets !== false)) assert.ok(g.tokens.includes(b.token), `${g.id} misses ${b.token}`);
	}
});

test("no search engine (or non-training bot) in an AI preset; Radar-only and unverified bots never join", () => {
	const search = new Set(BUNDLED.filter((b) => b.purpose === "search-engine").map((b) => b.token.toLowerCase()));
	for (const id of ["ai_training", "ai_search"]) {
		for (const t of rules.groupTokens(rules.CRAWLER_GROUPS.find((g) => g.id === id), BUNDLED)) assert.ok(!search.has(t.toLowerCase()), `${id}: ${t}`);
	}
	const training = rules.groupTokens(rules.CRAWLER_GROUPS.find((g) => g.id === "ai_training"), BUNDLED);
	for (const t of ["PetalBot", "GoogleOther", "ImagesiftBot", "Diffbot", "Omgilibot", "Timpibot", "img2dataset", "anthropic-ai", "SemrushBot-SWA", "Peer39_crawler"]) assert.ok(!training.includes(t), t);
	const radarOnly = [{ token: "NewAIBot", category: "AI_CRAWLER", status: "verified", origin: "radar", purpose: undefined }];
	assert.ok(!rules.groupTokens(rules.CRAWLER_GROUPS[1], radarOnly).includes("NewAIBot"));
	const custom = [{ token: "MyTrainer", category: "OTHER", status: "verified", origin: "custom", purpose: "training" }, { token: "Unchecked", category: "OTHER", status: "unverified", origin: "custom", purpose: "training" }];
	const withCustom = rules.groupTokens(rules.CRAWLER_GROUPS[1], custom);
	assert.ok(withCustom.includes("MyTrainer") && !withCustom.includes("Unchecked"));
});

test("rules made from a preset follow it (legacy lists and the 0.7.0 category expansion)", () => {
	const legacy = { ...rule({ name: "Block AI training crawlers", agents: ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended", "CCBot", "meta-externalagent", "Bytespider", "Amazonbot", "MistralAI-Training", "Webzio-Extended", "ImagesiftBot"] }) };
	delete legacy.group;
	const expanded = rule({ name: "Wide", agents: [...AI, "PetalBot", "GoogleOther"], group: "ai_training" });
	const mine = rule({ name: "Mine", agents: ["GPTBot", "CCBot"] });
	const { config, changes } = rules.refreshGroups(cfg([legacy, expanded, mine]), []);
	assert.deepEqual(config.rules[0].agents, AI);
	assert.equal(config.rules[0].group, "ai_training");
	assert.deepEqual(changes.find((c) => c.ruleName === "Block AI training crawlers").removed, ["ImagesiftBot"]);
	assert.deepEqual(changes.find((c) => c.ruleName === "Wide").removed, ["PetalBot", "GoogleOther"]);
	assert.deepEqual(config.rules[2].agents, ["GPTBot", "CCBot"]);
	assert.equal(changes.length, 2);
	assert.equal(rules.refreshGroups(config, []).changes.length, 0);
});

/* ---------------- review fixes ---------------- */

test("exceptions must sit inside the blocked area and can't reopen all of it", () => {
	const ok = rule({ kind: "folder", path: "/m/", except: ["/m/free/"] });
	assert.deepEqual(val.shapeFindings(ok), []);
	for (const [except, code] of [[["*"], "except-everything"], [["/"], "except-everything"], [["/m/"], "except-everything"], [["/other/"], "except-outside"], [["/m"], "except-everything"], [["/mx/"], "except-outside"]]) {
		const f = val.shapeFindings(rule({ kind: "folder", path: "/m/", except }));
		assert.ok(codes(f).includes(code), `${except}: ${codes(f)}`);
		assert.notEqual(val.checkConfig(cfg([rule({ kind: "folder", path: "/m/", except })]), SITE), null);
	}
	assert.deepEqual(val.shapeFindings(rule({ kind: "entire_site", except: ["/public/"] })), []);
});

test("exact addresses never get a double $", () => {
	assert.deepEqual(rules.directives(rule({ kind: "exact_url", path: "/search$" })).map((l) => l.value), ["/search$"]);
	assert.deepEqual(rules.directives(rule({ kind: "single_page", path: "/a$$", strict: true })).map((l) => l.value), ["/a$"]);
});

test("Extra lines that block everything are reported (without blocking the save)", () => {
	const c = cfg([], { extra: "User-agent: *\nDisallow: /" });
	assert.ok(val.extraLineWarnings(c, SITE).some((f) => f.code === "search-whole-site"));
	assert.equal(val.checkConfig(c, SITE), null);
	assert.deepEqual(val.extraLineWarnings(cfg([]), SITE), []);
});

test("takeover: a failed read of EmDash's settings imports nothing and serves EmDash's file", async () => {
	const mw = await import("../src/robots/middleware.ts");
	let writes = 0;
	let reads = 0;
	// A tiny fake: SELECTs return null except site:seo, which fails.
	const db = {
		prepare(sql) {
			let arg;
			return {
				bind(a) {
					arg = a;
					return this;
				},
				async first() {
					if (arg === "site:seo") throw new Error("D1 timeout");
					return null;
				},
				async all() {
					reads++;
					return { results: [] };
				},
				async run() {
					writes++;
				},
			};
		},
	};
	const res = await mw.serveRobots(new URL("https://example.com/robots.txt"), "GET", { DB: db });
	assert.equal(res, undefined);
	assert.equal(writes, 0);
	// The saved rules and the Site URL come from one query.
	assert.equal(reads, 1);
	await assert.rejects(() => mw.readEmdashCustomRobots(db));
});

test("EmDash's Disallow AI training setting adds EmDash's own lines, word for word", () => {
	const off = gen(cfg([]));
	assert.ok(!off.includes("Content-Signal"));
	const c = { ...cfg([]), automatic: rules.automaticFrom({}, true) };
	const txt = gen(c);
	assert.ok(txt.includes(`${rules.EMDASH_AI_TRAINING}\n`));
	// Before the sitemap, as in EmDash's file.
	assert.ok(txt.indexOf("Content-Signal") < txt.indexOf("Sitemap:"));
	for (const bot of rules.EMDASH_AI_TRAINING_CRAWLERS) assert.equal(allowed(txt, bot, "/x/"), false, bot);
	// Everyone else keeps the site, and the admin stays closed.
	assert.equal(allowed(txt, "Googlebot", "/x/"), true);
	assert.equal(allowed(txt, "OAI-SearchBot", "/x/"), true);
	assert.equal(allowed(txt, "Googlebot", "/_emdash/admin"), false);
	assert.equal(val.checkConfig(c, SITE), null);
	// No AI-training preset or template of the pack's own: EmDash's setting is the one switch.
	assert.ok(!rules.PRESETS.some((p) => p.group === "ai_training"));
	assert.ok(!rules.TEMPLATES.some((t) => t.id === "block-ai-training"));
});

test("EmDash's AI lines come after Extra lines, so lines without a User-agent keep their group", () => {
	const base = cfg([], { extra: "Disallow: /tmp/" });
	const on = { ...base, automatic: rules.automaticFrom({}, true) };
	for (const c of [base, on]) assert.equal(allowed(gen(c), "Googlebot", "/tmp/x"), false);
	const txt = gen(on);
	assert.ok(txt.indexOf("Disallow: /tmp/") < txt.indexOf("# Disallow AI training"));
});

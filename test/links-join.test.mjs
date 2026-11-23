// Run: node --import ./test/ts-resolve.mjs --test test/links-join.test.mjs
// Join split links (links.join): one link the editor saved in pieces is stored as one link.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { joinSplitLinks, joinEntrySplitLinks } = await import("../src/links/join.ts");
const { linksPack, joinSplitLinksBeforeSave, JOIN_FEATURE } = await import("../src/links/pack.ts");
const { composeHooks } = await import("../src/core/compose.ts");
const { invalidateFeatures, featureCatalog } = await import("../src/core/features.ts");

const deepFreeze = (v) => {
	if (v && typeof v === "object") {
		Object.freeze(v);
		for (const child of Object.values(v)) deepFreeze(child);
	}
	return v;
};

const GEMINI = "https://glossary.io/gemini/";
const span = (key, text, marks) => ({ _type: "span", _key: key, text, marks });
const link = (key, href, extra = {}) => ({ _type: "link", _key: key, href, ...extra });
const block = (children, markDefs, key = "b1") => ({ _type: "block", _key: key, style: "normal", children, markDefs });

/** The coywolf.com case: "Google's " and "Gemini" each with its own link mark to the same glossary.io page. */
const geminiBlock = () =>
	deepFreeze(
		block(
			[span("s1", "Ask ", []), span("s2", "Google's ", ["k1"]), span("s3", "Gemini", ["k2"]), span("s4", " anything.", [])],
			[link("k1", GEMINI), link("k2", GEMINI)],
		),
	);

const texts = (blocks) => blocks.flatMap((b) => b.children.map((c) => c.text));

test("the Gemini case collapses to one link mark", () => {
	const input = [geminiBlock()];
	const { value, joined } = joinSplitLinks(input);
	assert.equal(joined, 1);
	assert.deepEqual(value[0].markDefs, [link("k1", GEMINI)], "one markDef left");
	assert.deepEqual(
		value[0].children.map((c) => c.marks),
		[[], ["k1"], ["k1"], []],
	);
	assert.deepEqual(texts(value), texts(input), "text unchanged");
	assert.deepEqual(
		value[0].children.map((c) => c._key),
		["s1", "s2", "s3", "s4"],
		"span keys unchanged",
	);
	assert.equal(input[0].markDefs.length, 2, "input untouched");
	assert.equal(value[0].children[0], input[0].children[0], "unchanged spans are shared");
});

test("other marks stay, in their order; only the link key is swapped", () => {
	const b = deepFreeze(block([span("a", "Google's ", ["strong", "k1"]), span("b", "Gemini", ["em", "k2", "code"])], [link("k1", GEMINI), link("k2", GEMINI), { _type: "comment", _key: "c1", text: "x" }]));
	const { value, joined } = joinSplitLinks([b]);
	assert.equal(joined, 1);
	assert.deepEqual(value[0].children[0].marks, ["strong", "k1"]);
	assert.deepEqual(value[0].children[1].marks, ["em", "k1", "code"]);
	assert.deepEqual(
		value[0].markDefs.map((d) => d._key),
		["k1", "c1"],
		"a non-link markDef is kept",
	);
});

test("a run of three pieces joins the first link; both extra markDefs go", () => {
	const b = deepFreeze(block([span("a", "Go", ["k1"]), span("b", "og", ["k2"]), span("c", "le", ["k3", "strong"]), span("d", "le", ["k2"])], [link("k1", GEMINI), link("k2", GEMINI), link("k3", GEMINI)]));
	const { value, joined } = joinSplitLinks([b]);
	assert.equal(joined, 3);
	assert.deepEqual(
		value[0].children.map((c) => c.marks),
		[["k1"], ["k1"], ["k1", "strong"], ["k1"]],
	);
	assert.deepEqual(value[0].markDefs, [link("k1", GEMINI)]);
});

test("links with different addresses or attributes aren't joined", () => {
	const cases = [
		[link("k1", GEMINI), link("k2", "https://glossary.io/gemini")],
		[link("k1", GEMINI, { blank: true }), link("k2", GEMINI)],
		[link("k1", GEMINI, { title: "Gemini" }), link("k2", GEMINI)],
		[link("k1", GEMINI, { rel: "nofollow" }), link("k2", GEMINI, { rel: "sponsored" })],
	];
	for (const defs of cases) {
		const input = [deepFreeze(block([span("a", "Google's ", ["k1"]), span("b", "Gemini", ["k2"])], defs))];
		const { value, joined } = joinSplitLinks(input);
		assert.equal(joined, 0, JSON.stringify(defs));
		assert.equal(value, input, "nothing changed: the same array comes back");
	}
});

test("blank: false is the same as no blank, and attribute order doesn't matter", () => {
	const b = deepFreeze(
		block(
			[span("a", "Google's ", ["k1"]), span("b", "Gemini", ["k2"])],
			[
				{ _type: "link", _key: "k1", href: GEMINI, blank: false, data: { a: 1, b: 2 } },
				{ data: { b: 2, a: 1 }, href: GEMINI, _key: "k2", _type: "link" },
			],
		),
	);
	const { value, joined } = joinSplitLinks([b]);
	assert.equal(joined, 1);
	assert.deepEqual(
		value[0].markDefs.map((d) => d._key),
		["k1"],
	);
	const both = deepFreeze(block([span("a", "x", ["k1"]), span("b", "y", ["k2"])], [link("k1", GEMINI, { blank: true }), link("k2", GEMINI, { blank: true })]));
	assert.equal(joinSplitLinks([both]).joined, 1, "both open in a new tab");
});

test("only adjacent spans join: anything between them keeps two links", () => {
	const defs = [link("k1", GEMINI), link("k2", GEMINI)];
	const between = [
		[span("a", "Google's", ["k1"]), span("x", " and ", []), span("b", "Gemini", ["k2"])],
		[span("a", "Google's", ["k1"]), { _type: "inlineThing", _key: "i" }, span("b", "Gemini", ["k2"])],
		[span("a", "Google's", ["k1"]), span("x", "", ["strong"]), span("b", "Gemini", ["k2"])],
	];
	for (const children of between) {
		const input = [deepFreeze(block(children, defs))];
		assert.equal(joinSplitLinks(input).value, input);
	}
	// The same link before and after other text: already one markDef per piece of linked text, left alone.
	const same = [deepFreeze(block([span("a", "Gemini", ["k1"]), span("x", " and ", []), span("b", "Gemini", ["k1"])], [link("k1", GEMINI)]))];
	assert.equal(joinSplitLinks(same).value, same);
});

test("a markDef still used elsewhere in the block stays; one unused before stays too", () => {
	const b = deepFreeze(
		block(
			[span("a", "Google's ", ["k1"]), span("b", "Gemini", ["k2"]), span("c", " (see ", []), span("d", "Gemini", ["k2"]), span("e", ")", [])],
			[link("k1", GEMINI), link("k2", GEMINI), link("old", "https://example.com/")],
		),
	);
	const { value, joined } = joinSplitLinks([b]);
	assert.equal(joined, 1);
	assert.deepEqual(
		value[0].children.map((c) => c.marks),
		[["k1"], ["k1"], [], ["k2"], []],
	);
	assert.deepEqual(
		value[0].markDefs.map((d) => d._key),
		["k1", "k2", "old"],
	);
});

test("ambiguous spans and markDefs are left alone", () => {
	// A span with two link marks.
	const two = [deepFreeze(block([span("a", "Google's ", ["k1"]), span("b", "Gemini", ["k2", "k3"])], [link("k1", GEMINI), link("k2", GEMINI), link("k3", GEMINI)]))];
	assert.equal(joinSplitLinks(two).value, two);
	// A key defined twice.
	const dup = [deepFreeze(block([span("a", "Google's ", ["k1"]), span("b", "Gemini", ["k2"])], [link("k1", GEMINI), link("k2", GEMINI), link("k2", "https://example.com/")]))];
	assert.equal(joinSplitLinks(dup).value, dup);
	// A mark that isn't defined, links without an address, spans without marks.
	const odd = [
		deepFreeze(
			block(
				[span("a", "x", ["nope"]), span("b", "y", ["nope2"]), span("c", "z", ["e1"]), span("d", "w", ["e2"]), { _type: "span", _key: "e", text: "v" }],
				[link("e1", ""), link("e2", "")],
			),
		),
	];
	assert.equal(joinSplitLinks(odd).value, odd);
	assert.deepEqual(joinSplitLinks([]).value, []);
	assert.equal(joinSplitLinks(null).value, null);
	assert.equal(joinSplitLinks("text").value, "text");
});

test("nested blocks: inside another block's fields, and in table cells", () => {
	const callout = deepFreeze({ _type: "callout", _key: "co", tone: "info", body: [geminiBlock()], asset: { _ref: "m1" } });
	const table = deepFreeze({
		_type: "table",
		_key: "t",
		markDefs: [link("t1", GEMINI)],
		rows: [
			{
				_key: "r1",
				cells: [
					{ _key: "c1", content: [span("x", "Google's ", ["k1"]), span("y", "Gemini", ["k2"])], markDefs: [link("k1", GEMINI), link("k2", GEMINI)] },
					{ _key: "c2", content: [span("z", "plain", [])], markDefs: [] },
				],
			},
		],
	});
	const input = [callout, table];
	const { value, joined } = joinSplitLinks(input);
	assert.equal(joined, 2);
	assert.deepEqual(value[0].body[0].markDefs, [link("k1", GEMINI)]);
	assert.equal(value[0].tone, "info");
	assert.equal(value[0].asset, callout.asset);
	const cell = value[1].rows[0].cells[0];
	assert.deepEqual(
		cell.content.map((c) => c.marks),
		[["k1"], ["k1"]],
	);
	assert.deepEqual(cell.markDefs, [link("k1", GEMINI)]);
	assert.deepEqual(value[1].markDefs, [link("t1", GEMINI)], "the table's own markDefs aren't touched");
	assert.equal(value[1].rows[0].cells[1], table.rows[0].cells[1], "unchanged cells are shared");
});

test("running it twice joins nothing the second time; block order and keys never change", () => {
	const input = deepFreeze([{ _type: "image", _key: "i1", asset: { _ref: "m" } }, geminiBlock(), block([span("p", "plain", [])], [], "b2")]);
	const once = joinSplitLinks(input);
	assert.equal(once.joined, 1);
	assert.deepEqual(
		once.value.map((b) => b._key),
		["i1", "b1", "b2"],
	);
	assert.equal(once.value[0], input[0]);
	assert.equal(once.value[2], input[2]);
	const twice = joinSplitLinks(once.value);
	assert.equal(twice.joined, 0);
	assert.equal(twice.value, once.value);
});

test("joinEntrySplitLinks: only the fields that changed; null when nothing did", () => {
	const content = deepFreeze({ title: "Gemini", body: [geminiBlock()], excerpt: [block([span("e", "x", [])], [])], count: 3, tags: null });
	const out = joinEntrySplitLinks(content);
	assert.equal(out.joined, 1);
	assert.deepEqual(Object.keys(out.content), ["title", "body", "excerpt", "count", "tags"]);
	assert.equal(out.content.excerpt, content.excerpt);
	assert.equal(out.content.title, "Gemini");
	assert.deepEqual(out.content.body[0].markDefs, [link("k1", GEMINI)]);
	assert.equal(joinEntrySplitLinks(out.content), null);
	assert.equal(joinEntrySplitLinks({ title: "Only the title changed" }), null, "a save with only some fields: nothing added");
});

test("the hook: undefined when nothing changes, the joined content when it does, and it never throws", async () => {
	const logs = [];
	const ctx = { log: { debug: (msg, data) => logs.push([msg, data]), info: (msg, data) => logs.push([msg, data]), warn: (msg, data) => logs.push([msg, data]) } };
	assert.equal(await joinSplitLinksBeforeSave({ content: { title: "x" }, collection: "posts" }, ctx), undefined);
	assert.equal(await joinSplitLinksBeforeSave({ collection: "posts" }, ctx), undefined);
	assert.equal(await joinSplitLinksBeforeSave(undefined, ctx), undefined);
	const out = await joinSplitLinksBeforeSave({ content: { body: [geminiBlock()] }, collection: "posts", id: "p1" }, ctx);
	assert.deepEqual(out.body[0].markDefs, [link("k1", GEMINI)]);
	assert.deepEqual(logs.pop(), ["links: joined split links", { collection: "posts", id: "p1", joined: 1 }]);

	// Content that throws while it's read: saved as it came, with a warning.
	const hostile = { get body() { throw new Error("boom"); } };
	assert.equal(await joinSplitLinksBeforeSave({ content: hostile, collection: "posts" }, ctx), undefined);
	assert.match(logs.pop()[0], /couldn't check for split links/);
	// Even when logging fails.
	const broken = { log: { debug() { throw new Error("log"); }, info() { throw new Error("log"); }, warn() { throw new Error("log"); } } };
	assert.equal(await joinSplitLinksBeforeSave({ content: hostile }, broken), undefined);
	assert.equal(await joinSplitLinksBeforeSave({ content: { body: [geminiBlock()] } }, broken), undefined);
});

test("wired into Link Manager: a part on by default, gating content:beforeSave", async () => {
	const pack = linksPack();
	assert.equal(JOIN_FEATURE, "links.join");
	assert.equal(pack.hooks["content:beforeSave"], joinSplitLinksBeforeSave);
	assert.equal(pack.hookFeature["content:beforeSave"], JOIN_FEATURE);
	assert.ok(pack.capabilities.includes("content:write"), "beforeSave needs content:write");
	const def = pack.features.find((f) => f.id === JOIN_FEATURE);
	assert.equal(def.default, true);
	assert.ok(featureCatalog().some((f) => f.id === JOIN_FEATURE), "registered");
	assert.equal(pack.features[0].id, "links", "Link Manager stays the main switch");

	const { hooks } = composeHooks([pack], { tasks: [] });
	const event = { content: { body: [geminiBlock()] }, collection: "posts", isNew: false, id: "p1" };
	const ctxWith = (features) => {
		const store = new Map(features === undefined ? [] : [["features", features]]);
		return { settings: { get: async (key) => store.get(key) ?? null, set: async () => {} }, log: { debug() {}, info() {}, warn() {}, error() {} } };
	};
	invalidateFeatures();
	const on = await hooks["content:beforeSave"](event, ctxWith({ links: true }));
	assert.deepEqual(on.body[0].markDefs, [link("k1", GEMINI)], "Link Manager on: the part's default (on) applies");
	invalidateFeatures();
	assert.equal(await hooks["content:beforeSave"](event, ctxWith({ links: true, [JOIN_FEATURE]: false })), undefined, "part off");
	invalidateFeatures();
	assert.equal(await hooks["content:beforeSave"](event, ctxWith({ links: false, [JOIN_FEATURE]: true })), undefined, "Link Manager off");
	invalidateFeatures();
	assert.equal(await hooks["content:beforeSave"]({ ...event, content: { title: "x" } }, ctxWith({ links: true })), undefined, "nothing to join: no change");
	invalidateFeatures();
});

test("cost: a 20,000-piece link in one block joins in one pass, not one walk per piece", () => {
	const n = 20_000;
	const b = block(
		Array.from({ length: n }, (_, i) => span(`s${i}`, "x", [`k${i}`])),
		Array.from({ length: n }, (_, i) => link(`k${i}`, GEMINI)),
	);
	const started = performance.now();
	const { value, joined } = joinSplitLinks([b]);
	const ms = performance.now() - started;
	assert.equal(joined, n - 1);
	assert.deepEqual(value[0].markDefs, [link("k0", GEMINI)]);
	assert.ok(ms < 2_000, `took ${Math.round(ms)} ms (quadratic took about 4 s here)`);
});

/** The link elements EmDash's renderer makes from a block: astro-portabletext's own @portabletext/toolkit. */
async function renderedLinks(b) {
	const require = createRequire(import.meta.url);
	let toolkit;
	try {
		// From astro-portabletext's own entry: it can have its own copy of the toolkit (3.x under EmDash 1.5).
		toolkit = createRequire(require.resolve("astro-portabletext"))("@portabletext/toolkit");
	} catch {
		toolkit = await import("@portabletext/toolkit");
	}
	const links = [];
	const walk = (node) => {
		if (node && node._type === "@span" && node.markType === "link") links.push(toolkit.spanToPlainText(node));
		for (const child of node?.children ?? []) walk(child);
	};
	for (const node of toolkit.buildMarksTree(b)) walk(node);
	return links;
}

test("rendered: the joined pieces are one link element (EmDash's renderer), with the one documented exception", async () => {
	// Before: two links side by side. After: one.
	assert.deepEqual(await renderedLinks(geminiBlock()), ["Google's ", "Gemini"]);
	assert.deepEqual(await renderedLinks(joinSplitLinks([geminiBlock()]).value[0]), ["Google's Gemini"]);
	// Other formatting inside the link, or running on past it: still one link.
	const inner = block([span("a", "Google's ", ["k1"]), span("b", "Gem", ["k2", "strong"]), span("c", "ini", ["k2"])], [link("k1", GEMINI), link("k2", GEMINI)]);
	assert.deepEqual(await renderedLinks(joinSplitLinks([inner]).value[0]), ["Google's Gemini"]);
	const past = block([span("a", "Google's ", ["em", "k1"]), span("b", "Gemini", ["em", "k2"]), span("c", " here", ["em"])], [link("k1", GEMINI), link("k2", GEMINI)]);
	assert.deepEqual(await renderedLinks(joinSplitLinks([past]).value[0]), ["Google's Gemini"]);
	// Formatting that starts before the link and ends inside it closes the link with it (docs/links.md): one markDef, two elements.
	const across = block([span("p", "pre ", ["strong"]), span("a", "G ", ["strong", "k1"]), span("b", "Gem", ["k2"])], [link("k1", GEMINI), link("k2", GEMINI)]);
	const joined = joinSplitLinks([across]).value[0];
	assert.deepEqual(joined.markDefs, [link("k1", GEMINI)]);
	assert.deepEqual(await renderedLinks(joined), ["G ", "Gem"]);
});

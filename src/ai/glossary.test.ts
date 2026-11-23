/**
 * Unit tests for glossary.io definitions (src/ai/glossary.ts) and their use in entityNodes.
 * Run: node --import ./test/ts-resolve.mjs --test src/ai/glossary.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as G from "./glossary.ts";
// @ts-ignore -- as above.
import * as L from "./logic.ts";
// @ts-ignore -- as above.
import * as F from "../core/features.ts";

const glossary = G as typeof import("./glossary.js");
const logic = L as typeof import("./logic.js");
const features = F as typeof import("../core/features.js");

// AI Enrichment registers these when the pack loads (src/ai/pack.ts).
features.registerFeatures([
	{ id: "ai", label: "AI Enrichment", description: "", default: false },
	{ id: "ai.glossary", label: "glossary.io definitions", description: "", default: true },
]);

const GEMINI = "Gemini is Google's generative AI chatbot and assistant.";

test("parseGlossaryIndex keeps only well-formed terms", () => {
	const terms = glossary.parseGlossaryIndex({
		v: 1,
		terms: {
			Q116698014: ["gemini", `  ${GEMINI}\n`],
			Q1: ["Bad Slug", "x"],
			Q2: ["ok", ""],
			Q3: ["ok", "y".repeat(501)],
			Q4: ["ok", 5],
			X5: ["ok", "z"],
			Q0: ["zero", "z"],
			Q6: "not an array",
			Q7: ["javascript-x", "Fine."],
		},
	});
	assert.deepEqual(terms, { Q116698014: ["gemini", GEMINI], Q7: ["javascript-x", "Fine."] });
	assert.equal(glossary.parseGlossaryIndex({ v: 2, terms: {} }), null);
	assert.equal(glossary.parseGlossaryIndex({ terms: {} }), null);
	assert.equal(glossary.parseGlossaryIndex({ v: 1, terms: [] }), null);
	assert.equal(glossary.parseGlossaryIndex(null), null);
	assert.equal(glossary.parseGlossaryIndex("x"), null);
});

test("glossaryLookup builds glossary.io URLs and ignores inherited keys", () => {
	const lookup = glossary.glossaryLookup({ Q116698014: ["gemini", GEMINI] })!;
	assert.deepEqual(lookup("Q116698014"), { url: "https://glossary.io/gemini/", description: GEMINI });
	assert.equal(lookup("Q1"), undefined);
	assert.equal(lookup("constructor"), undefined);
	assert.equal(lookup("__proto__"), undefined);
	assert.equal(glossary.glossaryLookup(null), undefined);
});

test("isGlossarySite matches glossary.io only", () => {
	assert.equal(glossary.isGlossarySite("https://glossary.io"), true);
	assert.equal(glossary.isGlossarySite("https://www.glossary.io/"), true);
	assert.equal(glossary.isGlossarySite("https://GLOSSARY.IO/gemini/"), true);
	assert.equal(glossary.isGlossarySite("https://coywolf.com"), false);
	assert.equal(glossary.isGlossarySite("https://glossary.io.example.com"), false);
	assert.equal(glossary.isGlossarySite("/relative/"), false);
	assert.equal(glossary.isGlossarySite(null), false);
});

test("entityNodes adds the glossary.io page last and uses its definition", () => {
	const lookup = glossary.glossaryLookup({ Q116698014: ["gemini", GEMINI], Q90: ["paris", "Paris is a city."] });
	const nodes = logic.entityNodes(
		[
			{ name: "Gemini", type: "Thing", description: "Google's AI assistant built into Android", qid: "Q116698014", wikipedia: "https://en.wikipedia.org/wiki/Google_Gemini", website: "https://gemini.google.com/", primary: true },
			{ name: "X", type: "Thing", description: "Kept", qid: "Q1", wikipedia: "", website: "", primary: false },
			{ name: "Paris", type: "Place", description: "", qid: "Q90", wikipedia: "", website: "", primary: false },
		],
		lookup,
	);
	assert.deepEqual(nodes.about, [
		{
			"@type": "Thing",
			name: "Gemini",
			sameAs: ["https://www.wikidata.org/wiki/Q116698014", "https://en.wikipedia.org/wiki/Google_Gemini", "https://gemini.google.com/", "https://glossary.io/gemini/"],
			description: GEMINI,
		},
	]);
	assert.deepEqual(nodes.mentions, [
		{ "@type": "Thing", name: "X", sameAs: "https://www.wikidata.org/wiki/Q1", description: "Kept" },
		{ "@type": "Place", name: "Paris", sameAs: ["https://www.wikidata.org/wiki/Q90", "https://glossary.io/paris/"], description: "Paris is a city." },
	]);
});

test("entityNodes doesn't repeat a glossary.io page that's already the website", () => {
	const lookup = glossary.glossaryLookup({ Q5: ["glossary", "A glossary."] });
	const nodes = logic.entityNodes([{ name: "Glossary", type: "Thing", description: "", qid: "Q5", wikipedia: "", website: "https://glossary.io/glossary/", primary: true }], lookup);
	assert.deepEqual(nodes.about[0].sameAs, ["https://www.wikidata.org/wiki/Q5", "https://glossary.io/glossary/"]);
});

// ── Loading: a fake plugin context ───────────────────────────────

function fakeCtx(options: { features?: Record<string, boolean>; stored?: unknown; respond?: () => Promise<Response> }) {
	const docs = new Map<string, unknown>();
	if (options.stored !== undefined) docs.set("index", options.stored);
	const calls = { fetch: 0, put: 0 };
	const ctx = {
		settings: { get: async (key: string) => (key === "features" ? (options.features ?? { ai: true, "ai.entities": true }) : null) },
		storage: {
			aiGlossary: {
				get: async (id: string) => docs.get(id) ?? null,
				put: async (id: string, value: unknown) => {
					calls.put++;
					docs.set(id, value);
				},
			},
		},
		http: {
			fetch: async () => {
				calls.fetch++;
				return options.respond ? options.respond() : new Response(JSON.stringify({ v: 1, terms: { Q116698014: ["gemini", GEMINI] } }), { status: 200 });
			},
		},
	};
	return { ctx: ctx as never, calls, docs };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("glossaryFor fetches and stores when the site has no copy, then uses memory", async () => {
	glossary.resetGlossaryForTests();
	const { ctx, calls, docs } = fakeCtx({});
	const lookup = await glossary.glossaryFor(ctx, "https://coywolf.com");
	assert.equal(lookup?.("Q116698014")?.url, "https://glossary.io/gemini/");
	await settle();
	assert.equal(calls.fetch, 1);
	assert.equal(calls.put, 1);
	assert.equal((docs.get("index") as { terms: unknown }).terms !== undefined, true);
	await glossary.glossaryFor(ctx, "https://coywolf.com");
	assert.equal(calls.fetch, 1, "the second render uses this isolate's copy");
});

test("glossaryFor uses a fresh stored copy without fetching", async () => {
	glossary.resetGlossaryForTests();
	const { ctx, calls } = fakeCtx({ stored: { fetchedAt: Date.now(), terms: { Q90: ["paris", "Paris is a city."] } } });
	const lookup = await glossary.glossaryFor(ctx, "https://coywolf.com");
	assert.equal(lookup?.("Q90")?.url, "https://glossary.io/paris/");
	await settle();
	assert.equal(calls.fetch, 0);
});

test("glossaryFor serves a day-old copy and refreshes it after the response", async () => {
	glossary.resetGlossaryForTests();
	const { ctx, calls, docs } = fakeCtx({ stored: { fetchedAt: Date.now() - 25 * 60 * 60_000, terms: { Q90: ["paris", "Paris is a city."] } } });
	const lookup = await glossary.glossaryFor(ctx, "https://coywolf.com");
	assert.equal(lookup?.("Q90")?.url, "https://glossary.io/paris/", "the old copy answers this render");
	await settle();
	assert.equal(calls.fetch, 1);
	assert.deepEqual((docs.get("index") as { terms: unknown }).terms, { Q116698014: ["gemini", GEMINI] });
	const next = await glossary.glossaryFor(ctx, "https://coywolf.com");
	assert.equal(next?.("Q116698014")?.url, "https://glossary.io/gemini/", "the refreshed copy answers later renders");
	assert.equal(calls.fetch, 1);
});

test("glossaryFor survives glossary.io failing and waits before trying again", async () => {
	glossary.resetGlossaryForTests();
	const { ctx, calls } = fakeCtx({ respond: async () => new Response("blocked", { status: 403 }) });
	assert.equal(await glossary.glossaryFor(ctx, "https://coywolf.com"), undefined);
	assert.equal(await glossary.glossaryFor(ctx, "https://coywolf.com"), undefined);
	await settle();
	assert.equal(calls.fetch, 1);
	glossary.resetGlossaryForTests();
	const thrown = fakeCtx({ respond: async () => Promise.reject(new Error("network")) });
	assert.equal(await glossary.glossaryFor(thrown.ctx, "https://coywolf.com"), undefined);
	const garbage = fakeCtx({ respond: async () => new Response("<html>", { status: 200 }) });
	glossary.resetGlossaryForTests();
	assert.equal(await glossary.glossaryFor(garbage.ctx, "https://coywolf.com"), undefined);
});

test("glossaryFor stays off on glossary.io and when the switch is off", async () => {
	glossary.resetGlossaryForTests();
	const { ctx, calls } = fakeCtx({});
	assert.equal(await glossary.glossaryFor(ctx, "https://glossary.io"), undefined);
	features.invalidateFeatures();
	const off = fakeCtx({ features: { ai: true, "ai.glossary": false } });
	assert.equal(await glossary.glossaryFor(off.ctx, "https://coywolf.com"), undefined);
	features.invalidateFeatures();
	const aiOff = fakeCtx({ features: { ai: false } });
	assert.equal(await glossary.glossaryFor(aiOff.ctx, "https://coywolf.com"), undefined);
	features.invalidateFeatures();
	await settle();
	assert.equal(calls.fetch + off.calls.fetch + aiOff.calls.fetch, 0);
});

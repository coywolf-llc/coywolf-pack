// Run: node --test test/breadcrumbs.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { registerFeatures, resolveFeatures, invalidateFeatures, legacyChoice } = await import("../src/core/features.ts");
const { composeHooks } = await import("../src/core/compose.ts");
const { headingsPack } = await import("../src/headings/pack.ts");
const { breadcrumbsPack, FEATURES } = await import("../src/breadcrumbs/pack.ts");
const { resolveSettings, normalizeSettings, ctxBreadcrumbsSettings, DEFAULT_SETTINGS } = await import("../src/breadcrumbs/settings.ts");
const { stampBreadcrumbs } = await import("../src/breadcrumbs/stamp.ts");
const { capturePage, capturedPage, humanize, resolveTrail } = await import("../src/breadcrumbs/trail.ts");

/** A plugin context with settings in a map. */
function fakeCtx(settings) {
	const store = new Map(Object.entries(settings));
	return {
		settings: { get: async (key) => store.get(key) ?? null, set: async (key, value) => void store.set(key, value) },
		log: { info() {}, warn() {}, error() {} },
		store,
	};
}

// ── Feature migration (FeatureDef.replaces) ──────────────────────

test("breadcrumbs replaces headings.breadcrumbs", () => {
	assert.deepEqual(FEATURES[0].replaces, ["headings.breadcrumbs"]);
	assert.equal(FEATURES[0].default, false);
});

test("a stored legacy switch carries over when the new id isn't stored", () => {
	// wellbeing.io: Headings on with its Breadcrumbs sub-feature on.
	assert.equal(resolveFeatures({ headings: true, "headings.breadcrumbs": true }).breadcrumbs, true);
	assert.equal(resolveFeatures({ headings: true, "headings.breadcrumbs": false }).breadcrumbs, false);
	// The legacy sub-feature only counted while its parent was on.
	assert.equal(resolveFeatures({ headings: false, "headings.breadcrumbs": true }).breadcrumbs, false);
	assert.equal(resolveFeatures({ "headings.breadcrumbs": true }).breadcrumbs, false, "headings defaults to off");
	// Nothing stored: the default.
	assert.equal(resolveFeatures({}).breadcrumbs, false);
	assert.equal(resolveFeatures(null).breadcrumbs, false);
});

test("a stored choice for the new id wins over the legacy one", () => {
	assert.equal(resolveFeatures({ headings: true, "headings.breadcrumbs": true, breadcrumbs: false }).breadcrumbs, false);
	assert.equal(resolveFeatures({ "headings.breadcrumbs": false, breadcrumbs: true }).breadcrumbs, true);
});

test("Headings no longer has a breadcrumbs sub-feature, and turning Headings off leaves Breadcrumb Nav alone", () => {
	const features = resolveFeatures({ headings: false, breadcrumbs: true });
	assert.equal("headings.breadcrumbs" in features, false);
	assert.equal(features.breadcrumbs, true);
});

test("replaces: the first legacy id present decides; unknown legacy parents don't block", () => {
	registerFeatures([{ id: "zzNew", label: "New", description: "", default: false, replaces: ["zzOld.a", "zzOld.b"] }]);
	assert.equal(resolveFeatures({ "zzOld.b": true }).zzNew, true);
	assert.equal(resolveFeatures({ "zzOld.a": false, "zzOld.b": true }).zzNew, false);
	assert.equal(resolveFeatures({ zzOld: false, "zzOld.b": true }).zzNew, false);
	assert.equal(legacyChoice({ other: true }, { id: "x", label: "", description: "", replaces: ["y"] }), undefined);
	assert.equal(legacyChoice({ y: true }, { id: "x", label: "", description: "" }), undefined);
});

// ── Settings migration ───────────────────────────────────────────

const LEGACY = { prefix: "jump-", toc: {}, breadcrumbs: { separator: "chevron", customSeparator: "", homeLabel: "Start", showHome: true, showCurrent: false } };

test("settings fall back to the Headings sub-object until Breadcrumb Nav saves its own", () => {
	assert.deepEqual(resolveSettings(null, LEGACY), { separator: "chevron", customSeparator: "", homeLabel: "Start", showHome: true, showCurrent: false });
	assert.deepEqual(resolveSettings({ separator: "arrow" }, LEGACY), { ...DEFAULT_SETTINGS, separator: "arrow" });
	assert.deepEqual(resolveSettings(null, null), DEFAULT_SETTINGS);
	assert.deepEqual(resolveSettings(null, { prefix: "x-" }), DEFAULT_SETTINGS);
});

test("ctxBreadcrumbsSettings reads the new key, then the legacy one", async () => {
	assert.equal((await ctxBreadcrumbsSettings(fakeCtx({ headings: LEGACY }))).homeLabel, "Start");
	assert.equal((await ctxBreadcrumbsSettings(fakeCtx({ headings: LEGACY, breadcrumbs: { homeLabel: "Top" } }))).homeLabel, "Top");
	assert.deepEqual(await ctxBreadcrumbsSettings(fakeCtx({})), DEFAULT_SETTINGS);
});

test("settings routes read migrated values and save to the new key", async () => {
	const { routes } = breadcrumbsPack({});
	const ctx = fakeCtx({ headings: LEGACY });
	assert.equal((await routes["breadcrumbs/settings"].handler(ctx)).settings.separator, "chevron");
	const save = routes["breadcrumbs/settings/save"];
	const saved = await save.handler({ ...ctx, input: { settings: { separator: "bullet", homeLabel: "<b>Start</b>", customSeparator: "123456789" } } });
	assert.equal(saved.settings.separator, "bullet");
	assert.equal(saved.settings.homeLabel, "bStart/b");
	assert.equal(saved.settings.customSeparator, "12345678");
	assert.deepEqual(ctx.store.get("breadcrumbs"), saved.settings);
	assert.deepEqual(ctx.store.get("headings"), LEGACY, "the legacy setting is left untouched");
});

test("normalizeSettings clamps", () => {
	assert.equal(normalizeSettings({ separator: "nope" }).separator, "slash");
	assert.equal(normalizeSettings({ homeLabel: "  " }).homeLabel, "Home");
	assert.equal(normalizeSettings({ showHome: "no" }).showHome, true);
	assert.deepEqual(normalizeSettings([]), DEFAULT_SETTINGS);
});

// ── Stamping ─────────────────────────────────────────────────────

test("stampBreadcrumbs stamps the title into Breadcrumbs blocks only, idempotently", () => {
	const content = { title: " My Post ", body: [{ _type: "coywolf-breadcrumbs", _key: "b" }, { _type: "coywolf-toc", _key: "t" }], other: "x" };
	const out = stampBreadcrumbs(content);
	assert.equal(out.body[0]._title, "My Post");
	assert.equal(out.body[1]._title, undefined);
	assert.equal(out.other, "x");
	assert.equal(content.body[0]._title, undefined, "input untouched");
	assert.equal(stampBreadcrumbs(out), null);
	assert.equal(stampBreadcrumbs({ body: [{ _type: "coywolf-breadcrumbs" }] }), null, "no title, nothing to stamp");
});

test("Breadcrumbs blocks are stamped with Headings & TOC off", async () => {
	const { hooks } = composeHooks([headingsPack({}), breadcrumbsPack({})], { tasks: [] });
	const content = { title: "Overnight oats", body: [{ _type: "coywolf-breadcrumbs", _key: "b" }, { _type: "block", _key: "h", style: "h2", children: [{ _type: "span", text: "Intro" }], markDefs: [] }] };
	const event = { content, collection: "posts", isNew: true };

	invalidateFeatures();
	const out = await hooks["content:beforeSave"](event, fakeCtx({ features: { headings: false, breadcrumbs: true } }));
	assert.equal(out.body[0]._title, "Overnight oats");
	assert.equal(out.body[1].anchor, undefined, "headings stays off");

	invalidateFeatures();
	assert.equal(await hooks["content:beforeSave"](event, fakeCtx({ features: { headings: true, "headings.anchors": true, breadcrumbs: false } })).then((r) => r?.body[0]._title), undefined);

	invalidateFeatures();
	const both = await hooks["content:beforeSave"](event, fakeCtx({ features: { headings: true, "headings.anchors": true, breadcrumbs: true } }));
	assert.equal(both.body[0]._title, "Overnight oats");
	assert.equal(both.body[1].anchor, "jump-intro");

	invalidateFeatures();
	const legacy = await hooks["content:beforeSave"](event, fakeCtx({ features: { headings: true, "headings.breadcrumbs": true } }));
	assert.equal(legacy.body[0]._title, "Overnight oats", "legacy switch still stamps");
	invalidateFeatures();
});

test("page:metadata captures the theme trail when Breadcrumb Nav is on", async () => {
	const { hooks } = composeHooks([headingsPack({}), breadcrumbsPack({})], { tasks: [] });
	invalidateFeatures();
	await hooks["page:metadata"]({ page: { url: "https://ex.com/off/", pageTitle: "Off" } }, fakeCtx({ features: {} }));
	assert.equal(capturedPage("/off/"), null);
	invalidateFeatures();
	const out = await hooks["page:metadata"]({ page: { url: "https://ex.com/on/", pageTitle: "On", breadcrumbs: [{ name: "Home", url: "/" }] } }, fakeCtx({ features: { breadcrumbs: true } }));
	assert.deepEqual(out, []);
	assert.equal(capturedPage("/on/")?.title, "On");
	invalidateFeatures();
});

// ── Trails ───────────────────────────────────────────────────────

test("breadcrumb trails", () => {
	const base = { homeLabel: "Home", showHome: true, showCurrent: true };
	assert.deepEqual(resolveTrail({ ...base, path: "/guides/getting-started/", title: "Getting Started with EmDash" }), [
		{ name: "Home", url: "/" },
		{ name: "Guides", url: "/guides/" },
		{ name: "Getting Started with EmDash", url: "/guides/getting-started/" },
	]);
	assert.deepEqual(resolveTrail({ ...base, path: "/" }), []);
	assert.deepEqual(resolveTrail({ ...base, path: "/about", showCurrent: false }), []);
	assert.deepEqual(
		resolveTrail({ ...base, path: "/blog/post", items: [{ name: "Blog", url: "/blog" }, { name: "Post", url: "/blog/post" }] }).map((c) => c.name),
		["Home", "Blog", "Post"],
	);
	assert.deepEqual(resolveTrail({ ...base, path: "/x", items: [] }), []);
	assert.deepEqual(
		resolveTrail({ ...base, path: "/a/b", showHome: false, showCurrent: false, items: [{ name: "H", url: "https://ex.com/" }, { name: "A", url: "/a" }, { name: "B", url: "/a/b" }] }).map((c) => c.name),
		[],
	);
	assert.equal(humanize("getting-started_now"), "Getting started now");
	assert.equal(humanize("caf%C3%A9"), "Café");
});

test("captured trails belong to their request: an edit-mode render can't hand its draft title to a public render of the same URL", async () => {
	const { AsyncLocalStorage } = await import("node:async_hooks");
	const als = new AsyncLocalStorage();
	const key = Symbol.for("emdash:request-context");
	const before = globalThis[key];
	globalThis[key] = als;
	try {
		let release;
		const gate = new Promise((r) => (release = r));
		// The public render captures, then (while its body is still rendering) an editor's render of the same URL captures its draft.
		const publicRender = als.run({}, async () => {
			capturePage({ url: "https://ex.com/same/", pageTitle: "Published title" });
			await gate;
			return capturedPage("/same/")?.title;
		});
		const editorRender = als.run({}, async () => {
			capturePage({ url: "https://ex.com/same/", pageTitle: "Draft title" });
			return capturedPage("/same/")?.title;
		});
		assert.equal(await editorRender, "Draft title");
		release();
		assert.equal(await publicRender, "Published title", "the public page keeps its own title");
		assert.equal(await als.run({}, async () => capturedPage("/same/")), null, "another request sees nothing captured");
	} finally {
		globalThis[key] = before;
	}
});

test("captured theme trails are keyed by URL path and query", () => {
	capturePage({ url: "https://ex.com/fr/guide/?v=2", breadcrumbs: [{ name: "Accueil", url: "/fr/" }], pageTitle: "Guide" });
	assert.equal(capturedPage("/fr/guide?v=2")?.title, "Guide");
	assert.equal(capturedPage("/fr/guide"), null);
	assert.equal(capturedPage("/guide/?v=2"), null);
});

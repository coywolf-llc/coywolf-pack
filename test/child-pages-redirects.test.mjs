// Run: node --test test/child-pages-redirects.test.mjs
//
// Child Pages' 301s (src/childPages/pack.ts with src/redirects/slug-changes.ts applyUrlMoves): the
// pages below a page that moved, pages whose parent stops or starts counting, the switch turned off
// and on, the per-change cap, rules someone else made; the import's dry run; and the publish guard
// that refuses a loop, through the pack's composed hooks.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Workers Cache's purge, as cloudflare:workers exposes it (no Worker here).
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const cache = { purge: async () => ({ success: true }) }; export const env = {};", shortCircuit: true };
		return next(specifier, context);
	},
});

const { configureContentUrls } = await import("../src/core/content-url.ts");
const { applyUrlMoves } = await import("../src/redirects/slug-changes.ts");
const { settleCollection, settleSwitch, importPlan, stagedParent, MAX_MOVES } = await import("../src/childPages/pack.ts");
const read = await import("../src/childPages/read.ts");
const { composeHooks } = await import("../src/core/compose.ts");

function fakeD1(extra = "") {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE _emdash_collections (id TEXT, slug TEXT, label TEXT, label_singular TEXT, url_pattern TEXT, title_field TEXT, routable INTEGER DEFAULT 1);
		CREATE TABLE _emdash_fields (id TEXT, collection_id TEXT, slug TEXT, type TEXT, validation TEXT);
		CREATE TABLE _emdash_relations (id TEXT, slug TEXT);
		CREATE TABLE _emdash_content_references (id TEXT, relation_id TEXT, parent_group TEXT, child_group TEXT);
		CREATE TABLE ec_pages (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT, draft_revision_id TEXT, live_revision_id TEXT);
		CREATE TABLE revisions (id TEXT PRIMARY KEY, data TEXT);
		INSERT INTO _emdash_collections VALUES ('c1','pages','Pages','Page','/{slug}/','title',1);
		INSERT INTO _emdash_fields VALUES ('f1','c1','parent_page','reference','{"targetCollection":"pages","relation":"pages_parent_page","relationSide":"parent"}');
		INSERT INTO _emdash_relations VALUES ('r1','pages_parent_page');
	`);
	if (extra) db.exec(extra);
	const statement = (q, params = []) => ({
		bind: (...p) => statement(q, p),
		all: async () => ({ results: /^\s*(SELECT|WITH)/i.test(q) ? db.prepare(q).all(...params) : (db.prepare(q).run(...params), []) }),
		first: async () => db.prepare(q).get(...params) ?? null,
		run: async () => ({ success: true, meta: { changes: Number(db.prepare(q).run(...params).changes) } }),
	});
	return {
		raw: db,
		prepare: (q) => statement(q),
		batch: async (statements) => {
			const out = [];
			for (const s of statements) out.push(await s.all());
			return out;
		},
	};
}

/** A plugin context with what the module uses: kv, settings, storage (Slug changes' remembered URLs), log. */
function fakeCtx() {
	const kv = new Map();
	const settings = new Map();
	const remembered = new Map();
	const logs = [];
	return {
		kv: {
			get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
			set: async (k, v) => void kv.set(k, structuredClone(v)),
			delete: async (k) => kv.delete(k),
			list: async () => [...kv.keys()].map((key) => ({ key })),
		},
		settings: { get: async (k) => settings.get(k) ?? null, set: async (k, v) => void settings.set(k, v) },
		storage: { redirects_urls: { get: async (id) => remembered.get(id) ?? null, put: async (id, d) => void remembered.set(id, d), putMany: async (items) => items.forEach((i) => remembered.set(i.id, i.data)) } },
		log: { info: () => {}, warn: (m, d) => logs.push([m, d]), error: (m, d) => logs.push([m, d]) },
		state: { kv, settings, remembered, logs },
	};
}

/** The newest change kept for the Child Pages page. */
const lastChange = (ctx) => ctx.state.kv.get("state:childPages:status")?.changes[0];
const ON = { redirects: true, "redirects.slugChanges": true, childPages: true };
const rules = (d1) =>
	d1.raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'coywolf_redirects'").get().n
		? d1.raw.prepare("SELECT source, target, note FROM coywolf_redirects ORDER BY source").all().map((r) => [r.source, r.target])
		: [];
const page = (id, slug, status = "published", title = slug) => `INSERT INTO ec_pages VALUES ('${id}','${slug}','${status}','2024-01-01 00:00:00','en','${id}',NULL,'${title}',NULL,NULL);`;
const parent = (child, of) => `INSERT INTO _emdash_content_references VALUES ('e-${child}','r1','${child}','${of}');`;

test("applyUrlMoves: one 301 a page, chains retargeted, our rule at the new URL removed, someone else's kept and reported", async () => {
	const d1 = fakeD1();
	const ctx = fakeCtx();
	const { ensureTable, saveRule } = await import("../src/redirects/rules.ts");
	await ensureTable(d1);
	await saveRule(d1, { source: "/old-apps/pack", target: "/apps/pack/", note: "Slug change: Pack" }); // an earlier move: retargeted
	await saveRule(d1, { source: "/tools/pack", target: "/pack/", note: "Slug change: Pack" }); // ours, from the new URL: removed
	await saveRule(d1, { source: "/docs", target: "/elsewhere/", note: "Added by hand" }); // someone else's, at a new URL: kept, reported
	const out = await applyUrlMoves(ctx, d1, [
		{ collection: "pages", entryId: "p", title: "Pack", from: "/apps/pack/", to: "/tools/pack/" },
		{ collection: "pages", entryId: "d", title: "Docs", from: "/apps/pack/docs/", to: "/docs/" },
		{ collection: "pages", entryId: "x", title: "Same", from: "/same/", to: "/same" },
	]);
	assert.deepEqual(out, { written: 2, kept: 0, shadowed: [{ url: "/docs/", rule: { source: "/docs", target: "/elsewhere/" } }], loops: [] });
	assert.deepEqual(rules(d1), [
		["/apps/pack", "/tools/pack/"],
		["/apps/pack/docs", "/docs/"],
		["/docs", "/elsewhere/"],
		["/old-apps/pack", "/tools/pack/"],
	]);
	assert.deepEqual(ctx.state.remembered.get("pages:p")?.url, "/tools/pack/", "Slug changes won't see a move on the next save");
	assert.equal(ctx.state.remembered.has("pages:x"), false, "no change, nothing remembered");
});

const SITE = [page("a", "apps", "published", "Coywolf apps"), page("p", "coywolf-pack", "published", "Coywolf Pack"), page("d", "docs"), page("x", "about"), parent("p", "a"), parent("d", "p")].join("\n");

test("settleCollection: the first change only records; a parent's rename moves the pages below it; an unpublished parent makes them top level, and back", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(SITE);
	const ctx = fakeCtx();
	try {
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was published");
		assert.deepEqual(rules(d1), [], "no snapshot yet: nothing to compare");
		assert.deepEqual(ctx.state.kv.get("state:childPages:paths:pages").paths, { p: "/apps/coywolf-pack/", d: "/apps/coywolf-pack/docs/" });

		d1.raw.exec("UPDATE ec_pages SET slug = 'tools' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was published");
		assert.deepEqual(rules(d1), [
			["/apps/coywolf-pack", "/tools/coywolf-pack/"],
			["/apps/coywolf-pack/docs", "/tools/coywolf-pack/docs/"],
		], "the renamed page itself is Slug changes' (excluded here)");
		assert.equal(lastChange(ctx).moved, 2);

		d1.raw.exec("UPDATE ec_pages SET status = 'draft' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was unpublished");
		assert.deepEqual(rules(d1).filter(([s]) => s.startsWith("/tools")), [
			["/tools/coywolf-pack", "/coywolf-pack/"],
			["/tools/coywolf-pack/docs", "/coywolf-pack/docs/"],
		]);
		assert.deepEqual(rules(d1).find(([s]) => s === "/apps/coywolf-pack"), ["/apps/coywolf-pack", "/coywolf-pack/"], "the older rule follows (no chain)");

		d1.raw.exec("UPDATE ec_pages SET status = 'published' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was published");
		assert.equal(rules(d1).some(([s]) => s === "/tools/coywolf-pack"), false, "the live URL is freed");
		assert.deepEqual(rules(d1).find(([s]) => s === "/coywolf-pack"), ["/coywolf-pack", "/tools/coywolf-pack/"]);
	} finally {
		configureContentUrls({});
	}
});

test("settleCollection: Redirect Manager or Slug changes off: nothing written, the snapshot still kept", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(SITE);
	const ctx = fakeCtx();
	try {
		await settleCollection(ctx, d1, ON, "pages", null, "x");
		d1.raw.exec("UPDATE ec_pages SET slug = 'tools' WHERE id = 'a'");
		await settleCollection(ctx, d1, { ...ON, "redirects.slugChanges": false }, "pages", "a", "x");
		assert.equal(d1.raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'coywolf_redirects'").get().n, 0);
		assert.equal(lastChange(ctx).redirectsOff, true);
		assert.equal(ctx.state.kv.get("state:childPages:paths:pages").paths.p, "/tools/coywolf-pack/");
	} finally {
		configureContentUrls({});
	}
});

test(`settleCollection: at most ${MAX_MOVES} redirects for one change, the rest reported`, async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const children = Array.from({ length: MAX_MOVES + 5 }, (_, i) => `${page(`c${i}`, `child-${i}`)}\n${parent(`c${i}`, "a")}`).join("\n");
	const d1 = fakeD1(`${page("a", "apps")}\n${children}`);
	const ctx = fakeCtx();
	try {
		await settleCollection(ctx, d1, ON, "pages", null, "x");
		d1.raw.exec("UPDATE ec_pages SET slug = 'tools' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was published");
		const status = lastChange(ctx);
		assert.deepEqual([status.moved, status.written, status.skipped], [MAX_MOVES + 5, MAX_MOVES, 5]);
		assert.equal(rules(d1).length, MAX_MOVES);
		assert.equal(status.skippedUrls.length, 5, "the URLs still without a redirect, not just how many");
	} finally {
		configureContentUrls({});
	}
});

test("settleSwitch: off redirects nested URLs to the option's (or flat) ones; on reverses it and starts the snapshot", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" }, pageParents: { docs: "about" } });
	const d1 = fakeD1(SITE);
	const ctx = fakeCtx();
	try {
		await settleSwitch(ctx, d1, { ...ON, childPages: false }, false);
		assert.deepEqual(rules(d1), [
			["/apps/coywolf-pack", "/coywolf-pack/"],
			["/apps/coywolf-pack/docs", "/about/docs/"],
		]);
		assert.equal(ctx.state.kv.has("state:childPages:paths:pages"), false);
		assert.ok(ctx.state.settings.get("childPagesVersion"), "the URL version moved");
		await settleSwitch(ctx, d1, ON, true);
		assert.deepEqual(rules(d1), [
			["/about/docs", "/apps/coywolf-pack/docs/"],
			["/coywolf-pack", "/apps/coywolf-pack/"],
		]);
		assert.deepEqual(ctx.state.kv.get("state:childPages:paths:pages").paths, { p: "/apps/coywolf-pack/", d: "/apps/coywolf-pack/docs/" });
	} finally {
		configureContentUrls({});
	}
});

test("import dry run: set, already set, other parent, unpublished changes, a parent that isn't a page, no page, and loops (one across rows)", async () => {
	configureContentUrls({
		urls: { pages: "/{pagepath}/" },
		pageParents: { "coywolf-pack": "docs", docs: "coywolf-pack", about: "apps", huzzah: "newsletter", gone: "apps", edited: "apps", other: "about", "q-one": "q-two", "q-two": "q-one" },
	});
	const d1 = fakeD1(
		[page("a", "apps"), page("p", "coywolf-pack"), page("d", "docs"), page("x", "about"), page("h", "huzzah"), page("o", "other"), parent("o", "a"), page("e", "edited"), parent("d", "p"), page("q1", "q-one"), page("q2", "q-two")].join("\n") +
			"\nUPDATE ec_pages SET draft_revision_id = 'r2', live_revision_id = 'r1' WHERE id = 'e';",
	);
	try {
		const ct = await read.collectionTree(d1, "pages", { on: true });
		const rows = Object.fromEntries((await importPlan(d1, ct)).map((r) => [r.slug, r]));
		assert.deepEqual([rows.about.action, rows.about.url, rows.about.urlAfter], ["set", "/apps/about/", "/apps/about/"], "the option already nested it: same URL");
		assert.deepEqual([rows.about.entryId, rows.about.parentId], ["x", "a"]);
		assert.equal(rows.docs.action, "done");
		assert.deepEqual([rows["coywolf-pack"].action, rows["coywolf-pack"].reason], ["skip", "loop"], "docs is already under coywolf-pack");
		assert.deepEqual([rows.huzzah.action, rows.huzzah.reason], ["keep", "parentNotPage"]);
		assert.deepEqual([rows.gone.action, rows.gone.reason], ["skip", "noPage"]);
		assert.deepEqual([rows.edited.action, rows.edited.reason], ["skip", "pendingChanges"]);
		assert.deepEqual([rows.other.action, rows.other.reason], ["skip", "otherParent"]);
		assert.equal(rows["q-one"].action, "set");
		assert.deepEqual([rows["q-two"].action, rows["q-two"].reason], ["skip", "loop"], "q-one is set under q-two by this same import");
	} finally {
		configureContentUrls({});
	}
});

test("the publish guard: a staged parent that makes a loop is refused through the composed hooks; anything else, or a failure, lets the publish go", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(`${SITE}\nINSERT INTO revisions VALUES ('r-loop', '{"title":"Coywolf apps","_references":{"parent_page":["d"]}}'), ('r-ok', '{"_references":{"parent_page":["x"]}}'), ('r-none', '{"title":"x"}');`);
	const { childPagesPack } = await import("../src/childPages/pack.ts");
	const module = childPagesPack();
	const { configureStoredParents } = await import("../src/core/content-url.ts");
	configureStoredParents(null); // The pack installs its provider; these tests don't need it.
	// The guard reads the site's database through the DB binding: stand one in.
	const shared = await import("../src/shared.ts");
	const env = await shared.workerEnv().catch(() => null);
	if (env) env.DB = d1;
	const { hooks } = composeHooks([module], { tasks: [] });
	const policy = hooks["content:beforePublish"];
	assert.equal(policy.errorPolicy, "continue", "the pack's own failure never blocks a publish");
	const ctx = { ...fakeCtx(), settings: { get: async (k) => (k === "features" ? { childPages: true, _defaults036: true } : null), set: async () => {} } };
	const event = (draftRevisionId) => ({ collection: "pages", content: { id: "a", translationGroup: "a", draftRevisionId, data: { title: "Coywolf apps" } }, origin: { source: "api" } });
	try {
		assert.equal(await stagedParent(d1, "r-loop"), "d");
		assert.equal(await stagedParent(d1, "r-none"), undefined);
		const refused = await policy.handler(event("r-loop"), ctx);
		assert.equal(refused?.cancel, true);
		assert.match(refused.reason, /under itself \(Coywolf apps › Coywolf Pack › docs › Coywolf apps\)/);
		assert.equal(await policy.handler(event("r-ok"), ctx), undefined);
		assert.equal(await policy.handler(event(null), ctx), undefined, "nothing staged");
		if (env) env.DB = { prepare() { throw new Error("D1 down"); } };
		assert.equal(await policy.handler(event("r-loop"), ctx), undefined, "a failure reads as no decision");
	} finally {
		configureContentUrls({});
	}
});

// Run: node --test test/child-pages-review.test.mjs
//
// Child Pages under failure and through the pack's real hooks (src/childPages/pack.ts composed by
// src/core/compose.ts, with Redirect Manager's Slug changes after it): reads that fail never give flat
// URLs, redirects that would loop with a rule someone else made, the per-change cap draining, translations,
// cache purges, a missing snapshot, Re-check, the publish guard's message, and a slug-only save.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Workers Cache's purge, as cloudflare:workers exposes it (no Worker here): every purge is kept for the tests to read.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: "data:text/javascript,export const cache = { purge: async (scope) => { (globalThis.__cwPurges ??= []).push(scope); return { success: true }; } }; export const env = {};", shortCircuit: true };
		}
		return next(specifier, context);
	},
});
const purges = () => (globalThis.__cwPurges ??= []);

const cu = await import("../src/core/content-url.ts");
const { configureContentUrls, configureStoredParents, createEntryUrlResolver, entryUrl, matchEntryPath, currentChildPagesState, ParentPagesUnreadable } = cu;
const read = await import("../src/childPages/read.ts");
const pack = await import("../src/childPages/pack.ts"); // Registers the childPages switch too.
const { readFailures } = await import("../src/core/read-failures.ts");
const { invalidateFeatures } = await import("../src/core/features.ts");
const { slugChangesModule } = await import("../src/redirects/slug-changes.ts");
const shared = await import("../src/shared.ts");
const env = await shared.workerEnv();

/** A D1 stand-in on SQLite. `fail(sql)` makes a statement fail like a D1 blip; `counts` tallies the work. */
function fakeD1(extra = "", opts = {}) {
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
	const counts = { roundTrips: 0, statements: 0 };
	const isRead = (q) => /^\s*(SELECT|WITH)/i.test(q);
	const exec = (q, params) => {
		counts.statements++;
		if (opts.fail?.(q)) throw new Error("D1_ERROR: transient");
		return isRead(q) ? { results: db.prepare(q).all(...params) } : { results: [], success: true, meta: { changes: Number(db.prepare(q).run(...params).changes) } };
	};
	const statement = (q, params = []) => ({
		q,
		params,
		bind: (...p) => statement(q, p),
		all: async () => (counts.roundTrips++, exec(q, params)),
		first: async () => (counts.roundTrips++, exec(q, params).results[0] ?? null),
		run: async () => (counts.roundTrips++, exec(q, params)),
	});
	return {
		raw: db,
		counts,
		prepare: (q) => statement(q),
		batch: async (statements) => {
			counts.roundTrips++;
			return statements.map((s) => exec(s.q, s.params));
		},
	};
}

/** A plugin context with what the modules use: kv, settings (the switches included), storage, log. */
function fakeCtx(features = { childPages: true, redirects: true, "redirects.slugChanges": true }) {
	const kv = new Map();
	const settings = new Map([["features", { _defaults036: true, ...features }]]);
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
		log: { info: () => {}, warn: (m, d) => logs.push(["warn", m, d]), error: (m, d) => logs.push(["error", m, d]) },
		state: { kv, settings, remembered, logs },
	};
}

const ON = { redirects: true, "redirects.slugChanges": true, childPages: true };
const rules = (d1) =>
	d1.raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'coywolf_redirects'").get().n
		? d1.raw.prepare("SELECT source, target FROM coywolf_redirects ORDER BY source").all().map((r) => [r.source, r.target])
		: [];
const page = (id, slug, status = "published", title = slug, locale = "en", group = id) =>
	`INSERT INTO ec_pages VALUES ('${id}','${slug}','${status}','2024-01-01 00:00:00','${locale}','${group}',NULL,'${title.replace(/'/g, "''")}',NULL,NULL);`;
const parent = (child, of) => `INSERT INTO _emdash_content_references VALUES ('e-${child}','r1','${child}','${of}');`;
const SITE = [page("a", "apps", "published", "Coywolf apps"), page("p", "coywolf-pack", "published", "Coywolf Pack"), page("d", "docs"), page("x", "about"), parent("p", "a"), parent("d", "p")].join("\n");
const TREE_READ = /_emdash_content_references|FROM "ec_pages" WHERE deleted_at IS NULL/;
const quiet = async (run) => {
	const error = console.error;
	console.error = () => {};
	try {
		return await run();
	} finally {
		console.error = error;
	}
};

// ── Reads that fail (first: the "unknown switch" case needs an isolate that has never read the switches) ──

test("the switch can't be read and was never read: the provider rejects (never 'off'); once it has been read, the last read decides", async () => {
	const d1 = fakeD1(SITE);
	const provider = read.childPagesProvider({ database: async () => d1 });
	env.DB = { prepare: () => { throw new Error("D1 down"); }, batch: async () => { throw new Error("D1 down"); } };
	invalidateFeatures();
	try {
		await quiet(() => assert.rejects(provider.collections(d1), /feature switches couldn't be read/));
		// A read that works (no stored switches: Child Pages is off by default)…
		env.DB = d1;
		invalidateFeatures();
		assert.equal((await provider.collections(d1)).size, 0);
		// …then one that fails: this isolate's last read stands in.
		env.DB = { prepare: () => { throw new Error("D1 down"); }, batch: async () => { throw new Error("D1 down"); } };
		invalidateFeatures();
		assert.equal((await quiet(() => provider.collections(d1))).size, 0);
	} finally {
		delete env.DB;
		invalidateFeatures();
	}
});

test("a tree read that fails: Slug changes skips its settle (no 301 from the live nested page to its flat URL)", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	let failing = false;
	const d1 = fakeD1(SITE, { fail: (q) => failing && TREE_READ.test(q) });
	env.DB = d1;
	configureStoredParents(read.childPagesProvider({ enabled: async () => true }));
	const ctx = fakeCtx();
	const slugChanges = slugChangesModule({});
	const content = { id: "p", slug: "coywolf-pack", status: "published", locale: "en", data: { title: "Coywolf Pack" } };
	try {
		await slugChanges.hooks["content:afterPublish"]({ content, collection: "pages" }, ctx);
		assert.equal(ctx.state.remembered.get("pages:p").url, "/apps/coywolf-pack/");
		failing = true;
		read.invalidatePageTrees();
		const before = readFailures();
		await quiet(() => slugChanges.hooks["content:afterPublish"]({ content, collection: "pages" }, ctx));
		await quiet(() => slugChanges.hooks["content:afterSave"]({ content, collection: "pages" }, ctx));
		assert.deepEqual(rules(d1), [], "no rule from /apps/coywolf-pack to /coywolf-pack/");
		assert.equal(ctx.state.remembered.get("pages:p").url, "/apps/coywolf-pack/", "the remembered URL is left as it was");
		assert.ok(readFailures() > before, "noted: a page rendered meanwhile isn't edge-cached");
		// The read works again: the page is where it was, and nothing is written.
		failing = false;
		read.invalidatePageTrees();
		await slugChanges.hooks["content:afterPublish"]({ content, collection: "pages" }, ctx);
		assert.deepEqual(rules(d1), []);
	} finally {
		configureStoredParents(null);
		configureContentUrls({});
		delete env.DB;
	}
});

test("a tree read that fails while rendering: URLs, path matches, the theme's tree and the search state reject, and the failure is noted", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	let failing = false;
	const d1 = fakeD1(SITE, { fail: (q) => failing && TREE_READ.test(q) });
	configureStoredParents(read.childPagesProvider({ enabled: async () => true, database: async () => d1 }));
	const entries = [{ id: "p", slug: "coywolf-pack" }, { id: "x", slug: "about" }];
	try {
		assert.equal((await createEntryUrlResolver(d1).urls("pages", entries)).get("p"), "/apps/coywolf-pack/");
		failing = true;
		read.invalidatePageTrees();
		const before = readFailures();
		await quiet(async () => {
			// What the sitemaps, feeds, llms.txt and schema build their URLs with.
			await assert.rejects(createEntryUrlResolver(d1).urls("pages", entries), ParentPagesUnreadable);
			await assert.rejects(entryUrl(d1, "pages", entries[0]), ParentPagesUnreadable);
			await assert.rejects(currentChildPagesState(d1), ParentPagesUnreadable);
			// loadPageTree (a theme's catch-all route) and the breadcrumb titles.
			await assert.rejects(read.collectionTree(d1, "pages", { on: true }), /transient/);
		});
		// The breadcrumb titles (the switch read from the site's options, on): rejects, so the trail's caller falls back, and noted.
		d1.raw.prepare("INSERT INTO options VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify({ _defaults036: true, childPages: true }));
		env.DB = d1;
		invalidateFeatures();
		const titlesBefore = readFailures();
		await quiet(() => assert.rejects(read.pageTitlesByPath(d1), /transient/));
		assert.ok(readFailures() > titlesBefore);
		assert.ok(readFailures() >= before + 3, "each failure is noted (src/core/read-failures.ts): the page isn't edge-cached");
		// The collections with a field can't be read either: a nested page must not match at its flat path.
		configureContentUrls({});
		failing = false;
		assert.equal(await matchEntryPath(d1, "/docs/"), null);
		configureStoredParents({ collections: async () => { throw new Error("D1 down"); }, parents: async () => null, fingerprint: () => "" });
		await quiet(() => assert.rejects(matchEntryPath(d1, "/docs/"), ParentPagesUnreadable));
		await quiet(() => assert.rejects(entryUrl(d1, "pages", entries[0]), ParentPagesUnreadable));
	} finally {
		configureStoredParents(null);
		configureContentUrls({});
		delete env.DB;
		invalidateFeatures();
	}
});

test("a collection without a title column still reads (slugs stand in); any other failure isn't mistaken for it", async () => {
	const d1 = fakeD1(SITE);
	d1.raw.exec("ALTER TABLE ec_pages DROP COLUMN title");
	read.invalidatePageTrees();
	const meta = (await read.readMeta(d1)).find((m) => m.collection === "pages");
	const tree = await read.readTree(d1, meta, true);
	assert.equal(tree.nodes.get("p").title, null);
	assert.equal(tree.nodes.get("p").effectiveParentId, "a");
});

// ── Redirects ──

const { applyUrlMoves, loopingRule } = await import("../src/redirects/slug-changes.ts");
const { ensureTable, saveRule } = await import("../src/redirects/rules.ts");
const { settleCollection, settleSwitch, recheckCollection, movedPagesPurges, offNotice, readStatus, childPagesPack, MAX_MOVES, MAX_CHANGES } = pack;
const status = (ctx) => ctx.state.kv.get("state:childPages:status") ?? { changes: [], open: {} };
const snapshot = (ctx, collection = "pages") => ctx.state.kv.get(`state:childPages:paths:${collection}`);
const byHand = (d1, source, target, extra = {}) => saveRule(d1, { source, target, note: "WordPress move", ...extra });

test("applyUrlMoves: a rule someone else made that sends the new URL back to the old one (at once, or through other rules) is a loop: nothing written, the rule named", async () => {
	const d1 = fakeD1();
	const ctx = fakeCtx();
	await ensureTable(d1);
	await byHand(d1, "/coywolf-seo", "/apps/coywolf-seo/"); // coywolf.com's, from the WordPress move
	await byHand(d1, "/pack", "/middle/?utm=1");
	await byHand(d1, "/middle", "/apps/pack/"); // /pack → /middle → /apps/pack
	await byHand(d1, "/off", "/apps/off/", { enabled: false }); // disabled: answers nothing
	await saveRule(d1, { source: "/ours", target: "/apps/ours/", note: "Slug change: Ours" }); // ours at the new URL: removed, not a loop
	await byHand(d1, "/away", "https://example.com/apps/away/"); // leaves the site: shadowed, not a loop
	const move = (id, slug) => ({ collection: "pages", entryId: id, title: slug, from: `/apps/${slug}/`, to: `/${slug}/` });
	const out = await applyUrlMoves(ctx, d1, [move("s", "coywolf-seo"), move("p", "pack"), move("o", "off"), move("u", "ours"), move("w", "away")]);
	assert.deepEqual(out.loops.map((l) => [l.entryId, l.from, l.to, l.rule]), [
		["s", "/apps/coywolf-seo/", "/coywolf-seo/", { source: "/coywolf-seo", target: "/apps/coywolf-seo/" }],
		["p", "/apps/pack/", "/pack/", { source: "/pack", target: "/middle/?utm=1" }],
	]);
	assert.deepEqual(out.shadowed, [{ url: "/away/", rule: { source: "/away", target: "https://example.com/apps/away/" } }]);
	assert.equal(out.written, 3);
	assert.deepEqual(rules(d1), [
		["/apps/away", "/away/"],
		["/apps/off", "/off/"],
		["/apps/ours", "/ours/"],
		["/away", "https://example.com/apps/away/"],
		["/coywolf-seo", "/apps/coywolf-seo/"],
		["/middle", "/apps/pack/"],
		["/off", "/apps/off/"],
		["/pack", "/middle/?utm=1"],
	], "no /apps/coywolf-seo → /coywolf-seo/ and no /apps/pack → /pack/");
	assert.equal(ctx.state.remembered.get("pages:s").url, "/coywolf-seo/", "the page is at its new URL: Slug changes' next save sees no move");
	assert.ok(ctx.state.logs.some(([level, message]) => level === "warn" && /loop|sends the new URL back/.test(message)));
	assert.deepEqual(await loopingRule(d1, "/apps/coywolf-seo/", "/coywolf-seo/"), { source: "/coywolf-seo", target: "/apps/coywolf-seo/" });
	assert.equal(await loopingRule(d1, "/elsewhere/", "/coywolf-seo/"), null);
});

const SEO = [page("a", "apps", "published", "Coywolf apps"), page("s", "coywolf-seo", "published", "Coywolf SEO"), page("p", "coywolf-pack", "published", "Coywolf Pack"), parent("s", "a"), parent("p", "a")].join("\n");

test("turning the switch off with coywolf.com's hand-made rule: no loop is written, the Features page names the rule to delete, and Re-check adds the 301 once it's gone", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(SEO);
	const ctx = fakeCtx({ childPages: false, redirects: true, "redirects.slugChanges": true });
	const OFF = { ...ON, childPages: false };
	try {
		await ensureTable(d1);
		await byHand(d1, "/coywolf-seo", "/apps/coywolf-seo/");
		await settleSwitch(ctx, d1, OFF, false);
		assert.deepEqual(rules(d1), [
			["/apps/coywolf-pack", "/coywolf-pack/"],
			["/coywolf-seo", "/apps/coywolf-seo/"],
		]);
		const open = status(ctx).open.pages;
		assert.deepEqual(open.loops, [{ entryId: "s", title: "Coywolf SEO", from: "/apps/coywolf-seo/", to: "/coywolf-seo/", rule: { source: "/coywolf-seo", target: "/apps/coywolf-seo/" } }]);
		assert.deepEqual(status(ctx).changes[0].loops, open.loops);
		assert.deepEqual(snapshot(ctx), { paths: { s: "/apps/coywolf-seo/" }, at: snapshot(ctx).at, off: true }, "only the move that's still to make");
		// The Child Pages page is out of the sidebar while it's off: the Features page says it.
		const notice = await childPagesPack().featureNotice(ctx, OFF);
		configureStoredParents(null);
		assert.match(notice.text, /left 1 nested URL without a redirect/);
		assert.match(notice.items[0], /Delete the redirect \/coywolf-seo → \/apps\/coywolf-seo\/ on the Redirect Manager page/);
		assert.deepEqual(notice.action, { label: "Re-check redirects", route: "childPages/recheck" });
		assert.equal(await childPagesPack().featureNotice(ctx, ON), null, "on: the Child Pages page lists it instead");
		configureStoredParents(null);

		// Re-check with the rule still there: still a loop, still listed.
		await recheckCollection(ctx, d1, OFF, "pages");
		assert.equal(status(ctx).open.pages.loops.length, 1);
		assert.equal(rules(d1).some(([s]) => s === "/apps/coywolf-seo"), false);
		// The rule is deleted on Redirect Manager: Re-check makes the 301, and nothing is left.
		d1.raw.exec("DELETE FROM coywolf_redirects WHERE source = '/coywolf-seo'");
		await recheckCollection(ctx, d1, OFF, "pages");
		assert.deepEqual(rules(d1), [
			["/apps/coywolf-pack", "/coywolf-pack/"],
			["/apps/coywolf-seo", "/coywolf-seo/"],
		]);
		assert.equal(status(ctx).open.pages, undefined);
		assert.equal(snapshot(ctx), undefined);
		assert.equal(offNotice(await readStatus(ctx)), null);
	} finally {
		configureContentUrls({});
	}
});

test("unpublishing Apps with that rule: its children's loops are listed, their old URLs stay in the snapshot, and the next settle makes the 301 once the rule is gone", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(SEO);
	const ctx = fakeCtx();
	try {
		await ensureTable(d1);
		await byHand(d1, "/coywolf-seo", "/apps/coywolf-seo/");
		await settleCollection(ctx, d1, ON, "pages", null, "x");
		d1.raw.exec("UPDATE ec_pages SET status = 'draft' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was unpublished");
		assert.deepEqual(rules(d1), [
			["/apps/coywolf-pack", "/coywolf-pack/"],
			["/coywolf-seo", "/apps/coywolf-seo/"],
		]);
		assert.equal(status(ctx).open.pages.loops[0].rule.source, "/coywolf-seo");
		assert.equal(snapshot(ctx).paths.s, "/apps/coywolf-seo/", "the move is still to make");
		assert.equal(snapshot(ctx).paths.p, undefined);
		d1.raw.exec("DELETE FROM coywolf_redirects WHERE source = '/coywolf-seo'");
		await settleCollection(ctx, d1, ON, "pages", "x", "A page was published");
		assert.deepEqual(rules(d1).find(([s]) => s === "/apps/coywolf-seo"), ["/apps/coywolf-seo", "/coywolf-seo/"]);
		assert.equal(status(ctx).open.pages, undefined, "resolved: no longer listed");
	} finally {
		configureContentUrls({});
	}
});

test("a rule someone else made that sends a page's new URL elsewhere stays listed (with the rule) until it's gone", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(SEO);
	const ctx = fakeCtx();
	try {
		await ensureTable(d1);
		await byHand(d1, "/coywolf-seo", "/somewhere-else/");
		await settleCollection(ctx, d1, ON, "pages", null, "x");
		d1.raw.exec("UPDATE ec_pages SET status = 'draft' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was unpublished");
		assert.deepEqual(status(ctx).open.pages.shadowed, [{ url: "/coywolf-seo/", rule: { source: "/coywolf-seo", target: "/somewhere-else/" } }]);
		assert.equal(rules(d1).some(([s, t]) => s === "/apps/coywolf-seo" && t === "/coywolf-seo/"), true, "the 301 is written all the same");
		// Another change that moves nothing: still listed.
		await settleCollection(ctx, d1, ON, "pages", "x", "A page was published");
		assert.equal(status(ctx).open.pages.shadowed.length, 1);
		d1.raw.exec("DELETE FROM coywolf_redirects WHERE source = '/coywolf-seo'");
		await settleCollection(ctx, d1, ON, "pages", "x", "A page was published");
		assert.equal(status(ctx).open.pages, undefined);
	} finally {
		configureContentUrls({});
	}
});

test(`past ${MAX_MOVES} moves: a fixed order, the URLs that wait are listed, and the next settle (or Re-check) drains them`, async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const total = MAX_MOVES + 5;
	const pad = (i) => String(i).padStart(3, "0");
	// Inserted in reverse, so the order isn't the table's.
	const children = Array.from({ length: total }, (_, i) => total - 1 - i).map((i) => `${page(`c${pad(i)}`, `child-${pad(i)}`)}\n${parent(`c${pad(i)}`, "a")}`).join("\n");
	const d1 = fakeD1(`${page("a", "apps")}\n${children}`);
	const ctx = fakeCtx();
	const waiting = Array.from({ length: 5 }, (_, i) => `/apps/child-${pad(MAX_MOVES + i)}/`);
	try {
		await settleCollection(ctx, d1, ON, "pages", null, "x");
		d1.raw.exec("UPDATE ec_pages SET slug = 'tools' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was published");
		assert.equal(rules(d1).length, MAX_MOVES);
		const change = status(ctx).changes[0];
		assert.deepEqual([change.moved, change.written, change.skipped], [total, MAX_MOVES, 5]);
		assert.deepEqual(change.skippedUrls, waiting, "the last five by old URL, whatever order the rows come in");
		assert.deepEqual(status(ctx).open.pages.waiting.map((m) => m.from), waiting);
		assert.equal(status(ctx).open.pages.waitingCount, 5);
		for (const i of [MAX_MOVES, total - 1]) assert.equal(snapshot(ctx).paths[`c${pad(i)}`], `/apps/child-${pad(i)}/`, "the old URL stays in the snapshot");
		assert.equal(snapshot(ctx).paths.c000, "/tools/child-000/");

		// Any later change of the collection makes them.
		await settleCollection(ctx, d1, ON, "pages", "c000", "A page was published");
		assert.equal(rules(d1).length, total);
		assert.deepEqual(waiting.filter((from) => !rules(d1).some(([s]) => `${s}/` === from)), []);
		assert.equal(status(ctx).open.pages, undefined);
		assert.deepEqual([status(ctx).changes[0].moved, status(ctx).changes[0].written, status(ctx).changes[0].skipped], [5, 5, 0]);
		assert.equal(snapshot(ctx).paths[`c${pad(MAX_MOVES)}`], `/tools/child-${pad(MAX_MOVES)}/`);
	} finally {
		configureContentUrls({});
	}
});

test("the switch's cap drains through Re-check, on and off", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const total = MAX_MOVES + 3;
	const children = Array.from({ length: total }, (_, i) => `${page(`c${i}`, `child-${String(i).padStart(3, "0")}`)}\n${parent(`c${i}`, "a")}`).join("\n");
	const d1 = fakeD1(`${page("a", "apps")}\n${children}`);
	const ctx = fakeCtx();
	const OFF = { ...ON, childPages: false };
	try {
		await settleSwitch(ctx, d1, OFF, false);
		assert.equal(rules(d1).length, MAX_MOVES);
		assert.equal(Object.keys(snapshot(ctx).paths).length, 3);
		assert.match(offNotice(await readStatus(ctx)).items.at(-1), /3 more pages are over the limit of 200/);
		await recheckCollection(ctx, d1, OFF, "pages");
		assert.equal(rules(d1).length, total);
		assert.equal(snapshot(ctx), undefined);
		assert.equal(offNotice(await readStatus(ctx)), null);

		await settleSwitch(ctx, d1, ON, true);
		assert.equal(status(ctx).open.pages.waitingCount, 3);
		assert.equal(Object.values(snapshot(ctx).paths).filter((path) => !path.startsWith("/apps/")).length, 3, "the flat URLs still to redirect stay in the snapshot");
		await recheckCollection(ctx, d1, ON, "pages");
		assert.equal(status(ctx).open.pages, undefined);
		assert.equal(rules(d1).every(([s, t]) => !s.startsWith("/apps/") && t.startsWith("/apps/")), true, "every flat URL goes to its nested one");
		assert.equal(rules(d1).length, total);
	} finally {
		configureContentUrls({});
	}
});

test(`the status keeps the last ${MAX_CHANGES} changes of every collection, and one collection's open issues don't replace another's`, async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(SITE);
	const ctx = fakeCtx();
	const docsOpen = { at: "2026-11-01T00:00:00.000Z", reason: "A page was published", waiting: [], waitingCount: 0, loops: [{ entryId: "z", title: "Z", from: "/a/z/", to: "/z/", rule: { source: "/z", target: "/a/z/" } }], shadowed: [] };
	const docsChange = { at: "2026-11-01T00:00:00.000Z", collection: "docs", reason: "A page was published", moved: 1, written: 0, skipped: 0, redirectsOff: false, loops: docsOpen.loops };
	ctx.state.kv.set("state:childPages:status", { changes: [docsChange], open: { docs: docsOpen } });
	try {
		await settleCollection(ctx, d1, ON, "pages", null, "x");
		assert.deepEqual(status(ctx).changes, [docsChange], "a change that moved nothing isn't kept");
		for (let i = 0; i < MAX_CHANGES + 2; i++) {
			d1.raw.exec(`UPDATE ec_pages SET slug = 'apps-${i}' WHERE id = 'a'`);
			await settleCollection(ctx, d1, ON, "pages", "a", "A page was published");
		}
		assert.equal(status(ctx).changes.length, MAX_CHANGES);
		assert.equal(status(ctx).changes[0].collection, "pages");
		assert.deepEqual(status(ctx).open.docs, docsOpen, "another collection's unresolved loop is still listed");
	} finally {
		configureContentUrls({});
	}
});

test("translations: only default-locale pages are compared and redirected (a translation's move would write a rule over the live default-locale page)", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(
		[
			page("a-en", "apps", "published", "Apps", "en", "A"),
			page("a-fr", "apps", "published", "Apps FR", "fr", "A"),
			page("p-en", "pack", "published", "Pack", "en", "P"),
			page("p-fr", "pack", "published", "Pack FR", "fr", "P"),
			"INSERT INTO _emdash_content_references VALUES ('e1','r1','P','A');",
		].join("\n"),
	);
	const ctx = fakeCtx();
	try {
		await settleCollection(ctx, d1, ON, "pages", null, "x");
		assert.deepEqual(snapshot(ctx).paths, { "p-en": "/apps/pack/" }, "no translations in the snapshot");
		// The French parent is unpublished: the French child is top level, the English one stays where it is.
		d1.raw.exec("UPDATE ec_pages SET status = 'draft' WHERE id = 'a-fr'");
		await settleCollection(ctx, d1, ON, "pages", "a-fr", "A page was unpublished");
		assert.deepEqual(rules(d1), [], "no /apps/pack → /pack/ over the live English page");
		assert.equal((await read.collectionTree(d1, "pages", { on: true })).urls.get("p-en"), "/apps/pack/");
		// The switch too.
		await settleSwitch(ctx, d1, { ...ON, childPages: false }, false);
		assert.deepEqual(rules(d1), [["/apps/pack", "/pack/"]], "one rule, for the default-locale page");
		// A page with no locale at all counts as the default locale.
		d1.raw.exec("UPDATE ec_pages SET locale = NULL WHERE id = 'p-en'; DELETE FROM coywolf_redirects;");
		await settleSwitch(ctx, d1, ON, true);
		assert.deepEqual(rules(d1), [["/pack", "/apps/pack/"]]);
	} finally {
		configureContentUrls({});
	}
});

test("movedPagesPurges: each old and new path by prefix, paths under another left out, in calls of 100, everything past two calls", () => {
	assert.deepEqual(movedPagesPurges([]), []);
	assert.deepEqual(
		movedPagesPurges([
			{ from: "/apps/coywolf-pack/", to: "/tools/coywolf-pack/" },
			{ from: "/apps/coywolf-pack/docs/", to: "/tools/coywolf-pack/docs/" },
			{ from: "/apps/coywolf-pack-two/?x=1", to: "/tools/café/" },
		]),
		[{ pathPrefixes: ["/apps/coywolf-pack", "/apps/coywolf-pack-two", "/tools/caf%C3%A9", "/tools/coywolf-pack"] }],
		"docs is under coywolf-pack (a prefix clears it); coywolf-pack-two isn't",
	);
	const many = (n) => Array.from({ length: n }, (_, i) => ({ from: `/apps/p${i}/`, to: `/tools/p${i}/` }));
	assert.deepEqual(movedPagesPurges(many(50)).map((s) => s.pathPrefixes.length), [100]);
	assert.deepEqual(movedPagesPurges(many(100)).map((s) => s.pathPrefixes.length), [100, 100]);
	assert.deepEqual(movedPagesPurges(many(101)), [{ purgeEverything: true }]);
	assert.deepEqual(movedPagesPurges([{ from: "/", to: "/home/" }]), [{ purgeEverything: true }], "the home page's prefix is every page");
});

test("a settle purges the cached pages at the moved pages' old and new URLs; the switch leaves that to the save's own purge", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(SITE);
	const ctx = fakeCtx();
	try {
		await settleCollection(ctx, d1, ON, "pages", null, "x");
		purges().length = 0;
		await settleCollection(ctx, d1, ON, "pages", "x", "A page was published");
		assert.deepEqual(purges(), [], "nothing moved: nothing purged");
		d1.raw.exec("UPDATE ec_pages SET slug = 'tools' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was published");
		assert.deepEqual(purges().filter((s) => "pathPrefixes" in s), [{ pathPrefixes: ["/apps/coywolf-pack", "/tools/coywolf-pack"] }], "the page below it too: /apps/coywolf-pack/docs/ is under the prefix");
		assert.ok(purges().some((s) => s.tags?.includes("coywolf-redirects")), "and the cached redirects");
		// With the redirects off the pages still moved: their cached HTML still goes.
		purges().length = 0;
		d1.raw.exec("UPDATE ec_pages SET slug = 'apps' WHERE id = 'a'");
		await settleCollection(ctx, d1, { ...ON, redirects: false }, "pages", "a", "A page was published");
		assert.deepEqual(purges(), [{ pathPrefixes: ["/apps/coywolf-pack", "/tools/coywolf-pack"] }]);
		purges().length = 0;
		await settleSwitch(ctx, d1, { ...ON, childPages: false }, false);
		assert.equal(purges().some((s) => "pathPrefixes" in s), false);
	} finally {
		configureContentUrls({});
	}
});

test("no snapshot: one is recorded from the current tree, and the change says pages it moved got no redirect; a snapshot that can't be read fails the settle and is left alone", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(SITE);
	const ctx = fakeCtx();
	try {
		// The first parent ever chosen: only the page being published has one. Nothing to say.
		const first = fakeD1([page("a", "apps"), page("p", "coywolf-pack"), parent("p", "a")].join("\n"));
		const firstCtx = fakeCtx();
		await settleCollection(firstCtx, first, ON, "pages", "p", "A page was published");
		assert.deepEqual(status(firstCtx).changes, []);
		assert.deepEqual(snapshot(firstCtx).paths, { p: "/apps/coywolf-pack/" });

		// Other pages already have parents and there's no snapshot (deleted, or its write failed): said, and recorded.
		d1.raw.exec("UPDATE ec_pages SET status = 'draft' WHERE id = 'a'");
		await settleCollection(ctx, d1, ON, "pages", "a", "A page was unpublished");
		assert.equal(status(ctx).changes[0].noSnapshot, true);
		assert.ok(ctx.state.logs.some(([level, message]) => level === "warn" && /no earlier URLs/.test(message)));
		assert.deepEqual(snapshot(ctx).paths, { d: "/coywolf-pack/docs/" }, "tracking starts again from the current URLs");

		// The snapshot can't be read: nothing is compared with nothing, and it isn't overwritten.
		const kept = snapshot(ctx);
		const get = ctx.kv.get;
		ctx.kv.get = async (key) => {
			if (key.startsWith("state:childPages:paths:")) throw new Error("KV down");
			return get(key);
		};
		d1.raw.exec("UPDATE ec_pages SET status = 'published' WHERE id = 'a'");
		await assert.rejects(settleCollection(ctx, d1, ON, "pages", "a", "A page was published"), /KV down/);
		ctx.kv.get = get;
		assert.deepEqual(snapshot(ctx), kept);
		assert.deepEqual(rules(d1), []);
		// Re-check makes what the failed settle would have.
		await recheckCollection(ctx, d1, ON, "pages");
		assert.deepEqual(rules(d1), [
			["/coywolf-pack", "/apps/coywolf-pack/"],
			["/coywolf-pack/docs", "/apps/coywolf-pack/docs/"],
		]);
		// Re-check with no snapshot at all starts from the current URLs, and that isn't a problem to report.
		ctx.state.kv.delete("state:childPages:paths:pages");
		const changes = status(ctx).changes.length;
		await recheckCollection(ctx, d1, ON, "pages");
		assert.equal(status(ctx).changes.length, changes);
		assert.deepEqual(snapshot(ctx).paths, { p: "/apps/coywolf-pack/", d: "/apps/coywolf-pack/docs/" });
	} finally {
		configureContentUrls({});
	}
});

// ── Through the pack's hooks, as EmDash calls them ──

const { composeHooks, policyReason, POLICY_REASON_MAX } = await import("../src/core/compose.ts");
const { redirectsPack } = await import("../src/redirects/pack.ts");
const { readFileSync } = await import("node:fs");
/**
 * Child Pages and Redirect Manager in the order src/modules.ts lists them (the whole list can't be loaded
 * under Node: some modules need the Workers runtime), so the tests below run them as the pack does.
 */
function packOrder() {
	const source = readFileSync(new URL("../src/modules.ts", import.meta.url), "utf8");
	const list = source.slice(source.indexOf("export const MODULES"));
	const at = { childPages: list.indexOf("childPagesPack()"), redirects: list.indexOf("redirectsPack(") };
	assert.ok(at.childPages > 0 && at.redirects > 0, "both are in MODULES");
	return [
		{ id: "childPages", at: at.childPages, make: () => pack.childPagesPack() },
		{ id: "redirects", at: at.redirects, make: () => redirectsPack({}) },
	].sort((a, b) => a.at - b.at);
}
const { loopReason, MAX_REASON, importPlan, nestsBy } = pack;
const FEATURES_ROW = "plugin:coywolf-pack:settings:features";
const SWITCHES = { _defaults036: true, childPages: true, redirects: true, "redirects.slugChanges": true, "redirects.trashPrompt": false };

/**
 * A site: its D1 as the DB binding, the switches stored in it (the URL resolver reads them there) and given to the
 * plugin context, and the hooks of the named modules composed in the pack's own order (src/modules.ts).
 */
function site(sql, { modules: ids = ["childPages", "redirects"], d1: d1Options } = {}) {
	const d1 = fakeD1(sql, d1Options);
	d1.raw.prepare("INSERT INTO options VALUES (?, ?)").run(FEATURES_ROW, JSON.stringify(SWITCHES));
	env.DB = d1;
	invalidateFeatures();
	read.invalidatePageTrees();
	const modules = packOrder().filter((m) => ids.includes(m.id)).map((m) => m.make());
	const { hooks } = composeHooks(modules, { tasks: [] });
	const ctx = fakeCtx(SWITCHES);
	const call = (name, event) => {
		const hook = hooks[name];
		return (typeof hook === "function" ? hook : hook.handler)(event, ctx);
	};
	const row = (id) => {
		const r = d1.raw.prepare("SELECT * FROM ec_pages WHERE id = ?").get(id);
		return { id: r.id, slug: r.slug, status: r.status, locale: r.locale, translationGroup: r.translation_group, draftRevisionId: r.draft_revision_id, liveRevisionId: r.live_revision_id, publishedAt: r.published_at, data: { title: r.title } };
	};
	const event = (id) => ({ collection: "pages", content: row(id) });
	const close = () => {
		configureStoredParents(null);
		configureContentUrls({});
		delete env.DB;
		invalidateFeatures();
	};
	return { d1, ctx, hooks, modules, call, event, close };
}

test("the pack's own module order puts Child Pages before Redirect Manager, so Slug changes sees the parent that was just published", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	// Coywolf Pack is published at /coywolf-pack/; Apps is chosen as its parent and waits in its draft.
	const s = site([page("a", "apps"), page("p", "coywolf-pack")].join("\n") + `\nINSERT INTO revisions VALUES ('r2', '{"_references":{"parent_page":["a"]}}'); UPDATE ec_pages SET draft_revision_id = 'r2', live_revision_id = 'r1' WHERE id = 'p';`);
	// One request, as EmDash runs a publish: its reads are shared (src/core/request-memo.ts).
	const ALS = Symbol.for("emdash:request-context");
	const request = {};
	const earlier = globalThis[ALS];
	globalThis[ALS] = { getStore: () => request };
	try {
		assert.deepEqual(s.modules.map((m) => m.id), ["childPages", "redirects"]);
		// Slug changes knows the page at its flat URL.
		await s.call("content:afterSave", s.event("p"));
		assert.equal(s.ctx.state.remembered.get("pages:p").url, "/coywolf-pack/");
		// The guard reads the tree as it is before the publish (no parent yet), in this request.
		assert.equal(await s.call("content:beforePublish", s.event("p")), undefined);
		// EmDash publishes: the link goes live.
		s.d1.raw.exec(`${parent("p", "a")} UPDATE ec_pages SET draft_revision_id = NULL, live_revision_id = 'r2' WHERE id = 'p';`);
		await s.call("content:afterPublish", s.event("p"));
		assert.deepEqual(rules(s.d1), [["/coywolf-pack", "/apps/coywolf-pack/"]], "the 301 from the flat URL: Slug changes read the tree again, not the guard's");
		assert.equal(s.ctx.state.remembered.get("pages:p").url, "/apps/coywolf-pack/");
	} finally {
		if (earlier === undefined) delete globalThis[ALS];
		else globalThis[ALS] = earlier;
		s.close();
	}
});

test("afterPublish, afterUnpublish, afterDelete and afterRestore through the composed hooks: the pages below get their 301s, the page itself is left to Slug changes, and the URL version moves each time", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	// Child Pages alone: what's written here is its own doing.
	const s = site(SITE, { modules: ["childPages"] });
	const version = () => s.ctx.state.settings.get("childPagesVersion");
	try {
		await s.call("content:afterPublish", s.event("x"));
		const v1 = version();
		assert.ok(v1, "live search's cached page URLs are dropped (the URL fingerprint)");
		assert.deepEqual(snapshot(s.ctx).paths, { p: "/apps/coywolf-pack/", d: "/apps/coywolf-pack/docs/" });

		// A nested page is renamed and published: the page below it moves; the page itself is Slug changes' (not written here).
		s.d1.raw.exec("UPDATE ec_pages SET slug = 'pack' WHERE id = 'p'");
		await s.call("content:afterPublish", s.event("p"));
		assert.deepEqual(rules(s.d1), [["/apps/coywolf-pack/docs", "/apps/pack/docs/"]]);
		assert.notEqual(version(), v1);
		assert.equal(snapshot(s.ctx).paths.p, "/apps/pack/");

		// Unpublished: the pages below Apps become top level.
		s.d1.raw.exec("UPDATE ec_pages SET status = 'draft' WHERE id = 'a'");
		const v2 = version();
		await s.call("content:afterUnpublish", s.event("a"));
		assert.deepEqual(rules(s.d1), [
			["/apps/coywolf-pack/docs", "/pack/docs/"],
			["/apps/pack", "/pack/"],
			["/apps/pack/docs", "/pack/docs/"],
		]);
		assert.notEqual(version(), v2);

		// Published again, then moved to the trash: nested, then top level again.
		s.d1.raw.exec("UPDATE ec_pages SET status = 'published' WHERE id = 'a'");
		await s.call("content:afterPublish", s.event("a"));
		assert.deepEqual(rules(s.d1).find(([from]) => from === "/pack"), ["/pack", "/apps/pack/"]);
		s.d1.raw.exec("UPDATE ec_pages SET deleted_at = '2026-11-15' WHERE id = 'a'");
		const v3 = version();
		await s.call("content:afterDelete", { collection: "pages", id: "a", permanent: false });
		assert.deepEqual(rules(s.d1).find(([from]) => from === "/apps/pack"), ["/apps/pack", "/pack/"]);
		assert.equal(status(s.ctx).changes[0].reason, "A page was moved to the trash");
		assert.notEqual(version(), v3);

		// Restored (EmDash brings it back as a draft): nothing nests yet, but the hook runs and the version moves.
		s.d1.raw.exec("UPDATE ec_pages SET deleted_at = NULL, status = 'draft' WHERE id = 'a'");
		const v4 = version();
		const before = rules(s.d1);
		await s.call("content:afterRestore", s.event("a"));
		assert.deepEqual(rules(s.d1), before);
		assert.notEqual(version(), v4);
	} finally {
		s.close();
	}
});

test("afterSave through the composed hooks: a draft's save does nothing; a slug-only save of a published page with pending edits moves the pages below it", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const s = site(SITE, { modules: ["childPages"] });
	const version = () => s.ctx.state.settings.get("childPagesVersion");
	const kvWrites = [];
	try {
		await s.call("content:afterPublish", s.event("x"));
		const set = s.ctx.kv.set;
		s.ctx.kv.set = async (key, value) => (kvWrites.push(key), set(key, value));
		const v1 = version();

		// A draft page's save: not a change to the published tree.
		s.d1.raw.exec(page("n", "new-draft", "draft"));
		await s.call("content:afterSave", s.event("n"));
		// A published page with edits waiting in its draft, slug as it was: nothing is live yet.
		s.d1.raw.exec("UPDATE ec_pages SET draft_revision_id = 'r2', live_revision_id = 'r1' WHERE id IN ('a', 'p', 'x')");
		await s.call("content:afterSave", s.event("a"));
		await s.call("content:afterSave", s.event("x"));
		assert.equal(version(), v1, "no settle, no new URL version");
		assert.deepEqual(kvWrites, []);
		assert.deepEqual(rules(s.d1), []);

		// The REST API changes only the slug (no data, no references): EmDash writes it to the live row, pending edits or not.
		s.d1.raw.exec("UPDATE ec_pages SET slug = 'tools' WHERE id = 'a'");
		await s.call("content:afterSave", s.event("a"));
		assert.deepEqual(rules(s.d1), [
			["/apps/coywolf-pack", "/tools/coywolf-pack/"],
			["/apps/coywolf-pack/docs", "/tools/coywolf-pack/docs/"],
		]);
		assert.notEqual(version(), v1, "the URL version moves");
		assert.equal(status(s.ctx).changes[0].reason, "A page's slug changed");
		// The same for a nested page (the page itself is Slug changes').
		s.d1.raw.exec("UPDATE ec_pages SET slug = 'pack' WHERE id = 'p'");
		await s.call("content:afterSave", s.event("p"));
		assert.deepEqual(rules(s.d1).find(([from]) => from === "/tools/coywolf-pack/docs"), ["/tools/coywolf-pack/docs", "/tools/pack/docs/"]);
		// A top-level page with nothing under it: its slug moves no other page.
		const v2 = version();
		s.d1.raw.exec("UPDATE ec_pages SET slug = 'about-us' WHERE id = 'x'");
		await s.call("content:afterSave", s.event("x"));
		assert.equal(version(), v2);

		// A collection without drafts saves everything live: every save of a published page settles.
		s.d1.raw.exec("UPDATE ec_pages SET draft_revision_id = NULL WHERE id = 'x'");
		await s.call("content:afterSave", s.event("x"));
		assert.notEqual(version(), v2);
	} finally {
		s.close();
	}
});

test("a page that goes back to a URL a hand-made rule redirects: Slug changes writes no loop, Child Pages lists it, and Re-check adds the 301 once the rule is deleted", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const s = site(SEO);
	try {
		await ensureTable(s.d1);
		await byHand(s.d1, "/coywolf-seo", "/apps/coywolf-seo/");
		await s.call("content:afterPublish", s.event("s"));
		assert.equal(s.ctx.state.remembered.get("pages:s").url, "/apps/coywolf-seo/");
		// Its parent is removed and it's published: it's at /coywolf-seo/ now.
		s.d1.raw.exec("DELETE FROM _emdash_content_references WHERE parent_group = 's'");
		await s.call("content:afterPublish", s.event("s"));
		assert.deepEqual(rules(s.d1), [["/coywolf-seo", "/apps/coywolf-seo/"]], "no /apps/coywolf-seo → /coywolf-seo/");
		assert.ok(s.ctx.state.logs.some(([level, message]) => level === "warn" && /^Slug change: no redirect added/.test(message)));
		assert.deepEqual(status(s.ctx).open.pages.loops.map((l) => [l.entryId, l.from, l.to, l.rule.source]), [["s", "/apps/coywolf-seo/", "/coywolf-seo/", "/coywolf-seo"]]);
		assert.equal(snapshot(s.ctx).paths.s, "/apps/coywolf-seo/");

		// The Child Pages page's Re-check redirects, with the rule still there, then deleted.
		const recheck = s.modules.find((m) => m.id === "childPages").routes["childPages/recheck"];
		let answer = await recheck.handler({ ...s.ctx, input: undefined });
		assert.equal(answer.open[0].loops.length, 1);
		s.d1.raw.exec("DELETE FROM coywolf_redirects WHERE source = '/coywolf-seo'");
		answer = await recheck.handler({ ...s.ctx, input: undefined });
		assert.deepEqual(rules(s.d1), [["/apps/coywolf-seo", "/coywolf-seo/"]]);
		assert.deepEqual(answer.open, []);
		assert.equal(answer.changes[0].reason, "Redirects re-checked");
	} finally {
		s.close();
	}
});

test("a settle that fails in a hook is logged and listed, the snapshot is left alone, and the next change makes its redirects", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	let failing = false;
	const s = site(SITE, { modules: ["childPages"], d1: { fail: (q) => failing && /coywolf_redirects/.test(q) } });
	try {
		await s.call("content:afterPublish", s.event("x"));
		const kept = snapshot(s.ctx);
		s.d1.raw.exec("UPDATE ec_pages SET slug = 'tools' WHERE id = 'a'");
		failing = true;
		await s.call("content:afterPublish", s.event("a"));
		failing = false;
		assert.ok(s.ctx.state.logs.some(([level, message]) => level === "error" && /could not work out the redirects/.test(message)));
		assert.match(status(s.ctx).changes[0].failed, /transient/);
		assert.deepEqual(snapshot(s.ctx), kept);
		await s.call("content:afterPublish", s.event("x"));
		assert.deepEqual(rules(s.d1), [
			["/apps/coywolf-pack", "/tools/coywolf-pack/"],
			["/apps/coywolf-pack/docs", "/tools/coywolf-pack/docs/"],
		]);
	} finally {
		s.close();
	}
});

// ── The publish guard's message ──

test("the publish guard's reason stays within EmDash's 500 code points whatever the titles, so a loop with long titles is still refused", async () => {
	const long = "Ünïcödé 🐺 title ".repeat(20).trim(); // 300+ code points, astral characters included
	assert.ok([...long].length > 300);
	const reason = loopReason(long, [long, long, long]);
	assert.ok([...reason].length <= MAX_REASON, `${[...reason].length} code points`);
	assert.match(reason, /would put “Ünïcödé 🐺 title .+…” under itself \(.+ › .+ › .+\)\. Choose another parent page, or none\.$/u);
	assert.ok([...loopReason(long, Array.from({ length: 40 }, () => long))].length <= MAX_REASON, "a long chain keeps its ends");
	assert.ok([...loopReason(long, [long])].length <= MAX_REASON);
	assert.equal(loopReason("Coywolf apps", ["docs", "Coywolf Pack", "Coywolf apps"]), "That parent page would put “Coywolf apps” under itself (Coywolf apps › Coywolf Pack › docs › Coywolf apps). Choose another parent page, or none.");
	assert.doesNotMatch(loopReason("Bell\u0007 and\nnewline\u007f", ["a", "b"]), /[\u0000-\u001f\u007f]/, "no control characters: EmDash refuses a reason with one");
	// Any module's refusal is cut to the limit where the hooks are composed, too.
	assert.equal([...policyReason("🐺".repeat(600))].length, POLICY_REASON_MAX);
	assert.equal(policyReason("short"), "short");

	// Through the composed hook, as EmDash reads the decision.
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const s = site([page("a", "apps", "published", long), page("p", "pack", "published", long), page("d", "docs", "published", long), parent("p", "a"), parent("d", "p")].join("\n") + `\nINSERT INTO revisions VALUES ('r-loop', '{"_references":{"parent_page":["d"]}}');`, { modules: ["childPages"] });
	try {
		const decision = await s.call("content:beforePublish", { collection: "pages", content: { id: "a", translationGroup: "a", draftRevisionId: "r-loop", data: { title: long } }, origin: { source: "api" } });
		assert.equal(decision.cancel, true);
		assert.ok([...decision.reason].length <= 500);
		// EmDash's limit, from its source (inspectContentPolicyDecision throws past it, and the publish would go through).
		const emdash = readFileSync(new URL("../node_modules/emdash/src/plugins/content-policy.ts", import.meta.url), "utf8");
		assert.match(emdash, new RegExp(`MAX_CONTENT_POLICY_REASON_LENGTH = ${POLICY_REASON_MAX};`));
		assert.match(emdash, /codePointLength\(.*reason.*\) > MAX_CONTENT_POLICY_REASON_LENGTH|reason.*MAX_CONTENT_POLICY_REASON_LENGTH/s);
	} finally {
		s.close();
	}
});

// ── The import, and the Set up list ──

test("the import never publishes a page that isn't published: drafts (with no draft revision too) and scheduled pages are skipped", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" }, pageParents: { "sold-domain": "domains", soon: "domains", live: "domains", waiting: "domains" } });
	const d1 = fakeD1([page("dm", "domains"), page("s", "sold-domain", "draft"), page("q", "soon", "scheduled"), page("l", "live"), page("w", "waiting")].join("\n") + "\nUPDATE ec_pages SET draft_revision_id = 'r2', live_revision_id = 'r1' WHERE id = 'w';");
	try {
		assert.equal(d1.raw.prepare("SELECT draft_revision_id FROM ec_pages WHERE id = 's'").get().draft_revision_id, null, "a draft with no draft revision");
		const ct = await read.collectionTree(d1, "pages", { on: true });
		const rows = Object.fromEntries((await importPlan(d1, ct)).map((r) => [r.slug, [r.action, r.reason]]));
		assert.deepEqual(rows, { "sold-domain": ["skip", "notPublished"], soon: ["skip", "notPublished"], live: ["set", undefined], waiting: ["skip", "pendingChanges"] });
	} finally {
		configureContentUrls({});
	}
});

test("nestsBy: a collection whose own URL pattern has neither {slug} nor {pagepath} can't nest by its field", () => {
	const field = { id: "f", relation: "r", side: "parent" };
	assert.equal(nestsBy({ collection: "items", field, urlPattern: "/{id}" }, true), "pattern");
	assert.equal(nestsBy({ collection: "pages", field, urlPattern: "/{slug}/" }, true), "field");
	assert.equal(nestsBy({ collection: "pages", field, urlPattern: null }, true), "field", "EmDash's default pattern has {slug}");
	assert.equal(nestsBy({ collection: "pages", field, urlPattern: "/{slug}/" }, false), null);
	assert.equal(nestsBy({ collection: "pages", field: null, urlPattern: "/{slug}/" }, true), null);
	configureContentUrls({ urls: { pages: "/{pagepath}/", posts: "/{slug}/" } });
	assert.equal(nestsBy({ collection: "pages", field, urlPattern: null }, true), "configured");
	assert.equal(nestsBy({ collection: "posts", field, urlPattern: null }, true), "override");
	configureContentUrls({});
});

// ── Theme helpers ──

const theme = await import("../src/childPages/theme.ts");
const ALS = Symbol.for("emdash:request-context");
/** Run as one request of EmDash's (its request context shares the pack's reads, and carries a verified preview). */
async function inRequest(store, run) {
	const earlier = globalThis[ALS];
	globalThis[ALS] = { getStore: () => store };
	try {
		return await run();
	} finally {
		if (earlier === undefined) delete globalThis[ALS];
		else globalThis[ALS] = earlier;
	}
}

test("resolvePagePath: a draft or scheduled page answers null at its nested and its flat path (no page, no redirect), unless the route says it's a preview", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1([page("a", "apps"), page("s", "secret-launch", "draft"), page("q", "soon", "scheduled"), page("p", "coywolf-pack"), parent("s", "a"), parent("q", "a"), parent("p", "a")].join("\n"));
	try {
		const tree = theme.pageTreeFrom(await read.collectionTree(d1, "pages", { on: true }));
		for (const slug of ["secret-launch", "soon"]) {
			assert.equal(theme.resolvePagePath(tree, [slug], { search: "?x=1" }), null, "the flat form doesn't redirect to where the draft will be");
			assert.equal(theme.resolvePagePath(tree, ["apps", slug]), null);
			assert.equal(theme.resolvePagePath(tree, ["apps", slug], { preview: false }), null);
		}
		// A preview route: the draft at its path, and EmDash's flat preview link redirected there with its token.
		assert.equal(theme.resolvePagePath(tree, ["apps", "secret-launch"], { preview: true }).page.id, "s");
		assert.deepEqual(theme.resolvePagePath(tree, ["secret-launch"], { search: "?_preview=tok", preview: true }), { redirect: "/apps/secret-launch/?_preview=tok" });
		// Published pages as before.
		assert.equal(theme.resolvePagePath(tree, ["apps", "coywolf-pack"]).page.id, "p");
		assert.deepEqual(theme.resolvePagePath(tree, ["coywolf-pack"]), { redirect: "/apps/coywolf-pack/" });
		assert.equal(tree.get("secret-launch").published, false, "get() still finds it, for a template that already has the entry");

		// isPreviewRequest: only what EmDash's middleware verified, not a _preview parameter anyone can add.
		assert.equal(theme.isPreviewRequest(), false);
		assert.equal(await inRequest({}, async () => theme.isPreviewRequest()), false);
		assert.equal(await inRequest({ preview: { collection: "pages", id: "s" } }, async () => theme.isPreviewRequest()), true);
	} finally {
		configureContentUrls({});
	}
});

test("get(): a published page wins over an unpublished one with the same slug, whatever their locales", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1([page("x-en", "about", "draft", "About (draft)", "en", "X"), page("x-fr", "about", "published", "À propos", "fr", "X")].join("\n"));
	try {
		const tree = theme.pageTreeFrom(await read.collectionTree(d1, "pages", { on: true }));
		assert.equal(tree.get("about").id, "x-fr");
		assert.equal(theme.resolvePagePath(tree, ["about"]).page.id, "x-fr");
	} finally {
		configureContentUrls({});
	}
});

test("cacheTags follow the chosen parents, the ones that don't count included: a parent's publish clears the pages cached at the top level while it was unpublished", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const d1 = fakeD1(
		[page("a", "apps", "draft"), page("p", "coywolf-pack"), page("d", "docs"), page("l1", "loop-one"), page("l2", "loop-two"), page("x", "about"), parent("p", "a"), parent("d", "p"), parent("l1", "l2"), parent("l2", "l1")].join("\n"),
	);
	try {
		const tree = theme.pageTreeFrom(await read.collectionTree(d1, "pages", { on: true }));
		assert.equal(tree.path("coywolf-pack"), "/coywolf-pack/", "Apps isn't published: top level");
		assert.deepEqual(tree.trail("coywolf-pack"), []);
		assert.deepEqual(tree.cacheTags("coywolf-pack"), ["a"], "tagged with Apps all the same");
		assert.deepEqual(tree.cacheTags("docs"), ["p", "a"], "the page above it in its URL, and the chosen parents above that");
		assert.deepEqual(tree.cacheTags("loop-one"), ["l2"], "a loop stops where it comes back around, without the page itself");
		assert.deepEqual(tree.cacheTags("about"), []);
		assert.deepEqual(tree.cacheTags("nope"), []);
	} finally {
		configureContentUrls({});
	}
});

test("loadPageTree costs an uncached page one D1 round trip, shared with the menus, the breadcrumb titles and the URL resolver", async () => {
	configureContentUrls({ urls: { pages: "/{pagepath}/" } });
	const s = site(SITE, { modules: ["childPages"] });
	try {
		// The isolate has read the switches (the pack's middleware does, before anything renders).
		await inRequest({}, () => theme.loadPageTree(s.d1));
		const before = { ...s.d1.counts };
		await inRequest({}, async () => {
			const tree = await theme.loadPageTree(s.d1);
			assert.equal(tree.path("docs"), "/apps/coywolf-pack/docs/");
			assert.equal(tree.trail("docs")[0].title, "Coywolf apps");
			// The page template and the layout's menus ask again; breadcrumbs and the schema graph read the titles; a module resolves a URL.
			await theme.loadPageTree(s.d1);
			assert.equal((await read.pageTitlesByPath(s.d1)).get("/apps/coywolf-pack"), "Coywolf Pack");
			assert.equal(await entryUrl(s.d1, "pages", { id: "d", slug: "docs" }), "/apps/coywolf-pack/docs/");
		});
		assert.equal(s.d1.counts.roundTrips - before.roundTrips, 1, "one batch");
		assert.equal(s.d1.counts.statements - before.statements, 3, "the collections and their fields, the pages' rows, the links");

		// A collection whose title field isn't "title" (or that has none): found once, then one round trip again.
		s.d1.raw.exec("ALTER TABLE ec_pages DROP COLUMN title");
		read.invalidatePageTrees();
		await inRequest({}, () => theme.loadPageTree(s.d1));
		const again = s.d1.counts.roundTrips;
		const tree = await inRequest({}, () => theme.loadPageTree(s.d1));
		assert.equal(s.d1.counts.roundTrips - again, 1);
		assert.equal(tree.get("docs").title, "docs", "the slug stands in");

		// With Child Pages off (a theme that already uses the helpers): one round trip, without the links.
		s.d1.raw.prepare("UPDATE options SET value = ? WHERE name = ?").run(JSON.stringify({ ...SWITCHES, childPages: false }), FEATURES_ROW);
		invalidateFeatures();
		read.invalidatePageTrees();
		await inRequest({}, () => theme.loadPageTree(s.d1));
		const off = { ...s.d1.counts };
		const flat = await inRequest({}, () => theme.loadPageTree(s.d1));
		assert.equal(s.d1.counts.roundTrips - off.roundTrips, 1);
		assert.equal(s.d1.counts.statements - off.statements, 2);
		assert.equal(flat.path("docs"), "/docs/");
		assert.equal(await theme.loadPageTree(s.d1, { collection: "nope" }).catch((error) => error.message), 'coywolf-pack: loadPageTree: no collection "nope"');
	} finally {
		s.close();
	}
});

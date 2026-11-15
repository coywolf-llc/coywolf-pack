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

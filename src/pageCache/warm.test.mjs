// Unit tests for cache warming and scoped purges.
// Run: node --test src/pageCache/warm.test.mjs   (Node 22.6+ strips the types from the .ts files)
import assert from "node:assert/strict";
import { test } from "node:test";

const { sitemapLocs, warmOrder, collectUrls, homeLinks, newWarmState, claimWork, warmStep, writeWarmState, writeWarmQueue, readWarmState, startWarm, finishCollect, recordBatch, recordRevisit, remainingUrls, pendingRevisits, WARM_STATE_OPTION, WARM_QUEUE_PREFIX, QUEUE_CHUNK } =
	await import("./warm.ts");
const { STOPGAP_HEADER, MAX_REVISIT, REVISIT_DELAY_MS, MAX_REVISIT_ROUNDS } = await import("./warm.ts");
const { scheduleRewarm, warmMayHaveWork, REWARM_DELAY_MS, REWARM_MAX_DELAY_MS, BATCH_STALE_MS, DAILY_REFRESH_MS, nextDailyAt } = await import("./warm.ts");
const { purgeScope } = await import("./lib.ts");

const API = "/_emdash/api/plugins/coywolf-pack/";

test("settings that don't change pages don't clear them; robots clears only robots.txt", () => {
	assert.deepEqual(purgeScope(API + "redirects/import"), { tags: ["coywolf-redirects"] });
	assert.equal(purgeScope(API + "backups/run"), null);
	assert.equal(purgeScope(API + "links/recheck"), null);
	assert.equal(purgeScope(API + "cache/warm/start"), null);
	assert.equal(purgeScope(API + "cache/media/apply"), null);
	assert.deepEqual(purgeScope(API + "robots/save"), { pathPrefixes: ["/robots.txt"] });
	assert.deepEqual(purgeScope(API + "schema/site/save"), { purgeEverything: true });
	assert.deepEqual(purgeScope(API + "cache/settings/save"), { purgeEverything: true });
	assert.deepEqual(purgeScope(API + "features/save"), { purgeEverything: true });
});

test("reads sitemaps and sitemap indexes", () => {
	assert.deepEqual(sitemapLocs('<urlset><url><loc>https://x.com/a/?p=1&amp;q=2</loc></url><url><loc> https://x.com/b/ </loc></url></urlset>'), {
		isIndex: false,
		locs: ["https://x.com/a/?p=1&q=2", "https://x.com/b/"],
	});
	assert.equal(sitemapLocs("<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>").isIndex, true);
});

test("warm order: home first, same origin only, no duplicates, capped", () => {
	const order = warmOrder("https://x.com", ["https://x.com/new/", "https://other.com/x/", "https://x.com/", "https://x.com/new/#top", "/old/"], 3);
	assert.deepEqual(order, ["https://x.com/", "https://x.com/new/", "https://x.com/old/"]);
});

function fakeSite(pages) {
	const hits = [];
	return {
		hits,
		async fetch(req) {
			hits.push(req.url);
			const body = pages[req.url];
			return body === undefined ? new Response("nope", { status: 404 }) : new Response(body, { status: 200 });
		},
	};
}

test("collects URLs through a sitemap index", async () => {
	const site = fakeSite({
		"https://x.com/sitemap.xml": "<sitemapindex><sitemap><loc>https://x.com/sitemap-posts-1.xml</loc></sitemap><sitemap><loc>https://evil.com/s.xml</loc></sitemap></sitemapindex>",
		"https://x.com/sitemap-posts-1.xml": "<urlset><url><loc>https://x.com/p2/</loc></url><url><loc>https://x.com/p1/</loc></url></urlset>",
	});
	assert.deepEqual(await collectUrls(site, "https://x.com"), ["https://x.com/", "https://x.com/p2/", "https://x.com/p1/"]);
	assert.ok(!site.hits.some((u) => u.includes("evil.com")), "other hosts are never fetched");
});

test("section pages linked from the home page come right after it", async () => {
	const site = fakeSite({
		"https://x.com/": `<nav><a href="/notes/">Notes</a> <a class="x" href='https://x.com/news/#top'>News</a> <a href="https://other.com/a/">x</a>
			<a href="/p1/">p1</a> <a href="/_emdash/admin">admin</a> <a href="/feed/">rss</a> <a href="/file.pdf">pdf</a> <a href="/search/?q=a">s</a> <a href="#main">skip</a></nav>`,
		"https://x.com/sitemap.xml": "<urlset><url><loc>https://x.com/p2/</loc></url><url><loc>https://x.com/p1/</loc></url></urlset>",
	});
	assert.deepEqual(await collectUrls(site, "https://x.com"), ["https://x.com/", "https://x.com/notes/", "https://x.com/news/", "https://x.com/p1/", "https://x.com/p2/"]);
});

test("home links are capped", () => {
	const html = Array.from({ length: 300 }, (_, i) => `<a href="/c${i}/">c</a>`).join("");
	assert.equal(homeLinks(html, "https://x.com").length, 200);
});

/** The slice of D1 the warm queue uses: one options table. Counts writes to the progress row and their size. */
function fakeDb() {
	const rows = new Map();
	const db = {
		rows,
		stateWrites: [],
		prepare(sql) {
			let args = [];
			// D1 refuses LIKE/GLOB patterns over 50 bytes (SQLITE_MAX_LIKE_PATTERN_LENGTH); queue row names are longer.
			const checkLike = () => {
				if (/\bLIKE\b/.test(sql) && args.some((a) => typeof a === "string" && Buffer.byteLength(a) > 50)) {
					throw new Error("LIKE or GLOB pattern too complex: SQLITE_ERROR [code: 7500]");
				}
			};
			const stmt = {
				bind(...a) {
					args = a;
					return stmt;
				},
				async first() {
					return rows.has(args[0]) ? { value: rows.get(args[0]) } : null;
				},
				async all() {
					// SELECT name, value FROM options WHERE name IN (…)
					return { results: args.filter((n) => rows.has(n)).map((name) => ({ name, value: rows.get(name) })) };
				},
				async run() {
					checkLike();
					if (sql.startsWith("INSERT")) {
						if (sql.includes("DO NOTHING") && rows.has(args[0])) return { meta: { changes: 0 } };
						rows.set(args[0], args[1]);
						if (args[0] === WARM_STATE_OPTION) db.stateWrites.push(args[1].length);
						return { meta: { changes: 1 } };
					}
					if (sql.startsWith("DELETE")) {
						// name >= ? AND name < ? [AND NOT (name >= ? AND name < ?)]
						assert.ok(!sql.includes("LIKE"), "queue rows are deleted by name range");
						const [from, to, keepFrom, keepTo] = args;
						let changes = 0;
						for (const name of [...rows.keys()]) {
							if (name >= from && name < to && !(keepFrom !== undefined && name >= keepFrom && name < keepTo)) {
								rows.delete(name);
								changes++;
							}
						}
						return { meta: { changes } };
					}
					// UPDATE options SET value = ? WHERE name = ? AND value = ?
					const [value, name, before] = args;
					if (rows.get(name) !== before) return { meta: { changes: 0 } };
					rows.set(name, value);
					db.stateWrites.push(value.length);
					return { meta: { changes: 1 } };
				},
			};
			return stmt;
		},
		async batch(statements) {
			return Promise.all(statements.map((s) => s.run()));
		},
	};
	return db;
}

const queueRows = (db) => [...db.rows.keys()].filter((name) => name.startsWith(WARM_QUEUE_PREFIX));

/** A run in its warm phase with these URLs queued. */
async function warmRun(db, urls) {
	const state = { ...newWarmState("x"), phase: "warm", next: 0, total: urls.length };
	await writeWarmState(db, state);
	await writeWarmQueue(db, state.generation, urls);
	return state;
}

const site = (paths) =>
	fakeSite({
		"https://x.com/sitemap.xml": `<urlset>${paths.map((p) => `<url><loc>https://x.com${p}</loc></url>`).join("")}</urlset>`,
		"https://x.com/": "home",
		...Object.fromEntries(paths.map((p) => [`https://x.com${p}`, p])),
	});

test("a warm step reads the sitemap, then warms every page and finishes", async () => {
	const db = fakeDb();
	const s = site(["/a/", "/b/", "/c/", "/gone/"]);
	await startWarm(db, "deploy");
	await warmStep(db, { fetch: (req) => (req.url.endsWith("/gone/") ? Promise.resolve(new Response("", { status: 404 })) : s.fetch(req)) }, "https://x.com", { budgetMs: 10_000, batchSize: 2 });
	const state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.total, 5, "home page plus the sitemap's four");
	assert.equal(state.warmed, 4);
	assert.equal(state.failed, 1);
	assert.deepEqual(queueRows(db), [], "a finished run's URL rows are removed");
});

test("claims only rewrite the small progress row, however long the queue", async () => {
	const db = fakeDb();
	const urls = Array.from({ length: 5000 }, (_, i) => `https://x.com/a-fairly-long-post-slug-number-${i}/`);
	const state = await warmRun(db, urls);
	assert.equal(queueRows(db).length, Math.ceil(5000 / QUEUE_CHUNK));
	db.stateWrites.length = 0;
	const claimed = [];
	for (let i = 0; i < 300; i++) {
		const claim = await claimWork(db, 4);
		claimed.push(...claim.urls);
		await recordBatch(db, state.generation, claim.urls.length, 0);
	}
	assert.deepEqual(claimed, urls.slice(0, 1200), "batches follow the queue order, across chunk rows");
	assert.ok(Math.max(...db.stateWrites) < 1000, `progress writes stay small (largest ${Math.max(...db.stateWrites)} bytes)`);
	const progress = await readWarmState(db);
	assert.equal(progress.next, 1200);
	assert.equal(remainingUrls(progress), 3800);
});

test("a batch spanning two queue rows gets URLs from both", async () => {
	const db = fakeDb();
	const urls = Array.from({ length: QUEUE_CHUNK + 3 }, (_, i) => `https://x.com/${i}/`);
	const state = await warmRun(db, urls);
	await writeWarmState(db, { ...state, next: QUEUE_CHUNK - 2 });
	const claim = await claimWork(db, 4);
	assert.deepEqual(claim.urls, urls.slice(QUEUE_CHUNK - 2, QUEUE_CHUNK + 2));
});

test("a new run clears older runs' URL rows; a superseded collect doesn't leave its URLs", async () => {
	const db = fakeDb();
	const old = await warmRun(db, ["https://x.com/1/", "https://x.com/2/"]);
	assert.equal(queueRows(db).length, 1);
	const fresh = await startWarm(db, "deploy");
	assert.deepEqual(queueRows(db), []);
	// The old run's collect finishing late (after the restart) stores nothing.
	await finishCollect(db, old.generation, ["https://x.com/1/"], "https://x.com");
	assert.deepEqual(queueRows(db), []);
	assert.equal((await readWarmState(db)).generation, fresh.generation);
});

test("progress rows from before the queue rows are reported, then moved to URL rows and worked on", async () => {
	const db = fakeDb();
	const legacy = { ...newWarmState("x"), next: undefined, phase: "warm", queue: ["https://x.com/3/"], total: 3, warmed: 2 };
	db.rows.set(WARM_STATE_OPTION, JSON.stringify(legacy));
	const state = await readWarmState(db);
	assert.equal(state.legacy, true);
	assert.equal(remainingUrls(state), 1);
	assert.equal(state.queue, undefined);
	const claim = await claimWork(db, 4);
	assert.equal(claim.kind, "warm");
	assert.deepEqual(claim.urls, ["https://x.com/3/"]);
	assert.notEqual(claim.state.generation, legacy.generation, "a new generation, so a stale cleanup of the old one can't remove its rows");
	const migrated = JSON.parse(db.rows.get(WARM_STATE_OPTION));
	assert.equal(migrated.queue, undefined);
	assert.equal(migrated.total, 1);
});

test("deploy race: an old isolate finishing a new run's collect (queue + next, no URL rows) doesn't fail every page", async () => {
	const db = fakeDb();
	const s = site(["/a/", "/b/", "/c/"]);
	const fresh = await startWarm(db, "deploy");
	// What the older version's finishCollect writes: the new state spread, plus `queue`.
	const urls = ["https://x.com/", "https://x.com/a/", "https://x.com/b/", "https://x.com/c/"];
	db.rows.set(WARM_STATE_OPTION, JSON.stringify({ ...fresh, phase: "warm", queue: urls, total: urls.length }));
	assert.deepEqual(queueRows(db), []);
	await warmStep(db, s, "https://x.com", { budgetMs: 10_000, batchSize: 2 });
	const state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.warmed, 4);
	assert.equal(state.failed, 0);
	assert.equal(state.legacy, undefined);
	assert.deepEqual(queueRows(db), []);
});

test("an older-format collect step (queue: [], no next) is still collected", async () => {
	const db = fakeDb();
	const { next: _next, ...rest } = newWarmState("deploy");
	db.rows.set(WARM_STATE_OPTION, JSON.stringify({ ...rest, queue: [] }));
	const claim = await claimWork(db, 4);
	assert.equal(claim.kind, "collect");
	assert.equal(claim.state.next, 0);
	assert.equal(JSON.parse(db.rows.get(WARM_STATE_OPTION)).queue, undefined);
});

test("an older-format finished run is only reported", async () => {
	const db = fakeDb();
	db.rows.set(WARM_STATE_OPTION, JSON.stringify({ ...newWarmState("x"), next: undefined, phase: "done", queue: [], total: 2, warmed: 2 }));
	const before = db.rows.get(WARM_STATE_OPTION);
	assert.equal(await claimWork(db, 4), null);
	assert.equal(db.rows.get(WARM_STATE_OPTION), before);
});

test("parallel claims never take the same pages", async () => {
	const db = fakeDb();
	await warmRun(db, ["https://x.com/1/", "https://x.com/2/", "https://x.com/3/", "https://x.com/4/"]);
	const [a, b] = await Promise.all([claimWork(db, 2), claimWork(db, 2)]);
	const taken = [a, b].filter(Boolean).flatMap((c) => c.urls);
	assert.equal(new Set(taken).size, taken.length, "no URL claimed twice");
	const c = await claimWork(db, 2);
	const all = [...taken, ...(c?.urls ?? [])];
	assert.ok(all.length <= 4);
});

test("a restarted run makes old batches stop counting", async () => {
	const db = fakeDb();
	await warmRun(db, ["https://x.com/1/"]);
	const claim = await claimWork(db, 5);
	await startWarm(db, "settings");
	await recordBatch(db, claim.state.generation, 1, 0);
	const state = await readWarmState(db);
	assert.equal(state.phase, "collect");
	assert.equal(state.warmed, 0, "the old run's batch isn't added to the new one");
});

test("nothing to do when the collect step is already taken", async () => {
	const db = fakeDb();
	await startWarm(db, "deploy");
	assert.equal((await claimWork(db, 4)).kind, "collect");
	assert.equal(await claimWork(db, 4), null, "another isolate is reading the sitemap");
});

// ── Revisits: pages first rendered with a stopgap poster ──

/** A site whose pages in `stopgapFor` come back marked (STOPGAP_HEADER) for their first n visits (Infinity: always). */
function stopgapSite(paths, stopgapFor) {
	const hits = [];
	return {
		hits,
		async fetch(req) {
			hits.push(req.url);
			const path = new URL(req.url).pathname;
			if (path === "/sitemap.xml") return new Response(`<urlset>${paths.map((p) => `<url><loc>https://x.com${p}</loc></url>`).join("")}</urlset>`);
			const seen = hits.filter((u) => u === req.url).length;
			const marked = seen <= (stopgapFor[path] ?? 0);
			return new Response(path, { status: 200, headers: marked ? { [STOPGAP_HEADER]: "1" } : {} });
		},
	};
}

const clock = (start = 1_000_000) => {
	const c = { t: start, now: () => c.t };
	return c;
};

test("a page warmed with a stopgap is visited again once its posters have had time to copy, then the run finishes", async () => {
	const db = fakeDb();
	const c = clock();
	const s = stopgapSite(["/a/", "/v/"], { "/v/": 1 });
	await startWarm(db, "deploy");
	const opts = { budgetMs: 10_000, batchSize: 2, now: c.now };
	// The step's clock doesn't move, so it ends on the first "wait" rather than its budget.
	assert.equal(await warmStep(db, s, "https://x.com", opts), "warmed");
	let state = await readWarmState(db);
	assert.equal(state.phase, "warm", "not done while a revisit waits");
	assert.equal(state.warmed, 3);
	assert.deepEqual(state.revisit, [["https://x.com/v/", 0]]);
	assert.equal(pendingRevisits(state), 1);
	assert.equal(remainingUrls(state), 0);

	c.t += REVISIT_DELAY_MS - 1;
	assert.equal(await warmStep(db, s, "https://x.com", opts), "waiting", "too early: nothing visited");
	assert.equal(s.hits.filter((u) => u === "https://x.com/v/").length, 1);

	c.t += 1;
	await warmStep(db, s, "https://x.com", opts);
	state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.rewarmed, 1);
	assert.equal(state.revisitGaveUp, undefined);
	assert.equal(state.revisit, undefined);
	assert.equal(state.warmed, 3, "revisits don't count twice");
	assert.equal(s.hits.filter((u) => u === "https://x.com/v/").length, 2);
	assert.deepEqual(queueRows(db), []);
});

test("a page still on a stopgap after its last revisit is given up on without failing the run", async () => {
	const db = fakeDb();
	const c = clock();
	const s = stopgapSite(["/v/"], { "/v/": Infinity });
	await startWarm(db, "deploy");
	const opts = { budgetMs: 10_000, batchSize: 4, now: c.now };
	for (let i = 0; i < 6; i++) {
		await warmStep(db, s, "https://x.com", opts);
		c.t += REVISIT_DELAY_MS;
	}
	const state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.failed, 0);
	assert.equal(state.revisitGaveUp, 1);
	assert.equal(state.rewarmed, undefined);
	assert.equal(s.hits.filter((u) => u === "https://x.com/v/").length, 1 + MAX_REVISIT_ROUNDS);
});

test("revisits are deduplicated, capped and same-origin, and keep the progress row small", async () => {
	const db = fakeDb();
	const state = await warmRun(db, ["https://x.com/1/"]);
	db.stateWrites.length = 0;
	const many = Array.from({ length: MAX_REVISIT + 20 }, (_, i) => `https://x.com/videos/a-fairly-long-video-post-slug-${i}/`);
	await recordBatch(db, state.generation, 0, 0, 1000, many.slice(0, 50));
	await recordBatch(db, state.generation, 0, 0, 1000, many);
	const after = await readWarmState(db);
	assert.equal(after.revisit.length, MAX_REVISIT);
	assert.equal(new Set(after.revisit.map(([u]) => u)).size, MAX_REVISIT, "no duplicates");
	assert.equal(after.revisitGaveUp, 20, "pages past the cap are counted, not kept");
	assert.ok(Math.max(...db.stateWrites) < 20_000, `progress row stays small (largest ${Math.max(...db.stateWrites)} bytes)`);

	// warmStep only lists same-origin pages.
	const db2 = fakeDb();
	const s2 = { async fetch(req) { return new Response("x", { headers: { [STOPGAP_HEADER]: "1" } }); } };
	await warmRun(db2, ["https://other.com/v/", "https://x.com/v/"]);
	await warmStep(db2, s2, "https://x.com", { budgetMs: 10_000, batchSize: 4, now: () => 0 });
	assert.deepEqual((await readWarmState(db2)).revisit, [["https://x.com/v/", 0]]);
});

test("revisits belong to their run: a new run drops them and an old run's revisit batch doesn't count", async () => {
	const db = fakeDb();
	const state = await warmRun(db, ["https://x.com/v/"]);
	await claimWork(db, 4, 0);
	await recordBatch(db, state.generation, 1, 0, 0, ["https://x.com/v/"]);
	const claim = await claimWork(db, 4, REVISIT_DELAY_MS);
	assert.equal(claim.kind, "revisit");
	assert.deepEqual(claim.pages, [["https://x.com/v/", 0]]);
	const fresh = await startWarm(db, "settings");
	await recordRevisit(db, state.generation, [{ url: "https://x.com/v/", ok: true, stopgap: true, round: 0 }], REVISIT_DELAY_MS);
	const now = await readWarmState(db);
	assert.equal(now.generation, fresh.generation);
	assert.equal(now.revisit, undefined);
	assert.equal(now.revisitBusy, undefined);
	assert.equal(pendingRevisits(now), 0);
});

test("parallel revisit claims never take the same page; parallel batches all list their pages", async () => {
	const db = fakeDb();
	const urls = ["https://x.com/1/", "https://x.com/2/", "https://x.com/3/", "https://x.com/4/"];
	const state = await warmRun(db, urls);
	await claimWork(db, 4, 0);
	await Promise.all(urls.map((u) => recordBatch(db, state.generation, 1, 0, 0, [u])));
	let progress = await readWarmState(db);
	assert.equal(progress.warmed, 4);
	assert.deepEqual(progress.revisit.map(([u]) => u).sort(), urls);
	const claims = await Promise.all([claimWork(db, 2, REVISIT_DELAY_MS), claimWork(db, 2, REVISIT_DELAY_MS), claimWork(db, 2, REVISIT_DELAY_MS)]);
	const taken = claims.filter(Boolean).flatMap((c) => c.pages.map(([u]) => u));
	assert.equal(new Set(taken).size, taken.length, "no page claimed twice");
	progress = await readWarmState(db);
	assert.equal(progress.revisitBusy, taken.length);
	assert.equal((progress.revisit?.length ?? 0) + taken.length, 4);
});

test("revisits claimed by an isolate that stopped don't keep the run open forever", async () => {
	const db = fakeDb();
	const state = await warmRun(db, ["https://x.com/v/"]);
	await claimWork(db, 4, 0);
	await recordBatch(db, state.generation, 1, 0, 0, ["https://x.com/v/"]);
	assert.equal((await claimWork(db, 4, REVISIT_DELAY_MS)).kind, "revisit");
	// …and that batch is never recorded.
	assert.equal(await claimWork(db, 4, REVISIT_DELAY_MS + 1000), null);
	assert.equal((await readWarmState(db)).phase, "warm");
	assert.equal(await claimWork(db, 4, REVISIT_DELAY_MS + 3 * 60_000), null);
	const done = await readWarmState(db);
	assert.equal(done.phase, "done");
	assert.equal(done.revisitGaveUp, 1);
	assert.deepEqual(queueRows(db), []);
});

test("queue rows of every older run are cleared, even ones a failed cleanup left behind; a newer run's stay", async () => {
	const db = fakeDb();
	// Thirteen leftover runs (the LIKE-based cleanup never deleted anything on D1), then the current one.
	for (let i = 0; i < 13; i++) await writeWarmQueue(db, `17912${String(i).padStart(8, "0")}-old${i}`, ["https://x.com/"]);
	db.rows.set("plugin:coywolf-pack:pageCache:warmQueueish", "not ours");
	db.rows.set("plugin:coywolf-pack:pageCache:warmState2", "not ours");
	const fresh = await startWarm(db, "deploy");
	assert.deepEqual(queueRows(db).filter((n) => !n.endsWith("ish")), [], "starting a run clears every other run's rows");
	assert.ok(db.rows.has("plugin:coywolf-pack:pageCache:warmQueueish"), "rows outside the queue prefix stay");

	// Finishing a run clears its rows and older ones, never a newer run's.
	const s = site(["/a/"]);
	await warmStep(db, s, "https://x.com", { budgetMs: 10_000, batchSize: 1, now: () => Date.now() });
	assert.equal((await readWarmState(db)).generation, fresh.generation);
	const newer = `${Date.now() + 60_000}-newer`;
	const older = `${Date.now() - 60_000}-older`;
	const current = await warmRun(db, ["https://x.com/a/"]);
	await writeWarmQueue(db, newer, ["https://x.com/n/"]);
	await writeWarmQueue(db, older, ["https://x.com/o/"]);
	const claim = await claimWork(db, 4);
	await recordBatch(db, current.generation, claim.urls.length, 0);
	assert.equal((await readWarmState(db)).phase, "done");
	assert.deepEqual(queueRows(db).filter((n) => !n.endsWith("ish")), [`${WARM_QUEUE_PREFIX}${newer}:0`]);
});

test("content edits schedule one run a minute after the last edit (debounced, capped)", async () => {
	const db = fakeDb();
	const t0 = Date.parse("2026-10-06T12:00:00Z");
	const urls = ["https://x.com/a/"];
	const done = { ...(await warmRun(db, urls)), phase: "done", next: 1, warmed: 1, finishedAt: new Date(t0 - 1000).toISOString() };
	await writeWarmState(db, done);
	const raw0 = JSON.stringify(done);
	assert.equal(warmMayHaveWork(raw0, t0), false, "a finished run has nothing to do");

	await scheduleRewarm(db, t0);
	await scheduleRewarm(db, t0 + 30_000); // an autosave or another edit pushes it back
	let state = await readWarmState(db);
	assert.equal(state.rewarmAfter, new Date(t0 + 30_000 + REWARM_DELAY_MS).toISOString());
	assert.equal(state.rewarmBy, new Date(t0 + REWARM_MAX_DELAY_MS).toISOString());
	assert.equal(state.phase, "done", "the finished run is still reported meanwhile");
	const raw = db.rows.get(WARM_STATE_OPTION);
	assert.equal(warmMayHaveWork(raw, t0 + 60_000), false, "not due yet: requests skip the warm step");
	assert.equal(warmMayHaveWork(raw, t0 + 90_000), true);
	assert.equal(await claimWork(db, 4, t0 + 60_000), null, "nothing before it's due");

	const claim = await claimWork(db, 4, t0 + 90_000);
	assert.equal(claim.kind, "collect");
	assert.equal(claim.state.reason, "edit");
	assert.notEqual(claim.state.generation, done.generation);
	assert.equal(claim.state.rewarmAfter, undefined, "the new run clears the schedule");
	assert.deepEqual(queueRows(db), [], "the old run's rows go");
	assert.equal(await claimWork(db, 4, t0 + 91_000), null, "the collect step is taken once");
});

test("edits that keep coming still get a run within the cap", async () => {
	const db = fakeDb();
	const t0 = Date.parse("2026-10-06T12:00:00Z");
	for (let t = t0; t <= t0 + 10 * 60_000; t += 20_000) {
		await scheduleRewarm(db, t);
		assert.ok(Date.parse((await readWarmState(db)).rewarmAfter) <= t0 + REWARM_MAX_DELAY_MS);
		// Steps run with the traffic; once due, the run starts and the next edit schedules afresh.
		const claim = await claimWork(db, 4, t);
		if (claim?.kind === "collect") {
			assert.equal(t, t0 + REWARM_MAX_DELAY_MS, "the first run starts at the cap");
			await finishCollect(db, claim.state.generation, [], "https://x.com");
			return;
		}
	}
	assert.fail("no run started");
});

test("an edit with no run yet stores a finished, empty row carrying the schedule", async () => {
	const db = fakeDb();
	const t0 = Date.now();
	const state = await scheduleRewarm(db, t0);
	assert.equal(state.phase, "done");
	assert.equal(state.total, 0);
	assert.equal(warmMayHaveWork(db.rows.get(WARM_STATE_OPTION), t0), false);
	assert.equal((await claimWork(db, 4, t0 + REWARM_DELAY_MS)).kind, "collect");
});

test("an edit during a run lets it go on, then replaces it when due; the old run's batches stop counting", async () => {
	const db = fakeDb();
	const t0 = Date.now();
	const urls = Array.from({ length: 10 }, (_, i) => `https://x.com/${i}/`);
	const run = await warmRun(db, urls);
	await scheduleRewarm(db, t0);
	const first = await claimWork(db, 4, t0 + 1000);
	assert.equal(first.kind, "warm", "the run goes on while the rewarm waits");
	assert.equal(first.state.generation, run.generation);
	assert.equal(warmMayHaveWork(db.rows.get(WARM_STATE_OPTION), t0 + 1000), true);
	const replaced = await claimWork(db, 4, t0 + REWARM_DELAY_MS);
	assert.equal(replaced.kind, "collect");
	await recordBatch(db, run.generation, 4, 0, t0 + REWARM_DELAY_MS);
	const state = await readWarmState(db);
	assert.equal(state.generation, replaced.state.generation);
	assert.equal(state.warmed, 0);
	assert.deepEqual(queueRows(db), []);
});

test("a batch claimed by an isolate that stopped doesn't keep the run open forever", async () => {
	const db = fakeDb();
	const t0 = Date.now();
	const urls = Array.from({ length: 6 }, (_, i) => `https://x.com/${i}/`);
	const run = await warmRun(db, urls);
	const a = await claimWork(db, 4, t0);
	const b = await claimWork(db, 4, t0 + 1000); // never recorded
	assert.equal(b.urls.length, 2);
	await recordBatch(db, run.generation, a.urls.length, 0, t0 + 2000);
	assert.equal(await claimWork(db, 4, t0 + 60_000), null);
	assert.equal((await readWarmState(db)).phase, "warm", "a recent batch may still be under way");
	assert.equal(warmMayHaveWork(db.rows.get(WARM_STATE_OPTION)), true);
	await claimWork(db, 4, t0 + 1000 + BATCH_STALE_MS);
	const state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.warmed, 4);
	assert.equal(state.failed, 2, "the lost batch counts as failed");
	assert.deepEqual(queueRows(db), []);
	// Its isolate recording late changes nothing.
	await recordBatch(db, run.generation, 2, 0, t0 + 1000 + BATCH_STALE_MS + 1);
	assert.deepEqual([(await readWarmState(db)).warmed, (await readWarmState(db)).failed], [4, 2]);
});

// ── Daily refresh ──

/** A finished run whose last batch was recorded at `finishedAt`. */
async function finishedRun(db, finishedAt) {
	const state = { ...newWarmState("deploy", new Date(finishedAt - 60_000)), phase: "done", total: 3, next: 3, warmed: 3, finishedAt: new Date(finishedAt).toISOString() };
	await writeWarmState(db, state);
	return state;
}

test("daily refresh: a new run starts a day after the last one finished, not before", async () => {
	const db = fakeDb();
	const t0 = Date.now();
	const done = await finishedRun(db, t0);
	assert.equal(nextDailyAt(done), t0 + DAILY_REFRESH_MS);
	const raw = db.rows.get(WARM_STATE_OPTION);
	assert.equal(warmMayHaveWork(raw, t0 + DAILY_REFRESH_MS - 1), false, "requests skip the warm step (no query) until it's due");
	assert.equal(await claimWork(db, 4, t0 + DAILY_REFRESH_MS - 1), null);
	assert.equal(db.rows.get(WARM_STATE_OPTION), raw, "nothing written before it's due");
	assert.equal(warmMayHaveWork(raw, t0 + DAILY_REFRESH_MS), true);
	const claim = await claimWork(db, 4, t0 + DAILY_REFRESH_MS);
	assert.equal(claim.kind, "collect");
	assert.equal(claim.state.reason, "daily");
	assert.notEqual(claim.state.generation, done.generation);
	assert.equal(nextDailyAt(claim.state), null, "no refresh due while the run goes on");
});

test("daily refresh: same pages, same order; it finishes and pushes the next one a day later", async () => {
	const db = fakeDb();
	const c = clock();
	await finishedRun(db, c.t);
	c.t += DAILY_REFRESH_MS;
	const s = site(["/new/", "/old/"]);
	assert.equal(await warmStep(db, s, "https://x.com", { budgetMs: 1000, batchSize: 4, now: c.now }), "warmed");
	assert.deepEqual(s.hits, ["https://x.com/", "https://x.com/sitemap.xml", "https://x.com/", "https://x.com/new/", "https://x.com/old/"]);
	const state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.reason, "daily");
	assert.equal(nextDailyAt(state), c.t + DAILY_REFRESH_MS);
	assert.equal(await claimWork(db, 4, c.t + 1000), null, "it doesn't loop");
});

test("daily refresh: parallel claims start it once", async () => {
	const db = fakeDb();
	const t0 = Date.now();
	await finishedRun(db, t0);
	const claims = await Promise.all(Array.from({ length: 8 }, () => claimWork(db, 4, t0 + DAILY_REFRESH_MS)));
	const started = claims.filter(Boolean);
	assert.equal(started.length, 1);
	assert.equal(started[0].kind, "collect");
	assert.equal((await claimWork(db, 4, t0 + DAILY_REFRESH_MS + 1)), null, "the collect step is taken once");
});

test("daily refresh: a run started for another reason resets the clock", async () => {
	const db = fakeDb();
	const t0 = Date.now();
	await finishedRun(db, t0);
	const later = t0 + 20 * 60 * 60_000;
	const deploy = await startWarm(db, "deploy");
	assert.equal(warmMayHaveWork(db.rows.get(WARM_STATE_OPTION), t0 + DAILY_REFRESH_MS), true, "a run under way has work");
	await writeWarmState(db, { ...deploy, phase: "done", finishedAt: new Date(later).toISOString() });
	const raw = db.rows.get(WARM_STATE_OPTION);
	assert.equal(warmMayHaveWork(raw, t0 + DAILY_REFRESH_MS), false);
	assert.equal(await claimWork(db, 4, t0 + DAILY_REFRESH_MS), null, "not due a day after the older run");
	assert.equal((await claimWork(db, 4, later + DAILY_REFRESH_MS)).state.reason, "daily");
});

test("daily refresh: content edits due at the same time win (reason edit)", async () => {
	const db = fakeDb();
	const t0 = Date.now();
	await finishedRun(db, t0);
	await scheduleRewarm(db, t0 + DAILY_REFRESH_MS - REWARM_DELAY_MS);
	assert.equal((await claimWork(db, 4, t0 + DAILY_REFRESH_MS)).state.reason, "edit");
});

test("daily refresh: with no run yet, the first warm step starts one (once)", async () => {
	const db = fakeDb();
	assert.equal(warmMayHaveWork(null), true, "no row: the warm step runs");
	const claims = await Promise.all([claimWork(db, 4), claimWork(db, 4), claimWork(db, 4)]);
	const started = claims.filter(Boolean);
	assert.equal(started.length, 1);
	assert.equal(started[0].kind, "collect");
	assert.equal(started[0].state.reason, "daily");
	assert.equal((await readWarmState(db)).generation, started[0].state.generation);
});

test("daily refresh off: no daily run (none with no row either), and requests don't wake for it; on by default", async () => {
	const db = fakeDb();
	assert.equal(warmMayHaveWork(null, Date.now(), false), false);
	assert.equal(await claimWork(db, 4, Date.now(), false), null);
	assert.equal(db.rows.has(WARM_STATE_OPTION), false, "no row written");
	const t0 = Date.now();
	await finishedRun(db, t0);
	const raw = db.rows.get(WARM_STATE_OPTION);
	const later = t0 + 3 * DAILY_REFRESH_MS;
	assert.equal(warmMayHaveWork(raw, later, false), false);
	assert.equal(await claimWork(db, 4, later, false), null);
	assert.equal(db.rows.get(WARM_STATE_OPTION), raw, "nothing started");
	const s = site(["/a/"]);
	assert.equal(await warmStep(db, s, "https://x.com", { budgetMs: 1000, batchSize: 4, now: () => later, daily: false }), "idle");
	assert.deepEqual(s.hits, []);
	// Other triggers still work with it off.
	await scheduleRewarm(db, later);
	assert.equal((await claimWork(db, 4, later + REWARM_DELAY_MS, false)).state.reason, "edit");
	// Default (no option): on.
	const db2 = fakeDb();
	await finishedRun(db2, t0);
	assert.equal(warmMayHaveWork(db2.rows.get(WARM_STATE_OPTION), later), true);
	assert.equal((await warmStep(db2, site(["/a/"]), "https://x.com", { budgetMs: 1000, batchSize: 4, now: () => later })), "warmed");
	assert.equal((await readWarmState(db2)).reason, "daily");
});

test("a failed run is retried by the daily refresh a day after it started", () => {
	const startedAt = "2026-10-01T00:00:00.000Z";
	assert.equal(nextDailyAt({ phase: "failed", startedAt }), Date.parse(startedAt) + DAILY_REFRESH_MS);
	assert.equal(nextDailyAt({ phase: "warm", startedAt }), null);
});

// ── The hourly fallback (no visitor requests reach the Worker) ──

const { warmFromCron, WARM_TASK, CRON_WARM_STEPS } = await import("./warm.ts");

test("hourly fallback: finishes a run nobody's requests drive, step after step, then stops", async () => {
	const db = fakeDb();
	const s = site(["/a/", "/b/", "/c/", "/d/", "/e/"]);
	await startWarm(db, "deploy");
	const steps = await warmFromCron(db, s, "https://x.com", { daily: true });
	assert.ok(steps.length > 1 && steps.length <= CRON_WARM_STEPS, steps.join());
	assert.notEqual(steps[0], "idle");
	assert.equal(steps.at(-1), "idle", "stops once there's nothing left");
	const state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.warmed, 6);
});

test("hourly fallback: with nothing to do it reads the progress row and stops; the daily refresh still starts on time", async () => {
	const db = fakeDb();
	const s = site(["/a/"]);
	await startWarm(db, "deploy");
	await warmFromCron(db, s, "https://x.com", { daily: true });
	const writes = db.stateWrites.length;
	assert.deepEqual(await warmFromCron(db, s, "https://x.com", { daily: true }), [], "a finished run: no step at all");
	assert.equal(db.stateWrites.length, writes, "nothing written");
	// A day later the refresh is due even if no page request reached the Worker.
	const later = Date.now() + DAILY_REFRESH_MS + 60_000;
	const steps = await warmFromCron(db, s, "https://x.com", { daily: true, now: () => later });
	assert.ok(steps.length > 0);
	assert.equal((await readWarmState(db)).reason, "daily");
	assert.match(WARM_TASK, /^[a-zA-Z][a-zA-Z0-9_-]*$/, "EmDash's task-name rule");
});

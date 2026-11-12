// Run: node --test test/images-variants.test.mjs
// Stored image sizes: keys, planning, srcsets, making the copies with a fake
// bucket and Images binding, records and the backfill on a node:sqlite D1 stand-in,
// and video posters' stored sizes.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => p;`, shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const V = await import("../src/images/variants.ts");
const store = await import("../src/images/variants-store.ts");

/** An R2 stand-in: objects by key, with list (prefix, cursor, limit), get, put, delete and head. */
function bucket(initial = {}) {
	const objects = new Map(Object.entries(initial).map(([k, v]) => [k, { body: v, options: {} }]));
	return {
		objects,
		gets: 0,
		async head(key) {
			return objects.has(key) ? {} : null;
		},
		async get(key) {
			this.gets++;
			const o = objects.get(key);
			return o ? { arrayBuffer: async () => (o.body instanceof ArrayBuffer ? o.body : new Uint8Array([1, 2, 3]).buffer) } : null;
		},
		async put(key, value, options) {
			objects.set(key, { body: value, options });
		},
		async list({ prefix, cursor, limit = 1000 }) {
			const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
			const start = cursor ? Number(cursor) : 0;
			const page = keys.slice(start, start + limit);
			const truncated = start + limit < keys.length;
			return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined };
		},
		async delete(keys) {
			for (const k of [].concat(keys)) objects.delete(k);
		},
	};
}

/** An Images binding stand-in: records each transform; `fail` decides which ones throw. */
function images({ fail = () => false, avifAs = "image/avif" } = {}) {
	const calls = [];
	return {
		calls,
		input(stream) {
			return {
				transform(t) {
					return {
						async output(o) {
							calls.push({ ...t, format: o.format, quality: o.quality });
							if (fail(t, o)) throw new Error("transform failed");
							const type = o.format === "image/avif" ? avifAs : o.format;
							return { response: () => new Response(new Uint8Array([9]), { headers: { "content-type": type } }) };
						},
					};
				},
			};
		},
	};
}

test("keys, eligibility and planned sizes", () => {
	assert.equal(V.variantKey("01ABC", 800, "webp"), `v${V.VARIANTS_VERSION}/01ABC-800.webp`);
	assert.equal(V.variantKey("01ABC", "600x315", "avif"), `v${V.VARIANTS_VERSION}/01ABC-600x315.avif`);
	assert.equal(V.variantPrefix("01ABC", 3), "v3/01ABC-");
	assert.ok(V.eligible("image/jpeg", 2000, 1000));
	assert.ok(V.eligible("image/PNG", 10, null));
	assert.equal(V.ineligibleReason("image/gif", 2000, 1), "type");
	assert.equal(V.ineligibleReason("image/svg+xml", 2000, 1), "type");
	assert.equal(V.ineligibleReason("image/avif", 2000, 1), "type");
	assert.equal(V.ineligibleReason("image/jpeg", null, 1), "no-width");
	assert.equal(V.ineligibleReason("image/jpeg", 2000, 21 * 1024 * 1024), "too-large");
	assert.deepEqual(V.plannedWidths(1000), [400, 640, 800]);
	assert.deepEqual(V.plannedWidths(1600), [400, 640, 800, 1200], "the original is the largest; equal widths aren't stored");
	assert.deepEqual(V.plannedWidths(300), []);
	assert.deepEqual(V.normalizeCrops([[600, 315], [50, 50], [600.2, 315], [0, 5], ["x", 2]]), ["50x50", "600x315"]);
	assert.deepEqual(V.plannedCrops(600, 315, ["50x50", "600x315", "900x473"]), ["50x50", "600x315"], "never upscaled");
	assert.deepEqual(V.plannedCrops(600, null, ["50x50"]), [], "no height, no crops");
});

test("srcsets list the stored widths and the original last; crops by descriptor", () => {
	const doc = { v: V.VARIANTS_VERSION, w: [400, 640, 800, 1200], c: ["50x50", "100x100"], k: "100x100,50x50", at: "" };
	const s = V.variantSrcsets("https://m", "ID", doc, "https://m/ID.jpg", 1500);
	const v = `v${V.VARIANTS_VERSION}`;
	assert.equal(s.webp, `https://m/${v}/ID-400.webp 400w, https://m/${v}/ID-640.webp 640w, https://m/${v}/ID-800.webp 800w, https://m/${v}/ID-1200.webp 1200w, https://m/ID.jpg 1500w`);
	assert.match(s.avif, new RegExp(`^https://m/${v}/ID-400\\.avif 400w, .*, https://m/ID\\.jpg 1500w$`));
	assert.equal(s.src, `https://m/${v}/ID-800.webp`);
	assert.equal(s.full, "https://m/ID.jpg");
	assert.equal(V.variantSrcsets("https://m", "ID", { ...doc, w: [] }, "https://m/ID.jpg", 300).src, "https://m/ID.jpg");
	const c = V.cropSrcsets("https://m", "ID", doc, [["50x50", "1x"], ["100x100", "2x"]]);
	assert.equal(c.avif, `https://m/${v}/ID-50x50.avif 1x, https://m/${v}/ID-100x100.avif 2x`);
	assert.equal(c.src, `https://m/${v}/ID-50x50.webp`);
});

test("crop states: stored, never (too big, not a site crop, skipped), missing (widths stored, crop not yet), none (no current record)", () => {
	V.setImageCrops([[50, 50], [900, 473], [64, 64]]);
	const doc = { v: V.VARIANTS_VERSION, w: [400], c: ["50x50"], at: "" };
	assert.equal(V.cropState(doc, "50x50", 800, 600), "stored");
	assert.equal(V.cropState(doc, "900x473", 800, 600), "never", "larger than the original");
	assert.equal(V.cropState(doc, "64x64", 800, 600), "missing");
	assert.equal(V.cropState(doc, "70x70", 800, 600), "never", "not one of the site's crops");
	assert.equal(V.cropState(doc, "64x64", 800, null), "never", "unknown height");
	assert.equal(V.cropState({ ...doc, v: V.VARIANTS_VERSION + 1 }, "50x50", 800, 600), "none");
	assert.equal(V.cropState({ v: V.VARIANTS_VERSION, w: [], skip: "type", at: "" }, "50x50", 800, 600), "never");
	assert.equal(V.cropState(null, "50x50", 800, 600), "none");
	V.setImageCrops([]);
});

test("generateVariants stores WebP and AVIF for each width and crop, with the right metadata", async () => {
	const b = bucket({ "ID.jpg": new Uint8Array([1, 2, 3]).buffer });
	const img = images();
	const doc = await V.generateVariants({ bucket: b, images: img, key: "ID.jpg", id: "ID", width: 1000, height: 800, focal: { x: 0.25, y: 0.75 }, crops: ["600x315", "1200x630"], now: () => new Date(0) });
	assert.deepEqual(doc, { v: V.VARIANTS_VERSION, w: [400, 640, 800], c: ["600x315"], at: "1970-01-01T00:00:00.000Z" });
	const v = `v${V.VARIANTS_VERSION}`;
	for (const size of [400, 640, 800, "600x315"]) {
		for (const ext of ["webp", "avif"]) {
			const o = b.objects.get(`${v}/ID-${size}.${ext}`);
			assert.ok(o, `${size}.${ext}`);
			assert.equal(o.options.httpMetadata.contentType, `image/${ext}`);
			assert.equal(o.options.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
		}
	}
	assert.equal(b.gets, 1, "the original is read once");
	const crop = img.calls.find((c) => c.height === 315 && c.format === "image/webp");
	assert.deepEqual(crop, { width: 600, height: 315, fit: "cover", gravity: { x: 0.25, y: 0.75 }, format: "image/webp", quality: 85 });
	assert.equal(img.calls.find((c) => c.format === "image/avif").quality, 80);
	// 800 wide is 640 tall: AVIF is made (both sides within 1200).
	assert.ok(img.calls.some((c) => c.width === 800 && c.format === "image/avif"));

	// Everything's there: nothing is read or transformed again.
	const again = images();
	await V.generateVariants({ bucket: b, images: again, key: "ID.jpg", id: "ID", width: 1000, height: 800, crops: ["600x315"] });
	assert.equal(again.calls.length, 0);
	assert.equal(b.gets, 1);
});

test("generateVariants: AVIF beyond Cloudflare's limit or failing is stored as the WebP; WebP failing throws", async () => {
	const b = bucket({ "T.png": new Uint8Array([1]).buffer });
	const img = images({ fail: (t, o) => o.format === "image/avif" && t.width === 400 });
	// Tall image: 1200 wide is about 1850 tall, beyond AVIF's 1200 limit.
	await V.generateVariants({ bucket: b, images: img, key: "T.png", id: "T", width: 1300, height: 2000, crops: [] });
	const v = `v${V.VARIANTS_VERSION}`;
	assert.equal(b.objects.get(`${v}/T-400.avif`).options.httpMetadata.contentType, "image/webp", "failed AVIF → the WebP under .avif");
	assert.equal(b.objects.get(`${v}/T-1200.avif`).options.httpMetadata.contentType, "image/webp");
	assert.ok(!img.calls.some((c) => c.width === 1200 && c.format === "image/avif"), "no AVIF attempt beyond the limit");
	assert.equal(b.objects.get(`${v}/T-640.avif`).options.httpMetadata.contentType, "image/avif");

	const broken = bucket({ "X.jpg": new Uint8Array([1]).buffer });
	await assert.rejects(V.generateVariants({ bucket: broken, images: images({ fail: (t, o) => o.format === "image/webp" }), key: "X.jpg", id: "X", width: 900, crops: [] }));
	await assert.rejects(V.generateVariants({ bucket: bucket(), images: images(), key: "missing.jpg", id: "missing", width: 900, crops: [] }), /isn't in the media bucket/);
});

test("deleting an image's copies and an old version", async () => {
	const b = bucket({ "v1/A-400.webp": 1, "v1/A-400.avif": 1, "v1/AB-400.webp": 1, "v2/A-400.webp": 1, "A.jpg": 1 });
	await V.deleteVariants(b, [1, 2], "A");
	assert.deepEqual([...b.objects.keys()].sort(), ["A.jpg", "v1/AB-400.webp"], "other images (even with a shared prefix) stay");
	const many = bucket(Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`v7/I${i}-400.webp`, 1])));
	assert.equal(await V.deleteVersion(many, 7, 60_000), true);
	assert.equal(many.objects.size, 0);
	assert.equal(await V.deleteVersion(many, 0, 1), true, "no version 0");
});

// ── Records and the backfill on a D1 stand-in ─────────────────────

function d1() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT DEFAULT '0' NOT NULL);
		CREATE TABLE _plugin_storage (plugin_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT, updated_at TEXT, revision TEXT DEFAULT '0' NOT NULL, PRIMARY KEY (plugin_id, collection, id));
		CREATE TABLE media (id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, size INTEGER, width INTEGER, height INTEGER, storage_key TEXT, status TEXT, focal_x REAL, focal_y REAL, created_at TEXT DEFAULT '2020-01-01 00:00:00');
	`);
	const wrap = {
		sqlite: db,
		prepare(sql) {
			const stmt = db.prepare(sql);
			const bound = (values) => ({
				async run() {
					const r = stmt.run(...values);
					return { meta: { changes: Number(r.changes) } };
				},
				async first() {
					return stmt.get(...values) ?? null;
				},
				async all() {
					return { results: stmt.all(...values) };
				},
			});
			return { bind: (...values) => bound(values), ...bound([]) };
		},
	};
	return wrap;
}

function addMedia(db, id, ext, mime, width, height, size = 1000) {
	db.sqlite.prepare("INSERT INTO media (id, filename, mime_type, size, width, height, storage_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')").run(id, `${id}.${ext}`, mime, size, width, height, `${id}.${ext}`);
}

test("the backfill makes missing widths (no crops), skips what can't have them, records failures for later, and finishes", async () => {
	V.setImageCrops([[400, 210]]);
	const db = d1();
	const b = bucket();
	for (let i = 0; i < 12; i++) {
		const id = `01M${String(i).padStart(2, "0")}`;
		addMedia(db, id, "jpg", "image/jpeg", 1000, 600);
		b.objects.set(`${id}.jpg`, { body: new Uint8Array([1]).buffer, options: {} });
	}
	addMedia(db, "01N00", "gif", "image/gif", 500, 500); // Not a type that gets sizes: not even counted.
	addMedia(db, "01N01", "png", "image/png", null, null); // No width: skipped (recorded).
	addMedia(db, "01N02", "jpg", "image/jpeg", 900, 600); // Not in the bucket: fails.
	const deps = { db, bucket: b, images: images() };
	let upgraded = 0;
	deps.upgradePosters = async () => (upgraded++, true);

	let state = await store.backfillStep(deps, { budgetMs: 60_000, maxImages: 6 });
	assert.equal(state.phase, "running");
	assert.equal(state.done, 10, "batches of five, until at least six were handled");
	state = await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.equal(state.phase, "done");
	assert.deepEqual({ done: state.done, skipped: state.skipped, failed: state.failed }, { done: 12, skipped: 1, failed: 1 });
	assert.equal(upgraded, 1, "legacy posters were upgraded during cleanup");
	assert.deepEqual(await store.variantCounts(db), { total: 14, stored: 12, skipped: 1 });
	const doc = V.parseDoc(db.sqlite.prepare("SELECT data FROM _plugin_storage WHERE id = '01M00'").get().data);
	assert.deepEqual(doc, { v: V.VARIANTS_VERSION, w: [400, 640, 800], c: [], at: doc.at }, "widths only: crops are made on first use");
	assert.ok(!deps.images.calls.some((c) => c.fit === "cover"), "no crops made");

	// A finished run waits a day before starting over; the admin can force it.
	const calls = deps.images.calls.length;
	state = await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.equal(state.phase, "done");
	assert.equal(deps.images.calls.length, calls);
	await store.startVariantsRun(db, { force: true });
	b.objects.set("01N02.jpg", { body: new Uint8Array([1]).buffer, options: {} });
	state = await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.deepEqual({ phase: state.phase, done: state.done, failed: state.failed }, { phase: "done", done: 1, failed: 0 }, "only the missing one is made");
	assert.deepEqual(await store.variantCounts(db), { total: 14, stored: 13, skipped: 1 });
	V.setImageCrops([]);
});

test("two workers never claim the same images", async () => {
	const db = d1();
	const b = bucket();
	for (let i = 0; i < 20; i++) {
		const id = `01P${String(i).padStart(2, "0")}`;
		addMedia(db, id, "jpg", "image/jpeg", 1000, 600);
		b.objects.set(`${id}.jpg`, { body: new Uint8Array([1]).buffer, options: {} });
	}
	const img = images();
	const [a, c] = await Promise.all([store.backfillStep({ db, bucket: b, images: img }, { budgetMs: 60_000 }), store.backfillStep({ db, bucket: b, images: img }, { budgetMs: 60_000 })]);
	const { state } = await store.readVariantsState(db);
	assert.equal(state.done, 20);
	assert.equal(img.calls.length, 20 * 3 * 2, "each image's three widths × two formats, once");
	assert.ok(a && c);
});

test("records: written, replaced, removed with the copies", async () => {
	const db = d1();
	const b = bucket({ [`v${V.VARIANTS_VERSION}/Z-400.webp`]: 1 });
	await store.writeVariantRecord(db, "Z", { v: 1, w: [400], at: "" });
	await store.writeVariantRecord(db, "Z", { v: 1, w: [400, 640], at: "" });
	const rows = db.sqlite.prepare("SELECT data, revision FROM _plugin_storage").all();
	assert.equal(rows.length, 1);
	assert.deepEqual(JSON.parse(rows[0].data).w, [400, 640]);
	assert.notEqual(rows[0].revision, "0");
	await store.forgetMedia({ db, bucket: b }, "Z");
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _plugin_storage").get().n, 0);
	assert.equal(b.objects.size, 0);
});

// ── Video posters ──────────────────────────────────────────────────

test("a new poster gets stored sizes and is listed with the version; legacy entries keep /s/", async () => {
	const { mediaPoster, posterKey, posterEntry, resetMirroredPosters } = await import("../src/videos/poster.ts");
	resetMirroredPosters();
	const UID = "a67dcf0925d0747f8c5419df6400c2b5";
	const SRC = `https://customer-x.cloudflarestream.com/${UID}/thumbnails/thumbnail.jpg?time=3s&width=1600`;
	const b = bucket();
	const listed = new Set();
	const deferred = [];
	const img = images();
	const fetcher = async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/jpeg" } });
	const deps = { cdn: "https://m", bucket: b, images: img, listed, list: async (k) => void listed.add(k), defer: (p) => deferred.push(p), fetcher };
	assert.equal(await mediaPoster(UID, SRC, deps), null);
	await Promise.all(deferred);
	const key = await posterKey(UID, SRC);
	assert.ok(listed.has(posterEntry(key)));
	assert.equal(posterEntry(key), `${key}#v${V.VARIANTS_VERSION}`);
	const id = key.replace(/\.jpg$/, "");
	const v = `v${V.VARIANTS_VERSION}`;
	for (const w of [400, 800, 1200]) assert.ok(b.objects.has(`${v}/${id}-${w}.webp`) && b.objects.has(`${v}/${id}-${w}.avif`));
	const media = await mediaPoster(UID, SRC, { ...deps, listed: new Set([posterEntry(key)]) });
	assert.equal(media.src, `https://m/${v}/${id}-800.webp`);
	assert.equal(media.full, `https://m/${v}/${id}-1200.webp`);
	assert.match(media.avif, /-400\.avif 400w, .*-800\.avif 800w, .*-1200\.avif 1200w$/);

	resetMirroredPosters();
	const legacy = await mediaPoster(UID, SRC, { ...deps, listed: new Set([key]), defer: () => assert.fail("no work for a listed poster") });
	assert.equal(legacy.src, `https://m/s/800/${key}`);
	assert.equal(legacy.avif, undefined);
});

test("legacy listed posters are upgraded to stored sizes; ones that can't be are unlisted", async () => {
	const { upgradeListedPosters, POSTERS_OPTION } = await import("../src/videos/poster.ts");
	const db = d1();
	const b = bucket({ "cwposter-a-1.jpg": new Uint8Array([1]).buffer });
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run(POSTERS_OPTION, JSON.stringify(["cwposter-a-1.jpg", "cwposter-b-2.jpg", `cwposter-c-3.jpg#v${V.VARIANTS_VERSION}`]));
	assert.equal(await upgradeListedPosters(db, b, images(), Date.now() + 60_000), true);
	const list = JSON.parse(db.sqlite.prepare("SELECT value FROM options WHERE name = ?").get(POSTERS_OPTION).value);
	assert.deepEqual(list.sort(), [`cwposter-a-1.jpg#v${V.VARIANTS_VERSION}`, `cwposter-c-3.jpg#v${V.VARIANTS_VERSION}`]);
	assert.ok(b.objects.has(`v${V.VARIANTS_VERSION}/cwposter-a-1-400.webp`));

	// Many legacy posters: a bounded number per call (subrequests), the rest next time.
	const { POSTER_UPGRADES_PER_CALL } = await import("../src/videos/poster.ts");
	const many = Array.from({ length: POSTER_UPGRADES_PER_CALL + 2 }, (_, i) => `cwposter-m-${i}.jpg`);
	const mb = bucket(Object.fromEntries(many.map((k) => [k, new Uint8Array([1]).buffer])));
	db.sqlite.prepare("UPDATE options SET value = ? WHERE name = ?").run(JSON.stringify(many), POSTERS_OPTION);
	assert.equal(await upgradeListedPosters(db, mb, images(), Date.now() + 60_000), false);
	const after = JSON.parse(db.sqlite.prepare("SELECT value FROM options WHERE name = ?").get(POSTERS_OPTION).value);
	assert.equal(after.filter((e) => e.endsWith(`#v${V.VARIANTS_VERSION}`)).length, POSTER_UPGRADES_PER_CALL);
	assert.equal(after.length, many.length, "none unlisted");
	assert.equal(await upgradeListedPosters(db, mb, images(), Date.now() + 60_000), true);
});

// ── Media writes (middleware) ──────────────────────────────────────

test("after media writes: a delete removes copies and record; replaced files get sizes; imports run the backfill; confirms are left to the upload hook", async () => {
	const { variantsAfterMediaWrite } = await import("../src/images/pack.ts");
	const { setStoragePublicUrl: setImageCdn } = await import("../src/images/lib.ts");
	const db = d1();
	const v = `v${V.VARIANTS_VERSION}`;
	const b = bucket({ [`${v}/01D-400.webp`]: 1, [`${v}/01E-400.webp`]: 1 });
	await store.writeVariantRecord(db, "01D", { v: 1, w: [400], at: "" });
	globalThis.__testEnv = { DB: db, MEDIA: b, IMAGES: images() };

	assert.equal(variantsAfterMediaWrite("GET", "/_emdash/api/media/01D", true), null);
	assert.equal(variantsAfterMediaWrite("DELETE", "/_emdash/api/media/folders/x", true), null);
	assert.equal(variantsAfterMediaWrite("POST", "/_emdash/api/media/01D/confirm", true), null, "EmDash 1.2 runs media:afterUpload after a confirm");
	await variantsAfterMediaWrite("DELETE", "/_emdash/api/media/01D", false);
	assert.deepEqual([...b.objects.keys()], [`${v}/01E-400.webp`], "deleted even with the feature off");
	assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM _plugin_storage").get().n, 0);

	setImageCdn("https://media.example.com");
	addMedia(db, "01F", "jpg", "image/jpeg", 700, 500);
	b.objects.set("01F.jpg", { body: new Uint8Array([1]).buffer, options: {} });
	assert.equal(variantsAfterMediaWrite("POST", "/_emdash/api/media/01F/confirm", true), null);
	// The upload hook's work: sizes once; a second call (hook and backfill on the same image) makes nothing.
	const imgs = images();
	const deps = { db, bucket: b, images: imgs };
	const row = await store.mediaRow(db, "01F");
	assert.equal(await store.processMedia(deps, row), "done");
	const made = imgs.calls.length;
	assert.ok(made > 0 && b.objects.has(`${v}/01F-640.avif`));
	assert.equal(await store.processMedia(deps, row), "done");
	assert.equal(imgs.calls.length, made, "already made: no transformations");
	const rev = () => db.sqlite.prepare("SELECT revision FROM _plugin_storage WHERE id = '01F'").get().revision;
	const before = rev();
	assert.equal(await store.processMedia(deps, row, undefined, { force: true }), "done");
	assert.notEqual(rev(), before, "forced: done again and recorded");
	assert.deepEqual(V.parseDoc(db.sqlite.prepare("SELECT data FROM _plugin_storage WHERE id = '01F'").get().data).w, [400, 640]);
	assert.equal(variantsAfterMediaWrite("POST", "/_emdash/api/media/01F/replace", true), null, "EmDash replaces with PUT, not POST");
	assert.equal(variantsAfterMediaWrite("PUT", "/_emdash/api/media/01F/confirm", true), null);
	// A replaced file (PUT …/replace): the old copies go and the new file's sizes are made.
	db.sqlite.prepare("UPDATE media SET width = 500, height = 300 WHERE id = '01F'").run();
	await variantsAfterMediaWrite("PUT", "/_emdash/api/media/01F/replace", true);
	assert.ok(!b.objects.has(`${v}/01F-640.avif`), "sizes the smaller replacement doesn't have are gone");
	assert.deepEqual(V.parseDoc(db.sqlite.prepare("SELECT data FROM _plugin_storage WHERE id = '01F'").get().data).w, [400]);

	addMedia(db, "01G", "png", "image/png", 900, 500);
	b.objects.set("01G.png", { body: new Uint8Array([1]).buffer, options: {} });
	const { invalidateFeatures } = await import("../src/core/features.ts");
	invalidateFeatures();
	await variantsAfterMediaWrite("POST", "/_emdash/api/import/wordpress/media", true);
	assert.ok(!b.objects.has(`${v}/01G-800.webp`), "sizes for existing images are off: an import starts nothing");
	await setBulk(db, true);
	await variantsAfterMediaWrite("POST", "/_emdash/api/import/wordpress/media", true);
	assert.ok(b.objects.has(`${v}/01G-800.webp`), "the import's media got sizes once turned on");
	setImageCdn(null);
	globalThis.__testEnv = undefined;
});

function setBulk(db, on) {
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run("plugin:coywolf-pack:settings:imagesVariantsBulk", JSON.stringify(on));
	return import("../src/core/features.ts").then((f) => f.invalidateFeatures());
}

test("the hourly backfill does nothing until sizes for existing images are turned on", async () => {
	const { startBackfillChain: runVariantsBackfill } = await import("../src/images/pack.ts");
	const { setStoragePublicUrl: setImageCdn } = await import("../src/images/lib.ts");
	const { invalidateFeatures } = await import("../src/core/features.ts");
	const db = d1();
	const b = bucket();
	addMedia(db, "01H", "jpg", "image/jpeg", 900, 500);
	b.objects.set("01H.jpg", { body: new Uint8Array([1]).buffer, options: {} });
	const img = images();
	globalThis.__testEnv = { DB: db, MEDIA: b, IMAGES: img };
	setImageCdn("https://media.example.com");
	invalidateFeatures();
	assert.equal(await runVariantsBackfill(), null);
	assert.equal(img.calls.length, 0);
	assert.equal((await store.readVariantsState(db)).state, null, "not even a run started");
	await setBulk(db, true);
	// Without the SELF binding, one step runs right here.
	const state = await runVariantsBackfill();
	assert.equal(state.phase, "done");
	assert.equal(state.done, 1);
	assert.equal(state.lease, undefined, "the lease is let go");
	setImageCdn(null);
	globalThis.__testEnv = undefined;
});

test("crops made on first use are merged into the record without dropping others", async () => {
	const db = d1();
	assert.equal(await store.addCrops(db, "Q", ["50x50"]), false, "no record: nothing to add to");
	await store.writeVariantRecord(db, "Q", { v: V.VARIANTS_VERSION, w: [400], c: [], at: "" });
	assert.equal(await store.addCrops(db, "Q", ["50x50", "100x100"]), true);
	assert.equal(await store.addCrops(db, "Q", ["100x100", "64x64"]), true);
	assert.deepEqual(V.parseDoc(db.sqlite.prepare("SELECT data FROM _plugin_storage WHERE id = 'Q'").get().data).c.sort(), ["100x100", "50x50", "64x64"]);
	await store.writeVariantRecord(db, "R", { v: V.VARIANTS_VERSION, w: [], skip: "type", at: "" });
	assert.equal(await store.addCrops(db, "R", ["50x50"]), false, "skipped images get none");
	await store.writeVariantRecord(db, "S", { v: V.VARIANTS_VERSION, w: [400], at: "" });
	assert.equal(await store.addCrops(db, "S", ["50x50"]), true, "a record without a crop list gets one");
	assert.deepEqual(V.parseDoc(db.sqlite.prepare("SELECT data FROM _plugin_storage WHERE id = 'S'").get().data).c, ["50x50"]);
});

test("renders: stopgaps only when sizes are coming; missing crops are made after the response; small images have no <picture>", async () => {
	const pack = await import("../src/images/pack.ts");
	const { setStoragePublicUrl: setImageCdn } = await import("../src/images/lib.ts");
	const { invalidateFeatures } = await import("../src/core/features.ts");
	const { PENDING_MEDIA_LOCAL } = await import("../src/images/pending.ts");
	const db = d1();
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify({ images: true }));
	const b = bucket();
	const img = images();
	globalThis.__testEnv = { DB: db, MEDIA: b, IMAGES: img };
	setImageCdn("https://media.example.com");
	invalidateFeatures();
	V.setImageCrops([[400, 210], [50, 50]]);
	pack.resetCropJobs();
	const url = (id, ext = "jpg") => `https://media.example.com/${id}.${ext}`;
	const render = async (fn) => {
		const locals = {};
		const out = await fn(locals);
		return { out, stopgap: Boolean(locals[PENDING_MEDIA_LOCAL]) };
	};
	const thumbs = [[400, 210, "400w"]];

	// An existing image without a record, bulk off: plain /s/, no stopgap, nothing made.
	addMedia(db, "01OLD", "jpg", "image/jpeg", 1000, 600);
	let r = await render((locals) => pack.responsiveImage(url("01OLD"), { locals }));
	assert.deepEqual(r, { out: null, stopgap: false });
	r = await render((locals) => pack.croppedImage(url("01OLD"), thumbs, { locals }));
	assert.deepEqual(r, { out: null, stopgap: false });
	await pack.cropsIdle();
	assert.equal(img.calls.length, 0, "no generation without a record");

	// A fresh upload (sizes on their way): stopgap.
	db.sqlite.prepare("INSERT INTO media (id, filename, mime_type, size, width, height, storage_key, status, created_at) VALUES ('01NEW', '01NEW.jpg', 'image/jpeg', 1000, 1000, 600, '01NEW.jpg', 'ready', datetime('now'))").run();
	r = await render((locals) => pack.responsiveImage(url("01NEW"), { locals }));
	assert.deepEqual(r, { out: null, stopgap: true });

	// Bulk on: older images wait for the backfill without shortening pages (its run clears the cache once when done).
	await setBulk(db, true);
	pack.forgetInfo("01OLD");
	r = await render((locals) => pack.responsiveImage(url("01OLD"), { locals }));
	assert.deepEqual(r, { out: null, stopgap: false });
	r = await render((locals) => pack.croppedImage(url("01OLD"), thumbs, { locals }));
	assert.deepEqual(r, { out: null, stopgap: false });
	await setBulk(db, false);

	// Widths stored, crop missing: /s/ now (stopgap), the crop is made after the response, then used.
	addMedia(db, "01W", "jpg", "image/jpeg", 1000, 600);
	b.objects.set("01W.jpg", { body: new Uint8Array([1]).buffer, options: {} });
	await store.writeVariantRecord(db, "01W", { v: V.VARIANTS_VERSION, w: [400, 640, 800], c: [], at: "" });
	r = await render((locals) => pack.responsiveImage(url("01W"), { locals }));
	assert.ok(r.out && !r.stopgap);
	r = await render((locals) => pack.croppedImage(url("01W"), thumbs, { locals }));
	assert.deepEqual(r, { out: null, stopgap: true });
	r = await render((locals) => pack.croppedImage(url("01W"), thumbs, { locals }));
	assert.equal(r.stopgap, true, "still on its way");
	await pack.cropsIdle();
	assert.equal(img.calls.filter((c) => c.fit === "cover").length, 2, "one crop × two formats, made once");
	assert.ok(!img.calls.some((c) => c.fit !== "cover"), "no widths remade");
	r = await render((locals) => pack.croppedImage(url("01W"), thumbs, { locals }));
	assert.equal(r.stopgap, false);
	assert.match(r.out.webp, /01W-400x210\.webp 400w$/);

	// A crop that isn't one of the site's, or a failed one: /s/ without waiting.
	r = await render((locals) => pack.croppedImage(url("01W"), [[300, 300, "1x"]], { locals }));
	assert.deepEqual(r, { out: null, stopgap: false });
	addMedia(db, "01X", "jpg", "image/jpeg", 1000, 600); // Not in the bucket: the crop fails.
	await store.writeVariantRecord(db, "01X", { v: V.VARIANTS_VERSION, w: [400], c: [], at: "" });
	r = await render((locals) => pack.croppedImage(url("01X"), [[50, 50, "1x"]], { locals }));
	assert.equal(r.stopgap, true);
	await pack.cropsIdle();
	r = await render((locals) => pack.croppedImage(url("01X"), [[50, 50, "1x"]], { locals }));
	assert.deepEqual(r, { out: null, stopgap: false }, "failed recently: not retried yet");

	// Under 400 pixels: a record with no widths gives no <picture>, and no stopgap.
	addMedia(db, "01S", "png", "image/png", 300, 200);
	await store.writeVariantRecord(db, "01S", { v: V.VARIANTS_VERSION, w: [], c: [], at: "" });
	r = await render((locals) => pack.responsiveImage(url("01S", "png"), { locals }));
	assert.deepEqual(r, { out: null, stopgap: false });

	V.setImageCrops([]);
	pack.resetCropJobs();
	setImageCdn(null);
	globalThis.__testEnv = undefined;
});

test("crops: a job that never settles (its request was canceled) doesn't stop the crops queued after it", { timeout: 3_000 }, async () => {
	const pack = await import("../src/images/pack.ts");
	const { setStoragePublicUrl: setImageCdn } = await import("../src/images/lib.ts");
	const { invalidateFeatures } = await import("../src/core/features.ts");
	const { DEADLINES } = await import("../src/core/single-flight.ts");
	const saved = DEADLINES.cropJobMs;
	DEADLINES.cropJobMs = 40;
	const db = d1();
	db.sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:coywolf-pack:settings:features", JSON.stringify({ images: true }));
	const b = bucket();
	const img = images();
	globalThis.__testEnv = { DB: db, MEDIA: b, IMAGES: img };
	setImageCdn("https://media.example.com");
	invalidateFeatures();
	V.setImageCrops([[400, 210]]);
	pack.resetCropJobs();
	const thumbs = [[400, 210, "400w"]];
	for (const id of ["01HANG", "01NEXT"]) {
		addMedia(db, id, "jpg", "image/jpeg", 1000, 600);
		b.objects.set(`${id}.jpg`, { body: new Uint8Array([1]).buffer, options: {} });
		await store.writeVariantRecord(db, id, { v: V.VARIANTS_VERSION, w: [400, 640, 800], c: [], at: "" });
	}
	// The first image's original never arrives, and its job's deadline timer goes with its canceled request.
	const get = b.get.bind(b);
	b.get = (key) => (key === "01HANG.jpg" ? new Promise(() => {}) : get(key));
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => (ms === DEADLINES.cropJobMs ? 0 : realSetTimeout(fn, ms, ...args));
	await pack.croppedImage("https://media.example.com/01HANG.jpg", thumbs, { locals: {} });
	globalThis.setTimeout = realSetTimeout;
	await new Promise((resolve) => setTimeout(resolve, 50)); // Past that job's end.
	await pack.croppedImage("https://media.example.com/01NEXT.jpg", thumbs, { locals: {} });
	await pack.cropsIdle();
	assert.ok(b.objects.has(`v${V.VARIANTS_VERSION}/01NEXT-400x210.webp`), "the next image's crop was made");
	assert.ok(!b.objects.has(`v${V.VARIANTS_VERSION}/01HANG-400x210.webp`));

	// A job that's merely slow ends at its deadline (and is retried later); the one behind it runs.
	pack.resetCropJobs();
	const errors = [];
	const error = console.error;
	console.error = (...args) => errors.push(args.map(String).join(" "));
	try {
		await pack.croppedImage("https://media.example.com/01HANG.jpg", [[400, 210, "1x"]], { locals: {} });
		await pack.cropsIdle();
	} finally {
		console.error = error;
	}
	assert.match(errors[0], /couldn't make crops 400x210 of 01HANG.*took longer than 40 ms/);

	DEADLINES.cropJobMs = saved;
	V.setImageCrops([]);
	pack.resetCropJobs();
	setImageCdn(null);
	globalThis.__testEnv = undefined;
});

test("a run stops where it is once sizes for existing images are turned off (keepGoing)", async () => {
	const db = d1();
	const b = bucket();
	for (let i = 0; i < 12; i++) {
		const id = `01K${String(i).padStart(2, "0")}`;
		addMedia(db, id, "jpg", "image/jpeg", 1000, 600);
		b.objects.set(`${id}.jpg`, { body: new Uint8Array([1]).buffer, options: {} });
	}
	let on = true;
	let batches = 0;
	let upgraded = 0;
	const deps = {
		db,
		bucket: b,
		images: images(),
		upgradePosters: async () => (upgraded++, true),
		keepGoing: async () => (batches++ < 1 ? on : (on = false)),
	};
	let state = await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.equal(state.phase, "running", "stopped mid-way, not finished");
	assert.equal(state.done, 5, "one batch was made before the switch was seen off");
	assert.equal(upgraded, 0, "no cleanup (poster upgrades) either");
	const calls = deps.images.calls.length;
	state = await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.equal(deps.images.calls.length, calls, "off: nothing more is made");
	assert.equal(state.phase, "running");
	// Turned back on: a fresh run finishes the library.
	on = true;
	deps.keepGoing = async () => on;
	await store.startVariantsRun(db, { force: true });
	state = await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.equal(state.phase, "done");
	assert.deepEqual(await store.variantCounts(db), { total: 12, stored: 12, skipped: 0 });
});

// ── The backfill's chain of steps ──────────────────────────────────

/** A library of `n` images (1000 × 600 JPEGs: three widths each) in the database and bucket. */
function library(db, b, n, prefix = "01C") {
	for (let i = 0; i < n; i++) {
		const id = `${prefix}${String(i).padStart(4, "0")}`;
		addMedia(db, id, "jpg", "image/jpeg", 1000, 600);
		b.objects.set(`${id}.jpg`, { body: new Uint8Array([1]).buffer, options: {} });
	}
}

/**
 * The SELF service binding: hands each POST to the internal endpoint, and keeps
 * each step's background work (waitUntil) to run one at a time (drain), so the
 * test can see what each step did.
 */
function selfBinding(pack, img) {
	const pending = [];
	const steps = [];
	const self = {
		requests: [],
		async fetch(request) {
			self.requests.push({ method: request.method, step: request.headers.get("X-Coywolf-Backfill-Step") });
			const response = await pack.handleBackfillRequest(request, (p) => pending.push(p));
			return response ?? new Response("Not found", { status: 404 });
		},
	};
	const drain = async () => {
		while (pending.length) {
			const before = img.calls.length;
			await pending.shift();
			steps.push((img.calls.length - before) / 6);
		}
	};
	return { self, steps, drain };
}

async function chainSetup(n) {
	const pack = await import("../src/images/pack.ts");
	const { setStoragePublicUrl: setImageCdn } = await import("../src/images/lib.ts");
	const db = d1();
	const b = bucket();
	library(db, b, n);
	const img = images();
	const s = selfBinding(pack, img);
	globalThis.__testEnv = { DB: db, MEDIA: b, IMAGES: img, SELF: s.self };
	setImageCdn("https://media.example.com");
	await setBulk(db, true);
	const done = () => {
		setImageCdn(null);
		globalThis.__testEnv = undefined;
	};
	return { pack, db, b, img, ...s, done };
}

test("the backfill runs back to back in steps of their own (≤ 25 images each) until the run is done", async () => {
	const { pack, db, img, self, steps, drain, done } = await chainSetup(60);
	const started = await pack.startBackfillChain("https://site.test", { force: true });
	assert.ok(started.lease, "the trigger holds the run");
	assert.equal(img.calls.length, 0, "the trigger hands the work to a step of its own (no transformations in the trigger)");
	await drain();
	const { state } = await store.readVariantsState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.done, 60);
	assert.equal(state.lease, undefined, "a finished run has no chain");
	assert.ok(steps.every((n) => n <= pack.STEP_BUDGET.maxImages), `each step stays within its budget: ${steps}`);
	assert.deepEqual(steps.slice(0, 3), [25, 25, 10], "batches of five, 25 images a step");
	assert.deepEqual(
		self.requests.map((r) => r.step),
		steps.map((_, i) => String(i + 1)),
		"each step posts the next one",
	);
	assert.equal(img.calls.length, 60 * 6, "every image made once");
	// Subrequests per step: ≤ 25 images × (1 list + 1 get + 3 widths × 4 + 1 record) plus claims, counts and the lease.
	assert.ok(pack.STEP_BUDGET.maxImages * 22 + 50 < 1000);
	done();
});

test("the chain endpoint only works for the chain holding the run", async () => {
	const { pack, db, img, drain, done } = await chainSetup(10);
	await store.startVariantsRun(db, { force: true });
	const post = (headers, method = "POST") => pack.handleBackfillRequest(new Request(`https://site.test${pack.BACKFILL_PATH}`, { method, headers }), () => assert.fail("no work may start"));
	const token = crypto.randomUUID();
	assert.equal((await post({})).status, 403, "no token");
	assert.equal((await post({ "X-Coywolf-Backfill": token, "X-Coywolf-Backfill-Step": "1" })).status, 403, "not the lease's token");
	assert.equal((await post({ "X-Coywolf-Backfill": "x", "X-Coywolf-Backfill-Step": "1" })).status, 403);
	assert.equal(await pack.handleBackfillRequest(new Request("https://site.test/other"), () => {}), undefined, "other paths aren't touched");
	// The lease's own token works, but not with GET or an out-of-range step.
	assert.ok(await store.acquireLease(db, token));
	assert.equal((await post({ "X-Coywolf-Backfill": token, "X-Coywolf-Backfill-Step": "1" }, "GET")).status, 403);
	assert.equal((await post({ "X-Coywolf-Backfill": token, "X-Coywolf-Backfill-Step": String(pack.MAX_HOPS + 1) })).status, 403);
	assert.equal(img.calls.length, 0);
	await drain();
	done();
});

test("one chain at a time: the lease, taking over a dead chain, and what page requests look at", async () => {
	const db = d1();
	await store.startVariantsRun(db, { force: true, now: 1_000 });
	const a = await store.acquireLease(db, "a", { now: 1_000 });
	assert.equal(a.lease, "a");
	assert.equal(await store.acquireLease(db, "b", { now: 2_000 }), null, "held by another chain");
	assert.equal(await store.acquireLease(db, "b", { now: 2_000, follow: true }), null, "a step goes on only with its own token");
	assert.ok(await store.acquireLease(db, "a", { now: 2_000, follow: true }), "its own next step renews it");
	const raw = (await store.readVariantsState(db)).raw;
	assert.equal(store.backfillMayHaveWork(raw, 3_000), false, "a chain is working");
	assert.equal(store.backfillMayHaveWork(raw, 2_000 + store.LEASE_MS + 1), true, "its lease ran out: page requests start a new chain");
	assert.ok(await store.acquireLease(db, "b", { now: 2_000 + store.LEASE_MS + 1 }), "a dead chain is taken over");
	await store.releaseLease(db, "a");
	assert.equal((await store.readVariantsState(db)).state.lease, "b", "only the holder lets go");
	await store.releaseLease(db, "b");
	assert.equal(store.backfillMayHaveWork((await store.readVariantsState(db)).raw, 3_000), true);
	assert.equal(store.backfillMayHaveWork(null), false);
	assert.equal(store.backfillMayHaveWork(undefined), false, "unknown: no query to find out");
	assert.equal(store.publicState({ ...(await store.readVariantsState(db)).state, lease: "secret" }).lease, undefined, "the token never goes to the admin");
});

test("a chain stops after MAX_HOPS steps and lets go; the next trigger finishes the run", async () => {
	const { pack, db, steps, drain, done } = await chainSetup(650);
	await pack.startBackfillChain("https://site.test", { force: true });
	await drain();
	let { state } = await store.readVariantsState(db);
	assert.equal(steps.length, pack.MAX_HOPS);
	assert.equal(state.phase, "running");
	assert.equal(state.done, pack.MAX_HOPS * 25);
	assert.equal(state.lease, undefined, "let go, so a page request or the hourly job starts a new chain at once");
	await pack.startBackfillChain("https://site.test");
	await drain();
	({ state } = await store.readVariantsState(db));
	assert.deepEqual({ phase: state.phase, done: state.done }, { phase: "done", done: 650 });
	done();
});

test("Cloudflare Images rate limiting pauses the run and hands the batch back; turning sizes off stops the chain", async () => {
	const { pack, db, img, self, drain, done } = await chainSetup(12);
	let limited = true;
	const real = img.input;
	img.input = (stream) => {
		if (limited) return { transform: () => ({ output: async () => ({ response: () => new Response("", { status: 429 }) }) }) };
		return real(stream);
	};
	await pack.startBackfillChain("https://site.test", { force: true });
	await drain();
	let { state, raw } = await store.readVariantsState(db);
	assert.ok(Date.parse(state.pausedUntil) > Date.now(), "paused");
	assert.match(state.pauseReason, /limiting/);
	assert.deepEqual({ cursor: state.cursor, failed: state.failed, done: state.done, lease: state.lease }, { cursor: "", failed: 0, done: 0, lease: undefined }, "the batch is handed back, not failed");
	assert.equal(store.backfillMayHaveWork(raw), false, "page requests don't restart it while paused");
	const requests = self.requests.length;
	assert.equal((await pack.startBackfillChain("https://site.test")).lease, undefined, "nor does the hourly job");
	assert.equal(self.requests.length, requests, "no step posted");
	// The pause is over: the hourly job (or a page request) resumes it.
	limited = false;
	db.sqlite.prepare("UPDATE options SET value = json_set(value, '$.pausedUntil', '2000-01-01T00:00:00.000Z') WHERE name = ?").run(store.VARIANTS_STATE_OPTION);
	await setBulk(db, false);
	await pack.startBackfillChain("https://site.test");
	await drain();
	assert.equal((await store.readVariantsState(db)).state.done, 0, "off: nothing is made");
	await setBulk(db, true);
	await pack.startBackfillChain("https://site.test");
	await drain();
	({ state } = await store.readVariantsState(db));
	assert.deepEqual({ phase: state.phase, done: state.done, failed: state.failed }, { phase: "done", done: 12, failed: 0 });
	done();
});

test("a run that made sizes calls onDone exactly once (the page cache purge); one that made none doesn't", async () => {
	const db = d1();
	const b = bucket();
	library(db, b, 7);
	let calls = 0;
	const deps = { db, bucket: b, images: images(), onDone: async () => void calls++ };
	await store.startVariantsRun(db, { force: true });
	// Two steps racing to the end: only the one that finishes the run reports it.
	await Promise.all([store.backfillStep(deps, { budgetMs: 60_000 }), store.backfillStep(deps, { budgetMs: 60_000 })]);
	assert.equal((await store.readVariantsState(db)).state.phase, "done");
	assert.equal(calls, 1);
	await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.equal(calls, 1, "a finished run isn't reported again");
	await store.startVariantsRun(db, { force: true });
	await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.equal(calls, 1, "nothing was missing: no purge");
});

test("a whole batch failing for another reason counts as failed and pauses the run", async () => {
	const db = d1();
	const b = bucket();
	library(db, b, 5);
	const deps = { db, bucket: b, images: images({ fail: () => true }) };
	const state = await store.backfillStep(deps, { budgetMs: 60_000 });
	assert.equal(state.failed, 5);
	assert.ok(store.pausedAt(state, Date.now()));
	assert.match(state.pauseReason, /failed/);
	assert.equal(state.cursor, "01C0004", "not handed back: retried on the next run");
	assert.equal(store.isThrottled(new Error("Images binding answered 429")), true);
	assert.equal(store.isThrottled(new Error("transform failed")), false);
});

test("when the hand-off isn't accepted (something ahead of the pack refuses the internal request), the trigger makes one step's sizes itself and lets go", async () => {
	const { pack, db, img, done } = await chainSetup(30);
	globalThis.__testEnv.SELF = { fetch: async () => new Response("Unauthorized", { status: 401 }) };
	const state = await pack.startBackfillChain("https://site.test", { force: true });
	assert.equal(img.calls.length, pack.STEP_BUDGET.maxImages * 6, "one step's worth, made here");
	assert.equal(state.done, pack.STEP_BUDGET.maxImages);
	assert.equal(state.phase, "running");
	assert.equal(state.lease, undefined, "the lease is released, so the next trigger continues the run");
	assert.equal((await store.readVariantsState(db)).state.lease, undefined);
	done();
});

// Run: node --import ./test/ts-resolve.mjs --test test/buttondown-files.test.mjs
//
// Buttondown Drafts: the real read of File Downloads' files for a post's file cards (defaultDeps().files in
// src/buttondown/sync.ts). The other Buttondown tests replace it. A read that fails rejects, so the step is tried
// again: it never builds an email from File Downloads' default settings, or from no files.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: `data:text/javascript,export const env = new Proxy({}, { get: (_, k) => globalThis.__testEnv?.[k] }); export const waitUntil = (p) => p;`, shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const { invalidateFeatures } = await import("../src/core/features.ts");
const { invalidateSiteCache } = await import("../src/files/site.ts");
const { defaultDeps } = await import("../src/buttondown/sync.ts");

const option = (key) => `plugin:coywolf-pack:settings:${key}`;

/** A D1 stand-in: the options table (File Downloads' settings) and the media table (one row per file id). */
function fakeDb(options, media = {}) {
	const db = {
		failOptions: false,
		failMedia: false,
		prepare(sql) {
			let args = [];
			return {
				bind(...a) {
					args = a;
					return this;
				},
				async all() {
					if (db.failOptions) throw new Error("D1 unavailable");
					return { results: args.filter((n) => n in options).map((name) => ({ name, value: options[name] })) };
				},
				async first() {
					assert.match(sql, /FROM media WHERE id = \?/);
					if (db.failMedia) throw new Error("D1 unavailable");
					return media[args[0]] ?? null;
				},
			};
		},
	};
	return db;
}

const quiet = async (run) => {
	const error = console.error;
	console.error = () => {};
	try {
		return await run();
	} finally {
		console.error = error;
	}
};

const card = (id) => ({ _type: "coywolf-file", _key: `f-${id}`, id, title: "The guide" });
const post = (...blocks) => ({ id: "A", slug: "post-a", status: "published", data: { title: "Post A", content: blocks } });
const FILE = { id: "01GUIDE", filename: "guide.pdf", mime_type: "application/pdf", size: 1234, storage_key: "k", created_at: "2026-01-01", status: "ready" };
const fresh = () => {
	invalidateFeatures();
	invalidateSiteCache();
};

test("the post's files: read with File Downloads' own settings (the download path and the public base URL)", async () => {
	fresh();
	globalThis.__testEnv = { DB: fakeDb({ [option("filesBase")]: '"get"', [option("filesPublicBaseUrl")]: '"https://files.coywolf.com"' }, { "01GUIDE": FILE }) };
	const files = await defaultDeps().files({}, post(card("01GUIDE"), card("01MISSING")), "https://coywolf.com/");
	assert.deepEqual([...files.keys()], ["01GUIDE"], "a file that isn't there has no entry (its card links to the post)");
	const file = files.get("01GUIDE");
	assert.equal(file.name, "guide.pdf");
	assert.equal(file.size, 1234);
	assert.match(file.href, /^https:\/\/files\.coywolf\.com\/get\//);
});

test("P7: File Downloads' settings can't be read: the read rejects, and no link is built from the default settings", async () => {
	fresh();
	const db = fakeDb({ [option("filesBase")]: '"get"' }, { "01GUIDE": FILE });
	db.failOptions = true;
	globalThis.__testEnv = { DB: db };
	await quiet(() => assert.rejects(defaultDeps().files({}, post(card("01GUIDE")), "https://coywolf.com"), /settings couldn't be read/));
	// Once they read again, the files come back.
	db.failOptions = false;
	fresh();
	assert.equal((await defaultDeps().files({}, post(card("01GUIDE")), "https://coywolf.com")).size, 1);
});

test("a file's own read fails: the read rejects (never \"no files\")", async () => {
	fresh();
	const db = fakeDb({}, { "01GUIDE": FILE });
	db.failMedia = true;
	globalThis.__testEnv = { DB: db };
	await assert.rejects(defaultDeps().files({}, post(card("01GUIDE")), "https://coywolf.com"), /D1 unavailable/);
});

test("P8: no database to read the files from: the read rejects, but a post without file cards needs none", async () => {
	fresh();
	globalThis.__testEnv = {};
	await assert.rejects(defaultDeps().files({}, post(card("01GUIDE")), "https://coywolf.com"), /database couldn't be reached/);
	assert.equal((await defaultDeps().files({}, post(), "https://coywolf.com")).size, 0);
	// A binding under another name isn't the site's database either.
	globalThis.__testEnv = { OTHER: fakeDb({}, { "01GUIDE": FILE }) };
	await assert.rejects(defaultDeps("DB").files({}, post(card("01GUIDE")), "https://coywolf.com"), /database couldn't be reached/);
});

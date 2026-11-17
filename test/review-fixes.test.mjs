// Run: node --test test/review-fixes.test.mjs
//
// Slug changes page through all of EmDash's matching auto rows (up to a logged limit), and the link
// checker names the configured production address.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

test("slug changes: EmDash's auto rows are paged until the last page, up to a limit that's logged", async () => {
	const { dropEmDashAuto, EMDASH_AUTO_GROUP } = await import("../src/redirects/slug-changes.ts");
	// 350 rows that don't match and one that does, on the fourth page of 100.
	const rows = Array.from({ length: 351 }, (_, i) => ({ id: `r${i}`, source: i === 340 ? "/old-name" : `/other-${i}`, destination: "/new-name/", auto: true, groupName: EMDASH_AUTO_GROUP }));
	const deleted = [];
	const warnings = [];
	const api = {
		list: async ({ cursor }) => {
			const start = cursor ? Number(cursor) : 0;
			const more = start + 100 < rows.length;
			return { items: rows.slice(start, start + 100), hasMore: more, cursor: more ? String(start + 100) : undefined };
		},
		get: async (id) => ({ redirect: rows.find((r) => r.id === id), _rev: "x" }),
		delete: async (id) => (deleted.push(id), true),
	};
	const log = { warn: (m) => warnings.push(m) };
	assert.equal(await dropEmDashAuto({ redirects: api, log }, "posts", "/old-name/", "new-name"), 1);
	assert.deepEqual(deleted, ["r340"]);
	assert.deepEqual(warnings, []);
	// With a limit of 2 pages the match isn't reached, and the log says so.
	deleted.length = 0;
	assert.equal(await dropEmDashAuto({ redirects: api, log }, "posts", "/old-name/", "new-name", [], 2), 0);
	assert.match(warnings[0], /page limit/);
});

test("slug changes: the search fits D1's 50-byte LIKE limit, so a long slug's EmDash row is still found and deleted", async () => {
	const { dropEmDashAuto, likeSearchTerm, D1_LIKE_PATTERN_BYTES, EMDASH_AUTO_GROUP } = await import("../src/redirects/slug-changes.ts");
	// EmDash's pattern for a search (src/database/repositories/redirect.ts findMany), and its size in bytes.
	const pattern = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const bytes = (s) => Buffer.byteLength(s, "utf8");

	assert.equal(D1_LIKE_PATTERN_BYTES, 50);
	assert.equal(likeSearchTerm("new-name"), "new-name", "a short slug is searched whole");
	const fits = "a".repeat(48);
	assert.equal(likeSearchTerm(fits), fits, "48 bytes plus the two % is exactly 50");
	assert.equal(likeSearchTerm(`${fits}b`), fits, "one more byte is cut");
	assert.equal(likeSearchTerm("_".repeat(30)), "_".repeat(24), "an escaped character counts two bytes");
	const accented = "é".repeat(30); // 2 bytes each
	assert.equal(likeSearchTerm(accented), "é".repeat(24));
	assert.equal(likeSearchTerm("日本語".repeat(10)).length, 16, "a 3-byte character is never split");
	for (const slug of ["rank-trackers-getting-poisoned-serps-from-google-in-search-results", "x_y%z\\".repeat(20), "café-".repeat(20), "😀".repeat(20)]) {
		const term = likeSearchTerm(slug);
		assert.ok(slug.startsWith(term) && term.length > 0, slug);
		assert.ok(bytes(pattern(term)) <= 50, `${slug}: ${bytes(pattern(term))} bytes`);
	}

	// A redirects API that fails the way D1 does on a longer pattern.
	const newSlug = "rank-trackers-getting-poisoned-serps-from-google-in-search-results";
	const rows = [
		{ id: "mine", source: "/posts/google-is-feeding-rank-trackers-poisoned-serps", destination: `/posts/${newSlug}`, auto: true, groupName: EMDASH_AUTO_GROUP },
		{ id: "other", source: "/posts/something-else", destination: `/posts/${newSlug}-2`, auto: true, groupName: EMDASH_AUTO_GROUP },
	];
	const searches = [];
	const deleted = [];
	const api = {
		list: async ({ search }) => {
			searches.push(search);
			if (search !== undefined && bytes(pattern(search)) > 50) throw new Error("D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR");
			return { items: rows.filter((r) => !search || r.source.includes(search) || r.destination.includes(search)), hasMore: false };
		},
		get: async (id) => ({ redirect: rows.find((r) => r.id === id), _rev: "x" }),
		delete: async (id) => (deleted.push(id), true),
	};
	assert.equal(await dropEmDashAuto({ redirects: api }, "posts", "/news/seo/google-is-feeding-rank-trackers-poisoned-serps/", newSlug), 1);
	assert.deepEqual(deleted, ["mine"], "only the row ending in the whole new slug");
	assert.equal(searches[0], likeSearchTerm(newSlug));
});

test("the link checker names the configured production address, never a staging or setup origin", async () => {
	const { configuredSiteOrigin, resetConfiguredSiteUrl } = await import("../src/core/site.ts");
	resetConfiguredSiteUrl(null);
	assert.equal(await configuredSiteOrigin({ EMDASH_SITE_URL: "https://coywolf.com/" }, async () => "https://staging.coywolf.com"), "https://coywolf.com");
	assert.equal(await configuredSiteOrigin({}, async () => "https://coywolf.com/about"), "https://coywolf.com", "Settings → Site URL");
	assert.equal(await configuredSiteOrigin({}, async () => null), null, "nothing configured: no site named");
	assert.equal(
		await configuredSiteOrigin({}, async () => {
			throw new Error("outside a request");
		}),
		null,
	);
	resetConfiguredSiteUrl("https://www.coywolf.com");
	assert.equal(await configuredSiteOrigin({ EMDASH_SITE_URL: "https://staging.example.com" }), "https://www.coywolf.com", "EmDash's siteUrl option first");
	resetConfiguredSiteUrl();
	const links = readFileSync(new URL("../src/links/module.ts", import.meta.url), "utf8");
	assert.match(links, /siteUrl: checkerSite/);
	assert.doesNotMatch(links, /siteUrl: ctx\.site\.url/);
});

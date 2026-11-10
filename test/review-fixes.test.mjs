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

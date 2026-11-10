// Run: node --test test/sidebar.test.mjs
//
// The pack's sidebar (src/core/sidebar.ts): every page in one of the folders, folders in one
// piece, one title-case name per module that doesn't collide with EmDash's own pages, and the
// README's module table using the same names.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { SIDEBAR_FOLDERS, sidebarPages } = await import("../src/core/sidebar.ts");

const src = new URL("../src/", import.meta.url);
/** Every module page the packs declare: path → label. */
const declared = new Map(
	readdirSync(src, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) => {
			try {
				return [readFileSync(new URL(`${d.name}/pack.ts`, src), "utf8")];
			} catch {
				return [];
			}
		})
		.flatMap((pack) => [...pack.matchAll(/adminPages: \[\{ path: "([^"]+)", label: "([^"]+)"/g)].map((m) => [m[1], m[2]])),
);
declared.set("/features", "Features");
declared.set("/performance", "Performance");

test("every pack page is in exactly one folder", () => {
	assert.ok(declared.size >= 20, `found ${declared.size} pages`);
	const listed = SIDEBAR_FOLDERS.flatMap((f) => f.pages);
	assert.deepEqual([...new Set(listed)].sort(), listed.slice().sort(), "a page is listed twice");
	assert.deepEqual(listed.slice().sort(), [...declared.keys()].sort());
	assert.ok(SIDEBAR_FOLDERS.length >= 3 && SIDEBAR_FOLDERS.length <= 4);
});

test("folders come out in one piece, in order; an unlisted page joins the first folder", () => {
	const pages = [{ path: "/videos", label: "Videos" }, { path: "/new-module", label: "New Module" }, { path: "/schema", label: "Schema & Social" }, { path: "/features", label: "Features" }];
	assert.deepEqual(
		sidebarPages(pages).map((p) => `${p.group}: ${p.label}`),
		["Coywolf Pack: Features", "Coywolf Pack: New Module", "SEO: Schema & Social", "Media Tools: Videos"],
	);
});

test("page names: title case, unique, and none of EmDash's own sidebar names", () => {
	const labels = [...declared.values()];
	assert.equal(new Set(labels).size, labels.length);
	const minor = new Set(["&", "and", "of", "for", "the", "a"]);
	for (const label of labels) {
		for (const word of label.split(/\s+/)) assert.ok(minor.has(word) || /^[A-Z0-9]/.test(word), `"${label}" isn't title case ("${word}")`);
	}
	// EmDash's built-in sidebar entries (packages/admin Sidebar), which a pack page must not look like.
	const emdash = ["Dashboard", "Media", "Comments", "Menus", "Widgets", "Sections", "Redirects", "Import", "Settings", "Plugins", "Users", "Bylines", "Content Types", "Themes"];
	for (const label of labels) assert.ok(!emdash.includes(label), `"${label}" is also one of EmDash's own pages`);
});

test("the README's module table uses the sidebar's names", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const table = [...readme.matchAll(/^\| \[([^\]]+)\]\(docs\/[^)]+\.md\) \|/gm)].map((m) => m[1]);
	assert.ok(table.length >= 18, `found ${table.length} modules in the README`);
	const names = new Set([...declared.values(), "Update Check"]);
	for (const name of table) assert.ok(names.has(name), `README module "${name}" isn't a sidebar name (${[...names].join(", ")})`);
});

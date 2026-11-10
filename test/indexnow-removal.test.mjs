// Run: node --test test/indexnow-removal.test.mjs
// IndexNow and Bing submission were removed in 0.35.18; the code that deletes what they left on a site
// (retireIndexNow, the RETIRED_* constants, Discovery's retired daily task) stays until 0.38.0, so every
// site runs a release that cleans up first. This test fails once package.json reaches 0.38.0 while any
// of it is still in src/: remove it then (see src/discovery/module.ts and docs/discovery.md).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const REMOVE_IN = "0.38.0";

/** What the clean-up is made of: its names, the retired task and the marker it sets. */
const LEFTOVERS = [
	/\bretireIndexNow\b/,
	/\bRETIRED_(?:BING_TASK|MARKER|KV|URL_PREFIX|DELETE_BATCH|SETTINGS)\b/,
	/discovery-bing-drain/,
	/indexnowRetired/,
];

/** a >= b, for x.y.z versions (a prerelease of b counts as b). */
function atLeast(a, b) {
	const parse = (v) => v.split("-")[0].split(".").map(Number);
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return true;
}

function sources() {
	const src = join(root, "src");
	return readdirSync(src, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && /\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name))
		.map((e) => join(e.parentPath, e.name));
}

/** Lines of src that are part of the clean-up (plus any retiredTasks left in Discovery). */
function leftovers() {
	const found = [];
	for (const file of sources()) {
		const name = relative(root, file);
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, i) => {
				if (LEFTOVERS.some((re) => re.test(line)) || (name.startsWith("src/discovery/") && /\bretiredTasks\b/.test(line))) found.push(`${name}:${i + 1}: ${line.trim()}`);
			});
	}
	return found;
}

test("the version check counts prereleases and patch versions", () => {
	assert.equal(atLeast("0.37.9", REMOVE_IN), false);
	assert.equal(atLeast("0.38.0", REMOVE_IN), true);
	assert.equal(atLeast("0.38.0-beta.1", REMOVE_IN), true);
	assert.equal(atLeast("1.0.0", REMOVE_IN), true);
});

test("the IndexNow clean-up is still found by this test (until it's removed)", () => {
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (atLeast(version, REMOVE_IN)) return;
	assert.ok(leftovers().length > 0, "the clean-up is gone: delete this test and the 0.38.0 notes in docs/discovery.md");
});

test(`the IndexNow clean-up is removed by ${REMOVE_IN}`, () => {
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (!atLeast(version, REMOVE_IN)) return;
	assert.deepEqual(
		leftovers(),
		[],
		`package.json is ${version}: remove the IndexNow and Bing clean-up (retireIndexNow, RETIRED_*, Discovery's retiredTasks, the HOUSEKEEPING_KEYS marker), then this test and the notes in docs/discovery.md`,
	);
});

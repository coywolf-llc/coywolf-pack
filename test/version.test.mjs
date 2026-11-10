// Run: node --test test/version.test.mjs
// The pack reports src/version.ts's VERSION (the update check, the Plugins list); the
// publish workflow checks the tag against package.json. They must be the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { VERSION } = await import("../src/version.ts");

test("src/version.ts's VERSION is package.json's version", () => {
	const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(VERSION, version, "bump both when releasing (docs/releasing.md)");
});

test("package-lock.json has the same version", () => {
	const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
	assert.equal(lock.version, VERSION);
	assert.equal(lock.packages[""].version, VERSION);
});

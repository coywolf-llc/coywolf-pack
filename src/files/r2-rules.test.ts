/**
 * Run: node --test src/files/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { parseDownloadPath } from "./format.ts";
// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { MAX_THROUGH_SITE, PART_SIZE, partSizeFor } from "./r2-rules.ts";

const MiB = 1024 * 1024;

test("parts are 6 MiB: above R2's 5 MiB minimum, under EmDash's 8 MiB route body cap", () => {
	assert.equal(PART_SIZE, 6 * MiB);
	assert.equal(partSizeFor(1), PART_SIZE);
	assert.equal(partSizeFor(40 * 1024 * MiB), PART_SIZE);
	assert.equal(MAX_THROUGH_SITE, 10_000 * PART_SIZE);
	assert.ok(MAX_THROUGH_SITE >= 50 * 1024 ** 3, "the 50 GB setting fits");
});

test("download paths", () => {
	assert.deepEqual(parseDownloadPath("/download/fabcdefghijklmno/report.pdf", "download"), { id: "fabcdefghijklmno", filename: "report.pdf" });
	assert.deepEqual(parseDownloadPath("/download/01J9ZQ3W4X5Y6Z7A8B9C0D1E2F", "download"), { id: "01J9ZQ3W4X5Y6Z7A8B9C0D1E2F", filename: null });
	assert.equal(parseDownloadPath("/download/", "download"), null);
	assert.equal(parseDownloadPath("/download/not-an-id/x.pdf", "download"), null);
	assert.equal(parseDownloadPath("/download/fabcdefghijklmno/a/b", "download"), null);
	assert.equal(parseDownloadPath("/downloads/fabcdefghijklmno/x", "download"), null);
	assert.equal(parseDownloadPath("/download/%E0%A4%A/x", "download"), null);
});

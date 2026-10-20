// Sitemaps must never send `X-Robots-Tag: noindex`. Google Search Console flags a sitemap
// served with it as "Excluded by 'noindex' tag", and Jon's rule is that a sitemap is
// never noindexed. Every response the pack serves as XML (the News and video sitemaps)
// is checked at the source: no header object that sets an XML Content-Type may also set
// X-Robots-Tag.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return files(path);
		return /\.(ts|mjs|js)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
	});
}

/** The object literal (balanced braces) that contains `index` in `source`. */
function enclosingObject(source, index) {
	let depth = 0;
	let start = index;
	for (; start >= 0; start--) {
		if (source[start] === "}") depth++;
		else if (source[start] === "{") {
			if (depth === 0) break;
			depth--;
		}
	}
	depth = 0;
	let end = index;
	for (; end < source.length; end++) {
		if (source[end] === "{") depth++;
		else if (source[end] === "}") {
			if (depth === 0) break;
			depth--;
		}
	}
	return source.slice(start, end + 1);
}

test("no XML response (sitemap) sets X-Robots-Tag", () => {
	const offenders = [];
	let xmlResponses = 0;
	for (const file of files(SRC)) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/["']Content-Type["']\s*:\s*["']application\/xml/gi)) {
			xmlResponses++;
			if (/X-Robots-Tag/i.test(enclosingObject(source, match.index))) offenders.push(file.slice(SRC.length));
		}
	}
	assert.ok(xmlResponses >= 2, "expected to find the News and video sitemap responses");
	assert.deepEqual(offenders, []);
});

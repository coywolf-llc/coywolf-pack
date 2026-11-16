// Run: node --test test/import-cycle.test.mjs
//
// EmDash merges plugin block renderers in `virtual:emdash/block-components`, which imports this package's
// `blockComponents` (src/astro/index.ts, the componentsEntry) and is itself imported by emdash/ui's PortableText.
// If anything statically reachable from src/astro/index.ts imports emdash/ui (or EmDash's components), the two form
// an import cycle. A theme that then imports `@coywolf/emdash/astro` before `emdash/ui` gets a bundle that spreads
// `blockComponents` into `pluginBlockComponents` before it's defined, and every pack block (details, note, video,
// TOC, review…) renders as "PortableText [components.type] is missing" (coywolf.com, 2026-11-15). Components that
// need emdash/ui import it at render time (`await import("emdash/ui")`, as HeadingBlock and CaptionedTable do).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src/astro/index.ts");

/** Specifiers that lead to virtual:emdash/block-components (emdash/ui's barrel and EmDash's own components). */
const CYCLE = (spec) => spec === "emdash/ui" || spec.startsWith("emdash/ui/") || spec.startsWith("emdash/components");

/** The static import and re-export specifiers of a source file (an .astro file's frontmatter only). Type-only imports and dynamic import() are left out. */
export function staticSpecifiers(source, isAstro) {
	let code = source;
	if (isAstro) {
		const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
		code = m ? m[1] : "";
	}
	// Drop comments so commented-out imports don't count.
	code = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
	const specs = [];
	const re = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
	for (const m of code.matchAll(re)) {
		if (m[5]) {
			specs.push(m[5]);
			continue;
		}
		if (m[2]) continue; // import type … / export type …
		const clause = m[3].trim();
		// `import { type A, type B } from` imports nothing at runtime.
		if (/^\{[\s\S]*\}$/.test(clause) && clause.slice(1, -1).split(",").every((p) => !p.trim() || /^type\s/.test(p.trim()))) continue;
		specs.push(m[4]);
	}
	return specs;
}

function resolveRelative(from, spec) {
	const base = resolve(dirname(from), spec);
	const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.astro`, join(base, "index.ts")];
	return candidates.find((p) => existsSync(p) && /\.(ts|astro|mjs|js)$/.test(p));
}

/** Every file statically reachable from `entry` through relative imports, with each non-relative specifier it imports. */
function walk(entry) {
	const seen = new Map();
	const stack = [entry];
	while (stack.length) {
		const file = stack.pop();
		if (seen.has(file)) continue;
		const specs = staticSpecifiers(readFileSync(file, "utf8"), file.endsWith(".astro"));
		seen.set(file, specs.filter((s) => !s.startsWith(".")));
		for (const spec of specs) {
			if (!spec.startsWith(".")) continue;
			const next = resolveRelative(file, spec);
			if (next && !next.includes(`${join(ROOT, "src")}/admin/`)) stack.push(next);
		}
	}
	return seen;
}

test("nothing statically reachable from the component entry imports emdash/ui (no block-components cycle)", () => {
	const graph = walk(ENTRY);
	const offenders = [];
	for (const [file, specs] of graph) for (const spec of specs) if (CYCLE(spec)) offenders.push(`${relative(ROOT, file)} imports "${spec}"`);
	assert.deepEqual(offenders, [], `Import emdash/ui at render time instead (const { … } = await import("emdash/ui")):\n${offenders.join("\n")}`);
	// The walk really covers the block components (not a vacuous pass).
	const files = [...graph.keys()].map((f) => relative(ROOT, f));
	for (const f of ["src/astro/tables/CaptionedTable.astro", "src/astro/headings/HeadingBlock.astro", "src/astro/customBlocks/Details.astro", "src/astro/videos/CoywolfVideo.astro"]) {
		assert.ok(files.includes(f), `walk reaches ${f}`);
	}
});

test("staticSpecifiers: static imports count; type-only, dynamic and commented imports don't", () => {
	const astro = [
		"---",
		'import { emdashComponents } from "emdash/ui";',
		'import type { X } from "emdash/ui";',
		'import { type Y } from "emdash/ui";',
		'// import { Z } from "emdash/ui";',
		'const { Block } = await import("emdash/ui");',
		'export { a } from "./a.js";',
		'import "./side-effect.js";',
		"---",
		'<p>import { nope } from "emdash/ui";</p>',
	].join("\n");
	assert.deepEqual(staticSpecifiers(astro, true), ["emdash/ui", "./a.js", "./side-effect.js"]);
	assert.deepEqual(staticSpecifiers('export type { T } from "emdash/ui";\nexport { u } from "emdash/ui";', false), ["emdash/ui"]);
});

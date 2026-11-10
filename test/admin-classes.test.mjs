// Run: node --test test/admin-classes.test.mjs
//
// The admin pages render inside EmDash's admin, whose stylesheet is a precompiled
// Tailwind build: a utility it doesn't already contain is silently ignored. This
// checks every class in src/admin/**/*.tsx className attributes exists either in
// EmDash's admin stylesheet or in the pack's own admin CSS (src/admin/admin-css.ts).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./ts-resolve.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminDir = join(root, "src/admin");

function emdashAdminCss() {
	try {
		const require = createRequire(join(root, "package.json"));
		// A dependency of emdash (a devDependency here), exported as "./styles.css".
		return readFileSync(require.resolve("@emdash-cms/admin/styles.css", { paths: [root, join(root, "node_modules/emdash")] }), "utf8");
	} catch {
		return null;
	}
}

/** Every class name a stylesheet defines, with CSS escapes undone (`md\:flex` -> `md:flex`). */
export function cssClassNames(css) {
	const names = new Set();
	for (const match of css.matchAll(/\.((?:\\[0-9a-f]{1,6} ?|\\.|[\w-])+)/gi)) {
		names.add(match[1].replace(/\\([0-9a-f]{1,6}) ?|\\(.)/gi, (_, hex, ch) => (hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ch)));
	}
	return names;
}

/** Index just past the expression starting at `start` (an opening `{`), skipping strings. */
function skipBraces(src, start) {
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			i = src.indexOf(ch, i + 1);
			// An apostrophe in JSX text has no closing quote: indexOf gives -1, which would restart the scan forever.
			if (i === -1) return src.length;
		} else if (ch === "`") {
			i = skipTemplate(src, i);
		} else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i + 1;
	}
	return src.length;
}

function skipTemplate(src, start) {
	for (let i = start + 1; i < src.length; i++) {
		if (src[i] === "\\") i++;
		else if (src[i] === "`") return i;
		else if (src[i] === "$" && src[i + 1] === "{") i = skipBraces(src, i + 1) - 1;
	}
	return src.length;
}

/** String-literal text in a className expression: static strings and template static parts. Comparison operands (`x === "none"`) are skipped. */
function expressionStrings(expr) {
	const out = [];
	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i];
		if (ch === '"' || ch === "'") {
			const found = expr.indexOf(ch, i + 1);
			const end = found === -1 ? expr.length : found;
			if (!/[=!]==?\s*$/.test(expr.slice(0, i))) out.push(expr.slice(i + 1, end));
			i = end;
		} else if (ch === "`") {
			let text = "";
			let j = i + 1;
			for (; j < expr.length && expr[j] !== "`"; j++) {
				if (expr[j] === "$" && expr[j + 1] === "{") {
					const close = skipBraces(expr, j + 1);
					out.push(...expressionStrings(expr.slice(j + 2, close - 1)));
					text += " ";
					j = close - 1;
				} else text += expr[j];
			}
			out.push(text);
			i = j;
		}
	}
	return out;
}

/** Index of the `;` or line break that ends the statement starting at `start` (outside strings, brackets and braces; a line that continues with `? :`, `.` or a trailing operator is one statement). */
function statementEnd(src, start) {
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			i = src.indexOf(ch, i + 1);
			if (i === -1) return src.length;
		} else if (ch === "`") i = skipTemplate(src, i);
		else if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === ";" && depth <= 0) return i;
		else if (ch === "\n" && depth <= 0) {
			const before = src.slice(start, i).trimEnd();
			const after = src.slice(i + 1).trimStart();
			if (!/[=?:+&|,(]$/.test(before) && !/^[?:.]|^(?:&&|\|\|)/.test(after)) return i;
		}
	}
	return src.length;
}

/** Initializers of the file's `const`/`let` declarations by name: class strings kept in a variable (`${color}`) are checked through these. */
function declarations(src) {
	const map = new Map();
	for (const match of src.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=(?!=)\s*/g)) {
		const start = match.index + match[0].length;
		map.set(match[1], src.slice(start, statementEnd(src, start)));
	}
	return map;
}

/** Strings in a className expression, following bare identifiers (`${color}`, `className={rowClass}`, `cond ? a : b`) to their declarations in the same file. */
function classStrings(expr, decls, seen = new Set()) {
	const out = expressionStrings(expr);
	const idents = [...expr.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}|[?:]\s*([A-Za-z_$][\w$]*)\s*(?=[:)}]|$)/g)].map((m) => m[1] ?? m[2]);
	const whole = expr.trim().match(/^([A-Za-z_$][\w$]*)$/);
	if (whole) idents.push(whole[1]);
	for (const name of idents) {
		if (seen.has(name) || !decls.has(name)) continue;
		seen.add(name);
		out.push(...classStrings(decls.get(name), decls, seen));
	}
	return out;
}

/** Class names used in a file's className attributes. */
export function classNamesIn(src) {
	const decls = declarations(src);
	const classes = [];
	for (const match of src.matchAll(/className=/g)) {
		const start = match.index + match[0].length;
		let strings;
		if (src[start] === '"') strings = [src.slice(start + 1, src.indexOf('"', start + 1))];
		else if (src[start] === "{") strings = classStrings(src.slice(start + 1, skipBraces(src, start) - 1), decls);
		else continue;
		classes.push(...strings.join(" ").split(/\s+/).filter(Boolean));
	}
	return classes;
}

/** Class names used in className attributes, with the file they appear in. */
export function adminClassNames(files) {
	const found = new Map();
	for (const file of files) {
		for (const cls of classNamesIn(readFileSync(file, "utf8"))) {
			if (!found.has(cls)) found.set(cls, new Set());
			found.get(cls).add(relative(root, file));
		}
	}
	return found;
}

function tsxFiles(dir) {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
		.map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

const emdashCss = emdashAdminCss();

test("the extractor reads static strings, conditionals, and template literal static parts", () => {
	const expr = (s) => expressionStrings(s).join(" ").split(/\s+/).filter(Boolean);
	assert.deepEqual(expr('`text-xs ${on ? "font-bold" : ""} m-1`'), ["font-bold", "text-xs", "m-1"]);
	assert.deepEqual(expr('x === "none" ? "gap-2" : undefined'), ["gap-2"]);
	assert.deepEqual([...cssClassNames(".md\\:flex{display:flex}:where(.space-y-8>:not(:last-child)){}.w-1\\/2{}.\\32 xl\\:grid-cols-6{}")], ["md:flex", "space-y-8", "w-1/2", "2xl:grid-cols-6"]);
});

test("the extractor follows class strings kept in variables", () => {
	const src = [
		'const color = f.severity === "error" ? "text-kumo-danger" : "text-kumo-subtle";',
		"const row =",
		'\tactive ? "bg-kumo-tint"',
		'\t\t: "bg-kumo-base";',
		"const cell = `p-2 ${color}`;",
		'const label: string = "Save";',
		"<Icon className={`mt-0.5 shrink-0 ${color}`} />",
		"<li className={row} />",
		'<td className={on ? cell : "p-1"} />',
		"<em className={label} />",
	].join("\n");
	assert.deepEqual(
		[...new Set(classNamesIn(src))].sort(),
		["Save", "bg-kumo-base", "bg-kumo-tint", "mt-0.5", "p-1", "p-2", "shrink-0", "text-kumo-danger", "text-kumo-subtle"],
	);
});

test("every admin className exists in EmDash's admin CSS or the pack's admin CSS", { skip: emdashCss ? false : "@emdash-cms/admin/dist/styles.css not installed (run npm install); skipping the admin class check" }, async () => {
	const packCss = Object.values(await import("../src/admin/admin-css.ts")).filter((value) => typeof value === "string");
	const known = new Set([...cssClassNames(emdashCss), ...packCss.flatMap((css) => [...cssClassNames(css)])]);
	const used = adminClassNames(tsxFiles(adminDir));
	assert.ok(used.size > 100, `expected to find admin classes, found ${used.size}`);
	const missing = [...used].filter(([cls]) => !known.has(cls)).map(([cls, files]) => `${cls} (${[...files].join(", ")})`);
	assert.deepEqual(missing, [], `Classes not in EmDash's admin CSS or src/admin/admin-css.ts:\n  ${missing.join("\n  ")}`);
});

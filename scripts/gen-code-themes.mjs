#!/usr/bin/env node
/**
 * Generates src/codeBlocks/themes.generated.ts from highlight.js's own theme
 * stylesheets (node_modules/highlight.js/styles). Each theme is rescoped
 * under `.cw-code` (the `.hljs` root becomes the block wrapper, token rules
 * become descendants), layout rules (`pre code.hljs`, `code.hljs`) and layout
 * properties (display, width, padding, margin, overflow, …) are dropped, @-blocks (only the obsolete
 * -ms-high-contrast queries) are dropped, and the output is minified. Each
 * theme's original header comment (author / license) is kept above its entry.
 *
 * Run: node scripts/gen-code-themes.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const hljsDir = dirname(require.resolve("highlight.js/package.json"));
const hljsVersion = JSON.parse(readFileSync(join(hljsDir, "package.json"), "utf8")).version;

/** [id, label, file under styles/] — curated, popular, and readable. */
const THEMES = [
	["github", "GitHub", "github"],
	["github-dark", "GitHub Dark", "github-dark"],
	["github-dark-dimmed", "GitHub Dark Dimmed", "github-dark-dimmed"],
	["atom-one-light", "Atom One Light", "atom-one-light"],
	["atom-one-dark", "Atom One Dark", "atom-one-dark"],
	["a11y-light", "A11y Light", "a11y-light"],
	["a11y-dark", "A11y Dark", "a11y-dark"],
	["vs", "Visual Studio", "vs"],
	["vs2015", "Visual Studio 2015 (dark)", "vs2015"],
	["xcode", "Xcode", "xcode"],
	["monokai", "Monokai", "monokai"],
	["nord", "Nord", "nord"],
	["night-owl", "Night Owl", "night-owl"],
	["tokyo-night-light", "Tokyo Night Light", "tokyo-night-light"],
	["tokyo-night-dark", "Tokyo Night Dark", "tokyo-night-dark"],
	["rose-pine", "Rosé Pine", "rose-pine"],
	["dracula", "Dracula", "base16/dracula"],
	["solarized-light", "Solarized Light", "base16/solarized-light"],
	["solarized-dark", "Solarized Dark", "base16/solarized-dark"],
];

/** Layout properties are the block chrome's job; themes only supply colors and font styles. */
const LAYOUT_PROP = /^(?:display|position|float|width|height|min-width|max-width|min-height|max-height|overflow(?:-[xy])?|padding(?:-\w+)?|margin(?:-\w+)?|box-sizing)$/;

function rescopeSelector(sel) {
	sel = sel.trim().replace(/\s+/g, " ");
	if (sel === "pre code.hljs" || sel === "code.hljs") return null;
	// `.hljs` (not `.hljs-…`) is the root: the block wrapper.
	const replaced = sel.replace(/\.hljs(?![\w-])/g, ".cw-code");
	return replaced.startsWith(".cw-code") ? replaced : `.cw-code ${replaced}`;
}

function minifyBody(body) {
	return body
		.split(";")
		.map((d) => d.trim().replace(/\s+/g, " "))
		.filter(Boolean)
		.map((d) => {
			const i = d.indexOf(":");
			return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
		})
		.filter(([prop]) => !LAYOUT_PROP.test(prop))
		.map(([p, v]) => `${p}:${v}`)
		.join(";");
}

function luminance(hex) {
	const named = { white: "#ffffff", black: "#000000" };
	hex = named[hex.toLowerCase()] ?? hex;
	let h = hex.replace("#", "");
	if (h.length === 3) h = [...h].map((c) => c + c).join("");
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function convert(file) {
	const raw = readFileSync(join(hljsDir, "styles", `${file}.css`), "utf8");
	const header = raw.match(/\/\*[\s\S]*?\*\//)?.[0] ?? "";
	let css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
	// Drop @-blocks (balanced braces).
	for (let at = css.indexOf("@"); at !== -1; at = css.indexOf("@")) {
		let depth = 0;
		let end = at;
		for (let i = css.indexOf("{", at); i < css.length; i++) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}" && --depth === 0) {
				end = i + 1;
				break;
			}
		}
		css = css.slice(0, at) + css.slice(end);
	}
	const out = [];
	let background = null;
	for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selectors = match[1].split(",").map(rescopeSelector).filter(Boolean);
		if (!selectors.length) continue;
		const isRoot = selectors.includes(".cw-code");
		const body = minifyBody(match[2]);
		if (!body) continue;
		if (isRoot) {
			const bg = body.match(/background(?:-color)?:\s*(#[0-9a-f]{3,6}|white|black)\b/i);
			if (bg) background = bg[1];
		}
		out.push(`${selectors.join(",")}{${body}}`);
	}
	if (!background) throw new Error(`${file}: no root background`);
	return { header: header.trim(), css: out.join(""), scheme: luminance(background) < 0.5 ? "dark" : "light" };
}

const entries = THEMES.map(([id, label, file]) => {
	const { header, css, scheme } = convert(file);
	const comment = header
		.replace(/^\/\*!?/, "")
		.replace(/\*\/$/, "")
		.split("\n")
		.map((l) => ` * ${l.replace(/^\s*\*?\s?/, "")}`.trimEnd())
		.join("\n");
	return `\t/**\n\t * highlight.js styles/${file}.css\n${comment.replace(/^/gm, "\t")}\n\t */\n\t${JSON.stringify(id)}: { label: ${JSON.stringify(label)}, scheme: ${JSON.stringify(scheme)}, css: ${JSON.stringify(css)} },`;
});

const license = readFileSync(join(hljsDir, "LICENSE"), "utf8").trim().split("\n").map((l) => ` * ${l}`.trimEnd()).join("\n");

const file = `/* eslint-disable */
// Generated file: don't edit by hand.
/**
 * GENERATED by scripts/gen-code-themes.mjs from highlight.js ${hljsVersion}
 * (node_modules/highlight.js/styles). Do not edit by hand.
 *
 * Theme stylesheets are rescoped under .cw-code and minified; each theme's
 * original header (author, license) is kept above its entry. highlight.js
 * and its bundled themes are distributed under this license:
 *
${license}
 */

export interface HljsTheme {
	label: string;
	/** Background lightness, used for color-scheme and the auto pairs. */
	scheme: "light" | "dark";
	css: string;
}

export const HLJS_THEMES: Record<string, HljsTheme> = {
${entries.join("\n")}
};
`;

const target = join(root, "src/codeBlocks/themes.generated.ts");
writeFileSync(target, file);
console.log(`Wrote ${THEMES.length} themes to ${target}`);

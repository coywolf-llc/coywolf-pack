/**
 * Code Blocks module: server-side syntax highlighting, themes, language
 * label, copy button and line numbers for EmDash's built-in code block
 * (rendered by src/astro/codeBlocks/CodeBlock.astro). Port of Coywolf Code
 * Block Enhancer.
 */
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { parseInput } from "../shared.js";
import { invalidateTheme } from "./settings.js";
import { DEFAULT_THEME, THEME_SETTING, isTheme, themeCss, themeOptions } from "./themes.js";
import { readOnlyRoute } from "../core/routes.js";

// biome-ignore lint/suspicious/noEmptyInterface: reserved for future options.
export interface CodeBlocksOptions {}

export const FEATURES = [
	{
		id: "codeBlocks",
		label: "Code blocks",
		description: "Syntax highlighting and themes for code blocks on the site, rendered on the server (no highlighting script for visitors).",
		default: false,
	},
	{
		id: "codeBlocks.label",
		label: "Language label",
		description: "Show the code's language (e.g. TypeScript) above each block.",
		default: false,
	},
	{
		id: "codeBlocks.copy",
		label: "Copy button",
		description: "An accessible copy-to-clipboard button on each block (one small inline script, only on pages with code).",
		default: false,
	},
	{
		id: "codeBlocks.lineNumbers",
		label: "Line numbers",
		description: "Number each line. Numbers aren't selected or copied with the code.",
		default: false,
	},
];
registerFeatures(FEATURES);

const SAMPLE = {
	language: "typescript",
	code: `/** Say hello to someone. */
export function greet(name: string, times = 1): string {
  const words = ["Hello", name].join(", ");
  // Repeat it if asked
  return \`\${words}!\`.repeat(times);
}

console.log(greet("Coywolf", 2));
`,
};

export function codeBlocksPack(_options: CodeBlocksOptions): PackModule {
	return {
		id: "codeBlocks",
		label: "Code Blocks",
		features: FEATURES,
		adminPages: [{ path: "/code-blocks", label: "Code Blocks", icon: "code" }],
		routes: {
			"codeBlocks/settings": {
				permission: "plugins:manage" as const,
				// biome-ignore lint/suspicious/noExplicitAny: plugin context.
				handler: async (ctx: any) => {
					const stored = await ctx.settings.get(THEME_SETTING);
					return { theme: isTheme(stored) ? stored : DEFAULT_THEME, themes: themeOptions() };
				},
			},

			"codeBlocks/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const { theme } = parseInput(z.object({ theme: z.string().max(100) }), ctx.input);
					if (!isTheme(theme)) throw PluginRouteError.badRequest("Unknown theme.");
					await ctx.settings.set(THEME_SETTING, theme);
					invalidateTheme();
					ctx.log.info("Code block theme saved", { theme });
					return { theme };
				},
			}),

			/** Preview markup + CSS for the admin page (same renderer as the site). */
			"codeBlocks/preview": readOnlyRoute(definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const input = parseInput(
						z.object({ theme: z.string().max(100), label: z.boolean(), copy: z.boolean(), lineNumbers: z.boolean() }),
						ctx.input,
					);
					// Lazy: keeps lowlight and its grammars out of the plugin's startup path.
					const { CHROME_CSS, renderBlock } = await import("./render.js");
					return {
						css: CHROME_CSS + themeCss(input.theme),
						html: renderBlock(SAMPLE, { label: input.label, copy: input.copy, lineNumbers: input.lineNumbers }),
					};
				},
			})),
		},
	};
}

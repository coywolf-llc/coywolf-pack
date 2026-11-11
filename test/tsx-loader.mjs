// Lets a test import the admin's .tsx pages and render the real components: a relative ".js" import also
// resolves to the ".tsx" file next to it, and .tsx is compiled with TypeScript (JSX to react/jsx-runtime, as
// tsconfig.json says), types dropped. Node runs the plain .ts files itself (ts-resolve.mjs).
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import "./ts-resolve.mjs";

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(`${specifier.slice(0, -3)}.tsx`, context);
			throw error;
		}
	},
	load(url, context, next) {
		if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
		const fileName = fileURLToPath(url);
		const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
			fileName,
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
		});
		return { format: "module", source: outputText, shortCircuit: true };
	},
});

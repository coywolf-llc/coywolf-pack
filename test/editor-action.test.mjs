// Run: node --test test/editor-action.test.mjs
//
// The AI Enrich button's companion plugin (src/editor.ts): its descriptor, the
// action EmDash lists (always: with its parts off, a click says so), its private POST JSON
// route, and the bridge to the pack's ai/editor-enrich route (src/core/bridge.ts),
// which the pack's middleware feeds with EmDash's dispatcher.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

import "./ts-resolve.mjs";

// The middleware's module list pulls in every module (some need a bundler): this test passes no handlers.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "./modules.js" && context.parentURL?.endsWith("/src/middleware.ts")) return { url: "data:text/javascript,export const MIDDLEWARE = [];", shortCircuit: true };
		return next(specifier, context);
	},
});

const editor = await import("../src/editor.ts");
const bridge = await import("../src/core/bridge.ts");
const features = await import("../src/core/features.ts");
const { VERSION } = await import("../src/version.ts");
const { isJsonPostRouteContract } = await import("@emdash-cms/plugin-types");

features.registerFeatures(["ai", "ai.entities", "ai.glossaryLinks", "ai.imageText", "ai.descriptions"].map((id) => ({ id, label: id, description: "", default: false })));

const ctxWith = (stored) => ({ settings: { get: async (key) => (key === "features" ? stored : null) } });
const log = { info() {}, warn() {}, error() {}, debug() {} };

test("the descriptor: a native plugin at @coywolf/emdash/editor, no React admin (EmDash lists editor actions only without one), the draft capabilities", () => {
	const d = editor.coywolfEditorPlugin({ read: ["title", "content"], patch: ["content"] });
	assert.equal(d.id, "coywolf-pack-editor");
	assert.equal(d.format, "native");
	assert.equal(d.entrypoint, "@coywolf/emdash/editor");
	assert.equal(d.version, VERSION);
	assert.equal(d.adminEntry, undefined);
	assert.deepEqual(d.capabilities, ["admin.editor-draft:read", "admin.editor-draft:patch"]);
	assert.deepEqual(d.options, { read: ["title", "content"], patch: ["content"] });
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./editor"], "./src/editor.ts");
	assert.equal(typeof editor.createPlugin, "function", "EmDash imports { createPlugin } from a native plugin's entrypoint");
});

test("the action: AI Enrich in the toolbar, its route private POST JSON for admins; always listed, whatever the switches say; the fields it may patch are read too", async () => {
	const plugin = editor.createPlugin({ read: ["title", "content", "excerpt", "featured_image"], patch: ["content", "featured_image"] });
	assert.equal(features.knownFeatures(), null);
	const [action] = plugin.admin.editorActions;
	assert.deepEqual(action, {
		id: "ai-enrich",
		label: "AI Enrich",
		route: "enrich",
		placement: "toolbar",
		draft: { read: { fields: ["title", "content", "excerpt", "featured_image"] }, patch: { fields: ["content", "featured_image"] } },
	});
	assert.equal(action.confirm, undefined);
	assert.equal(action.collections, undefined, "the collections AI Enrichment covers are a setting: the route answers for the others");
	const route = plugin.routes.enrich;
	assert.equal(route.permission, "plugins:manage");
	assert.equal(route.public, undefined);
	assert.deepEqual(route.methods, ["POST"]);
	assert.equal(isJsonPostRouteContract(route), true);
	assert.deepEqual(plugin.capabilities, ["admin.editor-draft:read", "admin.editor-draft:patch"]);

	// The defaults: the collection's translatable fields.
	assert.deepEqual(editor.createPlugin().admin.editorActions[0].draft, { read: { translatable: true }, patch: { translatable: true } });

	// A field the patch may set is read too: one that isn't in the draft is never patched.
	assert.deepEqual(editor.createPlugin({ read: ["title"], patch: ["content"] }).admin.editorActions[0].draft, { read: { fields: ["title", "content"] }, patch: { fields: ["content"] } });
	assert.deepEqual(editor.createPlugin({ patch: ["content"] }).admin.editorActions[0].draft, { read: { translatable: true, fields: ["content"] }, patch: { fields: ["content"] } });

	// Listed whatever the switches this isolate last read say (a click answers "off"): a list that followed them could
	// lag a change by minutes, and EmDash answers a click on an unlisted action with a 404.
	await features.ctxFeatures(ctxWith({ ai: false, "ai.entities": true, "ai.glossaryLinks": true, "ai.imageText": true }));
	assert.equal(plugin.admin.editorActions.length, 1, "AI Enrichment off");
	await features.ctxFeatures(ctxWith({ ai: true, "ai.entities": true }));
	assert.equal(plugin.admin.editorActions.length, 1, "entities without glossary.io links, and no image text");
	assert.equal(Object.getOwnPropertyDescriptor(plugin.admin, "editorActions")?.get, undefined, "a plain list");
});

test("the route hands the draft to the pack's ai/editor-enrich through EmDash's dispatcher, with the caller and the patch selector, and returns its answer", async () => {
	bridge.resetDispatchForTests();
	const plugin = editor.createPlugin({ patch: ["content"] });
	const input = { type: "editor_action", draft: { collection: "posts", entryId: "E1", fields: { content: [] } } };
	const rc = { input, request: new Request("https://example.com/_emdash/api/content/posts/E1/plugin-extensions/coywolf-pack-editor/action/ai-enrich", { method: "POST" }), user: { id: "U1", role: 50 }, log };
	assert.match((await plugin.routes.enrich.handler(rc)).toast.message, /needs Coywolf Pack's middleware/);

	const calls = [];
	bridge.rememberDispatch(async (pluginId, method, path, request, user) => {
		calls.push({ pluginId, method, path, body: await request.json(), user });
		return { success: true, data: { toast: { type: "success", message: "Done." } } };
	});
	assert.deepEqual(await plugin.routes.enrich.handler(rc), { toast: { type: "success", message: "Done." } });
	assert.deepEqual(calls, [{ pluginId: "coywolf-pack", method: "POST", path: "ai/editor-enrich", body: { draft: input.draft, patch: { fields: ["content"] } }, user: rc.user }]);

	// A failed dispatch or a throw is a toast, never an error.
	bridge.rememberDispatch(async () => ({ success: false, error: { code: "NOT_FOUND", message: "Plugin not enabled: coywolf-pack" } }));
	assert.deepEqual(await plugin.routes.enrich.handler(rc), { toast: { type: "error", message: "AI Enrich didn't work: Plugin not enabled: coywolf-pack. Click again to retry." } });
	bridge.rememberDispatch(async () => {
		throw new Error("boom");
	});
	assert.equal((await plugin.routes.enrich.handler(rc)).toast.type, "error");
	bridge.rememberDispatch("not a function");
	assert.equal(typeof bridge.packDispatch(), "function", "anything else is ignored");
});

test("the pack's middleware remembers EmDash's dispatcher first, on every request", async () => {
	bridge.resetDispatchForTests();
	const { coywolfPack } = await import("../src/middleware.ts");
	const dispatch = async () => ({ success: true, data: {} });
	const context = { url: new URL("https://example.com/_astro/app.js"), request: new Request("https://example.com/_astro/app.js"), locals: { emdash: { handlePluginApiRoute: dispatch } } };
	const response = await coywolfPack()(context, async () => new Response("asset"));
	assert.equal(await response.text(), "asset");
	assert.equal(bridge.packDispatch(), dispatch);
	// A request without EmDash's locals changes nothing.
	await coywolfPack()({ ...context, locals: {} }, async () => new Response(""));
	assert.equal(bridge.packDispatch(), dispatch);
});

test("a direct POST to the pack's ai/editor-enrich clears no cached page and records no settings change: its answer is a patch for the editor's draft", async () => {
	const { purgesAfter } = await import("../src/pageCache/lib.ts");
	const pack = "/_emdash/api/plugins/coywolf-pack/";
	assert.equal(purgesAfter("POST", `${pack}ai/editor-enrich`), false);
	assert.equal(purgesAfter("POST", `${pack}ai/editor-enrich/more`), true, "only that route");
	assert.equal(purgesAfter("POST", `${pack}features/save`), true, "other pack saves still do");
});

/**
 * Whether the pack has started in this isolate: createPlugin() has run, so the
 * module-level state it sets (content URLs, term and page parents, the
 * read-only route list, the backup bucket…) is in place.
 *
 * Up to EmDash 1.4, its generated plugins module (virtual:emdash/plugins)
 * called createPlugin() as the Worker isolate started. Since 1.5.0 the module
 * exports a plugins() function that EmDash calls on its runtime's first start,
 * which EmDash's middleware begins before the pack's middleware runs. In one
 * rare path (EmDash's cold-start setup probe fails, so it renders without
 * waiting for its runtime) a page could render before that. The pack
 * middleware calls ensurePackStarted() first: it starts the plugins itself
 * through the same cached plugins() EmDash uses (no second instance), and a
 * page rendered while the pack still isn't started is kept out of the edge
 * cache (noteReadFailure).
 */

let ready = false;

/** createPlugin() calls this once the pack's module-level state is set. */
export function markPackReady(): void {
	ready = true;
}

/** True once createPlugin() has run in this isolate. */
export function packReady(): boolean {
	return ready;
}

type PluginsModule = { plugins?: unknown };

// @ts-ignore: provided by EmDash's Vite integration in the site build; absent under Node tests.
const loadPlugins = async (): Promise<PluginsModule> => (await import("virtual:emdash/plugins")) as PluginsModule;

/**
 * Makes sure createPlugin() has run, starting EmDash's plugins when it hasn't.
 * Returns false only when the pack is still not started after that. When the
 * plugins module can't be loaded (outside a site build, as under Node tests)
 * there's nothing to check, and it returns true.
 */
export async function ensurePackStarted(load: () => Promise<PluginsModule> = loadPlugins): Promise<boolean> {
	if (ready) return true;
	let mod: PluginsModule;
	try {
		mod = await load();
	} catch {
		return true;
	}
	// EmDash 1.5+: a function, cached per configuration on globalThis, so this is the instance EmDash uses.
	// EmDash 1.4: an array, created when the module loaded (createPlugin() has run by now).
	if (typeof mod.plugins === "function") {
		try {
			(mod.plugins as () => unknown)();
		} catch (error) {
			console.error("coywolf-pack: starting EmDash's plugins failed", error);
		}
	}
	return ready || !mod.plugins;
}

/** Tests only: back to "not started". */
export function resetPackReady(): void {
	ready = false;
}

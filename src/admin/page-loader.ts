/**
 * Loading a pack page's code on first visit (its own chunk), in a way that
 * can be tried again: React.lazy keeps a failed import's error for good, so
 * "Try again" needs a new lazy component that imports the page again.
 *
 * Kept free of JSX so tests can load it directly.
 */
import * as React from "react";

/**
 * A failed download of a page's code, rather than an error in the page: after
 * a deploy the old chunk names are gone (the admin tab still has the old ones),
 * or the network dropped. Trying the same import again doesn't help; reloading
 * the admin does.
 */
export function isChunkLoadError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.name === "ChunkLoadError" ||
		/dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(error.message)
	);
}

/** A page's lazy component, and `retry()`, which swaps in a new one that imports the page again. */
export function pageLoader(load: () => Promise<React.ComponentType>) {
	const make = () => React.lazy(async () => ({ default: await load() }));
	let lazy = make();
	return {
		get component() {
			return lazy;
		},
		retry() {
			lazy = make();
		},
	};
}

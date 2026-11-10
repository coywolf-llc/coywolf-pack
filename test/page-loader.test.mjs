// Run: node --test test/page-loader.test.mjs
//
// Lazy-loaded pack pages (src/admin/page-loader.ts, used by packPage in page.tsx): React.lazy
// keeps a failed import's error, so "Try again" must swap in a new lazy component; a failed
// download of the page's code (a deploy since the tab opened) is told apart, since only a
// reload helps there. Rendered with React in happy-dom.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import "./ts-resolve.mjs";

const { isChunkLoadError, pageLoader } = await import("../src/admin/page-loader.ts");

let window;
before(async () => {
	const { Window } = await import("happy-dom");
	window = new Window({ url: "https://example.com/_emdash/admin/plugins/coywolf-pack/schema" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => {
	await window?.happyDOM.close();
});

test("a failed download of a page's code is told apart from an error in the page", () => {
	assert.equal(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://example.com/_astro/schema.abc.js")), true, "Chrome");
	assert.equal(isChunkLoadError(new TypeError("Importing a module script failed.")), true, "Safari");
	assert.equal(isChunkLoadError(new TypeError("error loading dynamically imported module: https://example.com/_astro/schema.abc.js")), true, "Firefox");
	assert.equal(isChunkLoadError(Object.assign(new Error("Loading chunk 12 failed"), { name: "ChunkLoadError" })), true);
	assert.equal(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')")), false);
	assert.equal(isChunkLoadError("nope"), false);
});

test("Try again after a failed load: the same lazy component re-throws, a new one imports the page again", async () => {
	const React = await import("react");
	const { createRoot } = await import("react-dom/client");
	const h = React.createElement;

	let calls = 0;
	const loader = pageLoader(async () => {
		calls++;
		if (calls === 1) throw new Error("The server didn't answer");
		return () => h("p", null, "Schema page");
	});

	class Boundary extends React.Component {
		state = { error: null };
		static getDerivedStateFromError(error) {
			return { error };
		}
		render() {
			return this.state.error ? h("p", null, `Failed: ${this.state.error.message}`) : this.props.children;
		}
	}
	const boundary = React.createRef();
	// What packPage renders, each render reading the loader's current component.
	const page = () => h(Boundary, { ref: boundary }, h(React.Suspense, { fallback: h("p", null, "Loading…") }, h(loader.component)));

	const container = window.document.createElement("div");
	window.document.body.appendChild(container);
	const root = createRoot(container);
	const originalError = console.error;
	console.error = () => {};
	try {
		await React.act(async () => root.render(page()));
		assert.equal(container.textContent, "Failed: The server didn't answer");

		// Resetting the boundary alone: React.lazy hands back the same rejection, without importing again.
		await React.act(async () => boundary.current.setState({ error: null }));
		assert.equal(container.textContent, "Failed: The server didn't answer");
		assert.equal(calls, 1);

		// What "Try again" does: a new lazy component, then render again.
		loader.retry();
		await React.act(async () => {
			boundary.current.setState({ error: null });
			root.render(page());
		});
		assert.equal(container.textContent, "Schema page");
		assert.equal(calls, 2);
	} finally {
		console.error = originalError;
		await React.act(async () => root.unmount());
	}
});

test("packPage uses it: Try again rebuilds the page's lazy component; a failed download offers only a reload", () => {
	const page = readFileSync(new URL("../src/admin/page.tsx", import.meta.url), "utf8");
	assert.match(page, /const loader = pageLoader\(load\);/);
	assert.match(page, /const Lazy = loader\.component;/);
	assert.match(page, /<PageErrorBoundary name=\{name\} onRetry=\{retry\}>/);
	assert.match(page, /const download = isChunkLoadError\(error\);/);
	assert.match(page, /\{!download && \(\s*<Button/);
	assert.match(page, /this\.props\.onRetry\?\.\(\);\s*this\.setState\(\{ error: null \}\);/);
});

// Run: node --test test/features-draft.test.mjs
//
// The Features page's draft hook (src/admin/features-draft.ts), for what the page's own controls can't reach
// (test/features-page.test.mjs renders the real page): a save in flight ignores switches and a second save, and
// when the sidebar can't be refreshed in place the page reloads after the save, never with unsaved changes, back
// at its scroll position (a stored position older than 30 seconds is ignored) and with the save's result told
// once it's back. Rendered with React in happy-dom against a fake features/list and features/save.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import "./ts-resolve.mjs";

let window;
let React;
before(async () => {
	const { Window } = await import("happy-dom");
	window = new Window({ url: "https://example.com/_emdash/admin/plugins/coywolf-pack/features" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "sessionStorage", "Event"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	React = await import("react");
});
after(async () => {
	await window?.happyDOM.close();
});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	window.sessionStorage.clear();
});

const { useFeatureDraft, changedSwitches, switchesOf, SCROLL_MAX_AGE_MS } = await import("../src/admin/features-draft.ts");
const { refreshAdminManifest } = await import("../src/admin/extensions.ts");

const API = "/_emdash/api/plugins/coywolf-pack/features";
const SCROLL_KEY = "coywolf-pack:features-scroll";
const PATH = "/_emdash/admin/plugins/coywolf-pack/features";

/**
 * A fake server over `stored`. `hold`: the save waits until `release()`. `fail`: the save answers 500 without
 * storing; `failAfterStore`: stores, then answers 500. `meanwhile`: another admin's changes, stored with the next save.
 */
function server(stored, options = {}) {
	const catalog = [
		{ id: "cwA", features: ["cwA", "cwA.one", "cwA.two"] },
		{ id: "cwB", features: ["cwB", "cwB.x"] },
	];
	const calls = [];
	let release = () => {};
	globalThis.fetch = async (url, init = {}) => {
		const call = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
		calls.push(call);
		const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
		if (call.url === `${API}/list`) return reply({ data: { modules: catalog.map((m) => ({ id: m.id, label: m.id, features: m.features.map((id) => ({ id, label: id, description: "", enabled: stored[id], choice: stored[id] })) })) } });
		if (options.hold) await new Promise((resolve) => (release = resolve));
		Object.assign(stored, options.meanwhile);
		if (options.fail) return reply({ error: { message: options.fail } }, 500);
		Object.assign(stored, call.body.features);
		if (options.failAfterStore) return reply({ error: { message: options.failAfterStore } }, 500);
		return reply({ data: { features: { ...stored }, choices: { ...stored } } });
	};
	return { posts: () => calls.filter((c) => c.method === "POST"), release: () => release() };
}

const settle = () =>
	React.act(async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});

/** The hook in EmDash's scrolling <main>, with its effects counted. `refreshes: false`: no client to refresh the sidebar in place. */
async function mount({ refreshes = true } = {}) {
	const { createRoot } = await import("react-dom/client");
	const h = React.createElement;
	const log = [];
	const effects = {
		refreshManifest: () => (log.push("refresh"), refreshes),
		resetUpdates: () => void log.push("resetUpdates"),
		saved: () => void log.push("saved"),
		failed: (message) => void log.push(`failed: ${message}`),
		clear() {},
		reload: () => void log.push("reload"),
	};
	const hook = {};
	function Page() {
		const root = React.useRef(null);
		hook.current = useFeatureDraft(effects, root);
		return h("div", { ref: root, style: { height: "4000px" } });
	}
	const main = window.document.createElement("main");
	main.style.overflowY = "auto";
	window.document.body.appendChild(main);
	const root = createRoot(main);
	await React.act(async () => root.render(h(Page)));
	await settle();
	return {
		main,
		log,
		hook,
		act: (fn) => React.act(async () => fn()),
		async unmount() {
			await React.act(async () => root.unmount());
			main.remove();
		},
	};
}

const START = { cwA: true, "cwA.one": true, "cwA.two": false, cwB: false, "cwB.x": false };

test("the changed switches: only those that differ from what's saved; each feature's own switch from the list", () => {
	assert.deepEqual(changedSwitches({ a: true, b: false, c: true }, { a: true, b: true, c: false }), { b: false, c: true });
	assert.deepEqual(changedSwitches({ a: true }, { a: true }), {});
	assert.deepEqual(switchesOf([{ id: "m", label: "", features: [{ id: "m", enabled: false, choice: false }, { id: "m.p", enabled: false, choice: true }, { id: "m.q", enabled: true }] }]), { m: false, "m.p": true, "m.q": true });
});

test("a save in flight: a switch changed meanwhile is ignored, and a second save sends nothing", async () => {
	const s = server({ ...START }, { hold: true });
	const p = await mount();
	try {
		await p.act(() => p.hook.current.set("cwB", true));
		// Two presses in one tick, then another once the page shows it's saving.
		await p.act(() => {
			void p.hook.current.save();
			void p.hook.current.save();
		});
		assert.equal(p.hook.current.saving, true);
		await p.act(() => void p.hook.current.save());
		await p.act(() => p.hook.current.set("cwA.two", true));
		assert.equal(p.hook.current.draft["cwA.two"], false, "not changed while saving (it would be lost when the save comes back)");
		assert.equal(s.posts().length, 1);
		s.release();
		await settle();
		assert.equal(p.hook.current.saving, false);
		assert.equal(p.hook.current.dirty, false);
		assert.equal(s.posts().length, 1, "one request in all");
		assert.deepEqual(p.log, ["refresh", "saved"]);
	} finally {
		await p.unmount();
	}
});

test("no client to refresh the sidebar: the page reloads after the save at the same scroll position, and says it saved once it's back", async () => {
	server({ ...START });
	const p = await mount({ refreshes: false });
	try {
		await p.act(() => p.hook.current.set("cwB", true));
		assert.deepEqual(p.log, [], "nothing while there are unsaved changes");
		p.main.scrollTop = 240;
		const before = Date.now();
		await p.act(() => void p.hook.current.save());
		await settle();
		assert.deepEqual(p.log, ["refresh", "reload"], "reloaded once the save is in; the toast waits for the page to come back");
		const entry = JSON.parse(window.sessionStorage.getItem(SCROLL_KEY));
		assert.equal(entry.path, PATH);
		assert.equal(entry.top, 240);
		assert.equal(entry.saved, true);
		assert.ok(entry.at >= before && entry.at <= Date.now());
	} finally {
		await p.unmount();
	}
	// The page again, after the reload: back where it was, the toast, once.
	const again = await mount();
	try {
		assert.equal(again.main.scrollTop, 240);
		assert.deepEqual(again.log, ["saved"]);
		assert.equal(window.sessionStorage.getItem(SCROLL_KEY), null);
	} finally {
		await again.unmount();
	}
});

test("a stored scroll position older than 30 seconds (or from another page) is ignored, and removed", async () => {
	server({ ...START });
	for (const entry of [
		{ path: PATH, top: 240, at: Date.now() - SCROLL_MAX_AGE_MS - 1000, saved: true },
		{ path: "/_emdash/admin/plugins/coywolf-pack/schema", top: 240, at: Date.now(), saved: true },
		{ path: PATH, top: 240, saved: true },
	]) {
		window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify(entry));
		const p = await mount();
		try {
			assert.equal(p.main.scrollTop, 0, JSON.stringify(entry));
			assert.deepEqual(p.log, []);
			assert.equal(window.sessionStorage.getItem(SCROLL_KEY), null);
		} finally {
			await p.unmount();
		}
	}
});

test("never a reload with unsaved changes: a failed save while another admin turned a module on waits until the draft is clean", async () => {
	// The save isn't stored, but Module B was turned on meanwhile: the sidebar is stale, and the user's change is still unsaved.
	server({ ...START }, { fail: "The database is busy", meanwhile: { cwB: true } });
	const p = await mount({ refreshes: false });
	try {
		await p.act(() => p.hook.current.set("cwA.two", true));
		await p.act(() => void p.hook.current.save());
		await settle();
		assert.equal(p.hook.current.dirty, true, "the user's change is kept, on top of what's stored now");
		assert.equal(p.hook.current.draft.cwB, true, "another admin's change is taken in");
		assert.deepEqual(p.log, ["refresh", "failed: The database is busy"], "no reload while it's unsaved");
		await p.act(() => p.hook.current.discard());
		await settle();
		assert.deepEqual(p.log, ["refresh", "failed: The database is busy", "reload"], "clean again: the page reloads for the sidebar");
		assert.equal(JSON.parse(window.sessionStorage.getItem(SCROLL_KEY)).failed, undefined, "the failure was already told");
	} finally {
		await p.unmount();
	}
});

test("a failed save that was really stored, with no client: the page reloads, then tells the failure", async () => {
	server({ ...START }, { failAfterStore: "The switches are saved, but a task couldn't be scheduled." });
	const p = await mount({ refreshes: false });
	try {
		await p.act(() => p.hook.current.set("cwB", true));
		await p.act(() => void p.hook.current.save());
		await settle();
		assert.equal(p.hook.current.dirty, false);
		assert.deepEqual(p.log, ["refresh", "reload"]);
	} finally {
		await p.unmount();
	}
	const again = await mount();
	try {
		assert.deepEqual(again.log, ["failed: The switches are saved, but a task couldn't be scheduled."]);
	} finally {
		await again.unmount();
	}
});

test("refreshAdminManifest: invalidates [\"manifest\"] on the admin's own client, from the router's context", () => {
	const calls = [];
	const queryClient = { getQueryData: () => undefined, invalidateQueries: (filters) => (calls.push(filters), Promise.resolve()) };
	const router = { navigate() {}, history: { block: () => () => {} }, options: { basepath: "/_emdash/admin", context: { queryClient } } };
	assert.equal(refreshAdminManifest({ __TSR_ROUTER__: router }), true);
	assert.deepEqual(calls, [{ queryKey: ["manifest"] }]);
	assert.equal(refreshAdminManifest({}), false, "no router");
	assert.equal(refreshAdminManifest({ __TSR_ROUTER__: { ...router, options: { basepath: "/_emdash/admin", context: {} } } }), false, "no client");
});

// Run: node --test test/features-page.test.mjs
//
// The Features page's switches (src/admin/features.tsx with its draft, src/admin/features-draft.ts): a click
// changes the draft only, Save sends one request with only the switches that changed, Discard reverts, and the
// admin manifest (the sidebar) is refreshed only when a module's main switch changed, through the admin's own
// React Query client (src/admin/extensions.ts refreshAdminManifest). Rendered with React and the installed
// Kumo Switch in happy-dom, against a fake features/list and features/save.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, test } from "node:test";

import "./ts-resolve.mjs";

let window;
before(async () => {
	const { Window } = await import("happy-dom");
	window = new Window({ url: "https://example.com/_emdash/admin/plugins/coywolf-pack/features" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "sessionStorage"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => {
	await window?.happyDOM.close();
});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	window.sessionStorage.clear();
});

const { useFeatureDraft, changedSwitches, switchesOf } = await import("../src/admin/features-draft.ts");
const { refreshAdminManifest } = await import("../src/admin/extensions.ts");

const API = "/_emdash/api/plugins/coywolf-pack/features";

/** A fake server: features/list and features/save over `stored` (each feature's own switch), like src/core/features-module.ts. */
function server(stored, { fail } = {}) {
	const catalog = [
		{ id: "cwA", label: "Module A", features: ["cwA", "cwA.one", "cwA.two"] },
		{ id: "cwB", label: "Module B", features: ["cwB", "cwB.x"] },
		{ id: "updates", label: "Update check", features: ["updates"] },
	];
	const applies = () => Object.fromEntries(Object.entries(stored).map(([id, on]) => [id, on && (!id.includes(".") || stored[id.slice(0, id.indexOf("."))])]));
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		const call = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
		calls.push(call);
		const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
		if (call.url === `${API}/list`) {
			const now = applies();
			return reply({ data: { modules: catalog.map((m) => ({ id: m.id, label: m.label, features: m.features.map((id) => ({ id, label: id, description: "", enabled: now[id], choice: stored[id] })) })) } });
		}
		if (call.url === `${API}/save` && call.method === "POST") {
			if (fail) return reply({ error: { code: "INTERNAL", message: fail } }, 500);
			Object.assign(stored, call.body.features);
			return reply({ data: { features: applies(), choices: { ...stored } } });
		}
		return reply({ error: { message: "not found" } }, 404);
	};
	return { calls, posts: () => calls.filter((c) => c.method === "POST") };
}

/**
 * The page's switches and Save bar buttons, as features.tsx renders them (checked by the source test below),
 * with the effects counted.
 */
async function renderPage({ refreshes = true } = {}) {
	const React = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { Switch } = await import("@cloudflare/kumo");
	const h = React.createElement;
	const counts = { refreshManifest: 0, resetUpdates: 0, saved: 0, failed: [], reload: 0 };
	const effects = {
		refreshManifest: () => (counts.refreshManifest++, refreshes),
		resetUpdates: () => void counts.resetUpdates++,
		saved: () => void counts.saved++,
		failed: (message) => void counts.failed.push(message),
		clear() {},
		reload: () => void counts.reload++,
	};
	const page = {};
	function Page() {
		const root = React.useRef(null);
		const features = useFeatureDraft(effects, root);
		page.current = features;
		const { modules, draft, saving } = features;
		return h(
			"div",
			{ ref: root },
			draft &&
				modules?.map((module) => {
					const [main, ...subs] = module.features;
					const mainOn = draft[main.id] ?? false;
					return h(
						"section",
						{ key: module.id },
						h(Switch, { "aria-label": `${main.label}: ${mainOn ? "on" : "off"}`, checked: mainOn, disabled: saving, onCheckedChange: (on) => features.set(main.id, on) }),
						subs.map((feature) => {
							const on = Boolean(draft[feature.id]) && mainOn;
							return h(Switch, { key: feature.id, size: "sm", "aria-label": `${feature.label}: ${on ? "on" : "off"}`, checked: on, disabled: saving || !mainOn, onCheckedChange: (next) => features.set(feature.id, next) });
						}),
					);
				}),
			features.dirty && h("button", { type: "button", "data-save": "", onClick: () => void features.save() }, "Save"),
			features.dirty && h("button", { type: "button", "data-discard": "", onClick: features.discard }, "Discard"),
		);
	}
	// EmDash's scrolling <main>.
	const main = window.document.createElement("main");
	main.style.overflowY = "auto";
	window.document.body.appendChild(main);
	const root = createRoot(main);
	await React.act(async () => root.render(h(Page)));
	const switchFor = (id) => main.querySelector(`[role="switch"][aria-label^="${id}:"]`);
	return {
		main,
		page,
		counts,
		switchFor,
		checked: (id) => switchFor(id).getAttribute("aria-checked") === "true",
		click: (id) => React.act(async () => switchFor(id).click()),
		save: () => React.act(async () => main.querySelector("[data-save]").click()),
		discard: () => React.act(async () => main.querySelector("[data-discard]").click()),
		saveBar: () => Boolean(main.querySelector("[data-save]")),
		async unmount() {
			await React.act(async () => root.unmount());
			main.remove();
		},
	};
}

test("the changed switches: only those that differ from what's saved", () => {
	assert.deepEqual(changedSwitches({ a: true, b: false, c: true }, { a: true, b: true, c: false }), { b: false, c: true });
	assert.deepEqual(changedSwitches({ a: true }, { a: true }), {});
	// Each feature's own switch from features/list (`enabled` only from a route that doesn't send `choice`).
	assert.deepEqual(switchesOf([{ id: "m", label: "", features: [{ id: "m", enabled: false, choice: false }, { id: "m.p", enabled: false, choice: true }, { id: "m.q", enabled: true }] }]), { m: false, "m.p": true, "m.q": true });
});

test("clicking a switch changes the draft only: no request, and the Save bar shows", async () => {
	const s = server({ cwA: true, "cwA.one": true, "cwA.two": false, cwB: false, "cwB.x": false, updates: true });
	const p = await renderPage();
	try {
		assert.deepEqual(s.calls.map((c) => c.url), [`${API}/list`]);
		assert.equal(p.saveBar(), false);
		await p.click("cwA.two");
		await p.click("cwB");
		assert.equal(p.checked("cwA.two"), true);
		assert.equal(p.checked("cwB"), true);
		assert.match(p.switchFor("cwB").getAttribute("aria-label"), /: on$/, "the label follows the draft");
		assert.deepEqual(s.posts(), [], "nothing is saved on click");
		assert.equal(p.counts.refreshManifest, 0, "nor is the sidebar refreshed");
		assert.equal(p.saveBar(), true);
	} finally {
		await p.unmount();
	}
});

test("Save sends one request with only the changed switches; then the page shows what's saved, clean", async () => {
	const s = server({ cwA: true, "cwA.one": true, "cwA.two": false, cwB: false, "cwB.x": false, updates: true });
	const p = await renderPage();
	try {
		await p.click("cwB");
		await p.click("cwB.x");
		// Changed and changed back: not sent.
		await p.click("cwA.one");
		await p.click("cwA.one");
		await p.save();
		assert.equal(s.posts().length, 1, "one request");
		assert.deepEqual(s.posts()[0], { url: `${API}/save`, method: "POST", body: { features: { cwB: true, "cwB.x": true } } });
		assert.equal(p.saveBar(), false, "saved: nothing left to save");
		assert.equal(p.checked("cwB.x"), true);
		assert.equal(p.counts.saved, 1);
		assert.equal(p.counts.refreshManifest, 1, "a module was turned on: the sidebar is refreshed once");
		assert.equal(p.counts.reload, 0);
		assert.deepEqual(s.calls.map((c) => c.url), [`${API}/list`, `${API}/save`], "no reload of the list either");
	} finally {
		await p.unmount();
	}
});

test("Discard puts the draft back, without a request", async () => {
	const s = server({ cwA: true, "cwA.one": true, "cwA.two": false, cwB: false, "cwB.x": false, updates: true });
	const p = await renderPage();
	try {
		await p.click("cwA.one");
		await p.click("cwA");
		assert.equal(p.checked("cwA"), false);
		assert.equal(p.switchFor("cwA.two").hasAttribute("disabled"), true, "a part can't be switched while its module is off in the draft");
		await p.discard();
		assert.equal(p.checked("cwA"), true);
		assert.equal(p.checked("cwA.one"), true);
		assert.equal(p.switchFor("cwA.two").hasAttribute("disabled"), false);
		assert.equal(p.saveBar(), false);
		assert.deepEqual(s.posts(), []);
	} finally {
		await p.unmount();
	}
});

test("the sidebar is refreshed only when a module's main switch changed, once per save; the update notices reset only for the update check", async () => {
	const s = server({ cwA: true, "cwA.one": true, "cwA.two": false, cwB: true, "cwB.x": false, updates: true });
	const p = await renderPage();
	try {
		// Parts only: no refresh.
		await p.click("cwA.two");
		await p.click("cwB.x");
		await p.save();
		assert.equal(s.posts().length, 1);
		assert.equal(p.counts.refreshManifest, 0);
		assert.equal(p.counts.resetUpdates, 0);

		// Two modules (and a part) in one save: one refresh.
		await p.click("cwA.one");
		await p.click("cwA");
		await p.click("updates");
		await p.save();
		assert.deepEqual(s.posts()[1].body, { features: { cwA: false, "cwA.one": false, updates: false } });
		assert.equal(p.counts.refreshManifest, 1);
		assert.equal(p.counts.resetUpdates, 1);
	} finally {
		await p.unmount();
	}
});

test("a module off with its parts on: turning it on in the draft shows the parts as they'll be once saved", async () => {
	server({ cwA: false, "cwA.one": true, "cwA.two": false, cwB: false, "cwB.x": false, updates: true });
	const p = await renderPage();
	try {
		assert.equal(p.checked("cwA.one"), false, "off while its module is");
		assert.equal(p.switchFor("cwA.one").hasAttribute("disabled"), true);
		await p.click("cwA");
		assert.equal(p.checked("cwA.one"), true, "its own switch");
		assert.equal(p.checked("cwA.two"), false);
	} finally {
		await p.unmount();
	}
});

test("a failed save keeps the draft and reports the message; nothing is refreshed or reloaded", async () => {
	const s = server({ cwA: true, "cwA.one": true, "cwA.two": false, cwB: false, "cwB.x": false, updates: true }, { fail: "The database is busy" });
	const p = await renderPage({ refreshes: false });
	try {
		await p.click("cwB");
		await p.save();
		assert.equal(s.posts().length, 1);
		assert.deepEqual(p.counts.failed, ["The database is busy"]);
		assert.equal(p.checked("cwB"), true, "the draft is kept");
		assert.equal(p.saveBar(), true);
		assert.equal(p.counts.refreshManifest, 0);
		assert.equal(p.counts.reload, 0, "never a reload with unsaved changes");
	} finally {
		await p.unmount();
	}
});

test("no way to refresh the sidebar in place: after the save, the page reloads at the same scroll position", async () => {
	server({ cwA: true, "cwA.one": true, "cwA.two": false, cwB: false, "cwB.x": false, updates: true });
	const p = await renderPage({ refreshes: false });
	try {
		await p.click("cwB");
		assert.equal(p.counts.reload, 0, "not while there are unsaved changes");
		p.main.scrollTop = 240;
		await p.save();
		assert.equal(p.counts.reload, 1, "reloaded once the save is in");
		assert.deepEqual(JSON.parse(window.sessionStorage.getItem("coywolf-pack:features-scroll")), { path: "/_emdash/admin/plugins/coywolf-pack/features", top: 240 });
	} finally {
		await p.unmount();
	}
	// The page again, after the reload: back where it was, once.
	const again = await renderPage();
	try {
		assert.equal(again.main.scrollTop, 240);
		assert.equal(window.sessionStorage.getItem("coywolf-pack:features-scroll"), null);
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

test("features.tsx: switches edit the draft, the shared Save bar is the page's last child, and the manifest is refreshed in place first", () => {
	const src = readFileSync(new URL("../src/admin/features.tsx", import.meta.url), "utf8");
	// No request of its own: the draft hook saves, in one request.
	assert.doesNotMatch(src, /apiFetch|features\/save|postJson|apiPost/);
	assert.match(src, /const features = useFeatureDraft\(/);
	assert.match(src, /onCheckedChange=\{\(on\) => features\.set\(main\.id, on\)\}/);
	assert.match(src, /onCheckedChange=\{\(next\) => features\.set\(feature\.id, next\)\}/);
	assert.match(src, /aria-label=\{`\$\{main\.label\}: \$\{mainOn \? "on" : "off"\}`\}/);
	assert.match(src, /aria-label=\{`\$\{feature\.label\}: \$\{on \? "on" : "off"\}`\}/);
	assert.match(src, /disabled=\{saving \|\| !mainOn\}/);
	// The Save bar, as on the other settings pages: the last child of the page's root, with the failed save's message and Discard.
	assert.match(src, /<SaveBar\s+error=\{result\.error\}\s+dirty=\{features\.dirty\}\s+saving=\{saving\}\s+onSave=\{\(\) => void features\.save\(\)\}\s+onDiscard=\{features\.discard\}\s+\/>\s+<\/div>\s+\);\s+\}\s*$/);
	assert.match(src, /const result = useSaveResult\(\);/);
	// The admin's own client first (the pack's useQueryClient can be another copy's), never a reload from the page itself.
	assert.match(src, /if \(refreshAdminManifest\(\)\) return true;\s*if \(!queryClient\) return false;/);
	assert.doesNotMatch(src, /location\.reload/);
	assert.match(src, /resetUpdates: resetUpdateStatus/);
	// The Cloudflare token card keeps its own buttons.
	assert.match(src, /<CloudflareTokenCard \/>/);
});

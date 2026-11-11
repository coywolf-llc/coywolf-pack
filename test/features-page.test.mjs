// Run: node --test test/features-page.test.mjs
//
// The real Features page (src/admin/features.tsx, compiled by test/tsx-loader.mjs) in happy-dom, with the
// installed Kumo, the shared Save bar and a fake features/list and features/save: a click changes the draft
// only, Save sends one request with only the switches that changed, Discard reverts, the sidebar (the admin
// manifest, through the admin's own React Query client on the router's context) is refreshed only when a
// module's main switch changed, and a failed save that was really stored leaves the page as it's stored.
// The draft hook's own rules (a save in flight, the reload fallback) are in test/features-draft.test.mjs.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import "./tsx-loader.mjs";

const API = "/_emdash/api/plugins/coywolf-pack";

let window;
let React;
let h;
let act;
let createRoot;
let Toasty;
let FeaturesPage;
before(async () => {
	const { Window } = await import("happy-dom");
	window = new Window({ url: "https://example.com/_emdash/admin/plugins/coywolf-pack/features" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "sessionStorage", "KeyboardEvent", "Event", "CustomEvent"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	React = await import("react");
	h = React.createElement;
	act = React.act;
	({ createRoot } = await import("react-dom/client"));
	({ Toasty } = await import("@cloudflare/kumo"));
	({ FeaturesPage } = await import("../src/admin/features.tsx"));
});
after(async () => {
	await window?.happyDOM.close();
});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete globalThis.__TSR_ROUTER__;
});

/** EmDash's admin router, with its own React Query client on its context (createAdminRouter); counts manifest refreshes. */
function adminRouter() {
	const refreshes = [];
	globalThis.__TSR_ROUTER__ = {
		navigate() {},
		history: { block: () => () => {} },
		options: { basepath: "/_emdash/admin", context: { queryClient: { getQueryData: () => undefined, invalidateQueries: (filters) => void refreshes.push(filters) } } },
	};
	return refreshes;
}

const TOKEN_STATUS = { saved: true, unreadable: false, env: false, accountId: null, older: [], r2KeyPair: false, r2Leftovers: false, r2Page: "File Downloads (large uploads)", olderSecrets: [] };

/**
 * A fake server over `stored` (each feature's own switch), answering as src/core/features-module.ts does.
 * `failAfterStore`: stores the switches, then answers 500 (as when a task can't be scheduled). `fail`: answers 500
 * without storing. `meanwhile`: another admin's changes, stored with the next save. `noChoices`: a save answers
 * `features` only.
 */
function server(stored, options = {}) {
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
		if (call.url === `${API}/features/list`) {
			const now = applies();
			return reply({ data: { modules: catalog.map((m) => ({ id: m.id, label: m.label, features: m.features.map((id) => ({ id, label: id, description: `About ${id}`, enabled: now[id], choice: stored[id] })) })) } });
		}
		if (call.url === `${API}/features/save` && call.method === "POST") {
			if (options.fail) return reply({ error: { code: "INTERNAL", message: options.fail } }, 500);
			Object.assign(stored, options.meanwhile, call.body.features);
			if (options.failAfterStore) return reply({ error: { code: "TASK_SCHEDULE_FAILED", message: options.failAfterStore } }, 500);
			return reply({ data: options.noChoices ? { features: applies() } : { features: applies(), choices: { ...stored } } });
		}
		if (call.url === `${API}/cloudflare-token/status`) return reply({ data: { ...TOKEN_STATUS, ...options.token } });
		return reply({ error: { message: "not found" } }, 404);
	};
	return { calls, posts: () => calls.filter((c) => c.method === "POST"), lists: () => calls.filter((c) => c.url === `${API}/features/list`).length };
}

/** Lets the page's requests and their state updates finish. */
const settle = () =>
	act(async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});

/** The real FeaturesPage inside EmDash's scrolling <main> and Kumo's toast provider, as the admin renders it. */
async function renderPage() {
	const main = window.document.createElement("main");
	main.style.overflowY = "auto";
	window.document.body.appendChild(main);
	const root = createRoot(main);
	await act(async () => root.render(h(Toasty, null, h(FeaturesPage))));
	await settle();
	const switchFor = (id) => main.querySelector(`[role="switch"][aria-label^="${id}:"]`);
	const bar = () => main.querySelector('[role="region"][aria-label="Unsaved changes"]');
	const button = (label) => [...(bar()?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === label);
	return {
		main,
		switchFor,
		bar,
		checked: (id) => switchFor(id).getAttribute("aria-checked") === "true",
		disabled: (id) => switchFor(id).hasAttribute("disabled"),
		async click(id) {
			await act(async () => switchFor(id).click());
		},
		async save() {
			await act(async () => button("Save").click());
			await settle();
		},
		async discard() {
			await act(async () => button("Discard").click());
		},
		text: () => window.document.body.textContent,
		async unmount() {
			await act(async () => root.unmount());
			main.remove();
		},
	};
}

const START = { cwA: true, "cwA.one": true, "cwA.two": false, cwB: false, "cwB.x": false, updates: true };

test("clicking a switch changes the draft only: no request, and the Save bar shows as the page's last part", async () => {
	const s = server({ ...START });
	adminRouter();
	const p = await renderPage();
	try {
		assert.deepEqual(s.calls.map((c) => c.url).sort(), [`${API}/cloudflare-token/status`, `${API}/features/list`]);
		assert.equal(p.bar(), null);
		await p.click("cwA.two");
		await p.click("cwB");
		assert.equal(p.checked("cwA.two"), true);
		assert.equal(p.checked("cwB"), true);
		assert.equal(p.switchFor("cwB").getAttribute("aria-label"), "cwB: on", "the label follows the draft");
		assert.equal(p.switchFor("cwB.x").getAttribute("aria-label"), "cwB.x: off");
		assert.deepEqual(s.posts(), [], "nothing is saved on click");
		assert.ok(p.bar(), "the Save bar shows");
		const page = p.main.querySelector(".space-y-6");
		assert.equal(page.lastElementChild, p.bar(), "the bar is the page root's last child");
	} finally {
		await p.unmount();
	}
});

test("a part shows its own switch only while its module's draft switch is on, and can't be switched while it's off", async () => {
	server({ ...START, cwA: false, "cwA.one": true });
	adminRouter();
	const p = await renderPage();
	try {
		assert.equal(p.checked("cwA.one"), false, "off while its module is");
		assert.equal(p.disabled("cwA.one"), true);
		assert.equal(p.switchFor("cwA.one").getAttribute("aria-label"), "cwA.one: off");
		await p.click("cwA");
		assert.equal(p.checked("cwA.one"), true, "its own switch, as it'll be once saved");
		assert.equal(p.checked("cwA.two"), false);
		assert.equal(p.disabled("cwA.one"), false);
		await p.click("cwA");
		assert.equal(p.checked("cwA.one"), false);
		assert.equal(p.disabled("cwA.one"), true);
	} finally {
		await p.unmount();
	}
});

test("Save sends one request with only the changed switches, refreshes the sidebar once, and the page ends clean", async () => {
	const s = server({ ...START });
	const refreshes = adminRouter();
	const p = await renderPage();
	try {
		await p.click("cwB");
		await p.click("cwB.x");
		// Changed and changed back: not sent.
		await p.click("cwA.one");
		await p.click("cwA.one");
		await p.save();
		assert.equal(s.posts().length, 1, "one request");
		assert.deepEqual(s.posts()[0], { url: `${API}/features/save`, method: "POST", body: { features: { cwB: true, "cwB.x": true } } });
		assert.equal(p.bar(), null, "nothing left to save");
		assert.equal(p.checked("cwB.x"), true);
		assert.deepEqual(refreshes, [{ queryKey: ["manifest"] }], "a module was turned on: one refresh, in place");
		assert.equal(s.lists(), 1, "the page isn't loaded again");
		assert.match(p.text(), /Features saved/, "the success toast");
	} finally {
		await p.unmount();
	}
});

test("Ctrl/⌘+S saves too", async () => {
	const s = server({ ...START });
	adminRouter();
	const p = await renderPage();
	try {
		await p.click("cwA.two");
		await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true })));
		await settle();
		assert.deepEqual(s.posts().map((c) => c.body), [{ features: { "cwA.two": true } }]);
		assert.equal(p.bar(), null);
	} finally {
		await p.unmount();
	}
});

test("Discard puts the draft back, without a request", async () => {
	const s = server({ ...START });
	adminRouter();
	const p = await renderPage();
	try {
		await p.click("cwA.one");
		await p.click("cwA");
		assert.equal(p.disabled("cwA.two"), true);
		await p.discard();
		assert.equal(p.checked("cwA"), true);
		assert.equal(p.checked("cwA.one"), true);
		assert.equal(p.disabled("cwA.two"), false);
		assert.equal(p.bar(), null);
		assert.deepEqual(s.posts(), []);
	} finally {
		await p.unmount();
	}
});

test("parts only: no sidebar refresh; the update check: the notices ask again", async () => {
	const s = server({ ...START, cwB: true });
	const refreshes = adminRouter();
	let notices = 0;
	const onChanged = () => notices++;
	window.addEventListener("coywolf-pack:update-changed", onChanged);
	const p = await renderPage();
	try {
		await p.click("cwA.two");
		await p.click("cwB.x");
		await p.save();
		assert.equal(s.posts().length, 1);
		assert.deepEqual(refreshes, []);
		assert.equal(notices, 0);

		// Two modules and a part in one save: one refresh.
		await p.click("cwA.one");
		await p.click("cwA");
		await p.click("updates");
		await p.save();
		assert.deepEqual(s.posts()[1].body, { features: { cwA: false, "cwA.one": false, updates: false } });
		assert.equal(refreshes.length, 1);
		assert.equal(notices, 1);
	} finally {
		window.removeEventListener("coywolf-pack:update-changed", onChanged);
		await p.unmount();
	}
});

test("the saved switches come from the answer: another admin's change shows, and an answer without `choices` keeps the draft", async () => {
	const s = server({ ...START }, { meanwhile: { "cwA.two": true, cwB: true } });
	adminRouter();
	const p = await renderPage();
	try {
		await p.click("cwA.one");
		await p.save();
		assert.deepEqual(s.posts()[0].body, { features: { "cwA.one": false } });
		assert.equal(p.checked("cwA.two"), true, "stored by someone else meanwhile");
		assert.equal(p.checked("cwB"), true);
		assert.equal(p.checked("cwA.one"), false);
		assert.equal(p.bar(), null, "what's shown is what's saved");
	} finally {
		await p.unmount();
	}

	server({ ...START }, { noChoices: true });
	adminRouter();
	const q = await renderPage();
	try {
		await q.click("cwB");
		await q.click("cwB.x");
		await q.save();
		assert.equal(q.checked("cwB"), true);
		assert.equal(q.checked("cwB.x"), true);
		assert.equal(q.bar(), null);
	} finally {
		await q.unmount();
	}
});

test("a failed save that wasn't stored: the draft and the bar stay, with the message; Discard goes back to what's saved", async () => {
	const s = server({ ...START }, { fail: "The database is busy" });
	const refreshes = adminRouter();
	const p = await renderPage();
	try {
		await p.click("cwB");
		await p.save();
		assert.equal(s.posts().length, 1);
		assert.equal(s.lists(), 2, "the switches are read back");
		assert.equal(p.checked("cwB"), true, "the draft is kept");
		assert.ok(p.bar());
		assert.match(p.bar().textContent, /The database is busy/, "the message is on the bar");
		assert.deepEqual(refreshes, [], "nothing changed: no refresh");
		await p.discard();
		assert.equal(p.checked("cwB"), false);
		assert.equal(p.bar(), null);
	} finally {
		await p.unmount();
	}
});

test("a failed save that was really stored (a task couldn't be scheduled): the page shows what's stored, clean, with the message, and the sidebar is refreshed", async () => {
	const message = "The switches are saved, but cwBTask couldn't be scheduled, so it won't run yet: busy. Open the Features page again to retry.";
	const s = server({ ...START }, { failAfterStore: message, meanwhile: { "cwA.two": true } });
	const refreshes = adminRouter();
	const p = await renderPage();
	try {
		await p.click("cwB");
		await p.save();
		assert.equal(s.lists(), 2, "the switches are read back");
		assert.equal(p.checked("cwB"), true);
		assert.equal(p.checked("cwA.two"), true, "and what else was stored");
		assert.equal(p.bar(), null, "nothing left to save");
		assert.ok([...p.main.querySelectorAll('[role="alert"]')].some((a) => a.textContent.includes("The switches are saved, but")), "the message stays on the page");
		assert.deepEqual(refreshes, [{ queryKey: ["manifest"] }], "Module B was stored on: the sidebar is refreshed");

		// Discard now goes back to what's stored, not to the switches before the save.
		await p.click("cwA.one");
		await p.discard();
		assert.equal(p.checked("cwB"), true);
		assert.equal(p.checked("cwA.one"), true);
		assert.equal(p.checked("cwA.two"), true);
		assert.equal(p.bar(), null);
	} finally {
		await p.unmount();
	}
});

test("the token card says what large uploads use with leftover R2 values when the saved token can't be read", async () => {
	const cases = [
		[{ unreadable: true, saved: false, env: false, r2Leftovers: true }, /It isn't used: large uploads need the Cloudflare API token saved again \(the saved one can't be read\), or a complete key pair\./],
		[{ unreadable: true, saved: false, env: true, r2Leftovers: true }, /It isn't used: large uploads use the CLOUDFLARE_API_TOKEN Worker secret, since the saved token can't be read\./],
		[{ saved: true, r2Leftovers: true }, /It isn't used: large uploads use the Cloudflare API token\./],
	];
	for (const [token, expected] of cases) {
		server({ ...START }, { token });
		adminRouter();
		const p = await renderPage();
		try {
			assert.match(p.main.querySelector('[aria-labelledby="cw-cloudflare-token"]').textContent, expected);
		} finally {
			await p.unmount();
		}
	}
});

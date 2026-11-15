// Run: node --test test/buttondown-admin.test.mjs
//
// The real Buttondown Drafts page and entry editor panel (src/admin/buttondown.tsx, src/admin/editor-panels.tsx,
// compiled by test/tsx-loader.mjs) in happy-dom, with a fake server: the setup card without a key, Check key's
// four lines and its red warning, the rules form, the recent drafts with Retry, and the panel's buttons (Refresh
// asks first).
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import "./tsx-loader.mjs";

const API = "/_emdash/api/plugins/coywolf-pack";

let window;
let h;
let act;
let createRoot;
let Toasty;
let ButtondownPage;
let ButtondownPanel;
before(async () => {
	const { Window } = await import("happy-dom");
	window = new Window({ url: "https://example.com/_emdash/admin/plugins/coywolf-pack/buttondown" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "sessionStorage", "KeyboardEvent", "Event", "CustomEvent"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	const React = await import("react");
	h = React.createElement;
	act = React.act;
	({ createRoot } = await import("react-dom/client"));
	({ Toasty } = await import("@cloudflare/kumo"));
	({ ButtondownPage } = await import("../src/admin/buttondown.tsx"));
	({ ButtondownPanel } = await import("../src/admin/editor-panels.tsx"));
});
after(async () => {
	await window?.happyDOM.close();
});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const view = (extra = {}) => ({
	collection: "posts",
	entryId: "P1",
	state: "draft",
	text: "Draft in Buttondown.",
	job: null,
	emailId: "em_0000000000000000000000000a",
	appUrl: "https://buttondown.com/emails/em_0000000000000000000000000a",
	remoteStatus: "draft",
	title: "Why Claude has my attention",
	postUrl: "https://coywolf.com/newsletter/why/",
	createdAt: "2026-11-15T12:00:00.000Z",
	updatedAt: "2026-11-15T12:00:00.000Z",
	nextRetryAt: null,
	warnings: [],
	lastError: null,
	unpublished: false,
	trashed: false,
	deleted: false,
	manual: false,
	...extra,
});

const status = (extra = {}) => ({
	settings: { rules: [{ collection: "posts", taxonomy: "category", terms: ["newsletter"], since: "2026-11-10T00:00:00.000Z" }], footerLink: true },
	keySaved: true,
	keyUnreadable: false,
	updatesOn: false,
	siteHost: "coywolf.com",
	collections: [{ slug: "posts", label: "Posts", taxonomies: [{ name: "category", label: "Categories", hierarchical: true, terms: [{ slug: "newsletter", label: "Coywolf Newsletter", depth: 0 }, { slug: "seo", label: "SEO", depth: 0 }] }] }],
	recent: [view(), view({ entryId: "P2", title: "Broken one", state: "error", text: "Couldn't make or update the draft: Buttondown refused the key (401).", appUrl: null, emailId: null, lastError: { at: "", status: 401, code: null, message: "refused" } })],
	...extra,
});

function server(routes) {
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		const call = { url: String(url), body: init.body ? JSON.parse(init.body) : undefined };
		calls.push(call);
		const reply = (data, code = 200) => new Response(JSON.stringify(code === 200 ? { data } : { error: { message: data } }), { status: code, headers: { "Content-Type": "application/json" } });
		if (call.url === `${API}/features/list`) return reply({ modules: [{ id: "buttondown", features: [{ id: "buttondown", label: "Buttondown Drafts", description: "", enabled: true }, { id: "buttondown.updates", label: "Update drafts", description: "Update the draft.", enabled: false }] }] });
		const route = routes[call.url.slice(API.length + "/buttondown/".length)];
		if (route) {
			const out = await route(call.body);
			return out?.error ? reply(out.error, 400) : reply(out);
		}
		return reply("not found", 404);
	};
	return calls;
}

const settle = () =>
	act(async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});

async function render(element) {
	const main = window.document.createElement("main");
	window.document.body.appendChild(main);
	const root = createRoot(main);
	await act(async () => root.render(h(Toasty, null, element)));
	await settle();
	return {
		main,
		text: () => main.textContent,
		button: (label) => [...window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label),
		async click(label) {
			const b = [...window.document.querySelectorAll("button")].find((x) => x.textContent.trim() === label);
			assert.ok(b, `no button ${label}`);
			await act(async () => b.click());
			await settle();
		},
		async unmount() {
			await act(async () => root.unmount());
			main.remove();
		},
	};
}

test("no key: a setup card that points to the Settings page, and the rest of the page still loads", async () => {
	server({ status: () => status({ keySaved: false, recent: [] }) });
	const page = await render(h(ButtondownPage));
	try {
		assert.match(page.text(), /Add a Buttondown API key/);
		assert.match(page.text(), /only Emails and drafts → Write/);
		assert.ok([...page.main.querySelectorAll("a")].some((a) => a.getAttribute("href")?.endsWith("/plugins-manager/coywolf-pack/settings")));
		assert.equal(page.button("Check key"), undefined);
		assert.match(page.text(), /When to create a draft/);
		assert.match(page.text(), /No drafts yet/);
	} finally {
		await page.unmount();
	}
});

test("Check key: four lines from the status codes, and a red warning when the key can read newsletters or subscribers", async () => {
	let broad = false;
	server({
		status: () => status(),
		"key/check": () => ({ keySaved: true, keyUnreadable: false, check: { ping: 200, emails: 200, newsletters: broad ? 200 : 403, subscribers: 403 }, tooBroad: broad }),
	});
	const page = await render(h(ButtondownPage));
	try {
		await page.click("Check key");
		assert.match(page.text(), /The key works\./);
		assert.match(page.text(), /It can read and write drafts\./);
		assert.match(page.text(), /It can't read your newsletters or their keys\./);
		assert.match(page.text(), /It can't read your subscribers\./);
		assert.doesNotMatch(page.text(), /can do more than it needs/);
		broad = true;
		await page.click("Check key");
		assert.match(page.text(), /every newsletter's API key/);
		assert.match(page.text(), /This key can do more than it needs/);
		assert.ok(page.main.querySelector('[role="alert"]'));
	} finally {
		await page.unmount();
	}
});

test("rules: the saved rule with its date, a new rule that needs a term before it can be saved, and the save sends no since", async () => {
	const calls = server({ status: () => status(), "settings/save": (body) => ({ settings: { ...body, rules: body.rules.map((r) => ({ ...r, since: "2026-11-15T12:00:00.000Z" })) } }) });
	const page = await render(h(ButtondownPage));
	try {
		assert.match(page.text(), /Saved Nov (9|10), 2026/, "the rule's since, in local time");
		const checkboxes = () => [...page.main.querySelectorAll('[role="checkbox"], input[type="checkbox"]')];
		assert.ok(checkboxes().length >= 3, "two terms and the footer link");
		assert.equal(page.button("Add a rule").disabled, true, "one collection, already ruled: no second rule");
		await page.click("Remove rule");
		assert.match(page.text(), /No rules yet/);
		assert.equal(page.button("Add a rule").disabled, false);
		await page.click("Add a rule");
		assert.match(page.text(), /New: once saved/);
		// An incomplete rule isn't sent.
		const form = page.main.querySelector("#cw-buttondown-form");
		await act(async () => form.requestSubmit());
		await settle();
		assert.equal(calls.filter((c) => c.url.endsWith("/buttondown/settings/save")).length, 0);
		await page.click("Remove rule");
		await act(async () => form.requestSubmit());
		await settle();
		const save = calls.find((c) => c.url.endsWith("/buttondown/settings/save"));
		assert.deepEqual(save.body, { rules: [], footerLink: true }, "the page sends no since: the server stamps it");
	} finally {
		await page.unmount();
	}
});

test("recent drafts: state badges, Open in Buttondown, and Retry for a failed one", async () => {
	const calls = server({ status: () => status(), retry: () => ({ record: view({ entryId: "P2" }) }) });
	const page = await render(h(ButtondownPage));
	try {
		assert.match(page.text(), /Why Claude has my attention/);
		assert.match(page.text(), /Failed/);
		const open = [...page.main.querySelectorAll("a")].find((a) => a.textContent.includes("Open in Buttondown"));
		assert.equal(open.getAttribute("href"), "https://buttondown.com/emails/em_0000000000000000000000000a");
		assert.equal(open.getAttribute("target"), "_blank");
		await page.click("Retry");
		assert.deepEqual(calls.find((c) => c.url.endsWith("/buttondown/retry")).body, { collection: "posts", id: "P2" });
	} finally {
		await page.unmount();
	}
});

test("the panel: the draft's state and link; Create draft now; Refresh asks first and sends only after Refresh draft", async () => {
	let entry = { covered: true, published: true, matches: true, keySaved: true, record: null, canCreate: true, canRefresh: false, canRetry: false };
	const calls = server({
		entry: () => entry,
		sync: (body) => {
			entry = { ...entry, record: view(), canCreate: false, canRefresh: true };
			return { record: view({ text: body.action === "refresh" ? "Refreshed." : "Draft in Buttondown." }) };
		},
	});
	const panel = await render(h(ButtondownPanel, { collection: "posts", entry: { id: "P1", updatedAt: "u1" } }));
	try {
		assert.match(panel.text(), /published before the rule was saved: Create draft now makes one/);
		await panel.click("Create draft now");
		assert.deepEqual(calls.find((c) => c.url.endsWith("/buttondown/sync")).body, { collection: "posts", id: "P1", action: "create" });
		assert.match(panel.text(), /Draft in Buttondown\./);
		assert.ok([...panel.main.querySelectorAll("a")].some((a) => a.textContent.includes("Open in Buttondown")));
		await panel.click("Refresh draft from post");
		assert.match(window.document.body.textContent, /Refresh the draft from the post\?/);
		assert.equal(calls.filter((c) => c.url.endsWith("/buttondown/sync")).length, 1, "nothing sent before the confirm");
		await panel.click("Refresh draft");
		const refresh = calls.filter((c) => c.url.endsWith("/buttondown/sync"))[1];
		assert.deepEqual(refresh.body, { collection: "posts", id: "P1", action: "refresh" });
	} finally {
		await panel.unmount();
	}
});

test("the panel says so when no rule covers the collection (if EmDash shows it anyway)", async () => {
	server({ entry: () => ({ covered: false }) });
	const panel = await render(h(ButtondownPanel, { collection: "pages", entry: { id: "X", updatedAt: "u9" } }));
	try {
		assert.match(panel.text(), /No Buttondown rule covers this collection/);
	} finally {
		await panel.unmount();
	}
});

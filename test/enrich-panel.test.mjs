// Run: node --test test/enrich-panel.test.mjs
//
// The real AI Enrich button and its review (src/admin/enrich.tsx, compiled by test/tsx-loader.mjs) in happy-dom,
// with the installed Kumo, a fake editor draft and a scripted route: the status line, where focus goes, the review
// dialog (new links and switched ones, the meta description's box and its hint), Apply, a review that outlived its
// draft, and the messages that go when the panel unmounts or the entry is saved. The run itself is tested in
// src/admin/enrich-core.test.ts.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import "./tsx-loader.mjs";

let window;
let React;
let h;
let act;
let createRoot;
let EnrichButton;
let core;
before(async () => {
	const { Window } = await import("happy-dom");
	window = new Window({ url: "https://example.com/_emdash/admin/content/posts/E1" });
	for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Element", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "sessionStorage", "KeyboardEvent", "Event", "CustomEvent"]) {
		Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
	}
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	React = await import("react");
	h = React.createElement;
	act = React.act;
	({ createRoot } = await import("react-dom/client"));
	({ EnrichButton } = await import("../src/admin/enrich.tsx"));
	core = await import("../src/admin/enrich-core.ts");
});
after(async () => {
	await window?.happyDOM.close();
});

const NOW = 1_800_000_000_000;
let clock = NOW;
const errors = [];
const realError = console.error;
const mounted = [];
afterEach(async () => {
	for (const m of mounted.splice(0)) await m.unmount();
	console.error = realError;
	core.resetRunsForTests();
});

/** A fake editor draft, as EmDash 1.6's behaves: a revision per draft object that moves with every change. */
function fakeDraft(id = "a") {
	const state = { values: { title: "Post", content: [], "seo.description": null }, counter: 0, patches: [] };
	return {
		state,
		edit: (field, value) => {
			state.values[field] = value;
			state.counter++;
		},
		draft: {
			get: () => ({ revision: `rev:${id}:${state.counter}`, readOnly: false, fields: structuredClone(state.values), fieldDefinitions: Object.keys(state.values).map((slug) => ({ slug, type: "string" })) }),
			patch(ops, options) {
				if (options.expectedRevision !== `rev:${id}:${state.counter}`) return { ok: false, code: "EDITOR_DRAFT_STALE", message: "stale" };
				state.patches.push(ops);
				for (const op of ops) state.values[op.field] = op.value;
				state.counter++;
				return { ok: true };
			},
		},
	};
}

/** The route, scripted: each request takes the next answer; `hold` keeps it open until released. */
function route(...answers) {
	const sent = [];
	let release;
	core.enrichIo.send = async (body) => {
		sent.push(body);
		const next = answers.shift();
		if (next === "hold") return new Promise((resolve) => (release = resolve));
		return typeof next === "function" ? next(body) : next;
	};
	core.enrichIo.wait = async () => {};
	core.enrichIo.deadline = () => undefined;
	clock = NOW;
	core.enrichIo.now = () => clock;
	return { sent, release: (answer) => release(answer) };
}

const OPS = [
	{ op: "set", field: "content", value: [{ _type: "block", _key: "b", children: [] }] },
	{ op: "set", field: "seo.description", value: "A summary." },
];
const REVIEW = {
	links: [
		{ name: "Fastmail", slug: "fastmail", url: "https://glossary.io/fastmail/", field: "content", action: "switch" },
		{ name: "Google", slug: "google", url: "https://glossary.io/google/", field: "content", action: "add" },
		// The same term in the same field twice must not collide (React keys).
		{ name: "Google", slug: "google", url: "https://glossary.io/google/", field: "content", action: "add" },
	],
	possessives: 0,
	images: [],
	description: "A summary.",
	leftAlone: 0,
	remaining: 0,
};
const patched = (revision) => ({ toast: { type: "success", message: "Added." }, patch: { type: "editor-draft-patch", operations: OPS }, review: REVIEW, revision });

const settle = () =>
	act(async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});

async function render(draft, props = {}) {
	errors.length = 0;
	console.error = (...args) => void errors.push(args.map(String).join(" "));
	const host = window.document.createElement("div");
	window.document.body.appendChild(host);
	const root = createRoot(host);
	const applied = [];
	const element = (more = {}) => h(EnrichButton, { collection: "posts", entryId: "E1", draft, info: { available: true, links: true, images: false, describe: true, provider: "Anthropic" }, updatedAt: "2026-11-25T00:00:00.000Z", onApplied: () => applied.push(1), ...props, ...more });
	await act(async () => root.render(element()));
	const buttons = () => [...window.document.querySelectorAll("button")];
	const button = (label) => buttons().find((b) => b.textContent.trim() === label);
	const panel = {
		host,
		applied,
		button,
		// The panel's own status line (Kumo's loading button has a spinner with the role too).
		status: () => host.querySelector('div[role="status"][tabindex="-1"]'),
		dialog: () => window.document.querySelector('[role="dialog"]'),
		rerender: (more) => act(async () => root.render(element(more))),
		async click(label) {
			const b = button(label);
			assert.ok(b, `no ${label} button`);
			b.focus();
			await act(async () => b.click());
			await settle();
		},
		async unmount() {
			await act(async () => root.unmount());
			host.remove();
		},
	};
	mounted.push(panel);
	return panel;
}

test("a click: the status line is a status region that says it's working, then the review opens; nothing changes until Apply", async () => {
	const { draft, state } = fakeDraft();
	const io = route("hold");
	const panel = await render(draft);
	assert.match(panel.host.textContent, /Adds glossary\.io links and a meta description if there isn't one\. A link you already have to a term's home page, Wikipedia article or profile is switched to glossary\.io\. Sends this entry's text to Anthropic\./);
	await panel.click("AI Enrich");
	const status = panel.status();
	assert.ok(status, "the status line has role=status, and can take focus");
	assert.equal(status.textContent, core.MESSAGES.working);
	assert.equal(window.document.activeElement, status, "focus waits on the status line while the button is disabled");
	assert.equal(panel.dialog(), null);
	await act(async () => io.release(patched("rev:a:0")));
	await settle();

	const dialog = panel.dialog();
	assert.ok(dialog, "the review");
	assert.match(dialog.textContent, /Review AI Enrich changes/);
	assert.match(dialog.textContent, /Links \(2 added, 1 switched\)/);
	const rows = [...dialog.querySelectorAll("li")].map((li) => li.textContent.replace(" (opens in a new tab)", ""));
	assert.deepEqual(rows, ["Fastmail: your link switched to https://glossary.io/fastmail/", "Google: https://glossary.io/google/", "Google: https://glossary.io/google/"]);
	assert.deepEqual(errors.filter((e) => /same key|unique "key"/.test(e)), [], "no duplicate React keys");
	// The meta description's box and what ticking it means, tied together.
	const group = dialog.querySelector('[role="group"][aria-describedby]');
	assert.ok(group, "the box's group");
	assert.equal(window.document.getElementById(group.getAttribute("aria-describedby")).textContent, "Saved right away, also on a published entry.");
	assert.ok(group.querySelector('[role="checkbox"], input[type="checkbox"]'), "the box is inside it");
	assert.equal(state.patches.length, 0);

	await panel.click("Apply changes");
	assert.deepEqual(state.patches, [OPS]);
	assert.equal(panel.dialog(), null);
	assert.equal(panel.status().textContent, core.MESSAGES.applied);
	assert.equal(panel.applied.length, 1, "the panel reloads its suggestions");
});

test("images only left as they are: the section has no zero count, just the note", async () => {
	const { draft } = fakeDraft();
	route({ ...patched("rev:a:0"), review: { ...REVIEW, images: [], leftAlone: 1 } });
	const panel = await render(draft);
	await panel.click("AI Enrich");
	const dialog = panel.dialog();
	assert.ok(dialog);
	assert.doesNotMatch(dialog.textContent, /Images \(0\)/);
	assert.match(dialog.textContent, /Images1 image is left as it is/);
});

test("Cancel closes the review and applies nothing", async () => {
	const { draft, state } = fakeDraft();
	route(patched("rev:a:0"));
	const panel = await render(draft);
	await panel.click("AI Enrich");
	assert.ok(panel.dialog());
	await panel.click("Cancel");
	assert.equal(panel.dialog(), null);
	assert.equal(state.patches.length, 0);
	assert.equal(panel.status().textContent, "");
	assert.equal(core.runState("posts:E1").phase, "idle");
});

test("the entry changed while it worked: the stale message, and focus goes to Run again (from Run again too)", async () => {
	const fake = fakeDraft();
	route(
		(body) => {
			fake.edit("title", "Typed meanwhile");
			return patched(body.draft.revision);
		},
		(body) => {
			fake.edit("title", "Typed again");
			return patched(body.draft.revision);
		},
	);
	const panel = await render(fake.draft);
	await panel.click("AI Enrich");
	assert.equal(panel.dialog(), null);
	assert.equal(panel.status().textContent, core.MESSAGES.stale);
	assert.ok(panel.button("Run again"));
	assert.equal(window.document.activeElement, panel.button("Run again"));
	// A keyboard user on Run again: the button goes away while it runs, and focus comes back to it, never to the page.
	await panel.click("Run again");
	assert.equal(panel.status().textContent, core.MESSAGES.stale);
	assert.equal(window.document.activeElement, panel.button("Run again"));
});

test("a run that ends in a message: focus goes back to the button; a failure is shown as one", async () => {
	route({ toast: { type: "error", message: "Today's AI call limit is reached." } });
	const panel = await render(fakeDraft().draft);
	await panel.click("AI Enrich");
	assert.equal(panel.status().textContent, "Today's AI call limit is reached.");
	assert.match(panel.status().querySelector("p").className, /text-kumo-danger/);
	assert.equal(window.document.activeElement, panel.button("AI Enrich"));
});

test("focus the person moved elsewhere meanwhile is left where it is", async () => {
	const io = route("hold");
	const panel = await render(fakeDraft().draft);
	const other = window.document.createElement("input");
	window.document.body.appendChild(other);
	await panel.click("AI Enrich");
	other.focus();
	await act(async () => io.release({ toast: { type: "info", message: "Nothing to add." } }));
	await settle();
	assert.equal(window.document.activeElement, other);
	other.remove();
});

test("focus that was nowhere (a mouse click in Safari focuses no button) is never pulled to the panel: that would scroll the sidebar", async () => {
	route({ toast: { type: "info", message: "Nothing to add." } });
	const panel = await render(fakeDraft().draft);
	window.document.activeElement?.blur?.();
	// (Compared as booleans: a failed comparison of DOM nodes takes minutes to print.)
	assert.ok(window.document.activeElement === window.document.body);
	await act(async () => panel.button("AI Enrich").click());
	await settle();
	assert.equal(panel.status().textContent, "Nothing to add.");
	assert.ok(window.document.activeElement === window.document.body, "focus stayed where it was");
});

test("from the status line, focus moves without scrolling the page", async () => {
	route({ toast: { type: "info", message: "Nothing to add." } });
	const panel = await render(fakeDraft().draft);
	const button = panel.button("AI Enrich");
	const focused = [];
	const focus = button.focus.bind(button);
	button.focus = (options) => {
		focused.push(options);
		focus(options);
	};
	await panel.click("AI Enrich");
	assert.ok(window.document.activeElement === button);
	assert.deepEqual(focused.at(-1), { preventScroll: true });
});

test("a review that outlived its draft (the entry was left and opened again, or edited while the settings were hidden) never opens: stale, with Run again", async () => {
	const first = fakeDraft("a");
	route(patched("rev:a:0"));
	const panel = await render(first.draft);
	await panel.click("AI Enrich");
	assert.ok(panel.dialog());
	// Hide settings: the panel unmounts, the review stays in the store.
	await panel.unmount();
	assert.equal(core.runState("posts:E1").phase, "review");
	// The same draft, unchanged: the review shows again.
	const again = await render(first.draft);
	assert.ok(again.dialog(), "the review is back");
	await again.unmount();
	// Edited while hidden.
	first.edit("title", "Typed while hidden");
	const edited = await render(first.draft);
	assert.equal(edited.dialog(), null);
	assert.equal(edited.status().textContent, core.MESSAGES.stale);
	assert.ok(edited.button("Run again"));
	await edited.unmount();

	// Another draft object for the same entry (browser Back, then the entry opened again).
	core.resetRunsForTests();
	route(patched("rev:a:0"));
	const before = await render(fakeDraft("a").draft);
	await before.click("AI Enrich");
	await before.unmount();
	const reopened = await render(fakeDraft("b").draft);
	assert.equal(reopened.dialog(), null);
	assert.equal(reopened.status().textContent, core.MESSAGES.stale);
});

test("an ended run's message goes when the panel unmounts, and at a save once it's 10 seconds old (the autosave right after Apply leaves it)", async () => {
	const { draft } = fakeDraft();
	route(patched("rev:a:0"));
	const panel = await render(draft);
	await panel.click("AI Enrich");
	await panel.click("Apply changes");
	assert.equal(panel.status().textContent, core.MESSAGES.applied);
	// The editor's autosave, two seconds later.
	clock = NOW + 2_000;
	await panel.rerender({ updatedAt: "2026-11-25T00:00:02.000Z" });
	assert.equal(panel.status().textContent, core.MESSAGES.applied);
	// The publish, a minute later.
	clock = NOW + 60_000;
	await panel.rerender({ updatedAt: "2026-11-25T00:01:00.000Z" });
	assert.equal(panel.status().textContent, "");

	route({ toast: { type: "info", message: "Nothing to add." } });
	await panel.click("AI Enrich");
	assert.equal(panel.status().textContent, "Nothing to add.");
	await panel.unmount();
	assert.equal(core.runState("posts:E1").phase, "idle", "not shown again all session");
});

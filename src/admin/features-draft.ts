/**
 * The Features page's switches as a draft (src/admin/features.tsx). A click
 * changes the draft only. Save sends the switches that changed in one request
 * (features/save stores them in one write) and Discard puts the draft back.
 * After a save, the admin manifest (the sidebar and dashboard widgets) is
 * refreshed once, and only when a module's main switch changed.
 *
 * The draft holds each feature's own switch (`choice` from features/list): a
 * part keeps its own while its module is off, so turning the module on in the
 * draft shows the parts as they'll be once saved.
 *
 * A save that fails may still have been stored: features/save stores the
 * switches before it schedules their tasks, and answers 500 when a task can't
 * be scheduled ("The switches are saved, but …"); a lost answer can hide a
 * write too. So after any failed save the page reads the switches back
 * (features/list, which also retries the scheduling) and keeps only the
 * user's changes on top of them.
 *
 * Kept free of JSX so tests can load it directly.
 */
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { errorText } from "./api.js";
import { isDirty } from "./dirty.js";

export const FEATURES_API = "/_emdash/api/plugins/coywolf-pack/features";

export interface Feature {
	id: string;
	label: string;
	description: string;
	/** Whether it runs now (a part is off while its module is). */
	enabled: boolean;
	/** Its own switch (src/core/features.ts featureChoices). */
	choice?: boolean;
}

export interface ModuleState {
	id: string;
	label: string;
	features: Feature[];
}

/** Feature id → on. */
export type Switches = Record<string, boolean>;

/** Each feature's own switch, as features/list gives it. */
export function switchesOf(modules: ModuleState[]): Switches {
	return Object.fromEntries(modules.flatMap((m) => m.features.map((f) => [f.id, f.choice ?? f.enabled])));
}

/** The switches in `draft` that differ from `saved`: what Save sends. */
export function changedSwitches(draft: Switches, saved: Switches): Switches {
	return Object.fromEntries(Object.entries(draft).filter(([id, on]) => saved[id] !== on));
}

/** A module's main switch (no "." in its id): it adds or removes the module's pages in the sidebar. */
export const isModuleSwitch = (id: string) => !id.includes(".");

export interface FeatureDraftEffects {
	/** Refresh the admin manifest in place. False when it can't: the page is then reloaded (reloadKeepingScroll). */
	refreshManifest(): boolean;
	/** After a save that changed the update check (`updates`). */
	resetUpdates(): void;
	saved(): void;
	failed(message: string): void;
	clear(): void;
	/** Tests: instead of location.reload(). */
	reload?: () => void;
}

/** What to tell the user once the page is back after a reload: the save's result. */
export type AfterReload = { saved: true } | { failed: string };

const SCROLL_KEY = "coywolf-pack:features-scroll";
/** A reload that comes later than this isn't the one that stored the position (another tab, a later visit). */
export const SCROLL_MAX_AGE_MS = 30_000;

/** The element that scrolls the page: EmDash's <main> (overflow-y: auto), else the document. */
export function scrollerOf(node: Element | null): Element | null {
	let el = node?.parentElement ?? null;
	while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
	return el ?? document.scrollingElement;
}

/** Reload the page and come back to the same scroll position, with the save's result (restoreScroll, once the page has loaded). */
export function reloadKeepingScroll(node: Element | null, after: AfterReload | null, reload: () => void = () => window.location.reload()): void {
	try {
		sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: window.location.pathname, top: scrollerOf(node)?.scrollTop ?? 0, at: Date.now(), ...after }));
	} catch {
		// Private mode or blocked storage: the page reloads at the top.
	}
	reload();
}

/** After reloadKeepingScroll: scroll back to where the page was, once. Returns the save's result to tell (null when there's none). */
export function restoreScroll(node: Element | null, now = Date.now()): AfterReload | null {
	type Entry = { path?: unknown; top?: unknown; at?: unknown; saved?: unknown; failed?: unknown } | null;
	let entry: Entry;
	try {
		const raw = sessionStorage.getItem(SCROLL_KEY);
		if (!raw) return null;
		sessionStorage.removeItem(SCROLL_KEY);
		entry = JSON.parse(raw) as Entry;
	} catch {
		return null;
	}
	if (!entry || entry.path !== window.location.pathname || typeof entry.top !== "number") return null;
	if (typeof entry.at !== "number" || now - entry.at > SCROLL_MAX_AGE_MS || now < entry.at) return null;
	const scroller = scrollerOf(node);
	if (scroller) scroller.scrollTop = entry.top;
	if (typeof entry.failed === "string") return { failed: entry.failed };
	return entry.saved === true ? { saved: true } : null;
}

async function fetchModules(): Promise<ModuleState[]> {
	const response = await apiFetch(`${FEATURES_API}/list`);
	return (await parseApiResponse<{ modules: ModuleState[] }>(response, "Couldn't load features")).modules;
}

/**
 * The page's modules, the saved switches and the draft. `root` is the page's
 * root element (for the scroll position, should the page have to reload).
 */
export function useFeatureDraft(effects: FeatureDraftEffects, root: React.RefObject<Element | null>) {
	const latest = React.useRef(effects);
	latest.current = effects;
	const [modules, setModules] = React.useState<ModuleState[] | null>(null);
	const [saved, setSaved] = React.useState<Switches | null>(null);
	const [draft, setDraft] = React.useState<Switches | null>(null);
	const [loadError, setLoadError] = React.useState<string | null>(null);
	const [saving, setSaving] = React.useState(false);
	// A save in flight, read synchronously: two calls in one tick (a double press) must not both send.
	const inFlight = React.useRef(false);
	const [reloadAfterSave, setReloadAfterSave] = React.useState(false);
	const afterReload = React.useRef<AfterReload | null>(null);

	React.useEffect(() => {
		let live = true;
		(async () => {
			try {
				const list = await fetchModules();
				if (!live) return;
				const switches = switchesOf(list);
				setModules(list);
				setSaved(switches);
				setDraft(switches);
			} catch (cause) {
				if (live) setLoadError(errorText(cause, "Couldn't load features"));
			}
		})();
		return () => {
			live = false;
		};
	}, []);

	const dirty = isDirty(draft, saved);

	// Back after a reload (reloadKeepingScroll): where the page was, once its switches are there, and the save's result.
	React.useLayoutEffect(() => {
		if (!modules) return;
		const after = restoreScroll(root.current);
		if (after && "failed" in after) latest.current.failed(after.failed);
		else if (after) latest.current.saved();
	}, [modules, root]);

	// Only once the saved switches are on screen (the Save bar's leave guard is gone by then), never with unsaved changes.
	React.useEffect(() => {
		if (!reloadAfterSave || dirty) return;
		setReloadAfterSave(false);
		const after = afterReload.current;
		afterReload.current = null;
		reloadKeepingScroll(root.current, after, latest.current.reload);
	}, [reloadAfterSave, dirty, root]);

	/**
	 * The saved switches went from `before` to `next`: reset the update notices and refresh the sidebar, as needed.
	 * True when the page reloads for it right away (`clean`), with `after` to tell once it's back.
	 */
	const settle = (before: Switches, next: Switches, clean: boolean, after: AfterReload): boolean => {
		if (next.updates !== before.updates) latest.current.resetUpdates();
		const moduleChanged = Object.keys(next).some((id) => isModuleSwitch(id) && next[id] !== before[id]);
		if (!moduleChanged || latest.current.refreshManifest()) return false;
		// No way to refresh it in place: reload, once nothing is left unsaved.
		setReloadAfterSave(true);
		afterReload.current = clean ? after : null;
		return clean;
	};

	const set = (id: string, on: boolean) => {
		if (inFlight.current) return;
		setDraft((d) => (d ? { ...d, [id]: on } : d));
	};

	const discard = () => {
		latest.current.clear();
		setDraft(saved);
	};

	const save = async () => {
		if (!draft || !saved || inFlight.current) return;
		const changes = changedSwitches(draft, saved);
		if (!Object.keys(changes).length) return;
		inFlight.current = true;
		setSaving(true);
		latest.current.clear();
		try {
			const response = await apiFetch(`${FEATURES_API}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ features: changes }),
			});
			const out = await parseApiResponse<{ features: Switches; choices?: Switches }>(response, "Couldn't save");
			// The switches as stored now, which may include another admin's changes (the draft can't change while saving).
			const next: Switches = {};
			for (const id of Object.keys(saved)) next[id] = out.choices?.[id] ?? draft[id] ?? saved[id];
			setSaved(next);
			setDraft(next);
			if (!settle(saved, next, true, { saved: true })) latest.current.saved();
		} catch (cause) {
			const message = errorText(cause, "Couldn't save");
			// Stored anyway? Read the switches back and keep only the user's changes on top (clean when they were stored).
			let fresh: ModuleState[] | null = null;
			try {
				fresh = await fetchModules();
			} catch {
				// Can't tell: the draft stays as it was.
			}
			if (fresh) {
				const now = switchesOf(fresh);
				const rebased: Switches = { ...now };
				for (const [id, on] of Object.entries(changes)) if (id in now) rebased[id] = on;
				setModules(fresh);
				setSaved(now);
				setDraft(rebased);
				if (settle(saved, now, !isDirty(rebased, now), { failed: message })) return;
			}
			latest.current.failed(message);
		} finally {
			inFlight.current = false;
			setSaving(false);
		}
	};

	return { modules, draft, dirty, saving, loadError, set, save, discard };
}

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

const SCROLL_KEY = "coywolf-pack:features-scroll";

/** The element that scrolls the page: EmDash's <main> (overflow-y: auto), else the document. */
export function scrollerOf(node: Element | null): Element | null {
	let el = node?.parentElement ?? null;
	while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
	return el ?? document.scrollingElement;
}

/** Reload the page and come back to the same scroll position (restoreScroll, once the page has loaded). */
export function reloadKeepingScroll(node: Element | null, reload: () => void = () => window.location.reload()): void {
	try {
		sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: window.location.pathname, top: scrollerOf(node)?.scrollTop ?? 0 }));
	} catch {
		// Private mode or blocked storage: the page reloads at the top.
	}
	reload();
}

/** After reloadKeepingScroll: scroll back to where the page was, once. */
export function restoreScroll(node: Element | null): void {
	let saved: { path?: unknown; top?: unknown } | null = null;
	try {
		const raw = sessionStorage.getItem(SCROLL_KEY);
		if (!raw) return;
		sessionStorage.removeItem(SCROLL_KEY);
		saved = JSON.parse(raw) as { path?: unknown; top?: unknown };
	} catch {
		return;
	}
	if (saved?.path !== window.location.pathname || typeof saved.top !== "number") return;
	const scroller = scrollerOf(node);
	if (scroller) scroller.scrollTop = saved.top;
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
	const [reloadAfterSave, setReloadAfterSave] = React.useState(false);

	React.useEffect(() => {
		let live = true;
		(async () => {
			try {
				const response = await apiFetch(`${FEATURES_API}/list`);
				const list = (await parseApiResponse<{ modules: ModuleState[] }>(response, "Couldn't load features")).modules;
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

	// Back after a reload (reloadKeepingScroll): where the page was, once its switches are there.
	React.useLayoutEffect(() => {
		if (modules) restoreScroll(root.current);
	}, [modules, root]);

	// Only once the saved switches are on screen (the Save bar's leave guard is gone by then), never with unsaved changes.
	React.useEffect(() => {
		if (!reloadAfterSave || dirty) return;
		setReloadAfterSave(false);
		reloadKeepingScroll(root.current, latest.current.reload);
	}, [reloadAfterSave, dirty, root]);

	const set = (id: string, on: boolean) => {
		if (saving) return;
		setDraft((d) => (d ? { ...d, [id]: on } : d));
	};

	const discard = () => {
		latest.current.clear();
		setDraft(saved);
	};

	const save = async () => {
		if (!draft || !saved || saving) return;
		const changes = changedSwitches(draft, saved);
		const ids = Object.keys(changes);
		if (!ids.length) return;
		setSaving(true);
		latest.current.clear();
		try {
			const response = await apiFetch(`${FEATURES_API}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ features: changes }),
			});
			const out = await parseApiResponse<{ features: Switches; choices?: Switches }>(response, "Couldn't save");
			// The switches as stored now (the switches can't change while saving, so the draft is what was sent).
			const next: Switches = {};
			for (const id of Object.keys(saved)) next[id] = out.choices?.[id] ?? draft[id] ?? saved[id];
			setSaved(next);
			setDraft(next);
			latest.current.saved();
			if (ids.includes("updates")) latest.current.resetUpdates();
			if (ids.some(isModuleSwitch) && !latest.current.refreshManifest()) setReloadAfterSave(true);
		} catch (cause) {
			latest.current.failed(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	};

	return { modules, draft, dirty, saving, loadError, set, save, discard };
}

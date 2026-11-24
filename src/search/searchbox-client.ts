/**
 * The SearchBox's browser script (src/astro/search/SearchBoxForm.astro calls
 * enhanceSearchBoxes): live suggestions as the visitor types, arrow keys,
 * Enter and Escape, the clear button and screen-reader announcements.
 *
 * Instant while the live results client (live-client.ts) is on the page: it
 * lends the SearchBox its title index and matcher (window.__cwLive), so the
 * box fetches the index for its collections when the pointer reaches the
 * field or it gets focus, and from then on every keystroke shows matching
 * titles in the same frame. The live results route's answer (full text,
 * excerpts, and results for some of the words when nothing matches them
 * all) follows after `debounce` and merges in without reshuffling. Without
 * the client (an old cached page, or Instant titles off) it asks the server
 * only, as before. Answers are cached per query, so backspacing is instant
 * too, and an answer for a query the visitor has typed past is dropped.
 *
 * No imports beyond pure modules, so it bundles small and runs under
 * happy-dom in the tests. Nodes are added with appendChild, not append: the
 * pack type-checks against workers-types, whose Element is HTMLRewriter's.
 */
import { normalizeLiveQuery } from "./live-cache.js";
import { createSeenSignal } from "./seen-signal.js";

const MARK = /<(?!\/?mark>)/g;
/** Local (instant) matches are announced only if the server's answer takes longer than this. */
const ANNOUNCE_DELAY_MS = 700;

export interface SearchItem {
	title?: string;
	/** The title as escaped HTML with the matches in <mark> (the server's and the title matcher's highlighting). */
	titleHtml?: string;
	snippet?: string;
	url: string;
	type: string;
	/** A title match from the index (no excerpt yet). */
	local?: boolean;
}

interface Answer {
	items: SearchItem[];
	fallback: boolean;
}

/** What the live results client lends the SearchBox (live-client.ts sets window.__cwLive). */
export interface LiveTools {
	/** The prepared title index for these collections and locale, or null when the site has no index. */
	titles(collections: string | undefined, locale: string | undefined): Promise<unknown[]> | null;
	/** Wake a server isolate (once per page). */
	warm(): void;
	localItems(prepared: unknown[], query: string, limit: number): SearchItem[];
	merge(local: SearchItem[], server: SearchItem[], limit: number): SearchItem[];
}

/** The live results client's tools, or null when it isn't on the page (or is an older copy without them). */
export function liveTools(): LiveTools | null {
	const tools = (globalThis as { __cwLive?: unknown }).__cwLive as Partial<LiveTools> | undefined;
	return tools && typeof tools === "object" && typeof tools.titles === "function" && typeof tools.localItems === "function" && typeof tools.merge === "function" && typeof tools.warm === "function" ? (tools as LiveTools) : null;
}

function terms(query: string): string[] {
	return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

/** The title as text nodes, with the visitor's words (as word prefixes) wrapped in <mark>. */
function highlight(target: HTMLElement, text: string, words: string[]) {
	if (!words.length) {
		target.textContent = text;
		return;
	}
	const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})`, "giu");
	let last = 0;
	for (const m of text.matchAll(pattern)) {
		const start = (m.index ?? 0) + m[1].length;
		target.appendChild(document.createTextNode(text.slice(last, start)));
		const mark = document.createElement("mark");
		mark.textContent = m[2];
		target.appendChild(mark);
		last = start + m[2].length;
	}
	target.appendChild(document.createTextNode(text.slice(last)));
}

export function enhanceSearchBox(form: HTMLFormElement): void {
	const found = {
		input: form.querySelector<HTMLInputElement>(".cw-search__input"),
		list: form.querySelector<HTMLUListElement>(".cw-search__list"),
		status: form.querySelector<HTMLElement>("[role=status]"),
		clear: form.querySelector<HTMLButtonElement>(".cw-search__clear"),
	};
	if (!found.input || !found.list || !found.status || !found.clear) return;
	const input: HTMLInputElement = found.input;
	const list: HTMLUListElement = found.list;
	const status: HTMLElement = found.status;
	const clear: HTMLButtonElement = found.clear;

	const d = form.dataset;
	const minChars = Number(d.minChars) || 2;
	const wait = d.debounce !== undefined && d.debounce !== "" && Number.isFinite(Number(d.debounce)) ? Math.max(0, Number(d.debounce)) : 120;
	const limit = Math.min(20, Math.max(1, Number(d.limit) || 8));
	// Server answers, by normalized query (the server lower-cases and collapses spaces too).
	const cache = new Map<string, Answer>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let announceTimer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let options: HTMLElement[] = [];
	let active = -1;
	// The query typed last (trimmed): a keystroke that doesn't change it (a space) does nothing.
	let lastQuery = "";
	// The query the list shows results for, and the row the visitor picked (kept when the list fills in again).
	let shownFor = "";
	let pickedUrl = "";
	// The title index and its matcher, from the live results client (null until loaded, or without it).
	let tools: LiveTools | null = null;
	let prepared: unknown[] | null = null;
	let indexAsked = false;
	let warmed = false;
	// Escape closed the list: answers still on their way are cached, not shown, until the next keystroke.
	let dismissed = false;
	// Search insights: a suggestion search counts once the visitor stops typing (or opens one); off without data-seen.
	const seen = createSeenSignal({ endpoint: d.seen, current: () => input.value.trim() });

	// Without live results ("search.live" off) only the clear button is wired up.
	const live = d.live === "1";
	if (live) {
		input.setAttribute("role", "combobox");
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-controls", list.id);
		input.setAttribute("aria-expanded", "false");
	}

	const isOpen = () => !list.hidden;
	// The same entry whether its URL came from the index or the server (as the merge compares them).
	const urlKey = (url: string | undefined) => (url ?? "").replace(/[?#].*$/, "").replace(/\/+$/, "");
	const keyOf = (query: string) => normalizeLiveQuery(query);
	const current = (query: string) => keyOf(input.value.trim()) === keyOf(query);

	function close() {
		clearTimeout(announceTimer);
		list.hidden = true;
		list.classList.remove("is-open");
		if (live) input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
		active = -1;
	}

	function open() {
		list.hidden = false;
		input.setAttribute("aria-expanded", "true");
		requestAnimationFrame(() => list.classList.add("is-open"));
	}

	function setActive(index: number, picked = false) {
		options.forEach((o, i) => o.setAttribute("aria-selected", i === index ? "true" : "false"));
		active = index;
		const option = options[index];
		if (picked) pickedUrl = option?.dataset.url ?? "";
		if (option) {
			input.setAttribute("aria-activedescendant", option.id);
			option.scrollIntoView({ block: "nearest" });
		} else {
			input.removeAttribute("aria-activedescendant");
		}
	}

	function announce(message: string, later: boolean) {
		clearTimeout(announceTimer);
		if (!later) {
			status.textContent = message;
			return;
		}
		announceTimer = setTimeout(() => {
			status.textContent = message;
		}, ANNOUNCE_DELAY_MS);
	}

	/** Show these results; `partial` (instant title matches) are announced only if the server is slow. */
	function render(query: string, items: SearchItem[], fallback: boolean, partial: boolean) {
		list.replaceChildren();
		options = [];
		active = -1;
		// The old rows are gone, ids are reused: nothing is active until a row is picked again below.
		input.removeAttribute("aria-activedescendant");
		shownFor = keyOf(query);
		const words = terms(query);
		if (fallback && items.length) {
			const note = document.createElement("li");
			note.className = "cw-search__note";
			note.setAttribute("aria-hidden", "true");
			note.textContent = "No results for all of your words. Showing results for some of them.";
			list.appendChild(note);
		}
		items.forEach((item, i) => {
			// The option is a real link (so middle-click and "open in new tab" work), in a
			// presentational list item: a listbox may only contain options.
			const row = document.createElement("li");
			row.setAttribute("role", "none");
			const link = document.createElement("a");
			link.id = `${list.id}-${i}`;
			link.className = "cw-search__option cw-search__link";
			link.setAttribute("role", "option");
			link.setAttribute("aria-selected", "false");
			link.dataset.url = item.url;
			link.href = item.url;
			link.tabIndex = -1;
			const title = document.createElement("span");
			title.className = "cw-search__title";
			const text = document.createElement("span");
			// The server and the title matcher escape titles and add only <mark>; escape anything else again to be safe.
			if (item.titleHtml) text.innerHTML = item.titleHtml.replace(MARK, "&lt;");
			else highlight(text, item.title || item.url, words);
			title.appendChild(text);
			if (d.showType && item.type) {
				const type = document.createElement("span");
				type.className = "cw-search__type";
				type.textContent = item.type;
				title.appendChild(type);
			}
			link.appendChild(title);
			if (d.showSnippets && item.snippet) {
				const snippet = document.createElement("span");
				snippet.className = "cw-search__snippet";
				// EmDash escapes snippets and adds only <mark>; escape anything else again to be safe.
				snippet.innerHTML = item.snippet.replace(MARK, "&lt;");
				link.appendChild(snippet);
			}
			row.appendChild(link);
			// Keep focus in the field while clicking; the link still navigates.
			link.addEventListener("mousedown", (e) => e.preventDefault());
			list.appendChild(row);
			options.push(link);
		});
		if (!items.length) {
			const empty = document.createElement("li");
			empty.className = "cw-search__empty";
			empty.setAttribute("aria-hidden", "true");
			empty.textContent = "No matching results.";
			list.appendChild(empty);
		}
		announce(
			items.length
				? `${items.length} ${items.length === 1 ? "suggestion" : "suggestions"}${fallback ? " matching some of your words" : ""}. Use the up and down arrows to review.`
				: `No results for ${query}.`,
			partial,
		);
		open();
		// A row the visitor picked stays picked when the server's answer fills the list in (if it's still there).
		if (pickedUrl) {
			const again = options.findIndex((o) => urlKey(o.dataset.url) === urlKey(pickedUrl));
			if (again >= 0) setActive(again);
			else pickedUrl = "";
		}
	}

	/** Title matches from the index, at once (false when there's no index yet or nothing matches). */
	function showLocal(query: string): boolean {
		if (!tools || !prepared) return false;
		const local = tools.localItems(prepared, query, limit);
		if (!local.length) return false;
		render(query, local, false, true);
		// Search insights: opening one of these before the server answers counts too.
		seen.settle(query, local.length);
		return true;
	}

	/** The server's answer, merged into the title matches already showing. */
	function showServer(query: string, data: Answer) {
		const local = tools && prepared ? tools.localItems(prepared, query, limit) : [];
		const items = local.length && tools ? tools.merge(local, data.items, limit) : data.items;
		render(query, items, data.fallback && !local.length, false);
		// What the visitor saw: title matches the server didn't find still count as results.
		seen.settle(query, items.length);
	}

	/** Wake the server and load the title index (once each) when the visitor heads for the field. */
	function prime() {
		if (!live || indexAsked) return;
		tools ??= liveTools();
		if (!tools) {
			// No live results client yet (it runs after this script, at the end of the page, so a visitor can get
			// here first), or an older one without the tools: wake an isolate now, look again on the next focus,
			// pointer or keystroke.
			if (!warmed) {
				warmed = true;
				fetch(`${d.endpoint}?warm=1`, { credentials: "same-origin", priority: "low" } as RequestInit).catch(() => undefined);
			}
			return;
		}
		indexAsked = true;
		if (!warmed) {
			warmed = true;
			tools.warm();
		}
		tools.titles(d.collections || undefined, d.locale || undefined)?.then((list) => {
			prepared = list.length ? list : null;
			// The index arrived while the visitor was typing: show its matches unless the server already answered.
			const query = input.value.trim();
			if (prepared && !dismissed && document.activeElement === input && query.length >= minChars && query === lastQuery && !cache.has(keyOf(query))) showLocal(query);
		});
	}

	async function suggest(query: string) {
		const key = keyOf(query);
		const cached = cache.get(key);
		if (cached) return showServer(query, cached);
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		const params = new URLSearchParams({ q: key, limit: String(limit) });
		if (d.collections) params.set("collections", d.collections);
		if (d.locale) params.set("locale", d.locale);
		try {
			const response = await fetch(`${d.endpoint}?${params}`, { signal: mine.signal, credentials: "same-origin", headers: { Accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { data?: Answer } & Answer;
			const data = body.data ?? body;
			if (!Array.isArray(data?.items)) throw new Error("Unexpected answer");
			cache.set(key, data);
			// An answer for a query the visitor has typed past is kept for backspacing, not shown; nor is
			// one that arrives after they closed the list with Escape or left the box.
			if (current(query) && !dismissed && form.contains(document.activeElement)) showServer(query, data);
		} catch (error) {
			if ((error as Error).name === "AbortError" || !current(query)) return;
			// Title matches for this query stay; an older query's results don't.
			if (shownFor !== key) close();
		}
	}

	/** Empty the field and start over (the clear button, and Escape with the list closed). */
	function reset() {
		input.value = "";
		clear.hidden = true;
		clearTimeout(timer);
		clearTimeout(announceTimer);
		controller?.abort();
		seen.cancel();
		lastQuery = "";
		shownFor = "";
		pickedUrl = "";
		dismissed = false;
		status.textContent = "";
		close();
	}

	input.addEventListener("input", () => {
		const query = input.value.trim();
		clear.hidden = input.value === "";
		if (!live) return;
		// A keystroke that leaves the query as it was (a space) changes nothing: the request waiting on the
		// debounce and the settled-search timer keep going.
		if (query.length >= minChars && query === lastQuery && isOpen()) return;
		clearTimeout(timer);
		seen.cancel();
		dismissed = false;
		prime();
		if (query.length < minChars) {
			controller?.abort();
			clearTimeout(announceTimer);
			lastQuery = "";
			shownFor = "";
			status.textContent = "";
			return close();
		}
		lastQuery = query;
		pickedUrl = "";
		// A row picked for the last query isn't one for this one (its rows may stay until the answer comes).
		if (active >= 0) setActive(-1);
		const cached = cache.get(keyOf(query));
		if (cached) return showServer(query, cached);
		showLocal(query);
		timer = setTimeout(() => void suggest(query), wait);
	});

	// Keys work whenever the list is open (the listener is on the form, not just the field).
	form.addEventListener("keydown", (e) => {
		// Keys pressed while an input method (Chinese, Japanese, Korean) is composing belong to
		// it: Enter confirms a candidate, Escape cancels it. keyCode 229 covers Safari before 27,
		// which ends the composition before the confirming keydown.
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === "Escape") {
			if (isOpen()) {
				close();
				clearTimeout(timer);
				dismissed = true;
			} else if (input.value) {
				reset();
			} else {
				return;
			}
			e.preventDefault();
			input.focus();
			return;
		}
		if (!isOpen() || !options.length) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			setActive(active < 0 ? (step > 0 ? 0 : options.length - 1) : (active + step + options.length) % options.length, true);
		} else if (e.key === "Enter" && active >= 0) {
			e.preventDefault();
			const url = options[active]?.dataset.url;
			if (url) {
				seen.flush();
				window.location.assign(url);
			}
		} else if (e.key === "Tab") {
			close();
		}
	});

	form.addEventListener("focusout", (e) => {
		if (!form.contains(e.relatedTarget as Node | null)) close();
	});

	input.addEventListener("focus", () => {
		prime();
		const query = input.value.trim();
		if (!live || !options.length || query.length < minChars) return;
		// Back in the box: show results for what's typed now, never an older query's rows.
		const cached = cache.get(keyOf(query));
		if (cached) return showServer(query, cached);
		if (shownFor === keyOf(query)) return open();
		showLocal(query);
	});
	// The pointer reaching the field (or a touch on it) is a head start on the index and the warm-up.
	form.querySelector(".cw-search__field")?.addEventListener("pointerenter", prime);

	// A suggestion opened with the pointer counts at once; a submitted form is counted by the search page.
	list.addEventListener("click", (e) => {
		if ((e.target as Element | null)?.closest?.("a")) seen.flush();
	});
	form.addEventListener("submit", () => seen.cancel());

	clear.hidden = input.value === "";
	clear.addEventListener("click", () => {
		reset();
		input.focus();
	});
	// Attached after the field already has focus (a script that loaded late).
	if (document.activeElement === input) prime();
}

/** Every SearchBox on the page. */
export function enhanceSearchBoxes(root: ParentNode = document): void {
	for (const form of root.querySelectorAll<HTMLFormElement>("form[data-cw-search]")) enhanceSearchBox(form);
}

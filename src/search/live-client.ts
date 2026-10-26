/**
 * Live results client (feature "search.live"): the script and styles that
 * turn any search form on the page into one that shows matching entries in
 * a dropdown as the visitor types. A port of the Coywolf Search WordPress
 * plugin's typeahead: on first focus of a search field it loads a compact
 * title index (search/index, cached by the browser per content version) and
 * sends a tiny warm-up request, then shows title matches the moment the
 * visitor types (title-match.ts), while the search/live route's answer
 * (titles first, then full text, with excerpts) merges in without reshuffling.
 *
 * Added by the search module's page:fragments hook as a deferred script with
 * a versioned URL (LIVE_ASSET, served by the pack middleware or the
 * search/live-client route and cached by browsers for a year), so it needs no
 * build step and isn't resent with every page. Written as plain ES2020 inside String.raw
 * (no backticks or "${" inside). It attaches to GET forms with a search
 * field (type="search", or a field named "s" or "q"), skipping the pack's
 * own SearchBox, which has its suggestions built in. Progressive
 * enhancement: without it, or before it runs, the form submits as before.
 */

import { MATCH_SOURCE } from "./title-match.js";

export interface LiveClientConfig {
	endpoint: string;
	/** The title index route, or null for server results only. */
	indexEndpoint: string | null;
	/** The search content version (cache-busts the index and live URLs after publishing). */
	version: string;
	limit: number;
	minChars: number;
	debounce: number;
	locale: string | null;
	/** Preselect the first result so Enter opens it (as in Coywolf Search). */
	enterOpensTop: boolean;
}

/**
 * Inherits the theme: font and text color come from the form, the panel's
 * background from the nearest opaque ancestor (set as --cw-live-bg by the
 * script), and every tint is currentColor mixed down, so it reads right on
 * light and dark themes alike.
 */
export const LIVE_CSS = String.raw`.cw-live-list {
	position: absolute;
	box-sizing: border-box;
	z-index: 1000;
	max-height: min(60vh, 26em);
	overflow-y: auto;
	overscroll-behavior: contain;
	margin: 0;
	padding: 0;
	background: var(--cw-live-bg, Canvas);
	color: var(--cw-live-fg, CanvasText);
	border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
	border-radius: 6px;
	box-shadow: 0 6px 24px rgb(0 0 0 / 0.14);
	text-align: start;
	line-height: 1.35;
}
.cw-live-list[hidden],
.cw-live-clear[hidden] {
	display: none;
}
.cw-live-option {
	display: block;
	padding: 0.6em 0.85em;
	color: inherit;
	text-decoration: none;
	cursor: pointer;
	border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
.cw-live-option:last-child {
	border-bottom: 0;
}
.cw-live-option.is-active {
	background: color-mix(in srgb, currentColor 7%, var(--cw-live-bg, Canvas));
	box-shadow: inset 3px 0 0 0 currentColor;
}
.cw-live-title {
	display: block;
	font-weight: 700;
	overflow-wrap: anywhere;
}
.cw-live-snippet {
	display: block;
	font-weight: 400;
	margin-top: 0.2em;
	font-size: 0.85em;
	opacity: 0.8;
	overflow-wrap: anywhere;
}
.cw-live-list mark {
	background: transparent;
	color: inherit;
	font-weight: 700;
	padding: 0;
}
.cw-live-title mark {
	text-decoration: underline;
	text-decoration-thickness: 2px;
	text-underline-offset: 0.15em;
}
.cw-live-all {
	font-size: 0.9em;
	font-weight: 600;
}
.cw-live-empty {
	padding: 0.75em 0.85em;
	font-size: 0.9em;
	opacity: 0.7;
	cursor: default;
}
.cw-live-clear {
	position: absolute;
	z-index: 999;
	display: flex;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	padding: 0;
	border: 0;
	border-radius: 50%;
	background: color-mix(in srgb, currentColor 18%, transparent);
	color: var(--cw-live-fg, CanvasText);
	cursor: pointer;
}
.cw-live-clear:hover,
.cw-live-clear:focus-visible {
	background: color-mix(in srgb, currentColor 32%, transparent);
}
input[data-cw-live]::-webkit-search-cancel-button,
input[data-cw-live]::-webkit-search-decoration {
	-webkit-appearance: none;
	appearance: none;
}
.cw-live-status {
	position: absolute;
	width: 1px;
	height: 1px;
	margin: -1px;
	padding: 0;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
	border: 0;
}
@media (forced-colors: active) {
	.cw-live-list {
		background: Canvas;
		color: CanvasText;
	}
	.cw-live-option.is-active {
		background: Highlight;
		color: HighlightText;
		forced-color-adjust: none;
	}
}
@media (prefers-reduced-motion: no-preference) {
	.cw-live-option {
		transition: background-color 90ms ease;
	}
	.cw-live-list.is-open {
		animation: cw-live-in 140ms ease;
	}
	.cw-live-list.is-closing {
		animation: cw-live-out 140ms ease forwards;
	}
}
@keyframes cw-live-in {
	from { opacity: 0; transform: translateY(-2px); }
	to { opacity: 1; transform: none; }
}
@keyframes cw-live-out {
	from { opacity: 1; transform: none; }
	to { opacity: 0; transform: translateY(-2px); }
}`;

const SCRIPT = String.raw`function (config, css, tools) {
	"use strict";
	if (window.__cwLive || !window.fetch || !window.AbortController) return;
	window.__cwLive = 1;

	// Narrow fields (a header search, a sidebar widget) still need a readable dropdown.
	var MIN_WIDTH = 300;
	var EDGE_GAP = 8;
	// Kept in step with the fade in the CSS; instant for reduced motion.
	var FADE_MS = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140;
	var MARK = /<(?!\/?mark>)/g;
	var counter = 0;
	var styled = false;
	// Shared by every field on the page: one title index, one warm-up.
	var titles = { promise: null, prepared: null, listeners: [] };
	var warmed = false;

	function loadTitles() {
		if (!config.indexEndpoint || titles.promise) return;
		var params = new URLSearchParams({ v: config.version });
		if (config.locale) params.set("locale", config.locale);
		titles.promise = fetch(config.indexEndpoint + "?" + params, { credentials: "same-origin", headers: { Accept: "application/json" } })
			.then(function (r) {
				return r.ok ? r.json() : null;
			})
			.then(function (body) {
				var data = body && (body.entries ? body : body.data);
				titles.prepared = tools.prepare(data);
			})
			.catch(function () {
				titles.prepared = [];
			})
			.then(function () {
				titles.listeners.forEach(function (fn) {
					fn();
				});
			});
	}

	/** First focus: fetch the title index and wake a server isolate, so the first real search is quick. */
	function prime() {
		loadTitles();
		if (warmed) return;
		warmed = true;
		fetch(config.endpoint + "?warm=1", { credentials: "same-origin" }).catch(function () {});
	}

	function addStyles() {
		if (styled) return;
		styled = true;
		var style = document.createElement("style");
		style.id = "cw-live-css";
		style.textContent = css;
		document.head.appendChild(style);
	}

	function safeHtml(html) {
		// The server escapes everything and adds only <mark>; escape any other tag again to be safe.
		return String(html || "").replace(MARK, "&lt;");
	}

	function webUrl(url) {
		try {
			var u = new URL(url, location.href);
			return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
		} catch (e) {
			return null;
		}
	}

	/** The nearest ancestor with an opaque background, for the panel (it lives at the end of the body). */
	function backgroundOf(el) {
		for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
			var bg = getComputedStyle(node).backgroundColor;
			if (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg) && !/\/\s*0\)$/.test(bg)) return bg;
		}
		return "";
	}

	function attach(input) {
		if (input.dataset.cwLive) return;
		input.dataset.cwLive = "1";
		addStyles();

		var form = input.form;
		var id = "cw-live-" + ++counter;
		var items = [];
		var rows = [];
		var active = -1;
		var open = false;
		var timer = 0;
		var fadeTimer = 0;
		var controller = null;
		var token = 0;
		var cache = new Map();
		var announced = "";
		var hinted = false;
		var lastQuery = "";
		var announceTimer = 0;
		// Set when the visitor picks a row (arrows, pointer), so a second render keeps it selected.
		var userMoved = false;
		var activeUrl = "";

		// Nothing is wrapped around the field: themes lay search forms out with flexbox and
		// direct-child selectors, so the panel and clear button are positioned against the document.
		var list = document.createElement("div");
		list.className = "cw-live-list";
		list.id = id;
		list.setAttribute("role", "listbox");
		list.setAttribute("aria-label", "Search results");
		list.hidden = true;
		document.body.appendChild(list);

		var status = document.createElement("div");
		status.className = "cw-live-status";
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		status.setAttribute("aria-atomic", "true");
		document.body.appendChild(status);

		// Pointer and touch only (it sits at the end of the document, far from the field in tab
		// order); Escape is the keyboard path to the same thing, and the hint says so.
		var clear = document.createElement("button");
		clear.type = "button";
		clear.className = "cw-live-clear";
		clear.tabIndex = -1;
		clear.setAttribute("aria-label", "Clear search");
		clear.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
		clear.hidden = true;
		document.body.appendChild(clear);

		input.setAttribute("role", "combobox");
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-expanded", "false");
		input.setAttribute("aria-controls", id);
		input.setAttribute("autocomplete", "off");

		function visible() {
			if (!input.offsetParent && getComputedStyle(input).position !== "fixed") return false;
			var r = input.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		}

		function theme() {
			var source = form || input;
			var cs = getComputedStyle(source);
			var bg = backgroundOf(source);
			list.style.setProperty("--cw-live-fg", cs.color);
			clear.style.setProperty("--cw-live-fg", getComputedStyle(input).color);
			if (bg) list.style.setProperty("--cw-live-bg", bg);
			list.style.fontFamily = cs.fontFamily;
		}

		function position() {
			var r = input.getBoundingClientRect();
			var viewport = document.documentElement.clientWidth;
			var width = Math.min(Math.max(r.width, MIN_WIDTH), viewport - 2 * EDGE_GAP);
			var left = Math.max(scrollX + EDGE_GAP, Math.min(r.left + scrollX, scrollX + viewport - width - EDGE_GAP));
			list.style.top = r.bottom + scrollY + 4 + "px";
			list.style.left = left + "px";
			list.style.width = width + "px";
			var size = Math.min(28, Math.max(20, r.height * 0.55));
			clear.style.width = size + "px";
			clear.style.height = size + "px";
			clear.style.top = r.top + scrollY + (r.height - size) / 2 + "px";
			clear.style.left = r.right + scrollX - size - 8 + "px";
		}

		function show() {
			clearTimeout(fadeTimer);
			list.classList.remove("is-closing");
			if (!list.hidden) return;
			theme();
			list.hidden = false;
			void list.offsetHeight;
			list.classList.add("is-open");
		}

		function hide() {
			if (list.hidden) return;
			clearTimeout(fadeTimer);
			list.classList.remove("is-open");
			list.classList.add("is-closing");
			fadeTimer = setTimeout(function () {
				list.hidden = true;
				list.classList.remove("is-closing");
				list.replaceChildren();
			}, FADE_MS);
		}

		function close() {
			open = false;
			active = -1;
			hide();
			input.setAttribute("aria-expanded", "false");
			input.removeAttribute("aria-activedescendant");
		}

		function showClear() {
			clear.hidden = input.value === "" || !visible();
			if (!clear.hidden) position();
		}

		/** Empty the field and start over (the clear button, and Escape with the list closed). */
		function reset() {
			input.value = "";
			items = [];
			lastQuery = "";
			token++;
			if (controller) controller.abort();
			clearTimeout(timer);
			clearTimeout(announceTimer);
			close();
			showClear();
			status.textContent = "";
			announced = "";
		}

		/** The full results page: what submitting the form would load. */
		function allUrl(query) {
			if (!form || !input.name) return null;
			try {
				var data = new FormData(form);
				data.set(input.name, query);
				var url = new URL(form.action || location.href, location.href);
				var params = new URLSearchParams();
				data.forEach(function (value, key) {
					if (typeof value === "string") params.append(key, value);
				});
				url.search = params.toString();
				return webUrl(url.href);
			} catch (e) {
				return null;
			}
		}

		function announce(message) {
			clearTimeout(announceTimer);
			if (message === announced) return;
			announced = message;
			status.textContent = message;
		}

		// Instant (local) results are announced only if the server's answer is slow, so a screen
		// reader hears one count, not two in quick succession.
		function announceLater(message) {
			clearTimeout(announceTimer);
			announceTimer = setTimeout(function () {
				announce(message);
			}, 700);
		}

		function paint() {
			for (var i = 0; i < rows.length; i++) {
				var on = i === active;
				rows[i].setAttribute("aria-selected", on ? "true" : "false");
				rows[i].classList.toggle("is-active", on);
			}
			if (active >= 0 && rows[active]) {
				input.setAttribute("aria-activedescendant", rows[active].id);
				rows[active].scrollIntoView({ block: "nearest" });
			} else {
				input.removeAttribute("aria-activedescendant");
			}
		}

		function option(index, url) {
			var a = document.createElement("a");
			a.className = "cw-live-option";
			a.id = id + "-" + index;
			a.href = url;
			a.tabIndex = -1;
			a.setAttribute("role", "option");
			a.setAttribute("aria-selected", "false");
			a.dataset.index = String(index);
			return a;
		}

		function render(query, data, partial) {
			if (!visible()) return close();
			items = (data && data.items) || [];
			rows = [];
			list.replaceChildren();
			position();

			if (!items.length) {
				// Say so rather than vanish, which reads as broken. Not an option: nothing to open.
				active = -1;
				var empty = document.createElement("div");
				empty.className = "cw-live-empty";
				empty.setAttribute("aria-hidden", "true");
				empty.textContent = "No matching results.";
				list.appendChild(empty);
				show();
				open = true;
				input.setAttribute("aria-expanded", "true");
				input.removeAttribute("aria-activedescendant");
				announce("No matching results.");
				return;
			}

			items.forEach(function (item, i) {
				var url = webUrl(item.url);
				if (!url) return;
				var row = option(rows.length, url);
				var title = document.createElement("span");
				title.className = "cw-live-title";
				title.innerHTML = safeHtml(item.titleHtml);
				row.appendChild(title);
				if (item.snippet) {
					var snippet = document.createElement("span");
					snippet.className = "cw-live-snippet";
					snippet.innerHTML = safeHtml(item.snippet);
					row.appendChild(snippet);
				}
				list.appendChild(row);
				rows.push(row);
			});
			var count = rows.length;
			var all = allUrl(query);
			if (all) {
				var more = option(rows.length, all);
				more.classList.add("cw-live-all");
				more.textContent = "View all results";
				list.appendChild(more);
				rows.push(more);
			}

			// The first result selects itself, so what Enter will open is visible before it's pressed;
			// a row the visitor picked stays picked when the server's answer arrives.
			active = config.enterOpensTop && count ? 0 : -1;
			if (userMoved && activeUrl) {
				for (var r = 0; r < rows.length; r++) if (rows[r].href === activeUrl) active = r;
			}
			show();
			open = true;
			input.setAttribute("aria-expanded", "true");
			var message = count + (count === 1 ? " result" : " results") + (data.fallback ? " matching some of your words." : ".");
			if (!hinted && !partial) {
				message += " Use the up and down arrows to review, Enter to open, and Escape to close.";
				hinted = true;
			}
			if (partial) announceLater(message);
			else announce(message);
			paint();
		}

		/** Title matches from the index, at once (false when there's no index yet or nothing matches). */
		function showLocal(query) {
			if (!titles.prepared) return false;
			var local = tools.localItems(titles.prepared, query, config.limit);
			if (!local.length) return false;
			render(query, { items: local, fallback: false }, true);
			return true;
		}

		/** The server's answer, merged into the title matches already showing. */
		function showServer(query, data) {
			var local = titles.prepared ? tools.localItems(titles.prepared, query, config.limit) : [];
			var server = (data && data.items) || [];
			render(query, { items: tools.merge(local, server, config.limit), fallback: !!(data && data.fallback) && !local.length }, false);
		}

		// The index arrived while the visitor was typing: show its matches unless the server already answered.
		titles.listeners.push(function () {
			var query = input.value.trim();
			if (document.activeElement === input && query.length >= config.minChars && query === lastQuery && !cache.has(query)) showLocal(query);
		});

		function fetchResults(query) {
			var cached = cache.get(query);
			if (cached) return showServer(query, cached);
			if (controller) controller.abort();
			controller = new AbortController();
			var mine = ++token;
			var params = new URLSearchParams({ q: query, limit: String(config.limit) });
			if (config.locale) params.set("locale", config.locale);
			params.set("v", config.version);
			fetch(config.endpoint + "?" + params, { signal: controller.signal, credentials: "same-origin", headers: { Accept: "application/json" } })
				.then(function (r) {
					return r.ok ? r.json() : null;
				})
				.then(function (body) {
					if (!body) return;
					var data = body.data || body;
					cache.set(query, data);
					// A slower earlier answer must not replace a newer one.
					if (mine === token && input.value.trim() === query) showServer(query, data);
				})
				.catch(function () {
					// Aborted or offline: whatever is showing stands; the form still submits.
				});
		}

		input.addEventListener("input", function () {
			var query = input.value.trim();
			showClear();
			clearTimeout(timer);
			if (query.length < config.minChars) {
				lastQuery = "";
				token++;
				if (controller) controller.abort();
				items = [];
				announced = "";
				clearTimeout(announceTimer);
				status.textContent = "";
				return close();
			}
			if (query === lastQuery && open) return;
			lastQuery = query;
			userMoved = false;
			activeUrl = "";
			if (cache.has(query)) return showServer(query, cache.get(query));
			showLocal(query);
			timer = setTimeout(function () {
				fetchResults(query);
			}, config.debounce);
		});

		function move(step) {
			if (!rows.length) return;
			active = active < 0 ? (step > 0 ? 0 : rows.length - 1) : (active + step + rows.length) % rows.length;
			userMoved = true;
			activeUrl = rows[active].href;
			paint();
		}

		input.addEventListener("keydown", function (e) {
			// Keys pressed while an input method is composing belong to it (Enter confirms a
			// candidate, Escape cancels it); keyCode 229 covers Safari before 27.
			if (e.isComposing || e.keyCode === 229) return;
			switch (e.key) {
				case "ArrowDown":
				case "ArrowUp":
					// Reopen a list closed with Escape, for the same query.
					if (!open && e.key === "ArrowDown" && input.value.trim().length >= config.minChars) {
						var again = input.value.trim();
						if (cache.has(again)) {
							e.preventDefault();
							showServer(again, cache.get(again));
							return;
						}
						if (showLocal(again)) {
							e.preventDefault();
							return;
						}
					}
					if (!open || !rows.length) return;
					e.preventDefault();
					move(e.key === "ArrowDown" ? 1 : -1);
					break;
				case "Enter":
					// Opens what's highlighted; with nothing highlighted the form submits as usual.
					if (open && active >= 0 && rows[active]) {
						e.preventDefault();
						location.assign(rows[active].href);
					}
					break;
				case "Escape":
					// Two stages, per the combobox pattern: close the list first, keeping the query;
					// with the list closed, clear the field.
					if (open) {
						e.preventDefault();
						e.stopPropagation();
						close();
					} else if (input.value) {
						e.preventDefault();
						e.stopPropagation();
						reset();
					}
					break;
				case "Tab":
					close();
					break;
			}
		});

		input.addEventListener("focus", function () {
			prime();
			showClear();
			var query = input.value.trim();
			if (items.length && query.length >= config.minChars && cache.has(query)) showServer(query, cache.get(query));
		});

		// Keep focus in the field while clicking a result; the link itself navigates (so
		// middle-click and "open in new tab" work too).
		list.addEventListener("mousedown", function (e) {
			e.preventDefault();
		});
		list.addEventListener("mousemove", function (e) {
			var row = e.target.closest && e.target.closest(".cw-live-option");
			if (!row) return;
			var index = Number(row.dataset.index);
			if (index !== active) {
				active = index;
				userMoved = true;
				activeUrl = row.href;
				paint();
			}
		});

		clear.addEventListener("mousedown", function (e) {
			e.preventDefault();
		});
		clear.addEventListener("click", function () {
			reset();
			input.focus();
		});

		document.addEventListener("click", function (e) {
			if (open && e.target !== input && !list.contains(e.target) && e.target !== clear && !clear.contains(e.target)) close();
		});

		// The panel is anchored to the document, so it follows the field when the page moves.
		addEventListener("scroll", function () {
			if (open || !clear.hidden) position();
		}, { passive: true });
		addEventListener("resize", function () {
			if (open || !clear.hidden) position();
			if (!clear.hidden) showClear();
		});

		if (form) form.addEventListener("submit", close);
		showClear();
		// Attached on focus (a search form rendered later): that focus has already happened.
		if (document.activeElement === input) prime();
	}

	var FIELDS = 'form input[type="search"], form input[name="s"], form input[name="q"]';

	function candidate(input) {
		var form = input.form;
		if (!form || (form.method || "get").toLowerCase() !== "get") return false;
		// The pack's SearchBox has its own suggestions.
		if (form.hasAttribute("data-cw-search") || form.classList.contains("cw-search")) return false;
		return input.type === "search" || input.type === "text";
	}

	function boot() {
		var fields = document.querySelectorAll(FIELDS);
		for (var i = 0; i < fields.length; i++) if (candidate(fields[i])) attach(fields[i]);
		// Search forms rendered later (a header search opened on demand) attach on first focus.
		document.addEventListener("focusin", function (e) {
			var t = e.target;
			if (t && t.matches && t.matches(FIELDS) && !t.dataset.cwLive && candidate(t)) attach(t);
		});
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
	else boot();
}`;

/**
 * The script and styles as sent: comment lines, indentation and blank lines
 * dropped (line breaks stay, so semicolon insertion is unaffected). It ships
 * on every page while the feature is on, so this halves its size.
 */
const compact = (source: string) => source.replace(/^\s*(\/\/.*|\/\*\*.*\*\/)$/gm, "").replace(/^\s+/gm, "").replace(/\n{2,}/g, "\n");
const COMPACT_SCRIPT = compact(SCRIPT);
const COMPACT_MATCH = compact(MATCH_SOURCE);
const COMPACT_CSS = LIVE_CSS.replace(/\n\s*/g, "");

// JSON in a script element: escape "<" so nothing in it can close the tag or open a comment.
// (U+2028/2029 are legal in JS string literals since ES2019, so JSON needs nothing more.)
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** The inline script for one page: the client above, called with this config. */
export function liveScript(config: LiveClientConfig): string {
	return `(${COMPACT_SCRIPT})(${json(config)},${json(COMPACT_CSS)},(${COMPACT_MATCH})());`;
}

/**
 * The same client as a static file, so browsers download it once and cache
 * it instead of receiving it inline on every page. It reads the page's config
 * from its own <script> element's data-cw-live attribute (liveScriptConfig).
 */
export const LIVE_ASSET = `(function(){var s=document.currentScript,c=null;try{c=JSON.parse(s&&s.getAttribute("data-cw-live")||"null")}catch(e){}
if(c)(${COMPACT_SCRIPT})(c,${json(COMPACT_CSS)},(${COMPACT_MATCH})());})();`;

/** A short fingerprint of LIVE_ASSET (FNV-1a), for its immutable URL. Changes whenever the client does. */
export const LIVE_ASSET_HASH = (() => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < LIVE_ASSET.length; i++) {
		hash ^= LIVE_ASSET.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
})();

/** The data-cw-live attribute value for the LIVE_ASSET script (the page's renderer escapes it for HTML). */
export function liveScriptConfig(config: LiveClientConfig): string {
	return JSON.stringify(config);
}

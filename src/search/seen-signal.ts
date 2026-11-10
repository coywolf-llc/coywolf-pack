/**
 * Search insights' "the visitor settled on this search" signal, for the
 * SearchBox's suggestions (src/astro/search/SearchBoxForm.astro). The live
 * results client (live-client.ts) has the same logic written into its
 * script.
 *
 * A search counts once the visitor stops typing for `delay` (1.5 s) after
 * its answer showed, or opens a result first; once per query per page view;
 * never while they're still typing (every keystroke cancels), and not when
 * they submit the form (the search page counts that one). The signal is a
 * POST of { q, n } to search/seen, which the pack counts only while
 * insights.search is on; with no endpoint (the part is off), nothing is sent.
 *
 * No imports, so `node --test` can load this file.
 */

export const SEEN_DELAY_MS = 1_500;

export interface SeenSignal {
	/** The answer for `query` showed, with `count` results: it counts if the visitor stops here. */
	settle(query: string, count: number): void;
	/** A keystroke, a submit or a reset: whatever was waiting doesn't count. */
	cancel(): void;
	/** A result was opened: what was waiting counts now. */
	flush(): void;
}

export interface SeenOptions {
	/** search/seen, or null/undefined when Search insights is off. */
	endpoint: string | null | undefined;
	/** What's in the field now (a pending search counts only if it's still what's typed). */
	current: () => string;
	delay?: number;
	send?: (url: string, body: string) => void;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

const post = (url: string, body: string) => {
	try {
		void fetch(url, { method: "POST", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body }).catch(() => undefined);
	} catch {
		// Counting is best effort: never in the visitor's way.
	}
};

export function createSeenSignal(options: SeenOptions): SeenSignal {
	const sent = new Set<string>();
	const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
	const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	let timer: unknown = null;
	let pending: { q: string; n: number } | null = null;

	const send = (p: { q: string; n: number }) => {
		if (!options.endpoint || sent.has(p.q) || options.current() !== p.q) return;
		sent.add(p.q);
		(options.send ?? post)(options.endpoint, JSON.stringify(p));
	};
	const cancel = () => {
		if (timer !== null) clearTimer(timer);
		timer = null;
		pending = null;
	};
	return {
		settle(query, count) {
			if (!options.endpoint || sent.has(query)) return;
			cancel();
			pending = { q: query, n: count };
			timer = setTimer(() => {
				const p = pending;
				timer = null;
				pending = null;
				if (p) send(p);
			}, options.delay ?? SEEN_DELAY_MS);
		},
		cancel,
		flush() {
			const p = pending;
			cancel();
			if (p) send(p);
		},
	};
}

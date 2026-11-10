/**
 * Shared work with a deadline: the pack's guard against stranded shared
 * promises (the coywolf.com hangs of November 7 and 9, 2026).
 *
 * The pack shares work that's under way between the requests of an isolate:
 * the feature switches' read, the redirect patterns, a cold llms.txt build…
 * On Workers, a request's I/O and timers belong to that request. When it's
 * canceled (Cloudflare ends invocations at the 100-second wall, a client
 * disconnects, a waitUntil task is cut off at 30 seconds), the continuations
 * of what it started never run, so a promise it was computing neither
 * resolves nor rejects. A later request that awaits that promise waits
 * forever, and so does every request after it, until the isolate is torn
 * down: 524s at 100 seconds, with 1–10 ms of CPU. A .catch or .finally that
 * clears the shared promise doesn't help: a canceled request settles neither
 * way.
 *
 * sharedRead() keeps the coalescing and removes the hang:
 * - the read is anchored with waitUntil (`anchor`), so a request that answers
 *   (or whose client leaves) before the read is done still finishes it, and
 *   the callers waiting for it get its result;
 * - the read publishes its outcome on the shared slot when it settles, and a
 *   caller that finds a read under way checks for that outcome on timers of
 *   its own (every DEADLINES.sharedPollMs), never awaiting the other
 *   request's promise; at most until `waitMs` after that read started. Then
 *   it stops waiting, takes the stale read out (only if it's still the one
 *   there) and runs its own, which later callers share.
 *
 * EmDash 1.4 guards its own caches the same way: its single-flight cache has
 * waiters poll for the published value instead of awaiting the owner's
 * promise, and its coalescing D1 connection reclaims a flush whose timer was
 * dropped (#1927; see src/core/d1-batch.ts).
 *
 * The pack's deadlines are all in DEADLINES, with why each is what it is.
 * No imports, so tests can load it.
 */

export const DEADLINES = {
	/**
	 * Longest a caller waits for a read another request started (counted from
	 * when that read started), before reading itself. A healthy read of the
	 * pack's option rows takes 5–50 ms (a cold D1 up to about a second), so
	 * 2.5 s almost never duplicates a live read, and a stranded one costs one
	 * visitor 2.5 s instead of a 524 at 100 s (when D1 itself has stopped
	 * answering, 2.5 s and then its own read's d1ReadMs).
	 */
	sharedWaitMs: 2_500,
	/** How often a waiting caller checks whether the shared read has settled (a healthy read settles in tens of ms). */
	sharedPollMs: 25,
	/** The same for a cold llms.txt or news sitemap build (it reads every published entry: seconds on a big site). */
	coldBuildWaitMs: 10_000,
	/** The same for the Performance page's usage reading (a handful of Cloudflare API calls). */
	usageWaitMs: 20_000,
	/** The same for the update check (npm answers within 5 s or the check fails, then two settings calls). */
	updateCheckWaitMs: 10_000,
	/**
	 * A pack D1 read (src/core/d1-batch.ts) that hasn't answered by then
	 * fails; its callers fail closed (features at their defaults, the page
	 * kept out of the edge cache). Its reads are small indexed SELECTs (5–50 ms,
	 * a cold D1 about a second), so 5 s is far past any healthy answer. It also
	 * sets the cost of a D1 that stops answering: a request that waited
	 * sharedWaitMs for another's read and then reads itself fails after about
	 * 7.5 s in all (2.5 s + 5 s), not the 100 s wall. Lower would cut off a cold
	 * D1's slowest answers.
	 */
	d1ReadMs: 5_000,
	/**
	 * A D1 batch flush (a zero-delay timer) that hasn't run by then had its
	 * timer dropped by a canceled request: the next read takes its queue over.
	 * A live zero-delay timer fires within a turn. Same value as EmDash's.
	 */
	d1FlushReclaimMs: 1_000,
	/**
	 * A cache warmer visit (a SELF render: the fetch and reading its body).
	 * Renders take 15–60 ms of CPU and well under a second of wall time, a cold
	 * isolate a few seconds; 8 s leaves room for two rounds of visits in a step.
	 */
	warmVisitMs: 8_000,
	/**
	 * Hard limit on one warm step (src/pageCache/warm.ts), which runs under
	 * waitUntil: Cloudflare cancels waitUntil work 30 s after the response, so
	 * a step must end well before that, with its progress recorded.
	 */
	warmStepMs: 24_000,
	/**
	 * Kept at the end of a warm step for recording its last batch: a step stops
	 * claiming work once less than one visit plus this is left before its hard
	 * deadline, so a claimed batch is visited and recorded in time.
	 */
	warmRecordMarginMs: 2_000,
	/**
	 * Making one image's crops on first use (an R2 read, a few Images
	 * transformations, R2 writes): a few seconds. Bounded under waitUntil's
	 * 30 s so a crop job that never settles can't hold up the ones behind it.
	 */
	cropJobMs: 20_000,
	/** Copying one video poster into the media bucket (a head, a 5 s fetch, a put). */
	posterMirrorMs: 15_000,
	/** A targeted page cache purge made by a route (the Stream webhook). */
	purgeMs: 10_000,
	/**
	 * One Cloudflare API read from Discovery's Crawler Hints card (the zone
	 * lookup, then the zone's flags). Each answers in well under a second;
	 * 8 s keeps a stalled call from holding the admin page.
	 */
	cloudflareReadMs: 8_000,
	/**
	 * Any other Cloudflare API call (src/core/cloudflare-api.ts): media host
	 * setup steps, usage readings, Stream and D1 restore calls. Each answers in
	 * well under a few seconds; 30 s ends a stalled call long before the
	 * platform would, with an error the page can show.
	 */
	cloudflareApiMs: 30_000,
};

/** Work that didn't finish within its deadline. */
export class DeadlineError extends Error {
	constructor(what: string, ms: number) {
		super(`${what} took longer than ${ms} ms`);
		this.name = "DeadlineError";
	}
}

/**
 * `promise`, or a DeadlineError once `ms` have passed. The timer is the
 * caller's own, so it fires even when `promise` belongs to a request that was
 * canceled; it's cleared as soon as `promise` settles.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what = "work"): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new DeadlineError(what, ms)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Wait until `done()` is true, checking every `pollMs` on the caller's own
 * timers, or until `deadline` (ms since the epoch) passes. True when done.
 * For waiting on work another request is doing without attaching to its
 * promise: a reaction on a promise of a request that's gone is never run.
 */
export async function pollUntil(done: () => boolean, deadline: number, pollMs = DEADLINES.sharedPollMs): Promise<boolean> {
	while (!done()) {
		const left = deadline - Date.now();
		if (left <= 0) return false;
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
	}
	return true;
}

/** The read under way in one shared slot: when it started, its promise (for the request that runs it) and, once settled, its outcome. */
interface Flight<T> {
	promise: Promise<T>;
	startedAt: number;
	outcome?: { value: T } | { error: unknown };
}

/** Where callers find the read under way (module state: one per shared read). */
export interface SharedSlot<T> {
	flight: Flight<T> | null;
}

export function sharedSlot<T>(): SharedSlot<T> {
	return { flight: null };
}

export interface SharedReadOptions {
	/** Longest a caller waits for a read already under way, from its start (default DEADLINES.sharedWaitMs). */
	waitMs?: number;
	/** Keeps a new read alive past the response of the request that starts it (afterResponse: waitUntil). */
	anchor?: (promise: Promise<unknown>) => void;
	/** Names the read in the log line when a caller stops waiting for it. */
	label?: string;
}

const noop = () => undefined;

/** Start `read` (synchronously, so reads of the same tick still batch), sharing it through `slot` when `install`. */
function startFlight<T>(slot: SharedSlot<T>, read: () => Promise<T>, options: SharedReadOptions, install: boolean): Promise<T> {
	let promise: Promise<T>;
	try {
		promise = read();
	} catch (error) {
		promise = Promise.reject(error);
	}
	const flight: Flight<T> = { startedAt: Date.now(), promise };
	if (install) {
		// Published on the flight (plain memory every request of the isolate can read), then out of the slot.
		const settle = (outcome: Flight<T>["outcome"]) => {
			flight.outcome = outcome;
			if (slot.flight === flight) slot.flight = null;
		};
		flight.promise = promise.then(
			(value) => (settle({ value }), value),
			(error: unknown) => {
				settle({ error });
				throw error;
			},
		);
		slot.flight = flight;
	}
	options.anchor?.(flight.promise.then(noop, noop));
	return flight.promise;
}

/**
 * `read()`, shared with the callers that come while it's under way, never
 * awaited past its deadline (see the top of this file). A read that rejects
 * in time rejects for every caller waiting for it, as before; it isn't kept,
 * so the next caller reads again.
 *
 * Several callers can give up on the same stalled read in the same moment.
 * The first to wake starts its own read and puts it in the slot; the others
 * find that fresh read there and wait for it instead of each running a read
 * of their own, under the same rules (`waitMs` from its start, on their own
 * timers). A caller waits on at most two reads in a row, then reads itself.
 */
export async function sharedRead<T>(slot: SharedSlot<T>, read: () => Promise<T>, options: SharedReadOptions = {}): Promise<T> {
	const waitMs = options.waitMs ?? DEADLINES.sharedWaitMs;
	let current = slot.flight;
	for (let waited = 0; current && waited < 2; waited++) {
		const flight = current;
		if (await pollUntil(() => flight.outcome !== undefined, flight.startedAt + waitMs)) {
			const outcome = flight.outcome!;
			if ("value" in outcome) return outcome.value;
			throw outcome.error;
		}
		// Not settled in time: its request was canceled (or it's very slow). Nobody else gets it from here on.
		if (slot.flight === flight) slot.flight = null;
		console.warn(`coywolf-pack: shared read stalled: ${options.label ?? "a read"} didn't settle within ${waitMs} ms; reading again`);
		// Another caller that gave up at the same moment may already have put a fresh read in place: wait for that one.
		current = slot.flight;
	}
	// This caller's own read; shared from now on unless another caller already put a fresh one in place.
	return startFlight(slot, read, options, slot.flight === null);
}

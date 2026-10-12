/**
 * Reads that failed while pages were being answered. When the pack can't read
 * what it needs (D1 unreachable for a moment, a query error), it fails closed:
 * the feature switches read as their defaults (new features are off),
 * settings as unset, redirect and robots.txt rules as absent, and a module
 * whose page metadata failed adds none. That's the right answer for the one
 * request, but the page it renders isn't the site's real page (no schema,
 * reviews or videos, wrong links), so it mustn't go into the edge cache, where
 * it would stay for the Page cache lifetime (days).
 *
 * Every such fallback calls noteReadFailure(). The pack middleware reads
 * readFailures() before a request and again once the response is rendered,
 * and keeps the response out of the edge cache when the count moved (see
 * settlePage in src/pageCache/lib.ts).
 *
 * The count is per isolate, not per request: one read is often shared by
 * several requests (concurrent requests wait for the same read of the
 * switches), and the code that notices a failure has no request at hand. A
 * failure while another request of the same isolate rendered keeps that one
 * out of the cache too, which only costs a render. No imports, so tests can
 * load it.
 */

let failures = 0;
let last: string | undefined;

/**
 * A read failed and a fallback (off, unset, absent) was used instead. `what`
 * names it for the log line of the page left out of the cache: a module that
 * fails on every render (a bug, not a blip) keeps every page out of the cache
 * until it's fixed, and the log says which.
 */
export function noteReadFailure(what: string): void {
	failures++;
	last = what;
}

/** How many reads have failed in this isolate; compare two counts to tell whether one failed in between. */
export function readFailures(): number {
	return failures;
}

/** What failed most recently in this isolate (for the log). */
export function lastReadFailure(): string | undefined {
	return last;
}

/**
 * A plugin route's result that failed on the server, as EmDash's HTTP wiring
 * would answer it (plugins/http-route-dispatch.ts: a missing status is 404 for
 * NOT_FOUND, else 400): a 5xx means a read failed. Not found (a feature that's
 * off, the plugin not enabled), bad input and the like don't count.
 */
export function routeFailed(result: { success?: boolean; status?: number; error?: { code?: string } } | null | undefined): boolean {
	if (!result || result.success) return false;
	return (result.status ?? (result.error?.code === "NOT_FOUND" ? 404 : 400)) >= 500;
}

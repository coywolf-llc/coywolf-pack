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

/** A read failed and a fallback (off, unset, absent) was used instead. */
export function noteReadFailure(): void {
	failures++;
}

/** How many reads have failed in this isolate; compare two counts to tell whether one failed in between. */
export function readFailures(): number {
	return failures;
}

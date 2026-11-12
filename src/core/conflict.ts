/**
 * Whether a content write failed because the entry changed since it was read:
 * EmDash answers a stale `_rev` with a version conflict (409 CONFLICT, "Content
 * has been modified since last read"), and with co-editing on (EmDash 1.5+) an
 * open editor saves every few seconds, so the pack's writes that send `_rev`
 * meet one more often. Callers leave such an entry as it is (its edit stays a
 * draft) rather than retry on top of someone else's changes. No imports, so
 * tests can load it.
 */
export function isConflict(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	// EmDash's plugin content actions throw { code: "CONFLICT" }; the repository's own error is ContentMutationConflictError.
	const e = error as { code?: unknown; name?: unknown };
	return e.code === "CONFLICT" || e.name === "ContentMutationConflictError";
}

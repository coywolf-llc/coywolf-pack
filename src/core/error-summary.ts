/**
 * A caught error's text for a log line. Workers Logs shows some runtime errors, D1's among them
 * ("D1_ERROR: …"), by their stack alone, without their message, so a log line that passes the error
 * object passes this text before it: `console.error("what failed", errorSummary(error), error)`.
 */
export function errorSummary(error: unknown): string {
	if (!(error instanceof Error)) return plain(error).slice(0, 1000);
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const cause = (error as { cause?: unknown }).cause;
	const causeText = cause === undefined || cause === null ? "" : cause instanceof Error ? cause.message : String(cause);
	return (causeText && !head.includes(causeText) ? `${head} (cause: ${causeText})` : head).slice(0, 1000);
}

/** A thrown value that isn't an Error: as JSON when it's an object (String() would say "[object Object]"). */
function plain(value: unknown): string {
	if (value === null || typeof value !== "object") return String(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

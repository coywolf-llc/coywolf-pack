/**
 * A caught error's text for a log line. Workers Logs shows some runtime errors, D1's among them
 * ("D1_ERROR: …"), by their stack alone, without their message, so a log line that passes the error
 * object passes this text before it: `console.error("what failed", errorSummary(error), error)`.
 *
 * It never throws (it runs inside catch handlers, some of which let a request go on): anything it
 * can't read gives "(no error text)".
 */
export function errorSummary(error: unknown): string {
	try {
		return summary(error, 0).slice(0, 1000);
	} catch {
		return "(no error text)";
	}
}

/** Causes followed at most this deep (D1's own error is often a cause's cause). */
const MAX_CAUSES = 3;

function summary(error: unknown, depth: number): string {
	const message = messageOf(error);
	if (message === undefined) return plain(error);
	const name = nameOf(error);
	const head = message ? (name ? `${name}: ${message}` : message) : name || "Error";
	if (depth >= MAX_CAUSES) return head;
	// An AggregateError's own errors (Promise.any, and some runtime errors), the first three.
	const inner = (error as { errors?: unknown }).errors;
	const listed = Array.isArray(inner) && inner.length ? `${head} [${inner.slice(0, 3).map((item) => summary(item, depth + 1)).join("; ")}${inner.length > 3 ? "; …" : ""}]` : head;
	const cause = (error as { cause?: unknown }).cause;
	if (cause === undefined || cause === null) return listed;
	const causeText = summary(cause, depth + 1);
	return causeText && !listed.includes(messageOf(cause) || causeText) ? `${listed} (cause: ${causeText})` : listed;
}

/** An error's message: an Error's, or an error-like object's string `message` (an Error from another realm). Undefined for anything else. */
function messageOf(value: unknown): string | undefined {
	if (value instanceof Error) return typeof value.message === "string" ? value.message : plain(value.message);
	if (value !== null && typeof value === "object" && typeof (value as { message?: unknown }).message === "string" && typeof (value as { name?: unknown }).name === "string") {
		return (value as { message: string }).message;
	}
	return undefined;
}

function nameOf(error: unknown): string {
	const name = (error as { name?: unknown }).name;
	return typeof name === "string" ? name : "";
}

/** A thrown value that isn't an Error: as JSON when it's an object (String() would say "[object Object]"). */
function plain(value: unknown): string {
	if (value === null || typeof value !== "object") return String(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
}

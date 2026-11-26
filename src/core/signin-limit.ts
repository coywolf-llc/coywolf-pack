import { errorSummary } from "./error-summary.js";
/**
 * Sign-in email limit: a cap on the sign-in links EmDash emails to one
 * address.
 *
 * EmDash (1.5) limits `POST /_emdash/api/auth/magic-link/send` by IP address
 * only (3 per 5 minutes), so requests spread over many addresses can fill an
 * admin's inbox with sign-in emails. The pack middleware counts each request
 * for a user's address before EmDash sees it: 3 per 15 minutes for one
 * address (key `coywolf-email:<SHA-256 of the address>:magic-link/send`, so
 * the table never holds the address itself).
 *
 * The count is a row of EmDash's own `_emdash_rate_limits` table, written with
 * the upsert EmDash's checkRateLimit uses: fixed windows, a request counted
 * even when it's over (so a flood never resets its window), and EmDash's own
 * cleanup removing old windows. The lookup of the user and the count are one
 * statement, sent for every address, so a user's address and any other cost
 * the same one trip to the database.
 *
 * Over the limit, the request still goes on to EmDash, as a request for an
 * address that can't have an account: the middleware gives EmDash a copy of
 * the request (same URL, method and headers, less Content-Length) whose email
 * is `<16 random hex digits>@held.invalid`. `.invalid` is a reserved top-level
 * domain, so no user has such an address, and EmDash's schema accepts it.
 * EmDash then does exactly what it does for someone without an account: it
 * counts the request against its own IP limit, pauses 100 to 250 ms (or
 * answers at once when the IP is over that limit), answers 503 when the site
 * has no email provider, and sends nothing. The pack adds no pause and writes
 * no answer of its own, so a held request's status, headers, body and pauses
 * are EmDash's for an unknown address.
 *
 * What can still be told apart: nothing in the answer. In time, a user's
 * request and anyone else's run the same statement; the user's writes a row
 * where the other writes none, and a held request is then copied: differences
 * of well under a millisecond locally, far below the jitter of a request (not
 * measured on D1). EmDash's own answer for a user
 * whose email is sent (requests 1 to 3) takes as long as sending takes, against
 * its 100 to 250 ms pause for an unknown address: that is EmDash's, as before.
 *
 * What is counted is requests, not emails: a request for a user's address
 * counts even when EmDash then sends nothing (its IP limit was reached, or the
 * site has no email provider). So three requests in a row, from anywhere, hold
 * an address's sign-in emails until its 15-minute window ends.
 *
 * There is no cap on all addresses together. Only addresses in EmDash's users
 * table are counted (EmDash sends nothing to any other), so the per-address
 * limit already bounds the mail: 12 an hour per user, on sites with one or two
 * users. A shared cap would add almost nothing to that, and would let anyone
 * who knows a few users' addresses hold every user's sign-in emails for its
 * whole window.
 *
 * The address is lowercased, as EmDash looks users up, and nothing else:
 * EmDash's schema refuses an address with spaces or a line break around it
 * (400), so a padded one must match no user and go on to EmDash. If the pack
 * trimmed it, a user's padded address would be held on the 4th request (200,
 * since EmDash would get the `.invalid` address) while anyone else's got 400
 * every time, which would tell the sender who has an account. The same would
 * show for a user whose stored address EmDash's schema refuses (400 three
 * times, then 200): an address that can't sign in by email link at all.
 *
 * A body too big to be a sign-in request (over SIGNIN_BODY_MAX, declared or
 * actual) is held the same way, uncounted, whoever it names: EmDash gets a
 * request with only the `.invalid` address. EmDash's schema ignores extra
 * fields, so padding a request past the size the pack reads would otherwise
 * skip the limit. Anything else the pack can't read (bad JSON, no email, a
 * body already read) goes on to EmDash, which answers it as before. Any
 * database error fails open: the request goes on to EmDash unchanged (logged
 * once per isolate).
 *
 * Kept free of EmDash imports so tests can load it directly.
 */

/** EmDash's route that emails a sign-in link (as Astro routes it: decoded, no trailing slash). */
export const SIGNIN_SEND_PATH = "/_emdash/api/auth/magic-link/send";
/** Largest body read: a sign-in request is `{"email":"…"}`, an address at most 254 characters. */
export const SIGNIN_BODY_MAX = 4096;
/** The endpoint part of the key, as EmDash names its own limit on this route. */
const ENDPOINT = "magic-link/send";
/** One address: 3 links per 15 minutes. */
export const EMAIL_LIMIT = { max: 3, windowSeconds: 900 } as const;
/** The domain of the address a held request is given: a reserved top-level domain (RFC 2606), so it's never a user's. */
export const HELD_EMAIL_DOMAIN = "held.invalid";

export interface SignInLimitOptions {
	/** The clock (tests). */
	now?: () => number;
}

/**
 * The path the way Astro matches it to a route: decoded until it stops
 * changing (so `/sen%64` is `/send`), without repeated or trailing slashes
 * (Astro's default trailingSlash, "ignore", routes `/send/` to the same page).
 */
export function routedPath(pathname: string): string {
	let path = pathname;
	for (let i = 0; i < 10; i++) {
		let decoded: string;
		try {
			decoded = decodeURI(path);
		} catch {
			break;
		}
		if (decoded === path) break;
		path = decoded;
	}
	return path.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
}

/** Whether a request is a sign-in email request (EmDash's magic-link send). */
export function isSignInSend(method: string, pathname: string): boolean {
	return method === "POST" && routedPath(pathname) === SIGNIN_SEND_PATH;
}

const TOO_LARGE = Symbol("too large");

/** A copy of the body as text, read up to `max` bytes; TOO_LARGE past that, null when it can't be read. */
async function smallBody(request: Request, max: number): Promise<string | typeof TOO_LARGE | null> {
	const declared = Number(request.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > max) return TOO_LARGE;
	// A copy (the route reads the original), read in parts: with no Content-Length (a chunked upload), the size is only known by reading.
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		// Inside the try: clone() throws for a body that's already read or locked, and that request goes on to EmDash too.
		const stream = request.clone().body;
		if (!stream) return "";
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > max) {
				reader.cancel().catch(() => undefined);
				return TOO_LARGE;
			}
			parts.push(value);
		}
	} catch {
		return null;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * The address a sign-in request names, as the limits count it: A–Z lowercased
 * (the addresses EmDash accepts are ASCII, and it looks users up lowercase),
 * and never trimmed (see the note on padded addresses
 * above). Null when there isn't one.
 */
export function requestedEmail(text: string): string | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	const email = body && typeof body === "object" ? (body as { email?: unknown }).email : undefined;
	if (typeof email !== "string") return null;
	// A–Z only: toLowerCase() also turns the Kelvin sign (U+212A) into "k", which would make an address EmDash refuses match a user.
	const normalized = email.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	return normalized.includes("@") ? normalized : null;
}

/** The start of the fixed window `now` is in, as EmDash's checkRateLimit writes it. */
export function windowStart(now: number, windowSeconds: number): string {
	return new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();
}

/** The per-address key: `coywolf-email:<SHA-256 of the address, hex>:magic-link/send`. */
export async function emailKey(email: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `coywolf-email:${hex}:${ENDPOINT}`;
}

/**
 * EmDash's checkRateLimit upsert, for a user's address only: add one to the
 * key's count in this window and return the count, or no row when the address
 * isn't a user's (stored lowercase, as EmDash's getUserByEmail looks them up).
 * One statement for both, so every address costs the same trip to the database.
 */
function countUserRequest(db: D1Database, key: string, window: string, email: string): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO _emdash_rate_limits (key, "window", count)
			SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM users WHERE email = ?)
			ON CONFLICT (key, "window") DO UPDATE SET count = _emdash_rate_limits.count + 1
			RETURNING count`,
		)
		.bind(key, window, email);
}

/** The address a held request names: 16 random hex digits at HELD_EMAIL_DOMAIN. */
export function heldEmail(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return `${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}@${HELD_EMAIL_DOMAIN}`;
}

/**
 * The request EmDash gets in place of a held one: the same URL, method,
 * headers (less Content-Length: the body is new) and abort signal, its JSON
 * body the original's fields with the email replaced (or the email alone, when
 * the original was too big to read).
 */
function heldRequest(request: Request, text: string | null): Request {
	let fields: Record<string, unknown> = {};
	if (text !== null) {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
	}
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	// From the original, so everything else it carries comes along (on Workers that includes `cf`). Its own body is left unread.
	const held = new Request(request, { headers, body: JSON.stringify({ ...fields, email: heldEmail() }) });
	// EmDash only trusts CF-Connecting-IP on a request with `cf` (its getClientIp), so without it this request would skip EmDash's IP limit.
	const cf = (request as { cf?: unknown }).cf;
	if (cf !== undefined && (held as { cf?: unknown }).cf === undefined) Object.defineProperty(held, "cf", { value: cf, enumerable: true, configurable: true });
	return held;
}

/** Per isolate: a failure is logged once, so a broken table can't flood the logs. */
let failureLogged = false;

function logFailure(error: unknown): void {
	if (failureLogged) return;
	failureLogged = true;
	console.error("coywolf-pack: the sign-in email limit couldn't be checked, so EmDash handles the request (logged once per isolate)", errorSummary(error), error);
}

/**
 * For a sign-in email request over its address's limit (or too big to be one):
 * the request to hand EmDash in its place, for an address that has no account
 * (the middleware sets it as the context's request and goes on). Null for
 * every other request, which goes on unchanged.
 */
export async function signInHeldRequest(request: Request, pathname: string, db: D1Database | undefined, options: SignInLimitOptions = {}): Promise<Request | null> {
	if (!isSignInSend(request.method, pathname)) return null;
	const text = await smallBody(request, SIGNIN_BODY_MAX);
	try {
		if (text === TOO_LARGE) return heldRequest(request, null);
		const email = text === null ? null : requestedEmail(text);
		if (!email || !db) return null;
		const now = (options.now ?? Date.now)();
		// One statement, so each request gets its own place in the address's window, whichever isolate it arrives in.
		const row = await countUserRequest(db, await emailKey(email), windowStart(now, EMAIL_LIMIT.windowSeconds), email).first<{ count: number }>();
		if (!row || Number(row.count) <= EMAIL_LIMIT.max) return null;
		return heldRequest(request, text as string);
	} catch (error) {
		logFailure(error);
		return null;
	}
}

/** Tests: log the next failure again. */
export function resetSignInLimitLog(): void {
	failureLogged = false;
}

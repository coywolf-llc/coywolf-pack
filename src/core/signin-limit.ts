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
 * cleanup removing old windows. Over the limit, the request gets the answer
 * EmDash gives when it has sent a link (the same one it gives at its IP limit)
 * without reaching EmDash, after a pause like the one EmDash adds for an
 * unknown address, so neither the answer nor its timing says a limit was hit
 * or that the address has an account.
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
 * trimmed it, a user's padded address would be held with a 200 on the 4th
 * request while anyone else's got 400 every time, which would tell the sender
 * who has an account.
 *
 * A body too big to be a sign-in request (over SIGNIN_BODY_MAX, declared or
 * actual) gets the same answer without reaching EmDash: EmDash's schema
 * ignores extra fields, so padding a request past the size the pack reads
 * would otherwise skip the limit. Anything else the pack can't read (bad
 * JSON, no email, a body already read) goes on to EmDash, which answers it as
 * before. Any database error fails open: the request goes on to EmDash (logged
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
/** What EmDash's handler answers when it has sent a link (and at its own limit). */
export const SIGNIN_SENT_MESSAGE = "If an account exists for this email, a magic link has been sent.";

export interface SignInLimitOptions {
	/** The clock (tests). */
	now?: () => number;
	/** The pause before a held request's answer (tests). Default: 100–250 ms, as EmDash pauses for an unknown address. */
	pause?: () => Promise<void>;
}

/** EmDash's success answer, as its apiSuccess builds it: the JSON body and `Cache-Control: private, no-store`. */
export function signInSentResponse(): Response {
	return Response.json({ success: true, data: { success: true, message: SIGNIN_SENT_MESSAGE } }, { status: 200, headers: { "Cache-Control": "private, no-store" } });
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

/** EmDash's checkRateLimit upsert: add one to the key's count in this window, and return the count. */
function countRequest(db: D1Database, key: string, window: string): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO _emdash_rate_limits (key, "window", count) VALUES (?, ?, 1)
			ON CONFLICT (key, "window") DO UPDATE SET count = _emdash_rate_limits.count + 1
			RETURNING count`,
		)
		.bind(key, window);
}

/** Whether the address belongs to one of EmDash's users (stored lowercase, as EmDash's getUserByEmail looks them up). */
async function isUser(db: D1Database, email: string): Promise<boolean> {
	return (await db.prepare("SELECT 1 AS found FROM users WHERE email = ? LIMIT 1").bind(email).first()) !== null;
}

/** Per isolate: a failure is logged once, so a broken table can't flood the logs. */
let failureLogged = false;

const pauseLikeEmDash = () => new Promise<void>((resolve) => setTimeout(resolve, 100 + Math.random() * 150));

/**
 * For a sign-in email request over its address's limit (or too big to be one): the
 * answer to give instead of EmDash's, after a pause. Null for every other
 * request, which goes on unchanged.
 */
export async function signInLimitResponse(request: Request, pathname: string, db: D1Database | undefined, options: SignInLimitOptions = {}): Promise<Response | null> {
	if (!isSignInSend(request.method, pathname)) return null;
	const held = async () => {
		await (options.pause ?? pauseLikeEmDash)();
		return signInSentResponse();
	};
	const text = await smallBody(request, SIGNIN_BODY_MAX);
	if (text === TOO_LARGE) return held();
	const email = text === null ? null : requestedEmail(text);
	if (!email || !db) return null;
	try {
		if (!(await isUser(db, email))) return null;
		const now = (options.now ?? Date.now)();
		// One statement, so each request gets its own place in the address's window, whichever isolate it arrives in.
		const row = await countRequest(db, await emailKey(email), windowStart(now, EMAIL_LIMIT.windowSeconds)).first<{ count: number }>();
		if (Number(row?.count ?? 1) <= EMAIL_LIMIT.max) return null;
	} catch (error) {
		if (!failureLogged) {
			failureLogged = true;
			console.error("coywolf-pack: the sign-in email limit couldn't be checked, so EmDash handles the request (logged once per isolate)", error);
		}
		return null;
	}
	return held();
}

/** Tests: log the next failure again. */
export function resetSignInLimitLog(): void {
	failureLogged = false;
}
